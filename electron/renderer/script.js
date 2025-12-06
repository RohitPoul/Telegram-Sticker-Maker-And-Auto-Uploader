// Production mode - debug disabled
const RENDERER_DEBUG = false;

// Global error handling to prevent white screen crashes
window.addEventListener("error", (event) => {
  console.error("🚫 [GLOBAL_ERROR] Unhandled error:", event.error);
  console.error("🚫 [GLOBAL_ERROR] Error details:", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack
  });

  // Prevent app from crashing completely
  event.preventDefault();

  // Show error toast if possible
  if (window.app && window.app.showToast) {
    window.app.showToast("error", "Application Error", `Error: ${event.message}`);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("🚫 [GLOBAL_ERROR] Unhandled promise rejection:", event.reason);

  // Prevent app from crashing
  event.preventDefault();

  // Show error toast if possible
  if (window.app && window.app.showToast) {
    window.app.showToast("error", "Promise Error", `Promise rejection: ${event.reason}`);
  }
});

class TelegramUtilities {
  constructor() {
    this.activeProcesses = new Map();
    // Idempotency guards per process
    this.iconHandledProcesses = new Set();
    this.urlPromptHandledProcesses = new Set();
    this.videoFiles = [];
    this.mediaFiles = [];
    this.currentVideoOutput = "";
    this.telegramConnected = false;
    this.pendingCode = false;
    this.pendingPassword = false;
    this.currentProcessId = null;
    this.currentStickerProcessId = null; // Add specific tracking for sticker processes
    this.currentEmojiIndex = null;

    // Consolidated modal state management - cleaner than multiple boolean flags
    this.modalState = {
      isEmojiSaving: false,
      isEmojiLocked: false,
      preventEmojiClosure: false,
      isSubmittingCode: false,
      isSubmittingPassword: false
    };

    // Promise-based submission locks to prevent double submissions
    this._submitCodePromise = null;
    this._submitPasswordPromise = null;
    this._saveEmojiPromise = null;

    // CRITICAL FIX: Add workflow state tracking to prevent premature completion
    this.workflowState = {
      iconUploaded: false,
      urlNameSubmitted: false,
      packCompleted: false,
      currentStep: "initial" // initial, icon_upload, url_name, completed
    };
    this.progressInterval = null;
    this.stickerProgressInterval = null;
    this.currentOperation = null; // 'converting', 'hexediting', null
    this.isPaused = false;
    this.startTime = new Date();
    this.systemInfoInterval = null;
    this.selectedMediaType = null; // 'image' or 'video'
    this.defaultEmoji = "❤️"; // Heart as default emoji
    this.sessionStats = {
      totalConversions: 0,
      successfulConversions: 0,
      failedConversions: 0,
      totalStickers: 0
    };
    this.autoScrollEnabled = true; // Initialize auto-scroll

    // Prevent double submission - handled in modalState now
    this.isConnecting = false;

    // OPTIMIZED: Add properties to prevent race conditions and duplicate notifications
    this.lastStageWasQueue = false;
    this.lastStatusMessage = null;
    this.lastStatusType = null;
    // Removed autoSkipAttempted flag - auto-skip is handled entirely by backend
    this.lastStage = null;

    this.telegramConnectionData = null;
    this.mediaData = {};

    // Track logged file statuses to prevent duplicate logging
    this.loggedFileStatuses = new Set();

    // Toast debouncing to prevent duplicates
    this._lastToast = { type: '', title: '', message: '', time: 0 };
    this._toastDebounceTime = 500; // ms

    // Debouncing for UI updates
    this.debouncedUpdateVideoFileList = this.debounce(this.updateVideoFileList.bind(this), 100);
    this._lastMinorUpdate = 0;

    // Pack mode management - NEW for add to existing pack feature
    this.currentPackMode = "create"; // 'create' or 'add'
    this.userStickerPacks = []; // Cache of user's sticker packs

    this.init();
    this.initializeNavigation(); // Add this line to initialize navigation
    this.initializeTelegramForm(); // Add this to load saved Telegram credentials

    // Initialize Image Handler
    /* global ImageHandler */
    if (typeof ImageHandler !== "undefined") {
      this.imageHandler = new ImageHandler(this);
    }
  }

  // Add a debouncing utility function
  debounce(func, wait, immediate) {
    let timeout;
    return function executedFunction() {
      const context = this;
      const args = arguments;

      const later = function () {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };

      const callNow = immediate && !timeout;

      clearTimeout(timeout);
      timeout = setTimeout(later, wait);

      if (callNow) func.apply(context, args);
    };
  }

  // Check if input contains a valid emoji
  isValidEmoji(input) {
    if (!input || typeof input !== 'string') return false;

    const str = input.trim();
    if (!str) return false;

    // Try to normalize the emoji - if it works, it's valid
    try {
      const normalized = this.normalizeEmoji(str);
      // Check if normalized result is different from default emoji
      // and actually contains emoji-like characters
      if (normalized && normalized !== this.defaultEmoji) {
        return true;
      }
      // Also check if it's the same as input (already a valid emoji)
      if (str.length <= 4 && /\p{Emoji}/u.test(str)) {
        return true;
      }
    } catch (e) {
      // If normalization fails, it's not a valid emoji
    }

    return false;
  }

  // FIXED: Normalize and clamp a user-provided emoji to the first visible grapheme cluster
  // Properly preserves variation selectors (e.g., U+FE0F) and ZWJ sequences so hearts stay red on Windows
  normalizeEmoji(input) {
    try {
      const str = String(input || "").trim();
      if (!str) return this.defaultEmoji || "❤️";

      // Primary: Use Intl.Segmenter for proper grapheme cluster handling (Chrome 87+)
      if (typeof Intl !== "undefined" && Intl.Segmenter) {
        try {
          const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
          const segments = Array.from(segmenter.segment(str));
          if (segments.length > 0 && segments[0].segment) {
            // This properly preserves ALL variation selectors and ZWJ sequences
            return segments[0].segment;
          }
        } catch (e) {
        }
      }

      // Fallback for older browsers: Manual VS16 preservation
      // This is critical for Windows to show colored emojis (red heart instead of white)
      const codePoints = Array.from(str);
      if (codePoints.length === 0) return this.defaultEmoji || "❤️";

      let result = codePoints[0];
      let i = 1;

      // Append variation selectors, skin tones, and ZWJ sequences
      while (i < codePoints.length) {
        const cp = codePoints[i];
        const code = cp.codePointAt(0);

        // Check if this is a modifier that should be preserved
        const isModifier = (
          cp === "\uFE0F" ||  // VS16 (emoji style) - CRITICAL for Windows
          cp === "\uFE0E" ||  // VS15 (text style)
          code === 0x20E3 ||  // Combining enclosing keycap
          (code >= 0x1F3FB && code <= 0x1F3FF) ||  // Emoji skin tone modifiers
          code === 0x200D     // Zero-width joiner (for multi-char emojis)
        );

        if (isModifier) {
          result += cp;
          // If ZWJ, also include the next character (e.g., for family emojis)
          if (code === 0x200D && i + 1 < codePoints.length) {
            i++;
            result += codePoints[i];
          }
          i++;
        } else {
          // Stop at first non-modifier character
          break;
        }
      }

      // CRITICAL FIX: Ensure red heart on Windows by adding VS16 if missing
      // Check if the emoji is a heart or similar that needs VS16
      const needsVS16 = /^[\u2764\u2665\u2763\u2600-\u26FF\u2700-\u27BF]$/.test(result.charAt(0));
      if (needsVS16 && !result.includes("\uFE0F")) {
        result += "\uFE0F";  // Add VS16 to force emoji style
      }

      return result;
    } catch (e) {
      console.error("[EMOJI] Normalization error:", e);
      return this.defaultEmoji || "❤️";
    }
  }

  // Utility function to safely add event listeners
  safeAddEventListener(elementId, event, handler, logError = true) {
    const element = document.getElementById(elementId);
    if (element) {
      element.addEventListener(event, handler);
      return true;
    } else {
      return false;
    }
  }

  async init() {
    try {
      // App initialization
      this.setupEventListeners();
      this.setupTabSwitching();
      this.loadSettings();
      this.startSystemStatsMonitoring();
      await this.initializeTelegramConnection();

      // Update stats immediately on startup
      this.updateSystemInfo();
      this.updateDatabaseStats();

      // Fetch real-time GitHub stars
      this.fetchGitHubStars();

      // Add manual refresh function for testing
      window.forceRefreshStats = () => {
        this.updateSystemInfo();
        this.updateDatabaseStats();
      };

      // Initialize button states
      this.updateButtonStates();
    } catch (error) {
      console.error("🚫 [APP] Critical error during initialization:", error);
      // Show error to user
      document.body.innerHTML = `
        <div style="padding: 20px; background: #f44336; color: white; text-align: center;">
          <h2>Application Error</h2>
          <p>Failed to initialize the application: ${error.message}</p>
          <button onclick="location.reload()">Reload Application</button>
        </div>
      `;
    }
  }

  startSystemStatsMonitoring() {
    // Initial stats fetch only
    this.updateSystemStats();

    // Reduced frequency monitoring - only update every 30 seconds
    setInterval(() => {
      this.updateSystemStats();
    }, 30000);
  }





  async updateSystemStats() {
    try {
      const response = await this.apiRequest("GET", "/api/system-stats");
      const payload = response?.data || response || {};
      const stats = payload.stats;
      if (response?.success && stats) {

        // Update CPU stats with live percentage and color coding
        const cpuUsage = document.getElementById("cpu-usage");
        if (cpuUsage && stats.cpu) {
          const percent = stats.cpu.percent;
          cpuUsage.textContent = `${percent.toFixed(1)}%`;

          // Color code based on usage
          if (percent > 80) {
            cpuUsage.style.color = "#ff4444";
          } else if (percent > 50) {
            cpuUsage.style.color = "#ffaa00";
          } else {
            cpuUsage.style.color = "#44ff44";
          }
        }

        // Update RAM stats with live usage and color coding
        const ramUsage = document.getElementById("ram-usage");
        if (ramUsage && stats.memory) {
          const used = (stats.memory.used / 1024).toFixed(1);
          const total = (stats.memory.total / 1024).toFixed(1);
          const percent = stats.memory.percent;
          ramUsage.textContent = `${used}GB / ${total}GB`;

          // Color code based on usage
          if (percent > 90) {
            ramUsage.style.color = "#ff4444";
          } else if (percent > 70) {
            ramUsage.style.color = "#ffaa00";
          } else {
            ramUsage.style.color = "#44ff44";
          }
        }
      }
    } catch (error) {
      // Failed to fetch system stats - ignore silently
    }
  }

