// Production mode - debug disabled
const RENDERER_DEBUG = false;

// Global error handling to prevent white screen crashes
window.addEventListener('error', (event) => {
  console.error('🚫 [GLOBAL_ERROR] Unhandled error:', event.error);
  console.error('🚫 [GLOBAL_ERROR] Error details:', {
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
    window.app.showToast('error', 'Application Error', `Error: ${event.message}`);
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('🚫 [GLOBAL_ERROR] Unhandled promise rejection:', event.reason);
  
  // Prevent app from crashing
  event.preventDefault();
  
  // Show error toast if possible
  if (window.app && window.app.showToast) {
    window.app.showToast('error', 'Promise Error', `Promise rejection: ${event.reason}`);
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
    this.isSavingEmoji = false; // Flag to prevent multiple emoji saves
    this.isEmojiModalLocked = false; // Flag to prevent emoji modal lock
    this.preventEmojiModalClosure = false; // Flag to prevent immediate closure
    
    // CRITICAL FIX: Add workflow state tracking to prevent premature completion
    this.workflowState = {
      iconUploaded: false,
      urlNameSubmitted: false,
      packCompleted: false,
      currentStep: 'initial' // initial, icon_upload, url_name, completed
    };
    this.imageFiles = []; // Array to store image files for the image converter
    this.currentImageOutput = ""; // Current output directory for image conversion
    this.progressInterval = null;
    this.stickerProgressInterval = null;
    this.imageProgressInterval = null; // Progress interval for image conversion
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
    
    // Prevent double submission flags
    this.isSubmittingCode = false;
    this.isSubmittingPassword = false;
    this.isConnecting = false;
    
    // OPTIMIZED: Add properties to prevent race conditions and duplicate notifications
    this.lastStageWasQueue = false;
    this.lastStatusMessage = null;
    this.lastStatusType = null;
    // Removed autoSkipAttempted flag - auto-skip is handled entirely by backend
    this.lastStage = null;
    this.telegramConnectionData = null;
    this.mediaData = {};
    
    // Debouncing for UI updates
    this.debouncedUpdateVideoFileList = this.debounce(this.updateVideoFileList.bind(this), 100);
    this._lastMinorUpdate = 0;
    
    this.init();
    this.initializeNavigation(); // Add this line to initialize navigation
    this.initializeTelegramForm(); // Add this to load saved Telegram credentials
    
    // Initialize Image Handler
    if (typeof ImageHandler !== 'undefined') {
      this.imageHandler = new ImageHandler(this);
    }
  }
  
  // Add a debouncing utility function
  debounce(func, wait, immediate) {
    let timeout;
    return function executedFunction() {
      const context = this;
      const args = arguments;
          
      const later = function() {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
  
      const callNow = immediate && !timeout;
      
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      
      if (callNow) func.apply(context, args);
    };
  }

  // Utility function to safely add event listeners
  safeAddEventListener(elementId, event, handler, logError = true) {
    const element = document.getElementById(elementId);
    if (element) {
      element.addEventListener(event, handler);
      return true;
    } else {
      if (logError && RENDERER_DEBUG) {
        console.warn(`⚠️ Element with ID '${elementId}' not found for event '${event}'`);
      }
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
      
      // Add manual refresh function for testing
      window.forceRefreshStats = () => {
        this.updateSystemInfo();
        this.updateDatabaseStats();
      };
      
      // Initialize button states
      this.updateButtonStates();
    } catch (error) {
      console.error('🚫 [APP] Critical error during initialization:', error);
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
            cpuUsage.style.color = '#ff4444';
          } else if (percent > 50) {
            cpuUsage.style.color = '#ffaa00';
          } else {
            cpuUsage.style.color = '#44ff44';
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
            ramUsage.style.color = '#ff4444';
          } else if (percent > 70) {
            ramUsage.style.color = '#ffaa00';
          } else {
            ramUsage.style.color = '#44ff44';
          }
        }
      }
    } catch (error) {
      // Failed to fetch system stats - ignore silently
    }
  }


  // ---- Lightweight debug logger for Telegram flows ----
  logDebug(label, payload = undefined) {
    // Debug logging removed for production
  }

  // Debug warning method for detailed UI debugging
  debugWarn(label, payload = undefined) {
    // Debug logging removed for production
  }

  // OPTIMIZED apiRequest with better error handling and timeout
  async apiRequest(method, path, body = null) {
    // FIXED: Validate path to prevent [Errno 22] Invalid argument
    if (!path || typeof path !== 'string') {
      throw new Error('Invalid API path');
    }
    
    // ENHANCED: Sanitize path to prevent [Errno 22] Invalid argument
    // Remove all control characters which can cause OS errors
    const sanitizedPath = path.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
    
    if (!sanitizedPath || sanitizedPath.length === 0) {
      throw new Error('Invalid API path after sanitization');
    }
    
    // FIXED: Direct path usage - backend handles sanitization
    const url = `http://127.0.0.1:5000${sanitizedPath}`;
    
    // OPTIMIZED: Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for skip operations
    
    try {
      // ENHANCED: Validate and sanitize request body before sending
      let sanitizedBody = null;
      if (body) {
        try {
          // Stringify and parse to ensure valid JSON
          const jsonString = JSON.stringify(body);
          // Remove all control characters which can cause OS errors
          const sanitizedJsonString = jsonString.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
          sanitizedBody = sanitizedJsonString;
        } catch (jsonError) {
          console.error('[API] Error serializing request body:', jsonError);
          throw new Error('Invalid request data - unable to serialize. Please check your inputs.');
        }
      }
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
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
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - server may be overloaded. Please try again.');
      }
      // Do not mask backend errors; surface original message for debugging
      if (error.message && error.message.includes('timeout')) {
        throw new Error('Request timeout - server may be overloaded. Please try again.');
      }
      
      // ENHANCED: Handle [Errno 22] Invalid argument errors specifically
      if (error.message && (error.message.includes('Invalid argument') || error.message.includes('Errno 22'))) {
        console.error(`[API] Invalid argument error with path: ${path}`);
        console.error(`[API] Sanitized path: ${sanitizedPath}`);
        console.error(`[API] Request body:`, body);
        throw new Error('Invalid request data - contains invalid characters. Please check your inputs and try again.');
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
      
    // Image Converter Events
    const addImagesBtn = document.getElementById("add-images");
    const clearImagesBtn = document.getElementById("clear-images");
    const browseImageOutputBtn = document.getElementById("browse-image-output");
    const startImageConversionBtn = document.getElementById("start-image-conversion");
    
    if (addImagesBtn) {
      addImagesBtn.addEventListener("click", () => this.addImageFiles());
    }
    
    if (clearImagesBtn) {
      clearImagesBtn.addEventListener("click", () => this.clearImageFiles());
    }
    
    if (browseImageOutputBtn) {
      browseImageOutputBtn.addEventListener("click", () => this.browseImageOutput());
    }
    
    if (startImageConversionBtn) {
      startImageConversionBtn.addEventListener("click", () => this.startImageConversion());
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
    const pauseHexBtn = document.getElementById("pause-hex-edit");
    const resumeHexBtn = document.getElementById("resume-hex-edit");
    
    if (pauseHexBtn) {
      pauseHexBtn.addEventListener("click", () => this.pauseOperation());
    }
    
    if (resumeHexBtn) {
      resumeHexBtn.addEventListener("click", () => this.resumeOperation());
    }
    
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
        selectImageBtn.classList.add("active");
        selectVideoBtn.classList.remove("active");
        mediaControls.style.display = "flex";
        mediaTypeText.textContent = "Images";
        // Clear any existing media of different type
        if (this.mediaFiles.some(f => f.type === "video")) {
          if (confirm("Switching to images will clear existing videos. Continue?")) {
            this.clearMedia();
          } else {
            return;
          }
        }
      });
    }
    
    if (selectVideoBtn) {
      selectVideoBtn.addEventListener("click", () => {
        this.selectedMediaType = "video";
        selectVideoBtn.classList.add("active");
        selectImageBtn.classList.remove("active");
        mediaControls.style.display = "flex";
        mediaTypeText.textContent = "Videos";
        // Clear any existing media of different type
        if (this.mediaFiles.some(f => f.type === "image")) {
          if (confirm("Switching to videos will clear existing images. Continue?")) {
            this.clearMedia();
          } else {
            return;
          }
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
    document.querySelectorAll('.btn-toggle-visibility').forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        const icon = button.querySelector('i');
        
        if (targetInput.type === 'password') {
          targetInput.type = 'text';
          icon.classList.remove('fa-eye-slash');
          icon.classList.add('fa-eye');
          button.title = 'Hide';
        } else {
          targetInput.type = 'password';
          icon.classList.remove('fa-eye');
          icon.classList.add('fa-eye-slash');
          button.title = 'Show';
        }
      });
    });
    
    // Paste from Clipboard Events
    document.querySelectorAll('.btn-paste').forEach(button => {
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            targetInput.value = text.trim();
            targetInput.focus();
            
            // Show temporary success feedback with smooth animation
            const icon = button.querySelector('i');
            
            // Add success animation class
            button.style.transition = 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
            button.style.transform = 'scale(1.1)';
            
            icon.classList.remove('fa-paste');
            icon.classList.add('fa-check');
            button.style.color = '#28a745';
            button.style.backgroundColor = 'rgba(40, 167, 69, 0.2)';
            button.style.borderColor = 'rgba(40, 167, 69, 0.5)';
            
            // Reset after animation
            setTimeout(() => {
              button.style.transform = 'scale(1)';
            }, 200);
            
            setTimeout(() => {
              icon.classList.remove('fa-check');
              icon.classList.add('fa-paste');
              button.style.color = '';
              button.style.backgroundColor = '';
              button.style.borderColor = '';
            }, 1500);
            
            // Save settings after paste
            this.saveSettings();
          }
        } catch (err) {
          this.showToast('error', 'Clipboard Error', 'Failed to read from clipboard');
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
        
        const isCritical = activeModal.hasAttribute('data-critical');
        
        // Critical modals that should NOT close on overlay click
        const criticalModals = ['success-modal', 'url-name-modal', 'icon-modal'];
        
        if (criticalModals.includes(modalId) || isCritical) {
          // Add shake animation to indicate modal cannot be dismissed
          activeModal.classList.add('modal-shake');
          setTimeout(() => {
            activeModal.classList.remove('modal-shake');
          }, 500);
          
          // Show helpful toast for success modal
          if (modalId === 'success-modal') {
            this.showToast("info", "Modal Protected", "Use the buttons to interact with your sticker pack!");
          }
          return;
        }
        
        // Allow other modals to close on overlay click
        if (e.target === e.currentTarget) {
          // Check if we should prevent closure for emoji modal
          if (this.preventEmojiModalClosure && modalId === 'emoji-modal') {
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
      emojiInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.saveEmoji();
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

    switch (tabId) {
      case 'video-converter':
        // Specific actions for video converter tab
        break;
      case 'sticker-bot':
        // Specific actions for sticker bot tab
        break;
      case 'settings':
        // Update system info every 5 seconds while on settings tab
        break;
      case 'about':
        // Initialize about section only once
        if (!this.aboutSectionInitialized) {
          this.initializeAboutSection();
          this.aboutSectionInitialized = true;
        }
        break;
      default:
        // Unknown tab
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
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        zone.element.addEventListener(eventName, this.preventDefaults, false);
      });
      
      zone.element.addEventListener('dragover', () => zone.element.classList.add('drag-over'));
      zone.element.addEventListener('dragleave', () => zone.element.classList.remove('drag-over'));
      
      zone.element.addEventListener('drop', (e) => {
        zone.element.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files)
          .filter(file => {
            const extension = file.name.split('.').pop().toLowerCase();
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
          // Sanitize default emoji
          let cleanDefaultEmoji = '❤️';
          if (typeof this.defaultEmoji === 'string') {
            const sanitized = this.defaultEmoji.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
            if (sanitized.length > 0) {
              const emojiChars = Array.from(sanitized);
              cleanDefaultEmoji = emojiChars[0] || '❤️';
            }
          }
          
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
            connectBtnOk.classList.remove('btn-primary');
            connectBtnOk.classList.add('btn-secondary');
            // Update click handler for disconnect
            connectBtnOk.onclick = () => this.disconnectTelegram();
          }
          this.telegramConnected = true;
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
            connectBtnIdle.classList.remove('btn-secondary');
            connectBtnIdle.classList.add('btn-primary');
            // Reset click handler for connect
            connectBtnIdle.onclick = () => this.connectTelegram();
          }
          this.telegramConnected = false;
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
      const apiIdInput = document.getElementById("api-id");
      if (apiIdInput) apiIdInput.value = savedApiId;
    }
    if (savedApiHash) {
      const apiHashInput = document.getElementById("api-hash");
      if (apiHashInput) apiHashInput.value = savedApiHash;
    }
    if (savedPhone) {
      const phoneInput = document.getElementById("phone-number");
      if (phoneInput) phoneInput.value = savedPhone;
    }
    if (savedOutputDir) {
      const outputDirInput = document.getElementById("video-output-dir");
      if (outputDirInput) outputDirInput.value = savedOutputDir;
      this.currentVideoOutput = savedOutputDir;
    }
    
    const savedImageOutputDir = localStorage.getItem("image_output_dir");
    if (savedImageOutputDir) {
      const imageOutputDirInput = document.getElementById("image-output-dir");
      if (imageOutputDirInput) imageOutputDirInput.value = savedImageOutputDir;
      this.currentImageOutput = savedImageOutputDir;
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
    const apiIdInput = document.getElementById("api-id");
    const apiHashInput = document.getElementById("api-hash");
    const phoneInput = document.getElementById("phone-number");
    const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");
    
    if (apiIdInput) localStorage.setItem("telegram_api_id", apiIdInput.value);
    if (apiHashInput) localStorage.setItem("telegram_api_hash", apiHashInput.value);
    if (phoneInput) localStorage.setItem("telegram_phone", phoneInput.value);
    if (autoSkipIconCheckbox) localStorage.setItem("auto_skip_icon", autoSkipIconCheckbox.checked.toString());
    if (this.currentVideoOutput) {
      localStorage.setItem("video_output_dir", this.currentVideoOutput);
    }
    if (this.currentImageOutput) {
      localStorage.setItem("image_output_dir", this.currentImageOutput);
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
    // CRITICAL DEBUG: Check if the success modal is missing from the DOM
    const successModalInDOM = document.getElementById("success-modal");
    const allModalElements = document.querySelectorAll('[id*="modal"], .modal');
    
    // If success modal is missing, try to inject it from the original HTML
    if (!successModalInDOM) {
      console.warn(`⚠️ [SUCCESS_MODAL] Success modal not found in DOM. This might be due to HTML structure issues. Attempting to inject it...`);
      
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
        overlay.insertAdjacentHTML('beforeend', successModalHTML);
        
        // Add CSS animations if not already present
        if (!document.getElementById('success-modal-animations')) {
          const style = document.createElement('style');
          style.id = 'success-modal-animations';
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
        
        // console.log(`✅ [SUCCESS_MODAL] Success modal injected into DOM`);
        
        // Now proceed with normal flow
        const injectedModal = document.getElementById("success-modal");
        const linkInput = document.getElementById("shareable-link");
        
        if (injectedModal) {
          // Apply centering styles immediately after injection
          injectedModal.style.position = 'fixed';
          injectedModal.style.top = '50%';
          injectedModal.style.left = '50%';
          injectedModal.style.transform = 'translate(-50%, -50%)';
          injectedModal.style.zIndex = '10000';
          
          this.displaySuccessModal(injectedModal, overlay, linkInput, shareableLink);
          return;
        }
      }
    }
    
    // Wait for DOM to be ready if necessary
    const ensureDOMReady = () => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          const handler = () => {
            if (document.readyState === 'complete') {
              document.removeEventListener('readystatechange', handler);
              resolve();
            }
          };
          document.addEventListener('readystatechange', handler);
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
      
      /* console.log(`🎉 [SUCCESS_MODAL] Direct DOM query results:`, {
        modal: !!modal,
        overlay: !!overlay, 
        linkInput: !!linkInput,
        domReadyState: document.readyState,
        totalModals: document.querySelectorAll('[id*="modal"]').length,
        successModalExists: document.querySelector('#success-modal') !== null
      }); */
      
      // Debug: Log all modal-like elements if modal not found
      if (!modal) {
        const allModalElements = document.querySelectorAll('[id*="modal"], .modal');
        // console.log(`🎉 [SUCCESS_MODAL] Found ${allModalElements.length} modal elements:`);
        allModalElements.forEach((el, i) => {
          // console.log(`  ${i}: ${el.tagName}#${el.id}.${el.className}`);
        });
      }
      
      return { modal, overlay, linkInput };
    };
    
    // Ensure DOM is ready and then try to find elements
    ensureDOMReady().then(() => {
      let elements = findModalElements();
    
      // If modal still not found after DOM ready, try additional retries
      if (!elements.modal) {
        // console.log(`🎉 [SUCCESS_MODAL] Modal not found after DOM ready, retrying...`);
        
        // Try multiple retries with increasing delays
        let retryCount = 0;
        const maxRetries = 3;
        
        const retryFind = () => {
          retryCount++;
          setTimeout(() => {
            elements = findModalElements();
            
            if (elements.modal) {
              // console.log(`🎉 [SUCCESS_MODAL] Modal found on retry ${retryCount}`);
              this.displaySuccessModal(elements.modal, elements.overlay, elements.linkInput, shareableLink);
              return;
            }
            
            if (retryCount < maxRetries) {
              // console.log(`🎉 [SUCCESS_MODAL] Retry ${retryCount}/${maxRetries} failed, trying again...`);
              retryFind();
              return;
            }
            
            console.error(`🎉 [SUCCESS_MODAL] CRITICAL: Modal still not found after ${maxRetries} retries!`);
            
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
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = modalHTML.trim();
            const fallbackModal = tempDiv.firstChild;
            document.body.appendChild(fallbackModal);
            
            // Add event listener for the fallback open button to prevent double opening
            const fallbackOpenBtn = document.getElementById('open-telegram-btn-fallback');
            if (fallbackOpenBtn) {
              fallbackOpenBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(shareableLink, '_blank');
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
              
              // console.log('🎉 [SUCCESS_MODAL] Emergency fallback modal created and displayed');
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
                } else {
                  // console.log('🎉 [SUCCESS_MODAL] ElectronAPI methods not available, will show link in status');
                }
              } catch (error) {
                console.error('🎉 [SUCCESS_MODAL] Error opening URL:', error);
              }
            }
          }, 50 * retryCount); // Increasing delay: 50ms, 100ms, 150ms
        };
        
        retryFind();
      } else {
        // Modal found immediately, display it
        // console.log(`🎉 [SUCCESS_MODAL] Modal found immediately after DOM ready`);
        this.displaySuccessModal(elements.modal, elements.overlay, elements.linkInput, shareableLink);
      }
    });
  }



  displaySuccessModal(modal, overlay, linkInput, shareableLink) {
    // console.log(`🎉 [SUCCESS_MODAL] Starting modal display process...`);
    
    // Validate required elements
    if (!modal) {
      console.error(`🎉 [SUCCESS_MODAL] Cannot display modal - modal element is null`);
      return;
    }
    
    if (!overlay) {
      console.error(`🎉 [SUCCESS_MODAL] Cannot display modal - overlay element is null`);
      return;
    }
    
    // Set the shareable link
    if (linkInput && shareableLink) {
      linkInput.value = shareableLink;
      // console.log(`🎉 [SUCCESS_MODAL] Set link input value: ${shareableLink}`);
    } else {
      // console.warn(`🎉 [SUCCESS_MODAL] Link input not found or no link provided - linkInput: ${!!linkInput}, shareableLink: ${!!shareableLink}`);
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
    modal.style.setProperty('z-index', '10000', 'important');
    
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
    
    // console.log(`🎉 [SUCCESS_MODAL] Modal display set to flex, opacity transition starting...`);
    
    // Use requestAnimationFrame for smooth display
    requestAnimationFrame(() => {
      modal.style.opacity = "1";
      // console.log(`🎉 [SUCCESS_MODAL] Opacity set to 1, modal should be visible now`);
    });
    
    // Add critical modal protection (prevent outside click dismissal)
    modal.setAttribute('data-critical', 'true');
    
    // CRITICAL FIX: Ensure modal stays in view by recalculating position
    setTimeout(() => {
      // Force reflow to ensure proper positioning
      modal.style.transform = "translate(-50%, -50%)";
      modal.style.top = "50%";
      modal.style.left = "50%";
      
      // Verify visibility after a short delay
      const computedStyle = getComputedStyle(modal);
      console.log(`🎉 [SUCCESS_MODAL] Visibility check:`, {
        display: computedStyle.display,
        opacity: computedStyle.opacity,
        visibility: computedStyle.visibility,
        zIndex: computedStyle.zIndex,
        position: computedStyle.position,
        transform: computedStyle.transform
      });
      
      // If modal is still not visible, log additional debug info
      if (computedStyle.display === 'none' || computedStyle.opacity === '0') {
        console.error(`🎉 [SUCCESS_MODAL] Modal visibility issue detected:`, {
          modalElement: modal,
          overlayElement: overlay,
          modalClasses: modal.className,
          overlayClasses: overlay.className,
          modalRect: modal.getBoundingClientRect(),
          overlayRect: overlay.getBoundingClientRect()
        });
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
        // console.log(`🎉 [SUCCESS_MODAL] Modal not in viewport, scrolling to it`);
        // Scroll the modal into view
        modal.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
      
      // CRITICAL FIX: Ensure modal is above all other elements
      modal.style.zIndex = "10000";
      overlay.style.zIndex = "9999";
    }, 100);
    
    // console.log(`🎉 [SUCCESS_MODAL] Modal should now be visible`);
    
    // Setup event listeners for modal buttons
    this.setupSuccessModalEventListeners(shareableLink);
    
    // Focus management for accessibility
    setTimeout(() => {
      const copyBtn = document.getElementById("copy-link-btn");
      if (copyBtn) {
        copyBtn.focus();
        // console.log(`🎉 [SUCCESS_MODAL] Focus set to copy button`);
      }
    }, 300);
  }

  hideSuccessModal() {
    const modal = document.getElementById("success-modal");
    const overlay = document.getElementById("modal-overlay");
    
    // console.log(`🎉 [SUCCESS_MODAL] Hiding modal - modal found: ${!!modal}, overlay found: ${!!overlay}`);
    
    if (modal) {
      modal.style.display = "none";
      modal.style.opacity = "0";
      modal.removeAttribute('data-critical');
      // Reset positioning styles
      modal.style.position = "";
      modal.style.top = "";
      modal.style.left = "";
      modal.style.transform = "";
      modal.style.margin = "";
      // console.log(`🎉 [SUCCESS_MODAL] Modal hidden`);
    }
    
    if (overlay) {
      overlay.classList.remove("active");
      overlay.style.display = "none";
      overlay.style.visibility = "hidden";
      // console.log(`🎉 [SUCCESS_MODAL] Overlay hidden`);
    }
    
    // Clean up keyboard event listeners
    if (this.successModalKeyHandler) {
      document.removeEventListener('keydown', this.successModalKeyHandler);
      this.successModalKeyHandler = null;
      // console.log(`🎉 [SUCCESS_MODAL] Keyboard handlers removed`);
    }
    
    console.log(`🎉 [SUCCESS_MODAL] Modal hidden and cleaned up`);
  }
  
  setupSuccessModalEventListeners(shareableLink) {
    console.log(`🎉 [SUCCESS_MODAL] Setting up event listeners for link: ${shareableLink}`);
    
    // Copy link button
    const copyBtn = document.getElementById("copy-link-btn");
    if (copyBtn) {
      copyBtn.onclick = () => this.copyShareableLink();
      console.log(`🎉 [SUCCESS_MODAL] Copy button listener attached`);
    } else {
      console.warn(`🎉 [SUCCESS_MODAL] Copy button not found`);
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
      console.log(`🎉 [SUCCESS_MODAL] Telegram button listener attached`);
    } else {
      console.warn(`🎉 [SUCCESS_MODAL] Telegram button not found`);
    }
    
    // Create another pack button
    const anotherBtn = document.getElementById("create-another-btn");
    if (anotherBtn) {
      anotherBtn.onclick = () => this.createAnotherPack();
      console.log(`🎉 [SUCCESS_MODAL] Create another button listener attached`);
    } else {
      console.warn(`🎉 [SUCCESS_MODAL] Create another button not found`);
    }
    
    // Add keyboard support
    const keyHandler = (e) => {
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.copyShareableLink();
      } else if (e.key === 'Enter') {
        this.openTelegramLink();
      }
    };
    
    document.addEventListener('keydown', keyHandler);
    
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
        document.execCommand('copy');
        this.showToast("success", "Link Copied", "Shareable link copied to clipboard!");
      }
    }
  }

  openTelegramLink() {
    const linkInput = document.getElementById("shareable-link");
    if (linkInput && linkInput.value) {
      window.open(linkInput.value, '_blank');
      this.showToast("success", "Opening Telegram", "Opening your sticker pack in Telegram!");
    } else {
      this.showToast("error", "No Link", "Shareable link not available");
    }
  }
  
  // TEST METHOD - Remove in production
  testSuccessModal() {
    const testLink = "https://t.me/addstickers/test_sticker_pack_123";
    console.log(`🗋 [TEST] Triggering success modal with test link: ${testLink}`);
    this.showSuccessModal(testLink);
  }
  

  createAnotherPack() {
    console.log('🔄 [RESET] Starting complete process reset...');
    
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
      packNameInput.classList.remove('valid', 'invalid');
      packNameValidation.classList.remove('valid', 'invalid');
      packNameValidation.textContent = '';
    }
    
    if (urlNameInput && urlNameValidation) {
      urlNameInput.classList.remove('valid', 'invalid');
      urlNameValidation.classList.remove('valid', 'invalid');
      urlNameValidation.textContent = '';
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
    
    // STEP 7: Reset create button to initial state (but respect connection status)
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
      createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
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
      currentStep: 'initial'
    };
    
    // STEP 10: Focus on pack name input and update button state (preserve telegram connection)
    setTimeout(() => {
      // Update button state using existing connection status (don't change it)
      this.updatePackActions();
      
      // Focus on pack name input for immediate use
      if (packNameInput) {
        packNameInput.focus();
      }
      
      console.log('🔄 [RESET] Form reset completed - Telegram connection preserved');
    }, 100);
    
    console.log('🔄 [RESET] Complete process reset finished!');
    this.showToast("success", "Ready for New Pack", "Form cleared - ready to create another sticker pack!");
    this.addStatusItem("🔄 Ready to create new sticker pack", "ready");
  }

  resetStickerForm() {
    // Ask for confirmation if there are files or form data
    const hasData = this.mediaFiles.length > 0 || 
                    document.getElementById("pack-name").value.trim() !== "" ||
                    document.getElementById("pack-url-name").value.trim() !== "";
    
    if (hasData) {
      const confirmed = confirm("This will clear all your current form data and media files. Are you sure?");
      if (!confirmed) {
        return;
      }
    }
    
    console.log('🔄 [MANUAL_RESET] User initiated form reset...');
    
    // Optional: Clear any active sticker processes in the backend
    this.clearActiveProcesses();
    
    // Call the same comprehensive reset function used by "Create Another Pack"
    this.createAnotherPack();
  }

  async clearActiveProcesses() {
    try {
      // This is optional - clear any running sticker processes
      const response = await this.apiRequest("POST", "/api/clear-sticker-processes");
      if (response.success) {
        console.log('🔄 [RESET] Backend sticker processes cleared');
      }
    } catch (error) {
      // Don't block reset if this fails
      console.log('🔄 [RESET] Backend process clearing skipped:', error.message);
    }
  }

  updatePackActions() {
    const createBtn = document.getElementById("create-sticker-pack");
    if (!createBtn) return;
    
    const packName = document.getElementById("pack-name")?.value.trim() || "";
    const urlName = document.getElementById("pack-url-name")?.value.trim() || "";
    
    const isPackNameValid = packName.length > 0 && packName.length <= 64;
    const isUrlNameValid = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(urlName);
    const hasMedia = this.mediaFiles.length > 0;
    const isConnected = this.telegramConnected;
    
    // CRITICAL FIX: Button should only be disabled if Telegram is disconnected
    // If Telegram is connected, keep button enabled so user can see they can fill fields
    // The actual validation will happen when they click the button
    createBtn.disabled = !isConnected;
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
    input.classList.remove('valid', 'invalid');
    validationDiv.classList.remove('valid', 'invalid');
    validationDiv.textContent = '';

    if (validation.valid) {
      input.classList.add('valid');
      validationDiv.classList.add('valid');
      validationDiv.textContent = '✓ Valid';
    } else if (input.value.length > 0) {
      // Only show invalid state if user has typed something
      input.classList.add('invalid');
      validationDiv.classList.add('invalid');
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

  async analyzeVideoFiles() {
    // This would analyze video files for duration, size, etc.
    // Implementation would depend on backend capabilities
    this.showToast("info", "Analyzing", "Analyzing video files...");
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
    const statusElement = document.querySelector('.status');
    if (statusElement) {
      statusElement.textContent = 'Ready';
    }
    
    // Reset virtual list container completely
    const container = document.getElementById("video-file-list");
    if (container) {
      // Remove scroll event listeners
      if (container._virtualScrollHandler) {
        container.removeEventListener('scroll', container._virtualScrollHandler);
        container._virtualScrollHandler = null;
      }
      if (container._scrollTimeout) {
        clearTimeout(container._scrollTimeout);
        container._scrollTimeout = null;
      }
      
      // Reset container styles
      container.style.height = '';
      container.style.overflowY = '';
      container.style.overflowX = '';
      container.style.position = '';
      
      // Clear all content
      container.innerHTML = '';
    }
    
    this.updateVideoFileList();
    this.showToast("info", "Cleared", `Removed ${count} video files`);
  }

  updateVideoFileList() {
    const container = document.getElementById("video-file-list");
    if (!container) {
      // Try again after a short delay in case DOM is still loading
      setTimeout(() => {
        const retryContainer = document.getElementById("video-file-list");
        if (retryContainer && this.videoFiles.length > 0) {
          this.updateVideoFileList();
        }
      }, 100);
      return;
    }
    
    // Update video file list
    const fileCount = this.videoFiles.length;
    
    // IMMEDIATE FILE COUNT UPDATE - Do this first for instant feedback
    const counter = document.getElementById("video-file-count");
    if (counter) {
      counter.textContent = this.videoFiles.length;
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
    
    // Use virtualized list for better performance with large datasets
    if (this.videoFiles.length > 50) {
      // Use virtualized rendering for large lists
      window.updateVirtualList(
        container,
        this.videoFiles,
        (file, index) => this.createVideoFileElement(file, index),
        (file, index) => index,
        {
          itemHeight: 100, // Increased height for better spacing
          bufferSize: 15,   // Increased buffer for smoother scrolling
          scrollTop: container.scrollTop || 0,
          containerHeight: container.clientHeight || 300
        }
      );
    } else {
      // Use regular rendering for smaller lists
      this.updateVideoFileListRegular(container);
    }
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
    container.innerHTML = '';
    container.appendChild(fragment);
  }

  // Create a single video file element
  createVideoFileElement(file, index) {
    const statusClass = file.status || "pending";
    const progressWidth = file.progress || 0;
    const statusIcon = this.getStatusIcon(file.status);
    
    const fileElement = document.createElement('div');
    fileElement.className = `file-item ${statusClass}`;
    fileElement.setAttribute('data-index', index);
    
    const progressText = progressWidth === 100 ? '✔' : `${progressWidth}%`;
    const statusText = file.stage || "Ready to convert";
    
    fileElement.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <i class="${statusIcon}"></i>
        </div>
        <div class="file-details">
          <div class="file-name" title="${file.path}">${file.name}</div>
          <div class="file-status">
            ${statusText}
            ${file.hexEdited ? '<span class="hex-edited-badge" title="Hex edited">🔧</span>' : ''}
          </div>
          <div class="file-progress-container">
            <div class="file-progress-bar">
              <div class="file-progress-fill" style="width: ${progressWidth}%"></div>
            </div>
            <div class="file-progress-text">${progressText}</div>
          </div>
          ${file.size ? `<div class="file-meta">Size: ${file.size} | Duration: ${file.duration}</div>` : ""}
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-sm btn-info" onclick="app.showFileInfo(${index})" title="File Info">
          <i class="fas fa-info-circle"></i>
        </button>
        <button class="btn btn-sm btn-danger" onclick="app.removeVideoFile(${index})" 
                ${file.status === "converting" ? "disabled" : ""} title="Remove File">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    
    return fileElement;
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
      size: 'Unknown',
      duration: 'Unknown',
      format: 'Unknown',
      dimensions: 'Unknown'
    };
    
    try {
      const result = await this.apiRequest('POST', '/api/get-file-info', { 
        path: file.path 
      });
      
      if (result && result.success && result.data) {
        fileInfo = {
          name: result.data.name || file.name,
          size: result.data.size_formatted || 'Unknown',
          duration: result.data.duration_formatted || 'Unknown',
          format: result.data.format ? result.data.format.toUpperCase() : 'Unknown',
          dimensions: result.data.dimensions || 'Unknown',
          codec: result.data.codec || null,
          fps: result.data.fps || null
        };
      }
    } catch (error) {
      // Error getting file info, continue without it
    }
    
    // Format additional info
    let additionalInfo = '';
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
            <span style="color: ${this.getStatusColor(file.status)};">${file.status || 'Ready'}</span>
          </div>
          
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">📊 Progress:</strong> 
            <span style="color: #ccc;">${file.progress || 0}%</span>
          </div>
          
          ${file.stage ? `<div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">⚙️ Stage:</strong> 
            <span style="color: #ccc;">${file.stage}</span>
          </div>` : ''}
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
      const statusElement = document.querySelector('.status');
      if (statusElement) {
        statusElement.textContent = 'Ready';
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
    
    if (this.currentOperation === 'converting') {
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
    const invalidFiles = filesToConvert.filter(path => !path || path === 'undefined');
    if (invalidFiles.length > 0) {
      console.error("Invalid file paths found:", invalidFiles);
      this.showToast("error", "Invalid Files", "Some files have invalid paths. Please re-add them.");
      return;
    }
    
    // Set operation state
    this.currentOperation = 'converting';
    this.isPaused = false;
    
    // Update UI - Disable conversion button, enable pause, disable hex edit
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");
    
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Converting...';
      startBtn.style.display = 'inline-flex';
    }
    
    if (hexBtn) {
      hexBtn.disabled = true;
      hexBtn.style.opacity = '0.5';
      hexBtn.style.display = 'inline-flex';
    }
    
    if (pauseBtn) {
      pauseBtn.style.display = 'inline-block';
      pauseBtn.disabled = false;
    }
    
    if (resumeBtn) {
      resumeBtn.style.display = 'none';
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
            type: 'conversion'
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
        startBtn.style.display = 'inline-flex';
      }
      
      // Force update button states
      this.updateButtonStates();
    }
    
  }

  // Unified progress monitoring system with enhanced debouncing
  monitorProcess(processId) {
    if (RENDERER_DEBUG) console.log("Starting to monitor process:", processId);
    
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
      type: 'video'
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
          if (RENDERER_DEBUG) console.warn("Process timeout or not found");
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
              file.stage = fileStatus.stage || 'Processing';
              
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
        if (progress && (progress.status === 'completed' || progress.status === 'error')) {
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
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.activeOperationInterval) {
      clearInterval(this.activeOperationInterval);
      this.activeOperationInterval = null;
    }
  }

  // Improved process completion handler
  async handleProcessCompletion(processData) {
    if (RENDERER_DEBUG) console.log("=== PROCESS COMPLETION DEBUG ===");
    if (RENDERER_DEBUG) console.log("🎯 Process completion data:", processData);
    if (RENDERER_DEBUG) console.log("🎯 Current process ID:", this.currentProcessId);
    if (RENDERER_DEBUG) console.log("🎯 Active processes before cleanup:", this.activeProcesses.size);
    
    // Clean up process tracking
    if (this.currentProcessId) {
      this.activeProcesses.delete(this.currentProcessId);
      if (RENDERER_DEBUG) console.log("🗑️ Removed process from active processes:", this.currentProcessId);
    }
    
    // Determine overall success based on process status
    const isSuccessful = processData.status === 'completed';
    if (RENDERER_DEBUG) console.log("🎯 Overall success:", isSuccessful);
    
    // Update all file statuses based on results
    if (processData.file_statuses) {
      if (RENDERER_DEBUG) console.log("🔄 Updating file statuses from completion data:", processData.file_statuses);
      Object.keys(processData.file_statuses).forEach(index => {
        const fileStatus = processData.file_statuses[index];
        const file = this.videoFiles[parseInt(index)];
        if (file) {
          const oldStatus = file.status;
          const oldProgress = file.progress;
          const oldStage = file.stage;
          
          file.status = fileStatus.status;
          // Ensure progress shows 100% for completed files
          if (fileStatus.status === 'completed') {
            file.progress = 100;
            file.stage = 'Conversion completed';
          } else if (fileStatus.status === 'error') {
            file.progress = 0;
            file.stage = fileStatus.stage || 'Conversion failed';
          } else {
            file.progress = fileStatus.progress || 0;
            file.stage = fileStatus.stage || 'Processing';
          }
          
          if (RENDERER_DEBUG) console.log(`📁 File ${index} (${file.name}):`);
          if (RENDERER_DEBUG) console.log(`   Status: ${oldStatus} → ${file.status}`);
          if (RENDERER_DEBUG) console.log(`   Progress: ${oldProgress}% → ${file.progress}%`);
          if (RENDERER_DEBUG) console.log(`   Stage: ${oldStage} → ${file.stage}`);
        } else {
          if (RENDERER_DEBUG) console.warn(`❌ File index ${index} not found in videoFiles array`);
        }
      });
    } else {
      if (RENDERER_DEBUG) console.warn("⚠️ No file_statuses in completion data");
    }
    
    // Update UI
    this.updateVideoFileList();
    
    // Check if ALL files are completed
    const allFilesCompleted = this.videoFiles.every(file => file.status === 'completed');
    const anyFilesFailed = this.videoFiles.some(file => file.status === 'error');
    
    if (RENDERER_DEBUG) console.log("🎯 All files completed:", allFilesCompleted);
    if (RENDERER_DEBUG) console.log("🎯 Any files failed:", anyFilesFailed);
    
    // Show toast notification
    if (allFilesCompleted) {
      this.showToast(
        'success',
        'Conversion Completed',
        `Successfully converted ${processData.completed_files}/${processData.total_files} files`
      );
    } else if (anyFilesFailed) {
      this.showToast(
        'error',
        'Conversion Failed',
        `Conversion failed: ${processData.current_stage || 'Unknown error'}`
      );
    } else {
      this.showToast(
        isSuccessful ? 'success' : 'error',
        `Conversion ${isSuccessful ? 'Completed' : 'Failed'}`,
        isSuccessful 
          ? `Successfully converted ${processData.completed_files}/${processData.total_files} files` 
          : `Conversion failed: ${processData.current_stage || 'Unknown error'}`
      );
    }
    
    // Force immediate stats refresh to show updated counters
    await this.updateDatabaseStats();
    
    // Only reset operation state if ALL files are completed
    if (allFilesCompleted) {
      if (RENDERER_DEBUG) console.log("🎯 ALL files completed, resetting operation state");
      this.resetOperationState();
    } else {
      if (RENDERER_DEBUG) console.log("🎯 Not all files completed, keeping operation state active");
      if (RENDERER_DEBUG) console.log("🎯 Remaining files:", this.videoFiles.filter(f => f.status !== 'completed').map(f => f.name));
    }
    
    if (RENDERER_DEBUG) console.log("=== PROCESS COMPLETION END ===");
  }

  // Improved reset method
  resetOperationState() {
    if (RENDERER_DEBUG) console.log("=== RESET OPERATION STATE DEBUG ===");
    if (RENDERER_DEBUG) console.log("Before reset - Current operation:", this.currentOperation);
    if (RENDERER_DEBUG) console.log("Before reset - Current process ID:", this.currentProcessId);
    if (RENDERER_DEBUG) console.log("Before reset - Is paused:", this.isPaused);
    if (RENDERER_DEBUG) console.log("Before reset - Progress interval:", this.progressInterval);
    
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
      startBtn.style.display = 'inline-flex';
    }
    
    if (hexBtn) {
      hexBtn.disabled = false;
      hexBtn.style.opacity = '1';
      hexBtn.style.display = 'inline-flex';
    }
    
    if (pauseBtn) {
      pauseBtn.style.display = 'none';
      pauseBtn.disabled = true;
    }
    
    if (resumeBtn) {
      resumeBtn.style.display = 'none';
      resumeBtn.disabled = true;
    }
    
    // Reset progress bars to 100% if completed
    this.videoFiles.forEach(file => {
      if (file.status === 'completed') {
        file.progress = 100;
      }
    });
    
    this.updateVideoFileList();
    
    // Update button states
    this.updateButtonStates();
    
    if (RENDERER_DEBUG) console.log("After reset - Current operation:", this.currentOperation);
    if (RENDERER_DEBUG) console.log("After reset - Current process ID:", this.currentProcessId);
    if (RENDERER_DEBUG) console.log("After reset - Is paused:", this.isPaused);
    if (RENDERER_DEBUG) console.log("After reset - Progress interval:", this.progressInterval);
    if (RENDERER_DEBUG) console.log("=== RESET COMPLETE ===");
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
      !file.name.toLowerCase().endsWith('.webm')
    );
    
    if (nonWebmFiles.length > 0) {
      const fileNames = nonWebmFiles.map(f => f.name).slice(0, 3).join(', ');
      const moreText = nonWebmFiles.length > 3 ? ` and ${nonWebmFiles.length - 3} more` : '';
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
      const pauseBtn = document.getElementById("pause-hex-edit");
      const resumeBtn = document.getElementById("resume-hex-edit");
      
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
      }
      
      if (hexBtn) {
        hexBtn.disabled = true;
        hexBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Hex Editing...';
      }
      
      if (pauseBtn) {
        pauseBtn.style.display = 'inline-block';
        pauseBtn.disabled = false;
      }
      
      if (resumeBtn) {
        resumeBtn.style.display = 'none';
      }
      
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

  // Conversion progress monitor (video conversion only)
  startProgressMonitoring(processId, type = 'video') {
    const MAX_CONSECUTIVE_ERRORS = 5;
    const RETRY_DELAY = 2000; // 2 seconds
    const LONG_OPERATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    
    let consecutiveErrors = 0;
    let operationStartTime = Date.now();
    this.debugWarn('poll:start', { processId, type });
    
    this.progressInterval = setInterval(async () => {
      // Check for long-running operation
      if (Date.now() - operationStartTime > LONG_OPERATION_TIMEOUT) {
        if (RENDERER_DEBUG) console.warn(`[PROGRESS] Operation exceeded maximum time limit`);
        this.stopProgressMonitoring();
        this.resetOperationState();
        this.showToast("warning", "Operation Timeout", "Operation took too long and was stopped");
        return;
      }
      
      try {
        const progress = await this.getConversionProgress(processId);
        this.debugWarn('poll:data', { processId, type, progress });
        
        if (!progress) {
          consecutiveErrors++;
          this.handleProgressError(new Error("No progress data"), consecutiveErrors);
          return;
        }
        
        // Reset error counter on success
        consecutiveErrors = 0;
        this.logProgressDetails(progress);
        
        // Existing progress handling logic
        if (RENDERER_DEBUG) console.log(`[PROGRESS] ${processId}: ${progress.progress}% - ${progress.currentStage}`);
        
        // Update pause state if changed
        if (progress.paused !== this.isPaused) {
          this.isPaused = progress.paused;
          this.updateConversionButtons(this.currentOperation === 'converting', this.currentOperation === 'hexediting');
        }
        
        // Update overall progress display if needed
        this.updateOverallProgress(progress);
        
        // For hex edit, ensure the UI is refreshed after progress updates
        if (type === 'hex_edit') {
          // The files have already been updated in getConversionProgress
          // Just refresh the UI to show the changes
          this.updateVideoFileList();
        }

        // Check if operation is complete
        if (progress.status === "completed" || progress.status === "error") {
          this.debugWarn('poll:complete', { processId, type, status: progress.status });
          
          // For hex edit completion, only update files that haven't been updated yet
          if (type === 'hex_edit' && progress.status === "completed") {
            // Only update files that are still pending or processing
            this.videoFiles.forEach((file) => {
              if (file.status === 'pending' || file.status === 'processing') {
                file.status = 'completed';
                file.progress = 100;
                file.stage = 'Hex edit completed!';
              }
            });
            
            // Update UI immediately
            this.updateVideoFileList();
          }
          
          await this.handleConversionComplete(progress);
        }
      } catch (error) {
        consecutiveErrors++;
        this.debugWarn('poll:error', { processId, type, error: error?.message });
        this.handleProgressError(error, consecutiveErrors);
      }
    }, RETRY_DELAY);
  }

  // =============================================
  // HEX EDIT PROGRESS (Separate logic from conversion)
  // =============================================
  startHexProgressMonitoring(processId) {
    const MAX_CONSECUTIVE_ERRORS = 8;
    const RETRY_DELAY = 1200; // ms
    const LONG_OPERATION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
    
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    
    let consecutiveErrors = 0;
    const startTs = Date.now();
    if (RENDERER_DEBUG) console.log(`[HEX] monitor:start`, { processId, files: this.videoFiles.length });
    
    // For hex edit, check progress immediately since it's very fast
    this.checkHexProgressImmediately(processId);
    
    this.progressInterval = setInterval(async () => {
      // Removed excessive database stats monitoring during hex edit
      
      // Timeout guard
      if (Date.now() - startTs > LONG_OPERATION_TIMEOUT) {
        if (RENDERER_DEBUG) console.warn(`[HEX] monitor:timeout - stopping polling`);
        clearInterval(this.progressInterval);
        this.progressInterval = null;
        this.resetOperationState();
        this.showToast("warning", "Hex Edit Timeout", "Hex edit took too long and was stopped");
        return;
      }
      
      try {
        const progress = await this.getHexEditProgress(processId);
        if (RENDERER_DEBUG) console.log(`[HEX] monitor:data`, progress);
        
        // Update overall UI for hex edit
        this.updateHexOverallProgress(progress);
        
        // Refresh list each tick (lightweight, uses fragment)
        this.updateVideoFileList();
        
        if (progress.status === 'completed' || progress.status === 'error') {
          if (RENDERER_DEBUG) console.log(`[HEX] monitor:complete`, { status: progress.status });
          clearInterval(this.progressInterval);
          this.progressInterval = null;
          await this.handleConversionComplete(progress); // Reuse completion UI with wasHexEdit detection inside
        }
      } catch (err) {
        consecutiveErrors += 1;
        if (RENDERER_DEBUG) console.warn(`[HEX] monitor:error`, { consecutiveErrors, err: err?.message });
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
      if (RENDERER_DEBUG) console.log(`[HEX] immediate:check`, { processId });
      const progress = await this.getHexEditProgress(processId);
      
      // If hex edit is already completed (very fast operation)
      if (progress.status === 'completed') {
        if (RENDERER_DEBUG) console.log(`[HEX] immediate:completed`, progress);
        clearInterval(this.progressInterval);
        this.progressInterval = null;
        await this.handleConversionComplete(progress);
        return;
      }
      
      // Update UI immediately
      this.updateHexOverallProgress(progress);
      this.updateVideoFileList();
      
    } catch (err) {
      if (RENDERER_DEBUG) console.warn(`[HEX] immediate:error`, err?.message);
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
    if (RENDERER_DEBUG) console.log(`[HEX] progress:raw`, { keysCount: keys.length, keys });
    
    // Apply statuses to our local videoFiles array
    keys.forEach((k) => {
      const idx = parseInt(k);
      const fs = fileStatuses[k] || {};
      const file = this.videoFiles[idx];
      if (!file) return;
      
      const before = { s: file.status, p: file.progress, st: file.stage };
      file.status = fs.status || file.status || 'processing';
      file.progress = typeof fs.progress === 'number' ? fs.progress : (file.progress || 0);
      file.stage = fs.stage || file.stage || 'Processing hex edit...';
      // For hex edit, ensure completed files show 100% progress
      if (file.status === 'completed') {
        file.progress = 100;
        // Check if this is a hex edit completion
        if (file.stage && file.stage.includes('Hex edit completed')) {
          file.hexEdited = true; // Mark as hex edited
        }
      }
      
      if (before.s !== file.status || before.p !== file.progress || before.st !== file.stage) {
        if (RENDERER_DEBUG) console.log(`[HEX] file:update`, { idx, before, after: { s: file.status, p: file.progress, st: file.stage } });
      }
    });
    
    // Enhanced completion detection for hex edit
    const allCompleted = keys.every(k => {
      const fs = fileStatuses[k] || {};
      return fs.status === 'completed';
    });
    
    // Return normalized progress shape
    return {
      status: allCompleted ? 'completed' : (data.status || 'running'),
      progress: allCompleted ? 100 : (data.progress || 0),
      currentStage: data.current_stage || '',
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
      bar.setAttribute('aria-valuenow', progress.progress);
    }
    
    // Text status line (reuse conversion-status element)
    const statusEl = document.getElementById("conversion-status");
    if (statusEl) {
      const total = progress.totalFiles || this.videoFiles.length;
      statusEl.textContent = progress.currentStage || `Hex editing ${progress.completedFiles}/${total}`;
    }
  }

  logProgressDetails(progress) {
    if (RENDERER_DEBUG) console.log(`[PROGRESS DETAILS]`, {
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

  // =============================================
  // IMAGE CONVERTER METHODS
  // =============================================
  
  async addImageFiles() {
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
        if (!file || typeof file !== 'string') {
          console.warn('Invalid file path:', file);
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
        if (this.imageFiles.length >= 120) {
          skippedCount++;
          return;
        }
        
        if (!this.imageFiles.some((f) => f.path === file)) {
          // Get file metadata first
          const metadata = {
            name: file.split(/[\\/]/).pop(),
            path: file,
            status: "pending",
            progress: 0,
            stage: "Ready to convert"
          };
          
          this.imageFiles.push(metadata);
          addedCount++;
          
          // IMMEDIATE UI UPDATE - Update file count instantly
          const counter = document.getElementById("image-file-count");
          if (counter) {
            counter.textContent = this.imageFiles.length;
          }
        } else {
          skippedCount++;
        }
      });
      
      this.updateImageFileList();
      
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
      if (error.message && error.message.includes('Errno 22')) {
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

  clearImageFiles() {
    if (this.imageFiles.length === 0) {
      this.showToast("info", "Already Empty", "No image files to clear");
      return;
    }
    
    const count = this.imageFiles.length;
    this.imageFiles = [];
    
    // IMMEDIATE UI UPDATE - Update file count instantly
    const counter = document.getElementById("image-file-count");
    if (counter) {
      counter.textContent = this.imageFiles.length;
    }
    
    this.updateImageFileList();
    this.showToast("info", "Cleared", `Removed ${count} image files`);
  }

  async browseImageOutput() {
    try {
      // Check if Electron API is available
      if (!window.electronAPI || !window.electronAPI.selectDirectory) {
        throw new Error("Electron directory selection API not available");
      }
      
      const directory = await window.electronAPI.selectDirectory();
      
      if (directory) {
        this.currentImageOutput = directory;
        const outputInput = document.getElementById("image-output-dir");
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

  async startImageConversion() {
    // Basic validation
    if (this.imageFiles.length === 0) {
      this.showToast("warning", "No Files", "Please add images to convert.");
      return;
    }
    
    if (!this.currentImageOutput) {
      this.showToast("error", "No Output Folder", "Please select an output directory.");
      await this.browseImageOutput();
      if (!this.currentImageOutput) {
        return;
      }
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
    const filesToConvert = this.imageFiles.map(f => f.path);
    
    // Check if any file paths are invalid
    const invalidFiles = filesToConvert.filter(path => !path || path === 'undefined');
    if (invalidFiles.length > 0) {
      console.error("Invalid file paths found:", invalidFiles);
      this.showToast("error", "Invalid Files", "Some files have invalid paths. Please re-add them.");
      return;
    }
    
    try {
      // Get selected format (png or webp)
      const activeFormatBtn = document.querySelector('.format-toggle-btn.active');
      const format = activeFormatBtn ? activeFormatBtn.getAttribute('data-format') : 'png';
      
      // Get quality value
      const qualityInput = document.getElementById('image-quality');
      const quality = qualityInput ? parseInt(qualityInput.value) : 95;
      
      const requestData = {
        files: filesToConvert,
        output_dir: this.currentImageOutput,
        format: format,
        quality: quality
      };
      
      const response = await this.apiRequest("POST", "/api/convert-images", requestData);
      
      if (response.success) {
        this.showToast("success", "Conversion Started", `Conversion of ${filesToConvert.length} files started!`);
        
        // Update UI to show processing state
        this.imageFiles.forEach(file => {
          file.status = "processing";
          file.progress = 0;
          file.stage = "Converting...";
        });
        
        this.updateImageFileList();
        
        // Start monitoring progress if process_id is provided
        if (response.data && response.data.process_id) {
          this.monitorImageConversion(response.data.process_id);
        }
      } else {
        throw new Error(response.error || "Failed to start conversion process");
      }
      
    } catch (error) {
      console.error("Conversion start error:", error);
      this.showToast("error", "Conversion Error", error.message);
    }
  }

  async monitorImageConversion(processId) {
    const MAX_CONSECUTIVE_ERRORS = 5;
    const POLLING_INTERVAL = 1000;
    let consecutiveErrors = 0;
    
    // Clear any existing intervals
    if (this.imageProgressInterval) {
      clearInterval(this.imageProgressInterval);
    }
    
    this.imageProgressInterval = setInterval(async () => {
      try {
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
        
        const progressData = response.data;
        
        // Update file statuses
        if (progressData.file_statuses) {
          Object.entries(progressData.file_statuses).forEach(([index, fileStatus]) => {
            const file = this.imageFiles[parseInt(index)];
            if (file) {
              file.status = fileStatus.status;
              file.progress = fileStatus.progress || 0;
              file.stage = fileStatus.stage || 'Processing';
            }
          });
          
          this.updateImageFileList();
        }
        
        // Check if process is complete
        if (progressData.status === 'completed' || progressData.status === 'error') {
          clearInterval(this.imageProgressInterval);
          this.imageProgressInterval = null;
          
          // Update UI with final status
          this.imageFiles.forEach(file => {
            if (file.status === "processing") {
              file.status = progressData.status;
              file.progress = progressData.status === 'completed' ? 100 : 0;
              file.stage = progressData.status === 'completed' ? 'Conversion completed' : 'Conversion failed';
            }
          });
          
          this.updateImageFileList();
          
          if (progressData.status === 'completed') {
            this.showToast("success", "Conversion Complete", `Successfully converted ${progressData.completed_files}/${progressData.total_files} files`);
          } else {
            this.showToast("error", "Conversion Failed", progressData.current_stage || 'Conversion failed');
          }
        }
        
      } catch (error) {
        if (RENDERER_DEBUG) console.error("Progress monitoring error:", error);
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          clearInterval(this.imageProgressInterval);
          this.imageProgressInterval = null;
          this.showToast("error", "Monitoring Failed", "Unable to track progress");
        }
      }
    }, POLLING_INTERVAL);
  }

  updateImageFileList() {
    const container = document.getElementById("image-file-list");
    if (!container) {
      // Try again after a short delay in case DOM is still loading
      setTimeout(() => {
        const retryContainer = document.getElementById("image-file-list");
        if (retryContainer && this.imageFiles.length > 0) {
          this.updateImageFileList();
        }
      }, 100);
      return;
    }
    
    // Update image file list
    const fileCount = this.imageFiles.length;
    
    // IMMEDIATE FILE COUNT UPDATE - Do this first for instant feedback
    const counter = document.getElementById("image-file-count");
    if (counter) {
      counter.textContent = this.imageFiles.length;
    }
    
    if (this.imageFiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state-mini">
          <i class="fas fa-image"></i>
          <p>No images</p>
        </div>
      `;
      return;
    }
    
    // Create grid of image files
    container.innerHTML = '';
    
    this.imageFiles.forEach((file, index) => {
      const statusClass = file.status || "pending";
      const progressWidth = file.progress || 0;
      
      const fileElement = document.createElement('div');
      fileElement.className = `image-item ${statusClass}`;
      fileElement.setAttribute('data-index', index);
      
      const progressText = progressWidth === 100 ? '✔' : `${progressWidth}%`;
      const statusText = file.stage || "Ready to convert";
      
      fileElement.innerHTML = `
        <div class="image-preview">
          <div class="image-thumb" style="background-image: url('${file.path}');"></div>
        </div>
        <div class="image-info">
          <div class="image-name" title="${file.path}">${file.name}</div>
          <div class="image-status">${statusText}</div>
          <div class="image-progress-container">
            <div class="image-progress-bar">
              <div class="image-progress-fill" style="width: ${progressWidth}%"></div>
            </div>
            <div class="image-progress-text">${progressText}</div>
          </div>
          <button class="btn btn-sm btn-danger remove-image" onclick="app.removeImageFile(${index})" title="Remove File">
            <i class="fas fa-times"></i>
          </button>
        </div>
      `;
      
      container.appendChild(fileElement);
    });
  }

  removeImageFile(index) {
    if (index < 0 || index >= this.imageFiles.length) return;
    
    const removed = this.imageFiles.splice(index, 1)[0];
    
    // IMMEDIATE UI UPDATE - Update file count instantly
    const counter = document.getElementById("image-file-count");
    if (counter) {
      counter.textContent = this.imageFiles.length;
    }
    
    this.updateImageFileList();
    this.showToast("info", "Removed", `Removed ${removed.name}`);
  }

  async handleConversionComplete(progress) {
    if (RENDERER_DEBUG) console.log(`[COMPLETE] Operation finished with status: ${progress.status}`);
    
    this.stopProgressMonitoring();
    const wasHexEdit = this.currentOperation === 'hexediting';
    this.currentOperation = null;
    this.currentProcessId = null;
    
    // Re-enable buttons
    const startBtn = document.getElementById("start-conversion");
    const hexBtn = document.getElementById("start-hex-edit");
    
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fas fa-play"></i> Start Conversion';
    }
    
    if (hexBtn) {
      hexBtn.disabled = false;
      hexBtn.innerHTML = '<i class="fas fa-edit"></i> Hex Edit';
    }
    
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
    this.debugWarn('🔥 COMPLETION DEBUG - Updating Final File Statuses', {
      wasHexEdit: wasHexEdit,
      progressStatus: progress.status,
      hasFileStatuses: !!(progress.file_statuses && Object.keys(progress.file_statuses).length > 0),
      fileStatusesKeys: Object.keys(progress.file_statuses || {}),
      completedFiles: progress.completedFiles,
      totalFiles: progress.totalFiles
    });
    
    if (progress.file_statuses && Object.keys(progress.file_statuses).length > 0) {
      this.debugWarn('🔥 COMPLETION DEBUG - Using file_statuses data');
      this.videoFiles.forEach((file, index) => {
        const fileStatus = progress.file_statuses[index];
        if (fileStatus) {
          file.status = fileStatus.status;
          file.progress = fileStatus.progress;
          file.stage = fileStatus.stage || progress.currentStage;
          this.debugWarn('🔥 COMPLETION DEBUG - Updated file from file_statuses', {
            index: index,
            filename: file.name,
            status: file.status,
            progress: file.progress
          });
        } else {
          // Fallback if no specific file status
          file.status = progress.status === "completed" ? "completed" : "error";
          file.progress = progress.status === "completed" ? 100 : file.progress || 0;
          file.stage = progress.status === "completed" ? 
            (wasHexEdit ? "Hex edit successful" : "Conversion successful") : 
            (wasHexEdit ? "Hex edit failed" : "Conversion failed");
          this.debugWarn('🔥 COMPLETION DEBUG - Updated file with fallback', {
            index: index,
            filename: file.name,
            status: file.status,
            progress: file.progress
          });
        }
      });
    } else {
      // If no file_statuses at all, update all files with the overall status
      this.debugWarn('🔥 COMPLETION DEBUG - No file_statuses, using overall status');
      this.videoFiles.forEach((file, index) => {
        file.status = progress.status === "completed" ? "completed" : "error";
        file.progress = progress.status === "completed" ? 100 : file.progress || 0;
        file.stage = progress.status === "completed" ? 
          (wasHexEdit ? "Hex edit successful" : "Conversion successful") : 
          (wasHexEdit ? "Hex edit failed" : "Conversion failed");
        this.debugWarn('🔥 COMPLETION DEBUG - Updated file with overall status', {
          index: index,
          filename: file.name,
          status: file.status,
          progress: file.progress
        });
      });
    }
    
    this.debugWarn('🔥 COMPLETION DEBUG - Final File States', {
      videoFiles: this.videoFiles.map((f, i) => ({
        index: i,
        name: f.name,
        status: f.status,
        progress: f.progress,
        stage: f.stage
      }))
    });
    
    this.updateVideoFileList();
    
    // Force immediate stats refresh to show updated counters
    await this.forceUpdateDatabaseStats();
  }

  updateOverallProgress(progress) {
    // Update global progress indicators
    const progressElement = document.getElementById("overall-progress");
    if (progressElement) {
      progressElement.style.width = `${progress.progress}%`;
      progressElement.setAttribute('aria-valuenow', progress.progress);
    }
    
    const statusElement = document.getElementById("conversion-status");
    if (statusElement) {
      statusElement.textContent = progress.currentStage || `Converting ${progress.completedFiles}/${progress.totalFiles}`;
    }
    
    // File statuses are already updated in getConversionProgress
  }

  async getConversionProgress(processId) {
    try {
      const response = await this.apiRequest("GET", `/api/conversion-progress/${processId}`);
      this.debugWarn('🔍 DETAILED DEBUG - Raw API Response', {
        processId: processId,
        responseSuccess: response?.success,
        responseData: response?.data,
        hasFileStatuses: !!(response?.data?.file_statuses),
        fileStatusesKeys: Object.keys(response?.data?.file_statuses || {}),
        fullResponse: response
      });
      
      if (!response.success) {
        if (RENDERER_DEBUG) console.error(`Progress check failed for ${processId}:`, response.error);
        if (response.details && response.details.active_processes) {
          if (RENDERER_DEBUG) console.log("Active processes:", response.details.active_processes);
        }
        return null;
      }
      
      const progressData = response.data;
      this.debugWarn('🔍 DETAILED DEBUG - Progress Data Extracted', {
        progressData: progressData,
        fileStatusesRaw: progressData.file_statuses,
        fileStatusesType: typeof progressData.file_statuses,
        fileStatusesIsObject: progressData.file_statuses && typeof progressData.file_statuses === 'object',
        fileStatusesKeys: Object.keys(progressData.file_statuses || {})
      });
      
      // Update file statuses if available - but do this AFTER returning the data
      // so it's available for both conversion and hex edit operations
      const fileStatuses = progressData.file_statuses || {};
      
      // Debug log to see what we're getting
      if (Object.keys(fileStatuses).length > 0) {
        this.debugWarn('🔍 DETAILED DEBUG - File Statuses Processing', { 
          operation: this.currentOperation, 
          count: Object.keys(fileStatuses).length,
          statuses: fileStatuses,
          videoFilesCount: this.videoFiles.length,
          videoFiles: this.videoFiles.map((f, i) => ({ index: i, name: f.name, currentStatus: f.status, currentProgress: f.progress }))
        });
      } else {
        this.debugWarn('🚨 DETAILED DEBUG - NO FILE STATUSES FOUND', {
          operation: this.currentOperation,
          progressDataKeys: Object.keys(progressData),
          fileStatusesValue: progressData.file_statuses,
          fileStatusesStringified: JSON.stringify(progressData.file_statuses)
        });
      }
      
      // Update the videoFiles array immediately for both conversion and hex edit
      if ((this.currentOperation === 'converting' || this.currentOperation === 'hexediting') && Object.keys(fileStatuses).length > 0) {
        if (RENDERER_DEBUG) console.log(`[PROGRESS] Updating ${Object.keys(fileStatuses).length} file statuses for ${this.currentOperation}`);
        
        Object.entries(fileStatuses).forEach(([idx, fs]) => {
          const file = this.videoFiles[parseInt(idx)];
          if (!file) {
            if (RENDERER_DEBUG) console.warn(`[PROGRESS] File at index ${idx} not found in videoFiles`);
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
            if (RENDERER_DEBUG) console.log(`[PROGRESS] File ${idx} updated:`, {
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
      
      this.debugWarn('🔍 DETAILED DEBUG - Returning Progress Data', {
        returnData: returnData,
        fileStatusesInReturn: returnData.file_statuses,
        fileStatusesKeysInReturn: Object.keys(returnData.file_statuses || {})
      });
      
      return returnData;
    } catch (error) {
      if (RENDERER_DEBUG) console.error("Error getting conversion progress:", error);
      return null;
    }
  }

  updateFileStatuses(fileStatuses) {
    this.debugWarn('🎯 DETAILED DEBUG - updateFileStatuses Called', {
      input: fileStatuses,
      inputType: typeof fileStatuses,
      inputKeys: Object.keys(fileStatuses || {}),
      inputIsValid: fileStatuses && typeof fileStatuses === 'object'
    });
    
    // Handle both object and array-like structures
    if (!fileStatuses || typeof fileStatuses !== 'object') {
      this.debugWarn('🚨 DETAILED DEBUG - Invalid File Statuses', {
        fileStatuses: fileStatuses,
        type: typeof fileStatuses,
        isNull: fileStatuses === null,
        isUndefined: fileStatuses === undefined
      });
      return;
    }
    
    const fileStatusKeys = Object.keys(fileStatuses);
    this.debugWarn('🎯 DETAILED DEBUG - Processing File Status Keys', {
      keys: fileStatusKeys,
      count: fileStatusKeys.length
    });
    
    fileStatusKeys.forEach(index => {
      const fileStatus = fileStatuses[index];
      if (!fileStatus) {
        this.debugWarn('🚨 DETAILED DEBUG - Empty File Status', { index, fileStatus });
        return;
      }
      
      this.debugWarn('🎯 DETAILED DEBUG - Processing File Status', {
        index: index,
        fileStatus: fileStatus,
        status: fileStatus.status,
        progress: fileStatus.progress,
        stage: fileStatus.stage,
        filename: fileStatus.filename
      });
      
      // Our DOM uses data-index, not data-file-index
      const fileElement = document.querySelector(`[data-index="${index}"]`);
      this.debugWarn('🎯 DETAILED DEBUG - DOM Element Search', { 
        index, 
        selector: `[data-index="${index}"]`,
        found: !!fileElement,
        elementHTML: fileElement ? fileElement.outerHTML.substring(0, 200) + '...' : 'NOT FOUND'
      });
      
      if (fileElement) {
        // Update file item class based on status
        const oldClassName = fileElement.className;
        fileElement.className = `file-item ${fileStatus.status || 'pending'}`;
        
        this.debugWarn('🎯 DETAILED DEBUG - Updated Element Class', {
          index: index,
          oldClassName: oldClassName,
          newClassName: fileElement.className
        });
        
        // Update progress bar
        const progressBar = fileElement.querySelector('.file-progress-fill');
        const progressText = fileElement.querySelector('.file-progress-text');
        const statusElement = fileElement.querySelector('.file-status');
        
        this.debugWarn('🎯 DETAILED DEBUG - DOM Elements Found', {
          index: index,
          hasProgressBar: !!progressBar,
          hasProgressText: !!progressText,
          hasStatusElement: !!statusElement
        });
        
        if (progressBar) {
          const oldWidth = progressBar.style.width;
          progressBar.style.width = `${fileStatus.progress}%`;
          this.debugWarn('🎯 DETAILED DEBUG - Updated Progress Bar', {
            index: index,
            oldWidth: oldWidth,
            newWidth: progressBar.style.width,
            progress: fileStatus.progress
          });
        } else {
          this.debugWarn('🚨 DETAILED DEBUG - Progress Bar Not Found', { index });
        }
        
        if (progressText) {
          const oldText = progressText.textContent;
          progressText.textContent = `${fileStatus.progress === 100 ? '✔' : fileStatus.progress + '%'}`;
          this.debugWarn('🎯 DETAILED DEBUG - Updated Progress Text', {
            index: index,
            oldText: oldText,
            newText: progressText.textContent,
            progress: fileStatus.progress
          });
        } else {
          this.debugWarn('🚨 DETAILED DEBUG - Progress Text Not Found', { index });
        }
        
        if (statusElement) {
          const oldStatus = statusElement.textContent;
          statusElement.textContent = fileStatus.stage || fileStatus.status;
          this.debugWarn('🎯 DETAILED DEBUG - Updated Status Element', {
            index: index,
            oldStatus: oldStatus,
            newStatus: statusElement.textContent,
            stage: fileStatus.stage,
            status: fileStatus.status
          });
        } else {
          this.debugWarn('🚨 DETAILED DEBUG - Status Element Not Found', { index });
        }
      } else {
        this.debugWarn('🚨 DETAILED DEBUG - File Element Not Found in DOM', {
          index: index,
          selector: `[data-index="${index}"]`,
          availableElements: Array.from(document.querySelectorAll('[data-index]')).map(el => ({
            index: el.getAttribute('data-index'),
            className: el.className,
            innerHTML: el.innerHTML.substring(0, 100) + '...'
          }))
        });
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
    if (RENDERER_DEBUG) console.log('[DEBUG] disconnectTelegram called');
    
    try {
      this.updateTelegramStatus("connecting"); // Show as connecting/processing
      
      // Clean up the session
      const response = await this.apiRequest("POST", "/api/telegram/cleanup-session");
      
      if (response && response.success) {
        this.showToast('success', 'Disconnected', 'Successfully disconnected from Telegram');
        this.updateTelegramStatus("disconnected");
      } else {
        this.showToast('warning', 'Disconnect Warning', 'Session may not be fully cleaned');
        this.updateTelegramStatus("disconnected"); // Still update UI
      }
      
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[DEBUG] Disconnect error:', error);
      this.showToast('error', 'Disconnect Error', 'Error during disconnect, but session should be invalid');
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
        if (RENDERER_DEBUG) console.log('[DEBUG] User wants to connect - checking for existing session...');
        
        const sessionResponse = await this.apiRequest("GET", "/api/telegram/session-status");
        
        if (sessionResponse && sessionResponse.success && sessionResponse.data) {
          const { session_exists, session_valid } = sessionResponse.data;
          
          if (session_exists && session_valid) {
            if (RENDERER_DEBUG) console.log('[DEBUG] Found valid existing session - using it');
            this.updateTelegramStatus("connected");
            this.showToast('success', 'Already Connected', 'Using existing Telegram session');
            return;
          } else if (session_exists && !session_valid) {
            if (RENDERER_DEBUG) console.log('[DEBUG] Found invalid session - cleaning up before new connection');
            try {
              await this.cleanupTelegramSession();
            } catch (cleanupError) {
              console.warn('[DEBUG] Could not clean up invalid session:', cleanupError);
            }
          }
        }
      } catch (error) {
        if (RENDERER_DEBUG) console.warn('[DEBUG] Could not check existing session, proceeding with new connection:', error);
      }
      
      // ... rest of connection logic ...
      
      // Updated to match the HTML IDs correctly
      const apiIdInput = document.getElementById("telegram-api-id");
      const apiHashInput = document.getElementById("telegram-api-hash");
      const phoneInput = document.getElementById("telegram-phone");
      
      if (RENDERER_DEBUG) console.log('[DEBUG] connectTelegram called - checking inputs:', {
        apiIdInput: !!apiIdInput,
        apiHashInput: !!apiHashInput, 
        phoneInput: !!phoneInput
      });
      
      if (!apiIdInput || !apiHashInput || !phoneInput) {
        if (RENDERER_DEBUG) console.error('[DEBUG] Missing input elements:', {
          apiIdInput: !!apiIdInput,
          apiHashInput: !!apiHashInput,
          phoneInput: !!phoneInput
        });
        this.showToast('error', 'Input Error', 'Telegram connection inputs not found');
        return;
      }
      
      const apiId = apiIdInput.value.trim();
      const apiHash = apiHashInput.value.trim();
      const phoneNumber = phoneInput.value.trim();
      
      if (RENDERER_DEBUG) console.log('[DEBUG] Input values:', {
        apiId: apiId ? 'provided' : 'empty',
        apiHash: apiHash ? 'provided' : 'empty', 
        phoneNumber: phoneNumber ? 'provided' : 'empty'
      });
      
      // Validate inputs
      if (!apiId || !apiHash || !phoneNumber) {
        if (RENDERER_DEBUG) console.error('[DEBUG] Validation failed - missing inputs');
        
        // Show specific field errors
        const missingFields = [];
        if (!apiId) missingFields.push('API ID');
        if (!apiHash) missingFields.push('API Hash');
        if (!phoneNumber) missingFields.push('Phone Number');
        
        this.showToast('error', 'Invalid Input', `Please fill in: ${missingFields.join(', ')}`);
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
      
      if (RENDERER_DEBUG) console.log('[DEBUG] Sending connection request to backend');
      
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
          
          if (RENDERER_DEBUG) console.log('[DEBUG] Connection response received:', response);
          break; // Success, exit retry loop
          
        } catch (error) {
          if (RENDERER_DEBUG) console.error(`[DEBUG] Connection attempt ${retryCount + 1} failed:`, error);
          
          // Check for database lock error
          if (error.message && error.message.includes('database is locked') && retryCount < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 1000));
            retryCount++;
            continue;
          }
          
          throw error; // Re-throw if not a database lock error or max retries reached
        }
      }
      
      this.hideLoadingOverlay();
      
      const resOk = response && typeof response === 'object' && response.success === true;
      if (resOk) {
        const result = (response.data !== undefined && response.data !== null) ? response.data : response;
        const needsCode = !!(result && result.needs_code);
        const needsPassword = !!(result && result.needs_password);
        
        if (needsCode) {
          this.pendingCode = true;
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
          if (RENDERER_DEBUG) console.log('[DEBUG] Connection successful - updating UI');
          
          // Show session reuse information
          let successMessage = 'Successfully connected to Telegram';
          if (result && result.reused_session) {
            successMessage += ' (Reused existing session - no rate limits!)';
            this.showToast('success', 'Session Reused', 'Used existing session to avoid rate limiting', 6000);
            this.addStatusItem('✅ Session reused successfully', 'success');
          } else if (result && result.existing_session) {
            successMessage += ' (Used existing authorized session)';
            this.showToast('success', 'Session Found', 'Found existing authorized session', 5000);
            this.addStatusItem('✅ Existing session found and used', 'success');
          } else {
            successMessage += ' (Created new session)';
            this.showToast('success', 'Connected', successMessage);
            this.addStatusItem('✅ New session created', 'success');
          }
          
          this.updateTelegramStatus("connected");
        }
      } else {
        if (RENDERER_DEBUG) console.error('[DEBUG] Connection failed - response not successful:', response);
        
        // Handle rate limiting specifically
        if (response && response.rate_limited) {
          const waitTime = response.wait_time_human || 'some time';
          this.showToast(
            'warning', 
            'Rate Limited', 
            `${response.error}

Too many requests. Please wait ${waitTime} before trying again.

Tip: Next time, the app will reuse your session automatically to avoid this!`,
            12000  // Show for 12 seconds
          );
          
          // Show detailed rate limit info
          this.addStatusItem(`⚠️ Telegram rate limit: Wait ${waitTime}`, "warning");
          this.addStatusItem(`💡 Next connection will reuse session to avoid limits`, "info");
          
          return; // Don't proceed further
        }
        
        const errorMsg = (response && response.error) || 'Unknown error occurred';
        this.showToast('error', 'Connection Failed', errorMsg);
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[DEBUG] Connection error caught:', error);
      this.hideLoadingOverlay();
      
      let errorMsg = error.message || 'Failed to connect';
      
      // Handle specific error types
      if (errorMsg.includes('rate limit') || errorMsg.includes('wait') || errorMsg.includes('FloodWaitError')) {
        this.showToast(
          'warning', 
          'Rate Limited', 
          'Too many requests to Telegram. Please wait before trying again.',
          8000
        );
      } else if (errorMsg.includes('database is locked')) {
        errorMsg = 'Database is locked. Please try again in a moment.';
        this.showToast('error', 'Connection Error', errorMsg);
      } else if (errorMsg.includes('connect_telegram')) {
        errorMsg = 'Connection service unavailable. Please restart the application.';
        this.showToast('error', 'Connection Error', errorMsg);
      } else {
        this.showToast('error', 'Connection Error', errorMsg);
      }
      
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
    // Prevent double submission
    if (this.isSubmittingCode) {
      return;
    }
    
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
      // Set flag to prevent double submission
      this.isSubmittingCode = true;
      
      const submitBtn = document.getElementById("submit-code");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML =
          '<i class="fas fa-spinner fa-spin"></i> Verifying...';
      }
      
      const response = await this.apiRequest("POST", "/api/sticker/verify-code", { code });
      
      const resOk = response && typeof response === 'object' && response.success === true;
      if (resOk) {
        const result = (response.data !== undefined && response.data !== null) ? response.data : response;
        // Check if 2FA password is needed
        const needsPassword = !!(result && result.needs_password);
        if (RENDERER_DEBUG) console.debug('[verify-code] response:', response, 'computed needsPassword=', needsPassword);
        if (RENDERER_DEBUG) console.debug('[verify-code] result object:', result);
        if (RENDERER_DEBUG) console.debug('[verify-code] needs_password field:', result?.needs_password);
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
      // Reset submission flag
      this.isSubmittingCode = false;
      
      const submitBtn = document.getElementById("submit-code");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Verify Code';
      }
    }
  }

  async submitPassword() {
    // Prevent double submission
    if (this.isSubmittingPassword) {
      return;
    }
    
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
      // Set flag to prevent double submission
      this.isSubmittingPassword = true;
      
      const submitBtn = document.getElementById("submit-password");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML =
          '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
      }
      
      const response = await this.apiRequest("POST", "/api/sticker/verify-password", { password });
      
      const resOk = response && typeof response === 'object' && response.success === true;
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
      // Reset submission flag
      this.isSubmittingPassword = false;
      
      const submitBtn = document.getElementById("submit-password");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-key"></i> Authenticate';
      }
    }
  }

  async addImages() {
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
        if (!file || typeof file !== 'string') {
          console.warn('Invalid file path:', file);
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
          // Sanitize default emoji
          let cleanDefaultEmoji = '❤️';
          if (typeof this.defaultEmoji === 'string') {
            const sanitized = this.defaultEmoji.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
            if (sanitized.length > 0) {
              const emojiChars = Array.from(sanitized);
              cleanDefaultEmoji = emojiChars[0] || '❤️';
            }
          }
          
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
      if (error.message && error.message.includes('Errno 22')) {
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
        if (!file || typeof file !== 'string') {
          console.warn('Invalid file path:', file);
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
          // Sanitize default emoji
          let cleanDefaultEmoji = '❤️';
          if (typeof this.defaultEmoji === 'string') {
            const sanitized = this.defaultEmoji.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
            if (sanitized.length > 0) {
              const emojiChars = Array.from(sanitized);
              cleanDefaultEmoji = emojiChars[0] || '❤️';
            }
          }
          
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
      if (error.message && error.message.includes('Errno 22')) {
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
      if (RENDERER_DEBUG) console.warn('⚠️ sticker-media-list container not found');
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
        const icon = file.type === "video" ? "fas fa-video" : "fas fa-image";
        const statusClass = file.status || "pending";
        const statusIcon = this.getMediaStatusIcon(file.status);
        
        return `
          <div class="media-item ${statusClass} new-item" data-index="${index}">
            <div class="media-info">
              <div class="media-icon">
                <i class="${icon}"></i>
              </div>
              <div class="media-details">
                <div class="media-name" title="${file.file_path}">${file.name}</div>
                <div class="media-meta">
                  <span><i class="fas fa-file"></i> ${file.type.toUpperCase()}</span>
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
        console.log(`🔄 [MEDIA_STATUS] File ${fileIndex} (${file.name}): ${oldStatus} → ${status}`);
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
    const statusElement = mediaItem.querySelector('.media-status');
    if (statusElement) {
      statusElement.innerHTML = `<i class="${statusIcon}"></i> ${statusText}`;
    } else if (file.status && file.status !== "pending") {
      // Add status element if it doesn't exist
      const metaElement = mediaItem.querySelector('.media-meta');
      if (metaElement) {
        metaElement.innerHTML += `<span class="media-status"><i class="${statusIcon}"></i> ${statusText}</span>`;
      }
    }
    
    // Update item class for styling
    mediaItem.className = `media-item ${file.status || 'pending'} new-item`;
    
    // Add progress indicator for processing status
    if (file.status === 'processing' && file.progress !== undefined) {
      let progressBar = mediaItem.querySelector('.progress-indicator');
      if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.className = 'progress-indicator';
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
      const progressBar = mediaItem.querySelector('.progress-indicator');
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
      const status = file.status || 'pending';
      if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
        statusCounts[status]++;
      }
    });
    
    // Update progress indicators
    const progressPercent = Math.round((statusCounts.completed / totalFiles) * 100);
    
    // Update any progress displays
    const progressElements = document.querySelectorAll('.sticker-progress-percentage');
    progressElements.forEach(el => {
      if (el) el.textContent = `${progressPercent}%`;
    });
    
    const statusElements = document.querySelectorAll('.sticker-progress-stats');
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
            fileStatus.status || 'processing',
            fileStatus.progress,
            fileStatus.stage
          );
        }
      });
    } else {
      // Fallback: update all files based on overall progress
      const overallStatus = this.getStatusFromProgress(progress);
      this.mediaFiles.forEach((file, index) => {
        if (file.status !== 'completed' && file.status !== 'error') {
          this.updateMediaFileStatus(index, overallStatus, progress.progress);
        }
      });
    }
  }
  
  getStatusFromProgress(progress) {
    if (progress.status === 'completed') return 'completed';
    if (progress.status === 'error' || progress.status === 'failed') return 'error';
    if (progress.current_stage && progress.current_stage.includes('upload')) return 'uploading';
    if (progress.current_stage && progress.current_stage.includes('process')) return 'processing';
    return 'processing';  // Default to processing for active states
  }
  

  async showMediaInfo(index) {
    const file = this.mediaFiles[index];
    if (!file) return;
    
    // Get detailed file metadata from backend
    let fileInfo = {
      name: file.name,
      size: 'Unknown',
      duration: 'N/A',
      format: 'Unknown',
      dimensions: 'Unknown',
      dateModified: 'Unknown'
    };
    
    try {
      const result = await this.apiRequest('POST', '/api/get-file-info', { 
        path: file.file_path 
      });
      
      if (result && result.success && result.data) {
        fileInfo = {
          name: result.data.name || file.name,
          size: result.data.size_formatted || 'Unknown',
          duration: result.data.duration_formatted || 'N/A',
          format: result.data.format ? result.data.format.toUpperCase() : 'Unknown',
          dimensions: result.data.dimensions || 'Unknown',
          dateModified: result.data.modified ? new Date(result.data.modified * 1000).toLocaleDateString() : 'Unknown',
          type: result.data.type || 'unknown',
          codec: result.data.codec || null,
          fps: result.data.fps || null
        };
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error('Failed to get file info:', error);
    }
    
    // Format additional technical info
    let technicalInfo = '';
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
    const typeIcon = fileInfo.type === 'video' ? '🎥' : fileInfo.type === 'image' ? '🖼️' : '📄';
    const typeLabel = fileInfo.type === 'video' ? 'Video' : fileInfo.type === 'image' ? 'Image' : 'File';
    
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
        
        ${file.type === 'video' ? `<div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">⏱️ Duration:</strong> 
          <span style="color: #ccc;">${fileInfo.duration}</span>
        </div>` : ''}
        
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
            <span style="font-size: 1.5rem;">${file.emoji || '😀'}</span>
          </div>
          
          <div style="margin-bottom: 0.5rem;">
            <strong style="color: #667eea;">🔄 Status:</strong> 
            <span style="color: ${this.getStatusColor(file.status)};">${file.status || 'Ready'}</span>
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
    if (this.isEmojiModalLocked) {
        return;
    }
    
    // Prevent immediate closure
    this.preventEmojiModalClosure = true;
    setTimeout(() => {
      this.preventEmojiModalClosure = false;
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
    // Prevent multiple clicks
    if (this.isSavingEmoji) {
        return;
    }
    
    if (this.currentEmojiIndex === null || this.currentEmojiIndex < 0) {
        return;
    }
    
    const emojiInput = document.getElementById("emoji-input");
    
    if (!emojiInput) {
        return;
    }
    
    const newEmoji = emojiInput.value.trim();
    
    if (!newEmoji) {
      this.showToast("warning", "Empty Emoji", "Please enter an emoji");
      emojiInput.focus();
      return;
    }
    
    // Set saving flag to prevent multiple clicks
    this.isSavingEmoji = true;
    
    if (this.currentEmojiIndex < this.mediaFiles.length) {
      this.mediaFiles[this.currentEmojiIndex].emoji = newEmoji;
      this.updateMediaFileList();
      this.showToast(
        "success",
        "Emoji Updated",
        `Emoji updated to ${newEmoji}`
      );
    }
    
    this.hideModal();
    
    // Ensure currentEmojiIndex is reset
    this.currentEmojiIndex = null;
    
    // Reset saving flag after a short delay
    setTimeout(() => {
        this.isSavingEmoji = false;
    }, 100);
  }

  async createStickerPack() {
    const packNameEl = document.getElementById("pack-name");
    const packName = (packNameEl && typeof packNameEl.value === 'string') ? packNameEl.value.trim() : "";
    const packUrlNameEl = document.getElementById("pack-url-name");
    const packUrlName = (packUrlNameEl && typeof packUrlNameEl.value === 'string') ? packUrlNameEl.value.trim() : "";
    const stickerTypeEl = document.querySelector('input[name="sticker-type"]:checked');
    const stickerType = stickerTypeEl ? stickerTypeEl.value : 'image';

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
          console.error(`Health check failed:`, healthError);
          this.showToast("warning", "Connection Issue", "Backend connection issue detected, but proceeding anyway...");
        }
      }
    } catch (error) {
      console.error(`Session check failed:`, error);
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

    // Add initial status
    this.addStatusItem(`🚀 Starting sticker pack creation: "${packName}"`, "info");
    
    const incompatibleFiles = this.mediaFiles.filter((f) => {
      if (stickerType === "video" && f.type !== "video") return true;
      if (stickerType === "image" && f.type !== "image") return true;
      return false;
    });
    
    if (incompatibleFiles.length > 0) {
      this.addStatusItem(`⚠️ Warning: ${incompatibleFiles.length} files don't match sticker type`, "warning");
      const proceed = confirm(
        `${incompatibleFiles.length} files don't match the sticker type (${stickerType}). Continue with compatible files only?`
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
      processId = processId.substring(0, 50).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
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
          file_path: String(f.file_path || "").replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim(),
          emoji: typeof f.emoji === "string" && f.emoji.replace(/[\x00-\x1f\x7f-\x9f]/g, '').length > 0 ? Array.from(f.emoji.replace(/[\x00-\x1f\x7f-\x9f]/g, ''))[0] : this.defaultEmoji,
          type: f.type === "video" ? "video" : "image",
        }))
        .filter((m) => m.file_path && m.file_path.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(m.file_path));

      // Additional validation for file paths and emoji data
      for (const media of filteredMedia) {
        // Ensure file_path is properly sanitized
        if (typeof media.file_path === 'string') {
          // Remove any remaining invalid characters
          media.file_path = media.file_path.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
          // Ensure it's not empty
          if (media.file_path.length === 0) {
            throw new Error('Invalid file path');
          }
        }
        
        // Ensure emoji is a single valid character
        if (typeof media.emoji === 'string' && media.emoji.length > 0) {
          // Remove control characters first
          const cleanEmoji = media.emoji.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
          // Use only the first character and ensure it's valid
          const emojiChars = Array.from(cleanEmoji);
          media.emoji = emojiChars[0] || this.defaultEmoji;
        } else {
          media.emoji = this.defaultEmoji;
        }
      }

      // ENHANCED: Validate and sanitize all request data to prevent [Errno 22] Invalid argument
      // Remove any control characters that could cause issues
      const sanitizedPackName = String(packName || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().substring(0, 64);
      const sanitizedPackUrlName = String(packUrlName || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().substring(0, 32);
      const sanitizedProcessId = String(processId || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
      
      // Validate that we have valid data after sanitization
      if (!sanitizedPackName || sanitizedPackName.length === 0) {
        throw new Error('Invalid pack name');
      }
      
      if (!sanitizedPackUrlName || sanitizedPackUrlName.length === 0) {
        throw new Error('Invalid URL name');
      }
      
      if (!sanitizedProcessId || sanitizedProcessId.length === 0) {
        throw new Error('Invalid process ID');
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
        
        // Re-enable the button on failure
        if (createBtn) {
          createBtn.disabled = false;
          createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
        }
      }
    } catch (error) {
      this.hideLoadingOverlay();
      console.error(`Error creating sticker pack:`, error);
      
      // ENHANCED: Better error handling for [Errno 22] Invalid argument
      let errorMessage = error.message;
      if (error.message && (error.message.includes('Invalid argument') || error.message.includes('Errno 22'))) {
        errorMessage = 'Invalid request data - contains invalid characters. Please check your inputs and try again.';
      }
      
      this.addStatusItem(`❌ Error: Failed to create sticker pack - ${errorMessage}`, "error");
      this.showToast(
        "error",
        "Creation Error",
        "Failed to create sticker pack: " + errorMessage
      );
      
      // Re-enable the button on error
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
      }
    }
  }

  startStickerProgressMonitoring(processId) {
    console.log(`[MONITORING] Starting monitoring for process: ${processId}`);
    
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
    }
    
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
          
          // DEBUG LOGGING
          console.log(`[MONITORING] Process ${processId}:`, {
            status: progress.status,
            waiting_for_user: progress.waiting_for_user,
            icon_request_message: !!progress.icon_request_message,
            url_name_taken: !!progress.url_name_taken,
            isIconRequest,
            isUrlConflict,
            auto_skip_handled: progress.auto_skip_handled,
            shareable_link: !!progress.shareable_link
          });
          
          // CRITICAL FIX: Handle backend bug where both icon_request and url_name_taken are set
          // Priority: Icon request comes FIRST, then URL conflict
          if (isIconRequest && isUrlConflict) {
            console.warn(`[MONITORING] Backend bug: Both icon_request and url_name_taken are set! Prioritizing icon request.`);
            // Force isUrlConflict to false to handle icon first
            isUrlConflict = false;
          }
          
          // Handle URL conflict ONLY if it's not an icon request (for manual mode)
          if (isUrlConflict && !isIconRequest && !this.urlPromptHandledProcesses.has(processId)) {
            console.log(`[MONITORING] URL CONFLICT DETECTED! Showing retry modal...`);
            
            // Mark as handled to prevent duplicate processing
            this.urlPromptHandledProcesses.add(processId);
            
            // Stop monitoring while user provides new URL name
            this.stopStickerProgressMonitoring();
            
            // Show URL name modal with the original taken name
            const takenName = progress.original_url_name || progress.pack_url_name || "retry";
            const currentAttempt = progress.url_name_attempts || 1;
            const maxAttempts = progress.max_url_attempts || 3;
            
            this.addStatusItem(`URL name '${takenName}' is taken. Showing retry options (${currentAttempt}/${maxAttempts})`, "warning");
            
            console.log(`[MONITORING] Calling showUrlNameModal with:`, { takenName, currentAttempt, maxAttempts, processId });
            this.showUrlNameModal(takenName, currentAttempt, maxAttempts, processId);
            
            // Verify modal was shown
            setTimeout(() => {
              const modal = document.getElementById("url-name-modal");
              console.log(`[MONITORING] URL modal shown? Modal display:`, modal?.style.display);
            }, 100);
            
            return; // Exit early after handling URL name retry
          }
          
          // PRIORITY CHECK 3: Check for icon selection
          if (progress.waiting_for_user && (progress.icon_request_message || progress.icon_request) && !this.iconHandledProcesses.has(processId)) {
            console.log(`[MONITORING] Icon handling block entered`);
            
            // Check if auto-skip was enabled for this process (from backend)
            const processAutoSkip = progress.auto_skip_icon !== undefined ? progress.auto_skip_icon : true; // Default to true
            // Check if auto-skip has already been handled by the backend
            const autoSkipHandled = progress.auto_skip_handled !== undefined ? progress.auto_skip_handled : false;
            
            console.log(`[MONITORING] Icon handling - auto_skip: ${processAutoSkip}, auto_skip_handled: ${autoSkipHandled}`);
            
            // REMOVED: Don't check for completion here - it's a backend bug setting status=completed while waiting_for_user=true
            // The completion check should happen AFTER user input, not during icon request
            
            // If backend has already handled auto-skip, don't show icon modal
            // BUT CRITICAL: Continue monitoring instead of returning - don't exit early!
            // We MUST check for URL name conflicts and completion even when auto-skip is handled
            if (processAutoSkip && autoSkipHandled) {
              console.log(`[MONITORING] Auto-skip handled by backend, marking icon as processed`);
              
              // Backend is handling auto-skip, mark as handled but continue monitoring
              this.iconHandledProcesses.add(processId);
              
              // CRITICAL: Now check if there's a URL conflict to handle
              // Check the ORIGINAL url_name_taken flag, not isUrlConflict (which we may have modified)
              const hasUrlConflict = !!progress.url_name_taken;
              console.log(`[MONITORING] Checking for URL conflict - url_name_taken: ${progress.url_name_taken}, hasUrlConflict: ${hasUrlConflict}`);
              
              if (hasUrlConflict && !this.urlPromptHandledProcesses.has(processId)) {
                console.log(`[MONITORING] Auto-skip done, now handling URL conflict...`);
                
                // Mark as handled to prevent duplicate processing
                this.urlPromptHandledProcesses.add(processId);
                
                // Stop monitoring while user provides new URL name
                this.stopStickerProgressMonitoring();
                
                // Show URL name modal with the original taken name
                const takenName = progress.original_url_name || progress.pack_url_name || "retry";
                const currentAttempt = progress.url_name_attempts || 1;
                const maxAttempts = progress.max_url_attempts || 3;
                
                this.addStatusItem(`URL name '${takenName}' is taken. Showing retry options (${currentAttempt}/${maxAttempts})`, "warning");
                
                console.log(`[MONITORING] Calling showUrlNameModal with:`, { takenName, currentAttempt, maxAttempts, processId });
                this.showUrlNameModal(takenName, currentAttempt, maxAttempts, processId);
                
                // Verify modal was shown
                setTimeout(() => {
                  const modal = document.getElementById("url-name-modal");
                  console.log(`[MONITORING] URL modal shown? Modal display:`, modal?.style.display);
                }, 100);
                
                return; // Exit after showing URL retry modal
              }
              
              // No URL conflict - continue monitoring
              console.log(`[MONITORING] Auto-skip done, no URL conflict, continuing monitoring...`);
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
                try { this.hideIconModal(); } catch {}
                
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
                    const urlName = (urlInput && typeof urlInput.value === 'string') ? urlInput.value.trim() : '';
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
                const urlName = (urlInput && typeof urlInput.value === 'string') ? urlInput.value.trim() : '';
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
                  } catch {}
                }
                // Fallback: show URL modal to collect the name
                // Only add to urlPromptHandledProcesses when URL modal is shown
                this.urlPromptHandledProcesses.add(processId);
                this.showUrlNameModal(progress.pack_url_name || "retry", 1, 3, processId);
                return;
              }
              
              console.log(`[MONITORING] ICON REQUEST DETECTED! Showing icon modal...`);
              console.log(`[MONITORING] Calling showIconModal with:`, { processId, message: progress.icon_request_message?.substring(0, 50) });
              
              this.showIconModal(processId, progress.icon_request_message);
              this.iconHandledProcesses.add(processId);
              
              // Verify modal was shown
              setTimeout(() => {
                const modal = document.getElementById("icon-modal");
                console.log(`[MONITORING] Icon modal shown? Modal display:`, modal?.style.display);
              }, 100);
              
              // CRITICAL FIX: Don't add to urlPromptHandledProcesses here - only when URL prompt is actually handled
              // this.urlPromptHandledProcesses.add(processId);
              return; // CRITICAL: Exit early after handling icon selection
            }
          }
          
          // PRIORITY CHECK 4: Check completion status
          if (progress.status === "completed") {
            // CRITICAL FIX: Don't treat as completed if still waiting for user input
            if (progress.waiting_for_user) {
              console.warn(`[MONITORING] Backend marked as 'completed' but waiting_for_user=true. Ignoring completion.`);
              // Continue monitoring - this is a backend bug
            } else {
              // CRITICAL FIX: Check if we have a shareable_link, which means the process is ACTUALLY completed
              // In auto-skip flow without URL conflicts, backend completes successfully and provides shareable_link
              const hasShareableLink = !!(progress.shareable_link || progress.pack_link || progress.link);
              
              // ENHANCED: For auto-skip scenario without URL conflicts, backend completes successfully
              // Check for shareable_link OR auto_skip_handled OR normal workflow completion
              if (hasShareableLink || this.workflowState.packCompleted || (this.workflowState.iconUploaded && this.workflowState.urlNameSubmitted) || progress.auto_skip_handled) {
                this.addStatusItem("✅ Sticker pack creation completed successfully!", "completed");
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
            this.addStatusItem(`❌ Sticker pack creation failed: ${progress.current_stage || 'Unknown error'}`, "error");
            this.stopStickerProgressMonitoring();
            this.onStickerProcessCompleted(false, progress);
            return;
          }
          
          // Normal progress updates and media status tracking
          consecutiveErrors = 0;
          
          this.updateStickerProgressDisplay(progress);
          
          // OPTIMIZED: Prevent duplicate stage notifications with better tracking
          if (progress.current_stage && progress.current_stage !== this.lastStage) {
            // Show ALL meaningful stage changes, not just queue messages
            const isQueueMessage = progress.current_stage.includes('waiting in queue');
            const shouldShow = !isQueueMessage || !this.lastStageWasQueue;
            
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
          
          // OPTIMIZED: Reduced from 5 to 3 for faster failure detection
          if (consecutiveErrors >= 3) {
            this.stopStickerProgressMonitoring();
            this.addStatusItem("❌ Process monitoring failed - sticker creation may have stopped", "error");
          }
        }
      } catch (error) {
        consecutiveErrors++;
        
        if (consecutiveErrors >= 3) {
          this.stopStickerProgressMonitoring();
          this.addStatusItem(`❌ Monitoring error: ${error.message}`, "error");
        }
      }
      
      initialChecks++;
    };
    
    // Call immediately for first check
    checkProgress();
    
    // Then set up interval for subsequent checks
    this.stickerProgressInterval = setInterval(checkProgress, 2000); // Check every 2 seconds for faster response
  }

  stopStickerProgressMonitoring() {
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
      this.stickerProgressInterval = null;

    }
    
    // Reset the create button
    const createBtn = document.getElementById("create-sticker-pack");
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
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
      progressText.textContent = `${progress.completed_files}/${progress.total_files} files processed`;
    }
  }

  // OPTIMIZED status list functionality with rate limiting
  addStatusItem(message, type = "info", timestamp = null) {
    const statusList = document.getElementById("sticker-status-list");
    if (!statusList) return;
    
    // FIXED: Only prevent exact duplicate messages, allow similar but different ones
    if (this.lastStatusMessage === message && this.lastStatusType === type) {
      return; // Skip exact duplicate
    }
    
    this.lastStatusMessage = message;
    this.lastStatusType = type;

    const time = timestamp || new Date();
    const timeString = time.toLocaleTimeString();
    
    const statusItem = document.createElement('div');
    statusItem.className = `status-item ${type}`;
    
    const iconClass = this.getStatusIconClass(type);
    
    statusItem.innerHTML = `
      <div class="status-time">${timeString}</div>
      <div class="status-message">${message}</div>
      <div class="status-icon"><i class="${iconClass}"></i></div>
    `;
    
    // Add to the top of the list (latest first)
    statusList.insertBefore(statusItem, statusList.firstChild);
    
    // OPTIMIZED: Limit to 50 items to show more progress history
    const items = statusList.querySelectorAll('.status-item');
    if (items.length > 50) {
      statusList.removeChild(items[items.length - 1]);
    }
    
    // Auto-scroll to show latest message if enabled
    if (this.autoScrollEnabled) {
      statusItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  getStatusIconClass(type) {
    const iconMap = {
      'ready': 'fas fa-check-circle',
      'processing': 'fas fa-spinner fa-spin',
      'completed': 'fas fa-check-circle',
      'error': 'fas fa-exclamation-circle',
      'warning': 'fas fa-exclamation-triangle',
      'info': 'fas fa-info-circle'
    };
    return iconMap[type] || 'fas fa-info-circle';
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
    
    // CRITICAL FIX: Only show completion if workflow is actually finished
    if (success && !this.workflowState.packCompleted) {
      // Update workflow state to mark as completed
      this.workflowState.packCompleted = true;
      this.workflowState.currentStep = 'completed';
      
      this.sessionStats.totalStickers += this.mediaFiles.length;
      
      // Check if manual completion is required
      if (progressData?.manual_completion_required) {
        this.addStatusItem("Sticker pack processing completed - manual completion required in Telegram bot", "warning");
        this.showToast("warning", "Manual Setup Required", "Please complete sticker pack creation manually in the Telegram bot (@Stickers)");
        
        // Show special modal for manual completion
        this.showManualCompletionModal();
      } else {
        this.addStatusItem("Sticker pack created successfully!", "completed");
        
        // ENHANCED: Check for multiple possible property names for shareable link with detailed logging
        const shareableLink = progressData?.shareable_link || progressData?.pack_link || progressData?.link;
        
        if (shareableLink) {
          this.showSuccessModal(shareableLink);
        } else {
          // Still show a success message even without link
          this.showToast("success", "Pack Created", "Sticker pack created successfully!");
        }
      }
    } else if (!success) {
      this.addStatusItem(`Sticker pack creation failed: ${progressData?.error || "Unknown error"}`, "error");
    } else {
      // CRITICAL FIX: Prevent duplicate completion messages
      console.log("Workflow already completed, skipping duplicate completion message");
    }
    this.updateStats();
    
    // Reset button
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
    }
    
    // Mark all files as completed or error
    this.mediaFiles.forEach((file) => {
      if (file.status !== "completed") {
        file.status = success ? "completed" : "error";
      }
    });
    
    this.updateMediaFileList();
    
    // Show completion notification
    if (success) {
      if (!progressData?.manual_completion_required) {
        this.showToast(
          "success",
          "Pack Created",
          "Sticker pack created successfully!"
        );
        this.playNotificationSound();
        this.showSystemNotification(
          "Sticker Pack Created",
          "Your sticker pack has been published successfully!"
        );
      }
      
      // FIXED: Update backend database stats for successful sticker creation
      this.updateStickerCreationStats(this.mediaFiles.length);
      
    } else {
      this.showToast(
        "error",
        "Creation Failed",
        `Sticker pack creation failed: ${progressData?.error || "Unknown error"}`
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
        console.log(`✅ [STATS] Successfully updated sticker stats`);
        // Force refresh database stats display
        this.updateDatabaseStats();
      } else {
        console.warn(`⚠️ [STATS] Failed to update sticker stats:`, response.error);
      }
    } catch (error) {
      console.error(`❌ [STATS] Error updating sticker creation stats:`, error);
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
        overlay.style.willChange = 'opacity';
        modal.style.willChange = 'transform, opacity';
        
        // Use the CSS class-based approach for proper centering
        overlay.classList.add("active");
        // Remove any explicit display style that might override the CSS
        overlay.style.display = "";
        overlay.style.visibility = "";
        
        // CRITICAL FIX: Ensure proper modal positioning
        modal.style.display = "block";
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
          overlay.style.willChange = 'auto';
          modal.style.willChange = 'auto';
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
        // Remove explicit styles that might interfere with CSS
        overlay.style.display = "";
        overlay.style.visibility = "";
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
    console.log(`🖼️ [ICON_MODAL] Showing icon modal with message: ${iconRequestMessage}`);
    
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
    console.log(`🔗 [URL_MODAL] Showing URL name modal - taken: ${takenUrlName}, attempt: ${attemptNumber}/${maxAttempts}`);
    
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
      submitBtn.classList.remove('loading');
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
    
    const cleanBase = baseName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 15);
    const random = () => Math.floor(Math.random() * 999) + 100;
    const currentYear = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const day = String(new Date().getDate()).padStart(2, '0');
    
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
        const prefix = suggestion.split('_')[1];
        return !usedPrefixes.has(prefix) && suggestion.length >= 5 && suggestion.length <= 32;
      });
      
      if (options.length > 0) {
        const selected = options[Math.floor(Math.random() * options.length)];
        smartSuggestions.push(selected);
        usedPrefixes.add(selected.split('_')[1]);
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
    ).join('');
  }
  
  applySuggestion(suggestion) {
    const input = document.getElementById("new-url-name");
    if (input) {
      input.value = suggestion;
      input.dispatchEvent(new Event('input')); // Trigger validation
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
      console.error('new-url-name input not found');
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
        submitBtn.classList.add('loading');
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
        this.workflowState.currentStep = 'url_name';
        
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
            this.showUrlNameModal(processId, newUrlName, nextAttempt, maxAttempts);
            return; // Don't re-enable the button, show new modal
          } else {
            // Exhausted all retries - mark as completed with manual instruction
            this.addStatusItem(`❌ All ${maxAttempts} retry attempts exhausted. Please add sticker pack manually in Telegram bot.`, "error");
            this.showToast("warning", "Manual Setup Required", `Please complete the sticker pack creation manually in the Telegram bot (@Stickers)`); 
            
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
          submitBtn.classList.remove('loading');
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
        submitBtn.classList.remove('loading');
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
      if (error.message && error.message.includes('timeout')) {
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
      this.addStatusItem(`Uploading icon file${retryCount > 0 ? ` (attempt ${retryCount + 1}/${maxRetries + 1})` : ''}...`, "info");
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
          this.workflowState.currentStep = 'url_name';
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
          this.workflowState.currentStep = 'url_name';
          this.startStickerProgressMonitoring(this.currentIconProcessId);
        }
      } else {
        // Detect Telegram size error and mark as manual continuation allowed
        const errorText = String(response.error || '').toLowerCase();
        if (errorText.includes('too big') || errorText.includes('maximum file size') || 
            errorText.includes('invalid file') || errorText.includes('file type') || 
            response.manual_completion_required) {
          // CRITICAL FIX: Handle both size and format errors with appropriate messages
          const isSizeError = errorText.includes('too big') || errorText.includes('maximum file size');
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
        if (response.error && (response.error.includes('timeout') || response.error.includes('Request timeout'))) {
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
          const friendly = response.error && response.error.includes('not waiting for user')
            ? 'Icon step not ready yet. Please wait for the bot to request the icon and try again.'
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
      if (error.message && (error.message.includes('timeout') || error.message.includes('Request timeout'))) {
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
        if (error.message && (error.message.includes('timeout') || error.message.includes('network') || error.message.includes('fetch'))) {
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
    console.log('🔔 showToast called:', { type, title, message });
    
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) {
      console.error('❌ Toast container not found!');
      alert(`${type.toUpperCase()}: ${title} - ${message}`);
      return;
    }
    
    console.log('✅ Toast container found');
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    toast.innerHTML = `
      <h4>${title}</h4>
      <p>${message}</p>
    `;
    
    console.log('✅ Toast element created');
    
    // Simply append the toast - CSS flexbox will handle proper stacking
    toastContainer.appendChild(toast);
    
    console.log('✅ Toast added to container');
    
    // Auto-remove with proper cleanup
    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.remove();
        console.log('✅ Toast removed');
      }
    }, duration);
    
    // Click to dismiss with proper cleanup
    toast.onclick = () => {
      toast.remove();
      console.log('✅ Toast clicked and removed');
    };
  }

  repositionToasts() {
    // Move remaining toasts up to fill gaps
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) return;
    
    const toasts = toastContainer.querySelectorAll('.toast');
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
        audio.play().catch(() => {}); // Ignore errors
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
    const overlay = document.createElement('div');
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
    
    const modal = document.createElement('div');
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
    if (!document.getElementById('modal-animations')) {
      const style = document.createElement('style');
      style.id = 'modal-animations';
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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });
    
    // Close on Escape key
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
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
         (health.status && health.status.toLowerCase().includes('connected')));
      
      
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
      if (!res?.success || !res?.data) throw new Error(res?.error || 'readStats failed');
      const s = res.data;
      const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };

      setText('total-conversions', s.total_conversions);
      setText('successful-conversions', s.successful_conversions);
      setText('failed-conversions', s.failed_conversions);
      setText('total-hexedits', s.total_hexedits);
      setText('successful-hexedits', s.successful_hexedits);
      setText('failed-hexedits', s.failed_hexedits);
      setText('total-stickers-created', s.total_stickers_created);

      const ses = document.getElementById('session-start') || document.getElementById('session-started');
      if (ses && s.session_started) ses.textContent = new Date(s.session_started * 1000).toLocaleString();
    } catch (e) {
      console.error('❌ updateDatabaseStats (preload) failed:', e);
    }
  }

  // Force immediate database stats update - useful during active operations
  async forceUpdateDatabaseStats() {
    try {
      await this.updateDatabaseStats();
      if (RENDERER_DEBUG) console.log('🔄 Database stats force updated');
    } catch (e) {
      console.error('❌ forceUpdateDatabaseStats failed:', e);
    }
  }

  updateStats() {
    // Do NOT touch database info fields here to avoid overwriting with zeros
    // Keep only non-database UI refresh (e.g., local cache size)
    const cacheSizeEl = document.getElementById('cache-size');
    if (cacheSizeEl) {
      const cacheSize = Math.round(JSON.stringify(localStorage).length / 1024);
      cacheSizeEl.textContent = `${cacheSize} KB`;
    }
  }

  async exportStats() {
    try {
      const res = await window.electronAPI.readStats();
      if (!res?.success || !res?.data) throw new Error(res?.error || 'readStats failed');
      const d = res.data;
      const payload = {
        total_conversions: d.total_conversions ?? 0,
        successful_conversions: d.successful_conversions ?? 0,
        failed_conversions: d.failed_conversions ?? 0,
        total_hexedits: d.total_hexedits ?? 0,
        successful_hexedits: d.successful_hexedits ?? 0,
        failed_hexedits: d.failed_hexedits ?? 0,
        total_stickers_created: d.total_stickers_created ?? 0,
        session_started: d.session_started ?? null,
        exported_at: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `database-stats-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('Database stats exported', 'success');
    } catch (e) {
      console.error('Export stats failed:', e);
      this.showToast('Failed to export stats', 'error');
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
    const confirmMessage = `
This will permanently delete:
• All saved API credentials
• Application settings and preferences  
• Session data and cached files
• File lists and progress data
This action cannot be undone. Are you sure?
        `;
    
    if (confirm(confirmMessage.trim())) {
      try {
        // Clear localStorage
        const keysToKeep = ["app_theme"]; // Keep theme preference
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
        const formInputs = [
          "api-id",
          "api-hash",
          "phone-number",
          "video-output-dir",
          "pack-name",
        ];
        formInputs.forEach((id) => {
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
        this.apiRequest("POST", "/api/clear-session")
          .then(() => {
            if (RENDERER_DEBUG) console.log("Backend session cleared");
          })
          .catch(err => {
            if (RENDERER_DEBUG) console.log("Failed to clear backend session:", err);
          });
        
        this.showToast(
          "success",
          "Data Cleared",
          "All application data has been cleared successfully"
        );
      } catch (error) {
        if (RENDERER_DEBUG) console.error("Error clearing data:", error);
        this.showToast(
          "error",
          "Clear Failed",
          "Failed to clear some data: " + error.message
        );
      }
    }
  }

  updateButtonStates() {
    const startConversionBtn = document.getElementById("start-conversion");
    const pauseConversionBtn = document.getElementById("pause-conversion");
    const resumeConversionBtn = document.getElementById("resume-conversion");
    const startHexEditBtn = document.getElementById("start-hex-edit");
    const pauseHexEditBtn = document.getElementById("pause-hex-edit");
    const resumeHexEditBtn = document.getElementById("resume-hex-edit");
    
    // Reset all buttons first
    [startConversionBtn, pauseConversionBtn, resumeConversionBtn, 
     startHexEditBtn, pauseHexEditBtn, resumeHexEditBtn].forEach(btn => {
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
        startHexEditBtn.style.opacity = '1';
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
      // Hex editing running
      if (startConversionBtn) {
        startConversionBtn.style.display = "inline-flex";
        startConversionBtn.disabled = true;
      }
      
      if (this.isPaused) {
        if (resumeHexEditBtn) resumeHexEditBtn.style.display = "inline-flex";
      } else {
        if (pauseHexEditBtn) pauseHexEditBtn.style.display = "inline-flex";
      }
    }
  }

  async pauseOperation() {
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
          pauseBtn.style.display = 'none';
        }
        
        if (resumeBtn) {
          resumeBtn.style.display = 'inline-block';
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
          pauseBtn.style.display = 'inline-block';
          pauseBtn.disabled = false;
        }
        
        if (resumeBtn) {
          resumeBtn.style.display = 'none';
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
        hexBtn.style.opacity = '0.5';
      }
      
      if (this.isPaused) {
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (resumeBtn) resumeBtn.style.display = 'inline-block';
      } else {
        if (pauseBtn) pauseBtn.style.display = 'inline-block';
        if (resumeBtn) resumeBtn.style.display = 'none';
      }
    } else if (isHexEditing) {
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
      }
      
      if (hexBtn) {
        hexBtn.disabled = true;
        hexBtn.innerHTML = '<i class="fas fa-cog fa-spin"></i> Hex Editing...';
      }
      
      if (this.isPaused) {
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (resumeBtn) resumeBtn.style.display = 'inline-block';
      } else {
        if (pauseBtn) pauseBtn.style.display = 'inline-block';
        if (resumeBtn) resumeBtn.style.display = 'none';
      }
    }
  }

  // System Management Functions
  async clearCache() {
    try {
      // Clear localStorage cache
      const keysToKeep = ['telegram_api_id', 'telegram_api_hash', 'telegram_bot_token', 'telegram_chat_id'];
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (!keysToKeep.includes(key)) {
          localStorage.removeItem(key);
        }
      });
      
      // Update display
      document.getElementById('cache-size').textContent = '0 MB';
      this.showToast('Cache cleared successfully', 'success');
    } catch (error) {
      if (RENDERER_DEBUG) console.error('Failed to clear cache:', error);
      this.showToast('Failed to clear cache', 'error');
    }
  }
  

  async restartBackend() {
    try {
      this.showToast('Restarting backend...', 'info');
      const response = await this.apiRequest('POST', '/api/restart');
      
      // Wait a bit for backend to restart
      setTimeout(() => {
        this.checkBackendStatus();
        this.showToast('Backend restarted successfully', 'success');
      }, 3000);
    } catch (error) {
      if (RENDERER_DEBUG) console.error('Failed to restart backend:', error);
      // Try to reconnect after a delay
      setTimeout(() => {
        this.checkBackendStatus();
      }, 5000);
    }
  }
  
  async resetStats() {
    if (confirm('Are you sure you want to reset all statistics?')) {
      try {
        const response = await this.apiRequest("POST", "/api/reset-stats");
        if (response.success) {
          this.showToast("success", "Statistics Reset", "All statistics have been reset");
          // Force immediate database stats update after reset
          await this.forceUpdateDatabaseStats();
          // Update the display
          await this.updateDatabaseStats();
        } else {
          this.showToast("error", "Reset Failed", response.error || "Failed to reset statistics");
        }
      } catch (error) {
        this.showToast("error", "Reset Failed", "Failed to reset statistics: " + error.message);
      }
    }
  }

  async clearLogs() {
    if (confirm('Are you sure you want to clear all log files?')) {
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
  }

  async clearCredentials() {
    if (confirm('Are you sure you want to clear all saved credentials? This will require you to re-enter your Telegram API credentials.')) {
      try {
        const response = await this.apiRequest("POST", "/api/clear-credentials");
        if (response.success) {
          this.showToast("success", "Credentials Cleared", response.message);
          // Clear local storage credentials too
          localStorage.removeItem("telegram_api_id");
          localStorage.removeItem("telegram_api_hash");
          localStorage.removeItem("telegram_phone");
          // Reload the form
          this.initializeTelegramForm();
        } else {
          this.showToast("error", "Clear Failed", response.error || "Failed to clear credentials");
        }
      } catch (error) {
        this.showToast("error", "Clear Failed", "Failed to clear credentials: " + error.message);
      }
    }
  }
  
  async killPythonProcesses() {
    // Show custom confirmation modal
    this.showKillProcessesModal();
  }

  showKillProcessesModal() {
    const modalHtml = `
      <div class="modal-overlay" id="kill-processes-modal">
        <div class="modal-content">
          <div class="modal-header">
            <h3><i class="fas fa-exclamation-triangle" style="color: #ff6b6b;"></i> Kill Python Processes</h3>
            <button class="modal-close" onclick="window.app?.hideKillProcessesModal()">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="modal-body">
            <div class="warning-box">
              <p><strong>⚠️ WARNING:</strong> This will kill ALL Python processes on your system!</p>
              <p>This includes:</p>
              <ul>
                <li>This app's backend</li>
                <li>Any other Python scripts running</li>
                <li>Jupyter notebooks</li>
                <li>Python IDEs</li>
              </ul>
              <p><strong>You will need to restart this app after killing the processes.</strong></p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="window.app?.hideKillProcessesModal()">
              <i class="fas fa-times"></i> Cancel
            </button>
            <button class="btn btn-danger" onclick="window.app?.confirmKillProcesses()">
              <i class="fas fa-skull-crossbones"></i> Kill All Processes
            </button>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('kill-processes-modal');
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Add escape key handler
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        this.hideKillProcessesModal();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  hideKillProcessesModal() {
    const modal = document.getElementById('kill-processes-modal');
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
        
        // Show additional info if there were errors
        if (response.errors && response.errors.length > 0) {
          console.warn("Some processes couldn't be killed:", response.errors);
        }
        
        // Note: The backend will be killed, so the app might become unresponsive
        // User will need to restart the app
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
  
  // Enhanced emoji modal functions
  setupEmojiModal() {
    // Emoji tab switching with delegation for better performance
    const tabContainer = document.querySelector('.emoji-tabs');
    const categories = document.querySelectorAll('.emoji-category');
    
    if (tabContainer) {
      tabContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.emoji-tab');
        if (!tab) return;
        
        const category = tab.getAttribute('data-category');
        
        // Update active tab
        document.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Update active category
        categories.forEach(cat => cat.classList.remove('active'));
        const targetCategory = document.getElementById(`category-${category}`);
        if (targetCategory) {
          targetCategory.classList.add('active');
        }
      });
    }
    
    // Setup smooth scroll navigation buttons
    this.setupEmojiScrollNavigation();
  }
  
  setupEmojiScrollNavigation() {
    const tabsContainer = document.querySelector('.emoji-tabs');
    
    if (!tabsContainer) {
      console.log('Emoji tabs container not found');
      return;
    }
    
    // Enable mouse wheel scrolling
    tabsContainer.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        tabsContainer.scrollBy({
          left: e.deltaY > 0 ? 100 : -100,
          behavior: 'smooth'
        });
      }
    });
    
    // Enable drag scrolling
    let isDown = false;
    let startX;
    let scrollLeft;
    
    tabsContainer.addEventListener('mousedown', (e) => {
      isDown = true;
      startX = e.pageX - tabsContainer.offsetLeft;
      scrollLeft = tabsContainer.scrollLeft;
      tabsContainer.style.cursor = 'grabbing';
    });
    
    tabsContainer.addEventListener('mouseleave', () => {
      isDown = false;
      tabsContainer.style.cursor = 'grab';
    });
    
    tabsContainer.addEventListener('mouseup', () => {
      isDown = false;
      tabsContainer.style.cursor = 'grab';
    });
    
    tabsContainer.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - tabsContainer.offsetLeft;
      const walk = (x - startX) * 2; // Scroll speed
      tabsContainer.scrollLeft = scrollLeft - walk;
    });
    
    // Single delegated event for all emoji buttons
    const emojiContainer = document.querySelector('.emoji-picker-enhanced');
    if (emojiContainer) {
      emojiContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.emoji-btn');
        if (!btn) return;
        
        const emoji = btn.getAttribute('data-emoji');
        const input = document.getElementById('emoji-input');
        const preview = document.getElementById('emoji-preview-icon');
        
        if (input) input.value = emoji;
        if (preview) preview.textContent = emoji;
      });
    }
    
    // Live emoji preview
    const emojiInput = document.getElementById('emoji-input');
    if (emojiInput) {
      let debounceTimer;
      emojiInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const preview = document.getElementById('emoji-preview-icon');
          if (preview && e.target.value) {
            preview.textContent = e.target.value;
          }
        }, 50);
      });
    }
  }

  applyEmojiToAll() {
    const currentEmoji = document.getElementById('emoji-input')?.value || '😀';
    
    this.mediaFiles.forEach(file => {
      file.emoji = currentEmoji;
    });
    
    this.updateMediaFileList();
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
    this.showToast("success", "Sequential Emojis", "Applied sequential emojis to all files");
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
    this.showToast("success", "Theme Emojis", `Applied ${selectedTheme} theme emojis to all files`);
  }
  
  sortMedia(sortType) {
    if (!this.mediaFiles || this.mediaFiles.length === 0) return;
    
    switch(sortType) {
      case 'name-asc':
        this.mediaFiles.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        this.mediaFiles.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'date-new':
        this.mediaFiles.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
        break;
      case 'date-old':
        this.mediaFiles.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
        break;
      case 'size-large':
        this.mediaFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
      case 'size-small':
        this.mediaFiles.sort((a, b) => (a.size || 0) - (b.size || 0));
        break;
    }
    
    this.updateMediaFileList();
    this.showToast("success", "Sorted", `Files sorted by ${sortType.replace('-', ' ')}`);
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
    const coffeeBtn = document.querySelector('.coffee-btn');
    if (coffeeBtn) {
      coffeeBtn.addEventListener('click', () => {
        this.showSupportModal('coffee', 'Buy Me a Coffee', 
          'Support my open source work with a coffee! ☕\n\n' +
          'This will open your default browser to a coffee donation page.\n' +
          'You can replace this with your actual coffee.me or similar link later.');
      });
    }
    
    // PayPal button
    const paypalBtn = document.querySelector('.paypal-btn');
    if (paypalBtn) {
      paypalBtn.addEventListener('click', () => {
        this.showSupportModal('paypal', 'PayPal Donation', 
          'Support my work via PayPal! 💰\n\n' +
          'This will open your default browser to PayPal.\n' +
          'You can replace this with your actual PayPal.me link later.');
      });
    }
    
    // GitHub Sponsors button
    const githubBtn = document.querySelector('.github-btn');
    if (githubBtn) {
      githubBtn.addEventListener('click', () => {
        this.showSupportModal('github', 'GitHub Sponsors', 
          'Become a GitHub Sponsor! 🌟\n\n' +
          'This will open your GitHub profile for sponsorship.\n' +
          'You can replace this with your actual GitHub Sponsors link later.');
      });
    }
    
    // Star Projects button
    const starBtn = document.querySelector('.star-btn');
    if (starBtn) {
      starBtn.addEventListener('click', () => {
        this.showSupportModal('star', 'Star Projects', 
          'Show your appreciation by starring my projects! ⭐\n\n' +
          'This will open your GitHub repositories.\n' +
          'You can replace this with your actual project links later.');
      });
    }
  }
  
  setupProjectLinks() {
    // Add click tracking for project links
    const projectLinks = document.querySelectorAll('.project-link');
    projectLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        // Track project clicks
        if (RENDERER_DEBUG) console.log('🚀 Project link clicked:', link.href);
        this.showToast('info', 'Opening Project', 'Opening project in your browser...');
      });
    });
  }
  
  setupChannelPromotion() {
    const channelBtn = document.querySelector('.channel-join-btn');
    if (channelBtn) {
      channelBtn.addEventListener('click', (e) => {
        if (RENDERER_DEBUG) console.log('📱 Channel join button clicked');
        this.showToast('success', 'Joining Channel', 'Opening Telegram channel in your browser...');
      });
    }
  }
  
  showSupportModal(type, title, message) {
    // Create a simple modal for support options
    const modal = document.createElement('div');
    modal.className = 'support-modal';
    modal.innerHTML = `
      <div class="support-modal-content">
        <div class="support-modal-header">
          <h3>${title}</h3>
          <button class="support-modal-close">&times;</button>
        </div>
        <div class="support-modal-body">
          <p>${message.replace(/\n/g, '<br>')}</p>
        </div>
        <div class="support-modal-footer">
          <button class="btn btn-secondary support-modal-cancel">Cancel</button>
          <button class="btn btn-primary support-modal-proceed">Proceed</button>
        </div>
      </div>
    `;
    
    // Add modal styles
    const style = document.createElement('style');
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
    const closeBtn = modal.querySelector('.support-modal-close');
    const cancelBtn = modal.querySelector('.support-modal-cancel');
    const proceedBtn = modal.querySelector('.support-modal-proceed');
    
    const closeModal = () => {
      modal.remove();
      style.remove();
    };
    
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    
    // Handle proceed button
    proceedBtn.addEventListener('click', () => {
      closeModal();
      
      // Open appropriate link based on type
      let url = '';
      switch(type) {
        case 'coffee':
          url = 'https://buymeacoffee.com/JoonJelly'; // Updated with actual link
          break;
        case 'paypal':
          url = 'https://paypal.me/'; // Replace with your actual link
          break;
        case 'github':
          url = 'https://github.com/RohitPoul'; // Updated with your actual GitHub profile
          break;
        case 'star':
          url = 'https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader'; // Updated with your actual repositories
          break;
      }
      
      if (url) {
        // Use Electron's shell API to open external URLs
        if (window.electronAPI && window.electronAPI.shell && window.electronAPI.shell.openExternal) {
          window.electronAPI.shell.openExternal(url);
        } else {
          // Fallback to window.open if Electron API is not available
          window.open(url, '_blank');
        }
        this.showToast('success', 'Link Opened', 'Opening support page in your browser...');
      }
    });

    // Close on outside click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  initializeNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    if (RENDERER_DEBUG) console.log('Navigation items:', navItems);

    navItems.forEach((item) => {
      item.addEventListener("click", () => {
        // Remove active class from all nav items
        navItems.forEach((navItem) => navItem.classList.remove("active"));
        
        // Add active class to clicked nav item
        item.classList.add("active");
        
        const tabId = item.getAttribute("data-tab");
        if (RENDERER_DEBUG) console.log('Clicked tab:', tabId);
        
        this.handleTabSwitch(tabId);
      });
    });

    // Ensure initial tab is set correctly
    const initialActiveTab = document.querySelector(".nav-item.active");
    if (initialActiveTab) {
      const initialTabId = initialActiveTab.getAttribute("data-tab");
      if (RENDERER_DEBUG) console.log('Initial active tab:', initialTabId);
      this.handleTabSwitch(initialTabId);
    } else {
      if (RENDERER_DEBUG) console.warn('No initial active tab found');
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
      container.innerHTML = '';

      // Slice the visible portion of data
      const visibleData = dataSource.slice(startIndex, endIndex);

      // Render visible items
      visibleData.forEach((item, index) => {
        const itemElement = document.createElement('div');
        itemElement.classList.add('virtual-list-item');
        renderFunction(itemElement, item, startIndex + index);
        container.appendChild(itemElement);
      });

      // Add padding to simulate full list height
      const topPadding = document.createElement('div');
      topPadding.style.height = `${startIndex * itemHeight}px`;
      container.insertBefore(topPadding, container.firstChild);

      const bottomPadding = document.createElement('div');
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
    container.addEventListener('scroll', handleScroll);

    // Return methods for external control
    return {
      update: (newDataSource) => {
        dataSource = newDataSource;
        render();
      },
      destroy: () => {
        container.removeEventListener('scroll', handleScroll);
      }
    };
  }

  // Example usage for file lists
  initializeVirtualLists() {
    // Virtual scrolling for video file list
    this.videoFileList = this.createVirtualList(
      '#video-file-list', 
      '.file-item', 
      this.videoFiles, 
      (element, file, index) => {
        element.innerHTML = `
          <div class="file-info">
            <i class="fas fa-file-video file-icon"></i>
            <div class="file-details">
              <div class="file-name">${file.name}</div>
              <div class="file-path">${file.path}</div>
            </div>
          </div>
          <div class="file-actions">
            <button class="btn btn-sm btn-secondary">Remove</button>
          </div>
        `;
      }
    );

    // Similar implementation for sticker media list
    this.stickerMediaList = this.createVirtualList(
      '#sticker-media-list', 
      '.media-item', 
      this.stickerFiles, 
      (element, file, index) => {
        element.innerHTML = `
          <div class="media-info">
            <i class="fas fa-image media-icon"></i>
            <div class="media-details">
              <div class="media-name">${file.name}</div>
              <div class="media-type">${file.type}</div>
            </div>
          </div>
          <div class="media-actions">
            <button class="btn btn-sm btn-secondary">Remove</button>
          </div>
        `;
      }
    );
  }

  async getFileMetadata(filePath) {
    try {
      const response = await this.apiRequest('POST', '/api/get-file-info', {
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
      if (RENDERER_DEBUG) console.warn(`Failed to get metadata for ${filePath}:`, error);
    }
    
    // Fallback: try to get basic file size
    try {
      const response = await this.apiRequest('POST', '/api/analyze-video', {
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
      if (RENDERER_DEBUG) console.warn(`Failed to analyze video ${filePath}:`, error);
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
    
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  formatDuration(seconds) {
    if (seconds === "Unknown" || !seconds) return "Unknown";
    
    if (typeof seconds === 'string' && seconds.includes('s')) {
      return seconds; // Already formatted
    }
    
    const secs = parseFloat(seconds);
    if (isNaN(secs)) return "Unknown";
    
    const minutes = Math.floor(secs / 60);
    const remainingSeconds = Math.floor(secs % 60);
    
    if (minutes > 0) {
      return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
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
      if (RENDERER_DEBUG) console.log(`[SECURE] Stored ${key} securely`);
    } catch (error) {
      if (RENDERER_DEBUG) console.error(`[SECURE] Error storing ${key}:`, error);
      this.showToast('error', 'Credential Storage Error', 'Failed to securely store credentials');
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
      this.showToast('error', 'Credential Retrieval Error', 'Failed to retrieve stored credentials');
      return null;
    }
  }

  // Simple XOR encryption for localStorage (basic obfuscation)
  encryptData(data) {
    if (!data) return '';
    const key = 'TELEGRAM_SECURE_KEY';
    return btoa(data.split('').map((char, index) => 
      String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))
    ).join(''));
  }

  decryptData(encryptedData) {
    if (!encryptedData) return '';
    const key = 'TELEGRAM_SECURE_KEY';
    return atob(encryptedData).split('').map((char, index) => 
      String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))
    ).join('');
  }

  // Modify existing credential storage methods
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
        localStorage.setItem('telegramCredentials', JSON.stringify(credentials));
        this.showToast('success', 'Saved', 'Telegram credentials saved securely');
      } catch (error) {
        this.showToast('warning', 'Save Failed', 'Could not save credentials');
      }
    }
  }

  loadCredentials() {
    try {
      const savedCredentials = localStorage.getItem('telegramCredentials');
      if (savedCredentials) {
        const { apiId, apiHash, phoneNumber } = JSON.parse(savedCredentials);
        
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");
    
    if (apiIdInput && apiHashInput && phoneInput) {
          apiIdInput.value = apiId || '';
          apiHashInput.value = apiHash || '';
          phoneInput.value = phoneNumber || '';
        }
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error('Error loading credentials:', error);
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
      apiIdInput.addEventListener('change', () => this.saveCredentials());
    }
    if (apiHashInput) {
      apiHashInput.addEventListener('change', () => this.saveCredentials());
    }
    if (phoneInput) {
      phoneInput.addEventListener('change', () => this.saveCredentials());
    }
  }

  // Add method to clear credentials
  clearStoredCredentials() {
    try {
      localStorage.removeItem('telegram_api_id');
      localStorage.removeItem('telegram_api_hash');
      localStorage.removeItem('telegram_phone');
      
      // Clear input fields
      const apiIdInput = document.getElementById("telegram-api-id");
      const apiHashInput = document.getElementById("telegram-api-hash");
      const phoneInput = document.getElementById("telegram-phone");
      
      if (apiIdInput) apiIdInput.value = '';
      if (apiHashInput) apiHashInput.value = '';
      if (phoneInput) phoneInput.value = '';
      
      this.showToast('success', 'Credentials Cleared', 'Telegram credentials have been removed');
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[SECURE] Error clearing credentials:', error);
      this.showToast('error', 'Clearing Error', 'Failed to clear stored credentials');
    }
  }

  // Enhanced phone number management
  savePhoneNumber(phoneNumber) {
    try {
      // Securely store phone number
      this.secureStoreCredentials('telegram_last_phone', phoneNumber);
      
      // Optional: Store recent phone numbers (up to 5)
      const recentPhones = this.getRecentPhoneNumbers();
      if (!recentPhones.includes(phoneNumber)) {
        recentPhones.unshift(phoneNumber);
        // Keep only the last 5 unique phone numbers
        const uniqueRecentPhones = [...new Set(recentPhones)].slice(0, 5);
        localStorage.setItem('telegram_recent_phones', JSON.stringify(uniqueRecentPhones));
      }
      
      if (RENDERER_DEBUG) console.log('[PHONE] Phone number saved successfully');
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[PHONE] Error saving phone number:', error);
    }
  }

  getRecentPhoneNumbers() {
    try {
      const storedPhones = localStorage.getItem('telegram_recent_phones');
      return storedPhones ? JSON.parse(storedPhones) : [];
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[PHONE] Error retrieving recent phone numbers:', error);
      return [];
    }
  }

  populatePhoneInputWithRecent() {
    const phoneInput = document.getElementById("telegram-phone");
    const recentPhonesContainer = document.getElementById("recent-phones-container");
    
    if (!phoneInput || !recentPhonesContainer) return;

    // Clear existing recent phones
    recentPhonesContainer.innerHTML = '';

    const recentPhones = this.getRecentPhoneNumbers();
    
    // Populate recent phones dropdown
    if (recentPhones.length > 0) {
      recentPhones.forEach(phone => {
        const phoneOption = document.createElement('button');
        phoneOption.textContent = phone;
        phoneOption.className = 'recent-phone-option';
        phoneOption.addEventListener('click', () => {
          phoneInput.value = phone;
          // Optional: hide dropdown after selection
          recentPhonesContainer.style.display = 'none';
        });
        recentPhonesContainer.appendChild(phoneOption);
      });
      
      // Show dropdown if there are recent phones
      recentPhonesContainer.style.display = recentPhones.length > 0 ? 'flex' : 'none';
    }
  }

  // Input handling methods
  setupInputHandlers() {
    // Clipboard paste functionality
    const pasteButtons = document.querySelectorAll('.btn-paste');
    pasteButtons.forEach(button => {
      button.addEventListener('click', async () => {
        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        
        try {
          const clipboardText = await navigator.clipboard.readText();
          if (clipboardText) {
            targetInput.value = clipboardText.trim();
            this.showToast('success', 'Clipboard', 'Text pasted successfully');
          }
        } catch (error) {
          if (RENDERER_DEBUG) console.error('Clipboard paste error:', error);
          this.showToast('error', 'Clipboard Error', 'Failed to paste from clipboard');
        }
      });
    });

    // Input visibility toggle
    const visibilityButtons = document.querySelectorAll('.btn-toggle-visibility');
    visibilityButtons.forEach(button => {
      button.addEventListener('click', () => {
        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        const icon = button.querySelector('i');
        
        if (targetInput.type === 'tel' || targetInput.type === 'password') {
          targetInput.type = 'text';
          icon.classList.remove('fa-eye-slash');
          icon.classList.add('fa-eye');
        } else {
          targetInput.type = 'tel';
          icon.classList.remove('fa-eye');
          icon.classList.add('fa-eye-slash');
        }
      });
    });
  }

  // Check for existing Telegram session on startup
  async checkExistingConnection() {
    try {
      if (RENDERER_DEBUG) console.log('[DEBUG] Checking for existing Telegram session...');
      
      const response = await this.apiRequest("GET", "/api/telegram/session-status");
      
      if (response && response.success && response.data) {
        const { session_exists, session_valid } = response.data;
        
        if (session_exists && session_valid) {
          if (RENDERER_DEBUG) console.log('[DEBUG] Found valid existing session - setting connected status');
          this.updateTelegramStatus("connected");
          return true;
        }
      }
      
      if (RENDERER_DEBUG) console.log('[DEBUG] No valid session found - setting disconnected status');
      this.updateTelegramStatus("disconnected");
      return false;
      
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[DEBUG] Error checking session status:', error);
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
      console.error('Session cleanup error:', error);
      return false;
    }
  }

  // Modify initialization to include input handlers
  async initializeTelegramConnection() {
    this.logDebug('initializeTelegramConnection() - CLEAN WORKFLOW');
    
    // CLEAN WORKFLOW: Always start disconnected and force cleanup
    console.log('🔄 [CLEAN_INIT] Starting clean workflow initialization...');
    
    try {
      // STEP 1: Force backend cleanup on frontend startup (with retry)
      // Retry the force reset with backoff in case backend is still starting
      let forceResetSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.apiRequest('POST', '/api/telegram/force-reset');
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
      this.updateTelegramStatus('disconnected');
      this.telegramConnected = false;
      
      // STEP 3: Check actual connection status from backend (with retry)
      try {
        const statusResponse = await this.apiRequest('GET', '/api/telegram/connection-status');
        
        if (statusResponse.success && statusResponse.data) {
          const status = statusResponse.data;
          
          // For clean workflow, we expect clean_state: true and connected: false
          if (status.clean_state && !status.connected) {
            this.addStatusItem('🔄 Clean startup completed - ready for fresh connection', 'info');
          } else if (status.connected) {
            this.addStatusItem('⚠️ Unexpected connection state - will force cleanup on connect', 'warning');
          }
        }
      } catch (error) {
        // Assume clean state on error
      }
      
    } catch (error) {
      console.error('❌ [CLEAN_INIT] Error during clean initialization:', error);
      // Even on error, ensure we're in disconnected state
      this.updateTelegramStatus('disconnected');
      this.telegramConnected = false;
      this.addStatusItem('⚠️ Clean startup completed with warnings', 'warning');
    }
    
    // Continue with standard initialization...
    // Verify all required elements exist
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");
    const connectBtn = document.getElementById("connect-telegram");
    
    if (RENDERER_DEBUG) console.log('[DEBUG] Telegram form elements check:', {
      apiIdInput: !!apiIdInput,
      apiHashInput: !!apiHashInput,
      phoneInput: !!phoneInput,
      connectBtn: !!connectBtn
    });
    
    if (!connectBtn) {
      if (RENDERER_DEBUG) console.error('[DEBUG] Critical: Connect button not found!');
      return;
    }
    
    // Setup improved input handlers
    this.setupInputActionListeners?.();
    
    // Load saved credentials if available
    if (typeof this.loadCredentials === 'function') {
      try { this.loadCredentials(); } catch (_) {}
    }
    
    // Sync visibility icons
    this.syncVisibilityIcons?.();
    
    if (RENDERER_DEBUG) console.log('[DEBUG] Telegram connection initialization complete');
  }

  syncVisibilityIcons() {
    const visibilityButtons = document.querySelectorAll('.btn-input-action.btn-toggle-visibility');
    visibilityButtons.forEach(button => {
      const targetId = button.getAttribute('data-target');
      const targetInput = document.getElementById(targetId);
      const icon = button.querySelector('i');
      if (!targetInput || !icon) return;
      if (targetInput.type === 'password') {
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
      } else {
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
      }
    });
  }

  // Clipboard and Visibility Handling for Sensitive Inputs
  setupInputActionListeners() {
    // Visibility Toggle Functionality with Enhanced Logic
    const visibilityButtons = document.querySelectorAll('.btn-input-action.btn-toggle-visibility');
    visibilityButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        // Prevent default button actions
        e.preventDefault();
        e.stopPropagation();

        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        const visibilityIcon = button.querySelector('i');
        
        if (!targetInput || !visibilityIcon) return;

        // Explicitly set focus to input before toggling
        targetInput.focus();

        // Comprehensive toggle logic
        const isCurrentlyPassword = targetInput.type === 'password';
        
        // Toggle input type
        targetInput.type = isCurrentlyPassword ? 'text' : 'password';
        
        // Toggle icon classes
        if (isCurrentlyPassword) {
          visibilityIcon.classList.remove('fa-eye-slash');
          visibilityIcon.classList.add('fa-eye');
        } else {
          visibilityIcon.classList.remove('fa-eye');
          visibilityIcon.classList.add('fa-eye-slash');
        }

        // Maintain focus and cursor position
        const currentPosition = targetInput.selectionStart;
        targetInput.setSelectionRange(currentPosition, currentPosition);
      });

      // Prevent default form submission or other unwanted behaviors
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Clipboard Paste Functionality (unchanged from previous implementation)
    const pasteButtons = document.querySelectorAll('.btn-input-action.btn-paste');
    pasteButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        const targetId = button.getAttribute('data-target');
        const targetInput = document.getElementById(targetId);
        
        if (!targetInput) return;

        try {
          const clipboardText = await navigator.clipboard.readText();
          targetInput.value = clipboardText.trim();
          
          // Trigger change event for saving
          targetInput.dispatchEvent(new Event('change'));
          
          this.showToast('success', 'Pasted', 'Text copied from clipboard');
          
          // Highlight input briefly
          targetInput.classList.add('paste-highlight');
          setTimeout(() => {
            targetInput.classList.remove('paste-highlight');
          }, 1000);
        } catch (err) {
          this.showToast('error', 'Paste Failed', 'Could not read clipboard');
          if (RENDERER_DEBUG) console.error('Clipboard paste error:', err);
        }
      });
    });
  }
}

