// =============================================
// STICKER BOT MANAGER MODULE
// Handles Telegram sticker pack creation functionality
// =============================================

class StickerBotManager {
  constructor() {
    this.mediaFiles = [];
    this.selectedMediaType = null; // 'image' or 'video'
    this.defaultEmoji = "❤️";
    this.telegramConnected = false;
    
    // Connection state flags
    this.isSubmittingCode = false;
    this.isSubmittingPassword = false;
    this.isConnecting = false;
    this.pendingCode = false;
    this.pendingPassword = false;
    
    // Pack creation state
    this.currentStickerProcessId = null;
    this.stickerProgressInterval = null;
    
    this.loadSettings();
  }

  // =============================================
  // SETTINGS MANAGEMENT
  // =============================================
  
  loadSettings() {
    const savedApiId = localStorage.getItem("telegram_api_id");
    const savedApiHash = localStorage.getItem("telegram_api_hash");
    const savedPhone = localStorage.getItem("telegram_phone");
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
    if (savedAutoSkipIcon !== null) {
      const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");
      if (autoSkipIconCheckbox) {
        autoSkipIconCheckbox.checked = savedAutoSkipIcon === "true";
      }
    }
  }

  saveSettings() {
    const apiIdInput = document.getElementById("telegram-api-id");
    const apiHashInput = document.getElementById("telegram-api-hash");
    const phoneInput = document.getElementById("telegram-phone");
    const autoSkipIconCheckbox = document.getElementById("auto-skip-icon");
    
    if (apiIdInput) localStorage.setItem("telegram_api_id", apiIdInput.value);
    if (apiHashInput) localStorage.setItem("telegram_api_hash", apiHashInput.value);
    if (phoneInput) localStorage.setItem("telegram_phone", phoneInput.value);
    if (autoSkipIconCheckbox) {
      localStorage.setItem("auto_skip_icon", autoSkipIconCheckbox.checked.toString());
    }
  }

  // =============================================
  // MEDIA FILE MANAGEMENT
  // =============================================
  
  selectMediaType(type) {
    this.selectedMediaType = type;
    
    // Update UI
    const imageBtn = document.getElementById("select-image-type");
    const videoBtn = document.getElementById("select-video-type");
    const mediaControls = document.getElementById("media-controls");
    const mediaTypeText = document.getElementById("media-type-text");
    
    if (imageBtn && videoBtn) {
      imageBtn.classList.toggle("active", type === "image");
      videoBtn.classList.toggle("active", type === "video");
    }
    
    if (mediaControls) {
      mediaControls.style.display = "flex";
    }
    
    if (mediaTypeText) {
      mediaTypeText.textContent = type === "image" ? "Images" : "Videos";
    }
    
    // Clear existing media when switching types
    if (this.mediaFiles.length > 0) {
      const confirmed = confirm(`You have ${this.mediaFiles.length} files selected. Switching to ${type} will clear them. Continue?`);
      if (confirmed) {
        this.clearMediaFiles();
      } else {
        return;
      }
    }
    
    this.selectedMediaType = type;
    this.updatePackActions();
    
    window.uiManager?.showToast("success", "Media Type Selected", `Selected ${type} stickers`);
  }