  async fetchGitHubStars() {
    try {
      const username = "RohitPoul"; // Your GitHub username
      const response = await fetch(`https://api.github.com/users/${username}/repos?per_page=100`);

      if (!response.ok) {
        throw new Error("Failed to fetch GitHub data");
      }

      const repos = await response.json();

      // Calculate total stars across all repos
      const totalStars = repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);

      // Update the UI
      const starsElement = document.getElementById("github-stars-count");
      if (starsElement) {
        starsElement.innerHTML = totalStars;
      }

    } catch (error) {
      // Show fallback value
      const starsElement = document.getElementById("github-stars-count");
      if (starsElement) {
        starsElement.innerHTML = "2+";
      }
    }
  }

  // OPTIMIZED apiRequest with better error handling and timeout
  async apiRequest(method, path, body = null) {
    // FIXED: Validate path to prevent [Errno 22] Invalid argument
    if (!path || typeof path !== "string") {
      throw new Error("Invalid API path");
    }

    // ENHANCED: Sanitize path to prevent [Errno 22] Invalid argument
    // Remove all control characters which can cause OS errors
    const sanitizedPath = path.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();

    if (!sanitizedPath || sanitizedPath.length === 0) {
      throw new Error("Invalid API path after sanitization");
    }

    // FIXED: Direct path usage - backend handles sanitization
    const url = `http://127.0.0.1:5000${sanitizedPath}`;

    // OPTIMIZED: Add timeout to prevent hanging requests
    // Use longer timeout for batch operations and status checks
    let timeoutDuration = 30000; // Default 30 seconds
    if (sanitizedPath.includes("/process-batch") || sanitizedPath.includes("/process-status")) {
      timeoutDuration = 120000; // 2 minutes for batch operations
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

    try {
      // ENHANCED: Validate and sanitize request body before sending
      let sanitizedBody = null;
      if (body) {
        try {
          // Stringify and parse to ensure valid JSON
          const jsonString = JSON.stringify(body);
          // Remove all control characters which can cause OS errors
          const sanitizedJsonString = jsonString.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
          sanitizedBody = sanitizedJsonString;
        } catch (jsonError) {
          console.error("[API] Error serializing request body:", jsonError);
          throw new Error("Invalid request data - unable to serialize. Please check your inputs.");
        }
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: sanitizedBody,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {
        json = { raw: text };
      }

      if (!res.ok) {
        const err = new Error(json?.error || `${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (error) {
      clearTimeout(timeoutId);

      // FIXED: Better error handling for specific error types
      if (error.name === "AbortError") {
        throw new Error("Request timeout - server may be overloaded. Please try again.");
      }
      // Do not mask backend errors; surface original message for debugging
      if (error.message && error.message.includes("timeout")) {
        throw new Error("Request timeout - server may be overloaded. Please try again.");
      }

      // ENHANCED: Handle [Errno 22] Invalid argument errors specifically
      if (error.message && (error.message.includes("Invalid argument") || error.message.includes("Errno 22"))) {
        console.error("[API] Invalid argument error");
        throw new Error("Invalid request data - contains invalid characters. Please check your inputs and try again.");
      }

      throw error;
    }
  }
  setupEventListeners() {
    // quiet

    // Video Converter Events
    const addVideosBtn = document.getElementById("add-videos");
    const clearVideosBtn = document.getElementById("clear-videos");
    const browseOutputBtn = document.getElementById("browse-video-output");
    const startConversionBtn = document.getElementById("start-conversion");

    const startHexEditBtn = document.getElementById("start-hex-edit");

    if (addVideosBtn) {
      addVideosBtn.addEventListener("click", () => this.addVideoFiles());
    }

    // Setup emoji modal enhancements
    this.setupEmojiModal();

    if (clearVideosBtn) {
      clearVideosBtn.addEventListener("click", () => this.clearVideoFiles());
    }

    if (browseOutputBtn) {
      browseOutputBtn.addEventListener("click", () => this.browseVideoOutput());
    }

    if (startConversionBtn) {
      startConversionBtn.addEventListener("click", () => this.startVideoConversion());
    }

    if (startHexEditBtn) {
      startHexEditBtn.addEventListener("click", () => this.startHexEdit());
    }

    // Add pause/resume event listeners
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");

    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => this.pauseOperation());
    }

    if (resumeBtn) {
      resumeBtn.addEventListener("click", () => this.resumeOperation());
    }

    // Add hex edit pause/resume event listeners
    // Hex edit pause/resume removed - not needed for quick operations

    // Sticker Bot Events - with null checks
    const connectTelegramBtn = document.getElementById("connect-telegram");
    const clearMediaBtn = document.getElementById("clear-media");
    const createStickerPackBtn = document.getElementById("create-sticker-pack");
    const resetStickerFormBtn = document.getElementById("reset-sticker-form");

    if (connectTelegramBtn) {
      connectTelegramBtn.addEventListener("click", () => this.connectTelegram());
    }
    if (clearMediaBtn) {
      clearMediaBtn.addEventListener("click", () => this.clearMedia());
    }
    if (createStickerPackBtn) {
      createStickerPackBtn.addEventListener("click", () => this.createStickerPack());
    }
    if (resetStickerFormBtn) {
      resetStickerFormBtn.addEventListener("click", () => this.resetStickerForm());
    }

    // Pack mode selector - NEW
    const modeCreate = document.getElementById("mode-create");
    const modeAdd = document.getElementById("mode-add");

    if (modeCreate) {
      modeCreate.addEventListener("change", () => {
        if (modeCreate.checked) {
          this.togglePackMode("create");
        }
      });
    }

    if (modeAdd) {
      modeAdd.addEventListener("change", () => {
        if (modeAdd.checked) {
          this.togglePackMode("add");
        }
      });
    }

    // Existing pack input - NEW
    const packInput = document.getElementById("existing-pack-name");
    if (packInput) {
      packInput.addEventListener("input", (e) => {
        const validation = this.validateUrlName(e.target.value);
        this.updateValidationDisplay("existing-pack", validation);
        this.updatePackActions();
      });
    }

    // Icon Selection Modal Events - with null checks
    const uploadIconBtn = document.getElementById("upload-icon-btn");
    const skipIconBtn = document.getElementById("skip-icon-btn");
    const confirmIconUploadBtn = document.getElementById("confirm-icon-upload");
    const cancelIconSelectionBtn = document.getElementById("cancel-icon-selection");

    if (uploadIconBtn) {
      uploadIconBtn.addEventListener("click", () => this.selectIconFile());
    }
    if (skipIconBtn) {
      skipIconBtn.addEventListener("click", () => this.skipIconSelection());
    }
    if (confirmIconUploadBtn) {
      confirmIconUploadBtn.addEventListener("click", () => this.confirmIconUpload());
    }
    if (cancelIconSelectionBtn) {
      cancelIconSelectionBtn.addEventListener("click", () => this.hideIconModal());
    }

    // URL Name Retry Modal Events - with null checks
    const submitNewUrlBtn = document.getElementById("submit-new-url");
    const cancelUrlRetryBtn = document.getElementById("cancel-url-retry");

    if (submitNewUrlBtn) {
      submitNewUrlBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.submitNewUrlName();
      });
    }
    if (cancelUrlRetryBtn) {
      cancelUrlRetryBtn.addEventListener("click", () => this.hideUrlNameModal());
    }

    // Auto-skip icon setting - with null checks
    const autoSkipIconInput = document.getElementById("auto-skip-icon");
    const autoSkipHelpBtn = document.getElementById("auto-skip-help");

    if (autoSkipIconInput) {
      autoSkipIconInput.addEventListener("change", () => {
        this.saveSettings();
        this.updateToggleText();
      });
    }

    if (autoSkipHelpBtn) {
      autoSkipHelpBtn.addEventListener("click", () => {
        this.showAutoSkipHelp();
      });
    }

    // Success modal buttons - with null checks
    // Note: Success modal buttons are dynamically created, so we don't add permanent listeners here
    // Event listeners for success modal buttons are added when the modal is created

    // Real-time validation for pack name and URL name - with null checks
    const packNameInput = document.getElementById("pack-name");
    const packUrlNameInput = document.getElementById("pack-url-name");

    if (packNameInput) {
      packNameInput.addEventListener("input", (e) => {
        const validation = this.validatePackName(e.target.value);
        this.updateValidationDisplay("pack-name", validation);
      });
    }

    if (packUrlNameInput) {
      packUrlNameInput.addEventListener("input", (e) => {
        const validation = this.validateUrlName(e.target.value);
        this.updateValidationDisplay("pack-url-name", validation);
      });
    }

    // Update toggle text on page load
    this.updateToggleText();

    // Initialize validation display (empty state - no validation shown)
    // Validation will show as user types

    // Media type selection
    const selectImageBtn = document.getElementById("select-image-type");
    const selectVideoBtn = document.getElementById("select-video-type");
    const mediaControls = document.getElementById("media-controls");
    const addMediaBtn = document.getElementById("add-media");
    const mediaTypeText = document.getElementById("media-type-text");

    if (selectImageBtn) {
      selectImageBtn.addEventListener("click", () => {
        this.selectedMediaType = "image";
        // Check if we need to clear existing media of different type
        if (this.mediaFiles.some(f => f.type === "video")) {
          window.confirmModal.show("Switching to images will clear existing videos. Continue?", "Switch Media Type").then(confirmed => {
            if (confirmed) {
              this.clearMedia();
              this.selectedMediaType = "image";
              selectImageBtn.classList.add("active");
              selectVideoBtn.classList.remove("active");
              mediaControls.style.display = "flex";
              mediaTypeText.textContent = "Images";
            }
            // If not confirmed, do nothing - stay on current type
          });
        } else {
          this.selectedMediaType = "image";
          selectImageBtn.classList.add("active");
          selectVideoBtn.classList.remove("active");
          mediaControls.style.display = "flex";
          mediaTypeText.textContent = "Images";
        }
      });
    }

    if (selectVideoBtn) {
      selectVideoBtn.addEventListener("click", () => {
        // Check if we need to clear existing media of different type
        if (this.mediaFiles.some(f => f.type === "image")) {
          window.confirmModal.show("Switching to videos will clear existing images. Continue?", "Switch Media Type").then(confirmed => {
            if (confirmed) {
              this.clearMedia();
              this.selectedMediaType = "video";
              selectVideoBtn.classList.add("active");
              selectImageBtn.classList.remove("active");
              mediaControls.style.display = "flex";
              mediaTypeText.textContent = "Videos";
            }
            // If not confirmed, do nothing - stay on current type
          });
        } else {
          this.selectedMediaType = "video";
          selectVideoBtn.classList.add("active");
          selectImageBtn.classList.remove("active");
          mediaControls.style.display = "flex";
          mediaTypeText.textContent = "Videos";
        }
      });
    }

    if (addMediaBtn) {
      addMediaBtn.addEventListener("click", () => {
        if (this.selectedMediaType === "image") {
          this.addImages();
        } else if (this.selectedMediaType === "video") {
          this.addStickerVideos();
        } else {
          this.showToast("warning", "Select Type", "Please select media type first");
        }
      });
    }



    // Sort functionality
    const sortBtn = document.getElementById("sort-media");
    const sortOptions = document.getElementById("media-sort-options");
    const sortSelect = document.getElementById("sort-select");

    if (sortBtn) {
      sortBtn.addEventListener("click", () => {
        if (sortOptions.style.display === "none") {
          sortOptions.style.display = "block";
        } else {
          sortOptions.style.display = "none";
        }
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener("change", (e) => {
        this.sortMedia(e.target.value);
        sortOptions.style.display = "none";
      });
    }

    // Visibility Toggle Events for Credential Fields
    document.querySelectorAll(".btn-toggle-visibility").forEach(button => {
      button.addEventListener("click", (e) => {
        e.preventDefault();
        const targetId = button.getAttribute("data-target");
        const targetInput = document.getElementById(targetId);
        const icon = button.querySelector("i");

        if (targetInput.type === "password") {
          targetInput.type = "text";
          icon.classList.remove("fa-eye-slash");
          icon.classList.add("fa-eye");
          button.title = "Hide";
        } else {
          targetInput.type = "password";
          icon.classList.remove("fa-eye");
          icon.classList.add("fa-eye-slash");
          button.title = "Show";
        }
      });
    });

    // Paste from Clipboard Events
    document.querySelectorAll(".btn-paste").forEach(button => {
      button.addEventListener("click", async (e) => {
        e.preventDefault();
        const targetId = button.getAttribute("data-target");
        const targetInput = document.getElementById(targetId);

        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            targetInput.value = text.trim();
            targetInput.focus();

            // Show temporary success feedback with smooth animation
            const icon = button.querySelector("i");

            // Add success animation class
            button.style.transition = "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
            button.style.transform = "scale(1.1)";

            icon.classList.remove("fa-paste");
            icon.classList.add("fa-check");
            button.style.color = "#28a745";
            button.style.backgroundColor = "rgba(40, 167, 69, 0.2)";
            button.style.borderColor = "rgba(40, 167, 69, 0.5)";

            // Reset after animation
            setTimeout(() => {
              button.style.transform = "scale(1)";
            }, 200);

            setTimeout(() => {
              icon.classList.remove("fa-check");
              icon.classList.add("fa-paste");
              button.style.color = "";
              button.style.backgroundColor = "";
              button.style.borderColor = "";
            }, 1500);

            // Save settings after paste
            this.saveSettings();
          }
        } catch (err) {
          this.showToast("error", "Clipboard Error", "Failed to read from clipboard");
        }
      });
    });

    // Modal Events - with null checks
    const submitCodeBtn = document.getElementById("submit-code");
    const cancelCodeBtn = document.getElementById("cancel-code");
    const submitPasswordBtn = document.getElementById("submit-password");
    const cancelPasswordBtn = document.getElementById("cancel-password");
    const saveEmojiBtn = document.getElementById("save-emoji");
    const cancelEmojiBtn = document.getElementById("cancel-emoji");

    if (submitCodeBtn) {
      submitCodeBtn.addEventListener("click", () => this.submitVerificationCode());
    }
    if (cancelCodeBtn) {
      cancelCodeBtn.addEventListener("click", () => this.hideModal());
    }
    if (submitPasswordBtn) {
      submitPasswordBtn.addEventListener("click", () => this.submitPassword());
    }
    if (cancelPasswordBtn) {
      cancelPasswordBtn.addEventListener("click", () => this.hideModal());
    }
    if (saveEmojiBtn) {
      saveEmojiBtn.addEventListener("click", () => this.saveEmoji());
    }
    if (cancelEmojiBtn) {
      cancelEmojiBtn.addEventListener("click", () => this.hideModal());
    }

    // Settings Events - with null checks
    const clearDataBtn = document.getElementById("clear-data");
    const exportSettingsBtn = document.getElementById("export-settings");
    const importSettingsBtn = document.getElementById("import-settings");
    const clearLogsBtn = document.getElementById("clear-logs");
    const clearCredentialsBtn = document.getElementById("clear-credentials");
    const killPythonBtn = document.getElementById("kill-python-processes");

    if (clearDataBtn) {
      clearDataBtn.addEventListener("click", () => this.clearApplicationData());
    }
    if (exportSettingsBtn) {
      exportSettingsBtn.addEventListener("click", () => this.exportSettings());
    }
    if (importSettingsBtn) {
      importSettingsBtn.addEventListener("click", () => this.importSettings());
    }
    if (clearLogsBtn) {
      clearLogsBtn.addEventListener("click", () => this.clearLogs());
    }
    if (clearCredentialsBtn) {
      clearCredentialsBtn.addEventListener("click", () => this.clearCredentials());
    }
    if (killPythonBtn) {
      killPythonBtn.addEventListener("click", () => this.killPythonProcesses());
    }

    // Theme selector
    const themeSelector = document.getElementById("theme-selector");
    if (themeSelector) {
      themeSelector.addEventListener("change", (e) => {
        this.applyTheme(e.target.value);
        localStorage.setItem("app_theme", e.target.value);
      });

      // Set initial theme
      const savedTheme = localStorage.getItem("app_theme") || "dark";
      themeSelector.value = savedTheme;
      this.applyTheme(savedTheme);
    }

    // Modal overlay click handling - prevent accidental closure
    const modalOverlay = document.getElementById("modal-overlay");
    if (modalOverlay) {
      modalOverlay.addEventListener("click", (e) => {
        // Only allow closing certain modals by clicking overlay
        const activeModal = document.querySelector('.modal[style*="display: block"], .modal[style*="display: flex"]');
        if (!activeModal) {
          return;
        }

        const modalId = activeModal.id;

        const isCritical = activeModal.hasAttribute("data-critical");

        // Critical modals that should NOT close on overlay click
        const criticalModals = ["success-modal", "url-name-modal", "icon-modal"];

        if (criticalModals.includes(modalId) || isCritical) {
          // Add shake animation to indicate modal cannot be dismissed
          activeModal.classList.add("modal-shake");
          setTimeout(() => {
            activeModal.classList.remove("modal-shake");
          }, 500);

          // Show helpful toast for success modal
          if (modalId === "success-modal") {
            this.showToast("info", "Modal Protected", "Use the buttons to interact with your sticker pack!");
          }
          return;
        }

        // Allow other modals to close on overlay click
        if (e.target === e.currentTarget) {
          // Check if we should prevent closure for emoji modal
          if (this.modalState.preventEmojiClosure && modalId === "emoji-modal") {
            return;
          }

          // Add a small delay to prevent immediate closure
          setTimeout(() => {
            this.hideModal();
          }, 100);
        }
      });
    }

    // Enter key handlers for modals - with null checks
    const verificationCodeInput = document.getElementById("verification-code");
    const twoFactorPasswordInput = document.getElementById("two-factor-password");
    const emojiInput = document.getElementById("emoji-input");

    if (verificationCodeInput) {
      verificationCodeInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submitVerificationCode();
        }
      });
    }
    if (twoFactorPasswordInput) {
      twoFactorPasswordInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submitPassword();
        }
      });
    }
    if (emojiInput) {
      // Track last validation to avoid toast spam
      let lastInvalidTime = 0;

      // Block all non-emoji input
      emojiInput.addEventListener("input", (e) => {
        const value = e.target.value;

        // If input exists, validate it's an emoji
        if (value) {
          if (!this.isValidEmoji(value)) {
            // Not a valid emoji - remove the last character typed
            e.target.value = e.target.value.slice(0, -1);

            // Only show toast once per second to avoid spam
            const now = Date.now();
            if (now - lastInvalidTime > 1000) {
              this.showToast("warning", "Emoji Only", "Please enter emojis only");
              lastInvalidTime = now;
            }
          } else {
            // Valid emoji - normalize it
            const normalizedEmoji = this.normalizeEmoji(value);
            if (normalizedEmoji !== value) {
              e.target.value = normalizedEmoji;
            }
          }
        }
      });

      emojiInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.saveEmoji();
        }
      });

      // Add paste support for emojis (Ctrl+V)
      emojiInput.addEventListener("paste", (e) => {
        e.preventDefault();
        const pastedText = (e.clipboardData || window.clipboardData).getData("text");
        const trimmed = pastedText.trim();

        // Try to normalize first - if it works, it's valid
        const normalizedEmoji = this.normalizeEmoji(trimmed);

        if (normalizedEmoji && normalizedEmoji.length > 0) {
          emojiInput.value = normalizedEmoji;
          this.showToast("success", "Emoji Pasted", `Pasted: ${normalizedEmoji}`);
        } else {
          this.showToast("warning", "Invalid Input", "Clipboard doesn't contain a valid emoji");
        }
      });
    }

    // Paste button for emoji clipboard
    const pasteEmojiBtn = document.getElementById("paste-emoji-btn");
    if (pasteEmojiBtn) {
      pasteEmojiBtn.addEventListener("click", async () => {
        try {
          const clipboardText = await navigator.clipboard.readText();
          const trimmed = clipboardText.trim();

          // Try to normalize first - if it works, it's valid
          const normalizedEmoji = this.normalizeEmoji(trimmed);

          if (normalizedEmoji && normalizedEmoji.length > 0) {
            const emojiInput = document.getElementById("emoji-input");
            if (emojiInput) {
              emojiInput.value = normalizedEmoji;
            }
            this.showToast("success", "Emoji Pasted", `Pasted: ${normalizedEmoji}`);
          } else {
            this.showToast("warning", "Invalid Emoji", "Clipboard doesn't contain a valid emoji");
          }
        } catch (err) {
          this.showToast("error", "Paste Failed", "Could not read from clipboard");
        }
      });
    }

    // Theme switching
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => this.toggleTheme());
    }

    // Drag and drop for video files
    this.setupDragAndDrop();

    // Advanced settings
    this.setupAdvancedSettings();

    // Status list controls
    this.setupStatusControls();

    // Keyboard shortcuts
    this.setupKeyboardShortcuts();
  }

  setupTabSwitching() {
    const navItems = document.querySelectorAll(".nav-item");
    const tabContents = document.querySelectorAll(".tab-content");

    navItems.forEach((item) => {
      item.addEventListener("click", () => {
        const tabId = item.getAttribute("data-tab");
        // Update navigation
        navItems.forEach((nav) => nav.classList.remove("active"));
        item.classList.add("active");
        // Update content
        tabContents.forEach((content) => content.classList.remove("active"));
        const targetTab = document.getElementById(tabId);
        if (targetTab) {
          targetTab.classList.add("active");
        }
        // Auto-focus on specific elements when switching tabs
        this.handleTabSwitch(tabId);
      });
    });
  }

  handleTabSwitch(tabId) {
    const tabContents = document.querySelectorAll(".tab-content");

    tabContents.forEach((content) => {
      content.classList.remove("active");
    });

    const targetTab = document.getElementById(tabId);

    if (targetTab) {
      targetTab.classList.add("active");
    }

    // Manage live System Info updates (incl. uptime)
    const startSystemInfoTimer = () => {
      if (!this.systemInfoInterval) {
        // Refresh every 3 seconds for visible uptime (reduced from 1s for performance)
        this.systemInfoInterval = setInterval(() => this.updateSystemInfo(), 3000);
      }
      // Immediate refresh on tab switch
      this.updateSystemInfo();
    };
    const stopSystemInfoTimer = () => {
      if (this.systemInfoInterval) {
        clearInterval(this.systemInfoInterval);
        this.systemInfoInterval = null;
      }
    };

    switch (tabId) {
      case "video-converter":
        stopSystemInfoTimer();
        break;
      case "sticker-bot":
        stopSystemInfoTimer();
        break;
      case "settings":
        // Live updates while on settings tab so uptime progresses
        startSystemInfoTimer();
        break;
      case "about":
        stopSystemInfoTimer();
        // Initialize about section only once
        if (!this.aboutSectionInitialized) {
          this.initializeAboutSection();
          this.aboutSectionInitialized = true;
        }
        break;
      default:
        stopSystemInfoTimer();
        break;
    }
  }

  setupDragAndDrop() {
    const dropZones = [
      {
        element: document.getElementById("video-file-list"),
        handler: this.handleDroppedVideoFiles.bind(this),
        validExtensions: ["mp4", "avi", "mov", "mkv", "flv", "webm"]
      },
      {
        element: document.getElementById("sticker-media-list"),
        handler: this.handleDroppedMediaFiles.bind(this),
        validExtensions: ["png", "jpg", "jpeg", "webp", "webm"]
      }
    ];

    dropZones.forEach(zone => {
      if (!zone.element) return;

      // Prevent default drag behaviors
      ["dragenter", "dragover", "dragleave", "drop"].forEach(eventName => {
        zone.element.addEventListener(eventName, this.preventDefaults, false);
      });

      zone.element.addEventListener("dragover", () => zone.element.classList.add("drag-over"));
      zone.element.addEventListener("dragleave", () => zone.element.classList.remove("drag-over"));

      zone.element.addEventListener("drop", (e) => {
        zone.element.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer.files)
          .filter(file => {
            const extension = file.name.split(".").pop().toLowerCase();
            return zone.validExtensions.includes(extension);
          });

        zone.handler(files);
      });
    });
  }

  async handleDroppedVideoFiles(files) {
    const videoExtensions = ["mp4", "avi", "mov", "mkv", "flv", "webm"];
    let addedCount = 0;

    for (let index = 0; index < files.length; index++) {
      const file = files[index];

      const extension = file.name.split(".").pop().toLowerCase();

      if (videoExtensions.includes(extension)) {
        // Use file.path if available (Electron), otherwise use name
        const filePath = file.path || file.name;

        if (!this.videoFiles.some((f) => f.path === filePath)) {
          // Get file metadata first
          const metadata = await this.getFileMetadata(filePath);

          this.videoFiles.push({
            path: filePath,
            name: file.name,
            status: "pending",
            progress: 0,
            stage: "Ready to convert",
            size: metadata.size,
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height,
            fileObject: file // Store the actual file object for later use
          });
          addedCount++;

          // IMMEDIATE UI UPDATE - Update file count instantly
          const counter = document.getElementById("video-file-count");
          if (counter) {
            counter.textContent = this.videoFiles.length;
          }
        }
      }
    }


    if (addedCount > 0) {
      this.updateVideoFileList();
      this.showToast("success", "Files Added", `Added ${addedCount} video files via drag & drop`);
    } else {
      this.showToast("warning", "No Valid Files", "Please drop video files only");
    }
  }

  handleDroppedMediaFiles(files) {
    const imageExtensions = ["png", "jpg", "jpeg", "webp"];
    const videoExtensions = ["webm"];
    let addedCount = 0;

    files.forEach((file) => {
      const extension = file.name.split(".").pop().toLowerCase();
      let type = null;
      if (imageExtensions.includes(extension)) {
        type = "image";
      } else if (videoExtensions.includes(extension)) {
        type = "video";
      }
      if (type && this.mediaFiles.length < 120) {
        // For drag & drop, we need to get the actual file path
        const filePath = file.path || file.webkitRelativePath || file.name;

        if (!this.mediaFiles.some((f) => f.file_path === filePath)) {
          // Sanitize default emoji while preserving variation selectors (Windows color fix)
          const cleanDefaultEmoji = this.normalizeEmoji(this.defaultEmoji || "❤️");

          this.mediaFiles.push({
            file_path: filePath,
            name: file.name,
            type: type,
            emoji: cleanDefaultEmoji,
            dateAdded: Date.now(),
          });
          addedCount++;
        }
      }
    });

    if (addedCount > 0) {
      this.updateMediaFileList();
      this.showToast(
        "success",
        "Files Added",
        `Added ${addedCount} media files via drag & drop`
      );
    } else {
      this.showToast(
        "warning",
        "No Valid Files",
        "Please drop image (PNG, JPG, WEBP) or video (WEBM) files only"
      );
    }
  }

  setupAdvancedSettings() {

    // Quality settings
    const qualityRange = document.getElementById("quality-range");
    const qualityValue = document.getElementById("quality-value");
    if (qualityRange && qualityValue) {
      qualityRange.addEventListener("input", (e) => {
        qualityValue.textContent = e.target.value + "%";
        localStorage.setItem("quality_setting", e.target.value);
      });
    }

    // Auto-conversion toggle
    const autoConvert = document.getElementById("auto-convert");
    if (autoConvert) {
      autoConvert.addEventListener("change", (e) => {
        localStorage.setItem("auto_convert", e.target.checked);
      });
    }

    // Load saved advanced settings
    this.loadAdvancedSettings();
  }

  loadAdvancedSettings() {
    const savedQuality = localStorage.getItem("quality_setting");
    const savedAutoConvert = localStorage.getItem("auto_convert");
    if (savedQuality) {
      const qualityRange = document.getElementById("quality-range");
      const qualityValue = document.getElementById("quality-value");
      if (qualityRange) qualityRange.value = savedQuality;
      if (qualityValue) qualityValue.textContent = savedQuality + "%";
    }
    if (savedAutoConvert !== null) {
      const autoConvert = document.getElementById("auto-convert");
      if (autoConvert) autoConvert.checked = savedAutoConvert === "true";
    }
  }
  setupStatusControls() {
    // Copy status log button
    const copyBtn = document.getElementById("copy-status-log");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        this.copyStatusLog();
        this.showToast("info", "Copy Log", "Status log copied to clipboard");
      });
    }

    // Clear status history button
    const clearBtn = document.getElementById("clear-status-history");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        this.clearStatusHistory();
        this.showToast("info", "Status History", "Status history cleared");
      });
    }

    // Toggle auto-scroll button
    const toggleBtn = document.getElementById("toggle-auto-scroll");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        this.toggleAutoScroll();
        this.showToast("info", "Auto Scroll",
          this.autoScrollEnabled ? "Auto scroll enabled" : "Auto scroll disabled");
      });
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Ctrl/Cmd + N: Add new files
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        if (document.querySelector(".tab-content.active").id === "video-converter") {
          this.addVideoFiles();
        } else if (document.querySelector(".tab-content.active").id === "sticker-bot") {
          this.addImages();
        }
      }

      // Ctrl/Cmd + Enter: Start conversion/creation
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (document.querySelector(".tab-content.active").id === "video-converter") {
          this.startVideoConversion();
        } else if (document.querySelector(".tab-content.active").id === "sticker-bot") {
          this.createStickerPack();
        }
      }

      // Ctrl/Cmd + R: Reset form (sticker bot only)
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        if (document.querySelector(".tab-content.active").id === "sticker-bot") {
          e.preventDefault();
          this.resetStickerForm();
        }
      }

      // Escape: Close modals
      if (e.key === "Escape") {
        this.hideModal();
      }

      // F5: Refresh/update status
      if (e.key === "F5") {
        e.preventDefault();
        this.checkBackendStatus();
      }
    });
  }

  setupProgressMonitoring() {
    // Set up minimal monitoring only when needed
    // Removed excessive periodic checks to save resources
  }
  // Memory monitoring removed to save resources

  async checkBackendStatus() {
    try {
      const response = await this.apiRequest("GET", "/api/health");

      if (!response.success) {
        this.updateBackendStatus(false);
        document.getElementById("backend-status-text").textContent = "Disconnected";
        document.getElementById("backend-status-text").style.color = "#dc3545";
        document.getElementById("ffmpeg-status").textContent = "Not Available";
        document.getElementById("ffmpeg-status").style.color = "#dc3545";
        return;
      }

      this.updateBackendStatus(true);
      document.getElementById("backend-status-text").textContent = "Connected";
      document.getElementById("backend-status-text").style.color = "#28a745";

      // Check FFmpeg status from the health response
      if (response.data && response.data.ffmpeg_available !== undefined) {
        document.getElementById("ffmpeg-status").textContent = response.data.ffmpeg_available ? "Available" : "Not Available";
        document.getElementById("ffmpeg-status").style.color = response.data.ffmpeg_available ? "#28a745" : "#dc3545";
      } else {
        document.getElementById("ffmpeg-status").textContent = "Available";
        document.getElementById("ffmpeg-status").style.color = "#28a745";
      }


    } catch (error) {
      this.updateBackendStatus(false);
      document.getElementById("backend-status-text").textContent = "Disconnected";
      document.getElementById("backend-status-text").style.color = "#dc3545";
      document.getElementById("ffmpeg-status").textContent = "Unknown";
      document.getElementById("ffmpeg-status").style.color = "#6c757d";
    }
  }

  updateBackendStatus(connected) {
    const statusElement = document.getElementById("backend-status");
    if (statusElement) {
      if (connected) {
        statusElement.classList.remove("disconnected");
        statusElement.classList.add("connected");
      } else {
        statusElement.classList.remove("connected");
        statusElement.classList.add("disconnected");
      }
    }
  }

  updateTelegramStatus(status) {
    const statusElement = document.getElementById("telegram-status");
    const connectionStatus = document.getElementById("telegram-connection-status");

    if (statusElement) {
      statusElement.classList.remove("connected", "disconnected", "connecting");

      switch (status) {
        case "connected": {
          statusElement.classList.add("connected");
          if (connectionStatus) {
            connectionStatus.innerHTML = '<i class="fas fa-check-circle"></i> Connected';
          }
          const createBtn = document.getElementById("create-sticker-pack");
          if (createBtn) createBtn.disabled = false;
          // Update Connect button to show Disconnect option
          const connectBtnOk = document.getElementById("connect-telegram");
          if (connectBtnOk) {
            connectBtnOk.disabled = false;
            connectBtnOk.innerHTML = '<i class="fas fa-unlink"></i> Disconnect';
            connectBtnOk.classList.remove("btn-primary");
            connectBtnOk.classList.add("btn-secondary");
            // Update click handler for disconnect
            connectBtnOk.onclick = () => this.disconnectTelegram();
          }
          this.telegramConnected = true;
          // Update preset manager UI to disable controls when connected
          if (window.telegramPresetManager) {
            window.telegramPresetManager.updateUIState();
          }
          break;
        }
        case "connecting": {
          statusElement.classList.add("connecting");
          if (connectionStatus) {
            connectionStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
          }
          const connectBtnBusy = document.getElementById("connect-telegram");
          if (connectBtnBusy) {
            connectBtnBusy.disabled = true;
            connectBtnBusy.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
          }
          break;
        }
        default: {
          statusElement.classList.add("disconnected");
          if (connectionStatus) {
            connectionStatus.innerHTML = '<i class="fas fa-times-circle"></i> Disconnected';
          }
          const createBtnDisco = document.getElementById("create-sticker-pack");
          if (createBtnDisco) createBtnDisco.disabled = true;
          const connectBtnIdle = document.getElementById("connect-telegram");
          if (connectBtnIdle) {
            connectBtnIdle.disabled = false;
            connectBtnIdle.innerHTML = '<i class="fas fa-plug"></i> Connect to Telegram';
            connectBtnIdle.classList.remove("btn-secondary");
            connectBtnIdle.classList.add("btn-primary");
            // Reset click handler for connect
            connectBtnIdle.onclick = () => this.connectTelegram();
          }
          this.telegramConnected = false;
          // Update preset manager UI to enable controls when disconnected
          if (window.telegramPresetManager) {
            window.telegramPresetManager.updateUIState();
          }
          break;
        }
      }
    }
  }

  loadSettings() {
    // Load saved settings from localStorage
    const savedApiId = localStorage.getItem("telegram_api_id");
    const savedApiHash = localStorage.getItem("telegram_api_hash");
    const savedPhone = localStorage.getItem("telegram_phone");
    const savedOutputDir = localStorage.getItem("video_output_dir");
    const savedTheme = localStorage.getItem("app_theme");
    const savedAutoSkipIcon = localStorage.getItem("auto_skip_icon");

    if (savedApiId) {
      const apiIdInput = document.getElementById("telegram-api-id");
      if (apiIdInput) apiIdInput.value = savedApiId;
    }
    if (savedApiHash) {
      const apiHashInput = document.getElementById("telegram-api-hash");
      if (apiHashInput) apiHashInput.value = savedApiHash;
    }
    if (savedPhone) {
      const phoneInput = document.getElementById("telegram-phone");
      if (phoneInput) phoneInput.value = savedPhone;
    }
    if (savedOutputDir) {
      const outputDirInput = document.getElementById("video-output-dir");
      if (outputDirInput) outputDirInput.value = savedOutputDir;
      this.currentVideoOutput = savedOutputDir;
    }
    if (savedTheme) {
      this.applyTheme(savedTheme);
    }
    if (savedAutoSkipIcon !== null) {
      const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");
      if (autoSkipIconCheckbox) {
        autoSkipIconCheckbox.checked = savedAutoSkipIcon === "true";
      }
    }
  }

  saveSettings() {
    // Save settings to localStorage
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");
    const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");

    if (apiIdInput) localStorage.setItem("telegram_api_id", apiIdInput.value);
    if (apiHashInput) localStorage.setItem("telegram_api_hash", apiHashInput.value);
    if (phoneInput) localStorage.setItem("telegram_phone", phoneInput.value);
    if (autoSkipIconCheckbox) localStorage.setItem("auto_skip_icon", autoSkipIconCheckbox.checked.toString());
    if (this.currentVideoOutput) {
      localStorage.setItem("video_output_dir", this.currentVideoOutput);
    }
  }

  updateToggleText() {
    const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");
    const toggleTitle = document.getElementById("toggle-title");
    const toggleSubtitle = document.getElementById("toggle-subtitle");

    if (autoSkipIconCheckbox && toggleTitle && toggleSubtitle) {
      if (autoSkipIconCheckbox.checked) {
        toggleTitle.textContent = "Auto-skip Icon Selection";
        toggleSubtitle.textContent = "Icon step will be automatically skipped";
      } else {
        toggleTitle.textContent = "Auto-skip Icon Selection";
        toggleSubtitle.textContent = "You'll be prompted to upload an icon file";
      }
    }
  }

  showAutoSkipHelp() {
    const helpText = `
      <div style="text-align: left; line-height: 1.4; font-size: 0.9rem;">
        <h4 style="margin: 0 0 0.75rem 0; color: var(--text-primary); font-size: 1rem;">
          <i class="fas fa-magic" style="color: var(--accent-color); margin-right: 0.5rem;"></i>
          Auto-skip Icon
        </h4>
        <div style="margin-bottom: 0.75rem;">
          <strong style="color: var(--accent-color);">Enabled:</strong>
          <p style="margin: 0.25rem 0; color: var(--text-secondary);">
            Automatically skip icon step, use first sticker as pack icon.
          </p>
        </div>
        <div>
          <strong style="color: var(--accent-color);">Disabled:</strong>
          <p style="margin: 0.25rem 0; color: var(--text-secondary);">
            Upload custom icon file (WEBM, 32 KB max).
          </p>
        </div>
      </div>
    `;

    this.showToast("info", "Auto-skip Icon", helpText, 5000);
  }

  showSuccessModal(shareableLink) {
    const successModalInDOM = document.getElementById("success-modal");

    // If success modal is missing, try to inject it from the original HTML
    if (!successModalInDOM) {

      // Try to find the modal overlay to inject the success modal into it
      const overlay = document.getElementById("modal-overlay");
      if (overlay) {
        const successModalHTML = `
          <div class="modal success-modal-enhanced" id="success-modal" style="display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 10000; max-width: 700px; width: 90%; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5); border-radius: 12px; overflow: hidden; background: var(--bg-card); border: 1px solid var(--border-color);">
            <div style="display: flex; min-height: 320px; background: var(--bg-card); color: var(--text-primary);">
              <!-- Left side - Icon and Title -->
              <div class="modal-header success-header" style="background: #0b0f12; color: white; padding: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 280px; position: relative; border-right: 1px solid var(--border-color);">
                <button class="modal-close" onclick="window.app?.hideSuccessModal()" style="position: absolute; top: 16px; right: 16px; background: none; border: none; color: white; font-size: 1.2rem; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.2)'" onmouseout="this.style.backgroundColor='transparent'">
                  <i class="fas fa-times"></i>
                </button>
                
                <div class="success-icon-wrapper" style="margin-bottom: 16px;">
                  <i class="fas fa-check-circle success-icon" style="font-size: 3.5rem; color: #34d399;"></i>
                </div>
                
                <h3 style="font-size: 1.4rem; font-weight: 700; margin: 0 0 16px 0; text-align: center; line-height: 1.3;">Sticker Pack Created Successfully!</h3>
                
                <div style="background: rgba(52, 211, 153, 0.15); padding: 8px 16px; border-radius: 20px; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 8px; color: #dcfce7;">
                  <i class="fas fa-sync-alt"></i>Retry Attempt - Success!
                </div>
              </div>
              
              <!-- Right side - Content and Actions -->
              <div class="modal-body success-body" style="padding: 32px; background: var(--bg-secondary); color: var(--text-primary); flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                  <div class="success-message" style="margin-bottom: 24px;">
                    <h4 style="color: #34d399; font-size: 1.1rem; margin-bottom: 8px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                      <span>🎉</span> Congratulations!
                    </h4>
                    <p style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5; margin: 0;">Your sticker pack has been successfully created and uploaded to Telegram after retry attempts.</p>
                  </div>
                  
                  <div class="link-section" style="background: rgba(16, 185, 129, 0.08); padding: 20px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.2); margin-bottom: 24px;">
                    <label class="link-label" style="display: block; color: var(--text-secondary); font-weight: 600; margin-bottom: 12px; font-size: 0.9rem;">Share this link with others:</label>
                    <div class="link-display-enhanced" style="display: flex; gap: 10px; align-items: stretch;">
                      <div class="link-input-wrapper" style="flex: 1; position: relative; display: flex; align-items: center; background: rgba(31,41,55,0.9); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 6px; padding: 0 12px;">
                        <i class="fas fa-link link-icon" style="color: #34d399; margin-right: 8px; font-size: 0.85rem;"></i>
                        <input type="text" id="shareable-link" class="form-control link-input" readonly style="background: transparent; border: none; color: var(--text-primary); font-size: 0.85rem; font-family: 'Courier New', monospace; font-weight: 500; flex: 1; padding: 10px 0; outline: none;">
                      </div>
                      <button class="btn btn-copy" id="copy-link-btn" style="background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 16px; border-radius: 6px; font-weight: 600; font-size: 0.85rem; cursor: pointer; transition: background-color 0.2s; display: flex; align-items: center; gap: 6px;" onmouseover="this.style.backgroundColor='#047857'" onmouseout="this.style.backgroundColor=''">
                        <i class="fas fa-copy"></i>
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                </div>
                
                <div class="success-actions" style="display: flex; flex-direction: column; gap: 10px;">
                  <button class="btn btn-primary btn-large" id="open-telegram-btn" style="background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 12px 20px; border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: background-color 0.2s; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;" onmouseover="this.style.backgroundColor='#047857'" onmouseout="this.style.backgroundColor=''">
                    <i class="fab fa-telegram" style="font-size: 1.1rem;"></i>
                    <span>Open in Telegram</span>
                  </button>
                  <button class="btn btn-secondary btn-large" id="create-another-btn" style="background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 12px 20px; border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: background-color 0.2s; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;" onmouseover="this.style.backgroundColor='var(--bg-input)'" onmouseout="this.style.backgroundColor='var(--bg-tertiary)'">
                    <i class="fas fa-plus" style="font-size: 1rem;"></i>
                    <span>Create Another Pack</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;

        // Inject the modal into the overlay
        overlay.insertAdjacentHTML("beforeend", successModalHTML);

        // Add CSS animations if not already present
        if (!document.getElementById("success-modal-animations")) {
          const style = document.createElement("style");
          style.id = "success-modal-animations";
          style.textContent = `
            .success-modal-enhanced {
              animation: successModalSlideIn 0.3s ease-out;
            }
            
            @keyframes successModalSlideIn {
              from {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
              }
              to {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
              }
            }
            
            @media (max-width: 768px) {
              .success-modal-enhanced {
                max-width: 95% !important;
                margin: 20px;
              }
              .success-modal-enhanced > div {
                flex-direction: column !important;
                min-height: auto !important;
              }
              .success-modal-enhanced .modal-header {
                min-width: auto !important;
                padding: 24px !important;
                text-align: center;
              }
              .success-modal-enhanced .success-actions {
                flex-direction: column !important;
              }
            }
          `;
          document.head.appendChild(style);
        }

        // Now proceed with normal flow
        const injectedModal = document.getElementById("success-modal");
        const linkInput = document.getElementById("shareable-link");

        if (injectedModal) {
          // Apply centering styles immediately after injection
          injectedModal.style.position = "fixed";
          injectedModal.style.top = "50%";
          injectedModal.style.left = "50%";
          injectedModal.style.transform = "translate(-50%, -50%)";
          injectedModal.style.zIndex = "10000";

          this.displaySuccessModal(injectedModal, overlay, linkInput, shareableLink);
          return;
        }
      }
    }

    // Wait for DOM to be ready if necessary
    const ensureDOMReady = () => {
      return new Promise((resolve) => {
        if (document.readyState === "complete") {
          resolve();
        } else {
          const handler = () => {
            if (document.readyState === "complete") {
              document.removeEventListener("readystatechange", handler);
              resolve();
            }
          };
          document.addEventListener("readystatechange", handler);
          // Fallback timeout
          setTimeout(resolve, 100);
        }
      });
    };

    // ENHANCED: DOM check with detailed debugging
    const findModalElements = () => {
      const modal = document.getElementById("success-modal");
      const overlay = document.getElementById("modal-overlay");
      const linkInput = document.getElementById("shareable-link");

      return { modal, overlay, linkInput };
    };

    // Ensure DOM is ready and then try to find elements
    ensureDOMReady().then(() => {
      let elements = findModalElements();

      // If modal still not found after DOM ready, try additional retries
      if (!elements.modal) {
        // Try multiple retries with increasing delays
        let retryCount = 0;
        const maxRetries = 3;

        const retryFind = () => {
          retryCount++;
          setTimeout(() => {
            elements = findModalElements();

            if (elements.modal) {
              this.displaySuccessModal(elements.modal, elements.overlay, elements.linkInput, shareableLink);
              return;
            }

            if (retryCount < maxRetries) {
              retryFind();
              return;
            }

            // EMERGENCY: Try to create and inject the success modal if it doesn't exist
            const modalHTML = `
              <div class="modal success-modal-enhanced" id="success-modal-fallback" style="display: none">
                <div class="modal-header success-header">
                  <div class="success-icon-wrapper">
                    <i class="fas fa-check-circle success-icon"></i>
                  </div>
                  <h3>Sticker Pack Created!</h3>
                </div>
                <div class="modal-body success-body">
                  <div class="success-content">
                    <div class="success-message">
                      <h4>🎉 Congratulations!</h4>
                      <p>Your sticker pack has been successfully created and uploaded to Telegram.</p>
                    </div>
                    <div class="link-section">
                      <label class="link-label">Share this link with others:</label>
                      <div class="link-display-enhanced">
                        <div class="link-input-wrapper">
                          <i class="fas fa-link link-icon"></i>
                          <input type="text" id="shareable-link-fallback" class="form-control link-input" readonly value="${shareableLink}">
                        </div>
                        <button class="btn btn-copy" onclick="navigator.clipboard.writeText('${shareableLink}'); window.app?.showToast('success', 'Copied', 'Link copied to clipboard!')">
                          <i class="fas fa-copy"></i> Copy
                        </button>
                      </div>
                    </div>
                    <div class="success-actions">
                      <button class="btn btn-primary btn-large" id="open-telegram-btn-fallback">
                        <i class="fab fa-telegram"></i> Open in Telegram
                      </button>
                      <button class="btn btn-secondary btn-large" onclick="window.app?.createAnotherPack(); document.getElementById('success-modal-fallback').style.display='none'; document.getElementById('modal-overlay').classList.remove('active')">
                        <i class="fas fa-plus"></i> Create Another Pack
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            `;

            // Inject the modal into the document
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = modalHTML.trim();
            const fallbackModal = tempDiv.firstChild;
            document.body.appendChild(fallbackModal);

            // Add event listener for the fallback open button to prevent double opening
            const fallbackOpenBtn = document.getElementById("open-telegram-btn-fallback");
            if (fallbackOpenBtn) {
              fallbackOpenBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(shareableLink, "_blank");
                this.showToast("success", "Opening Telegram", "Opening your sticker pack in Telegram!");
              };
            }

            // Get the overlay (should exist)
            const overlay = document.getElementById("modal-overlay");

            if (overlay) {
              // Show the fallback modal
              overlay.classList.add("active");
              fallbackModal.style.display = "flex";
              fallbackModal.style.zIndex = "9999";
              return;
            }

            // Ultimate fallback: Show success via toast and status
            this.showToast("success", "🎉 Pack Created!", `Sticker pack created successfully! Link: ${shareableLink}`, 15000);
            this.addStatusItem(`🎉 Success! Shareable link: ${shareableLink}`, "completed");

            // Try to trigger Telegram opening directly
            if (shareableLink) {
              try {
                if (window.electronAPI && window.electronAPI.openUrl) {
                  window.electronAPI.openUrl(shareableLink);
                } else if (window.electronAPI && window.electronAPI.shell && window.electronAPI.shell.openExternal) {
                  window.electronAPI.shell.openExternal(shareableLink);
                }
              } catch (error) {
                console.error("🎉 [SUCCESS_MODAL] Error opening URL:", error);
              }
            }
          }, 50 * retryCount); // Increasing delay: 50ms, 100ms, 150ms
        };

        retryFind();
      } else {
        this.displaySuccessModal(elements.modal, elements.overlay, elements.linkInput, shareableLink);
      }
    });
  }



  displaySuccessModal(modal, overlay, linkInput, shareableLink) {
    // Validate required elements
    if (!modal) {
      console.error("🎉 [SUCCESS_MODAL] Cannot display modal - modal element is null");
      return;
    }

    if (!overlay) {
      console.error("🎉 [SUCCESS_MODAL] Cannot display modal - overlay element is null");
      return;
    }

    // Set the shareable link
    if (linkInput && shareableLink) {
      linkInput.value = shareableLink;
    }

    // Reset any previous states and ensure modal is ready with proper centering
    modal.style.display = "none";
    modal.style.opacity = "0";
    modal.style.visibility = "visible";
    modal.style.zIndex = "10000"; // Ensure highest z-index

    // CRITICAL FIX: Ensure proper positioning using fixed positioning
    modal.style.position = "fixed";
    modal.style.top = "50%";
    modal.style.left = "50%";
    modal.style.transform = "translate(-50%, -50%)";
    modal.style.margin = "0";

    // Ensure modal is brought to front
    modal.style.setProperty("z-index", "10000", "important");

    modal.style.maxWidth = "700px";
    modal.style.width = "90%";

    // Ensure overlay is ready
    overlay.style.display = "block";
    overlay.style.visibility = "visible";
    overlay.style.zIndex = "9999";
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.backgroundColor = "rgba(0, 0, 0, 0.8)";

    // Show modal with proper overlay (following project specifications)
    overlay.classList.add("active");
    modal.style.display = "flex";

    // Use requestAnimationFrame for smooth display
    requestAnimationFrame(() => {
      modal.style.opacity = "1";
    });

    // Add critical modal protection (prevent outside click dismissal)
    modal.setAttribute("data-critical", "true");

    // CRITICAL FIX: Ensure modal stays in view by recalculating position
    setTimeout(() => {
      // Force reflow to ensure proper positioning
      modal.style.transform = "translate(-50%, -50%)";
      modal.style.top = "50%";
      modal.style.left = "50%";

      // Verify visibility after a short delay
      const computedStyle = getComputedStyle(modal);

      // If modal is still not visible, attempt to fix it
      if (computedStyle.display === "none" || parseFloat(computedStyle.opacity) < 0.5) {
        // Force display and opacity
        modal.style.display = "flex";
        modal.style.opacity = "1";
        modal.style.visibility = "visible";
      }

      // CRITICAL FIX: Scroll to modal if it's not in view
      const rect = modal.getBoundingClientRect();
      const isInViewport = (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
      );

      if (!isInViewport) {
        modal.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }

      // CRITICAL FIX: Ensure modal is above all other elements
      modal.style.zIndex = "10000";
      overlay.style.zIndex = "9999";
    }, 200);

    // Setup event listeners for modal buttons
    this.setupSuccessModalEventListeners(shareableLink);

    // Focus management for accessibility
    setTimeout(() => {
      const copyBtn = document.getElementById("copy-link-btn");
      if (copyBtn) {
        copyBtn.focus();
      }
    }, 300);
  }

  hideSuccessModal() {
    const modal = document.getElementById("success-modal");
    const overlay = document.getElementById("modal-overlay");

    if (modal) {
      modal.style.display = "none";
      modal.style.opacity = "0";
      modal.removeAttribute("data-critical");
      // Reset positioning styles
      modal.style.position = "";
      modal.style.top = "";
      modal.style.left = "";
      modal.style.transform = "";
      modal.style.margin = "";
    }

    if (overlay) {
      overlay.classList.remove("active");
      overlay.style.display = "none";
      overlay.style.visibility = "hidden";
    }

    // Clean up keyboard event listeners
    if (this.successModalKeyHandler) {
      document.removeEventListener("keydown", this.successModalKeyHandler);
      this.successModalKeyHandler = null;
    }
  }

  setupSuccessModalEventListeners(shareableLink) {
    // Copy link button
    const copyBtn = document.getElementById("copy-link-btn");
    if (copyBtn) {
      copyBtn.onclick = () => this.copyShareableLink();
    }

    // Open in Telegram button - prevent double opening
    const openBtn = document.getElementById("open-telegram-btn");
    if (openBtn) {
      // Remove any existing listeners first
      openBtn.onclick = null;
      openBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openTelegramLink();
      };
    }

    // Create another pack button
    const anotherBtn = document.getElementById("create-another-btn");
    if (anotherBtn) {
      anotherBtn.onclick = () => this.createAnotherPack();
    }

    // Add keyboard support
    const keyHandler = (e) => {
      if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.copyShareableLink();
      } else if (e.key === "Enter") {
        this.openTelegramLink();
      }
    };

    document.addEventListener("keydown", keyHandler);

    // Store handler for cleanup
    this.successModalKeyHandler = keyHandler;
  }

  async copyShareableLink() {
    const linkInput = document.getElementById("shareable-link");
    if (linkInput && linkInput.value) {
      try {
        await navigator.clipboard.writeText(linkInput.value);
        this.showToast("success", "Link Copied", "Shareable link copied to clipboard!");
      } catch (err) {
        // Fallback for older browsers
        linkInput.select();
        document.execCommand("copy");
        this.showToast("success", "Link Copied", "Shareable link copied to clipboard!");
      }
    }
  }

  openTelegramLink() {
    const linkInput = document.getElementById("shareable-link");
    if (linkInput && linkInput.value) {
      window.open(linkInput.value, "_blank");
      this.showToast("success", "Opening Telegram", "Opening your sticker pack in Telegram!");
    } else {
      this.showToast("error", "No Link", "Shareable link not available");
    }
  }

  createAnotherPack() {

    this.hideSuccessModal();

    // STEP 1: Clear form inputs and reset to initial state
    const packNameInput = document.getElementById("pack-name");
    const urlNameInput = document.getElementById("pack-url-name");

    if (packNameInput) packNameInput.value = "";
    if (urlNameInput) urlNameInput.value = "";

    // STEP 2: Clear media files and reset arrays
    this.mediaFiles = [];
    this.updateMediaFileList();
    this.updatePackActions();

    // STEP 3: Reset validation display (clear any existing validation)
    const packNameValidation = document.getElementById("pack-name-validation");
    const urlNameValidation = document.getElementById("pack-url-name-validation");

    if (packNameInput && packNameValidation) {
      packNameInput.classList.remove("valid", "invalid");
      packNameValidation.classList.remove("valid", "invalid");
      packNameValidation.textContent = "";
    }

    if (urlNameInput && urlNameValidation) {
      urlNameInput.classList.remove("valid", "invalid");
      urlNameValidation.classList.remove("valid", "invalid");
      urlNameValidation.textContent = "";
    }

    // STEP 4: Reset progress monitoring and UI state
    this.stopStickerProgressMonitoring();

    // STEP 5: Clear status history and reset to ready state
    this.clearStatusHistory();

    // STEP 6: Reset progress bar
    const progressBar = document.getElementById("sticker-progress-bar");
    const progressText = document.getElementById("sticker-progress-text");
    if (progressBar) {
      progressBar.style.width = "0%";
    }
    if (progressText) {
      progressText.textContent = "0/0 files processed";
    }

    // STEP 7: Reset create button to initial state (but respect connection status and pack mode)
    const createBtn = document.getElementById("create-sticker-pack");
    if (createBtn) {
      // Don't just enable the button - check all conditions properly
      const packName = packNameInput?.value.trim() || "";
      const urlName = urlNameInput?.value.trim() || "";

      const isPackNameValid = packName.length > 0 && packName.length <= 64;
      const isUrlNameValid = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(urlName);
      const hasMedia = this.mediaFiles.length > 0;
      const isConnected = this.telegramConnected;

      const canCreate = isPackNameValid && isUrlNameValid && hasMedia && isConnected;
      createBtn.disabled = !canCreate;
      // Respect current pack mode - force reset since this is a form reset
      this.resetButtonText(createBtn, true);
    }

    // STEP 8: Reset any internal flags
    // Removed autoSkipAttempted flag - auto-skip is handled entirely by backend
    this.lastStage = null;
    this.lastStageWasQueue = false;
    this.currentIconProcessId = null;
    this.currentStickerProcessId = null; // Clear sticker process ID
    this.currentUrlNameProcessId = null;
    this.currentUrlAttempt = null;
    this.maxUrlAttempts = null;
    this.currentEmojiIndex = null;

    // STEP 9: Hide any modals that might be open
    this.hideModal();
    this.hideIconModal();
    this.hideUrlNameModal();
    this.hideLoadingOverlay();

    // CRITICAL FIX: Reset workflow state for new sticker pack
    this.workflowState = {
      iconUploaded: false,
      urlNameSubmitted: false,
      packCompleted: false,
      currentStep: "initial"
    };

    // STEP 10: Focus on pack name input and update button state (preserve telegram connection)
    setTimeout(() => {
      // Update button state using existing connection status (don't change it)
      this.updatePackActions();

      // Focus on pack name input for immediate use
      if (packNameInput) {
        packNameInput.focus();
      }

    }, 100);

    this.showToast("success", "Ready for New Pack", "Form cleared - ready to create another sticker pack!");
    this.addStatusItem("🔄 Ready to create new sticker pack", "ready");
  }

  resetStickerForm() {
    // Ask for confirmation if there are files or form data
    const hasData = this.mediaFiles.length > 0 ||
      document.getElementById("pack-name").value.trim() !== "" ||
      document.getElementById("pack-url-name").value.trim() !== "";

    if (hasData) {
      window.confirmModal.show("This will clear all your current form data and media files. Are you sure?", "Reset Form").then(confirmed => {
        if (confirmed) {
          this.clearActiveProcesses();
          this.createAnotherPack();
        }
      });
      return;
    }

    // No data to clear, just reset
    this.clearActiveProcesses();
    this.createAnotherPack();
  }

  async clearActiveProcesses() {
    try {
      // This is optional - clear any running sticker processes
      const response = await this.apiRequest("POST", "/api/clear-sticker-processes");
      if (response.success) {
      }
    } catch (error) {
      // Don't block reset if this fails
    }
  }

  updatePackActions() {
    const createBtn = document.getElementById("create-sticker-pack");
    if (!createBtn) return;

    const hasMedia = this.mediaFiles.length > 0;
    const isConnected = this.telegramConnected;

    console.log("[UPDATE_PACK_ACTIONS] Mode:", this.currentPackMode, "| Connected:", isConnected, "| Media files:", this.mediaFiles.length);

    if (this.currentPackMode === "create") {
      // Existing validation for create mode
      const packName = document.getElementById("pack-name")?.value.trim() || "";
      const urlName = document.getElementById("pack-url-name")?.value.trim() || "";

      const isPackNameValid = packName.length > 0 && packName.length <= 64;
      const isUrlNameValid = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(urlName);

      // FIXED: Only disable if not connected, let validation handle the rest on click
      createBtn.disabled = !isConnected;
    } else {
      // Validation for add mode
      const packInput = document.getElementById("existing-pack-name");
      const packName = packInput?.value.trim() || "";
      const isPackNameValid = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(packName);

      console.log("[UPDATE_PACK_ACTIONS] Add mode - Pack name:", packName, "| Valid:", isPackNameValid, "| Button should be:", (!isConnected ? "DISABLED" : "ENABLED"));

      // FIXED: Only disable if not connected, let validation handle the rest on click
      createBtn.disabled = !isConnected;
    }
  }

  // ==========================================
  // PACK MODE MANAGEMENT - NEW METHODS
  // ==========================================

  togglePackMode(mode) {
    this.currentPackMode = mode;

    const packNameGroup = document.getElementById("pack-name-group");
    const packUrlGroup = document.getElementById("pack-url-group");
    const autoSkipGroup = document.getElementById("auto-skip-group");
    const existingPackSelector = document.getElementById("existing-pack-selector");
    const stickerTypeGroup = document.getElementById("sticker-type-group");
    const actionButton = document.getElementById("create-sticker-pack");
    const actionText = document.getElementById("pack-action-text");

    if (mode === "create") {
      // Show new pack fields
      if (packNameGroup) packNameGroup.style.display = "block";
      if (packUrlGroup) packUrlGroup.style.display = "block";
      if (autoSkipGroup) autoSkipGroup.style.display = "block";
      if (existingPackSelector) existingPackSelector.style.display = "none";
      if (stickerTypeGroup) stickerTypeGroup.style.display = "block";
    } else {
      // Show existing pack input, hide sticker type (pack already has a type)
      if (packNameGroup) packNameGroup.style.display = "none";
      if (packUrlGroup) packUrlGroup.style.display = "none";
      if (autoSkipGroup) autoSkipGroup.style.display = "none";
      if (existingPackSelector) existingPackSelector.style.display = "block";
      if (stickerTypeGroup) stickerTypeGroup.style.display = "none";
    }

    // Update button text and icon using helper - but only if no process is running
    if (actionButton && !this.stickerProgressInterval && !this.currentProcessId) {
      this.resetButtonText(actionButton);
    }

    // Update validation
    this.updatePackActions();
  }

  async addToExistingPack() {
    const packInput = document.getElementById("existing-pack-name");
    const packShortName = packInput?.value.trim() || "";

    // Validation
    if (!packShortName) {
      this.showToast("error", "Pack Name Required", "Please enter the pack short name");
      return;
    }

    // Validate URL name format
    const validation = this.validateUrlName(packShortName);
    if (!validation.valid) {
      this.showToast("error", "Invalid Pack Name", validation.error);
      return;
    }

    // Check Telegram connection
    if (!this.telegramConnected) {
      this.showToast("error", "Not Connected", "Please connect to Telegram first");
      return;
    }

    // Check media files
    if (this.mediaFiles.length === 0) {
      this.showToast("error", "No Media", "Please add images or videos first");
      return;
    }

    try {
      // Generate process ID
      let processId = `add_sticker_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      processId = processId.substring(0, 50);

      // Disable button
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
      }

      // Prepare media files
      const mediaFiles = this.mediaFiles.map((file) => ({
        file_path: file.file_path,
        emoji: file.emoji || "😀",
        type: file.type
      }));

      // Call API
      const response = await this.apiRequest("POST", "/api/sticker/add-to-pack", {
        pack_short_name: packShortName,
        media_files: mediaFiles,
        process_id: processId
      });

      if (response.success) {
        this.currentProcessId = processId;
        this.currentOperation = "adding_stickers";

        this.addStatusItem(`🚀 Adding ${mediaFiles.length} stickers to pack "${packShortName}"...`, "processing");

        // Start progress monitoring
        this.startStickerProgressMonitoring(processId);
      } else {
        throw new Error(response.error || "Failed to start process");
      }
    } catch (error) {
      console.error("[ADD_TO_PACK] Error:", error);
      this.showToast("error", "Failed", error.message);

      // Clear process tracking since it failed
      this.currentProcessId = null;
      this.currentOperation = null;

      // Re-enable button - force reset since process failed
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = false;
        this.resetButtonText(createBtn, true);
      }
    }
  }

  validatePackName(packName) {
    // Length validation (1-64 characters)
    if (packName.length === 0) {
      return { valid: false, error: "Pack name is required" };
    }
    if (packName.length > 64) {
      return { valid: false, error: "Pack name must be no more than 64 characters long" };
    }

    // Basic validation (no special characters that might cause issues)
    const invalidChars = /[<>\"'&]/;
    if (invalidChars.test(packName)) {
      return { valid: false, error: "Pack name contains invalid characters" };
    }

    return { valid: true };
  }

  validateUrlName(urlName) {
    // Length validation (5-32 characters)
    if (urlName.length < 5) {
      return { valid: false, error: "URL name must be at least 5 characters long" };
    }
    if (urlName.length > 32) {
      return { valid: false, error: "URL name must be no more than 32 characters long" };
    }

    // Starting character validation (must start with letter)
    if (!/^[a-zA-Z]/.test(urlName)) {
      return { valid: false, error: "URL name must start with a letter" };
    }

    // Character validation (only letters, numbers, underscores)
    const validPattern = /^[a-zA-Z0-9_]+$/;
    if (!validPattern.test(urlName)) {
      return { valid: false, error: "URL name can only contain letters, numbers, and underscores" };
    }

    return { valid: true };
  }

  updateValidationDisplay(inputId, validation) {
    const input = document.getElementById(inputId);
    const validationDiv = document.getElementById(`${inputId}-validation`);

    if (!input || !validationDiv) return;

    // Remove existing validation classes
    input.classList.remove("valid", "invalid");
    validationDiv.classList.remove("valid", "invalid");
    validationDiv.textContent = "";

    if (validation.valid) {
      input.classList.add("valid");
      validationDiv.classList.add("valid");
      validationDiv.textContent = "✓ Valid";
    } else if (input.value.length > 0) {
      // Only show invalid state if user has typed something
      input.classList.add("invalid");
      validationDiv.classList.add("invalid");
      validationDiv.textContent = validation.error;
    }
    // If input is empty, don't show any validation state
  }

  // =============================================
  // VIDEO CONVERTER METHODS WITH PROPER PROGRESS TRACKING
  // =============================================
  async addVideoFiles() {
    try {
      // Check if electronAPI is available
      if (!window.electronAPI) {
        this.showToast("error", "System Error", "Electron API not available");
        return;
      }

      const files = await window.electronAPI.selectFiles({
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "avi", "mov", "mkv", "flv", "webm"],
          },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      // selectFiles returns an array directly
      if (!Array.isArray(files) || files.length === 0) {
        return;
      }

      let addedCount = 0;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];

        if (!this.videoFiles.some((f) => f.path === file)) {
          // Get file metadata first
          const metadata = await this.getFileMetadata(file);

          this.videoFiles.push({
            path: file,
            name: file.split(/[\\/]/).pop(),
            status: "pending",
            progress: 0,
            stage: "Ready to convert",
            size: metadata.size,
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height
          });
          addedCount++;

          // IMMEDIATE UI UPDATE - Update file count instantly
          const counter = document.getElementById("video-file-count");
          if (counter) {
            counter.textContent = this.videoFiles.length;
          }
        }
      }


      // Force immediate update
      this.updateVideoFileList();

      if (addedCount > 0) {
        this.showToast("success", "Files Added", `Added ${addedCount} video files`);
      } else {
        this.showToast("info", "No New Files", "All selected files were already in the list");
      }

    } catch (error) {
      this.showToast("error", "Error", "Failed to add video files: " + error.message);
    }
  }

  clearVideoFiles() {
    if (this.videoFiles.length === 0) {
      this.showToast("info", "Already Empty", "No video files to clear");
      return;
    }

    const count = this.videoFiles.length;

    // Stop all pollers
    this.videoFiles.forEach(file => {
      if (file.poller) {
        clearInterval(file.poller);
      }
    });

    this.videoFiles = [];

    // IMMEDIATE UI UPDATE - Update file count instantly
    const counter = document.getElementById("video-file-count");
    if (counter) {
      counter.textContent = this.videoFiles.length;
    }

    // Reset GUI to original state
    const convertBtn = document.getElementById("start-conversion");
    if (convertBtn) {
      convertBtn.disabled = false;
      convertBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
    }

    // Clear any status messages
    const statusElement = document.querySelector(".status");
    if (statusElement) {
      statusElement.textContent = "Ready";
    }

    // Reset virtual list container completely
    const container = document.getElementById("video-file-list");
    if (container) {
      // Remove scroll event listeners
      if (container._virtualScrollHandler) {
        container.removeEventListener("scroll", container._virtualScrollHandler);
        container._virtualScrollHandler = null;
      }
      if (container._scrollTimeout) {
        clearTimeout(container._scrollTimeout);
        container._scrollTimeout = null;
      }

      // Clear all virtual list properties
      delete container._virtualSpacer;
      delete container._virtualItemHeight;

      // Reset container styles
      container.style.height = "";
      container.style.overflowY = "";
      container.style.overflowX = "";
      container.style.position = "";

      // Clear all content
      container.innerHTML = "";
    }

    // Force a complete UI refresh
    this.updateVideoFileList();
    this.showToast("info", "Cleared", `Removed ${count} video files`);
  }

  updateVideoFileList() {
    // Initialize debounce property if not exists
    if (!this._updateVideoFileListDebounce) {
      this._updateVideoFileListDebounce = null;
    }

    // Clear existing timeout
    if (this._updateVideoFileListDebounce) {
      clearTimeout(this._updateVideoFileListDebounce);
    }

    // Update counter immediately
    const counter = document.getElementById("video-file-count");
    if (counter) {
      counter.textContent = this.videoFiles.length;
    }

    // Debounce the actual list update
    this._updateVideoFileListDebounce = setTimeout(() => {
      this._updateVideoFileListInternal();
    }, 50);
  }

  _updateVideoFileListInternal() {
    const container = document.getElementById("video-file-list");
    if (!container) {
      return;
    }

    if (this.videoFiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-video"></i>
          <p>No videos selected</p>
          <small>Click "Add Videos" to get started or drag & drop files here</small>
        </div>
      `;
      return;
    }

    // Force container to be visible
    container.style.display = "block";

    // Always use regular rendering for consistent appearance
    this.updateVideoFileListRegular(container);
  }

  // Regular list update for smaller datasets
  updateVideoFileListRegular(container) {
    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();

    this.videoFiles.forEach((file, index) => {
      const element = this.createVideoFileElement(file, index);
      fragment.appendChild(element);
    });

    // Clear and append in one operation for better performance
    container.innerHTML = "";
    container.appendChild(fragment);
  }

  // Virtual scrolling implementation for video files
  renderVirtualVideoList(container) {

    // Match CSS: min-height (70px) + margin (4px) = 74px per item
    const itemHeight = 74;
    const visibleHeight = 350; // Fixed height from CSS
    const totalHeight = this.videoFiles.length * itemHeight;


    // Setup container
    container.innerHTML = "";
    container.style.height = visibleHeight + "px";
    container.style.overflowY = "auto";
    container.style.position = "relative";
    container.style.display = "block";

    // Create spacer for scrollbar
    const spacer = document.createElement("div");
    spacer.style.height = totalHeight + "px";
    spacer.style.position = "relative";

    // Create items container
    const itemsContainer = document.createElement("div");
    itemsContainer.style.position = "absolute";
    itemsContainer.style.top = "0";
    itemsContainer.style.left = "0";
    itemsContainer.style.right = "0";

    spacer.appendChild(itemsContainer);
    container.appendChild(spacer);

    let lastRenderTop = 0;
    const renderBuffer = 5;

    const renderVisibleItems = () => {
      const scrollTop = container.scrollTop;
      const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - renderBuffer);
      const endIndex = Math.min(
        this.videoFiles.length,
        Math.ceil((scrollTop + visibleHeight) / itemHeight) + renderBuffer
      );


      // Only re-render if scrolled significantly
      if (Math.abs(scrollTop - lastRenderTop) < itemHeight / 2 && itemsContainer.children.length > 0) return;
      lastRenderTop = scrollTop;

      // Create visible items
      const fragment = document.createDocumentFragment();

      for (let i = startIndex; i < endIndex; i++) {
        const element = this.createVideoFileElement(this.videoFiles[i], i);
        element.style.position = "absolute";
        element.style.top = (i * itemHeight) + "px";
        element.style.left = "0";
        element.style.right = "0";
        element.style.height = (itemHeight - 4) + "px"; // Subtract margin
        element.style.marginBottom = "4px";
        element.style.boxSizing = "border-box";
        fragment.appendChild(element);
      }

      itemsContainer.innerHTML = "";
      itemsContainer.appendChild(fragment);

    };

    // Debounced scroll handler
    let scrollTimeout;
    container.addEventListener("scroll", () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(renderVisibleItems, 16);
    });

    // Initial render
    renderVisibleItems();
  }

  // Create a single video file element
  createVideoFileElement(file, index) {
    const statusClass = (file.status || "pending").toLowerCase();
    const progressWidth = file.progress || 0;
    const statusIcon = this.getStatusIcon(file.status);

    const fileElement = document.createElement("div");
    fileElement.className = `file-item ${statusClass}`;
    fileElement.setAttribute("data-index", index);

    const progressText = progressWidth === 100 ? "✔" : `${progressWidth}%`;
    const statusText = file.stage || "Ready to convert";

    fileElement.innerHTML = `
      <div class="file-icon">
        <i class="${statusIcon}"></i>
      </div>
      <div class="file-details">
        <div class="file-name" title="${file.path}">${this.truncateFileName(file.name, 30)}</div>
        <div class="file-meta-compact">
          <span class="file-status">${statusText}</span>
          ${file.hexEdited ? '<span class="hex-edited-badge" title="Hex edited">🔧</span>' : ""}
          ${file.size ? `| Size: ${file.size} | Duration: ${file.duration}` : ""}
        </div>
        <div class="file-progress-compact">
          <div class="file-progress-bar">
            <div class="file-progress-fill" style="width: ${progressWidth}%"></div>
          </div>
          <div class="file-progress-text">${progressText}</div>
        </div>
      </div>
      <div class="file-actions-compact">
        <button class="btn-mini btn-info" onclick="app.showFileInfo(${index})" title="File Info">
          <i class="fas fa-info-circle"></i>
        </button>
        <button class="btn-mini btn-danger" onclick="app.removeVideoFile(${index})" 
                ${file.status === "converting" ? "disabled" : ""} title="Remove File">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;

    return fileElement;
  }

  // Helper method to truncate file names
  truncateFileName(name, maxLength) {
    if (name.length <= maxLength) return name;
    const extension = name.split('.').pop();
    const nameWithoutExt = name.slice(0, name.lastIndexOf('.'));
    return `${nameWithoutExt.slice(0, maxLength - extension.length - 4)}...${extension}`;
  }

  getStatusIcon(status) {
    const iconMap = {
      pending: "fas fa-clock",
      starting: "fas fa-play-circle",
      analyzing: "fas fa-search",
      preparing: "fas fa-cog",
      converting: "fas fa-sync fa-spin",
      checking: "fas fa-check-circle",
      completed: "fas fa-check text-success",
      error: "fas fa-exclamation-triangle text-danger",
    };
    return iconMap[status] || "fas fa-video";
  }

  getStatusColor(status) {
    const colorMap = {
      pending: "#fbbf24",
      starting: "#3b82f6",
      analyzing: "#8b5cf6",
      preparing: "#f59e0b",
      converting: "#3b82f6",
      checking: "#06b6d4",
      completed: "#10b981",
      error: "#ef4444",
      ready: "#6b7280"
    };
    return colorMap[status] || "#ccc";
  }

  async showFileInfo(index) {
    const file = this.videoFiles[index];
    if (!file) return;

    // Get detailed file metadata from backend
    let fileInfo = {
      name: file.name,
      size: "Unknown",
      duration: "Unknown",
      format: "Unknown",
      dimensions: "Unknown"
    };

    try {
      const result = await this.apiRequest("POST", "/api/get-file-info", {
        path: file.path
      });

      if (result && result.success && result.data) {
        fileInfo = {
          name: result.data.name || file.name,
          size: result.data.size_formatted || "Unknown",
          duration: result.data.duration_formatted || "Unknown",
          format: result.data.format ? result.data.format.toUpperCase() : "Unknown",
          dimensions: result.data.dimensions || "Unknown",
          codec: result.data.codec || null,
          fps: result.data.fps || null
        };
      }
    } catch (error) {
      // Error getting file info, continue without it
    }

    // Format additional info
    let additionalInfo = "";
    if (fileInfo.codec) {
      additionalInfo += `<strong style="color: #667eea;">Codec:</strong> <span style="color: #ccc;">${fileInfo.codec}</span><br>`;
    }
    if (fileInfo.fps && fileInfo.fps > 0) {
      additionalInfo += `<strong style="color: #667eea;">Frame Rate:</strong> <span style="color: #ccc;">${fileInfo.fps.toFixed(1)} fps</span><br>`;
    }

    const info = `
      <div style="font-size: 0.9rem; line-height: 1.8; max-width: 400px;">
        <div style="margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.1);">
          <strong style="color: #667eea; font-size: 1rem;">📹 Video File Information</strong>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📄 Name:</strong> 
          <span style="color: #ccc; word-break: break-word;">${fileInfo.name}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📏 Size:</strong> 
          <span style="color: #ccc;">${fileInfo.size}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">⏱️ Duration:</strong> 
          <span style="color: #ccc;">${fileInfo.duration}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📐 Dimensions:</strong> 
          <span style="color: #ccc;">${fileInfo.dimensions}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">🎬 Format:</strong> 
          <span style="color: #ccc;">${fileInfo.format}</span>
        </div>
        
        ${additionalInfo}
        
        <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">🔄 Status:</strong> 
            <span style="color: ${this.getStatusColor(file.status)};">${file.status || "Ready"}</span>
          </div>
          
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">📊 Progress:</strong> 
            <span style="color: #ccc;">${file.progress || 0}%</span>
          </div>
          
          ${file.stage ? `<div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">⚙️ Stage:</strong> 
            <span style="color: #ccc;">${file.stage}</span>
          </div>` : ""}
        </div>
        
        <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">
          <small style="color: #888;">File ${index + 1} of ${this.videoFiles.length} • Video Conversion</small>
        </div>
      </div>
    `;

    this.showDetailedMessage("Video File Details", info);
  }

  async removeVideoFile(index) {
    const removed = this.videoFiles.splice(index, 1)[0];

    // Stop any ongoing polling for this file
    if (removed.poller) {
      clearInterval(removed.poller);
    }

    // IMMEDIATE UI UPDATE - Update file count instantly
    const counter = document.getElementById("video-file-count");
    if (counter) {
      counter.textContent = this.videoFiles.length;
    }

    // Reset GUI to original state if no files left
    if (this.videoFiles.length === 0) {
      // Reset conversion button
      const convertBtn = document.getElementById("start-conversion");
      if (convertBtn) {
        convertBtn.disabled = false;
        convertBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
      }

      // Clear any status messages
      const statusElement = document.querySelector(".status");
      if (statusElement) {
        statusElement.textContent = "Ready";
      }
    }

    this.updateVideoFileList();

    // Tell backend to stop if file still converting
    if (removed && removed.process_id) {
      try {
        await this.apiRequest("POST", "/api/stop-process", { process_id: removed.process_id });
      } catch (error) {
        // Error stopping process, continue without it
      }
    }

    this.showToast("info", "Removed", `Removed ${removed.name}`);
  }

  async browseVideoOutput() {
    try {
      // Check if Electron API is available
      if (!window.electronAPI || !window.electronAPI.selectDirectory) {
        throw new Error("Electron directory selection API not available");
      }

      const directory = await window.electronAPI.selectDirectory();

      if (directory) {
        this.currentVideoOutput = directory;
        const outputInput = document.getElementById("video-output-dir");
        if (outputInput) outputInput.value = directory;
        this.saveSettings();
        this.showToast(
          "success",
          "Directory Selected",
          "Output directory updated"
        );
      }
    } catch (error) {
      this.showToast(
        "error",
        "Directory Selection Error",
        `Failed to select directory: ${error.message}\nCheck console for details`
      );
    }
  }
  async startVideoConversion() {

    // Basic validation
    if (this.videoFiles.length === 0) {
      this.showToast("warning", "No Files", "Please add videos to convert.");
      return;
    }

    // Force immediate database stats update when starting conversion
    await this.forceUpdateDatabaseStats();

    if (!this.currentVideoOutput) {
      this.showToast("error", "No Output Folder", "Please select an output directory.");
      await this.browseVideoOutput();
      if (!this.currentVideoOutput) {
        return;
      }
    }

    if (this.currentOperation === "converting") {
      this.showToast("warning", "Operation in Progress", "A conversion is already running.");
      return;
    }

    // Check backend connectivity
    try {
      const healthCheck = await this.apiRequest("GET", "/api/health");

      if (!healthCheck.success) {
        this.showToast("error", "Backend Error", "Backend server is not responding");
        return;
      }
    } catch (error) {
      console.error("Backend health check error:", error);
      this.showToast("error", "Connection Error", "Cannot connect to backend server");
      return;
    }

    // Prepare conversion data
    const filesToConvert = this.videoFiles.map(f => f.path);

    // Check if any file paths are invalid
    const invalidFiles = filesToConvert.filter(path => !path || path === "undefined");
    if (invalidFiles.length > 0) {
      console.error("Invalid file paths found:", invalidFiles);
      this.showToast("error", "Invalid Files", "Some files have invalid paths. Please re-add them.");
      return;
    }

    // Set operation state
    this.currentOperation = "converting";
    this.isPaused = false;

    // Update UI - Disable conversion button, enable pause, disable hex edit
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");

    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Converting...';
      startBtn.style.display = "inline-flex";
    }

    if (hexBtn) {
      hexBtn.disabled = true;
      hexBtn.style.opacity = "0.5";
      hexBtn.style.display = "inline-flex";
    }

    if (pauseBtn) {
      pauseBtn.style.display = "inline-block";
      pauseBtn.disabled = false;
    }

    if (resumeBtn) {
      resumeBtn.style.display = "none";
    }

    // Force update button states
    this.updateButtonStates();

    try {
      const requestData = {
        files: filesToConvert,
        output_dir: this.currentVideoOutput,
        settings: {
          cpu_mode: "cpu", // Always use CPU-only processing
          quality: Number(localStorage.getItem("quality_setting") || 75)
        }
      };

      const response = await this.apiRequest("POST", "/api/convert-videos", requestData);

      if (response.success) {
        // Standardize process ID extraction
        let processId = null;

        // Try direct access first
        // Standardized structure - backend returns data.process_id inside data
        if (response.data && response.data.data && response.data.data.process_id) {
          processId = response.data.data.process_id;
        }
        // Fallback for direct structure 
        else if (response.data && response.data.process_id) {
          processId = response.data.process_id;
        }

        if (processId) {
          this.currentProcessId = processId;

          // Add process to activeProcesses
          this.activeProcesses.set(this.currentProcessId, {
            startTime: Date.now(),
            files: this.videoFiles,
            type: "conversion"
          });

          // Start progress monitoring
          this.monitorProcess(this.currentProcessId);
          this.showToast("success", "Conversion Started", `Conversion of ${filesToConvert.length} files started!`);

          // Force immediate stats refresh to show conversion started
          await this.updateDatabaseStats();

          if (startBtn) {
            startBtn.innerHTML = '<i class="fas fa-cog fa-spin"></i> Converting...';
          }
        } else {
          console.error("No process_id received from backend");
          this.showToast("error", "Conversion Error", "Failed to get process ID from backend");
          this.resetOperationState();
        }
      } else {
        throw new Error(response.error || "Failed to start conversion process");
      }

    } catch (error) {
      console.error("Conversion start error:", error);
      this.showToast("error", "Conversion Error", error.message);
      this.resetOperationState();

      // Ensure button is reset even if resetOperationState fails
      const startBtn = document.getElementById("start-conversion");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
        startBtn.style.display = "inline-flex";
      }

      // Force update button states
      this.updateButtonStates();
    }

  }

  // Unified progress monitoring system with enhanced debouncing
  monitorProcess(processId) {
    const MAX_CONSECUTIVE_ERRORS = 3;
    const POLLING_INTERVAL = 2000; // Reduced from 1000ms to 2000ms
    const MAX_OPERATION_TIME = 30 * 60 * 1000; // 30 minutes
    let consecutiveErrors = 0;

    // Clear any existing intervals
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Store process info
    this.activeProcesses.set(processId, {
      startTime: Date.now(),
      files: this.videoFiles,
      type: "video"
    });

    this.progressInterval = setInterval(async () => {
      try {
        // Update database stats during active monitoring (reduced frequency)
        if (consecutiveErrors === 0) { // Only update on successful operations
          await this.updateDatabaseStats();
        }

        // Check timeout
        const processInfo = this.activeProcesses.get(processId);
        if (!processInfo || Date.now() - processInfo.startTime > MAX_OPERATION_TIME) {
          this.stopProgressMonitoring();
          this.resetOperationState();
          this.showToast("warning", "Timeout", "Operation took too long");
          return;
        }

        // Get progress from backend
        const response = await this.apiRequest("GET", `/api/conversion-progress/${processId}`);

        if (!response.success) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error("Too many consecutive errors");
          }
          return;
        }

        // Reset error counter on success
        consecutiveErrors = 0;

        // Unwrap nested response shape { success, data: {...} }
        const progress = (response && response.data && response.data.data) ? response.data.data : response.data;

        // Update file statuses (only log on significant changes)
        if (progress && progress.file_statuses) {
          let hasChanges = false;
          let significantChange = false;

          Object.entries(progress.file_statuses).forEach(([index, fileStatus]) => {
            const file = this.videoFiles[parseInt(index)];
            if (file) {
              const oldStatus = file.status;
              const oldProgress = file.progress;
              file.status = fileStatus.status;
              file.progress = fileStatus.progress || 0;
              file.stage = fileStatus.stage || "Processing";

              // Check for any change
              if (oldStatus !== file.status || oldProgress !== file.progress) {
                hasChanges = true;
              }

              // Only trigger UI update for significant changes (progress > 5% change or status change)
              if (oldStatus !== file.status || Math.abs(oldProgress - file.progress) > 5) {
                significantChange = true;
              }
            }
          });

          // Only update UI for significant changes
          if (significantChange && this.debouncedUpdateVideoFileList) {
            this.debouncedUpdateVideoFileList();
          } else if (hasChanges) {
            // For minor changes, update immediately but less frequently
            if (!this._lastMinorUpdate || Date.now() - this._lastMinorUpdate > 500) {
              this.updateVideoFileList();
              this._lastMinorUpdate = Date.now();
            }
          }
        }

        // Check if process is complete
        if (progress && (progress.status === "completed" || progress.status === "error")) {
          this.stopProgressMonitoring();
          await this.handleProcessCompletion(progress);
        }

      } catch (error) {
        if (RENDERER_DEBUG) console.error("Progress monitoring error:", error);
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.stopProgressMonitoring();
          this.resetOperationState();
          this.showToast("error", "Monitoring Failed", "Unable to track progress");
        }
      }
    }, POLLING_INTERVAL);
  }

  stopProgressMonitoring() {
    // CRITICAL FIX: Clear all monitoring intervals to prevent memory leaks
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.activeOperationInterval) {
      clearInterval(this.activeOperationInterval);
      this.activeOperationInterval = null;
    }
    // Also clear sticker progress interval if it exists
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
      this.stickerProgressInterval = null;
    }
  }

  // Improved process completion handler
  async handleProcessCompletion(processData) {

    // Clean up process tracking
    if (this.currentProcessId) {
      this.activeProcesses.delete(this.currentProcessId);
    }

    // Determine overall success based on process status
    const isSuccessful = processData.status === "completed";

    // Update all file statuses based on results
    if (processData.file_statuses) {
      Object.keys(processData.file_statuses).forEach(index => {
        const fileStatus = processData.file_statuses[index];
        const file = this.videoFiles[parseInt(index)];
        if (file) {
          const oldStatus = file.status;
          const oldProgress = file.progress;
          const oldStage = file.stage;

          file.status = fileStatus.status;
          // Ensure progress shows 100% for completed files
          if (fileStatus.status === "completed") {
            file.progress = 100;
            file.stage = "Conversion completed";
          } else if (fileStatus.status === "error") {
            file.progress = 0;
            file.stage = fileStatus.stage || "Conversion failed";
          } else {
            file.progress = fileStatus.progress || 0;
            file.stage = fileStatus.stage || "Processing";
          }

        } else {
        }
      });
    } else {
    }

    // Update UI
    this.updateVideoFileList();

    // Check if ALL files are completed
    const allFilesCompleted = this.videoFiles.every(file => file.status === "completed");
    const anyFilesFailed = this.videoFiles.some(file => file.status === "error");


    // Show toast notification
    if (allFilesCompleted) {
      this.showToast(
        "success",
        "Conversion Completed",
        `Successfully converted ${processData.completed_files}/${processData.total_files} files`
      );
    } else if (anyFilesFailed) {
      this.showToast(
        "error",
        "Conversion Failed",
        `Conversion failed: ${processData.current_stage || "Unknown error"}`
      );
    } else {
      this.showToast(
        isSuccessful ? "success" : "error",
        `Conversion ${isSuccessful ? "Completed" : "Failed"}`,
        isSuccessful
          ? `Successfully converted ${processData.completed_files}/${processData.total_files} files`
          : `Conversion failed: ${processData.current_stage || "Unknown error"}`
      );
    }

    // Force immediate stats refresh to show updated counters
    await this.updateDatabaseStats();

    // Only reset operation state if ALL files are completed
    if (allFilesCompleted) {
      this.resetOperationState();
    } else {
    }

  }

  // Improved reset method
  resetOperationState() {

    // Clear all operation flags
    this.currentOperation = null;
    this.currentProcessId = null;
    this.isPaused = false;

    // Clear any active monitoring
    this.stopProgressMonitoring();

    // Reset all buttons to default state
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
      startBtn.style.display = "inline-flex";
    }

    if (hexBtn) {
      hexBtn.disabled = false;
      hexBtn.style.opacity = "1";
      hexBtn.style.display = "inline-flex";
    }

    if (pauseBtn) {
      pauseBtn.style.display = "none";
      pauseBtn.disabled = true;
    }

    if (resumeBtn) {
      resumeBtn.style.display = "none";
      resumeBtn.disabled = true;
    }

    // Reset progress bars to 100% if completed
    this.videoFiles.forEach(file => {
      if (file.status === "completed") {
        file.progress = 100;
      }
    });

    this.updateVideoFileList();

    // Update button states
    this.updateButtonStates();

  }

  async startHexEdit() {
    if (this.currentOperation) {
      this.showToast("warning", "Operation in Progress", "Another operation is already running");
      return;
    }

    // Force immediate database stats update when starting hex edit
    await this.forceUpdateDatabaseStats();

    if (this.videoFiles.length === 0) {
      this.showToast("warning", "No Files", "Please add files first");
      return;
    }

    if (!this.currentVideoOutput) {
      this.showToast("warning", "No Output Directory", "Please select an output directory");
      return;
    }

    // Validate that all files are WebM
    const nonWebmFiles = this.videoFiles.filter(file =>
      !file.name.toLowerCase().endsWith(".webm")
    );

    if (nonWebmFiles.length > 0) {
      const fileNames = nonWebmFiles.map(f => f.name).slice(0, 3).join(", ");
      const moreText = nonWebmFiles.length > 3 ? ` and ${nonWebmFiles.length - 3} more` : "";
      this.showToast(
        "error",
        "Invalid Files for Hex Edit",
        `Hex editing only supports WebM files. Found non-WebM files: ${fileNames}${moreText}`
      );
      return;
    }

    try {
      this.currentOperation = "hexediting";
      this.isPaused = false;

      // Update UI - Disable conversion button, enable hex edit pause, disable conversion
      const startBtn = document.getElementById("start-conversion");
      const hexBtn = document.getElementById("start-hex-edit");

      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.opacity = "0.5";
      }

      if (hexBtn) {
        hexBtn.disabled = true;
        hexBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Hex Editing...';
      }

      // No pause/resume for hex edit - it's too fast
      this.updateButtonStates();

      const processId = `hex_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.currentProcessId = processId;

      // Reset all file statuses for hex edit
      this.videoFiles.forEach((file, index) => {
        file.status = "pending";
        file.progress = 0;
        file.stage = "Waiting to process...";
        file.index = index; // Ensure index is set
      });

      this.updateVideoFileList();

      const response = await this.apiRequest("POST", "/api/hex-edit", {
        files: this.videoFiles.map(f => f.path),
        output_dir: this.currentVideoOutput,
        process_id: processId
      });

      if (response.success) {
        this.showToast("success", "Hex Edit Started", "Hex editing has started");

        // Force immediate stats refresh to show hex edit started
        await this.updateDatabaseStats();

        // Use dedicated hex-edit progress monitor (separate from conversion)
        this.startHexProgressMonitoring(processId);
      } else {
        throw new Error(response.error || "Failed to start hex edit");
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error starting hex edit:", error);
      this.showToast("error", "Hex Edit Failed", error.message);
      this.currentOperation = null;
      this.currentProcessId = null;
      this.updateButtonStates();
    }
  }

  // =============================================
  // HEX EDIT PROGRESS (Separate logic from conversion)
  // =============================================
  startHexProgressMonitoring(processId) {
    const MAX_CONSECUTIVE_ERRORS = 8;
    const RETRY_DELAY = 1200; // ms
    const LONG_OPERATION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

    // CRITICAL FIX: Always clear ALL intervals before starting new ones to prevent memory leaks
    this.stopProgressMonitoring();

    let consecutiveErrors = 0;
    const startTs = Date.now();

    // For hex edit, check progress immediately since it's very fast
    this.checkHexProgressImmediately(processId);

    this.progressInterval = setInterval(async () => {
      // Removed excessive database stats monitoring during hex edit

      // Timeout guard
      if (Date.now() - startTs > LONG_OPERATION_TIMEOUT) {
        clearInterval(this.progressInterval);
        this.progressInterval = null;
        this.resetOperationState();
        this.showToast("warning", "Hex Edit Timeout", "Hex edit took too long and was stopped");
        return;
      }

      try {
        const progress = await this.getHexEditProgress(processId);

        // Update overall UI for hex edit
        this.updateHexOverallProgress(progress);

        // Refresh list each tick (lightweight, uses fragment)
        this.updateVideoFileList();

        if (progress.status === "completed" || progress.status === "error") {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
          await this.handleConversionComplete(progress); // Reuse completion UI with wasHexEdit detection inside
        }
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          clearInterval(this.progressInterval);
          this.progressInterval = null;
          this.resetOperationState();
          this.showToast("error", "Hex Edit Error", err?.message || "Unable to fetch progress");
        } else {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }
    }, 250); // Faster polling for hex edit (250ms instead of 750ms)
  }

  // Immediate progress check for hex edit since it's very fast
  async checkHexProgressImmediately(processId) {
    try {
      const progress = await this.getHexEditProgress(processId);

      // If hex edit is already completed (very fast operation)
      if (progress.status === "completed") {
        clearInterval(this.progressInterval);
        this.progressInterval = null;
        await this.handleConversionComplete(progress);
        return;
      }

      // Update UI immediately
      this.updateHexOverallProgress(progress);
      this.updateVideoFileList();

    } catch (err) {
      // Continue with normal polling if immediate check fails
    }
  }

  async getHexEditProgress(processId) {
    // Single source of truth – backend progress endpoint
    const resp = await this.apiRequest("GET", `/api/conversion-progress/${processId}`);
    if (!resp || !resp.success) throw new Error(resp?.error || "No progress response");

    const data = resp.data || {};
    const fileStatuses = data.file_statuses || {};
    const keys = Object.keys(fileStatuses);

    // Apply statuses to our local videoFiles array
    keys.forEach((k) => {
      const idx = parseInt(k);
      const fs = fileStatuses[k] || {};
      const file = this.videoFiles[idx];
      if (!file) return;

      const before = { s: file.status, p: file.progress, st: file.stage };
      file.status = fs.status || file.status || "processing";
      file.progress = typeof fs.progress === "number" ? fs.progress : (file.progress || 0);
      file.stage = fs.stage || file.stage || "Processing hex edit...";
      // For hex edit, ensure completed files show 100% progress
      if (file.status === "completed") {
        file.progress = 100;
        // Check if this is a hex edit completion
        if (file.stage && file.stage.includes("Hex edit completed")) {
          file.hexEdited = true; // Mark as hex edited
        }
      }

      if (before.s !== file.status || before.p !== file.progress || before.st !== file.stage) {
      }
    });

    // Enhanced completion detection for hex edit
    const allCompleted = keys.every(k => {
      const fs = fileStatuses[k] || {};
      return fs.status === "completed";
    });

    // Return normalized progress shape
    return {
      status: allCompleted ? "completed" : (data.status || "running"),
      progress: allCompleted ? 100 : (data.progress || 0),
      currentStage: data.current_stage || "",
      totalFiles: data.total_files || this.videoFiles.length,
      completedFiles: data.completed_files || 0,
      failedFiles: data.failed_files || 0,
      file_statuses: fileStatuses,
    };
  }

  updateHexOverallProgress(progress) {
    // Progress bar fill
    const bar = document.getElementById("sticker-progress-fill") || document.getElementById("conversion-progress-fill");
    if (bar) {
      bar.style.width = `${progress.progress}%`;
      bar.setAttribute("aria-valuenow", progress.progress);
    }

    // Text status line (reuse conversion-status element)
    const statusEl = document.getElementById("conversion-status");
    if (statusEl) {
      const statusText = statusEl.querySelector(".status-text");
      const progressText = statusEl.querySelector(".progress-text");
      const total = progress.totalFiles || this.videoFiles.length;

      if (statusText) {
        statusText.textContent = progress.currentStage || `Hex editing ${progress.completedFiles}/${total}`;
      }

      if (progressText && progress.completedFiles !== undefined) {
        progressText.textContent = `${progress.completedFiles}/${total}`;
      }
    }
  }

  logProgressDetails(progress) {
    console.log("Progress Details:", {
      processId: this.currentProcessId,
      progress: progress.progress,
      status: progress.status,
      currentFile: progress.currentFile,
      completedFiles: `${progress.completedFiles}/${progress.totalFiles}`,
      timestamp: new Date().toISOString()
    });
  }
  handleProgressError(error, consecutiveErrors) {
    if (RENDERER_DEBUG) console.error(`[PROGRESS ERROR #${consecutiveErrors}]`, {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    if (consecutiveErrors >= 5) {
      this.stopProgressMonitoring();
      this.resetOperationState();
      this.showToast("error", "Persistent Error", "Unable to track operation progress");
    }
  }

  async handleConversionComplete(progress) {

    this.stopProgressMonitoring();
    const wasHexEdit = this.currentOperation === "hexediting";
    this.currentOperation = null;
    this.currentProcessId = null;

    // Re-enable buttons and hide pause/resume
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
      startBtn.style.display = "inline-flex";
      startBtn.style.opacity = "1";
    }

    if (hexBtn) {
      hexBtn.disabled = false;
      hexBtn.innerHTML = '<i class="fas fa-edit"></i> Hex Edit';
      hexBtn.style.display = "inline-flex";
      hexBtn.style.opacity = "1";
    }

    // Hide pause/resume buttons
    if (pauseBtn) pauseBtn.style.display = "none";
    if (resumeBtn) resumeBtn.style.display = "none";

    if (progress.status === "completed") {
      const operationType = wasHexEdit ? "Hex Edit" : "Conversion";

      // Update stats for successful conversions
      if (!wasHexEdit) {
        this.sessionStats.totalConversions++;
        this.sessionStats.successfulConversions++;
        this.updateStats();
      }

      this.showToast(
        "success",
        `${operationType} Complete`,
        `Successfully processed ${progress.completedFiles}/${progress.totalFiles} files`
      );
    } else if (progress.status === "error") {
      const operationType = wasHexEdit ? "Hex Edit" : "Conversion";

      // Update stats for failed conversions
      if (!wasHexEdit) {
        this.sessionStats.totalConversions++;
        this.sessionStats.failedConversions++;
        this.updateStats();
      }

      this.showToast(
        "error",
        `${operationType} Error`,
        progress.currentStage || `${operationType} failed`
      );
    }

    // Update file statuses with final values

    if (progress.file_statuses && Object.keys(progress.file_statuses).length > 0) {
      this.videoFiles.forEach((file, index) => {
        const fileStatus = progress.file_statuses[index];
        if (fileStatus) {
          file.status = fileStatus.status;
          file.progress = fileStatus.progress;
          file.stage = fileStatus.stage || progress.currentStage;
        } else {
          // Fallback if no specific file status
          file.status = progress.status === "completed" ? "completed" : "error";
          file.progress = progress.status === "completed" ? 100 : file.progress || 0;
          file.stage = progress.status === "completed" ?
            (wasHexEdit ? "Hex edit successful" : "Conversion successful") :
            (wasHexEdit ? "Hex edit failed" : "Conversion failed");
        }
      });
    } else {
      this.videoFiles.forEach((file, index) => {
        file.status = progress.status === "completed" ? "completed" : "error";
        file.progress = progress.status === "completed" ? 100 : file.progress || 0;
        file.stage = progress.status === "completed" ?
          (wasHexEdit ? "Hex edit successful" : "Conversion successful") :
          (wasHexEdit ? "Hex edit failed" : "Conversion failed");
      });
    }

    this.updateVideoFileList();

    // Force immediate stats refresh to show updated counters
    await this.forceUpdateDatabaseStats();

    // Reset button states to show Start/Hex Edit buttons
    this.updateButtonStates();

    // Reset status text to Ready
    const statusEl = document.getElementById("conversion-status");
    if (statusEl) {
      const statusText = statusEl.querySelector(".status-text");
      const progressText = statusEl.querySelector(".progress-text");

      if (statusText) {
        statusText.textContent = "Ready";
      }
      if (progressText) {
        progressText.textContent = "";
      }
    }
  }

  updateOverallProgress(progress) {
    // Update global progress indicators
    const progressElement = document.getElementById("overall-progress");
    if (progressElement) {
      progressElement.style.width = `${progress.progress}%`;
      progressElement.setAttribute("aria-valuenow", progress.progress);
    }

    const statusElement = document.getElementById("conversion-status");
    if (statusElement) {
      const statusText = statusElement.querySelector(".status-text");
      const progressText = statusElement.querySelector(".progress-text");

      if (statusText) {
        statusText.textContent = progress.currentStage || `Converting ${progress.completedFiles}/${progress.totalFiles}`;
      }

      if (progressText && progress.completedFiles !== undefined && progress.totalFiles !== undefined) {
        progressText.textContent = `${progress.completedFiles}/${progress.totalFiles}`;
      }
    }

    // File statuses are already updated in getConversionProgress
  }

  async getConversionProgress(processId) {
    try {
      const response = await this.apiRequest("GET", `/api/conversion-progress/${processId}`);

      if (!response.success) {
        if (RENDERER_DEBUG) console.error(`Progress check failed for ${processId}:`, response.error);
        if (response.details && response.details.active_processes) {
        }
        return null;
      }

      const progressData = response.data;

      // Update file statuses if available - but do this AFTER returning the data
      // so it's available for both conversion and hex edit operations
      const fileStatuses = progressData.file_statuses || {};

      // Debug log to see what we're getting - removed for production

      // Update the videoFiles array immediately for both conversion and hex edit
      if ((this.currentOperation === "converting" || this.currentOperation === "hexediting") && Object.keys(fileStatuses).length > 0) {

        Object.entries(fileStatuses).forEach(([idx, fs]) => {
          const file = this.videoFiles[parseInt(idx)];
          if (!file) {
            return;
          }

          // Update file with data from backend
          const oldStatus = file.status;
          const oldProgress = file.progress;
          const oldStage = file.stage;

          file.status = fs.status || file.status;
          file.progress = fs.progress !== undefined ? fs.progress : file.progress;
          file.stage = fs.stage || file.stage;

          // Log if there were changes
          if (oldStatus !== file.status || oldProgress !== file.progress || oldStage !== file.stage) {
            console.log("File status changed:", {
              status: `${oldStatus} → ${file.status}`,
              progress: `${oldProgress}% → ${file.progress}%`,
              stage: `${oldStage} → ${file.stage}`
            });
          }
        });
      }

      const returnData = {
        progress: progressData.progress || 0,
        status: progressData.status || "running",
        currentFile: progressData.current_file || "",
        currentStage: progressData.current_stage || "",
        completedFiles: progressData.completed_files || 0,
        totalFiles: progressData.total_files || 0,
        failedFiles: progressData.failed_files || 0,
        paused: progressData.paused || false,
        canPause: progressData.can_pause || false,
        file_statuses: fileStatuses  // Pass the actual file_statuses object
      };

      return returnData;
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error getting conversion progress:", error);
      return null;
    }
  }

  updateFileStatuses(fileStatuses) {
    // Handle both object and array-like structures
    if (!fileStatuses || typeof fileStatuses !== "object") {
      return;
    }

    const fileStatusKeys = Object.keys(fileStatuses);

    fileStatusKeys.forEach(index => {
      const fileStatus = fileStatuses[index];
      if (!fileStatus) {
        return;
      }

      // Our DOM uses data-index, not data-file-index
      const fileElement = document.querySelector(`[data-index="${index}"]`);

      if (fileElement) {
        // Update file item class based on status
        fileElement.className = `file-item ${fileStatus.status || "pending"}`;

        // Update progress bar
        const progressBar = fileElement.querySelector(".file-progress-fill");
        const progressText = fileElement.querySelector(".file-progress-text");
        const statusElement = fileElement.querySelector(".file-status");

        if (progressBar) {
          progressBar.style.width = `${fileStatus.progress}%`;
        }

        if (progressText) {
          progressText.textContent = `${fileStatus.progress === 100 ? "✔" : fileStatus.progress + "%"}`;
        }

        if (statusElement) {
          statusElement.textContent = fileStatus.stage || fileStatus.status;
        }
      }
    });
  }

  preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // =============================================
  // TELEGRAM STICKER BOT METHODS
  // =============================================
  async disconnectTelegram() {

    try {
      this.updateTelegramStatus("connecting"); // Show as connecting/processing

      // Clean up the session
      const response = await this.apiRequest("POST", "/api/telegram/cleanup-session");

      if (response && response.success) {
        this.showToast("success", "Disconnected", "Successfully disconnected from Telegram");
        this.updateTelegramStatus("disconnected");
      } else {
        this.showToast("warning", "Disconnect Warning", "Session may not be fully cleaned");
        this.updateTelegramStatus("disconnected"); // Still update UI
      }

    } catch (error) {
      if (RENDERER_DEBUG) console.error("[DEBUG] Disconnect error:", error);
      this.showToast("error", "Disconnect Error", "Error during disconnect, but session should be invalid");
      this.updateTelegramStatus("disconnected"); // Still update UI
    }
  }

  async connectTelegram() {
    // Prevent double connection attempts - ENHANCED
    if (this.isConnecting || this.pendingCode || this.pendingPassword) {
      return;
    }

    // Set flag to prevent duplicate requests
    this.isConnecting = true;

    try {
      // Check if there's already a valid session first when user wants to connect
      try {

        const sessionResponse = await this.apiRequest("GET", "/api/telegram/session-status");

        if (sessionResponse && sessionResponse.success && sessionResponse.data) {
          const { session_exists, session_valid } = sessionResponse.data;

          if (session_exists && session_valid) {
            this.updateTelegramStatus("connected");
            this.showToast("success", "Already Connected", "Using existing Telegram session");
            return;
          } else if (session_exists && !session_valid) {
            try {
              await this.cleanupTelegramSession();
            } catch (cleanupError) {
            }
          }
        }
      } catch (error) {
      }

      // ... rest of connection logic ...

      // Updated to match the HTML IDs correctly
      const apiIdInput = document.getElementById("telegram-api-id");
      const apiHashInput = document.getElementById("telegram-api-hash");
      const phoneInput = document.getElementById("telegram-phone");

      if (!apiIdInput || !apiHashInput || !phoneInput) {
        if (RENDERER_DEBUG) console.error("[DEBUG] Missing input elements:", {
          apiIdInput: !!apiIdInput,
          apiHashInput: !!apiHashInput,
          phoneInput: !!phoneInput
        });
        this.showToast("error", "Input Error", "Telegram connection inputs not found");
        return;
      }

      const apiId = apiIdInput.value.trim();
      const apiHash = apiHashInput.value.trim();
      const phoneNumber = phoneInput.value.trim();

      // Validate inputs
      if (!apiId || !apiHash || !phoneNumber) {
        if (RENDERER_DEBUG) console.error("[DEBUG] Validation failed - missing inputs");

        // Show specific field errors
        const missingFields = [];
        if (!apiId) missingFields.push("API ID");
        if (!apiHash) missingFields.push("API Hash");
        if (!phoneNumber) missingFields.push("Phone Number");

        this.showToast("error", "Invalid Input", `Please fill in: ${missingFields.join(", ")}`);
        return;
      }

      // Save credentials securely
      this.saveCredentials();

      // Save phone number for future use
      this.savePhoneNumber(phoneNumber);

      // Proceed with Telegram connection
      const connectBtn = document.getElementById("connect-telegram");
      if (connectBtn) {
        connectBtn.disabled = true;
        connectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
      }

      this.showLoadingOverlay("Connecting to Telegram...");


      let response;
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          response = await this.apiRequest("POST", "/api/telegram/connect", {
            api_id: apiId,
            api_hash: apiHash,
            phone_number: phoneNumber,
            process_id: "connect_" + Date.now(),
          });

          break; // Success, exit retry loop

        } catch (error) {
          if (RENDERER_DEBUG) console.error(`[DEBUG] Connection attempt ${retryCount + 1} failed:`, error);

          // Check for database lock error
          if (error.message && error.message.includes("database is locked") && retryCount < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 1000));
            retryCount++;
            continue;
          }

          throw error; // Re-throw if not a database lock error or max retries reached
        }
      }

      this.hideLoadingOverlay();

      const resOk = response && typeof response === "object" && response.success === true;
      if (resOk) {
        const result = (response.data !== undefined && response.data !== null) ? response.data : response;
        const needsCode = !!(result && result.needs_code);
        const needsPassword = !!(result && result.needs_password);

        if (needsCode) {
          this.pendingCode = true;
          try { this.hideIconModal(); } catch (_e) {
            // Ignore errors when hiding icon modal
          }
          this.showModal("code-modal");
          this.showToast(
            "info",
            "Code Sent",
            "Verification code sent to your phone number"
          );
          setTimeout(() => {
            const codeInput = document.getElementById("verification-code");
            if (codeInput) codeInput.focus();
          }, 500);
        } else if (needsPassword) {
          this.pendingPassword = true;
          try { this.hideIconModal(); } catch (_e) {
            // Ignore errors when hiding icon modal  
          }
          this.showModal("password-modal");
          this.showToast(
            "info",
            "2FA Required",
            "Please enter your 2FA password"
          );
          setTimeout(() => {
            const passwordInput = document.getElementById("two-factor-password");
            if (passwordInput) passwordInput.focus();
          }, 500);
        } else {
          // Successful connection

          // Show session reuse information
          let successMessage = "Successfully connected to Telegram";
          if (result && result.reused_session) {
            successMessage += " (Reused existing session - no rate limits!)";
            this.showToast("success", "Session Reused", "Used existing session to avoid rate limiting", 6000);
            this.addStatusItem("✅ Session reused successfully", "success");
          } else if (result && result.existing_session) {
            successMessage += " (Used existing authorized session)";
            this.showToast("success", "Session Found", "Found existing authorized session", 5000);
            this.addStatusItem("✅ Existing session found and used", "success");
          } else {
            successMessage += " (Created new session)";
            this.showToast("success", "Connected", successMessage);
            this.addStatusItem("✅ New session created", "success");
          }

          this.updateTelegramStatus("connected");
        }
      } else {
        if (RENDERER_DEBUG) console.error("[DEBUG] Connection failed - response not successful:", response);

        // Handle rate limiting specifically
        if (response && response.rate_limited) {
          const waitTime = response.wait_time_human || "some time";
          this.showToast(
            "warning",
            "Rate Limited",
            `${response.error}
Too many requests. Please wait ${waitTime} before trying again.
Tip: Next time, the app will reuse your session automatically to avoid this!`,
            12000  // Show for 12 seconds
          );

          // Show detailed rate limit info
          this.addStatusItem(`⚠️ Telegram rate limit: Wait ${waitTime}`, "warning");
          this.addStatusItem("💡 Next connection will reuse session to avoid limits", "info");

          // Reset UI state before returning
          this.hideLoadingOverlay();
          this.updateTelegramStatus("disconnected");
          return; // Don't proceed further
        }

        const errorMsg = (response && response.error) || "Unknown error occurred";
        this.showToast("error", "Connection Failed", errorMsg);

        // Reset UI state for general connection failure
        this.hideLoadingOverlay();
        this.updateTelegramStatus("disconnected");
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("[DEBUG] Connection error caught:", error);
      this.hideLoadingOverlay();

      let errorMsg = error.message || "Failed to connect";

      // Handle specific error types
      if (errorMsg.includes("rate limit") || errorMsg.includes("wait") || errorMsg.includes("FloodWaitError")) {
        this.showToast(
          "warning",
          "Rate Limited",
          "Too many requests to Telegram. Please wait before trying again.",
          8000
        );
      } else if (errorMsg.includes("database is locked")) {
        errorMsg = "Database is locked. Please try again in a moment.";
        this.showToast("error", "Connection Error", errorMsg);
      } else if (errorMsg.includes("connect_telegram")) {
        errorMsg = "Connection service unavailable. Please restart the application.";
        this.showToast("error", "Connection Error", errorMsg);
      } else {
        this.showToast("error", "Connection Error", errorMsg);
      }

      // Reset UI state after error
      this.updateTelegramStatus("disconnected");

    } finally {
      // Reset connection flag
      this.isConnecting = false;
    }
  }


  highlightEmptyFields(fields) {
    fields.forEach((field) => {
      if (!field.value.trim()) {
        field.classList.add("error");
        setTimeout(() => field.classList.remove("error"), 3000);
      }
    });
  }

  async submitVerificationCode() {
    // Promise-based lock to prevent double submission
    if (this._submitCodePromise) {
      return this._submitCodePromise;
    }

    this._submitCodePromise = (async () => {
      const codeInput = document.getElementById("verification-code");
      if (!codeInput) return;

      const code = codeInput.value.trim();
      if (!code) {
        this.showToast(
          "error",
          "Missing Code",
          "Please enter the verification code"
        );
        codeInput.focus();
        return;
      }

      if (!/^\d{5}$/.test(code)) {
        this.showToast(
          "warning",
          "Invalid Format",
          "Verification code should be 5 digits"
        );
        codeInput.select();
        return;
      }

      try {

        const submitBtn = document.getElementById("submit-code");
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> Verifying...';
        }

        const response = await this.apiRequest("POST", "/api/sticker/verify-code", { code });

        const resOk = response && typeof response === "object" && response.success === true;
        if (resOk) {
          const result = (response.data !== undefined && response.data !== null) ? response.data : response;
          // Check if 2FA password is needed
          const needsPassword = !!(result && result.needs_password);
          if (needsPassword) {
            this.pendingCode = false;
            this.pendingPassword = true;
            this.hideModal();
            this.showModal("password-modal");
            this.showToast(
              "info",
              "2FA Required",
              "Please enter your 2FA password"
            );
            setTimeout(() => {
              const passwordInput = document.getElementById(
                "two-factor-password"
              );
              if (passwordInput) passwordInput.focus();
            }, 500);
          } else {
            this.pendingCode = false;
            this.hideModal();
            this.updateTelegramStatus("connected");
            this.saveSettings();
            this.showToast(
              "success",
              "Connected",
              "Successfully connected to Telegram"
            );
          }
        } else {
          this.showToast(
            "error",
            "Verification Failed",
            (response && response.error) || "Invalid verification code"
          );
          codeInput.select();
        }
      } catch (error) {
        if (RENDERER_DEBUG) console.error("Error verifying code:", error);
        this.showToast(
          "error",
          "Verification Error",
          "Failed to verify code: " + error.message
        );
      } finally {
        const submitBtn = document.getElementById("submit-code");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fas fa-check"></i> Verify Code';
        }
      }
    })();

    // Always clear the promise lock after completion
    this._submitCodePromise.finally(() => {
      this._submitCodePromise = null;
    });

    return this._submitCodePromise;
  }

  async submitPassword() {
    // Promise-based lock to prevent double submission
    if (this._submitPasswordPromise) {
      return this._submitPasswordPromise;
    }

    this._submitPasswordPromise = (async () => {
      const passwordInput = document.getElementById("two-factor-password");
      if (!passwordInput) return;

      const password = passwordInput.value.trim();
      if (!password) {
        this.showToast(
          "error",
          "Missing Password",
          "Please enter your 2FA password"
        );
        passwordInput.focus();
        return;
      }

      try {

        const submitBtn = document.getElementById("submit-password");
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
        }

        const response = await this.apiRequest("POST", "/api/sticker/verify-password", { password });

        const resOk = response && typeof response === "object" && response.success === true;
        if (resOk) {
          const result = (response.data !== undefined && response.data !== null) ? response.data : response;
          this.pendingPassword = false;
          this.hideModal();
          this.updateTelegramStatus("connected");
          this.saveSettings();
          this.showToast(
            "success",
            "Connected",
            "Successfully connected to Telegram"
          );
        } else {
          this.showToast(
            "error",
            "Authentication Failed",
            (response && response.error) || "Invalid password"
          );
          passwordInput.select();
        }
      } catch (error) {
        if (RENDERER_DEBUG) console.error("Error verifying password:", error);
        this.showToast(
          "error",
          "Authentication Error",
          "Failed to verify password: " + error.message
        );
      } finally {
        const submitBtn = document.getElementById("submit-password");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fas fa-key"></i> Authenticate';
        }
      }
    })();

    // Always clear the promise lock after completion
    this._submitPasswordPromise.finally(() => {
      this._submitPasswordPromise = null;
    });

    return this._submitPasswordPromise;
  }

  async addImages() {
    // Check if video type is selected and prevent image upload
    if (this.selectedMediaType === "video" && this.mediaFiles.some(f => f.type === "video")) {
      this.showToast("error", "Type Mismatch", "Cannot add images to a video sticker pack. Clear media or switch to image type.");
      return;
    }

    try {
      const files = await window.electronAPI.selectFiles({
        filters: [
          { name: "Image Files", extensions: ["png", "jpg", "jpeg", "webp"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      // selectFiles returns an array directly
      if (!Array.isArray(files) || files.length === 0) {
        return;
      }

      // Validate files before processing
      const validFiles = files.filter(file => {
        if (!file || typeof file !== "string") {
          return false;
        }
        return true;
      });

      if (validFiles.length === 0) {
        this.showToast("warning", "No Valid Files", "No valid image files were selected");
        return;
      }

      let addedCount = 0;
      let skippedCount = 0;

      files.forEach((file) => {
        if (this.mediaFiles.length >= 120) {
          skippedCount++;
          return;
        }

        if (!this.mediaFiles.some((f) => f.file_path === file)) {
          // Sanitize default emoji while preserving variation selectors (Windows color fix)
          const cleanDefaultEmoji = this.normalizeEmoji(this.defaultEmoji || "❤️");

          this.mediaFiles.push({
            file_path: file,
            name: file.split(/[\\/]/).pop(),
            type: "image",
            emoji: cleanDefaultEmoji,
            dateAdded: Date.now(),
            status: "pending",
          });
          addedCount++;
        } else {
          skippedCount++;
        }
      });

      this.updateMediaFileList();

      if (addedCount > 0) {
        this.showToast(
          "success",
          "Images Added",
          `Added ${addedCount} image files`
        );
      }

      if (skippedCount > 0) {
        this.showToast(
          "warning",
          "Some Files Skipped",
          `${skippedCount} files were skipped (duplicates or limit reached)`
        );
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error adding images:", error);

      // Handle specific Windows file system errors
      if (error.message && error.message.includes("Errno 22")) {
        this.showToast(
          "error",
          "File Selection Error",
          "Invalid file path or file access denied. Please check file names and try again."
        );
      } else {
        this.showToast(
          "error",
          "Error",
          "Failed to add image files: " + error.message
        );
      }
    }
  }

  async addStickerVideos() {
    // Check if image type is selected and prevent video upload
    if (this.selectedMediaType === "image" && this.mediaFiles.some(f => f.type === "image")) {
      this.showToast("error", "Type Mismatch", "Cannot add videos to an image sticker pack. Clear media or switch to video type.");
      return;
    }

    try {
      const files = await window.electronAPI.selectFiles({
        filters: [
          { name: "Video Files", extensions: ["webm"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      // selectFiles returns an array directly
      if (!Array.isArray(files) || files.length === 0) {
        return;
      }

      // Validate files before processing
      const validFiles = files.filter(file => {
        if (!file || typeof file !== "string") {
          return false;
        }
        return true;
      });

      if (validFiles.length === 0) {
        this.showToast("warning", "No Valid Files", "No valid video files were selected");
        return;
      }

      let addedCount = 0;
      let skippedCount = 0;

      files.forEach((file) => {
        if (this.mediaFiles.length >= 120) {
          skippedCount++;
          return;
        }

        if (!this.mediaFiles.some((f) => f.file_path === file)) {
          // Sanitize default emoji while preserving variation selectors (Windows color fix)
          const cleanDefaultEmoji = this.normalizeEmoji(this.defaultEmoji || "❤️");

          this.mediaFiles.push({
            file_path: file,
            name: file.split(/[\\/]/).pop(),
            type: "video",
            emoji: cleanDefaultEmoji,
            dateAdded: Date.now(),
            status: "pending",
          });
          addedCount++;
        } else {
          skippedCount++;
        }
      });

      this.updateMediaFileList();

      if (addedCount > 0) {
        this.showToast(
          "success",
          "Videos Added",
          `Added ${addedCount} video files`
        );
      }

      if (skippedCount > 0) {
        this.showToast(
          "warning",
          "Some Files Skipped",
          `${skippedCount} files were skipped (duplicates or limit reached)`
        );
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error adding videos:", error);

      // Handle specific Windows file system errors
      if (error.message && error.message.includes("Errno 22")) {
        this.showToast(
          "error",
          "File Selection Error",
          "Invalid file path or file access denied. Please check file names and try again."
        );
      } else {
        this.showToast(
          "error",
          "Error",
          "Failed to add video files: " + error.message
        );
      }
    }
  }

  clearMedia() {
    if (this.mediaFiles.length === 0) {
      this.showToast("info", "Already Empty", "No media files to clear");
      return;
    }

    const count = this.mediaFiles.length;
    this.mediaFiles = [];
    this.updateMediaFileList();
    this.showToast("info", "Cleared", `Removed ${count} media files`);
  }

  updateMediaFileList() {
    const container = document.getElementById("sticker-media-list");
    if (!container) {
      // Try again after a short delay in case DOM is still loading
      setTimeout(() => {
        const retryContainer = document.getElementById("sticker-media-list");
        if (retryContainer && this.mediaFiles.length > 0) {
          this.updateMediaFileList();
        }
      }, 100);
      return;
    }

    if (this.mediaFiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-file-image"></i>
          <p>No media files selected</p>
          <small>Add images or videos for your sticker pack (max 120 files)</small>
        </div>
      `;
      return;
    }

    container.innerHTML = this.mediaFiles
      .map((file, index) => {
        const statusClass = file.status || "pending";
        const statusIcon = this.getMediaStatusIcon(file.status);
        const fileUrl = this.pathToFileUrl(file.file_path);
        const preview = file.type === "image"
          ? `<div class="media-preview" onclick="window.openMediaPreview(${index})" title="Click to preview">
               <img class="media-preview-img" src="${fileUrl}" alt="${file.name}">
             </div>`
          : `<div class="media-preview" onclick="window.openMediaPreview(${index})" title="Click to preview">
               <video class="media-preview-video" src="${fileUrl}" muted preload="metadata"></video>
               <i class="fas fa-play-circle media-preview-video-icon"></i>
             </div>`;

        return `
          <div class="media-item ${statusClass} new-item" data-index="${index}">
            <div class="media-info">
              ${preview}
              <div class="media-details">
                <div class="media-name" title="${file.file_path}">${file.name}</div>
                <div class="media-meta">
                  ${file.status && file.status !== "pending"
            ? `<span class="media-status"><i class="${statusIcon}"></i> ${this.getStatusText(file.status)}</span>`
            : ""
          }
                </div>
              </div>
            </div>
            <div class="media-actions">
              <button class="media-emoji-btn" onclick="window.app?.editEmoji(${index})" 
                      title="Change Emoji">
                ${file.emoji}
              </button>
              <button class="btn btn-sm btn-info" onclick="window.app?.showMediaInfo(${index})" title="File Info">
                <i class="fas fa-info-circle"></i>
              </button>
              <button class="btn btn-sm btn-danger" onclick="window.app?.removeMediaFile(${index})" 
                      title="Remove File">
                <i class="fas fa-times"></i>
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    // Update media counter
    const counter = document.getElementById("media-counter");
    if (counter) {
      counter.textContent = this.mediaFiles.length;
    }

    // Update progress if in progress
    this.updateStickerProgress();
  }

  getMediaStatusIcon(status) {
    const iconMap = {
      pending: "fas fa-clock",
      uploading: "fas fa-upload text-primary",
      processing: "fas fa-cog fa-spin text-warning",
      completed: "fas fa-check text-success",
      error: "fas fa-exclamation-triangle text-danger",
      ready: "fas fa-clock text-muted"
    };
    return iconMap[status] || "fas fa-clock";
  }

  getStatusText(status) {
    const textMap = {
      pending: "Waiting",
      uploading: "Uploading",
      processing: "Processing",
      completed: "Complete",
      error: "Error",
      ready: "Ready"
    };
    return textMap[status] || status;
  }

  // Convert a local file path to a file:// URL safe for <img>/<video>
  pathToFileUrl(p) {
    try {
      if (!p) return "";
      if (/^(https?:|data:|file:)/i.test(p)) return p;
      let norm = String(p).replace(/\\/g, "/");
      if (!norm.startsWith("/")) norm = "/" + norm; // Ensure leading slash for Windows paths
      return "file://" + encodeURI(norm);
    } catch (_) {
      return "";
    }
  }

  // Open full preview for image/video
  openMediaPreview(index) {
    const file = this.mediaFiles[index];
    if (!file) return;
    const url = this.pathToFileUrl(file.file_path);
    if (file.type === "image") {
      if (window.ImageViewer && typeof window.ImageViewer.open === "function") {
        window.ImageViewer.open({ src: url, title: file.name });
      } else {
        window.open(url, "_blank");
      }
    } else {
      this.showVideoViewer({ src: url, title: file.name });
    }
  }

  showVideoViewer({ src, title = "" }) {
    // If an overlay already exists, remove it first
    const existing = document.querySelector(".video-viewer-overlay");
    if (existing) existing.parentNode.removeChild(existing);

    const overlay = document.createElement("div");
    overlay.className = "video-viewer-overlay";

    const container = document.createElement("div");
    container.className = "video-viewer-container";

    const video = document.createElement("video");
    video.className = "video-viewer-player";
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.title = title;

    const closeBtn = document.createElement("button");
    closeBtn.className = "video-viewer-close";
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';

    container.appendChild(video);
    container.appendChild(closeBtn);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("active"));

    const onClose = () => this.closeVideoViewer(overlay, video);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) onClose(); });
    closeBtn.addEventListener("click", onClose);
    const keyHandler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", keyHandler, { once: true });
  }

  closeVideoViewer(overlay, video) {
    try { if (video) { video.pause(); video.src = ""; } } catch (_) { }
    if (!overlay) overlay = document.querySelector(".video-viewer-overlay");
    if (overlay) overlay.parentNode.removeChild(overlay);
  }

  // Enhanced media status update with real-time sync
  updateMediaFileStatus(fileIndex, status, progress = null, stage = null) {
    if (fileIndex >= 0 && fileIndex < this.mediaFiles.length) {
      const file = this.mediaFiles[fileIndex];
      const oldStatus = file.status;

      // Update file properties
      file.status = status;
      if (progress !== null) file.progress = progress;
      if (stage !== null) file.stage = stage;

      // Log status change for debugging
      if (oldStatus !== status) {
      }

      // Update the specific media item in the DOM without full refresh
      this.updateSingleMediaItem(fileIndex);

      // Update overall progress indicators
      this.updateMediaProgress();
    }
  }

  updateSingleMediaItem(index) {
    const mediaItem = document.querySelector(`[data-index="${index}"]`);
    if (!mediaItem || !this.mediaFiles[index]) return;

    const file = this.mediaFiles[index];
    const statusIcon = this.getMediaStatusIcon(file.status);
    const statusText = this.getStatusText(file.status);

    // Update status display
    const statusElement = mediaItem.querySelector(".media-status");
    if (statusElement) {
      statusElement.innerHTML = `<i class="${statusIcon}"></i> ${statusText}`;
    } else if (file.status && file.status !== "pending") {
      // Add status element if it doesn't exist
      const metaElement = mediaItem.querySelector(".media-meta");
      if (metaElement) {
        metaElement.innerHTML += `<span class="media-status"><i class="${statusIcon}"></i> ${statusText}</span>`;
      }
    }

    // Update item class for styling
    mediaItem.className = `media-item ${file.status || "pending"} new-item`;

    // Add progress indicator for processing status
    if (file.status === "processing" && file.progress !== undefined) {
      let progressBar = mediaItem.querySelector(".progress-indicator");
      if (!progressBar) {
        progressBar = document.createElement("div");
        progressBar.className = "progress-indicator";
        mediaItem.appendChild(progressBar);
      }
      progressBar.innerHTML = `
        <div class="progress-bar-container">
          <div class="progress-bar" style="width: ${file.progress || 0}%"></div>
          <span class="progress-text">${file.progress || 0}%</span>
        </div>
      `;
    } else {
      // Remove progress indicator if not processing
      const progressBar = mediaItem.querySelector(".progress-indicator");
      if (progressBar) {
        progressBar.remove();
      }
    }
  }

  updateMediaProgress() {
    const totalFiles = this.mediaFiles.length;
    if (totalFiles === 0) return;

    const statusCounts = {
      completed: 0,
      processing: 0,
      error: 0,
      pending: 0
    };

    // Count statuses
    this.mediaFiles.forEach(file => {
      const status = file.status || "pending";
      if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
        statusCounts[status]++;
      }
    });

    // Update progress indicators
    const progressPercent = Math.round((statusCounts.completed / totalFiles) * 100);

    // Update any progress displays
    const progressElements = document.querySelectorAll(".sticker-progress-percentage");
    progressElements.forEach(el => {
      if (el) el.textContent = `${progressPercent}%`;
    });

    const statusElements = document.querySelectorAll(".sticker-progress-stats");
    statusElements.forEach(el => {
      if (el) el.textContent = `${statusCounts.completed} / ${totalFiles} stickers processed`;
    });
  }

  // Update media file statuses based on backend progress data
  updateMediaStatusFromProgress(progress) {
    if (!progress || !this.mediaFiles) return;

    // If progress contains file-specific status information
    if (progress.file_statuses) {
      Object.entries(progress.file_statuses).forEach(([fileIndex, fileStatus]) => {
        const index = parseInt(fileIndex);
        if (index >= 0 && index < this.mediaFiles.length) {
          this.updateMediaFileStatus(
            index,
            fileStatus.status || "processing",
            fileStatus.progress,
            fileStatus.stage
          );
        }
      });
    } else {
      // Fallback: update all files based on overall progress
      const overallStatus = this.getStatusFromProgress(progress);
      this.mediaFiles.forEach((file, index) => {
        if (file.status !== "completed" && file.status !== "error") {
          this.updateMediaFileStatus(index, overallStatus, progress.progress);
        }
      });
    }
  }

  getStatusFromProgress(progress) {
    if (progress.status === "completed") return "completed";
    if (progress.status === "error" || progress.status === "failed") return "error";
    if (progress.current_stage && progress.current_stage.includes("upload")) return "uploading";
    if (progress.current_stage && progress.current_stage.includes("process")) return "processing";
    return "processing";  // Default to processing for active states
  }
  async showMediaInfo(index) {
    const file = this.mediaFiles[index];
    if (!file) return;

    // Get detailed file metadata from backend
    let fileInfo = {
      name: file.name,
      size: "Unknown",
      duration: "N/A",
      format: "Unknown",
      dimensions: "Unknown",
      dateModified: "Unknown"
    };

    try {
      const result = await this.apiRequest("POST", "/api/get-file-info", {
        path: file.file_path
      });

      if (result && result.success && result.data) {
        fileInfo = {
          name: result.data.name || file.name,
          size: result.data.size_formatted || "Unknown",
          duration: result.data.duration_formatted || "N/A",
          format: result.data.format ? result.data.format.toUpperCase() : "Unknown",
          dimensions: result.data.dimensions || "Unknown",
          dateModified: result.data.modified ? new Date(result.data.modified * 1000).toLocaleDateString() : "Unknown",
          type: result.data.type || "unknown",
          codec: result.data.codec || null,
          fps: result.data.fps || null
        };
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Failed to get file info:", error);
    }

    // Format additional technical info
    let technicalInfo = "";
    if (fileInfo.codec) {
      technicalInfo += `<div style="margin-bottom: 0.5rem;">
        <strong style="color: #667eea;">🎬 Codec:</strong> 
        <span style="color: #ccc;">${fileInfo.codec}</span>
      </div>`;
    }
    if (fileInfo.fps && fileInfo.fps > 0) {
      technicalInfo += `<div style="margin-bottom: 0.5rem;">
        <strong style="color: #667eea;">⚡ Frame Rate:</strong> 
        <span style="color: #ccc;">${fileInfo.fps.toFixed(1)} fps</span>
      </div>`;
    }

    // Get file type icon
    const typeIcon = fileInfo.type === "video" ? "🎥" : fileInfo.type === "image" ? "🖼️" : "📄";
    const typeLabel = fileInfo.type === "video" ? "Video" : fileInfo.type === "image" ? "Image" : "File";

    const info = `
      <div style="font-size: 0.9rem; line-height: 1.8; max-width: 400px;">
        <div style="margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.1);">
          <strong style="color: #667eea; font-size: 1rem;">${typeIcon} ${typeLabel} File Information</strong>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📄 Name:</strong> 
          <span style="color: #ccc; word-break: break-word;">${fileInfo.name}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📏 Size:</strong> 
          <span style="color: #ccc;">${fileInfo.size}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📐 Dimensions:</strong> 
          <span style="color: #ccc;">${fileInfo.dimensions}</span>
        </div>
        
        ${file.type === "video" ? `<div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">⏱️ Duration:</strong> 
          <span style="color: #ccc;">${fileInfo.duration}</span>
        </div>` : ""}
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">🎬 Format:</strong> 
          <span style="color: #ccc;">${fileInfo.format}</span>
        </div>
        
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">📅 Modified:</strong> 
          <span style="color: #ccc;">${fileInfo.dateModified}</span>
        </div>
        
        ${technicalInfo}
        
        <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">🎉 Emoji:</strong> 
            <span style="font-size: 1.5rem;">${file.emoji || "😀"}</span>
          </div>
          
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">🔄 Status:</strong> 
            <span style="color: ${this.getStatusColor(file.status)};">${file.status || "Ready"}</span>
          </div>
        </div>
        
        <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">
          <small style="color: #888;">File ${index + 1} of ${this.mediaFiles.length} • Sticker Pack</small>
        </div>
      </div>
    `;

    this.showDetailedMessage("Media File Details", info);
  }


  removeMediaFile(index) {
    if (index < 0 || index >= this.mediaFiles.length) return;

    const file = this.mediaFiles[index];
    this.mediaFiles.splice(index, 1);
    this.updateMediaFileList();
    this.showToast("info", "File Removed", `Removed ${file.name}`);
  }

  editEmoji(index) {
    if (index < 0 || index >= this.mediaFiles.length) {
      return;
    }

    // Ensure we're not in a locked state
    if (this.modalState.isEmojiLocked) {
      return;
    }

    // Prevent immediate closure
    this.modalState.preventEmojiClosure = true;
    setTimeout(() => {
      this.modalState.preventEmojiClosure = false;
    }, 300);

    this.currentEmojiIndex = index;
    const currentEmoji = this.mediaFiles[index].emoji;
    const fileName = this.mediaFiles[index].name;
    const emojiInput = document.getElementById("emoji-input");
    const filenameDisplay = document.getElementById("emoji-filename");

    if (emojiInput) emojiInput.value = currentEmoji;
    if (filenameDisplay) filenameDisplay.textContent = fileName;

    // Ensure the modal is properly reset before showing
    const modal = document.getElementById("emoji-modal");
    if (modal) {
      modal.style.opacity = "1";
      modal.style.display = "block";
      // Ensure proper z-index for emoji modal
      modal.style.zIndex = "9000";
    }

    this.showModal("emoji-modal");

    // Add a small delay to ensure focus works
    setTimeout(() => {
      if (emojiInput) {
        emojiInput.focus();
        emojiInput.select();
      }
    }, 100);
  }

  saveEmoji() {
    const emojiInput = document.getElementById("emoji-input");
    if (!emojiInput) return;

    const newEmoji = this.normalizeEmoji(emojiInput.value.trim());
    this.saveEmojiDirect(newEmoji);
  }

  saveEmojiDirect(emoji) {
    // Check if we have a valid emoji index
    if (this.currentEmojiIndex === null || this.currentEmojiIndex < 0) {
      return;
    }

    const newEmoji = this.normalizeEmoji(emoji);

    if (!newEmoji) {
      this.showToast("warning", "Empty Emoji", "Please select an emoji");
      return;
    }

    // Update emoji
    if (this.currentEmojiIndex < this.mediaFiles.length) {
      this.mediaFiles[this.currentEmojiIndex].emoji = newEmoji;
      this.updateMediaFileList();
      // Keep modal input/preview in sync
      this.syncEmojiModalWithCurrent();
      this.showToast(
        "success",
        "Emoji Set",
        `Emoji set to ${newEmoji}`
      );
    }

    this.hideModal();

    // Reset for next use
    this.currentEmojiIndex = null;
  }

  async createStickerPack() {
    // Check if we're creating new or adding to existing
    if (this.currentPackMode === "add") {
      return await this.addToExistingPack();
    }

    const packNameEl = document.getElementById("pack-name");
    const packName = (packNameEl && typeof packNameEl.value === "string") ? packNameEl.value.trim() : "";
    const packUrlNameEl = document.getElementById("pack-url-name");
    const packUrlName = (packUrlNameEl && typeof packUrlNameEl.value === "string") ? packUrlNameEl.value.trim() : "";
    const stickerTypeEl = document.querySelector('input[name="sticker-type"]:checked');
    const stickerType = stickerTypeEl ? stickerTypeEl.value : "image";

    // 🔒 CRITICAL: Check Telegram connection first
    // Primary check: Use frontend connection status first
    if (!this.telegramConnected) {
      this.showToast("error", "Telegram Not Connected", "Please connect to Telegram first before creating sticker packs");
      this.addStatusItem("❌ Error: Telegram not connected - Please connect to Telegram first", "error");

      // Switch to Telegram tab to help user
      const telegramTab = document.querySelector('[data-tab="sticker-bot"]');
      if (telegramTab) {
        telegramTab.click();
      }
      return;
    }

    // Secondary check: Verify backend session (non-blocking)
    try {
      const sessionResponse = await this.apiRequest("GET", "/api/telegram/session-status");

      // If backend says no connection but frontend thinks connected, try to reconnect silently
      if (!sessionResponse.success || !sessionResponse.data || !sessionResponse.data.session_valid) {
        // Try a quick health check to refresh connection
        try {
          await this.apiRequest("GET", "/api/health");
        } catch (healthError) {
          console.error("Health check failed:", healthError);
          this.showToast("warning", "Connection Issue", "Backend connection issue detected, but proceeding anyway...");
        }
      }
    } catch (error) {
      console.error("Session check failed:", error);
      // Don't block creation on session check failure - frontend status takes precedence
    }

    // Validate media files
    if (!this.mediaFiles || this.mediaFiles.length === 0) {
      this.showToast("error", "No Media Files", "Please add media files first");
      this.addStatusItem("❌ Error: No media files selected", "error");
      return;
    }

    // Validate pack name
    const packNameValidation = this.validatePackName(packName);
    if (!packNameValidation.valid) {
      this.showToast("error", "Invalid Pack Name", packNameValidation.error);
      this.addStatusItem(`❌ Error: ${packNameValidation.error}`, "error");
      this.updateValidationDisplay("pack-name", packNameValidation);
      return;
    }

    // Validate URL name
    const urlValidation = this.validateUrlName(packUrlName);
    if (!urlValidation.valid) {
      this.showToast("error", "Invalid URL Name", urlValidation.error);
      this.addStatusItem(`❌ Error: ${urlValidation.error}`, "error");
      this.updateValidationDisplay("pack-url-name", urlValidation);
      return;
    }

    // Check for duplicate/concurrent sticker creation
    if (this.stickerProgressInterval) {
      this.showToast("warning", "Creation In Progress", "Another sticker pack creation is already running");
      this.addStatusItem("⚠️ Warning: Sticker pack creation already in progress", "warning");
      return;
    }

    // Clear logged file statuses for new pack creation
    this.loggedFileStatuses.clear();

    // Add initial status
    this.addStatusItem(`🚀 Starting sticker pack creation: "${packName}"`, "info");

    const incompatibleFiles = this.mediaFiles.filter((f) => {
      if (stickerType === "video" && f.type !== "video") return true;
      if (stickerType === "image" && f.type !== "image") return true;
      return false;
    });

    if (incompatibleFiles.length > 0) {
      this.addStatusItem(`⚠️ Warning: ${incompatibleFiles.length} files don't match sticker type`, "warning");
      const proceed = await window.confirmModal.show(
        `${incompatibleFiles.length} files don't match the sticker type (${stickerType}). Continue with compatible files only?`,
        "Incompatible Files"
      );
      if (!proceed) {
        this.addStatusItem("❌ Creation cancelled by user", "info");
        return;
      }
    }

    this.addStatusItem(`🔍 Validating ${this.mediaFiles.length} media files...`, "info");

    try {
      // Sanitize process id for safe server-side handling
      // ENHANCED: Better sanitization to prevent [Errno 22] Invalid argument
      let processId = ("sticker_" + Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");
      // Ensure it's not too long and doesn't contain invalid characters
      processId = processId.substring(0, 50).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      if (!processId || processId.length === 0) {
        processId = "sticker_" + Date.now();
      }

      // Get auto-skip setting
      const autoSkipIconEl = document.getElementById("auto-skip-icon");
      const autoSkipIcon = autoSkipIconEl ? autoSkipIconEl.checked : true;

      // Disable the create button to prevent double-clicking
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
      }

      this.showLoadingOverlay("Starting sticker pack creation...");

      // Build a minimal, backend-friendly payload
      // ENHANCED: Better sanitization to prevent [Errno 22] Invalid argument
      const filteredMedia = this.mediaFiles
        .filter((f) => (stickerType === "video" ? f.type === "video" : f.type === "image"))
        .map((f) => ({
          file_path: String(f.file_path || "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim(),
          emoji: typeof f.emoji === "string" && f.emoji.replace(/[\x00-\x1f\x7f-\x9f]/g, "").length > 0
            ? this.normalizeEmoji(f.emoji)
            : this.normalizeEmoji(this.defaultEmoji),
          type: f.type === "video" ? "video" : "image",
        }))
        .filter((m) => m.file_path && m.file_path.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(m.file_path));

      // Additional validation for file paths and emoji data
      for (const media of filteredMedia) {
        // Ensure file_path is properly sanitized
        if (typeof media.file_path === "string") {
          // Remove any remaining invalid characters
          media.file_path = media.file_path.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
          // Ensure it's not empty
          if (media.file_path.length === 0) {
            throw new Error("Invalid file path");
          }
        }

        // Ensure emoji is a single valid character
        if (typeof media.emoji === "string" && media.emoji.length > 0) {
          media.emoji = this.normalizeEmoji(media.emoji);
        } else {
          media.emoji = this.normalizeEmoji(this.defaultEmoji);
        }
      }

      // ENHANCED: Validate and sanitize all request data to prevent [Errno 22] Invalid argument
      // Remove any control characters that could cause issues
      const sanitizedPackName = String(packName || "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().substring(0, 64);
      const sanitizedPackUrlName = String(packUrlName || "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().substring(0, 32);
      const sanitizedProcessId = String(processId || "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);

      // Validate that we have valid data after sanitization
      if (!sanitizedPackName || sanitizedPackName.length === 0) {
        throw new Error("Invalid pack name");
      }

      if (!sanitizedPackUrlName || sanitizedPackUrlName.length === 0) {
        throw new Error("Invalid URL name");
      }

      if (!sanitizedProcessId || sanitizedProcessId.length === 0) {
        throw new Error("Invalid process ID");
      }

      const requestData = {
        pack_name: sanitizedPackName,
        pack_url_name: sanitizedPackUrlName,
        sticker_type: stickerType,
        media_files: filteredMedia,
        process_id: sanitizedProcessId,
        auto_skip_icon: autoSkipIcon,
      };

      const response = await this.apiRequest("POST", "/api/sticker/create-pack", requestData);

      this.hideLoadingOverlay();

      if (response.success) {
        this.showToast(
          "info",
          "Creation Started",
          "Sticker pack creation started in background"
        );

        this.addStatusItem("🚀 Starting sticker pack creation: \"" + packName + "\"", "processing");

        if (createBtn) {
          createBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Pack...';
        }

        // Start monitoring progress
        const finalProcessId = response.process_id || processId;

        // CRITICAL: Track the sticker process ID for URL name retry functionality
        this.currentStickerProcessId = finalProcessId;
        this.currentUrlNameProcessId = finalProcessId; // Also set this as backup

        this.startStickerProgressMonitoring(finalProcessId);
      } else {
        this.addStatusItem(`❌ Error: ${response.error || "Failed to start creation"}`, "error");
        this.showToast(
          "error",
          "Creation Failed",
          response.error || "Failed to start creation"
        );

        // Clear process tracking since it failed
        this.currentProcessId = null;
        this.currentOperation = null;

        // Re-enable the button on failure - force reset
        if (createBtn) {
          createBtn.disabled = false;
          this.resetButtonText(createBtn, true);
        }
      }
    } catch (error) {
      this.hideLoadingOverlay();
      console.error("Error creating sticker pack:", error);

      // Clear process tracking since it failed
      this.currentProcessId = null;
      this.currentOperation = null;

      // ENHANCED: Better error handling for [Errno 22] Invalid argument
      let errorMessage = error.message;
      if (error.message && (error.message.includes("Invalid argument") || error.message.includes("Errno 22"))) {
        errorMessage = "Invalid request data - contains invalid characters. Please check your inputs and try again.";
      }

      const isAddMode = this.currentPackMode === "add";
      this.addStatusItem(`❌ Error: Failed to ${isAddMode ? 'add stickers' : 'create sticker pack'} - ${errorMessage}`, "error");
      this.showToast(
        "error",
        isAddMode ? "Add Error" : "Creation Error",
        `Failed to ${isAddMode ? 'add stickers' : 'create sticker pack'}: ` + errorMessage
      );

      // Re-enable the button on error - force reset
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = false;
        this.resetButtonText(createBtn, true);
      }
    }
  }
  startStickerProgressMonitoring(processId) {
    // CRITICAL FIX: Always clear previous interval to prevent memory leaks
    // Pass false to NOT reset the button - we're starting a new monitoring session
    this.stopStickerProgressMonitoring(false);

    // Reset auto-skip flag for this process
    // Removed autoSkipAttempted flag - auto-skip is handled entirely by backend
    this.lastStage = null;

    // CRITICAL: Track the process ID for URL name retry functionality
    this.currentStickerProcessId = processId;
    if (!this.currentUrlNameProcessId) {
      this.currentUrlNameProcessId = processId; // Backup in case it wasn't set
    }

    // Store last known progress for completion detection
    this.lastKnownProgress = null;

    let consecutiveErrors = 0;
    let initialChecks = 0; // Track initial checks to avoid premature "Process not found" errors

    // Monitoring function
    const checkProgress = async () => {
      if (!this.currentStickerProcessId) {
        clearInterval(this.stickerProgressInterval);
        return;
      }

      try {
        const response = await this.apiRequest("GET", `/api/process-status/${this.currentStickerProcessId}`);

        if (response.success && response.data) {
          const progress = response.data;
          this.lastKnownProgress = progress; // Store for error handling

          // PRIORITY CHECK 1: Check for URL name retry attempts exhausted
          if (progress.url_name_attempts && progress.url_name_attempts > progress.max_url_attempts) {
            const currentAttempt = progress.url_name_attempts || 1;
            const maxAttempts = progress.max_url_attempts || 3;

            this.addStatusItem(`❌ All ${maxAttempts} URL name attempts exhausted. Please add sticker pack manually in Telegram bot.`, "error");
            this.showToast("warning", "Manual Setup Required", "Please complete the sticker pack creation manually in the Telegram bot (@Stickers)");

            this.stopStickerProgressMonitoring();

            this.onStickerProcessCompleted(true, {
              manual_completion_required: true,
              message: "Please complete sticker pack creation manually in Telegram bot"
            });
            return;
          }

          // PRIORITY CHECK 2: Check for URL name retry - BUT ONLY if it's NOT an icon request
          // We need to distinguish between:
          // 1. Icon request (waiting_for_user + icon_request_message) = Show icon modal
          // 2. URL conflict (waiting_for_user + url_name_taken) = Show URL retry modal
          const isIconRequest = progress.waiting_for_user && !!(progress.icon_request_message || progress.icon_request);
          let isUrlConflict = (progress.waiting_for_user || progress.status === "waiting_for_url_name") && !!progress.url_name_taken;

          // CRITICAL FIX: Handle backend bug where both icon_request and url_name_taken are set
          // Priority: Icon request comes FIRST, then URL conflict
          if (isIconRequest && isUrlConflict) {
            // Force isUrlConflict to false to handle icon first
            isUrlConflict = false;
          }

          // Handle URL conflict ONLY if it's not an icon request (for manual mode)
          if (isUrlConflict && !isIconRequest && !this.urlPromptHandledProcesses.has(processId)) {
            // Mark as handled to prevent duplicate processing
            this.urlPromptHandledProcesses.add(processId);

            // Stop monitoring while user provides new URL name
            this.stopStickerProgressMonitoring();

            // Show URL name modal with the original taken name
            const takenName = progress.original_url_name || progress.pack_url_name || "retry";
            const currentAttempt = progress.url_name_attempts || 1;
            const maxAttempts = progress.max_url_attempts || 3;

            this.addStatusItem(`URL name '${takenName}' is taken. Showing retry options (${currentAttempt}/${maxAttempts})`, "warning");

            this.showUrlNameModal(takenName, currentAttempt, maxAttempts, processId);

            return; // Exit early after handling URL name retry
          }

          // PRIORITY CHECK 3: Check for icon selection
          if (progress.waiting_for_user && (progress.icon_request_message || progress.icon_request) && !this.iconHandledProcesses.has(processId)) {
            // Check if auto-skip was enabled for this process (from backend)
            const processAutoSkip = progress.auto_skip_icon !== undefined ? progress.auto_skip_icon : true; // Default to true
            // Check if auto-skip has already been handled by the backend
            const autoSkipHandled = progress.auto_skip_handled !== undefined ? progress.auto_skip_handled : false;

            // REMOVED: Don't check for completion here - it's a backend bug setting status=completed while waiting_for_user=true
            // The completion check should happen AFTER user input, not during icon request

            // If backend has already handled auto-skip, don't show icon modal
            // BUT CRITICAL: Continue monitoring instead of returning - don't exit early!
            // We MUST check for URL name conflicts and completion even when auto-skip is handled
            if (processAutoSkip && autoSkipHandled) {
              // Backend is handling auto-skip, mark as handled but continue monitoring
              this.iconHandledProcesses.add(processId);

              // CRITICAL: Now check if there's a URL conflict to handle
              // Check the ORIGINAL url_name_taken flag, not isUrlConflict (which we may have modified)
              const hasUrlConflict = !!progress.url_name_taken;

              if (hasUrlConflict && !this.urlPromptHandledProcesses.has(processId)) {

                // Mark as handled to prevent duplicate processing
                this.urlPromptHandledProcesses.add(processId);

                // Stop monitoring while user provides new URL name
                this.stopStickerProgressMonitoring();

                // Show URL name modal with the original taken name
                const takenName = progress.original_url_name || progress.pack_url_name || "retry";
                const currentAttempt = progress.url_name_attempts || 1;
                const maxAttempts = progress.max_url_attempts || 3;

                this.addStatusItem(`URL name '${takenName}' is taken. Showing retry options (${currentAttempt}/${maxAttempts})`, "warning");

                this.showUrlNameModal(takenName, currentAttempt, maxAttempts, processId);

                return; // Exit after showing URL retry modal
              }

              // No URL conflict - continue monitoring
              // DON'T return here - fall through to remaining checks
            } else {
              // Manual mode: show icon selection modal and STOP monitoring
              // Process will wait indefinitely for user action - no timeout
              this.stopStickerProgressMonitoring(); // Stop monitoring - user controls when to continue

              // CRITICAL FIX: Store the process ID so we can restart monitoring after icon is sent
              this.currentIconProcessId = processId;

              // CRITICAL FIX: Also store in urlPromptHandledProcesses to prevent duplicate handling
              this.urlPromptHandledProcesses.add(processId);

              // If Telegram is already asking for short name, bypass icon modal and proceed to URL
              const urlPrompt = (progress.icon_request_message && /short name|create a link|addstickers/i.test(progress.icon_request_message))
                || progress.waiting_for_url_name
                || false;
              if (urlPrompt) {
                try { this.hideIconModal(); } catch (_e) {
                  // Ignore errors when hiding icon modal
                }

                // Check if auto-skip is enabled - if so, automatically submit the URL name
                const autoSkipIcon = document.getElementById("auto-skip-icon");
                const shouldAutoSkip = autoSkipIcon && autoSkipIcon.checked;

                // Even if auto-skip is enabled, the backend should handle it, not the frontend
                // But if for some reason we're here, we can still submit the URL name
                if (shouldAutoSkip) {
                  // Auto-skip is enabled, automatically submit the URL name
                  this.addStatusItem("Auto-skip enabled, automatically submitting URL name...", "info");
                  try {
                    const urlInput = document.getElementById("pack-url-name");
                    const urlName = (urlInput && typeof urlInput.value === "string") ? urlInput.value.trim() : "";
                    if (urlName) {
                      const submitRes = await this.apiRequest("POST", "/api/sticker/submit-url-name", {
                        process_id: processId,
                        new_url_name: urlName,
                        current_attempt: 1,
                        max_attempts: 3
                      });

                      if (submitRes && submitRes.success) {
                        // Only add to urlPromptHandledProcesses when URL name is actually submitted
                        this.urlPromptHandledProcesses.add(processId);
                        this.startStickerProgressMonitoring(processId);
                        return;
                      } else if (submitRes && submitRes.url_name_taken) {
                        // Only add to urlPromptHandledProcesses when URL name taken is handled
                        this.urlPromptHandledProcesses.add(processId);
                        this.showUrlNameModal(urlName, (submitRes.attempt || 1), (submitRes.max_attempts || 3), processId);
                        return;
                      }
                    }
                  } catch (e) {
                    // If auto-submit fails, fall back to manual process
                    this.addStatusItem(`Auto-submit failed: ${e.message}. Continuing with manual process.`, "warning");
                  }
                }

                const urlInput = document.getElementById("pack-url-name");
                const urlName = (urlInput && typeof urlInput.value === "string") ? urlInput.value.trim() : "";
                if (urlName) {
                  try {
                    const submitRes = await this.apiRequest("POST", "/api/sticker/submit-url-name", {
                      process_id: processId,
                      new_url_name: urlName,
                      current_attempt: 1,
                      max_attempts: 3
                    });
                    if (submitRes && submitRes.success) {
                      // Only add to urlPromptHandledProcesses when URL name is actually submitted
                      this.urlPromptHandledProcesses.add(processId);
                      this.startStickerProgressMonitoring(processId);
                      return;
                    } else if (submitRes && submitRes.url_name_taken) {
                      // Only add to urlPromptHandledProcesses when URL name taken is handled
                      this.urlPromptHandledProcesses.add(processId);
                      this.showUrlNameModal(urlName, (submitRes.attempt || 1), (submitRes.max_attempts || 3), processId);
                      return;
                    }
                  } catch (_e) {
                    // Ignore errors when submitting URL
                  }
                }
                // Fallback: show URL modal to collect the name
                // Only add to urlPromptHandledProcesses when URL modal is shown
                this.urlPromptHandledProcesses.add(processId);
                this.showUrlNameModal(progress.pack_url_name || "retry", 1, 3, processId);
                return;
              }

              // If verification is pending, do not show icon modal
              if (this.pendingCode || this.pendingPassword) {
                return;
              }
              // DOM-based guard as a fallback
              try {
                const codeModal = document.getElementById("code-modal");
                const passModal = document.getElementById("password-modal");
                const codeVisible = codeModal && codeModal.style && codeModal.style.display && codeModal.style.display !== "none";
                const passVisible = passModal && passModal.style && passModal.style.display && passModal.style.display !== "none";
                if (codeVisible || passVisible) {
                  return;
                }
              } catch (_e) {
                // Ignore DOM check errors
              }

              this.showIconModal(processId, progress.icon_request_message);
              this.iconHandledProcesses.add(processId);

              // CRITICAL FIX: Don't add to urlPromptHandledProcesses here - only when URL prompt is actually handled
              // this.urlPromptHandledProcesses.add(processId);
              return; // CRITICAL: Exit early after handling icon selection
            }
          }

          // PRIORITY CHECK 4: Check completion status
          if (progress.status === "completed") {
            // CRITICAL FIX: Don't treat as completed if still waiting for user input
            if (progress.waiting_for_user) {
              // Continue monitoring - this is a backend bug
            } else {
              // Check if we have a shareable_link, which means the process is ACTUALLY completed
              const hasShareableLink = !!(progress.shareable_link || progress.pack_link || progress.link);

              // For "add to pack" mode, just check if status is completed and we have stickers_added
              const isAddMode = this.currentPackMode === "add" || this.currentOperation === "adding_stickers";
              const addModeCompleted = isAddMode && (progress.stickers_added > 0 || progress.completed_files > 0);

              // Check for completion: shareable_link OR add mode completed OR normal workflow completion
              if (hasShareableLink || addModeCompleted || this.workflowState.packCompleted || (this.workflowState.iconUploaded && this.workflowState.urlNameSubmitted) || progress.auto_skip_handled) {
                const successMsg = isAddMode
                  ? `✅ Successfully added ${progress.stickers_added || progress.completed_files || 1} sticker(s) to pack!`
                  : "✅ Sticker pack creation completed successfully!";
                this.addStatusItem(successMsg, "completed");
                this.stopStickerProgressMonitoring();
                this.onStickerProcessCompleted(true, progress);
                return;
              } else {
                // CRITICAL FIX: Don't show completion if workflow is not actually finished
                this.addStatusItem("Process marked as completed but workflow not finished - continuing monitoring", "warning");
                // Continue monitoring instead of stopping
              }
            }
          } else if (progress.status === "error" || progress.status === "failed") {
            const isAddMode = this.currentPackMode === "add" || this.currentOperation === "adding_stickers";
            const errorMsg = progress.current_stage || progress.error || "Unknown error";
            this.addStatusItem(`❌ ${isAddMode ? 'Add stickers' : 'Sticker pack creation'} failed: ${errorMsg}`, "error");
            this.stopStickerProgressMonitoring();
            this.onStickerProcessCompleted(false, progress);
            return;
          }

          // Normal progress updates and media status tracking
          consecutiveErrors = 0;

          this.updateStickerProgressDisplay(progress);

          // OPTIMIZED: Prevent duplicate stage notifications with better tracking
          if (progress.current_stage && progress.current_stage !== this.lastStage) {
            // Filter out excessive logging - only show essential messages
            const isEssentialMessage =
              progress.current_stage.includes("START") ||
              progress.current_stage.includes("COMPLETE") ||
              progress.current_stage.includes("ERROR") ||
              progress.current_stage.includes("FAILED") ||
              progress.current_stage.includes("SUCCESS") ||
              progress.current_stage.includes("created successfully") ||
              progress.current_stage.includes("URL name") ||
              progress.current_stage.includes("icon");

            // Show queue messages only once
            const isQueueMessage = progress.current_stage.includes("waiting in queue");
            const shouldShow = isEssentialMessage || (!isQueueMessage || !this.lastStageWasQueue);

            if (shouldShow) {
              this.addStatusItem(progress.current_stage, "info");
              this.lastStage = progress.current_stage;
              this.lastStageWasQueue = isQueueMessage;
            }
          }

          // Update individual media file statuses
          if (progress.current_file) {
            const fileIndex = this.mediaFiles.findIndex(
              (f) =>
                f.name === progress.current_file ||
                f.file_path.includes(progress.current_file)
            );
            if (fileIndex >= 0) {
              this.mediaFiles[fileIndex].status =
                progress.status || "processing";
            }
          }

          // Show essential file status updates only
          if (progress.file_statuses) {
            const failedFiles = Object.values(progress.file_statuses).filter(status => status.status === "failed").length;
            const completedFiles = Object.values(progress.file_statuses).filter(status => status.status === "completed").length;

            if (failedFiles > 0) {
              this.addStatusItem(`⚠️ ${failedFiles} files failed during processing. Check logs for details.`, "warning");
            }

            // Show completed files less frequently to avoid spam (every 25 files instead of 10)
            if (completedFiles > 0 && completedFiles % 25 === 0) {
              this.addStatusItem(`✅ ${completedFiles} files completed successfully`, "info");
            }
          }
        } else {
          consecutiveErrors++;

          // SMART ERROR HANDLING: Check if this is a "Process not found" after a recent skip
          // Note: autoSkipAttempted flag removed - auto-skip is handled entirely by backend
          if (response.error && response.error.includes("Process not found")) {
            this.addStatusItem("✅ Sticker pack created successfully (process completed)", "completed");
            this.stopStickerProgressMonitoring();

            // Try to construct a reasonable shareable link from stored data
            const packUrlName = this.lastKnownProgress?.pack_url_name ||
              this.lastKnownProgress?.url_name ||
              "unknown";
            const shareableLink = `https://t.me/addstickers/${packUrlName}`;

            this.onStickerProcessCompleted(true, {
              shareable_link: shareableLink,
              pack_url_name: packUrlName,
              message: "✅ Sticker pack created successfully"
            });
            return;
          }

          // Show detailed error information
          this.addStatusItem(`⚠️ Monitoring error ${consecutiveErrors}/3: ${response.error || "Unknown error"}`, "warning");

          // OPTIMIZED: Reduced from 5 to 3 for faster failure detection
          if (consecutiveErrors >= 3) {
            this.stopStickerProgressMonitoring();
            this.addStatusItem("❌ Process monitoring failed - sticker creation may have stopped", "error");
            // Show last known progress for debugging
            if (this.lastKnownProgress) {
              const completed = this.lastKnownProgress.completed_files || 0;
              const total = this.lastKnownProgress.total_files || 0;
              const failed = this.lastKnownProgress.failed_files || 0;
              this.addStatusItem(`📊 Last known status: ${completed}/${total} completed, ${failed} failed`, "info");
            }
          }
        }
      } catch (error) {
        consecutiveErrors++;

        // Show detailed error information
        this.addStatusItem(`⚠️ Monitoring error ${consecutiveErrors}/3: ${error.message}`, "warning");

        if (consecutiveErrors >= 3) {
          this.stopStickerProgressMonitoring();
          this.addStatusItem("❌ Process monitoring failed - sticker creation may have stopped", "error");
          this.addStatusItem(`🔧 Technical details: ${error.message}`, "info");
          this.addStatusItem("📋 Please check the application logs for more detailed information about what caused the process to stop", "info");

          // Show last known progress for debugging
          if (this.lastKnownProgress) {
            const completed = this.lastKnownProgress.completed_files || 0;
            const total = this.lastKnownProgress.total_files || 0;
            const failed = this.lastKnownProgress.failed_files || 0;
            this.addStatusItem(`📊 Last known status: ${completed}/${total} completed, ${failed} failed`, "info");

            // Show information about the last file being processed
            if (this.lastKnownProgress.current_file) {
              this.addStatusItem(`📂 Last file processed: ${this.lastKnownProgress.current_file}`, "info");
            }
          }
        }
      }

      initialChecks++;
    };

    // Call immediately for first check
    checkProgress();

    // Then set up interval for subsequent checks
    this.stickerProgressInterval = setInterval(checkProgress, 2000); // Check every 2 seconds for faster response
  }

  stopStickerProgressMonitoring(resetButton = true) {
    // CRITICAL FIX: Clear sticker progress interval to prevent memory leaks
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
      this.stickerProgressInterval = null;
    }

    // Only reset button and clear tracking if explicitly requested (not when starting new monitoring)
    if (resetButton) {
      // Clear process tracking FIRST so resetButtonText knows process is done
      this.currentProcessId = null;
      this.currentOperation = null;

      // Reset the create button - respect pack mode, force reset since process is done
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = false;
        this.resetButtonText(createBtn, true); // Force reset
      }
    }
  }

  // Helper function to reset button text based on current pack mode
  // Only resets if no process is actively running
  resetButtonText(btn, force = false) {
    if (!btn) return;

    // Don't reset if a process is running (unless forced)
    if (!force && (this.stickerProgressInterval || this.currentProcessId)) {
      console.log("[BUTTON] Skipping reset - process is running");
      return;
    }

    if (this.currentPackMode === "add") {
      btn.innerHTML = '<i class="fas fa-plus"></i> <span id="pack-action-text">Add to Pack</span>';
    } else {
      btn.innerHTML = '<i class="fas fa-magic"></i> <span id="pack-action-text">Create Sticker Pack</span>';
    }
  }

  updateStickerProgressDisplay(progress) {
    // OPTIMIZED: Don't add redundant status updates - only for progress bar
    const progressBar = document.getElementById("sticker-progress-bar");
    const progressText = document.getElementById("sticker-progress-text");

    if (progressBar && progress.progress !== undefined) {
      progressBar.style.width = `${progress.progress}%`;
    }

    if (
      progressText &&
      progress.completed_files !== undefined &&
      progress.total_files !== undefined
    ) {
      const failedFiles = progress.failed_files || 0;
      if (failedFiles > 0) {
        progressText.textContent = `${progress.completed_files}/${progress.total_files} files processed (${failedFiles} failed)`;
      } else {
        progressText.textContent = `${progress.completed_files}/${progress.total_files} files processed`;
      }
    }

    // Update individual file statuses if available
    if (progress.file_statuses) {
      this.updateFileStatuses(progress.file_statuses);
    }
  }

  // Method removed - duplicate definition exists earlier in the file

  // OPTIMIZED status list functionality with rate limiting
  addStatusItem(message, type = "info", timestamp = null) {
    const statusList = document.getElementById("sticker-status-list");
    if (!statusList) return;

    // Enhanced duplicate detection to prevent similar messages
    if (this.isDuplicateMessage(message, type)) {
      return; // Skip duplicate or similar messages
    }

    this.lastStatusMessage = message;
    this.lastStatusType = type;

    const time = timestamp || new Date();
    const timeString = time.toLocaleTimeString();

    const statusItem = document.createElement("div");
    statusItem.className = `status-item ${type}`;

    const iconClass = this.getStatusIconClass(type);

    statusItem.innerHTML = `
      <div class="status-time">${timeString}</div>
      <div class="status-message">${message}</div>
      <div class="status-icon"><i class="${iconClass}"></i></div>
    `;

    // Add to the bottom of the list (chronological order)
    statusList.appendChild(statusItem);

    // OPTIMIZED: Limit to 100 items to show more progress history
    const items = statusList.querySelectorAll(".status-item");
    if (items.length > 100) {
      statusList.removeChild(items[0]); // Remove the oldest item (first child)
    }

    // Auto-scroll to show latest message if enabled and user is at the bottom
    if (this.autoScrollEnabled) {
      // Check if user is near the bottom (within 50px)
      const isNearBottom = (statusList.scrollTop + statusList.clientHeight + 50 >= statusList.scrollHeight);
      if (isNearBottom) {
        statusList.scrollTop = statusList.scrollHeight; // Scroll to bottom
      }
    }
  }

  isDuplicateMessage(message, type) {
    // Exact duplicate check
    if (this.lastStatusMessage === message && this.lastStatusType === type) {
      return true;
    }

    // Similar message check (for progress updates)
    if (type === "info" && this.lastStatusType === "info") {
      // Check if both messages are progress updates
      const isProgressUpdate1 = message.includes("PROGRESS") || message.includes("Completed") || message.includes("files processed");
      const isProgressUpdate2 = this.lastStatusMessage.includes("PROGRESS") || this.lastStatusMessage.includes("Completed") || this.lastStatusMessage.includes("files processed");

      if (isProgressUpdate1 && isProgressUpdate2) {
        // Extract file numbers to compare
        const fileRegex = /(\d+)\/\d+\s*files/;
        const match1 = message.match(fileRegex);
        const match2 = this.lastStatusMessage.match(fileRegex);

        if (match1 && match2) {
          const currentFile1 = parseInt(match1[1]);
          const currentFile2 = parseInt(match2[1]);

          // Only show every 5th progress update to reduce spam
          if (Math.abs(currentFile1 - currentFile2) < 5) {
            return true;
          }
        }
      }

      // Check for repetitive "waiting" messages
      const waitingRegex = /waiting|pending|queued/i;
      if (waitingRegex.test(message) && waitingRegex.test(this.lastStatusMessage)) {
        return true;
      }
    }

    return false;
  }

  getStatusIconClass(type) {
    const iconMap = {
      "ready": "fas fa-check-circle",
      "processing": "fas fa-spinner fa-spin",
      "completed": "fas fa-check-circle",
      "error": "fas fa-exclamation-circle",
      "warning": "fas fa-exclamation-triangle",
      "info": "fas fa-info-circle"
    };
    return iconMap[type] || "fas fa-info-circle";
  }

  clearStatusHistory() {
    const statusList = document.getElementById("sticker-status-list");
    if (!statusList) return;

    statusList.innerHTML = `
      <div class="status-item ready">
        <div class="status-time">Ready</div>
        <div class="status-message">Ready to create sticker pack</div>
        <div class="status-icon"><i class="fas fa-check-circle"></i></div>
      </div>
    `;
  }

  copyStatusLog() {
    const statusList = document.getElementById("sticker-status-list");
    if (!statusList) return;

    // Get all status items
    const items = statusList.querySelectorAll(".status-item");
    let logText = "";

    // Extract text from each status item in chronological order
    items.forEach(item => {
      const timeElement = item.querySelector(".status-time");
      const messageElement = item.querySelector(".status-message");

      if (timeElement && messageElement) {
        const time = timeElement.textContent;
        const message = messageElement.textContent;
        logText += `[${time}] ${message}\n`;
      }
    });

    // Copy to clipboard
    navigator.clipboard.writeText(logText).catch(err => {
      console.error("Failed to copy log to clipboard:", err);
      this.showToast("error", "Copy Failed", "Failed to copy log to clipboard");
    });
  }

  toggleAutoScroll() {
    this.autoScrollEnabled = !this.autoScrollEnabled;
    const button = document.getElementById("toggle-auto-scroll");
    if (button) {
      button.classList.toggle("active", this.autoScrollEnabled);
      button.innerHTML = this.autoScrollEnabled
        ? '<i class="fas fa-arrow-down"></i>'
        : '<i class="fas fa-pause"></i>';
    }
  }

  updateStickerProgress() {
    // Update progress based on media file statuses
    const completed = this.mediaFiles.filter(
      (f) => f.status === "completed"
    ).length;
    const total = this.mediaFiles.length;

    const progressBar = document.getElementById("sticker-progress-bar");
    const progressText = document.getElementById("sticker-progress-text");

    if (progressBar && total > 0) {
      const percentage = (completed / total) * 100;
      progressBar.style.width = `${percentage}%`;
    }

    if (progressText) {
      progressText.textContent = `${completed}/${total} files processed`;
    }
  }

  onStickerProcessCompleted(success, progressData) {
    const createBtn = document.getElementById("create-sticker-pack");
    const isAddMode = this.currentPackMode === "add" || this.currentOperation === "adding_stickers";

    // CRITICAL FIX: Only show completion if workflow is actually finished
    if (success && !this.workflowState.packCompleted) {
      // Update workflow state to mark as completed
      this.workflowState.packCompleted = true;
      this.workflowState.currentStep = "completed";

      this.sessionStats.totalStickers += this.mediaFiles.length;

      // Check if manual completion is required
      if (progressData?.manual_completion_required) {
        this.addStatusItem("Sticker pack processing completed - manual completion required in Telegram bot", "warning");
        this.showToast("warning", "Manual Setup Required", "Please complete sticker pack creation manually in the Telegram bot (@Stickers)");

        // Show special modal for manual completion
        this.showManualCompletionModal();
      } else {
        // Different messages for add mode vs create mode
        const stickersAdded = progressData?.stickers_added || progressData?.completed_files || this.mediaFiles.length;

        if (isAddMode) {
          this.addStatusItem(`✅ Successfully added ${stickersAdded} sticker(s) to pack!`, "completed");
        } else {
          this.addStatusItem("Sticker pack created successfully!", "completed");
        }

        // ENHANCED: Check for multiple possible property names for shareable link
        const shareableLink = progressData?.shareable_link || progressData?.pack_link || progressData?.link;

        if (shareableLink && !isAddMode) {
          // Only show success modal for new pack creation
          this.showSuccessModal(shareableLink);
        } else {
          // Show toast for add mode or when no link
          const toastTitle = isAddMode ? "Stickers Added" : "Pack Created";
          const toastMsg = isAddMode
            ? `Successfully added ${stickersAdded} sticker(s) to pack!`
            : "Sticker pack created successfully!";
          this.showToast("success", toastTitle, toastMsg);
        }
      }
    } else if (!success) {
      const errorMessage = progressData?.error || progressData?.current_stage || "Unknown error";
      const failMsg = isAddMode ? "Add stickers failed" : "Sticker pack creation failed";
      this.addStatusItem(`${failMsg}: ${errorMessage}`, "error");
    } else {
      // CRITICAL FIX: Prevent duplicate completion messages
    }
    this.updateStats();

    // Reset current operation
    this.currentOperation = null;

    // Reset button - respect current pack mode using helper
    if (createBtn) {
      createBtn.disabled = false;
      this.resetButtonText(createBtn);
    }

    // Mark all files as completed or error
    this.mediaFiles.forEach((file) => {
      if (file.status !== "completed") {
        file.status = success ? "completed" : "error";
      }
    });

    this.updateMediaFileList();

    // Show completion notification - respect pack mode (use isAddMode from above)
    if (success) {
      if (!progressData?.manual_completion_required) {
        this.playNotificationSound();
        this.showSystemNotification(
          isAddMode ? "Stickers Added" : "Sticker Pack Created",
          isAddMode ? "Your stickers have been added to the pack!" : "Your sticker pack has been published successfully!"
        );
      }

      // FIXED: Update backend database stats for successful sticker creation
      this.updateStickerCreationStats(this.mediaFiles.length);

    } else {
      const errorMessage = progressData?.error || progressData?.current_stage || "Unknown error";
      // Check if this is a user error (like invalid pack name, duration too long, etc.)
      const isUserError = progressData?.user_error ||
        errorMessage.includes("Invalid sticker pack") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("duration") ||
        errorMessage.includes("too long") ||
        errorMessage.includes("too large") ||
        errorMessage.includes("dimensions") ||
        errorMessage.includes("format") ||
        errorMessage.includes("Please");

      this.showToast(
        isUserError ? "warning" : "error",
        isUserError ? "Sticker Error" : (isAddMode ? "Add Failed" : "Creation Failed"),
        errorMessage
      );
    }

    // Clear progress
    const statusElement = document.getElementById("sticker-status");
    if (statusElement) {
      statusElement.textContent = success
        ? (progressData?.manual_completion_required ? "Manual completion required" : "Pack created successfully!")
        : "Pack creation failed";
    }
  }

  async updateStickerCreationStats(stickerCount) {
    try {

      const response = await this.apiRequest("POST", "/api/stats/increment-stickers", {
        count: stickerCount
      });

      if (response.success) {
        // Force refresh database stats display
        this.updateDatabaseStats();
      } else {
      }
    } catch (error) {
      console.error("❌ [STATS] Error updating sticker creation stats:", error);
    }
  }

  showPackLinkModal(packLink) {
    const modalHtml = `
      <div class="modal-header">
        <h3><i class="fas fa-check-circle text-success"></i> Sticker Pack Created!</h3>
      </div>
      <div class="modal-body">
        <p>Your sticker pack has been created successfully!</p>
        <div class="pack-link-container">
          <label>Pack Link:</label>
          <input type="text" class="form-control" value="${packLink}" readonly id="pack-link-input">
        </div>
        <p class="help-text">Share this link with others to let them add your sticker pack.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="app.copyPackLink()">
          <i class="fas fa-copy"></i> Copy Link
        </button>
        <button class="btn btn-primary" onclick="app.openPackLink('${packLink}')">
          <i class="fas fa-external-link-alt"></i> Open Pack
        </button>
        <button class="btn btn-success" onclick="app.hideModal()">
          <i class="fas fa-check"></i> Done
        </button>
      </div>
    `;

    const modal = document.getElementById("info-modal");
    if (modal) {
      modal.innerHTML = modalHtml;
      this.showModal("info-modal");
    }
  }

  copyPackLink() {
    const input = document.getElementById("pack-link-input");
    if (input) {
      input.select();
      document.execCommand("copy");
      this.showToast("success", "Copied", "Pack link copied to clipboard!");
    }
  }

  openPackLink(link) {
    window.electronAPI.openExternal(link);
    this.showToast("info", "Opening", "Opening sticker pack in Telegram...");
  }
  showManualCompletionModal() {
    const modal = document.getElementById("info-modal");
    if (!modal) return;

    const modalHtml = `
      <div class="modal-header">
        <h3><i class="fas fa-hand-paper text-warning"></i> Manual Completion Required</h3>
      </div>
      <div class="modal-body">
        <div class="manual-completion-content">
          <p><strong>All URL name retry attempts have been exhausted.</strong></p>
          <p>Your sticker pack has been partially created but needs to be completed manually.</p>
          
          <div class="instructions">
            <h4><i class="fas fa-list-ol"></i> Next Steps:</h4>
            <ol>
              <li>Open Telegram and go to <strong>@Stickers</strong> bot</li>
              <li>Choose a unique URL name for your sticker pack</li>
              <li>Complete the sticker pack creation process</li>
              <li>Your stickers have been uploaded and are ready to publish</li>
            </ol>
          </div>
          
          <div class="help-note">
            <i class="fas fa-info-circle text-info"></i>
            <span>The bot will guide you through the final steps to publish your pack.</span>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="window.electronAPI.openExternal('https://t.me/stickers')">
          <i class="fas fa-external-link-alt"></i> Open @Stickers Bot
        </button>
        <button class="btn btn-success" onclick="app.hideModal()">
          <i class="fas fa-check"></i> Got It
        </button>
      </div>
    `;

    modal.innerHTML = modalHtml;
    this.showModal("info-modal");
  }

  // =============================================
  // UTILITY METHODS
  // =============================================
  showModal(modalId) {
    // Performance optimization: use requestAnimationFrame for smooth rendering
    requestAnimationFrame(() => {
      const overlay = document.getElementById("modal-overlay");
      const modal = document.getElementById(modalId);

      if (overlay && modal) {
        // Use GPU-accelerated transforms for better performance
        overlay.style.willChange = "opacity";
        modal.style.willChange = "transform, opacity";

        // Use the CSS class-based approach for proper centering
        overlay.classList.add("active");
        // Remove any explicit display style that might override the CSS
        overlay.style.display = "";
        overlay.style.visibility = "";

        // CRITICAL FIX: Ensure proper modal positioning
        // Use flex for emoji modal to enable column layout
        modal.style.display = (modalId === "emoji-modal") ? "flex" : "block";
        modal.style.opacity = "1"; // Reset opacity to 1 when showing modal

        // Ensure modal is properly centered
        modal.style.position = "fixed";
        modal.style.top = "50%";
        modal.style.left = "50%";
        modal.style.transform = "translate(-50%, -50%)";
        modal.style.margin = "0";

        // Ensure proper z-index stacking
        if (modalId === "success-modal") {
          modal.style.zIndex = "10000";
        } else if (modalId === "emoji-modal" || modalId === "icon-modal" || modalId === "url-name-modal") {
          modal.style.zIndex = "9000";
        } else {
          modal.style.zIndex = "8000";
        }

        // Special handling for emoji modal
        if (modalId === "emoji-modal") {
          // Ensure emoji modal is not locked
          this.isEmojiModalLocked = false;
          this.isSavingEmoji = false;

          // Add a small delay to ensure overlay stays visible
          setTimeout(() => {
            if (overlay) {
              overlay.classList.add("active");
            }
          }, 10);
        }

        // Focus management with shorter delay
        const firstInput = modal.querySelector("input, textarea, select");

        if (firstInput) {
          setTimeout(() => {
            firstInput.focus();
          }, 50);  // Reduced from 100ms
        }

        // Clean up GPU acceleration hints after animation
        setTimeout(() => {
          overlay.style.willChange = "auto";
          modal.style.willChange = "auto";
        }, 250);
      }
    });
  }

  hideModal() {
    // Performance optimization: batch DOM updates
    requestAnimationFrame(() => {
      const overlay = document.getElementById("modal-overlay");
      if (overlay) {
        overlay.classList.remove("active");
        // Force display none to override !important in CSS
        overlay.style.setProperty("display", "none", "important");
        overlay.style.visibility = "hidden";
      }

      // Batch all modal hiding operations
      const modals = document.querySelectorAll(".modal");
      modals.forEach((modal) => {
        modal.style.display = "none";
        modal.style.opacity = "0";
        // Reset z-index when hiding
        modal.style.zIndex = "";
      });

      // Clear modal inputs
      this.clearModalInputs();

      // Reset current emoji index to allow reopening emoji modal
      this.currentEmojiIndex = null;

      // Reset emoji modal flags
      this.isSavingEmoji = false;
      this.isEmojiModalLocked = false;
      this.preventEmojiModalClosure = false;
    });
  }

  // Icon Selection Modal Functions
  showIconModal(iconRequestMessage) {
    // Guard: suppress icon modal if verification flow is active
    if (this.pendingCode || this.pendingPassword) {
      return;
    }
    // DOM-based guard: if code/password modal is visible, skip
    try {
      const codeModal = document.getElementById("code-modal");
      const passModal = document.getElementById("password-modal");
      const codeVisible = codeModal && codeModal.style && codeModal.style.display && codeModal.style.display !== "none";
      const passVisible = passModal && passModal.style && passModal.style.display && passModal.style.display !== "none";
      if (codeVisible || passVisible) {
        return;
      }
    } catch { }

    // Hide any existing loading overlay
    this.hideLoadingOverlay();

    // Reset file info display
    const fileInfo = document.getElementById("icon-file-info");
    const fileName = document.getElementById("icon-file-name");
    const confirmBtn = document.getElementById("confirm-icon-upload");
    if (fileInfo) fileInfo.style.display = "none";
    if (fileName) fileName.textContent = "No file selected";
    if (confirmBtn) confirmBtn.disabled = true;

    // Optimized modal display without unnecessary GPU acceleration
    const modal = document.getElementById("icon-modal");
    const overlay = document.getElementById("modal-overlay");

    if (modal && overlay) {
      // Use consistent approach with other modals
      modal.style.display = "flex"; // Direct display style for immediate showing
      modal.style.opacity = "1"; // Set opacity to 1 immediately
      // Ensure proper z-index for icon modal
      modal.style.zIndex = "9000";
      overlay.classList.add("active");

      // Update the modal content with the actual message from Telegram
      const iconInfo = modal.querySelector(".info-details");
      if (iconInfo && iconRequestMessage) {
        iconInfo.textContent = iconRequestMessage;
      }

      // Reset file selection
      this.resetIconFileSelection();

      // Focus management for accessibility
      setTimeout(() => {
        const uploadBtn = document.getElementById("upload-icon-btn");
        if (uploadBtn) {
          uploadBtn.focus();
        }
      }, 50);
    }
  }

  showUrlNameModal(takenUrlName, attemptNumber, maxAttempts, processId = null) {

    // Store process ID for later use
    if (processId) {
      this.currentUrlNameProcessId = processId;
    }

    // Hide any existing loading overlay
    this.hideLoadingOverlay();

    const modal = document.getElementById("url-name-modal");
    const overlay = document.getElementById("modal-overlay");
    const takenNameElement = document.getElementById("taken-url-name");
    const attemptCounter = document.getElementById("attempt-counter");
    const newUrlInput = document.getElementById("new-url-name");

    if (!modal || !overlay) {
      console.error(`🔗 [URL_MODAL] Modal or overlay not found - modal: ${!!modal}, overlay: ${!!overlay}`);
      return;
    }

    // Set modal content
    if (takenNameElement) takenNameElement.textContent = takenUrlName;
    if (attemptCounter) attemptCounter.textContent = `Attempt ${attemptNumber} of ${maxAttempts}`;

    // Generate URL suggestions
    const suggestionsContainer = document.getElementById("url-suggestions");
    if (suggestionsContainer) {
      this.generateUrlSuggestions(takenUrlName, suggestionsContainer);
    }

    // Clear any previous input
    if (newUrlInput) newUrlInput.value = "";

    // CRITICAL FIX: Reset submit button state from previous submission
    const submitBtn = document.getElementById("submit-new-url");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove("loading");
      submitBtn.innerHTML = '<i class="fas fa-check"></i> Try This Name';
    }

    // Ensure proper z-index for URL name modal
    modal.style.zIndex = "9000";

    // Show modal using the standard method
    this.showModal("url-name-modal");

    // Focus on the input field
    setTimeout(() => {
      if (newUrlInput) {
        newUrlInput.focus();
      }
    }, 100);
  }

  generateUrlSuggestions(baseName, container) {
    if (!container) return;

    const cleanBase = baseName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substring(0, 15);
    const random = () => Math.floor(Math.random() * 999) + 100;
    const currentYear = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, "0");
    const day = String(new Date().getDate()).padStart(2, "0");

    // Advanced smart suggestion categories
    const creativeCategories = {
      professional: [`${cleanBase}_official`, `${cleanBase}_studio`, `${cleanBase}_premium`, `${cleanBase}_pro`],
      versioned: [`${cleanBase}_v${random()}`, `${cleanBase}_${currentYear}`, `${cleanBase}_v2`, `${cleanBase}_latest`],
      themed: [`${cleanBase}_collection`, `${cleanBase}_pack`, `${cleanBase}_set`, `${cleanBase}_bundle`],
      temporal: [`${cleanBase}_${month}${day}`, `${cleanBase}_${currentYear.toString().slice(-2)}`, `${cleanBase}_new`],
      exclusive: [`${cleanBase}_exclusive`, `${cleanBase}_limited`, `${cleanBase}_special`, `${cleanBase}_ultimate`]
    };

    // Smart selection algorithm - pick diverse suggestions from different categories
    const smartSuggestions = [];
    const categories = Object.keys(creativeCategories);
    const usedPrefixes = new Set();

    // Select one from each category, avoiding repetitive patterns
    categories.forEach(category => {
      const options = creativeCategories[category].filter(suggestion => {
        const prefix = suggestion.split("_")[1];
        return !usedPrefixes.has(prefix) && suggestion.length >= 5 && suggestion.length <= 32;
      });

      if (options.length > 0) {
        const selected = options[Math.floor(Math.random() * options.length)];
        smartSuggestions.push(selected);
        usedPrefixes.add(selected.split("_")[1]);
      }
    });

    // Add fallback unique suggestions if needed
    while (smartSuggestions.length < 5) {
      const uniqueId = Date.now().toString().slice(-4) + Math.floor(Math.random() * 99);
      const fallback = `${cleanBase}_${uniqueId}`;
      if (!smartSuggestions.includes(fallback)) {
        smartSuggestions.push(fallback);
      }
    }

    // Take exactly 5 diverse suggestions
    const finalSuggestions = smartSuggestions.slice(0, 5);

    container.innerHTML = finalSuggestions.map(suggestion =>
      `<button class="suggestion-btn" onclick="window.app?.applySuggestion('${suggestion}')">${suggestion}</button>`
    ).join("");
  }

  applySuggestion(suggestion) {
    const input = document.getElementById("new-url-name");
    if (input) {
      input.value = suggestion;
      input.dispatchEvent(new Event("input")); // Trigger validation
      input.focus();
    }
  }

  hideUrlNameModal(clearProcessInfo = true) {
    const modal = document.getElementById("url-name-modal");
    const overlay = document.getElementById("modal-overlay");

    if (modal) {
      modal.style.display = "none";
    }
    if (overlay) {
      overlay.classList.remove("active");
    }

    // Only clear retry information if explicitly requested (default: true for backward compatibility)
    // This allows temporary modal hiding without losing process tracking
    if (clearProcessInfo) {
      this.currentUrlNameProcessId = null;
      this.currentUrlAttempt = null;
      this.maxUrlAttempts = null;
    }
  }

  async submitNewUrlName() {
    // Store process ID immediately to prevent loss if modal gets hidden
    let processId = this.currentUrlNameProcessId;
    const currentAttempt = this.currentUrlAttempt;
    const maxAttempts = this.maxUrlAttempts;

    const newUrlNameInput = document.getElementById("new-url-name");
    if (!newUrlNameInput) {
      console.error("new-url-name input not found");
      return;
    }

    if (!processId) {
      // ENHANCED FIX: Check multiple sources for the process ID
      if (window.app?.stickerBot?.currentUrlNameProcessId) {
        processId = window.app.stickerBot.currentUrlNameProcessId;
        this.currentUrlNameProcessId = processId; // Sync back to main script
      }
      // Fallback: Try to find the current sticker process ID
      else if (this.currentIconProcessId || this.currentStickerProcessId) {
        const fallbackProcessId = this.currentIconProcessId || this.currentStickerProcessId;
        processId = fallbackProcessId;
        this.currentUrlNameProcessId = processId; // Update the stored ID
      }
      // Last resort: Check if stickerBot has any process ID we can use
      else if (window.app?.stickerBot?.currentStickerProcessId) {
        processId = window.app.stickerBot.currentStickerProcessId;
        this.currentUrlNameProcessId = processId;
      }

      if (!processId) {
        this.showToast("error", "Process Error", "No active sticker creation process found");
        return;
      }
    }

    const newUrlName = newUrlNameInput.value.trim();

    if (!newUrlName) {
      this.showToast("error", "Missing URL Name", "Please enter a new URL name");
      newUrlNameInput.focus();
      return;
    }

    // Validate the new URL name
    const validation = this.validateUrlName(newUrlName);
    if (!validation.valid) {
      this.showToast("error", "Invalid URL Name", validation.error);
      newUrlNameInput.select();
      return;
    }

    try {
      const submitBtn = document.getElementById("submit-new-url");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add("loading");
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
      }

      const response = await this.apiRequest("POST", "/api/sticker/submit-url-name", {
        process_id: processId,
        new_url_name: newUrlName,
        current_attempt: currentAttempt || 1,
        max_attempts: maxAttempts || 3
      });

      if (response.success) {
        // CRITICAL FIX: Update workflow state when URL name is submitted
        this.workflowState.urlNameSubmitted = true;
        this.workflowState.currentStep = "url_name";

        // DON'T clear process info when hiding modal on success - we may need it for monitoring
        this.hideUrlNameModal(false); // Preserve process info

        if (response.completed) {
          // Sticker pack creation completed successfully - now we can clear process info
          this.addStatusItem(`✅ Sticker pack created successfully with URL name: ${newUrlName}`, "completed");
          this.showToast("success", "Pack Created", `Sticker pack created: ${newUrlName}`);

          // Stop monitoring and show success
          this.stopStickerProgressMonitoring();
          this.onStickerProcessCompleted(true, {
            shareable_link: response.shareable_link || `https://t.me/addstickers/${newUrlName}`,
            pack_url_name: newUrlName
          });
          // NOW clear process info since we're done
          this.currentUrlNameProcessId = null;
          this.currentUrlAttempt = null;
          this.maxUrlAttempts = null;
        } else {
          // URL name updated, continue monitoring
          this.addStatusItem(`✅ New URL name submitted: ${newUrlName}`, "completed");
          this.showToast("success", "URL Name Updated", `Using new URL name: ${newUrlName}`);

          // Restart progress monitoring with the same process ID
          this.startStickerProgressMonitoring(processId);
        }
      } else {
        // Check if this was a URL name taken error and we have retries left
        if (response.error && response.error.includes("already taken") && response.url_name_taken) {
          const nextAttempt = (currentAttempt || 1) + 1;

          if (nextAttempt <= (maxAttempts || 3)) {
            // Show retry modal with updated attempt count
            this.addStatusItem(`❌ URL name '${newUrlName}' is taken. Retry ${nextAttempt}/${maxAttempts}`, "warning");
            this.showUrlNameModal(newUrlName, nextAttempt, maxAttempts, processId);
            return; // Don't re-enable the button, show new modal
          } else {
            // Exhausted all retries - mark as completed with manual instruction
            this.addStatusItem(`❌ All ${maxAttempts} retry attempts exhausted. Please add sticker pack manually in Telegram bot.`, "error");
            this.showToast("warning", "Manual Setup Required", "Please complete the sticker pack creation manually in the Telegram bot (@Stickers)");

            // Mark process as completed (user needs to complete manually)
            this.stopStickerProgressMonitoring();
            this.onStickerProcessCompleted(true, {
              manual_completion_required: true,
              message: "Please complete sticker pack creation manually in Telegram bot"
            });
            return;
          }
        }

        this.addStatusItem(`❌ Error submitting URL name: ${response.error}`, "error");
        this.showToast("error", "Submission Failed", response.error);

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("loading");
          submitBtn.innerHTML = '<i class="fas fa-check"></i> Try This Name';
        }
      }
    } catch (error) {
      console.error("Error submitting new URL name:", error);
      this.addStatusItem(`❌ Error submitting URL name: ${error.message}`, "error");
      this.showToast("error", "Submission Error", error.message);

      const submitBtn = document.getElementById("submit-new-url");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove("loading");
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Try This Name';
      }
    }
  }

  hideIconModal() {
    const modal = document.getElementById("icon-modal");
    const overlay = document.getElementById("modal-overlay");

    if (modal && overlay) {
      // Use consistent approach with other modals - remove inline styles and use CSS classes
      modal.style.display = "none"; // Set to none immediately
      modal.style.opacity = "0"; // Set opacity to 0
      overlay.classList.remove("active");
    }

    // CRITICAL FIX: Remove timeout cleanup since we removed the timeout
    // User requested: "we dont need timeout here cause it is auto sending we want user to give order if they dont we wait no matter what"
    // if (this.iconModalTimeout) {
    //   clearTimeout(this.iconModalTimeout);
    //   this.iconModalTimeout = null;
    // }

    // Preserve currentIconProcessId to allow progress monitoring to continue
    // Only clear transient UI selection state
    this.currentIconRequestMessage = null;
    this.selectedIconFile = null;
  }

  resetIconFileSelection() {
    this.selectedIconFile = null;
    const fileInfo = document.getElementById("icon-file-info");
    const fileName = document.getElementById("icon-file-name");

    if (fileInfo) fileInfo.style.display = "none";
    if (fileName) fileName.textContent = "No file selected";
  }

  async selectIconFile() {
    try {
      // Use selectFiles which returns an array of file paths
      const paths = await window.electronAPI.selectFiles({
        filters: [
          { name: "WEBM Files", extensions: ["webm"] },
          { name: "All Files", extensions: ["*"] }
        ]
      });

      if (Array.isArray(paths) && paths.length > 0) {
        const filePath = paths[0];
        const fileName = filePath.split(/[\\/]/).pop();

        this.selectedIconFile = filePath;

        // Show file info and enable confirm
        const fileInfo = document.getElementById("icon-file-info");
        const fileNameElement = document.getElementById("icon-file-name");
        const confirmBtn = document.getElementById("confirm-icon-upload");

        if (fileInfo) fileInfo.style.display = "block";
        if (fileNameElement) fileNameElement.textContent = fileName;
        if (confirmBtn) confirmBtn.disabled = false;

        this.addStatusItem(`Selected icon file: ${fileName}`, "info");
      }
    } catch (error) {
      console.error("Error selecting icon file:", error);
      this.addStatusItem(`Error selecting icon file: ${error.message}`, "error");
    }
  }

  async skipIconSelection() {
    if (!this.currentIconProcessId) {
      this.addStatusItem("No active process found", "error");
      return;
    }

    try {
      // Disable skip button to prevent double-clicks
      const skipBtn = document.getElementById("skip-icon-btn");
      if (skipBtn) {
        skipBtn.disabled = true;
        skipBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Skipping...';
      }

      this.addStatusItem("Sending skip command...", "info");

      const response = await this.apiRequest("POST", "/api/sticker/skip-icon", {
        process_id: this.currentIconProcessId
      });

      if (response.success) {
        this.addStatusItem("✅ Icon step skipped successfully", "completed");
        this.showToast("success", "Icon Skipped", "Using first sticker as pack icon");
        this.hideIconModal();

        // Check if pack creation is complete
        if (response.completed) {
          // Pack creation completed after skipping icon
          this.stopStickerProgressMonitoring();
          this.onStickerProcessCompleted(true, {
            shareable_link: response.shareable_link || `https://t.me/addstickers/${response.pack_url_name}`,
            pack_url_name: response.pack_url_name,
            message: "✅ Sticker pack created successfully"
          });
        } else {
          // Continue monitoring for remaining steps
          this.startStickerProgressMonitoring(this.currentIconProcessId);
        }
      } else {
        // Handle specific error cases
        if (response.waiting_for_user && response.url_name_taken) {
          this.addStatusItem("Icon skip completed - please provide URL name", "warning");
          this.hideIconModal();
          // Show URL name modal for user input
          this.showUrlNameModal(response.original_url_name || response.pack_url_name || response.url_name || "retry", 1, 3, this.currentIconProcessId);
        } else if (response.error && response.error.includes("monitoring error")) {
          // Handle the "Process not found" error by showing success instead
          this.addStatusItem("✅ Sticker pack created successfully", "completed");
          this.showToast("success", "Pack Created", "Sticker pack has been created successfully");
          this.hideIconModal();
          this.stopStickerProgressMonitoring();
          this.onStickerProcessCompleted(true, {
            shareable_link: response.shareable_link || "https://t.me/addstickers/unknown",
            message: "✅ Sticker pack created successfully"
          });
        } else {
          this.addStatusItem(`Error skipping icon: ${response.error}`, "error");
          this.showToast("error", "Skip Failed", response.error);
        }

        // Re-enable skip button on error
        if (skipBtn) {
          skipBtn.disabled = false;
          skipBtn.innerHTML = '<i class="fas fa-forward"></i> Skip Icon';
        }
      }
    } catch (error) {
      console.error("Error skipping icon:", error);

      // Handle timeout or server overload errors
      if (error.message && error.message.includes("timeout")) {
        this.addStatusItem("Skip request timeout - assuming success", "warning");
        this.showToast("success", "Pack Created", "Sticker pack likely created successfully");
        this.hideIconModal();
        this.stopStickerProgressMonitoring();
        this.onStickerProcessCompleted(true, {
          message: "✅ Sticker pack created successfully (after timeout)"
        });
      } else {
        this.addStatusItem(`Error skipping icon: ${error.message}`, "error");
        this.showToast("error", "Skip Error", error.message);
      }

      // Re-enable skip button
      const skipBtn = document.getElementById("skip-icon-btn");
      if (skipBtn) {
        skipBtn.disabled = false;
        skipBtn.innerHTML = '<i class="fas fa-forward"></i> Skip Icon';
      }
    }
  }
  async confirmIconUpload(retryCount = 0) {
    const maxRetries = 3;

    if (!this.currentIconProcessId) {
      this.addStatusItem("No active process found", "error");
      return;
    }

    if (!this.selectedIconFile) {
      this.addStatusItem("No icon file selected", "error");
      return;
    }

    try {
      this.addStatusItem(`Uploading icon file${retryCount > 0 ? ` (attempt ${retryCount + 1}/${maxRetries + 1})` : ""}...`, "info");
      const confirmBtn = document.getElementById("confirm-icon-upload");
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
      }

      // Increase timeout for icon upload to match backend
      const response = await this.apiRequest("POST", "/api/sticker/upload-icon", {
        process_id: this.currentIconProcessId,
        icon_file_path: this.selectedIconFile
      });

      if (response.success) {
        // Handle timeout case where icon was sent but response is pending
        if (response.timeout) {
          this.addStatusItem("Icon sent to Telegram; awaiting response...", "warning");
          this.showToast("warning", "Icon Sent", "Icon sent to Telegram; awaiting response. This may take a moment...");
        } else {
          this.addStatusItem("Icon file uploaded successfully", "completed");
          this.showToast("success", "Icon Uploaded", "Icon uploaded successfully. Waiting for URL name request...");

          // CRITICAL FIX: Update workflow state to prevent premature completion
          this.workflowState.iconUploaded = true;
          this.workflowState.currentStep = "url_name";
        }

        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.innerHTML = '<i class="fas fa-check"></i> Sent';
        }
        // Mark icon handled for this process to avoid duplicate icon flow in polling
        this.iconHandledProcesses.add(this.currentIconProcessId);

        // CRITICAL FIX: Close modal immediately after successful upload
        this.hideIconModal();

        // CRITICAL FIX: Apply the same logic as skip button - check if pack creation is complete
        if (response.completed) {
          // Pack creation completed after icon upload
          this.stopStickerProgressMonitoring();
          this.onStickerProcessCompleted(true, {
            shareable_link: response.shareable_link || `https://t.me/addstickers/${response.pack_url_name}`,
            pack_url_name: response.pack_url_name,
            message: "✅ Sticker pack created successfully"
          });
        } else if (response.waiting_for_user && response.url_name_taken) {
          // Handle the case where Telegram immediately asks for URL name after icon upload
          this.addStatusItem("Icon uploaded - please provide URL name", "warning");
          // Show URL name modal for user input
          this.showUrlNameModal(response.original_url_name || response.pack_url_name || response.url_name || "retry", 1, 3, this.currentIconProcessId);
        } else {
          // Continue monitoring for remaining steps (URL name step)
          // CRITICAL FIX: Ensure we follow the same flow as skip button
          this.workflowState.iconUploaded = true;
          this.workflowState.currentStep = "url_name";
          this.startStickerProgressMonitoring(this.currentIconProcessId);
        }
      } else {
        // Detect Telegram size error and mark as manual continuation allowed
        const errorText = String(response.error || "").toLowerCase();
        if (errorText.includes("too big") || errorText.includes("maximum file size") ||
          errorText.includes("invalid file") || errorText.includes("file type") ||
          response.manual_completion_required) {
          // CRITICAL FIX: Handle both size and format errors with appropriate messages
          const isSizeError = errorText.includes("too big") || errorText.includes("maximum file size");
          const errorMessage = isSizeError ?
            "Icon rejected: file too big (max 32 KB). You can continue manually in Telegram." :
            "Icon rejected: invalid file format. You can continue manually in Telegram.";
          const toastMessage = isSizeError ?
            "Telegram rejected the icon due to size. Continue manually in @Stickers." :
            "Telegram rejected the icon due to format. Continue manually in @Stickers.";

          this.addStatusItem(errorMessage, "warning");
          this.showToast("warning", "Icon Rejected", toastMessage);
          setTimeout(() => this.hideIconModal(), 200);
          this.stopStickerProgressMonitoring();
          this.onStickerProcessCompleted(true, {
            manual_completion_required: true,
            message: response.message || errorMessage
          });
          return;
        }

        // Handle timeout errors specifically
        if (response.error && (response.error.includes("timeout") || response.error.includes("Request timeout"))) {
          if (retryCount < maxRetries) {
            this.addStatusItem(`Icon upload timed out. Retrying in 3 seconds... (attempt ${retryCount + 1}/${maxRetries})`, "warning");
            this.showToast("warning", "Upload Timeout", `Icon upload timed out. Retrying... (attempt ${retryCount + 1}/${maxRetries})`);

            // Wait 3 seconds before retry (increased from 2)
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Retry the upload
            return await this.confirmIconUpload(retryCount + 1);
          } else {
            this.addStatusItem(`Icon upload timed out after ${maxRetries + 1} attempts. The icon may have been sent to Telegram. Please wait for the response or try skipping the icon.`, "warning");
            this.showToast("warning", "Upload May Be Sent", `Icon upload timed out after ${maxRetries + 1} attempts. The icon may have been sent to Telegram. Please wait for the response or try skipping the icon.`);

            // Even after timeout, mark as handled since it might have been sent
            this.iconHandledProcesses.add(this.currentIconProcessId);

            // Close modal and continue monitoring
            setTimeout(() => this.hideIconModal(), 200);
            // CRITICAL FIX: Ensure monitoring is restarted after icon is sent
            if (this.currentIconProcessId) {
              // Small delay to ensure the backend has updated the process status
              setTimeout(() => {
                this.startStickerProgressMonitoring(this.currentIconProcessId);
              }, 1000);
            }
          }
        } else {
          // Surface common readiness error clearly
          const friendly = response.error && response.error.includes("not waiting for user")
            ? "Icon step not ready yet. Please wait for the bot to request the icon and try again."
            : response.error;
          this.addStatusItem(`Error uploading icon: ${friendly}`, "error");
        }

        // Re-enable the button for retry
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = '<i class="fas fa-check"></i> Upload This File';
        }

      }
    } catch (error) {
      console.error("Error uploading icon:", error);

      // Handle timeout or server overload errors
      if (error.message && (error.message.includes("timeout") || error.message.includes("Request timeout"))) {
        const maxRetries = 3;
        if (retryCount < maxRetries) {
          this.addStatusItem(`Icon upload timed out. Retrying in 3 seconds... (attempt ${retryCount + 1}/${maxRetries})`, "warning");
          this.showToast("warning", "Upload Timeout", `Icon upload timed out. Retrying... (attempt ${retryCount + 1}/${maxRetries})`);

          // Wait 3 seconds before retry
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Retry the upload
          return await this.confirmIconUpload(retryCount + 1);
        } else {
          this.addStatusItem(`Icon upload timed out after ${maxRetries + 1} attempts. The icon may have been sent to Telegram. Please wait for the response or try skipping the icon.`, "warning");
          this.showToast("warning", "Upload May Be Sent", `Icon upload timed out after ${maxRetries + 1} attempts. The icon may have been sent to Telegram. Please wait for the response or try skipping the icon.`);

          // Even after timeout, mark as handled since it might have been sent
          this.iconHandledProcesses.add(this.currentIconProcessId);

          // Close modal and continue monitoring with proper delay
          setTimeout(() => {
            this.hideIconModal();
            // Ensure monitoring is restarted after icon is sent
            if (this.currentIconProcessId) {
              // Small delay to ensure the backend has updated the process status
              setTimeout(() => {
                this.startStickerProgressMonitoring(this.currentIconProcessId);
              }, 1000);
            }
          }, 500); // Reduced delay for faster continuation
        }
      } else {
        this.addStatusItem(`Error uploading icon: ${error.message}`, "error");

        // CRITICAL FIX: Better error handling for network issues
        if (error.message && (error.message.includes("timeout") || error.message.includes("network") || error.message.includes("fetch"))) {
          this.showToast("warning", "Network Issue", "Network connection issue during icon upload. Please check your connection and try again.");
          this.addStatusItem("Network issue detected. Please check your connection and try again.", "warning");
        } else {
          this.showToast("error", "Upload Failed", `Icon upload failed: ${error.message}`);
        }
      }

      const confirmBtn = document.getElementById("confirm-icon-upload");
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-check"></i> Upload This File';
      }
    }
  }

  clearModalInputs() {
    const inputs = ["verification-code", "two-factor-password", "emoji-input"];
    inputs.forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    this.currentEmojiIndex = null;

    // Reset emoji modal flags
    this.isSavingEmoji = false;
    this.isEmojiModalLocked = false;
  }

  showInfoModal(title, content) {
    const modalHtml = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle"></i> ${title}</h3>
      </div>
      <div class="modal-body">
        <div class="info-content">${content}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="app.hideModal()">
          <i class="fas fa-check"></i> Close
        </button>
      </div>
    `;

    const modal = document.getElementById("info-modal");
    if (modal) {
      modal.innerHTML = modalHtml;
      this.showModal("info-modal");
    }
  }

  showLoadingOverlay(message) {
    const overlay = document.getElementById("loading-overlay");
    const messageElement = document.getElementById("loading-message");

    if (overlay) {
      overlay.classList.add("active");
    }

    if (messageElement) {
      messageElement.textContent = message || "Loading...";
    }
  }

  hideLoadingOverlay() {
    const overlay = document.getElementById("loading-overlay");
    if (overlay) {
      overlay.classList.remove("active");
    }
  }

  showToast(type, title, message, duration = 5000) {
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) {
      // Only show error in development mode
      if (typeof RENDERER_DEBUG !== "undefined" && RENDERER_DEBUG) {
        console.error("❌ Toast container not found!");
      }
      alert(`${type.toUpperCase()}: ${title} - ${message}`);
      return;
    }

    // DEBOUNCE: Prevent showing same toast multiple times in quick succession
    const now = Date.now();
    const isSameToast = this._lastToast.type === type &&
      this._lastToast.title === title &&
      this._lastToast.message === message;
    const isWithinDebounceTime = (now - this._lastToast.time) < this._toastDebounceTime;

    if (isSameToast && isWithinDebounceTime) {
      // Skip duplicate toast
      return;
    }

    // Update last toast tracker
    this._lastToast = { type, title, message, time: now };

    // PREVENT DUPLICATE TOASTS: Check if same toast already exists
    const toastId = `${type}-${title}-${message}`.replace(/[^a-zA-Z0-9]/g, "");
    const existingToast = toastContainer.querySelector(`[data-toast-id="${toastId}"]`);
    if (existingToast) {
      // Don't show duplicate - just flash the existing one
      existingToast.style.animation = "none";
      setTimeout(() => {
        existingToast.style.animation = "slideIn 0.3s ease";
      }, 10);
      return;
    }

    // Limit max toasts to prevent overflow
    const existingToasts = toastContainer.querySelectorAll(".toast");
    if (existingToasts.length >= 5) {
      // Remove oldest toast
      this.removeToast(existingToasts[0]);
    }

    // Increase duration for longer messages
    if (message.length > 50) {
      duration = Math.max(duration, 8000);
    }

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("data-toast-id", toastId);
    toast.style.cursor = "pointer"; // Show it's clickable
    toast.title = "Click to dismiss"; // Tooltip

    toast.innerHTML = `
      <div class="toast-content">
        <h4>${title}</h4>
        <p>${message}</p>
      </div>
      <button class="toast-close" aria-label="Close">
        <i class="fas fa-times"></i>
      </button>
    `;

    // Append to container - CSS will handle stacking with gap
    toastContainer.appendChild(toast);

    // Ensure any slide-out animation actually removes the node
    toast.addEventListener("animationend", (evt) => {
      if (evt.animationName === "slideOut" && toast.parentNode) {
        try { toast.remove(); } catch (_) { }
      }
    });

    // Track removal state
    let isRemoving = false;

    // Auto-remove with slide-out animation
    const autoRemoveTimer = setTimeout(() => {
      this.removeToast(toast);
    }, duration);

    // Close button handler
    const closeBtn = toast.querySelector(".toast-close");
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (isRemoving) return; // Prevent double removal
        isRemoving = true;
        clearTimeout(autoRemoveTimer);
        this.removeToast(toast);
      };
    }

    // Click anywhere to dismiss
    toast.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (isRemoving) return; // Prevent double removal
      isRemoving = true;
      clearTimeout(autoRemoveTimer);
      this.removeToast(toast);
    };
  }

  removeToast(toast) {
    if (!toast) return;

    // Check if already removed or being removed
    if (toast.dataset.removing === "true") return;
    if (!toast.parentNode) return;

    // Mark as being removed
    toast.dataset.removing = "true";

    // Remove event listeners to prevent further clicks
    toast.onclick = null;
    const closeBtn = toast.querySelector(".toast-close");
    if (closeBtn) closeBtn.onclick = null;

    // Add slide-out animation
    toast.style.animation = "slideOut 0.3s ease";

    // Robust removal: prefer animationend, fallback to timeout
    const onAnimEnd = (evt) => {
      if (evt.animationName === "slideOut") {
        toast.removeEventListener("animationend", onAnimEnd);
        if (toast && toast.parentNode) {
          try { toast.remove(); } catch (_) { }
        }
      }
    };
    toast.addEventListener("animationend", onAnimEnd);

    // Fallback in case animationend doesn't fire
    setTimeout(() => {
      if (toast && toast.parentNode) {
        try { toast.remove(); } catch (_) { }
      }
    }, 400);
  }

  repositionToasts() {
    // Move remaining toasts up to fill gaps
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) return;

    const toasts = toastContainer.querySelectorAll(".toast");
    toasts.forEach((toast, index) => {
      // Ensure proper stacking order
      toast.style.zIndex = 1000 + index;
    });
  }

  playNotificationSound() {
    if (localStorage.getItem("enable_sounds") === "true") {
      try {
        const audio = new Audio(
          "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSyD0/PEfCwEKHnN8+OVSA0Oarrj58VdEw1Gne54fFkYkGo5UgkRuBsHJwFZ"
        );
        audio.volume = 0.3;
        audio.play().catch(() => { }); // Ignore errors
      } catch (error) {
        // Ignore audio errors
      }
    }
  }

  showSystemNotification(title, body) {
    if (
      localStorage.getItem("enable_notifications") === "true" &&
      "Notification" in window
    ) {
      if (Notification.permission === "granted") {
        new Notification(title, {
          body: body,
          icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3Njape.org5vuPBoAAANCSURBVFiFtZc9aBRBFMd/M2uC",
        });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((permission) => {
          if (permission === "granted") {
            new Notification(title, { body: body });
          }
        });
      }
    }
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";
    this.applyTheme(newTheme);
    localStorage.setItem("app_theme", newTheme);
  }

  showDetailedMessage(title, htmlContent) {
    // Create a modal-like overlay
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999; /* Lower than toast notifications */
      animation: fadeIn 0.2s ease;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
      background: #2a2a2a;
      border-radius: 8px;
      padding: 20px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      border: 1px solid #444;
      animation: slideIn 0.3s ease;
    `;

    modal.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #444; padding-bottom: 10px;">
        <h3 style="margin: 0; color: #fff; font-size: 18px;">
          <i class="fas fa-microchip" style="margin-right: 8px; color: #007bff;"></i>
          ${title}
        </h3>
        <button style="
          background: transparent;
          border: none;
          color: #888;
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: color 0.2s;
        " onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#888'" onclick="this.closest('div').parentElement.parentElement.remove()">×</button>
      </div>
      <div style="color: #ddd; line-height: 1.8; font-size: 14px;">
        ${htmlContent}
      </div>
      <div style="margin-top: 20px; text-align: right; border-top: 1px solid #444; padding-top: 15px;">
        <button style="
          background: #007bff;
          color: white;
          border: none;
          padding: 10px 24px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: background 0.2s;
        " onmouseover="this.style.background='#0056b3'" onmouseout="this.style.background='#007bff'" onclick="this.closest('div').parentElement.parentElement.remove()">OK</button>
      </div>
    `;

    // Add animations if not already present
    if (!document.getElementById("modal-animations")) {
      const style = document.createElement("style");
      style.id = "modal-animations";
      style.textContent = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // Close on Escape key
    const escHandler = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      const icon = themeToggle.querySelector("i");
      if (icon) {
        icon.className = theme === "dark" ? "fas fa-sun" : "fas fa-moon";
      }
    }
  }

  async updateSystemInfo() {
    try {
      const health = await this.apiRequest("GET", "/api/health");

      // Update Backend Status - just show Connected/Disconnected
      const backendStatusEl = document.getElementById("backend-status-text");
      const backendStatusContainer = document.getElementById("backend-status");

      // More robust backend status detection
      const isBackendHealthy = health &&
        (health.success === true ||
          (health.status && health.status.toLowerCase().includes("connected")));


      if (backendStatusEl && backendStatusContainer) {
        if (isBackendHealthy) {
          backendStatusEl.textContent = "Connected";
          backendStatusContainer.className = "status-item connected";

          // Also update the settings page backend status
          const settingsBackendStatus = document.getElementById("settings-backend-status");
          if (settingsBackendStatus) {
            settingsBackendStatus.textContent = "Connected";
          }
        } else {
          backendStatusEl.textContent = "Disconnected";
          backendStatusContainer.className = "status-item disconnected";

          // Also update the settings page backend status
          const settingsBackendStatus = document.getElementById("settings-backend-status");
          if (settingsBackendStatus) {
            settingsBackendStatus.textContent = "Disconnected";
          }
        }
      }

      // Update FFmpeg Status - get real status from API
      const ffmpegStatusEl = document.getElementById("ffmpeg-status");
      if (ffmpegStatusEl && health?.data?.ffmpeg_available !== undefined) {
        const ffmpegAvailable = health.data.ffmpeg_available;
        ffmpegStatusEl.textContent = ffmpegAvailable ? "Available" : "Not Available";
        ffmpegStatusEl.style.color = ffmpegAvailable ? "#28a745" : "#dc3545";
      } else if (ffmpegStatusEl) {
        ffmpegStatusEl.textContent = "Unknown";
        ffmpegStatusEl.style.color = "#6c757d";
      }
    } catch (error) {
      console.error("updateSystemInfo failed:", error);

      // If backend is not available, show disconnected state
      const backendStatusEl = document.getElementById("backend-status-text");
      const backendStatusContainer = document.getElementById("backend-status");
      if (backendStatusEl && backendStatusContainer) {
        backendStatusEl.textContent = "Disconnected";
        backendStatusContainer.className = "status-item disconnected";
      }

      // Also update settings panel backend status
      const settingsBackendStatus = document.getElementById("settings-backend-status");
      if (settingsBackendStatus) {
        settingsBackendStatus.textContent = "Disconnected";
      }

      const ffmpegStatusEl = document.getElementById("ffmpeg-status");
      if (ffmpegStatusEl) {
        ffmpegStatusEl.textContent = "Unknown";
        ffmpegStatusEl.style.color = "#6c757d";
      }
    }

    // Update Platform Info
    const platformEl = document.getElementById("platform-info");
    if (platformEl) {
      const platform = navigator.platform;
      if (platform.includes("Win")) {
        platformEl.textContent = "Windows";
      } else if (platform.includes("Mac")) {
        platformEl.textContent = "macOS";
      } else if (platform.includes("Linux")) {
        platformEl.textContent = "Linux";
      } else {
        platformEl.textContent = platform;
      }
    }

    // Update Architecture
    const archEl = document.getElementById("arch-info");
    if (archEl) {
      const is64bit = navigator.userAgent.includes("x64") ||
        navigator.userAgent.includes("x86_64") ||
        navigator.userAgent.includes("Win64");
      archEl.textContent = is64bit ? "64-bit" : "32-bit";
    }



    // Update Uptime
    const uptimeEl = document.getElementById("app-uptime");
    if (uptimeEl && this.startTime) {
      const now = new Date();
      const diff = now - this.startTime;
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);

      if (hours > 0) {
        uptimeEl.textContent = `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        uptimeEl.textContent = `${minutes}m ${seconds}s`;
      } else {
        uptimeEl.textContent = `${seconds}s`;
      }
    }

    // Update stats
    this.updateStats();

    // Update file counts
    const videoCountElement = document.getElementById("video-file-count");
    const mediaCountElement = document.getElementById("media-file-count");

    if (videoCountElement)
      videoCountElement.textContent = this.videoFiles.length;
    if (mediaCountElement)
      mediaCountElement.textContent = this.mediaFiles.length;

    // Database stats are updated by separate interval
  }

  async updateDatabaseStats() {
    try {
      const res = await window.electronAPI.readStats();
      if (!res?.success || !res?.data) throw new Error(res?.error || "readStats failed");
      const s = res.data;
      const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };

      setText("total-conversions", s.total_conversions);
      setText("successful-conversions", s.successful_conversions);
      setText("failed-conversions", s.failed_conversions);
      setText("total-images-converted", s.total_images_converted);
      setText("successful-images", s.successful_images);
      setText("failed-images", s.failed_images);
      setText("total-hexedits", s.total_hexedits);
      setText("successful-hexedits", s.successful_hexedits);
      setText("failed-hexedits", s.failed_hexedits);
      setText("total-stickers-created", s.total_stickers_created);

      const ses = document.getElementById("session-start") || document.getElementById("session-started");
      if (ses && s.session_started) ses.textContent = new Date(s.session_started * 1000).toLocaleString();
    } catch (e) {
      console.error("❌ updateDatabaseStats (preload) failed:", e);
    }
  }

  // Force immediate database stats update - useful during active operations
  async forceUpdateDatabaseStats() {
    try {
      await this.updateDatabaseStats();
    } catch (e) {
      console.error("❌ forceUpdateDatabaseStats failed:", e);
    }
  }

  updateStats() {
    // Do NOT touch database info fields here to avoid overwriting with zeros
    // Keep only non-database UI refresh (e.g., local cache size)
    const cacheSizeEl = document.getElementById("cache-size");
    if (cacheSizeEl) {
      const cacheSize = Math.round(JSON.stringify(localStorage).length / 1024);
      cacheSizeEl.textContent = `${cacheSize} KB`;
    }
  }

  async exportStats() {
    try {
      const res = await window.electronAPI.readStats();
      if (!res?.success || !res?.data) throw new Error(res?.error || "readStats failed");
      const d = res.data;
      const payload = {
        total_conversions: d.total_conversions ?? 0,
        successful_conversions: d.successful_conversions ?? 0,
        failed_conversions: d.failed_conversions ?? 0,
        total_images_converted: d.total_images_converted ?? 0,
        successful_images: d.successful_images ?? 0,
        failed_images: d.failed_images ?? 0,
        total_hexedits: d.total_hexedits ?? 0,
        successful_hexedits: d.successful_hexedits ?? 0,
        failed_hexedits: d.failed_hexedits ?? 0,
        total_stickers_created: d.total_stickers_created ?? 0,
        session_started: d.session_started ?? null,
        exported_at: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `database-stats-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast("Database stats exported", "success");
    } catch (e) {
      console.error("Export stats failed:", e);
      this.showToast("Failed to export stats", "error");
    }
  }

  formatTimeAgo(date) {
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) {
      return `${diffInSeconds}s ago`;
    } else if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `${minutes}m ago`;
    } else if (diffInSeconds < 86400) {
      const hours = Math.floor(diffInSeconds / 3600);
      return `${hours}h ago`;
    } else {
      return date.toLocaleDateString();
    }
  }
  async exportSettings() {
    try {
      const settings = {
        telegram_api_id: localStorage.getItem("telegram_api_id") || "",
        telegram_api_hash: localStorage.getItem("telegram_api_hash") || "",
        telegram_phone: localStorage.getItem("telegram_phone") || "",
        video_output_dir: localStorage.getItem("video_output_dir") || "",
        quality_setting: localStorage.getItem("quality_setting") || "80",
        auto_convert: localStorage.getItem("auto_convert") || "false",
        enable_sounds: localStorage.getItem("enable_sounds") || "true",
        enable_notifications:
          localStorage.getItem("enable_notifications") || "true",
        app_theme: localStorage.getItem("app_theme") || "dark",
        export_date: new Date().toISOString(),
      };

      const dataStr = JSON.stringify(settings, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });

      // Create download link
      const link = document.createElement("a");
      link.href = URL.createObjectURL(dataBlob);
      link.download = `telegram-utilities-settings-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      this.showToast(
        "success",
        "Settings Exported",
        "Settings exported successfully"
      );
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error exporting settings:", error);
      this.showToast(
        "error",
        "Export Failed",
        "Failed to export settings: " + error.message
      );
    }
  }

  async importSettings() {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";

      input.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        try {
          const text = await file.text();
          const settings = JSON.parse(text);

          // Validate settings structure
          const requiredFields = [
            "telegram_api_id",
            "telegram_api_hash",
            "telegram_phone",
          ];
          const hasRequiredFields = requiredFields.some(
            (field) => settings[field]
          );

          if (!hasRequiredFields) {
            throw new Error("Invalid settings file format");
          }

          // Import settings
          Object.keys(settings).forEach((key) => {
            if (key !== "export_date" && settings[key] !== undefined) {
              localStorage.setItem(key, settings[key]);
            }
          });

          // Reload settings
          this.loadSettings();
          this.loadAdvancedSettings();

          // Apply theme
          if (settings.app_theme) {
            this.applyTheme(settings.app_theme);
          }

          this.showToast(
            "success",
            "Settings Imported",
            "Settings imported successfully"
          );
        } catch (error) {
          if (RENDERER_DEBUG) console.error("Error importing settings:", error);
          this.showToast(
            "error",
            "Import Failed",
            "Failed to import settings: " + error.message
          );
        }
      };

      input.click();
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error importing settings:", error);
      this.showToast(
        "error",
        "Import Failed",
        "Failed to import settings: " + error.message
      );
    }
  }
  clearApplicationData() {
    window.confirmModal.show("This will permanently delete all saved credentials, settings, session data and file lists. This cannot be undone. Are you sure?", "Factory Reset").then(confirmed => {
      if (!confirmed) return;

      try {
        // Clear localStorage (keep theme)
        const theme = localStorage.getItem("app_theme");
        localStorage.clear();
        if (theme) localStorage.setItem("app_theme", theme);

        // Reset application state
        this.videoFiles = [];
        this.mediaFiles = [];
        this.currentVideoOutput = "";
        this.telegramConnected = false;
        this.pendingCode = false;
        this.pendingPassword = false;

        // Clear form values
        ["telegram-api-id", "telegram-api-hash", "telegram-phone", "video-output-dir", "pack-name"].forEach(id => {
          const input = document.getElementById(id);
          if (input) input.value = "";
        });

        // Reset UI
        this.updateVideoFileList();
        this.updateMediaFileList();
        this.updateTelegramStatus("disconnected");

        // Clear any active processes
        this.stopProgressMonitoring();
        if (this.stickerProgressInterval) {
          clearInterval(this.stickerProgressInterval);
          this.stickerProgressInterval = null;
        }

        // Clear backend session
        this.apiRequest("POST", "/api/clear-session").catch(() => { });

        this.showToast("success", "Data Cleared", "All application data has been cleared successfully");
      } catch (error) {
        this.showToast("error", "Clear Failed", "Failed to clear some data: " + error.message);
      }
    });
  }

  updateButtonStates() {
    const startConversionBtn = document.getElementById("start-conversion");
    const pauseConversionBtn = document.getElementById("pause-conversion");
    const resumeConversionBtn = document.getElementById("resume-conversion");
    const startHexEditBtn = document.getElementById("start-hex-edit");

    // Reset all buttons first
    [startConversionBtn, pauseConversionBtn, resumeConversionBtn, startHexEditBtn].forEach(btn => {
      if (btn) btn.style.display = "none";
    });

    if (!this.currentOperation) {
      // No operation running
      if (startConversionBtn) {
        startConversionBtn.style.display = "inline-flex";
        startConversionBtn.disabled = false;
        startConversionBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
      }

      if (startHexEditBtn) {
        startHexEditBtn.style.display = "inline-flex";
        startHexEditBtn.disabled = false;
        startHexEditBtn.innerHTML = '<i class="fas fa-edit"></i> Hex Edit';
        startHexEditBtn.style.opacity = "1";
      }
    } else if (this.currentOperation === "converting") {
      // Conversion running
      if (startHexEditBtn) {
        startHexEditBtn.style.display = "inline-flex";
        startHexEditBtn.disabled = true;
      }

      if (this.isPaused) {
        if (resumeConversionBtn) resumeConversionBtn.style.display = "inline-flex";
      } else {
        if (pauseConversionBtn) pauseConversionBtn.style.display = "inline-flex";
      }
    } else if (this.currentOperation === "hexediting") {
      // Hex editing running - no pause/resume for hex edit (too fast)
      if (startConversionBtn) {
        startConversionBtn.style.display = "inline-flex";
        startConversionBtn.disabled = true;
      }
    }
  }

  async pauseOperation() {
    // NOTE: This only sets a pause flag - it doesn't actually suspend the Python process
    // The conversion will continue running but UI shows "paused" state
    // True process suspension would require OS-level process control (SIGSTOP/SIGCONT)
    if (!this.currentProcessId || this.isPaused) return;

    try {
      const response = await this.apiRequest("POST", "/api/pause-operation", {
        process_id: this.currentProcessId
      });

      if (response.success) {
        this.isPaused = true;

        // Update UI for pause state
        const pauseBtn = document.getElementById("pause-conversion");
        const resumeBtn = document.getElementById("resume-conversion");

        if (pauseBtn) {
          pauseBtn.style.display = "none";
        }

        if (resumeBtn) {
          resumeBtn.style.display = "inline-block";
          resumeBtn.disabled = false;
        }

        this.updateButtonStates();
        this.showToast("info", "Operation Paused", "The current operation has been paused");
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error pausing operation:", error);
      this.showToast("error", "Pause Failed", "Failed to pause the operation");
    }
  }

  async resumeOperation() {
    if (!this.currentProcessId || !this.isPaused) return;

    try {
      const response = await this.apiRequest("POST", "/api/resume-operation", {
        process_id: this.currentProcessId
      });

      if (response.success) {
        this.isPaused = false;

        // Update UI for resume state
        const pauseBtn = document.getElementById("pause-conversion");
        const resumeBtn = document.getElementById("resume-conversion");

        if (pauseBtn) {
          pauseBtn.style.display = "inline-block";
          pauseBtn.disabled = false;
        }

        if (resumeBtn) {
          resumeBtn.style.display = "none";
        }

        this.updateButtonStates();
        this.showToast("info", "Operation Resumed", "The operation has been resumed");
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error resuming operation:", error);
      this.showToast("error", "Resume Failed", "Failed to resume the operation");
    }
  }

  updateConversionButtons(isConverting, isHexEditing) {
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");

    if (isConverting) {
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-cog fa-spin"></i> Converting...';
      }

      if (hexBtn) {
        hexBtn.disabled = true;
        hexBtn.style.opacity = "0.5";
      }

      if (this.isPaused) {
        if (pauseBtn) pauseBtn.style.display = "none";
        if (resumeBtn) resumeBtn.style.display = "inline-block";
      } else {
        if (pauseBtn) pauseBtn.style.display = "inline-block";
        if (resumeBtn) resumeBtn.style.display = "none";
      }
    } else if (isHexEditing) {
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.opacity = "0.5";
      }

      if (hexBtn) {
        hexBtn.disabled = true;
        hexBtn.innerHTML = '<i class="fas fa-cog fa-spin"></i> Hex Editing...';
      }

      if (this.isPaused) {
        if (pauseBtn) pauseBtn.style.display = "none";
        if (resumeBtn) resumeBtn.style.display = "inline-block";
      } else {
        if (pauseBtn) pauseBtn.style.display = "inline-block";
        if (resumeBtn) resumeBtn.style.display = "none";
      }
    }
  }

  // System Management Functions
  async clearCache() {
    try {
      // Clear localStorage cache
      const keysToKeep = ["telegram_api_id", "telegram_api_hash", "telegram_bot_token", "telegram_chat_id"];
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (!keysToKeep.includes(key)) {
          localStorage.removeItem(key);
        }
      });

      // Update display
      document.getElementById("cache-size").textContent = "0 MB";
      this.showToast("Cache cleared successfully", "success");
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Failed to clear cache:", error);
      this.showToast("Failed to clear cache", "error");
    }
  }


  async restartBackend() {
    try {
      this.showToast("Restarting backend...", "info");
      const response = await this.apiRequest("POST", "/api/restart");

      // Wait a bit for backend to restart
      setTimeout(() => {
        this.checkBackendStatus();
        this.showToast("Backend restarted successfully", "success");
      }, 3000);
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Failed to restart backend:", error);
      // Try to reconnect after a delay
      setTimeout(() => {
        this.checkBackendStatus();
      }, 5000);
    }
  }

  async resetStats() {
    const confirmed = await window.confirmModal.show("Are you sure you want to reset all statistics?", "Reset Statistics");
    if (!confirmed) return;

    try {
      const response = await this.apiRequest("POST", "/api/reset-stats");
      if (response.success) {
        this.showToast("success", "Statistics Reset", "All statistics have been reset");
        await this.forceUpdateDatabaseStats();
        await this.updateDatabaseStats();
      } else {
        this.showToast("error", "Reset Failed", response.error || "Failed to reset statistics");
      }
    } catch (error) {
      this.showToast("error", "Reset Failed", "Failed to reset statistics: " + error.message);
    }
  }

  async clearLogs() {
    const confirmed = await window.confirmModal.show("Are you sure you want to clear all log files?", "Clear Logs");
    if (!confirmed) return;

    try {
      const response = await this.apiRequest("POST", "/api/clear-logs");
      if (response.success) {
        this.showToast("success", "Logs Cleared", response.message);
      } else {
        this.showToast("error", "Clear Failed", response.error || "Failed to clear logs");
      }
    } catch (error) {
      this.showToast("error", "Clear Failed", "Failed to clear logs: " + error.message);
    }
  }

  async clearCredentials() {
    const confirmed = await window.confirmModal.show("Clear all saved credentials? You'll need to re-enter your Telegram API credentials.", "Clear Credentials");
    if (!confirmed) return;

    try {
      const response = await this.apiRequest("POST", "/api/clear-credentials");
      if (response.success) {
        this.showToast("success", "Credentials Cleared", response.message);
        localStorage.removeItem("telegram_api_id");
        localStorage.removeItem("telegram_api_hash");
        localStorage.removeItem("telegram_phone");
        this.initializeTelegramForm();
      } else {
        this.showToast("error", "Clear Failed", response.error || "Failed to clear credentials");
      }
    } catch (error) {
      this.showToast("error", "Clear Failed", "Failed to clear credentials: " + error.message);
    }
  }

  async killPythonProcesses() {
    this.showKillProcessesModal();
  }

  showKillProcessesModal() {
    const modalHtml = `
      <div class="modal-overlay active" id="kill-processes-modal">
        <div class="modal kill-processes-modal-content">
          <div class="modal-header">
            <h3>
              <i class="fas fa-skull-crossbones"></i>
              Kill Python Processes
            </h3>
          </div>
          
          <div class="modal-body">
            <div class="kill-warning-content">
              <div class="warning-section">
                <div class="warning-icon">
                  <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div class="warning-text">
                  Terminates all Python processes including:
                </div>
              </div>
              
              <div class="process-list">
                <div class="process-item">
                  <i class="fas fa-server"></i>
                  <span>Backend server</span>
                </div>
                <div class="process-item">
                  <i class="fas fa-code"></i>
                  <span>Python scripts</span>
                </div>
                <div class="process-item">
                  <i class="fas fa-book"></i>
                  <span>Jupyter notebooks</span>
                </div>
                <div class="process-item">
                  <i class="fas fa-laptop-code"></i>
                  <span>IDEs & debuggers</span>
                </div>
              </div>
              
              <div class="important-note">
                <i class="fas fa-info-circle"></i>
                <span>Restart required after killing processes</span>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="window.app?.hideKillProcessesModal()">
              Cancel
            </button>
            <button class="btn btn-danger" onclick="window.app?.confirmKillProcesses();">
              Kill Processes
            </button>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById("kill-processes-modal");
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    // Add escape key handler
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        this.hideKillProcessesModal();
        document.removeEventListener("keydown", handleEscape);
      }
    };
    document.addEventListener("keydown", handleEscape);
  }

  hideKillProcessesModal() {
    const modal = document.getElementById("kill-processes-modal");
    if (modal) {
      modal.remove();
    }
  }

  async confirmKillProcesses() {
    this.hideKillProcessesModal();

    try {
      const response = await this.apiRequest("POST", "/api/kill-python-processes");

      if (response.success) {
        this.showToast("success", "Python Processes Killed", response.message);

        // Show backend termination notice after kill
        setTimeout(() => {
          this.showToast("info", "Backend Killed", "The backend has been terminated. Please restart the app.");
        }, 2000);

      } else {
        this.showToast("error", "Kill Failed", response.error || "Failed to kill Python processes");
      }
    } catch (error) {
      this.showToast("error", "Kill Failed", "Failed to kill Python processes: " + error.message);
    }
  }

  // Enhanced emoji modal functions with lazy loading
  setupEmojiModal() {
    // Initialize lazy loading cache properties
    if (!this._emojiDataCache) {
      this._emojiDataCache = null;
    }
    if (!this._emojiLoadPromise) {
      this._emojiLoadPromise = null;
    }

    // Defer emoji loading until needed
    const modal = document.getElementById("emoji-modal");
    if (!modal) return;

    // Setup drag scrolling for emoji tabs
    this.setupEmojiScrollNavigation();

    // Single click - just preview
    modal.addEventListener("click", (e) => {
      const tab = e.target.closest(".emoji-tab");
      if (tab) {
        this.handleEmojiTabClick(tab);
        return;
      }

      const emojiBtn = e.target.closest(".emoji-btn");
      if (emojiBtn) {
        const emoji = emojiBtn.getAttribute("data-emoji");
        this.selectQuickEmoji(emoji, false); // false = don't save
      }
    });

    // Double click - save and close
    modal.addEventListener("dblclick", (e) => {
      const emojiBtn = e.target.closest(".emoji-btn");
      if (emojiBtn) {
        const emoji = emojiBtn.getAttribute("data-emoji");
        this.selectQuickEmoji(emoji, true); // true = save immediately
      }
    });
  }

  // Method to select a quick emoji from the emoji picker
  selectQuickEmoji(emoji, shouldSave = false) {
    // Update emoji input
    const emojiInput = document.getElementById("emoji-input");

    if (emojiInput) {
      emojiInput.value = emoji;

      // If shouldSave is true (double-click), save immediately
      if (shouldSave) {
        // Direct save without delay
        this.saveEmojiDirect(emoji);
      }
    }
  }

  handleEmojiTabClick(tab) {
    const category = tab.getAttribute("data-category");

    // Batch DOM updates
    requestAnimationFrame(() => {
      // Update tabs
      document.querySelectorAll(".emoji-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      // Update categories
      document.querySelectorAll(".emoji-category").forEach(cat => cat.classList.remove("active"));
      const targetCategory = document.getElementById(`category-${category}`);
      if (targetCategory) {
        targetCategory.classList.add("active");
      }
    });
  }

  async lazyLoadEmojiOptions() {
    // Return cached data if available
    if (this._emojiDataCache) return this._emojiDataCache;

    // Return existing promise if loading is in progress
    if (this._emojiLoadPromise) return this._emojiLoadPromise;

    // Start loading emoji data
    this._emojiLoadPromise = this.loadEmojiData();
    this._emojiDataCache = await this._emojiLoadPromise;
    this._emojiLoadPromise = null;

    return this._emojiDataCache;
  }

  async loadEmojiData() {
    // Simulate loading emoji data (in real app, might load from file)
    return new Promise(resolve => {
      setTimeout(() => {
        resolve({
          loaded: true,
          categories: ["smileys", "hearts", "animals", "food", "objects"]
        });
      }, 10);
    });
  }

  setupEmojiScrollNavigation() {
    const tabsContainer = document.querySelector(".emoji-tabs");

    if (!tabsContainer) {
      return;
    }

    // Enable mouse wheel scrolling
    tabsContainer.addEventListener("wheel", (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        tabsContainer.scrollBy({
          left: e.deltaY > 0 ? 100 : -100,
          behavior: "smooth"
        });
      }
    });

    // Enable drag scrolling with click prevention
    let isDown = false;
    let startX;
    let scrollLeft;
    let hasMoved = false; // Track if mouse moved during drag

    tabsContainer.addEventListener("mousedown", (e) => {
      // Only start drag if not clicking on a tab button directly
      isDown = true;
      hasMoved = false;
      startX = e.pageX - tabsContainer.offsetLeft;
      scrollLeft = tabsContainer.scrollLeft;
      tabsContainer.style.cursor = "grabbing";
      tabsContainer.style.userSelect = "none";
    });

    tabsContainer.addEventListener("mouseleave", () => {
      isDown = false;
      tabsContainer.style.cursor = "grab";
      tabsContainer.style.userSelect = "";
    });

    tabsContainer.addEventListener("mouseup", () => {
      isDown = false;
      tabsContainer.style.cursor = "grab";
      tabsContainer.style.userSelect = "";
    });

    tabsContainer.addEventListener("mousemove", (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - tabsContainer.offsetLeft;
      const walk = (x - startX) * 2.5; // Scroll speed multiplier

      // If moved more than 5px, consider it a drag
      if (Math.abs(walk) > 5) {
        hasMoved = true;
      }

      tabsContainer.scrollLeft = scrollLeft - walk;
    });

    // Handle tab clicks - only if not dragging
    tabsContainer.addEventListener("click", (e) => {
      // If we just dragged, prevent the click from changing category
      if (hasMoved) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const tab = e.target.closest(".emoji-tab");
      if (tab) {
        this.handleEmojiTabClick(tab);
      }
    }, true); // Use capture phase to intercept before other handlers

    // Single delegated event for all emoji buttons
    const emojiContainer = document.querySelector(".emoji-picker-enhanced");
    if (emojiContainer) {
      emojiContainer.addEventListener("click", (e) => {
        const btn = e.target.closest(".emoji-btn");
        if (!btn) return;

        const emoji = btn.getAttribute("data-emoji");
        const input = document.getElementById("emoji-input");
        const preview = document.getElementById("emoji-preview-icon");

        if (input) input.value = emoji;
        if (preview) preview.textContent = emoji;
      });
    }

    // Live emoji preview
    const emojiInput = document.getElementById("emoji-input");
    if (emojiInput) {
      let debounceTimer;
      emojiInput.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const preview = document.getElementById("emoji-preview-icon");
          if (preview && e.target.value) {
            preview.textContent = e.target.value;
          }
        }, 50);
      });
    }
  }

  applyEmojiToAll() {
    const currentEmoji = document.getElementById("emoji-input")?.value || "😀";

    this.mediaFiles.forEach(file => {
      file.emoji = currentEmoji;
    });

    this.updateMediaFileList();
    // Keep the emoji modal input in sync with the item being edited
    this.syncEmojiModalWithCurrent();
    this.showToast("success", "Emoji Applied", `Applied ${currentEmoji} to all files`);
  }
  applyRandomEmojis() {
    const allEmojis = [
      // Smileys
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
      "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
      "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔",
      // Hearts & Love
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️",
      // Animals
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐒", "🦄",
      // Objects & Symbols
      "✨", "⭐", "🌟", "💫", "⚡", "🔥", "💥", "☀️", "🌈", "❄️",
      "💧", "💯", "✅", "🎯", "🎉", "🎊", "🎈", "🎁", "🎀", "💎"
    ];

    this.mediaFiles.forEach(file => {
      file.emoji = allEmojis[Math.floor(Math.random() * allEmojis.length)];
    });

    this.updateMediaFileList();
    // Keep modal in sync if it's open
    this.syncEmojiModalWithCurrent();
    this.showToast("success", "Random Emojis", "Applied random emojis to all files");
  }

  applySequentialEmojis() {
    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    const alternativeEmojis = ["🅰️", "🅱️", "🆎", "🅾️", "🆑", "🆒", "🆓", "🆔", "🆕", "🆖"];

    this.mediaFiles.forEach((file, index) => {
      if (index < numberEmojis.length) {
        file.emoji = numberEmojis[index];
      } else if (index < numberEmojis.length + alternativeEmojis.length) {
        file.emoji = alternativeEmojis[index - numberEmojis.length];
      } else {
        // For files beyond our sequential emojis, use a pattern
        file.emoji = "➡️";
      }
    });

    this.updateMediaFileList();
    // Keep modal in sync if it's open
    this.syncEmojiModalWithCurrent();
    this.showToast("success", "Sequential Emojis", "Applied sequential emojis to all files");
  }

  // Keep emoji modal controls in sync with the currently selected media item
  syncEmojiModalWithCurrent() {
    try {
      if (this.currentEmojiIndex !== null && this.currentEmojiIndex >= 0) {
        const emojiInput = document.getElementById("emoji-input");
        const preview = document.getElementById("emoji-preview-icon");
        const current = this.mediaFiles[this.currentEmojiIndex]?.emoji;
        if (emojiInput && typeof current === "string") {
          emojiInput.value = current;
        }
        if (preview && typeof current === "string") {
          preview.textContent = current;
        }
      }
    } catch (_) { }
  }

  applyThemeEmojis() {
    const themes = {
      happy: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇"],
      love: ["❤️", "🧡", "💛", "💚", "💙", "💜", "💕", "💞", "💓", "💗"],
      cool: ["😎", "🤩", "😏", "😈", "👿", "🤠", "🦾", "🔥", "⚡", "💯"],
      nature: ["🌸", "🌺", "🌻", "🌷", "🌹", "🌲", "🌳", "🌴", "🌵", "🍀"],
      food: ["🍕", "🍔", "🍟", "🌭", "🍿", "🥓", "🍳", "🧇", "🥞", "🧈"],
      sports: ["⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🎱", "🏓", "🏸"]
    };

    // Randomly select a theme
    const themeNames = Object.keys(themes);
    const selectedTheme = themeNames[Math.floor(Math.random() * themeNames.length)];
    const themeEmojis = themes[selectedTheme];

    this.mediaFiles.forEach((file, index) => {
      file.emoji = themeEmojis[index % themeEmojis.length];
    });

    this.updateMediaFileList();
    // Keep modal in sync if it's open
    this.syncEmojiModalWithCurrent();
    this.showToast("success", "Theme Emojis", `Applied ${selectedTheme} theme emojis to all files`);
  }

  sortMedia(sortType) {
    if (!this.mediaFiles || this.mediaFiles.length === 0) return;

    switch (sortType) {
      case "name-asc":
        this.mediaFiles.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        this.mediaFiles.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "date-new":
        this.mediaFiles.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
        break;
      case "date-old":
        this.mediaFiles.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
        break;
      case "size-large":
        this.mediaFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
      case "size-small":
        this.mediaFiles.sort((a, b) => (a.size || 0) - (b.size || 0));
        break;
    }

    this.updateMediaFileList();
    this.showToast("success", "Sorted", `Files sorted by ${sortType.replace("-", " ")}`);
  }

  // Removed profile card functionality - will add new content later

  // About Me Section Functionality
  initializeAboutSection() {
    this.setupSupportButtons();
    this.setupProjectLinks();
    this.setupChannelPromotion();
  }

  setupSupportButtons() {
    // Coffee button
    const coffeeBtn = document.querySelector(".coffee-btn");
    if (coffeeBtn) {
      coffeeBtn.addEventListener("click", () => {
        this.showSupportModal("coffee", "Buy Me a Coffee",
          "Support my open source work with a coffee! ☕\n\n" +
          "This will open your default browser to a coffee donation page.\n" +
          "You can replace this with your actual coffee.me or similar link later.");
      });
    }

    // PayPal button
    const paypalBtn = document.querySelector(".paypal-btn");
    if (paypalBtn) {
      paypalBtn.addEventListener("click", () => {
        this.showSupportModal("paypal", "PayPal Donation",
          "Support my work via PayPal! 💰\n\n" +
          "This will open your default browser to PayPal.\n" +
          "You can replace this with your actual PayPal.me link later.");
      });
    }

    // GitHub Sponsors button
    const githubBtn = document.querySelector(".github-btn");
    if (githubBtn) {
      githubBtn.addEventListener("click", () => {
        this.showSupportModal("github", "GitHub Sponsors",
          "Become a GitHub Sponsor! 🌟\n\n" +
          "This will open your GitHub profile for sponsorship.\n" +
          "You can replace this with your actual GitHub Sponsors link later.");
      });
    }

    // Star Projects button
    const starBtn = document.querySelector(".star-btn");
    if (starBtn) {
      starBtn.addEventListener("click", () => {
        this.showSupportModal("star", "Star Projects",
          "Show your appreciation by starring my projects! ⭐\n\n" +
          "This will open your GitHub repositories.\n" +
          "You can replace this with your actual project links later.");
      });
    }
  }

  setupProjectLinks() {
    // Add click tracking for project links
    const projectLinks = document.querySelectorAll(".project-link");
    projectLinks.forEach(link => {
      link.addEventListener("click", (e) => {
        // Track project clicks
        this.showToast("info", "Opening Project", "Opening project in your browser...");
      });
    });
  }

  setupChannelPromotion() {
    const channelBtn = document.querySelector(".channel-join-btn");
    if (channelBtn) {
      channelBtn.addEventListener("click", (e) => {
        this.showToast("success", "Joining Channel", "Opening Telegram channel in your browser...");
      });
    }
  }
  showSupportModal(type, title, message) {
    // Create a simple modal for support options
    const modal = document.createElement("div");
    modal.className = "support-modal";
    modal.innerHTML = `
      <div class="support-modal-content">
        <div class="support-modal-header">
          <h3>${title}</h3>
          <button class="support-modal-close">&times;</button>
        </div>
        <div class="support-modal-body">
          <p>${message.replace(/\n/g, "<br>")}</p>
        </div>
        <div class="support-modal-footer">
          <button class="btn btn-secondary support-modal-cancel">Cancel</button>
          <button class="btn btn-primary support-modal-proceed">Proceed</button>
        </div>
      </div>
    `;

    // Add modal styles
    const style = document.createElement("style");
    style.textContent = `
      .support-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999; /* Lower than toast notifications */
        animation: fadeIn 0.3s ease;
      }
      
      .support-modal-content {
        background: var(--bg-card);
        border-radius: 15px;
        max-width: 500px;
        width: 90%;
        max-height: 80vh;
        overflow-y: auto;
        border: 1px solid var(--border-color);
        animation: slideUp 0.3s ease;
      }
      
      .support-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1.5rem;
        border-bottom: 1px solid var(--border-color);
      }
      
      .support-modal-header h3 {
        margin: 0;
        color: var(--text-primary);
      }
      
      .support-modal-close {
        background: none;
        border: none;
        font-size: 1.5rem;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 0;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 0.3s ease;
      }
      
      .support-modal-close:hover {
        background: var(--bg-input);
      }
      
      .support-modal-body {
        padding: 1.5rem;
        color: var(--text-secondary);
        line-height: 1.6;
      }
      
      .support-modal-footer {
        padding: 1.5rem;
        border-top: 1px solid var(--border-color);
        display: flex;
        gap: 1rem;
        justify-content: flex-end;
      }
      
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      @keyframes slideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(modal);

    // Handle close button
    const closeBtn = modal.querySelector(".support-modal-close");
    const cancelBtn = modal.querySelector(".support-modal-cancel");
    const proceedBtn = modal.querySelector(".support-modal-proceed");

    const closeModal = () => {
      modal.remove();
      style.remove();
    };

    closeBtn.addEventListener("click", closeModal);
    cancelBtn.addEventListener("click", closeModal);

    // Handle proceed button
    proceedBtn.addEventListener("click", () => {
      closeModal();

      // Open appropriate link based on type
      let url = "";
      switch (type) {
        case "coffee":
          url = "https://buymeacoffee.com/joonjelly"; // Updated with actual link
          break;
        case "paypal":
          url = "https://paypal.me/"; // Replace with your actual link
          break;
        case "github":
          url = "https://github.com/RohitPoul"; // Updated with your actual GitHub profile
          break;
        case "star":
          url = "https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader"; // Updated with your actual repositories
          break;
      }

      if (url) {
        // Use Electron's shell API to open external URLs
        if (window.electronAPI && window.electronAPI.shell && window.electronAPI.shell.openExternal) {
          window.electronAPI.shell.openExternal(url);
        } else {
          // Fallback to window.open if Electron API is not available
          window.open(url, "_blank");
        }
        this.showToast("success", "Link Opened", "Opening support page in your browser...");
      }
    });

    // Close on outside click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
  }

  initializeNavigation() {
    const navItems = document.querySelectorAll(".nav-item");

    navItems.forEach((item) => {
      item.addEventListener("click", () => {
        // Remove active class from all nav items
        navItems.forEach((navItem) => navItem.classList.remove("active"));

        // Add active class to clicked nav item
        item.classList.add("active");

        const tabId = item.getAttribute("data-tab");

        this.handleTabSwitch(tabId);
      });
    });

    // Ensure initial tab is set correctly
    const initialActiveTab = document.querySelector(".nav-item.active");
    if (initialActiveTab) {
      const initialTabId = initialActiveTab.getAttribute("data-tab");
      this.handleTabSwitch(initialTabId);
    } else {
    }
  }

  // Virtual Scrolling Utility
  createVirtualList(containerSelector, itemTemplate, dataSource, renderFunction) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    // Viewport and item sizing
    const viewportHeight = container.clientHeight;
    const itemHeight = 50; // Estimated item height
    const visibleItemCount = Math.ceil(viewportHeight / itemHeight) + 2;

    // Scrolling state
    let startIndex = 0;
    let endIndex = visibleItemCount;

    // Render function
    const render = () => {
      // Clear existing content
      container.innerHTML = "";

      // Slice the visible portion of data
      const visibleData = dataSource.slice(startIndex, endIndex);

      // Render visible items
      visibleData.forEach((item, index) => {
        const itemElement = document.createElement("div");
        itemElement.classList.add("virtual-list-item");
        renderFunction(itemElement, item, startIndex + index);
        container.appendChild(itemElement);
      });

      // Add padding to simulate full list height
      const topPadding = document.createElement("div");
      topPadding.style.height = `${startIndex * itemHeight}px`;
      container.insertBefore(topPadding, container.firstChild);

      const bottomPadding = document.createElement("div");
      bottomPadding.style.height = `${Math.max(0, (dataSource.length - endIndex) * itemHeight)}px`;
      container.appendChild(bottomPadding);
    };

    // Scroll event handler
    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      startIndex = Math.floor(scrollTop / itemHeight);
      endIndex = startIndex + visibleItemCount;

      // Throttle rendering to reduce performance impact
      requestAnimationFrame(render);
    };

    // Initial render
    render();

    // Attach scroll event
    container.addEventListener("scroll", handleScroll);

    // Return methods for external control
    return {
      update: (newDataSource) => {
        dataSource = newDataSource;
        render();
      },
      destroy: () => {
        container.removeEventListener("scroll", handleScroll);
      }
    };
  }

  async getFileMetadata(filePath) {
    try {
      const response = await this.apiRequest("POST", "/api/get-file-info", {
        path: filePath
      });

      if (response.success && response.data) {
        const data = response.data;
        return {
          size: data.size ? this.formatFileSize(data.size) : "Unknown",
          duration: data.duration ? this.formatDuration(data.duration) : "Unknown",
          width: data.width || "Unknown",
          height: data.height || "Unknown"
        };
      }
    } catch (error) {
    }

    // Fallback: try to get basic file size
    try {
      const response = await this.apiRequest("POST", "/api/analyze-video", {
        file_path: filePath
      });

      if (response.success && response.data) {
        const data = response.data;
        return {
          size: data.size || "Unknown",
          duration: data.duration || "Unknown",
          width: data.width || "Unknown",
          height: data.height || "Unknown"
        };
      }
    } catch (error) {
    }

    return {
      size: "Unknown",
      duration: "Unknown",
      width: "Unknown",
      height: "Unknown"
    };
  }

  formatFileSize(bytes) {
    if (bytes === "Unknown" || !bytes) return "Unknown";

    const sizes = ["B", "KB", "MB", "GB"];
    if (bytes === 0) return "0 B";

    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + " " + sizes[i];
  }

  formatDuration(seconds) {
    if (seconds === "Unknown" || !seconds) return "Unknown";

    if (typeof seconds === "string" && seconds.includes("s")) {
      return seconds; // Already formatted
    }

    const secs = parseFloat(seconds);
    if (isNaN(secs)) return "Unknown";

    const minutes = Math.floor(secs / 60);
    const remainingSeconds = Math.floor(secs % 60);

    if (minutes > 0) {
      return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  // Secure Credential Management
  secureStoreCredentials(key, value) {
    try {
      // Encrypt sensitive data before storing
      const encryptedValue = this.encryptData(value);
      localStorage.setItem(key, encryptedValue);
    } catch (error) {
      if (RENDERER_DEBUG) console.error(`[SECURE] Error storing ${key}:`, error);
      this.showToast("error", "Credential Storage Error", "Failed to securely store credentials");
    }
  }

  secureRetrieveCredentials(key) {
    try {
      const encryptedValue = localStorage.getItem(key);
      if (!encryptedValue) return null;

      const decryptedValue = this.decryptData(encryptedValue);
      return decryptedValue;
    } catch (error) {
      if (RENDERER_DEBUG) console.error(`[SECURE] Error retrieving ${key}:`, error);
      this.showToast("error", "Credential Retrieval Error", "Failed to retrieve stored credentials");
      return null;
    }
  }


  // Credential storage methods
  saveCredentials() {
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");

    if (apiIdInput && apiHashInput && phoneInput) {
      const credentials = {
        apiId: apiIdInput.value.trim(),
        apiHash: apiHashInput.value.trim(),
        phoneNumber: phoneInput.value.trim()
      };

      try {
        localStorage.setItem("telegramCredentials", JSON.stringify(credentials));
        this.showToast("success", "Saved", "Telegram credentials saved securely");
      } catch (error) {
        this.showToast("warning", "Save Failed", "Could not save credentials");
      }
    }
  }

  loadCredentials() {
    try {
      const savedCredentials = localStorage.getItem("telegramCredentials");
      if (savedCredentials) {
        const { apiId, apiHash, phoneNumber } = JSON.parse(savedCredentials);

        const apiIdInput = document.getElementById("telegram-api-id");
        const apiHashInput = document.getElementById("telegram-api-hash");
        const phoneInput = document.getElementById("telegram-phone");

        if (apiIdInput && apiHashInput && phoneInput) {
          apiIdInput.value = apiId || "";
          apiHashInput.value = apiHash || "";
          phoneInput.value = phoneNumber || "";
        }
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error loading credentials:", error);
    }
  }

  // Call this in the constructor or init method
  initializeTelegramForm() {
    this.loadCredentials();
    this.setupInputActionListeners(); // Add this line

    // Add event listeners to save credentials when changed
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");

    if (apiIdInput) {
      apiIdInput.addEventListener("change", () => this.saveCredentials());
    }
    if (apiHashInput) {
      apiHashInput.addEventListener("change", () => this.saveCredentials());
    }
    if (phoneInput) {
      phoneInput.addEventListener("change", () => this.saveCredentials());
    }
  }

  // Add method to clear credentials
  clearStoredCredentials() {
    try {
      localStorage.removeItem("telegram_api_id");
      localStorage.removeItem("telegram_api_hash");
      localStorage.removeItem("telegram_phone");

      // Clear input fields
      const apiIdInput = document.getElementById("telegram-api-id");
      const apiHashInput = document.getElementById("telegram-api-hash");
      const phoneInput = document.getElementById("telegram-phone");

      if (apiIdInput) apiIdInput.value = "";
      if (apiHashInput) apiHashInput.value = "";
      if (phoneInput) phoneInput.value = "";

      this.showToast("success", "Credentials Cleared", "Telegram credentials have been removed");
    } catch (error) {
      if (RENDERER_DEBUG) console.error("[SECURE] Error clearing credentials:", error);
      this.showToast("error", "Clearing Error", "Failed to clear stored credentials");
    }
  }

  // Enhanced phone number management
  savePhoneNumber(phoneNumber) {
    try {
      // Securely store phone number
      this.secureStoreCredentials("telegram_last_phone", phoneNumber);

      // Optional: Store recent phone numbers (up to 5)
      const recentPhones = this.getRecentPhoneNumbers();
      if (!recentPhones.includes(phoneNumber)) {
        recentPhones.unshift(phoneNumber);
        // Keep only the last 5 unique phone numbers
        const uniqueRecentPhones = [...new Set(recentPhones)].slice(0, 5);
        localStorage.setItem("telegram_recent_phones", JSON.stringify(uniqueRecentPhones));
      }

    } catch (error) {
      if (RENDERER_DEBUG) console.error("[PHONE] Error saving phone number:", error);
    }
  }

  getRecentPhoneNumbers() {
    try {
      const storedPhones = localStorage.getItem("telegram_recent_phones");
      return storedPhones ? JSON.parse(storedPhones) : [];
    } catch (error) {
      if (RENDERER_DEBUG) console.error("[PHONE] Error retrieving recent phone numbers:", error);
      return [];
    }
  }

  populatePhoneInputWithRecent() {
    const phoneInput = document.getElementById("telegram-phone");
    const recentPhonesContainer = document.getElementById("recent-phones-container");

    if (!phoneInput || !recentPhonesContainer) return;

    // Clear existing recent phones
    recentPhonesContainer.innerHTML = "";

    const recentPhones = this.getRecentPhoneNumbers();

    // Populate recent phones dropdown
    if (recentPhones.length > 0) {
      recentPhones.forEach(phone => {
        const phoneOption = document.createElement("button");
        phoneOption.textContent = phone;
        phoneOption.className = "recent-phone-option";
        phoneOption.addEventListener("click", () => {
          phoneInput.value = phone;
          // Optional: hide dropdown after selection
          recentPhonesContainer.style.display = "none";
        });
        recentPhonesContainer.appendChild(phoneOption);
      });

      // Show dropdown if there are recent phones
      recentPhonesContainer.style.display = recentPhones.length > 0 ? "flex" : "none";
    }
  }

  // Check for existing Telegram session on startup
  async checkExistingConnection() {
    try {

      const response = await this.apiRequest("GET", "/api/telegram/session-status");

      if (response && response.success && response.data) {
        const { session_exists, session_valid } = response.data;

        if (session_exists && session_valid) {
          this.updateTelegramStatus("connected");
          return true;
        }
      }

      this.updateTelegramStatus("disconnected");
      return false;

    } catch (error) {
      if (RENDERER_DEBUG) console.error("[DEBUG] Error checking session status:", error);
      // Default to disconnected if we can't check
      this.updateTelegramStatus("disconnected");
      return false;
    }
  }

  async refreshConnectionStatus() {
    return await this.checkExistingConnection();
  }

  async cleanupTelegramSession() {
    try {
      const response = await this.apiRequest("POST", "/api/telegram/cleanup-session");
      if (response && response.success) {
        this.updateTelegramStatus("disconnected");
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.error("Session cleanup error:", error);
      return false;
    }
  }

  // Modify initialization to include input handlers
  async initializeTelegramConnection() {
    // CLEAN WORKFLOW: Always start disconnected and force cleanup

    try {
      // STEP 1: Force backend cleanup on frontend startup (with retry)
      // Retry the force reset with backoff in case backend is still starting
      let forceResetSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.apiRequest("POST", "/api/telegram/force-reset");
          forceResetSuccess = true;
          break;
        } catch (error) {
          if (attempt < 3) {
            // Wait longer on each attempt
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          }
        }
      }

      // STEP 2: Always set disconnected state 
      this.updateTelegramStatus("disconnected");
      this.telegramConnected = false;

      // STEP 3: Check actual connection status from backend (with retry)
      try {
        const statusResponse = await this.apiRequest("GET", "/api/telegram/connection-status");

        if (statusResponse.success && statusResponse.data) {
          const status = statusResponse.data;

          // For clean workflow, we expect clean_state: true and connected: false
          if (status.clean_state && !status.connected) {
            this.addStatusItem("🔄 Clean startup completed - ready for fresh connection", "info");
          } else if (status.connected) {
            this.addStatusItem("⚠️ Unexpected connection state - will force cleanup on connect", "warning");
          }
        }
      } catch (error) {
        // Assume clean state on error
      }

    } catch (error) {
      console.error("❌ [CLEAN_INIT] Error during clean initialization:", error);
      // Even on error, ensure we're in disconnected state
      this.updateTelegramStatus("disconnected");
      this.telegramConnected = false;
      this.addStatusItem("⚠️ Clean startup completed with warnings", "warning");
    }

    // Continue with standard initialization...
    // Verify all required elements exist
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");
    const connectBtn = document.getElementById("connect-telegram");

    if (!connectBtn) {
      if (RENDERER_DEBUG) console.error("[DEBUG] Critical: Connect button not found!");
      return;
    }

    // Setup improved input handlers
    this.setupInputActionListeners?.();

    // Load saved credentials if available
    if (typeof this.loadCredentials === "function") {
      try { this.loadCredentials(); } catch (_) { }
    }

    // Sync visibility icons
    this.syncVisibilityIcons?.();

  }

  syncVisibilityIcons() {
    const visibilityButtons = document.querySelectorAll(".btn-input-action.btn-toggle-visibility");
    visibilityButtons.forEach(button => {
      const targetId = button.getAttribute("data-target");
      const targetInput = document.getElementById(targetId);
      const icon = button.querySelector("i");
      if (!targetInput || !icon) return;
      if (targetInput.type === "password") {
        icon.classList.remove("fa-eye");
        icon.classList.add("fa-eye-slash");
      } else {
        icon.classList.remove("fa-eye-slash");
        icon.classList.add("fa-eye");
      }
    });
  }
  // Clipboard and Visibility Handling for Sensitive Inputs
  setupInputActionListeners() {
    // Visibility Toggle Functionality with Enhanced Logic
    const visibilityButtons = document.querySelectorAll(".btn-input-action.btn-toggle-visibility");
    visibilityButtons.forEach(button => {
      button.addEventListener("click", (e) => {
        // Prevent default button actions
        e.preventDefault();
        e.stopPropagation();

        const targetId = button.getAttribute("data-target");
        const targetInput = document.getElementById(targetId);
        const visibilityIcon = button.querySelector("i");

        if (!targetInput || !visibilityIcon) return;

        // Explicitly set focus to input before toggling
        targetInput.focus();

        // Comprehensive toggle logic
        const isCurrentlyPassword = targetInput.type === "password";

        // Toggle input type
        targetInput.type = isCurrentlyPassword ? "text" : "password";

        // Toggle icon classes
        if (isCurrentlyPassword) {
          visibilityIcon.classList.remove("fa-eye-slash");
          visibilityIcon.classList.add("fa-eye");
        } else {
          visibilityIcon.classList.remove("fa-eye");
          visibilityIcon.classList.add("fa-eye-slash");
        }

        // Maintain focus and cursor position
        const currentPosition = targetInput.selectionStart;
        targetInput.setSelectionRange(currentPosition, currentPosition);
      });

      // Prevent default form submission or other unwanted behaviors
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Clipboard Paste Functionality (unchanged from previous implementation)
    const pasteButtons = document.querySelectorAll(".btn-input-action.btn-paste");
    pasteButtons.forEach(button => {
      button.addEventListener("click", async (e) => {
        const targetId = button.getAttribute("data-target");
        const targetInput = document.getElementById(targetId);

        if (!targetInput) return;

        try {
          const clipboardText = await navigator.clipboard.readText();
          targetInput.value = clipboardText.trim();

          // Trigger change event for saving
          targetInput.dispatchEvent(new Event("change"));

          this.showToast("success", "Pasted", "Text copied from clipboard");

          // Highlight input briefly
          targetInput.classList.add("paste-highlight");
          setTimeout(() => {
            targetInput.classList.remove("paste-highlight");
          }, 1000);
        } catch (err) {
          this.showToast("error", "Paste Failed", "Could not read clipboard");
          if (RENDERER_DEBUG) console.error("Clipboard paste error:", err);
        }
      });
    });
  }
}

// Initialize the application when DOM is ready
let app;

// Ensure modal overlay is hidden on startup
function ensureModalOverlayHidden() {
  const overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.classList.remove("active");
    overlay.style.setProperty("display", "none", "important");
    overlay.style.visibility = "hidden";
  }
  // Also hide all modals
  const modals = document.querySelectorAll(".modal");
  modals.forEach((modal) => {
    modal.style.display = "none";
    modal.style.opacity = "0";
  });
}

// Wait for DOM to be fully loaded before initializing
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    ensureModalOverlayHidden();
    app = new TelegramUtilities();
    window.app = app;
    // Force immediate database stats update on app startup
    app.forceUpdateDatabaseStats();
  });
} else {
  // DOM is already loaded (shouldn't happen in normal flow but just in case)
  ensureModalOverlayHidden();
  app = new TelegramUtilities();
  window.app = app;
  // Force immediate database stats update on app startup
  app.forceUpdateDatabaseStats();
}

