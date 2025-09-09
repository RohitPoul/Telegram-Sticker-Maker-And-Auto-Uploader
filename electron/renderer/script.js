// Debug controls for renderer logs/tests
const RENDERER_DEBUG = false;

// Debug logging disabled

class TelegramUtilities {
  constructor() {
    this.activeProcesses = new Map();
    this.videoFiles = [];
    this.mediaFiles = [];
    this.currentVideoOutput = "";
    this.telegramConnected = false;
    this.pendingCode = false;
    this.pendingPassword = false;
    this.currentProcessId = null;
    this.currentEmojiIndex = null;
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
    this.init();
    this.initializeNavigation(); // Add this line to initialize navigation
    this.initializeTelegramForm(); // Add this to load saved Telegram credentials
  }
  
  async init() {
    if (RENDERER_DEBUG) console.log("🚀 APP INIT STARTING...");
    this.setupEventListeners();
    this.setupTabSwitching();
    this.loadSettings();
    await this.detectAccelerationMode();
    this.startSystemStatsMonitoring();
    this.initializeTelegramConnection();
    
    // Update stats immediately on startup (only once)
    if (RENDERER_DEBUG) console.log("🔄 CALLING updateSystemInfo() IMMEDIATELY...");
    this.updateSystemInfo();
    
    if (RENDERER_DEBUG) console.log("🔄 CALLING updateDatabaseStats() IMMEDIATELY...");
    this.updateDatabaseStats();
    
    // Add manual refresh function for testing
    window.forceRefreshStats = () => {
      if (RENDERER_DEBUG) console.log("🔄 Force refreshing stats...");
      this.updateSystemInfo();
      this.updateDatabaseStats();
    };
    // Wire GPU utility buttons
    const checkBtn = document.getElementById('check-gpu');
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.innerHTML = '<i class="fas fa-sync fa-spin"></i> Checking...';
        try {
          await this.detectAccelerationMode();
          const resp = await this.apiRequest('GET', '/api/gpu-detect');
          
          // Show detailed GPU information
          if (resp && resp.success) {
            let message = '';
            
            // Show detected GPUs
            if (resp.gpus && resp.gpus.length > 0) {
              const gpu = resp.gpus[0];
              message += `<strong>GPU Detected:</strong> ${gpu.name}<br>`;
              message += `<strong>Type:</strong> ${gpu.type.toUpperCase()}<br>`;
              message += `<strong>Memory:</strong> ${gpu.memory_mb ? (gpu.memory_mb / 1024).toFixed(1) + ' GB' : 'Unknown'}<br>`;
              
              if (gpu.cuda_version) {
                message += `<strong>CUDA:</strong> ${gpu.cuda_version}<br>`;
              }
              
              // Show acceleration status
              const modeBadge = document.getElementById("mode-badge");
              if (modeBadge) {
                const currentMode = modeBadge.textContent;
                message += `<br><strong>Current Mode:</strong> ${currentMode}`;
              }
            } else {
              message = '<strong>No GPU detected</strong><br>Running in CPU mode';
            }
            
            // Show CUDA status for NVIDIA
            if (resp.cuda_info) {
              if (!resp.cuda_info.nvcc_available && resp.gpus && resp.gpus[0]?.type === 'nvidia') {
                message += '<br><br><em>CUDA toolkit not installed - GPU acceleration limited</em>';
              }
            }
            
            // Display results in a nice format
            this.showDetailedMessage('GPU Detection Results', message);
            
            // Update install button visibility
            const installBtn = document.getElementById('install-gpu-support');
            if (installBtn) {
              const best = resp?.gpus && resp.gpus[0];
              const needs = resp?.needs_cuda_install && best?.type === 'nvidia';
              installBtn.style.display = needs ? 'inline-flex' : 'none';
            }
          } else {
            this.showToast('error', 'GPU Check', 'Failed to detect GPU');
          }
        } catch (e) {
          this.showToast('error', 'GPU Check', 'Failed to detect GPU: ' + e.message);
        } finally {
          checkBtn.disabled = false;
          checkBtn.innerHTML = '<i class="fas fa-sync"></i> Check GPU';
        }
      });
    }

    const installBtn = document.getElementById('install-gpu-support');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
        try {
          const res = await this.apiRequest('POST', '/api/install-cuda');
          if (res.success) {
            this.showToast('success', 'CUDA Install', 'Installer launched. Restart app after installation.', 8000);
          } else {
            const url = 'https://developer.nvidia.com/cuda-downloads';
            this.showToast('error', 'CUDA Install', (res.error || 'Failed to start installer') + ` <a href="${url}" target="_blank">Download manually</a>`, 12000);
          }
        } catch (e) {
          this.showToast('error', 'CUDA Install', 'Failed to start installer');
        } finally {
          installBtn.disabled = false;
          installBtn.innerHTML = '<i class="fas fa-download"></i> Install GPU Support';
        }
      });
    }
    
    // Optional backend tests only in debug mode
    if (RENDERER_DEBUG) {
      // Wait a bit for backend to fully start
      await new Promise(resolve => setTimeout(resolve, 1000));
      const retryBackendTests = async (maxRetries = 2) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const health = await this.apiRequest("GET", "/api/health");
            if (health.success) {
              await this.apiRequest("GET", "/api/test");
              await this.apiRequest("GET", "/api/debug/simple");
              await this.apiRequest("POST", "/api/test-conversion");
              await this.apiRequest("GET", "/api/debug/video-converter");
              return true;
            }
          } catch (error) {
            // ignore in non-critical debug tests
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return false;
      };
      await retryBackendTests();
    }
    
    // Initialize button states
    this.updateButtonStates();
  }

  startSystemStatsMonitoring() {
    // Initial stats fetch
    this.updateSystemStats();
    
    // Update stats every 5 seconds (reduced frequency)
    setInterval(() => {
      this.updateSystemStats();
    }, 5000);
  }
  
  async detectAccelerationMode() {
    try {
      const modeBadge = document.getElementById("mode-badge");
      const modeDetails = document.getElementById("mode-details");
      
      // Show detecting status
      if (modeBadge) {
        modeBadge.textContent = "Detecting...";
        modeBadge.className = "mode-badge detecting";
      }
      
      // Detect available GPUs
      const response = await this.apiRequest("GET", "/api/gpu-detect");
      
      // Handle different response scenarios
      if (!response.success) {
        if (RENDERER_DEBUG) console.warn("GPU detection failed, falling back to CPU mode:", response.error);
        
        // Set CPU fallback mode
        if (modeBadge) {
          modeBadge.textContent = "CPU";
          modeBadge.className = "mode-badge cpu mode-badge-tooltip";
          modeBadge.innerHTML = `
            CPU
            <span class="tooltip-content">CPU Processing Mode</span>
          `;
        }
        
        if (modeDetails) {
          modeDetails.innerHTML = `
            <div class="acceleration-details">
              <div class="detail-icon cpu-icon"></div>
              <div class="detail-text">CPU Processing</div>
            </div>
          `;
        }
        
        // Store CPU mode
        this.accelerationMode = "cpu";
        this.selectedGPU = null;
        this.cudaAvailable = false;
        
        return false;
      }
      
      // Successful GPU detection
      if (response.gpus && response.gpus.length > 0) {
        const bestGPU = response.gpus[0];
        
        // Update mode badge
        if (modeBadge) {
          const cudaAvailable = response.cuda_info && response.cuda_info.available;
          const cudaToolkitInstalled = response.cuda_toolkit_installed;
          
          modeBadge.textContent = cudaAvailable ? "CUDA" : "GPU";
          modeBadge.className = `mode-badge gpu mode-badge-tooltip ${!cudaToolkitInstalled ? 'warning' : ''}`;
          modeBadge.innerHTML = `
            ${cudaAvailable ? 'CUDA' : 'GPU'}
            <span class="tooltip-content">
              ${bestGPU.name}
              ${!cudaToolkitInstalled ? '<br><strong>Toolkit Not Fully Installed</strong>' : ''}
            </span>
          `;
        }
        
        // Update mode details
        if (modeDetails) {
          let detailsHtml = `
            <div class="acceleration-details">
              <div class="detail-icon gpu-icon"></div>
              <div class="detail-text">${bestGPU.name}</div>
            </div>
          `;
          
          // Add CUDA toolkit warning if not fully installed
          if (!response.cuda_toolkit_installed) {
            detailsHtml += `
              <div class="cuda-warning">
                <strong>Note:</strong> CUDA toolkit not fully installed
                <button id="install-cuda-btn" class="btn btn-warning">Install CUDA</button>
              </div>
            `;
          }
          
          modeDetails.innerHTML = detailsHtml;
          
          // Add event listener for CUDA installation
          const installCudaBtn = document.getElementById('install-cuda-btn');
          if (installCudaBtn) {
            installCudaBtn.addEventListener('click', () => this.installCUDA());
          }
        }
        
        // Store GPU mode
        this.accelerationMode = response.cuda_info && response.cuda_info.available ? "cuda" : "gpu";
        this.selectedGPU = bestGPU;
        this.cudaAvailable = response.cuda_info && response.cuda_info.available;
        
        return true;
      }
      
      // No GPUs detected - CPU fallback
      if (RENDERER_DEBUG) console.info("No GPUs detected, using CPU fallback mode");
      
      if (modeBadge) {
        modeBadge.textContent = "CPU";
        modeBadge.className = "mode-badge cpu mode-badge-tooltip";
        modeBadge.innerHTML = `
          CPU
          <span class="tooltip-content">CPU Processing Mode</span>
        `;
      }
      
      if (modeDetails) {
        modeDetails.innerHTML = `
          <div class="acceleration-details">
            <div class="detail-icon cpu-icon"></div>
            <div class="detail-text">CPU Processing</div>
          </div>
        `;
      }
      
      // Store CPU mode
      this.accelerationMode = "cpu";
      this.selectedGPU = null;
      this.cudaAvailable = false;
      
      return false;
    } catch (error) {
      if (RENDERER_DEBUG) console.error("GPU detection error, falling back to CPU mode:", error);
      
      const modeBadge = document.getElementById("mode-badge");
      const modeDetails = document.getElementById("mode-details");
      
      // Set CPU fallback mode on error
      if (modeBadge) {
        modeBadge.textContent = "CPU";
        modeBadge.className = "mode-badge cpu mode-badge-tooltip";
        modeBadge.innerHTML = `
          CPU
          <span class="tooltip-content">CPU Processing Mode</span>
        `;
      }
      
      if (modeDetails) {
        modeDetails.innerHTML = `
          <div class="acceleration-details">
            <div class="detail-icon cpu-icon"></div>
            <div class="detail-text">CPU Processing</div>
          </div>
        `;
      }
      
      // Store CPU mode
      this.accelerationMode = "cpu";
      this.selectedGPU = null;
      this.cudaAvailable = false;
      
      return false;
    }
  }
  
  async showCudaInstallPrompt(gpu) {
    // Get CUDA installation info
    const installInfo = await this.apiRequest("GET", "/api/cuda-install-info");
    if (!installInfo.success) return;
    
    const info = installInfo.install_info;
    
    // Create a notification or modal
    const message = `
      <div style="text-align: left;">
        <h3>🚀 CUDA Not Detected</h3>
        <p>Your system has an NVIDIA GPU (${gpu.name}) but CUDA is not installed.</p>
        <p>Installing CUDA will enable <strong>5-10x faster</strong> video processing!</p>
        <br>
        <p><strong>To install CUDA:</strong></p>
        <p style="font-family: monospace; background: #1a1a1a; padding: 8px; border-radius: 4px;">
          ${info.command || 'Visit: ' + info.url}
        </p>
        <br>
        <p style="font-size: 0.9em; color: #888;">
          ${info.description}
        </p>
      </div>
    `;
    
    // Toast with action buttons
    this.showToast("info", "CUDA Installation Recommended", message +
      '<div style="margin-top:8px;display:flex;gap:8px;">\
        <button id="install-cuda-btn" class="btn btn-sm btn-success">Install CUDA</button>\
        <button id="dismiss-cuda-btn" class="btn btn-sm">Not now</button>\
      </div>', 20000);
    
    // Also add a permanent indicator in the UI
    const gpuInfo = document.getElementById("gpu-info");
    if (gpuInfo) {
      gpuInfo.innerHTML = `
        <a href="${info.url}" target="_blank" style="color: #ffa500; text-decoration: none;">
          ⚠️ Install CUDA for 5-10x faster processing →
        </a>
      `;
      gpuInfo.style.display = "block";
    }

    // Wire up action buttons
    setTimeout(() => {
      const installBtn = document.getElementById('install-cuda-btn');
      const dismissBtn = document.getElementById('dismiss-cuda-btn');
      if (installBtn) {
        installBtn.onclick = async () => {
          try {
            const res = await this.apiRequest('POST', '/api/install-cuda');
            if (res.success) {
              this.showToast('success', 'CUDA Install', 'Installer launched. Follow prompts, then restart the app.', 8000);
            } else {
              const hint = res.hint ? `<br><small>${res.hint}</small>` : '';
              this.showToast('error', 'CUDA Install', (res.error || 'Failed to launch installer') + hint, 10000);
            }
          } catch (e) {
            this.showToast('error', 'CUDA Install', 'Failed to start installer. Open the link and install manually.', 8000);
          }
        };
      }
      if (dismissBtn) {
        dismissBtn.onclick = () => {
          // Do nothing; user opted out
        };
      }
    }, 0);
  }

  async updateSystemStats() {
    try {
      const response = await this.apiRequest("GET", "/api/system-stats");
      // Normalize payload shape from main process { success, data: {...} }
      const payload = response?.data || response || {};
      const stats = payload.stats;
      if (response?.success && stats) {
        
        // Update CPU stats with color coding
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
        
        // Update RAM stats with better formatting
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
        
        // Check if we're in CPU mode or GPU mode
        const gpuStatsRow = document.getElementById("gpu-stats-row");
        const gpuLabel = document.getElementById("gpu-label");
        const vramLabel = document.getElementById("vram-label");
        const gpuName = document.getElementById("gpu-name");
        const gpuMemory = document.getElementById("gpu-memory");
        const gpuDetails = document.getElementById("gpu-details");
        
        // Update GPU/CPU stats based on acceleration mode
        if (this.accelerationMode === "cpu") {
          // Show CPU stats in the GPU row when in CPU mode
          if (gpuStatsRow) gpuStatsRow.style.display = "flex";
          
          // Update labels for CPU mode
          if (gpuLabel) gpuLabel.textContent = "Cores:";
          if (vramLabel) vramLabel.textContent = "Threads:";
          
          // Show CPU core information
          if (gpuName && stats.cpu) {
            gpuName.textContent = `${stats.cpu.count || 0} cores`;
            gpuName.style.color = '#44aaff';
          }
          
          if (gpuMemory && stats.cpu) {
            gpuMemory.textContent = `${stats.cpu.threads || 0} threads`;
            gpuMemory.style.color = '#44aaff';
          }
          
          // Show CPU frequency and details
          if (gpuDetails && stats.cpu) {
            const parts = [];
            
            // Add CPU frequency
            if (stats.cpu.frequency > 0) {
              const freqGHz = (stats.cpu.frequency / 1000).toFixed(2);
              parts.push(`${freqGHz} GHz`);
            }
            
            // Add CPU usage with color
            const percent = stats.cpu.percent;
            let usageStr = `${percent.toFixed(1)}% Usage`;
            if (percent > 80) {
              usageStr = `<span style="color: #ff4444">${usageStr}</span>`;
            } else if (percent > 50) {
              usageStr = `<span style="color: #ffaa00">${usageStr}</span>`;
            } else {
              usageStr = `<span style="color: #44ff44">${usageStr}</span>`;
            }
            parts.push(usageStr);
            
            // Add CPU mode indicator
            parts.push('<span style="color: #2196F3">CPU Processing</span>');
            
            gpuDetails.innerHTML = parts.join(' | ');
          }
          
        } else if (stats.gpus && stats.gpus.length > 0) {
          // GPU mode - show GPU stats
          const gpu = stats.gpus[0]; // Use first GPU for display
          
          if (gpuStatsRow) gpuStatsRow.style.display = "flex";
          
          // Reset labels for GPU mode
          if (gpuLabel) gpuLabel.textContent = "GPU:";
          if (vramLabel) vramLabel.textContent = "VRAM:";
          
          if (gpuName) {
            // Show GPU utilization as primary metric
            if (gpu.utilization !== undefined) {
              gpuName.textContent = `${gpu.utilization.toFixed(0)}%`;
              
              // Color code GPU usage
              if (gpu.utilization > 80) {
                gpuName.style.color = '#ff4444';
              } else if (gpu.utilization > 50) {
                gpuName.style.color = '#ffaa00';
              } else {
                gpuName.style.color = '#44ff44';
              }
            } else {
              gpuName.textContent = "0%";
              gpuName.style.color = '#44ff44';
            }
          }
          
          if (gpuMemory && gpu.memory_total > 0) {
            const usedGB = (gpu.memory_used / 1024).toFixed(1);
            const totalGB = (gpu.memory_total / 1024).toFixed(1);
            const memPercent = (gpu.memory_used / gpu.memory_total * 100);
            gpuMemory.textContent = `${usedGB}GB / ${totalGB}GB`;
            
            // Color code VRAM usage
            if (memPercent > 90) {
              gpuMemory.style.color = '#ff4444';
            } else if (memPercent > 70) {
              gpuMemory.style.color = '#ffaa00';
            } else {
              gpuMemory.style.color = '#44ff44';
            }
          }
          
          if (gpuDetails) {
            const parts = [];
            
            // Add temperature with color coding
            if (gpu.temperature > 0) {
              const temp = gpu.temperature;
              let tempStr = `${temp}°C`;
              if (temp > 80) {
                tempStr = `<span style="color: #ff4444">${tempStr}</span>`;
              } else if (temp > 70) {
                tempStr = `<span style="color: #ffaa00">${tempStr}</span>`;
              } else {
                tempStr = `<span style="color: #44ff44">${tempStr}</span>`;
              }
              parts.push(tempStr);
            }
            
            // Add power draw if available
            if (gpu.power_draw > 0) {
              parts.push(`${gpu.power_draw.toFixed(0)}W`);
            }
            
            // Add clocks if available
            if (gpu.core_clock > 0) {
              parts.push(`${gpu.core_clock}MHz`);
            }
            
            gpuDetails.innerHTML = parts.join(' | ');
          }
        } else {
          // No GPU detected - show CPU stats instead
          if (gpuStatsRow) gpuStatsRow.style.display = "flex";
          
          // Update labels for CPU mode
          if (gpuLabel) gpuLabel.textContent = "Cores:";
          if (vramLabel) vramLabel.textContent = "Threads:";
          
          // Show CPU core information
          if (gpuName && stats.cpu) {
            gpuName.textContent = `${stats.cpu.count || 0} cores`;
            gpuName.style.color = '#44aaff';
          }
          
          if (gpuMemory && stats.cpu) {
            gpuMemory.textContent = `${stats.cpu.threads || 0} threads`;
            gpuMemory.style.color = '#44aaff';
          }
          
          // Show CPU details
          if (gpuDetails && stats.cpu) {
            const parts = [];
            
            // Add CPU frequency
            if (stats.cpu.frequency > 0) {
              const freqGHz = (stats.cpu.frequency / 1000).toFixed(2);
              parts.push(`${freqGHz} GHz`);
            }
            
            // Add CPU mode indicator
            parts.push('<span style="color: #2196F3">CPU Processing Mode</span>');
            
            gpuDetails.innerHTML = parts.join(' | ');
          }
        }
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.debug("Failed to fetch system stats:", error);
    }
  }


  getSelectedGpuModeForBackend() {
    // Always return auto mode - let backend decide
    return "auto";
  }

  debugWarn(...args) {
    // Debug logging completely disabled
    return;
  }

  // ---- Lightweight debug logger for Telegram flows ----
  logDebug(label, payload = undefined) {
    try {
      const ts = new Date().toISOString();
      if (payload !== undefined) {
        if (RENDERER_DEBUG) console.debug(`[TG ${ts}] ${label}`, payload);
      } else {
        if (RENDERER_DEBUG) console.debug(`[TG ${ts}] ${label}`);
      }
    } catch (_) {
      // no-op
    }
  }

  // Wrap apiRequest with tracing
  async apiRequest(method, path, body = null) {
    const id = Math.random().toString(36).slice(2, 8);
    const url = `http://127.0.0.1:5000${path}`;
    const DEBUG = (typeof RENDERER_DEBUG !== 'undefined') ? RENDERER_DEBUG : false;
    console.log(`🌐 apiRequest#${id} → ${method} ${path}`);
    if (body) console.log(`📤 Request body:`, body);
    const started = performance.now();

    console.log(`⏳ Making fetch request to ${url}...`);
    const res = await fetch(url, {
        method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null
      });
    console.log(`📡 Fetch response received:`, res.status, res.statusText);

    console.log(`📖 Reading response text...`);
      const text = await res.text();
    console.log(`📄 Response text length:`, text.length);
      let json;
    try { 
      json = text ? JSON.parse(text) : {}; 
      console.log(`✅ JSON parsed successfully:`, json);
    } catch (e) { 
      console.log(`❌ JSON parse error:`, e);
      json = { raw: text }; 
    }

    if (DEBUG) console.log(`🌐 apiRequest#${id} ← ${res.status} ${method} ${path} (${Math.round(performance.now()-started)}ms)`);

      if (!res.ok) {
        const err = new Error(json?.error || `${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return json;
  }

  setupEventListeners() {
    // quiet
    
    // Video Converter Events
    const addVideosBtn = document.getElementById("add-videos");
    const clearVideosBtn = document.getElementById("clear-videos");
    const browseOutputBtn = document.getElementById("browse-video-output");
    const startConversionBtn = document.getElementById("start-conversion");
    
    const startHexEditBtn = document.getElementById("start-hex-edit");
    
    if (RENDERER_DEBUG) console.log("📋 Found buttons:", {
      addVideos: !!addVideosBtn,
      clearVideos: !!clearVideosBtn,
      browseOutput: !!browseOutputBtn,
      startConversion: !!startConversionBtn,
      startHexEdit: !!startHexEditBtn
    });
    
    if (addVideosBtn) {
      addVideosBtn.addEventListener("click", () => this.addVideoFiles());
    } else {
      if (RENDERER_DEBUG) console.warn("⚠️ add-videos button not found - will retry if needed");
    }
    
    // Setup emoji modal enhancements
    this.setupEmojiModal();
    
    if (clearVideosBtn) {
      clearVideosBtn.addEventListener("click", () => this.clearVideoFiles());
    } else {
      if (RENDERER_DEBUG) console.error("❌ clear-videos button not found!");
    }
    
    if (browseOutputBtn) {
      browseOutputBtn.addEventListener("click", () => this.browseVideoOutput());
    } else {
      if (RENDERER_DEBUG) console.error("❌ browse-video-output button not found!");
    }
    
    if (startConversionBtn) {
      console.log("✅ Start Conversion button found and event listener added");
      startConversionBtn.addEventListener("click", () => this.startVideoConversion());
    } else {
      console.error("❌ start-conversion button not found!");
    }
    
    if (startHexEditBtn) {
      console.log("✅ Start Hex Edit button found and event listener added");
      startHexEditBtn.addEventListener("click", () => this.startHexEdit());
    } else {
      console.error("❌ start-hex-edit button not found!");
    }
      
    // Add pause/resume event listeners
    const pauseBtn = document.getElementById("pause-conversion");
    const resumeBtn = document.getElementById("resume-conversion");
    
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => {
        if (RENDERER_DEBUG) console.log("⏸️ PAUSE BUTTON CLICKED!");
        this.pauseOperation();
      });
    }
    
    if (resumeBtn) {
      resumeBtn.addEventListener("click", () => {
        if (RENDERER_DEBUG) console.log("▶️ RESUME BUTTON CLICKED!");
        this.resumeOperation();
      });
    }
    
    // Add hex edit pause/resume event listeners
    const pauseHexBtn = document.getElementById("pause-hex-edit");
    const resumeHexBtn = document.getElementById("resume-hex-edit");
    
    if (pauseHexBtn) {
      pauseHexBtn.addEventListener("click", () => {
        if (RENDERER_DEBUG) console.log("⏸️ HEX PAUSE BUTTON CLICKED!");
        this.pauseOperation();
      });
    }
    
    if (resumeHexBtn) {
      resumeHexBtn.addEventListener("click", () => {
        if (RENDERER_DEBUG) console.log("▶️ HEX RESUME BUTTON CLICKED!");
        this.resumeOperation();
      });
    }
    
    // Sticker Bot Events
    document.getElementById("connect-telegram").addEventListener("click", () => this.connectTelegram());
    document.getElementById("clear-media").addEventListener("click", () => this.clearMedia());
    document.getElementById("create-sticker-pack").addEventListener("click", () => this.createStickerPack());
    
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
    
    // Toggle media view (horizontal/vertical)
    const toggleBtn = document.getElementById("toggle-media-view");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const mediaList = document.getElementById("sticker-media-list");
        const icon = toggleBtn.querySelector("i");
        
        if (mediaList) {
          mediaList.classList.toggle("vertical-scroll");
          
          if (mediaList.classList.contains("vertical-scroll")) {
            icon.className = "fas fa-grip-lines";
            toggleBtn.classList.add("active");
          } else {
            icon.className = "fas fa-grip-horizontal";
            toggleBtn.classList.remove("active");
          }
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
          if (RENDERER_DEBUG) console.error('Failed to read clipboard:', err);
          this.showToast('error', 'Clipboard Error', 'Failed to read from clipboard');
        }
      });
    });
    
    // Modal Events
    document.getElementById("submit-code").addEventListener("click", () => this.submitVerificationCode());
    document.getElementById("cancel-code").addEventListener("click", () => this.hideModal());
    document.getElementById("submit-password").addEventListener("click", () => this.submitPassword());
    document.getElementById("cancel-password").addEventListener("click", () => this.hideModal());
    document.getElementById("save-emoji").addEventListener("click", () => this.saveEmoji());
    document.getElementById("cancel-emoji").addEventListener("click", () => this.hideModal());
    
    // Settings Events
    document.getElementById("clear-data").addEventListener("click", () => this.clearApplicationData());
    document.getElementById("export-settings").addEventListener("click", () => this.exportSettings());
    document.getElementById("import-settings").addEventListener("click", () => this.importSettings());
    
    // New system management events
    document.getElementById("clear-logs").addEventListener("click", () => this.clearLogs());
    document.getElementById("clear-credentials").addEventListener("click", () => this.clearCredentials());
    document.getElementById("kill-python-processes").addEventListener("click", () => this.killPythonProcesses());
    
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
    
    // Modal overlay click to close
    document.getElementById("modal-overlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        this.hideModal();
      }
    });
    
    // Enter key handlers for modals
    document.getElementById("verification-code").addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.submitVerificationCode();
    });
    document.getElementById("two-factor-password").addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.submitPassword();
    });
    document.getElementById("emoji-input").addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.saveEmoji();
    });
    
    // Theme switching
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => this.toggleTheme());
    }
    
    // Drag and drop for video files
    this.setupDragAndDrop();
    
    // Advanced settings
    this.setupAdvancedSettings();
    
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
    if (RENDERER_DEBUG) console.log('Switching to tab:', tabId);
    const tabContents = document.querySelectorAll(".tab-content");
    if (RENDERER_DEBUG) console.log('All tab contents:', tabContents);
    
    tabContents.forEach((content) => {
      if (RENDERER_DEBUG) console.log('Removing active from:', content.id);
      content.classList.remove("active");
    });
    
    const targetTab = document.getElementById(tabId);
    if (RENDERER_DEBUG) console.log('Target tab:', targetTab);
    
    if (targetTab) {
      if (RENDERER_DEBUG) console.log('Adding active to:', tabId);
      targetTab.classList.add("active");
    } else {
      if (RENDERER_DEBUG) console.error('Tab not found:', tabId);
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
        // Specific actions for about tab
        break;
      default:
        if (RENDERER_DEBUG) console.warn('Unknown tab:', tabId);
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
    if (RENDERER_DEBUG) console.log("=== DRAG & DROP DEBUG ===");
    if (RENDERER_DEBUG) console.log("Raw dropped files:", files);
    
    const videoExtensions = ["mp4", "avi", "mov", "mkv", "flv", "webm"];
    let addedCount = 0;
    
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (RENDERER_DEBUG) console.log(`🗂️ Processing dropped file ${index + 1}:`, {
        name: file.name,
        size: file.size,
        type: file.type,
        path: file.path || "NO PATH",
        webkitRelativePath: file.webkitRelativePath
      });
      
      const extension = file.name.split(".").pop().toLowerCase();
      if (RENDERER_DEBUG) console.log(`📝 File extension: ${extension}`);
      
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
          if (RENDERER_DEBUG) console.log(`✅ Added dropped file: ${file.name} with metadata:`, metadata);
          
          // IMMEDIATE UI UPDATE - Update file count instantly
          const counter = document.getElementById("video-file-count");
          if (counter) {
            counter.textContent = this.videoFiles.length;
          }
        } else {
          if (RENDERER_DEBUG) console.log(`⚠️ Dropped file already exists: ${file.name}`);
        }
      } else {
        if (RENDERER_DEBUG) console.log(`❌ Invalid extension for: ${file.name}`);
      }
    }
    
    if (RENDERER_DEBUG) console.log(`📊 Dropped files added: ${addedCount}`);
    
    if (addedCount > 0) {
      this.updateVideoFileList();
      this.showToast("success", "Files Added", `Added ${addedCount} video files via drag & drop`);
    } else {
      this.showToast("warning", "No Valid Files", "Please drop video files only");
    }
    
    if (RENDERER_DEBUG) console.log("=== DRAG & DROP DEBUG END ===");
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
          this.mediaFiles.push({
            file_path: filePath,
            name: file.name,
            type: type,
            emoji: this.defaultEmoji,
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
    // Set up periodic status checks
            setInterval(() => {
              this.updateSystemInfo();
    }, 5000); // Update every 5 seconds
            
    // Update database stats every 2 seconds for immediate updates
            setInterval(() => {
              this.updateDatabaseStats();
    }, 2000); // Update every 2 seconds
    
    // Monitor memory usage
    this.monitorPerformance();
  }

  monitorPerformance() {
    const performanceMetrics = this.getPerformanceMetrics();
    this.updatePerformanceDisplay(performanceMetrics);
  }

  getPerformanceMetrics() {
    const metrics = {
      memory: null,
      timestamp: new Date().toISOString()
    };
    
    if ("performance" in window && "memory" in performance) {
      const memoryInfo = performance.memory;
      metrics.memory = {
        used: Math.round(memoryInfo.usedJSHeapSize / 1048576),
        total: Math.round(memoryInfo.totalJSHeapSize / 1048576),
        percentage: Math.round((memoryInfo.usedJSHeapSize / memoryInfo.totalJSHeapSize) * 100)
      };
    }
    
    return metrics;
  }

  updatePerformanceDisplay(metrics) {
    const memoryElement = document.getElementById("memory-usage");
    if (memoryElement && metrics.memory) {
      memoryElement.textContent = `${metrics.memory.used}MB / ${metrics.memory.total}MB (${metrics.memory.percentage}%)`;
    }
  }

  async checkBackendStatus() {
    try {
      const response = await this.apiRequest("GET", "/api/health");
      
      if (!response.success) {
        if (RENDERER_DEBUG) console.error("Backend health check failed:", {
          status: response.status,
          error: response.error,
          details: response.details || 'No additional details'
        });
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
      if (RENDERER_DEBUG) console.error("Backend status check failed:", {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
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
        case "connected":
          statusElement.classList.add("connected");
          if (connectionStatus) {
            connectionStatus.innerHTML = '<i class="fas fa-check-circle"></i> Connected';
          }
          const createBtn = document.getElementById("create-sticker-pack");
          if (createBtn) createBtn.disabled = false;
          // Update Connect button to Connected state
          const connectBtnOk = document.getElementById("connect-telegram");
          if (connectBtnOk) {
            connectBtnOk.disabled = true;
            connectBtnOk.innerHTML = '<i class="fas fa-plug"></i> Connected';
          }
          this.telegramConnected = true;
          break;
        case "connecting":
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
        default:
          statusElement.classList.add("disconnected");
          if (connectionStatus) {
            connectionStatus.innerHTML = '<i class="fas fa-times-circle"></i> Disconnected';
          }
          const createBtnDisco = document.getElementById("create-sticker-pack");
          if (createBtnDisco) createBtnDisco.disabled = true;
          const connectBtnIdle = document.getElementById("connect-telegram");
          if (connectBtnIdle) {
            connectBtnIdle.disabled = false;
            connectBtnIdle.innerHTML = '<i class="fas fa-plug"></i> Connect';
          }
          this.telegramConnected = false;
          break;
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
    if (savedTheme) {
      this.applyTheme(savedTheme);
    }
  }

  saveSettings() {
    // Save settings to localStorage
    const apiIdInput = document.getElementById("api-id");
    const apiHashInput = document.getElementById("api-hash");
    const phoneInput = document.getElementById("phone-number");
    
    if (apiIdInput) localStorage.setItem("telegram_api_id", apiIdInput.value);
    if (apiHashInput) localStorage.setItem("telegram_api_hash", apiHashInput.value);
    if (phoneInput) localStorage.setItem("telegram_phone", phoneInput.value);
    if (this.currentVideoOutput) {
      localStorage.setItem("video_output_dir", this.currentVideoOutput);
    }
  }

  // =============================================
  // VIDEO CONVERTER METHODS WITH PROPER PROGRESS TRACKING
  // =============================================
  async addVideoFiles() {
    if (RENDERER_DEBUG) console.log("=== ADD VIDEO FILES DEBUG ===");
    if (RENDERER_DEBUG) console.log("Current video files before adding:", this.videoFiles.length);
    
    try {
      // Check if electronAPI is available
      if (!window.electronAPI) {
        if (RENDERER_DEBUG) console.error("❌ window.electronAPI is not available");
        this.showToast("error", "System Error", "Electron API not available");
        return;
      }
      
      if (RENDERER_DEBUG) console.log("✅ Electron API is available");
      if (RENDERER_DEBUG) console.log("Container exists:", !!document.getElementById("video-file-list"));
      
      const files = await window.electronAPI.selectFiles({
        filters: [
          {
            name: "Video Files",
            extensions: ["mp4", "avi", "mov", "mkv", "flv", "webm"],
          },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      
      if (RENDERER_DEBUG) console.log("📁 Selected files:", files);
      
      if (!files || files.length === 0) {
        if (RENDERER_DEBUG) console.log("ℹ️ No files selected");
        return;
      }
      
      let addedCount = 0;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (RENDERER_DEBUG) console.log(`📄 Processing file ${index + 1}:`, {
          path: file,
          exists: file ? "checking..." : "NO PATH"
        });
        
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
          if (RENDERER_DEBUG) console.log(`✅ Added file: ${file.split(/[\\/]/).pop()} with metadata:`, metadata);
          
          // IMMEDIATE UI UPDATE - Update file count instantly
          const counter = document.getElementById("video-file-count");
          if (counter) {
            counter.textContent = this.videoFiles.length;
          }
        } else {
          if (RENDERER_DEBUG) console.log(`⚠️ File already exists: ${file.split(/[\\/]/).pop()}`);
        }
      }
      
      if (RENDERER_DEBUG) console.log(`📊 Total files added: ${addedCount}`);
      if (RENDERER_DEBUG) console.log(`📊 Total files in list: ${this.videoFiles.length}`);
      if (RENDERER_DEBUG) console.log("📊 Files array:", this.videoFiles);
      
      // Force immediate update
      this.updateVideoFileList();
      
      // Verify DOM update
      setTimeout(() => {
        const container = document.getElementById("video-file-list");
        if (container) {
          if (RENDERER_DEBUG) console.log("✅ Container children after update:", container.children.length);
          if (RENDERER_DEBUG) console.log("✅ Container HTML preview:", container.innerHTML.substring(0, 200));
        }
      }, 200);
      
      if (addedCount > 0) {
        this.showToast("success", "Files Added", `Added ${addedCount} video files`);
      } else {
        this.showToast("info", "No New Files", "All selected files were already in the list");
      }
      
      if (RENDERER_DEBUG) console.log("=== ADD VIDEO FILES DEBUG END ===");
      
    } catch (error) {
      if (RENDERER_DEBUG) console.error("❌ Error adding video files:", error);
      if (RENDERER_DEBUG) console.error("Stack trace:", error.stack);
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
    
    this.updateVideoFileList();
    this.showToast("info", "Cleared", `Removed ${count} video files`);
  }

  updateVideoFileList() {
    const container = document.getElementById("video-file-list");
    if (!container) {
      if (RENDERER_DEBUG) console.warn('🚨 UI DEBUG - Container Not Found', 'video-file-list container not found');
      // Try again after a short delay in case DOM is still loading
      setTimeout(() => {
        const retryContainer = document.getElementById("video-file-list");
        if (retryContainer && this.videoFiles.length > 0) {
          this.updateVideoFileList();
        }
      }, 100);
      return;
    }
    
    this.debugWarn('🔥 UI DEBUG - updateVideoFileList Called', {
      fileCount: this.videoFiles.length,
      currentOperation: this.currentOperation,
      files: this.videoFiles.map((file, index) => ({
        index: index,
        name: file.name,
        status: file.status,
        progress: file.progress,
        stage: file.stage,
        path: file.path
      }))
    });
    
    if (RENDERER_DEBUG) console.log("Updating video file list with", this.videoFiles.length, "files");
    this.videoFiles.forEach((file, index) => {
      if (RENDERER_DEBUG) console.log(`File ${index}: ${file.name} - status=${file.status}, progress=${file.progress}, stage=${file.stage}`);
    });
    
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
    
    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();
    
    this.videoFiles.forEach((file, index) => {
      const statusClass = file.status || "pending";
      const progressWidth = file.progress || 0;
      const statusIcon = this.getStatusIcon(file.status);
      
      this.debugWarn('🔥 UI DEBUG - Creating File Element', {
        index: index,
        filename: file.name,
        status: file.status,
        statusClass: statusClass,
        progress: file.progress,
        progressWidth: progressWidth,
        stage: file.stage,
        statusIcon: statusIcon
      });
      
      const fileElement = document.createElement('div');
      fileElement.className = `file-item ${statusClass}`;
      fileElement.setAttribute('data-index', index);
      
      const progressText = progressWidth === 100 ? '✔' : `${progressWidth}%`;
      const statusText = file.stage || "Ready to convert";
      
      this.debugWarn('🔥 UI DEBUG - Element Content Details', {
        index: index,
        progressText: progressText,
        statusText: statusText,
        progressBarWidth: `${progressWidth}%`
      });
      
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
          <button class="btn btn-sm btn-secondary" onclick="app.showFileInfo(${index})" title="File Info">
            <i class="fas fa-info"></i>
          </button>
          <button class="btn btn-sm btn-danger" onclick="app.removeVideoFile(${index})" 
                  ${file.status === "converting" ? "disabled" : ""} title="Remove File">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `;
      
      this.debugWarn('🔥 UI DEBUG - Element Created', {
        index: index,
        dataIndex: fileElement.getAttribute('data-index'),
        className: fileElement.className,
        hasProgressFill: fileElement.querySelector('.file-progress-fill') !== null,
        progressFillWidth: fileElement.querySelector('.file-progress-fill')?.style.width,
        hasProgressText: fileElement.querySelector('.file-progress-text') !== null,
        progressTextContent: fileElement.querySelector('.file-progress-text')?.textContent
      });
      
      fragment.appendChild(fileElement);
    });
    
    // Clear and append in one operation for better performance
    container.innerHTML = '';
    container.appendChild(fragment);
    
    this.debugWarn('🔥 UI DEBUG - DOM Updated', {
      containerChildCount: container.children.length,
      elementsWithDataIndex: Array.from(container.querySelectorAll('[data-index]')).map(el => ({
        dataIndex: el.getAttribute('data-index'),
        className: el.className,
        progressFillWidth: el.querySelector('.file-progress-fill')?.style.width,
        progressText: el.querySelector('.file-progress-text')?.textContent,
        statusText: el.querySelector('.file-status')?.textContent
      }))
    });
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

  showFileInfo(index) {
    const file = this.videoFiles[index];
    if (!file) return;
    
    const info = `
      <strong>File:</strong> ${file.name}<br>
      <strong>Path:</strong> ${file.path}<br>
      <strong>Status:</strong> ${file.status}<br>
      <strong>Progress:</strong> ${file.progress}%<br>
      <strong>Stage:</strong> ${file.stage}<br>
      ${file.size ? `<strong>Size:</strong> ${file.size}<br>` : ""}
      ${file.duration ? `<strong>Duration:</strong> ${file.duration}<br>` : ""}
    `;
    
    this.showInfoModal("File Information", info);
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
        if (RENDERER_DEBUG) console.error("Error stopping process:", error);
      }
    }
    
    this.showToast("info", "Removed", `Removed ${removed.name}`);
  }

  async browseVideoOutput() {
    try {
      if (RENDERER_DEBUG) console.log("[DEBUG] Starting directory selection...");
      
      // Check if Electron API is available
      if (!window.electronAPI || !window.electronAPI.selectDirectory) {
        throw new Error("Electron directory selection API not available");
      }
      
      const directory = await window.electronAPI.selectDirectory();
      if (RENDERER_DEBUG) console.log("[DEBUG] Directory selection result:", directory);
      
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
      if (RENDERER_DEBUG) console.error("[ERROR] Error selecting directory:", error);
      if (RENDERER_DEBUG) console.error("[ERROR] Error details:", {
        message: error.message,
        stack: error.stack,
        electronAPI: !!window.electronAPI,
        selectDirectory: !!(window.electronAPI && window.electronAPI.selectDirectory)
      });
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
          gpu_mode: "auto", // Always use automatic GPU detection
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

  // Unified progress monitoring system
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
          Object.entries(progress.file_statuses).forEach(([index, fileStatus]) => {
            const file = this.videoFiles[parseInt(index)];
            if (file) {
              const oldStatus = file.status;
              const oldProgress = file.progress;
              file.status = fileStatus.status;
              file.progress = fileStatus.progress || 0;
              file.stage = fileStatus.stage || 'Processing';
              
              // Only log if status changed or progress increased significantly
              if (oldStatus !== file.status || Math.abs(oldProgress - file.progress) > 5) {
                hasChanges = true;
              }
            }
          });
          
          if (hasChanges) {
            this.updateVideoFileList();
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
    console.log("🔧 START HEX EDIT BUTTON CLICKED!");
    if (this.currentOperation) {
      this.showToast("warning", "Operation in Progress", "Another operation is already running");
      return;
    }
    
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
    await this.updateDatabaseStats();
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
  async connectTelegram() {
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
    
    try {
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
          response = await this.apiRequest("POST", "/api/sticker/connect", {
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
            if (RENDERER_DEBUG) console.log(`[DEBUG] Database lock detected, retrying in ${(retryCount + 1) * 1000}ms...`);
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
          this.showToast('success', 'Connected', 'Successfully connected to Telegram');
          this.updateTelegramStatus("connected");
        }
      } else {
        if (RENDERER_DEBUG) console.error('[DEBUG] Connection failed - response not successful:', response);
        const errorMsg = (response && response.error) || 'Unknown error occurred';
        this.showToast('error', 'Connection Failed', errorMsg);
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error('[DEBUG] Connection error caught:', error);
      this.hideLoadingOverlay();
      
      let errorMsg = error.message || 'Failed to connect';
      if (errorMsg.includes('database is locked')) {
        errorMsg = 'Database is locked. Please try again in a moment.';
      } else if (errorMsg.includes('connect_telegram')) {
        errorMsg = 'Connection service unavailable. Please restart the application.';
      }
      
      this.showToast('error', 'Connection Error', errorMsg);
    } finally {
      if (RENDERER_DEBUG) console.log('[DEBUG] Resetting connection button');
      const connectBtn = document.getElementById("connect-telegram");
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.innerHTML = '<i class="fas fa-plug"></i> Connect to Telegram';
      }
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
      const submitBtn = document.getElementById("submit-code");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Verify Code';
      }
    }
  }

  async submitPassword() {
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
      
      if (!files || files.length === 0) {
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
          this.mediaFiles.push({
            file_path: file,
            name: file.split(/[\\/]/).pop(),
            type: "image",
            emoji: this.defaultEmoji,
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
      this.showToast(
        "error",
        "Error",
        "Failed to add image files: " + error.message
      );
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
      
      if (!files || files.length === 0) {
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
          this.mediaFiles.push({
            file_path: file,
            name: file.split(/[\\/]/).pop(),
            type: "video",
            emoji: this.defaultEmoji,
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
      this.showToast(
        "error",
        "Error",
        "Failed to add video files: " + error.message
      );
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
      uploading: "fas fa-upload",
      processing: "fas fa-cog fa-spin",
      completed: "fas fa-check text-success",
      error: "fas fa-exclamation-triangle text-danger",
    };
    return iconMap[status] || "fas fa-clock";
  }

  getStatusText(status) {
    const textMap = {
      pending: "Waiting",
      uploading: "Uploading",
      processing: "Processing",
      completed: "Completed",
      error: "Error",
    };
    return textMap[status] || status;
  }

  async showMediaInfo(index) {
    const file = this.mediaFiles[index];
    if (!file) return;
    
    // Get file metadata
    let fileSize = 'Unknown';
    let dimensions = 'Unknown';
    let duration = 'N/A';
    let dateModified = 'Unknown';
    
    try {
      const result = await this.apiRequest('POST', '/api/get-file-info', { 
        path: file.file_path 
      });
      
      if (result && result.success && result.data) {
        fileSize = this.formatFileSize(result.data.size || 0);
        if (result.data.width && result.data.height) {
          dimensions = `${result.data.width} × ${result.data.height}`;
        }
        if (result.data.duration) {
          duration = this.formatDuration(result.data.duration);
        }
        if (result.data.modified) {
          dateModified = new Date(result.data.modified).toLocaleDateString();
        }
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error('Failed to get file info:', error);
    }
    
    const info = `
      <div style="font-size: 0.9rem; line-height: 1.8;">
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">File Name:</strong> 
          <span style="color: #ccc;">${file.name}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Type:</strong> 
          <span style="color: #ccc;">${file.type.toUpperCase()}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Size:</strong> 
          <span style="color: #ccc;">${fileSize}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Dimensions:</strong> 
          <span style="color: #ccc;">${dimensions}</span>
        </div>
        ${file.type === 'video' ? `
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Duration:</strong> 
          <span style="color: #ccc;">${duration}</span>
        </div>` : ''}
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Date Modified:</strong> 
          <span style="color: #ccc;">${dateModified}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Emoji:</strong> 
          <span style="font-size: 1.5rem;">${file.emoji}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #667eea;">Status:</strong> 
          <span style="color: ${file.status === 'completed' ? '#4ade80' : '#ccc'};">${file.status || "Ready"}</span>
        </div>
        <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">
          <small style="color: #888;">File ${index + 1} of ${this.mediaFiles.length}</small>
        </div>
      </div>
    `;
    
    this.showInfoModal("Media File Metadata", info);
  }
  
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  removeMediaFile(index) {
    if (index < 0 || index >= this.mediaFiles.length) return;
    
    const file = this.mediaFiles[index];
    this.mediaFiles.splice(index, 1);
    this.updateMediaFileList();
    this.showToast("info", "File Removed", `Removed ${file.name}`);
  }

  editEmoji(index) {
    if (index < 0 || index >= this.mediaFiles.length) return;
    
    this.currentEmojiIndex = index;
    const currentEmoji = this.mediaFiles[index].emoji;
    const fileName = this.mediaFiles[index].name;
    const emojiInput = document.getElementById("emoji-input");
    const filenameDisplay = document.getElementById("emoji-filename");
    
    if (emojiInput) emojiInput.value = currentEmoji;
    if (filenameDisplay) filenameDisplay.textContent = fileName;
    
    this.showModal("emoji-modal");
    
    setTimeout(() => {
      if (emojiInput) {
        emojiInput.focus();
        emojiInput.select();
      }
    }, 100);
  }

  saveEmoji() {
    if (this.currentEmojiIndex === null || this.currentEmojiIndex < 0) return;
    
    const emojiInput = document.getElementById("emoji-input");
    if (!emojiInput) return;
    
    const newEmoji = emojiInput.value.trim();
    if (!newEmoji) {
      this.showToast("warning", "Empty Emoji", "Please enter an emoji");
      emojiInput.focus();
      return;
    }
    
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
    this.currentEmojiIndex = null;
  }

  async createStickerPack() {
    const packNameEl = document.getElementById("pack-name");
    const packName = (packNameEl && typeof packNameEl.value === 'string') ? packNameEl.value.trim() : "";
    const stickerTypeEl = document.querySelector('input[name="sticker-type"]:checked');
    const stickerType = stickerTypeEl ? stickerTypeEl.value : 'image';

    if (!packName) {
      this.showToast("error", "Invalid Input", "Please enter a pack name");
      return;
    }
    
    const incompatibleFiles = this.mediaFiles.filter((f) => {
      if (stickerType === "video" && f.type !== "video") return true;
      if (stickerType === "image" && f.type !== "image") return true;
      return false;
    });
    
    if (incompatibleFiles.length > 0) {
      const proceed = confirm(
        `${incompatibleFiles.length} files don't match the sticker type (${stickerType}). Continue with compatible files only?`
      );
      if (!proceed) return;
    }
    
    try {
      const processId = "sticker_" + Date.now();
      this.showLoadingOverlay("Starting sticker pack creation...");
      
      const response = await this.apiRequest("POST", "/api/sticker/create-pack", {
        pack_name: packName,
        sticker_type: stickerType,
        media_files: this.mediaFiles.filter((f) => {
          if (stickerType === "video") return f.type === "video";
          if (stickerType === "image") return f.type === "image";
          return true;
        }),
        process_id: processId,
      });
      
      this.hideLoadingOverlay();
      
      if (response.success) {
        this.showToast(
          "success",
          "Creation Queued",
          "Sticker pack creation started in background"
        );
        
        const createBtn = document.getElementById("create-sticker-pack");
        if (createBtn) {
          createBtn.disabled = true;
          createBtn.innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> Creating Pack...';
        }
        
        // Start monitoring progress
        this.startStickerProgressMonitoring(response.process_id || processId);
      } else {
        this.showToast(
          "error",
          "Creation Failed",
          response.error || "Failed to start creation"
        );
      }
    } catch (error) {
      this.hideLoadingOverlay();
      if (RENDERER_DEBUG) console.error("Error creating sticker pack:", error);
      this.showToast(
        "error",
        "Creation Error",
        "Failed to create sticker pack: " + error.message
      );
    }
  }

  startStickerProgressMonitoring(processId) {
    if (this.stickerProgressInterval) {
      clearInterval(this.stickerProgressInterval);
    }
    
    this.stickerProgressInterval = setInterval(async () => {
      try {
        const response = await this.apiRequest("GET", `/api/conversion-progress/${processId}`);
        
        if (response.success) {
          const progress = response.data.progress;
          this.updateStickerProgressDisplay(progress);
          
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
          
          if (progress.status === "completed") {
            clearInterval(this.stickerProgressInterval);
            this.onStickerProcessCompleted(true, progress);
          } else if (progress.status === "error") {
            clearInterval(this.stickerProgressInterval);
            this.onStickerProcessCompleted(false, progress);
          }
        } else {
          if (RENDERER_DEBUG) console.error("Sticker progress monitoring failed:", response.error);
          clearInterval(this.stickerProgressInterval);
          this.onStickerProcessCompleted(false, { error: response.error });
        }
      } catch (error) {
        if (RENDERER_DEBUG) console.error("Error monitoring sticker progress:", error);
        clearInterval(this.stickerProgressInterval);
        this.onStickerProcessCompleted(false, { error: error.message });
      }
    }, 2000);
  }

  updateStickerProgressDisplay(progress) {
    const statusElement = document.getElementById("sticker-status");
    const progressBar = document.getElementById("sticker-progress-bar");
    const progressText = document.getElementById("sticker-progress-text");
    
    if (statusElement && progress.current_stage) {
      statusElement.textContent = progress.current_stage;
    }
    
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
    
    // Update stats
    if (success) {
      this.sessionStats.totalStickers += this.mediaFiles.length;
    }
    this.updateStats();
    
    // Reset button
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '<i class="fas fa-rocket"></i> Create Sticker Pack';
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
      
      // Show pack link if available
      if (progressData.pack_link) {
        this.showPackLinkModal(progressData.pack_link);
      }
    } else {
      this.showToast(
        "error",
        "Creation Failed",
        `Sticker pack creation failed: ${progressData.error || "Unknown error"}`
      );
    }
    
    // Clear progress
    const statusElement = document.getElementById("sticker-status");
    if (statusElement) {
      statusElement.textContent = success
        ? "Pack created successfully!"
        : "Pack creation failed";
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

  // =============================================
  // UTILITY METHODS
  // =============================================
  showModal(modalId) {
    const overlay = document.getElementById("modal-overlay");
    const modal = document.getElementById(modalId);
    
    if (overlay && modal) {
      overlay.classList.add("active");
      modal.style.display = "block";
      
      // Focus first input if available
      const firstInput = modal.querySelector("input, textarea, select");
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 100);
      }
    }
  }

  hideModal() {
    const overlay = document.getElementById("modal-overlay");
    if (overlay) {
      overlay.classList.remove("active");
    }
    
    const modals = document.querySelectorAll(".modal");
    modals.forEach((modal) => {
      modal.style.display = "none";
    });
    
    // Clear modal inputs
    this.clearModalInputs();
  }

  clearModalInputs() {
    const inputs = ["verification-code", "two-factor-password", "emoji-input"];
    inputs.forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    this.currentEmojiIndex = null;
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

  showToast(type, title, message) {
    const toastContainer = document.getElementById("toast-container");
    if (!toastContainer) return;
    
    const toastId = "toast-" + Date.now();
    const iconMap = {
      success: "fas fa-check-circle",
      error: "fas fa-times-circle",
      warning: "fas fa-exclamation-triangle",
      info: "fas fa-info-circle",
    };
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.id = toastId;
    
    toast.innerHTML = `
      <div class="toast-icon">
        <i class="${iconMap[type]}"></i>
      </div>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" onclick="document.getElementById('${toastId}').remove()">
        <i class="fas fa-times"></i>
      </button>
    `;
    
    toastContainer.appendChild(toast);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      const toastElement = document.getElementById(toastId);
      if (toastElement) {
        toastElement.style.animation = "slideOutRight 0.3s ease forwards";
        setTimeout(() => toastElement.remove(), 300);
      }
    }, 5000);
    
    // Add click to dismiss
    toast.addEventListener("click", () => {
      toast.style.animation = "slideOutRight 0.3s ease forwards";
      setTimeout(() => toast.remove(), 300);
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
      z-index: 10000;
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
    if (!document.getElementById('gpu-modal-animations')) {
      const style = document.createElement('style');
      style.id = 'gpu-modal-animations';
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
      if (RENDERER_DEBUG) console.log("🔄 updateSystemInfo() CALLED - Starting...");
      if (RENDERER_DEBUG) console.log("🌐 Making API request to /api/health...");
      const health = await this.apiRequest("GET", "/api/health");
      if (RENDERER_DEBUG) console.log("📊 Backend status response:", health);
      if (RENDERER_DEBUG) console.log("📊 Response success:", health?.success);
      if (RENDERER_DEBUG) console.log("📊 Response data:", health?.data);
      
      if (RENDERER_DEBUG) console.log("📊 FULL Health Response:", JSON.stringify(health, null, 2));
      if (RENDERER_DEBUG) console.log("📊 Response data:", health?.data);
      if (RENDERER_DEBUG) console.log("📊 Health Success:", health?.success);
      if (RENDERER_DEBUG) console.log("📊 Health Status:", health?.status);
      
      // Update Backend Status - just show Connected/Disconnected
      if (RENDERER_DEBUG) console.log("🔍 Looking for backend status elements...");
      const backendStatusEl = document.getElementById("backend-status-text");
      const backendStatusContainer = document.getElementById("backend-status");
      if (RENDERER_DEBUG) console.log("🔍 backendStatusEl found:", !!backendStatusEl);
      if (RENDERER_DEBUG) console.log("🔍 backendStatusContainer found:", !!backendStatusContainer);
      
      // More robust backend status detection
      const isBackendHealthy = health && 
        (health.success === true || 
         (health.status && health.status.toLowerCase().includes('connected')));
      
      if (RENDERER_DEBUG) console.log("📊 Backend Health Check:", {
        success: health?.success,
        status: health?.status,
        isHealthy: isBackendHealthy
      });
      
      if (backendStatusEl && backendStatusContainer) {
        if (isBackendHealthy) {
          if (RENDERER_DEBUG) console.log("✅ Health check successful - setting Connected");
          backendStatusEl.textContent = "Connected";
          backendStatusContainer.className = "status-item connected";
          if (RENDERER_DEBUG) console.log("✅ Backend status updated: Connected");
          
          // Also update the settings page backend status
          const settingsBackendStatus = document.getElementById("backend-status-text");
          if (settingsBackendStatus) {
            settingsBackendStatus.textContent = "Connected";
            if (RENDERER_DEBUG) console.log("✅ Settings backend status updated: Connected");
          } else {
            if (RENDERER_DEBUG) console.log("❌ settingsBackendStatus not found");
          }
        } else {
          if (RENDERER_DEBUG) console.log("❌ Health check failed - setting Disconnected");
          backendStatusEl.textContent = "Disconnected";
          backendStatusContainer.className = "status-item disconnected";
          if (RENDERER_DEBUG) console.log("❌ Backend status failed:", health);
          
          // Also update the settings page backend status
          const settingsBackendStatus = document.getElementById("backend-status-text");
          if (settingsBackendStatus) {
            settingsBackendStatus.textContent = "Disconnected";
            if (RENDERER_DEBUG) console.log("✅ Settings backend status updated: Disconnected");
          } else {
            if (RENDERER_DEBUG) console.log("❌ settingsBackendStatus not found");
          }
        }
      } else {
        if (RENDERER_DEBUG) console.log("❌ Backend status elements not found!");
      }

      // Update FFmpeg Status - get real status from API
      const ffmpegStatusEl = document.getElementById("ffmpeg-status");
      if (ffmpegStatusEl && health?.data?.ffmpeg_available !== undefined) {
        const ffmpegAvailable = health.data.ffmpeg_available;
        ffmpegStatusEl.textContent = ffmpegAvailable ? "Available" : "Not Available";
        ffmpegStatusEl.style.color = ffmpegAvailable ? "#28a745" : "#dc3545";
        if (RENDERER_DEBUG) console.log(`✅ FFmpeg status set to: ${ffmpegAvailable ? 'Available' : 'Not Available'}`);
      } else if (ffmpegStatusEl) {
        ffmpegStatusEl.textContent = "Unknown";
        ffmpegStatusEl.style.color = "#6c757d";
        if (RENDERER_DEBUG) console.log("⚠️ FFmpeg status unknown - no data from API");
      }
    } catch (error) {
      if (RENDERER_DEBUG) console.error("❌ updateSystemInfo failed:", error);
      
      // If backend is not available, show disconnected state
      const backendStatusEl = document.getElementById("backend-status-text");
      const backendStatusContainer = document.getElementById("backend-status");
      if (backendStatusEl && backendStatusContainer) {
        backendStatusEl.textContent = "Disconnected";
        backendStatusContainer.className = "status-item disconnected";
        if (RENDERER_DEBUG) console.log("❌ Backend status set to: Disconnected (API call failed)");
      }
      
      const ffmpegStatusEl = document.getElementById("ffmpeg-status");
      if (ffmpegStatusEl) {
        ffmpegStatusEl.textContent = "Unknown";
        ffmpegStatusEl.style.color = "#6c757d";
        if (RENDERER_DEBUG) console.log("❌ FFmpeg status set to: Unknown (API call failed)");
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
      console.log('📊 Loaded stats.json:', JSON.stringify(s));

      const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val ?? 0); };

      setText('total-conversions', s.total_conversions);
      setText('successful-conversions', s.successful_conversions);
      setText('failed-conversions', s.failed_conversions);
      setText('total-hexedits', s.total_hexedits);
      setText('successful-hexedits', s.successful_hexedits);
      setText('failed-hexedits', s.failed_hexedits);
      setText('total-stickers', s.total_stickers_created);

      const ses = document.getElementById('session-start') || document.getElementById('session-started');
      if (ses && s.session_started) ses.textContent = new Date(s.session_started * 1000).toLocaleString();

      console.log('📊 Database stats updated from file via preload');
    } catch (e) {
      console.error('❌ updateDatabaseStats (preload) failed:', e);
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
    
    // Single delegated event for all emoji buttons - much better performance
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
    
    // Live emoji preview with debouncing
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
        z-index: 10000;
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
          url = 'https://buymeacoffee.com/'; // Replace with your actual link
          break;
        case 'paypal':
          url = 'https://paypal.me/'; // Replace with your actual link
          break;
        case 'github':
          url = 'https://github.com/RohitPoul'; // Your GitHub profile
          break;
        case 'star':
          url = 'https://github.com/RohitPoul?tab=repositories'; // Your repositories
          break;
      }
      
      if (url) {
        window.open(url, '_blank');
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

  // Modify initialization to include input handlers
  initializeTelegramConnection() {
    this.logDebug('initializeTelegramConnection()');
    
    // Check for existing connection status
    this.updateTelegramStatus("disconnected");
    
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
    if (RENDERER_DEBUG) console.log("✅ App initialized after DOM ready");
  });
} else {
  // DOM is already loaded (shouldn't happen in normal flow but just in case)
  app = new TelegramUtilities();
  window.app = app;
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

// Handle page visibility changes
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && window.app) {
    // Refresh status when page becomes visible
    window.app.updateSystemInfo();
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

// Global click handler for debugging
document.addEventListener("click", (event) => {
  if (RENDERER_DEBUG) console.log("🖱️ Global click detected:", {
    target: event.target,
    id: event.target.id,
    className: event.target.className,
    tagName: event.target.tagName
  });
});

if (RENDERER_DEBUG) console.log("Telegram Utilities application loaded successfully!");
if (RENDERER_DEBUG) console.log("Telegram Utilities application loaded successfully!");