  async addMediaFiles() {
    if (!this.selectedMediaType) {
      window.uiManager?.showToast("warning", "No Media Type", "Please select image or video type first");
      return;
    }
    
    if (this.mediaFiles.length >= 120) {
      window.uiManager?.showToast("warning", "Limit Reached", "Maximum 120 files allowed per pack");
      return;
    }
    
    try {
      const extensions = this.selectedMediaType === "image" 
        ? ["png", "jpg", "jpeg", "webp"]
        : ["webm"];
      
      if (!window.electronAPI) {
        window.uiManager?.showToast("error", "System Error", "Electron API not available");
        return;
      }
      
      const result = await window.electronAPI.showOpenDialog({
        title: `Select ${this.selectedMediaType === "image" ? "Image" : "Video"} Files`,
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: `${this.selectedMediaType === "image" ? "Image" : "Video"} Files`,
            extensions: extensions,
          },
        ],
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return;
      }
      
      let addedCount = 0;
      const maxFiles = 120 - this.mediaFiles.length;
      
      for (const filePath of result.filePaths.slice(0, maxFiles)) {
        if (!this.mediaFiles.some(f => f.file_path === filePath)) {
          this.mediaFiles.push({
            file_path: filePath,
            name: filePath.split(/[\\/]/).pop(),
            type: this.selectedMediaType,
            emoji: this.defaultEmoji,
            dateAdded: Date.now(),
          });
          addedCount++;
        }
      }
      
      if (addedCount > 0) {
        this.updateMediaFileList();
        this.updatePackActions();
        
        let message = `Added ${addedCount} ${this.selectedMediaType} file${addedCount !== 1 ? "s" : ""}`;
        if (result.filePaths.length > maxFiles) {
          message += ` (${result.filePaths.length - maxFiles} files skipped due to 120 file limit)`;
        }
        
        window.uiManager?.showToast("success", "Files Added", message);
      } else {
        window.uiManager?.showToast("info", "No New Files", "All selected files were already added");
      }
      
    } catch (error) {
      console.error("Error adding media files:", error);
      window.uiManager?.showToast("error", "Error", "Failed to add media files: " + error.message);
    }
  }

  clearMediaFiles() {
    if (this.mediaFiles.length === 0) {
      window.uiManager?.showToast("info", "No Files", "No media files to clear");
      return;
    }
    
    const count = this.mediaFiles.length;
    this.mediaFiles = [];
    
    this.updateMediaFileList();
    this.updatePackActions();
    
    window.uiManager?.showToast("success", "Files Cleared", `Removed ${count} media files`);
  }

  updateMediaFileList() {
    const container = document.getElementById("sticker-media-list");
    const counter = document.getElementById("media-counter");
    
    if (!container) return;
    
    // Update counter
    if (counter) {
      counter.textContent = `${this.mediaFiles.length} files`;
    }
    
    if (this.mediaFiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-file-image"></i>
          <p>No media files selected</p>
          <small>Add ${this.selectedMediaType || "images or videos"} for your sticker pack (max 120 files)</small>
        </div>
      `;
      return;
    }
    
    container.innerHTML = this.mediaFiles
      .map((file, index) => this.createMediaFileItem(file, index))
      .join("");
  }

  createMediaFileItem(file, index) {
    const typeIcon = file.type === "image" ? "fas fa-image" : "fas fa-video";
    const fileName = file.name;
    
    return `
      <div class="media-file-item" data-index="${index}">
        <div class="media-preview">
          <i class="${typeIcon}"></i>
        </div>
        <div class="media-info">
          <div class="media-name" title="${file.file_path}">${fileName}</div>
          <div class="media-details">
            <span class="media-type">${file.type}</span>
          </div>
          <div class="media-emoji">
            <label>Emoji:</label>
            <input type="text" class="emoji-input" value="${file.emoji}" 
                   onchange="app.stickerBot.updateFileEmoji(${index}, this.value)" 
                   maxlength="2" placeholder="❤️">
          </div>
        </div>
        <div class="media-actions">
          <button class="btn btn-sm btn-danger" onclick="app.stickerBot.removeMediaFile(${index})" title="Remove file">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
    `;
  }

  // =============================================
  // VALIDATION AND PACK ACTIONS
  // =============================================
  
  validatePackName() {
    const input = document.getElementById("pack-name");
    if (!input) return false;
    
    const packName = input.value.trim();
    const isValid = packName.length > 0 && packName.length <= 64 && !/[<>"'&]/.test(packName);
    
    input.classList.toggle("valid", isValid && packName.length > 0);
    input.classList.toggle("invalid", !isValid && packName.length > 0);
    
    this.updatePackActions();
    return isValid;
  }

  validateUrlName() {
    const input = document.getElementById("pack-url-name");
    if (!input) return false;
    
    const urlName = input.value.trim();
    const isValid = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(urlName);
    
    input.classList.toggle("valid", isValid);
    input.classList.toggle("invalid", !isValid && urlName.length > 0);
    
    this.updatePackActions();
    return isValid;
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
    
    const canCreate = isPackNameValid && isUrlNameValid && hasMedia && isConnected;
    createBtn.disabled = !canCreate;
  }

  // =============================================
  // TELEGRAM CONNECTION
  // =============================================
  
  async connectTelegram() {
    if (this.isConnecting) return;
    
    this.isConnecting = true;
    
    try {
      const apiIdInput = document.getElementById("telegram-api-id");
      const apiHashInput = document.getElementById("telegram-api-hash");
      const phoneInput = document.getElementById("telegram-phone");
      
      const apiId = apiIdInput?.value.trim();
      const apiHash = apiHashInput?.value.trim();
      const phoneNumber = phoneInput?.value.trim();
      
      if (!apiId || !apiHash || !phoneNumber) {
        window.uiManager?.showToast('error', 'Invalid Input', 'Please fill in all Telegram credentials');
        return;
      }
      
      this.saveSettings();
      window.uiManager?.updateTelegramStatus("connecting");
      
      const response = await window.coreSystem.apiRequest("POST", "/api/sticker/connect", {
        api_id: apiId,
        api_hash: apiHash,
        phone_number: phoneNumber,
        process_id: "connect_" + Date.now(),
      });
      
      if (response.success) {
        const result = response.data || response;
        
        if (result.needs_code) {
          this.pendingCode = true;
          window.uiManager?.showModal("code-modal");
          window.uiManager?.showToast("info", "Code Sent", "Verification code sent to your phone number");
        } else if (result.needs_password) {
          this.pendingPassword = true;
          window.uiManager?.showModal("password-modal");
          window.uiManager?.showToast("info", "2FA Required", "Please enter your 2FA password");
        } else {
          this.telegramConnected = true;
          window.uiManager?.updateTelegramStatus("connected");
          this.updatePackActions();
          window.uiManager?.showToast('success', 'Connected', 'Successfully connected to Telegram');
        }
      } else {
        throw new Error(response.error || "Failed to connect to Telegram");
      }
      
    } catch (error) {
      console.error("Connection error:", error);
      window.uiManager?.updateTelegramStatus("disconnected");
      window.uiManager?.showToast('error', 'Connection Error', error.message || 'Failed to connect');
    } finally {
      this.isConnecting = false;
    }
  }

  async disconnectTelegram() {
    try {
      const response = await window.coreSystem.apiRequest("POST", "/api/telegram/cleanup-session");
      
      this.telegramConnected = false;
      window.uiManager?.updateTelegramStatus("disconnected");
      this.updatePackActions();
      
      window.uiManager?.showToast('success', 'Disconnected', 'Successfully disconnected from Telegram');
      
    } catch (error) {
      console.error('Disconnect error:', error);
      this.telegramConnected = false;
      window.uiManager?.updateTelegramStatus("disconnected");
      this.updatePackActions();
      window.uiManager?.showToast('warning', 'Disconnect Warning', 'Session cleanup may have failed');
    }
  }

  // =============================================
  // STICKER PACK CREATION
  // =============================================
  
  async createStickerPack() {
    if (!this.telegramConnected || this.mediaFiles.length === 0) {
      window.uiManager?.showToast("warning", "Cannot Create", "Connect to Telegram and add media files first");
      return;
    }
    
    const packName = document.getElementById("pack-name")?.value.trim();
    const urlName = document.getElementById("pack-url-name")?.value.trim();
    
    if (!packName || !urlName) {
      window.uiManager?.showToast("error", "Invalid Form", "Please fill in pack name and URL name");
      return;
    }
    
    try {
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Pack...';
      }
      
      const response = await window.coreSystem.apiRequest("POST", "/api/sticker/create-pack", {
        pack_name: packName,
        pack_url_name: urlName,
        media_files: this.mediaFiles,
        sticker_type: this.selectedMediaType,
        auto_skip_icon: document.getElementById("auto-skip-icon")?.checked || false,
        process_id: "create_pack_" + Date.now(),
      });
      
      if (response.success) {
        this.currentStickerProcessId = response.data.process_id;
        this.startStickerProgressMonitoring();
        window.uiManager?.showToast("success", "Pack Creation Started", "Sticker pack creation has begun");
      } else {
        throw new Error(response.error || "Failed to start pack creation");
      }
      
    } catch (error) {
      console.error("Pack creation error:", error);
      
      const createBtn = document.getElementById("create-sticker-pack");
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
      }
      
      window.uiManager?.showToast("error", "Creation Error", "Failed to create sticker pack: " + error.message);
    }
  }

  startStickerProgressMonitoring() {
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
    }
    
    this.stickerProgressInterval = setInterval(async () => {
      if (!this.currentStickerProcessId) {
        clearInterval(this.stickerProgressInterval);
        return;
      }
      
      try {
        const response = await window.coreSystem.apiRequest("GET", `/api/sticker/progress/${this.currentStickerProcessId}`);
        
        if (response.success && response.data) {
          const { status, progress, completed_files, total_files, error, shareable_link } = response.data;
          
          // Update progress display
          const progressBar = document.getElementById("sticker-progress-bar");
          const progressText = document.getElementById("sticker-progress-text");
          
          if (progressBar) {
            progressBar.style.width = `${progress || 0}%`;
          }
          
          if (progressText) {
            progressText.textContent = `${completed_files || 0}/${total_files || this.mediaFiles.length} files processed`;
          }
          
          // Handle completion
          if (status === 'completed' && shareable_link) {
            this.handleStickerPackComplete(shareable_link);
          } else if (status === 'error') {
            this.handleStickerPackError(error);
          }
        }
      } catch (error) {
        console.error("Error updating sticker progress:", error);
      }
    }, 2000);
  }

  handleStickerPackComplete(shareableLink) {
    clearInterval(this.stickerProgressInterval);
    this.currentStickerProcessId = null;
    
    const createBtn = document.getElementById("create-sticker-pack");
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
    }
    
    window.uiManager?.showSuccessModal(shareableLink);
    window.uiManager?.showToast("success", "Pack Created", "Sticker pack created successfully!");
  }

  handleStickerPackError(error) {
    clearInterval(this.stickerProgressInterval);
    this.currentStickerProcessId = null;
    
    const createBtn = document.getElementById("create-sticker-pack");
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '<i class="fas fa-magic"></i> Create Sticker Pack';
    }
    
    window.uiManager?.showToast("error", "Creation Failed", error || "An error occurred during pack creation");
  }

  // =============================================
  // UTILITY METHODS
  // =============================================
  
  updateFileEmoji(index, emoji) {
    if (index >= 0 && index < this.mediaFiles.length) {
      this.mediaFiles[index].emoji = emoji || this.defaultEmoji;
    }
  }

  removeMediaFile(index) {
    if (index >= 0 && index < this.mediaFiles.length) {
      const fileName = this.mediaFiles[index].name;
      this.mediaFiles.splice(index, 1);
      this.updateMediaFileList();
      this.updatePackActions();
      window.uiManager?.showToast("info", "File Removed", `Removed ${fileName}`);
    }
  }

  handleDroppedMediaFiles(files) {
    if (!this.selectedMediaType) {
      window.uiManager?.showToast("warning", "No Media Type", "Please select image or video type first");
      return;
    }
    
    const imageExtensions = ["png", "jpg", "jpeg", "webp"];
    const videoExtensions = ["webm"];
    const validExtensions = this.selectedMediaType === "image" ? imageExtensions : videoExtensions;
    
    let addedCount = 0;
    const maxFiles = 120 - this.mediaFiles.length;
    
    files.slice(0, maxFiles).forEach((file) => {
      const extension = file.name.split(".").pop().toLowerCase();
      
      if (validExtensions.includes(extension)) {
        const filePath = file.path || file.webkitRelativePath || file.name;
        
        if (!this.mediaFiles.some((f) => f.file_path === filePath)) {
          this.mediaFiles.push({
            file_path: filePath,
            name: file.name,
            type: this.selectedMediaType,
            emoji: this.defaultEmoji,
            dateAdded: Date.now(),
            size: file.size,
          });
          addedCount++;
        }
      }
    });
    
    if (addedCount > 0) {
      this.updateMediaFileList();
      this.updatePackActions();
      window.uiManager?.showToast("success", "Files Added", `Added ${addedCount} files via drag & drop`);
    } else {
      window.uiManager?.showToast("warning", "No Valid Files", 
        `Please drop ${this.selectedMediaType} files only`);
    }
  }

  // =============================================
  // URL RETRY MODAL METHODS
  // =============================================
  
  showUrlNameModal(processId, takenName, currentAttempt = 1, maxAttempts = 3) {
    console.log(`🔧 [FRONTEND] showUrlNameModal called with:`, { processId, takenName, currentAttempt, maxAttempts });
    
    const modal = document.getElementById("url-name-modal");
    const overlay = document.getElementById("modal-overlay");
    const takenNameSpan = document.getElementById("taken-url-name");
    const newUrlNameInput = document.getElementById("new-url-name");
    const attemptCounter = document.getElementById("attempt-counter");
    const suggestionsContainer = document.getElementById("url-suggestions");

    if (!modal || !overlay) {
      console.error("🔧 [FRONTEND] URL name modal elements not found!");
      return;
    }

    // Store current state
    this.currentUrlNameProcessId = processId;
    this.currentUrlAttempt = currentAttempt;
    this.maxUrlAttempts = maxAttempts;

    // Update modal content
    if (takenNameSpan) takenNameSpan.textContent = takenName;
    if (attemptCounter) attemptCounter.textContent = `Attempt ${currentAttempt} of ${maxAttempts}`;
    
    // Generate suggestions based on taken name
    if (suggestionsContainer) {
      this.generateSuggestions(takenName, suggestionsContainer);
    }
    
    // Set up input with suggested name
    if (newUrlNameInput) {
      const suggestedName = this.generateSuggestedName(takenName);
      newUrlNameInput.value = suggestedName;
      
      // Simple validation without complex DOM manipulation
      const validateInput = () => {
        const value = newUrlNameInput.value.trim();
        const validation = this.validateUrlName(value);
        const container = newUrlNameInput.closest('.url-input-container');
        
        // Only apply styling if elements exist
        if (container) {
          if (value.length === 0) {
            container.style.borderColor = 'var(--border-color)';
          } else if (validation.valid) {
            container.style.borderColor = 'var(--success-color)';
          } else {
            container.style.borderColor = 'var(--error-color)';
          }
        }
      };
      
      // Remove any existing event listeners
      newUrlNameInput.removeEventListener('input', validateInput);
      newUrlNameInput.addEventListener('input', validateInput);
      
      // Add Enter key support
      newUrlNameInput.removeEventListener('keypress', this.handleUrlRetryKeypress);
      this.handleUrlRetryKeypress = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.submitNewUrlName();
        }
      };
      newUrlNameInput.addEventListener('keypress', this.handleUrlRetryKeypress);
      
      // Initial validation
      validateInput();
      
      // Focus and select for easy editing
      setTimeout(() => {
        newUrlNameInput.focus();
        newUrlNameInput.select();
      }, 100);
    }

    // Show modal
    modal.style.display = "flex";
    overlay.classList.add("active");

    console.log(`🔧 [FRONTEND] URL name modal displayed for process ${processId}`);
  }

  generateSuggestedName(takenName) {
    const baseName = takenName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 15);
    const timestamp = Date.now().toString().slice(-6);
    return `${baseName}_${timestamp}`;
  }

  generateSuggestions(takenName, container) {
    const baseName = takenName.replace(/_\d+$/, ''); // Remove trailing numbers
    const cleanBase = baseName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 15);
    const timestamp = Date.now().toString().slice(-6);
    const year = new Date().getFullYear();
    
    const suggestions = [
      `${cleanBase}_${timestamp}`,
      `${cleanBase}_${year}`,
      `${cleanBase}_pack`,
      `${cleanBase}_stickers`,
      `my_${cleanBase}_pack`
    ].filter(s => s.length >= 5 && s.length <= 32);
    
    container.innerHTML = suggestions.map(suggestion => 
      `<button class="suggestion-btn" onclick="window.app?.stickerBot?.applySuggestion('${suggestion}')">${suggestion}</button>`
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

  hideUrlNameModal() {
    const modal = document.getElementById("url-name-modal");
    const overlay = document.getElementById("modal-overlay");
    
    if (modal) {
      modal.style.display = "none";
    }
    if (overlay) {
      overlay.classList.remove("active");
    }
    
    // Clear retry information
    this.currentUrlNameProcessId = null;
    this.currentUrlAttempt = null;
    this.maxUrlAttempts = null;
  }

  async submitNewUrlName() {
    const newUrlNameInput = document.getElementById("new-url-name");
    if (!newUrlNameInput || !this.currentUrlNameProcessId) return;
    
    const newUrlName = newUrlNameInput.value.trim();
    if (!newUrlName) {
      window.uiManager?.showToast("error", "Missing URL Name", "Please enter a new URL name");
      newUrlNameInput.focus();
      return;
    }
    
    // Validate the new URL name
    const validation = this.validateUrlName(newUrlName);
    if (!validation.valid) {
      window.uiManager?.showToast("error", "Invalid URL Name", validation.error);
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
      
      // Hide modal immediately for better UX
      this.hideUrlNameModal();
      
      const response = await window.coreSystem.apiRequest("POST", "/api/sticker/submit-url-name", {
        process_id: this.currentUrlNameProcessId,
        new_url_name: newUrlName,
        attempt: this.currentUrlAttempt
      });
      
      if (response.success) {
        window.uiManager?.showToast("success", "URL Submitted", "New URL name submitted successfully");
        // Progress monitoring will continue and show results
      } else {
        // Check if we need to show retry modal again
        if (response.error && response.error.includes("taken") && this.currentUrlAttempt < this.maxUrlAttempts) {
          // Show retry modal again with incremented attempt
          setTimeout(() => {
            this.showUrlNameModal(this.currentUrlNameProcessId, newUrlName, this.currentUrlAttempt + 1, this.maxUrlAttempts);
          }, 500);
          return; // Don't re-enable the button, show new modal
        } else if (this.currentUrlAttempt >= this.maxUrlAttempts) {
          // Exhausted all retries - mark as completed with manual instruction
          window.uiManager?.showToast("warning", "Manual Setup Required", `Please complete the sticker pack creation manually in the Telegram bot (@Stickers)`); 
          
          // Mark process as completed (user needs to complete manually)
          this.handleStickerPackError("Please complete sticker pack creation manually in Telegram bot");
          return;
        }
        
        window.uiManager?.showToast("error", "Submission Failed", response.error);
        
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
          submitBtn.innerHTML = '<i class="fas fa-check"></i> Try This Name';
        }
      }
    } catch (error) {
      console.error("Error submitting new URL name:", error);
      window.uiManager?.showToast("error", "Submission Error", error.message);
      
      const submitBtn = document.getElementById("submit-new-url");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Try This Name';
      }
    }
  }
}

// Make StickerBotManager available globally
window.StickerBotManager = StickerBotManager;