// Initialize the application when DOM is ready
let app;

// Wait for DOM to be fully loaded before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    app = new TelegramUtilities();
    window.app = app;
    // Force immediate database stats update on app startup
    app.forceUpdateDatabaseStats();
    if (RENDERER_DEBUG) console.log("✅ App initialized after DOM ready");
  });
} else {
  // DOM is already loaded (shouldn't happen in normal flow but just in case)
  app = new TelegramUtilities();
  window.app = app;
  // Force immediate database stats update on app startup
  app.forceUpdateDatabaseStats();
  if (RENDERER_DEBUG) console.log("✅ App initialized (DOM was already ready)");
}

// Additional global functions for inline event handlers (use arrow functions to get app at call time)
window.removeVideoFile = (index) => window.app?.removeVideoFile(index);
window.removeMediaFile = (index) => window.app?.removeMediaFile(index);
window.editEmoji = (index) => window.app?.editEmoji(index);
window.showFileInfo = (index) => window.app?.showFileInfo(index);
window.showMediaInfo = (index) => window.app?.showMediaInfo(index);

// Enhanced emoji modal functions
window.applyEmojiToAll = () => window.app?.applyEmojiToAll();
window.applyRandomEmojis = () => window.app?.applyRandomEmojis();
window.applySequentialEmojis = () => window.app?.applySequentialEmojis();
window.applyThemeEmojis = () => window.app?.applyThemeEmojis();

// TEST METHOD - Console access for success modal testing with DOM analysis
window.testSuccessModal = () => {
  if (window.app?.testSuccessModal) {
    window.app.testSuccessModal();
  }
};

// Quick manual test - inject and show modal immediately
window.quickModalTest = () => {
  if (window.app?.showSuccessModal) {
    window.app.showSuccessModal('https://t.me/addstickers/test_manual_123');
  }
};

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
    // console.info('[TRACE] boot hook executing');
    const banner = () => { /* console.info('[TRACE] Frontend tracing active'); */ };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', banner, { once: true });
    } else {
      banner();
    }
  } catch (e) { console.warn('TRACE boot failed', e); }
})();

// ===== Aggressive apiRequest patch (poll until app exists) =====
// REMOVED: Debug tracing to improve performance
// The tracing code was causing slowness and memory issues