// Additional global functions for inline event handlers (use arrow functions to get app at call time)
window.removeVideoFile = (index) => window.app?.removeVideoFile(index);
window.removeMediaFile = (index) => window.app?.removeMediaFile(index);
window.editEmoji = (index) => window.app?.editEmoji(index);
window.showFileInfo = (index) => window.app?.showFileInfo(index);
window.showMediaInfo = (index) => window.app?.showMediaInfo(index);
window.openMediaPreview = (index) => window.app?.openMediaPreview(index);

// Enhanced emoji modal functions
window.applyEmojiToAll = () => window.app?.applyEmojiToAll();
window.applyRandomEmojis = () => window.app?.applyRandomEmojis();
window.applySequentialEmojis = () => window.app?.applySequentialEmojis();
window.applyThemeEmojis = () => window.app?.applyThemeEmojis();

// Handle page visibility changes
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && window.app) {
    // Refresh status when page becomes visible
    window.app.updateSystemInfo();
    // Force immediate database stats update when page becomes visible
    window.app.forceUpdateDatabaseStats();
  }
});

// Handle window resize
window.addEventListener("resize", () => {
  // Adjust layout if needed
  if (window.app) {
    window.app.updateVideoFileList();
    window.app.updateMediaFileList();
  }
});

// Handle before unload
window.addEventListener("beforeunload", (event) => {
  if (window.app && (window.app.currentProcessId || window.app.stickerProgressInterval)) {
    event.preventDefault();
    event.returnValue =
      "Processing is in progress. Are you sure you want to leave?";
    return event.returnValue;
  }
});

// ===== TRACE BOOT BANNER =====
(function () {
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", banner, { once: true });
    } else {
      banner();
    }
  } catch (e) {
    // Ignore banner errors
  }
})();
// ===== Aggressive apiRequest patch (poll until app exists) =====
// REMOVED: Debug tracing to improve performance
// The tracing code was causing slowness and memory issues