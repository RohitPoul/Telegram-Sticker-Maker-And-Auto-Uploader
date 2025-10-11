/**
 * Image Handler Module
 * Handles image conversion for Telegram stickers
 */

class ImageHandler {
  constructor(app) {
    this.app = app;
    this.imageFiles = []; // Each item: {path, name, thumbnail, metadata, converted, convertedMetadata, status, selected}
    this.selectedFormat = 'png';
    this.quality = 95;
    this.outputDir = '';
    this.currentProcessId = null;
    this.selectedImageIndex = null;
    this.previewMode = 'original'; // 'original' or 'converted'
    
    this.init();
  }
  
  // Ensure UI and state are reset when images are cleared/removed
  resetConversionUI() {
    this.currentProcessId = null;
    this.previewMode = 'original';

    const statusEl = document.getElementById('image-conversion-status');
    if (statusEl) {
      const statusText = statusEl.querySelector('.status-text');
      const progressText = statusEl.querySelector('.progress-text');
      if (statusText) statusText.textContent = 'Ready';
      if (progressText) progressText.textContent = '';
    }

    const convertBtn = document.getElementById('start-image-conversion');
    if (convertBtn) {
      const canConvert = this.imageFiles.some(img => img.selected) && this.outputDir;
      convertBtn.disabled = !canConvert;
      convertBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
    }

    this.updateImageDetails(null);
  }

  init() {
    this.setupEventListeners();
    this.checkImageMagick();
    
    // Initialize button states
    const convertBtn = document.getElementById('start-image-conversion');
    if (convertBtn) {
      convertBtn.disabled = true; // Disabled until images selected and output dir set
    }
  }
  
  setupEventListeners() {
    // Add images button
    const addImagesBtn = document.getElementById('add-images');
    if (addImagesBtn) {
      addImagesBtn.addEventListener('click', () => this.selectImages());
    }
    
    // Clear images button
    const clearImagesBtn = document.getElementById('clear-images');
    if (clearImagesBtn) {
      clearImagesBtn.addEventListener('click', () => this.clearImages());
    }
    
    // Format selector (works with all styles)
    const formatBtns = document.querySelectorAll('.format-btn, .format-btn-compact, .format-toggle-btn');
    formatBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        formatBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedFormat = btn.dataset.format;
      });
    });
    
    // Quality slider
    const qualitySlider = document.getElementById('image-quality');
    const qualityValue = document.getElementById('image-quality-value');
    if (qualitySlider && qualityValue) {
      qualitySlider.addEventListener('input', (e) => {
        this.quality = parseInt(e.target.value);
        qualityValue.textContent = this.quality;
      });
    }
    
    // Output directory browser
    const browseOutputBtn = document.getElementById('browse-image-output');
    if (browseOutputBtn) {
      browseOutputBtn.addEventListener('click', () => this.selectOutputDirectory());
    }
    
    // Start conversion button
    const startConversionBtn = document.getElementById('start-image-conversion');
    if (startConversionBtn) {
      startConversionBtn.addEventListener('click', () => {
        this.startConversion();
      });
    } else {
      console.error('[INIT] Convert button NOT FOUND!');
    }
    
    // Select all button
    const selectAllBtn = document.getElementById('select-all-images');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => this.selectAllImages());
    }
    
    // Deselect all button  
    const deselectAllBtn = document.getElementById('deselect-all-images');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', () => this.deselectAllImages());
    }
    
  }
  
  async checkImageMagick() {
    try {
      const response = await this.app.apiRequest('GET', '/api/image/check-imagemagick');
      if (response && response.success) {
        if (!response.available) {
          this.app.showToast('warning', 'ImageMagick Not Found', 
            'ImageMagick is required for image conversion. Please install it to use this feature.');
        }
      }
    } catch (error) {
      console.error('Error checking ImageMagick:', error);
    }
  }
  
  async selectImages() {
    try {
      const filePaths = await window.electronAPI.selectFiles({
        title: 'Select Images',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'tif'] }
        ]
      });
      
      // The IPC handler returns an array directly (or empty array if canceled)
      if (filePaths && Array.isArray(filePaths) && filePaths.length > 0) {
        // Add new images to the list
        for (const filePath of filePaths) {
          if (!this.imageFiles.some(img => img.path === filePath)) {
            this.imageFiles.push({
              path: filePath,
              name: filePath.split('/').pop().split('\\').pop(),
              thumbnail: null,
              metadata: null
            });
          }
        }
        
        await this.updateImageList();
        this.app.showToast('success', 'Images Added', `Added ${filePaths.length} image(s)`);
      }
    } catch (error) {
      console.error('Error selecting images:', error);
      this.app.showToast('error', 'Error', 'Failed to select images');
    }
  }
  
  clearImages() {
    if (this.imageFiles.length === 0) return;
    
    if (confirm(`Clear all ${this.imageFiles.length} image(s)?`)) {
      // Clean up data URLs and object references
      this.imageFiles.forEach(img => {
        if (img.thumbnail && img.thumbnail.startsWith('blob:')) {
          URL.revokeObjectURL(img.thumbnail);
        }
        if (img.converted && img.converted.startsWith('blob:')) {
          URL.revokeObjectURL(img.converted);
        }
        // Clear references
        img.thumbnail = null;
        img.converted = null;
        img.metadata = null;
        img.convertedMetadata = null;
      });
      
      this.imageFiles = [];
      this.selectedImageIndex = null;
      this.previewMode = 'original';
      this.updateImageList();
      this.updateImageDetails(null);
      this.app.showToast('info', 'Images Cleared', 'All images have been removed');
      this.resetConversionUI();
      
      // Force garbage collection hint
      if (window.gc) window.gc();
    }
  }
  
  async updateImageList() {
    const fileList = document.getElementById('image-file-list');
    const fileCount = document.getElementById('image-file-count');
    
    if (!fileList) return;
    
    if (this.imageFiles.length === 0) {
      fileList.innerHTML = `
        <div class="empty-state-mini">
          <i class="fas fa-image"></i>
          <p>No images</p>
        </div>
      `;
      if (fileCount) fileCount.textContent = '0';
      return;
    }
    
    if (fileCount) fileCount.textContent = this.imageFiles.length;
    
    // Store scroll position
    const scrollPos = fileList.scrollTop;
    
    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    fileList.classList.remove('image-preview-grid');
    fileList.classList.add('image-list-compact');
    
    for (let i = 0; i < this.imageFiles.length; i++) {
      const img = this.imageFiles[i];
      const imgItem = document.createElement('div');
      imgItem.className = 'image-list-item';
      imgItem.dataset.index = i;
      
      // Add status class
      if (img.status) {
        imgItem.classList.add(`status-${img.status}`);
      }
      
      // Create thumbnail if not exists
      if (!img.thumbnail) {
        img.thumbnail = `file://${img.path}`;
      }
      
      // Get file sizes
      const originalSize = img.metadata ? img.metadata.file_size_kb : '?';
      const convertedSize = img.convertedMetadata ? img.convertedMetadata.file_size_kb : null;
      const sizeStatus = img.metadata && img.metadata.file_size_kb > 512 ? 'size-over-limit' : 'size-ok';
      const convertedSizeStatus = convertedSize && convertedSize <= 512 ? 'size-ok' : (convertedSize ? 'size-over-limit' : '');
      
      imgItem.innerHTML = `
        <div class="image-list-checkbox">
          <input type="checkbox" id="img-check-${i}" ${img.selected ? 'checked' : ''}>
          <label for="img-check-${i}"></label>
        </div>
        <div class="image-list-thumbnails">
          <div class="image-list-thumb">
            <img src="${img.thumbnail}" alt="${img.name}" loading="lazy">
            <div class="image-list-thumb-label">Original</div>
          </div>
          <div class="image-list-thumb ${!img.converted ? 'placeholder' : ''}">
            ${img.converted ? `<img src="${img.converted}" alt="Converted" loading="lazy">` : ''}
            <div class="image-list-thumb-label">Converted</div>
          </div>
        </div>
        <div class="image-list-info">
          <div class="image-list-name" title="${img.name}">${img.name}</div>
          <div class="image-list-stats">
            <div class="image-list-stat ${sizeStatus}">
              <i class="fas fa-file-image image-list-stat-icon"></i>
              <span>${originalSize}KB</span>
            </div>
            ${convertedSize ? `
              <div class="image-list-stat ${convertedSizeStatus}">
                <i class="fas fa-arrow-right image-list-stat-icon"></i>
                <span>${convertedSize}KB</span>
              </div>
            ` : `
              <div class="image-list-stat" style="opacity: 0.5;">
                <i class="fas fa-arrow-right image-list-stat-icon"></i>
                <span>Not converted</span>
              </div>
            `}
          </div>
        </div>
        <button class="image-list-remove" data-index="${i}" title="Remove">
          <i class="fas fa-times"></i>
        </button>
      `;
      
      // Add checkbox handler
      const checkbox = imgItem.querySelector(`#img-check-${i}`);
      if (checkbox) {
        checkbox.addEventListener('change', (e) => {
          e.stopPropagation();
          img.selected = checkbox.checked;
          this.updateSelectionCount();
        });
      }
      
      // Add click handler to show preview (not the checkbox area)
      imgItem.addEventListener('click', (e) => {
        if (!e.target.closest('.image-list-remove') && !e.target.closest('.image-list-checkbox')) {
          this.selectImage(i);
        }
      });
      
      // Add remove button handler
      const removeBtn = imgItem.querySelector('.image-list-remove');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeImage(i);
      });
      
      fragment.appendChild(imgItem);
      
      // Load metadata if not loaded
      if (!img.metadata) {
        this.loadImageMetadata(i);
      }
    }
    
    // Clear and append all at once for better performance
    fileList.innerHTML = '';
    fileList.appendChild(fragment);
    
    // Restore scroll position
    fileList.scrollTop = scrollPos;
  }
  
  async loadImageMetadata(index) {
    const img = this.imageFiles[index];
    if (!img) return;
    
    try {
      const response = await this.app.apiRequest('POST', '/api/image/metadata', {
        image_path: img.path
      });
      
      if (response && response.success && response.metadata) {
        img.metadata = response.metadata;
        
        // Update the metadata display in the card
        const metaEl = document.getElementById(`image-meta-${index}`);
        if (metaEl) {
          const meta = response.metadata;
          metaEl.innerHTML = `${meta.width}x${meta.height} • ${meta.file_size_kb}KB`;
          
          // Add transparency indicator
          if (meta.has_transparency) {
            metaEl.innerHTML += ' • <i class="fas fa-check-circle" title="Has transparency"></i>';
          }
        }
      }
    } catch (error) {
      console.error('Error loading metadata:', error);
      const metaEl = document.getElementById(`image-meta-${index}`);
      if (metaEl) {
        metaEl.textContent = 'Error loading info';
      }
    }
  }
  
  removeImage(index) {
    // Clean up resources before removing
    const img = this.imageFiles[index];
    if (img) {
      if (img.thumbnail && img.thumbnail.startsWith('blob:')) {
        URL.revokeObjectURL(img.thumbnail);
      }
      if (img.converted && img.converted.startsWith('blob:')) {
        URL.revokeObjectURL(img.converted);
      }
    }
    
    this.imageFiles.splice(index, 1);
    if (this.selectedImageIndex === index) {
      this.selectedImageIndex = null;
      this.previewMode = 'original';
      this.updateImageDetails(null);
    } else if (this.selectedImageIndex > index) {
      this.selectedImageIndex--;
    }
    this.updateImageList();
    this.updateSelectionCount();
    if (this.imageFiles.length === 0) {
      this.resetConversionUI();
    }
  }
  
  selectImage(index) {
    this.selectedImageIndex = index;
    const img = this.imageFiles[index];
    
    // Highlight selected image
    document.querySelectorAll('.image-list-item').forEach((item, i) => {
      item.classList.toggle('selected', i === index);
    });
    
    // Reset preview mode to original when selecting new image
    this.previewMode = 'original';
    this.updateImageDetails(img);
  }
  
  updateImageDetails(img) {
    const detailsContainer = document.getElementById('image-details-container');
    if (!detailsContainer) return;
    
    if (!img || !img.metadata) {
      detailsContainer.innerHTML = `
        <div class="empty-state-mini">
          <i class="fas fa-mouse-pointer"></i>
          <p>Select image</p>
        </div>
      `;
      return;
    }
    
    const meta = img.metadata;
    const hasConverted = img.converted && img.convertedMetadata;
    
    // Determine which image to show based on preview mode
    let previewSrc, previewMeta;
    if (this.previewMode === 'converted' && hasConverted) {
      previewSrc = img.converted;
      previewMeta = img.convertedMetadata;
    } else {
      previewSrc = `file://${img.path}`;
      previewMeta = meta;
    }
    
    detailsContainer.innerHTML = `
      <div class="image-details-content">
        <div class="preview-controls">
          <button class="preview-mode-btn ${this.previewMode === 'original' ? 'active' : ''}" data-mode="original">
            <i class="fas fa-image"></i> Original
          </button>
          <button class="preview-mode-btn ${this.previewMode === 'converted' ? 'active' : ''}" data-mode="converted" ${!hasConverted ? 'disabled' : ''}>
            <i class="fas fa-check-circle"></i> Converted
          </button>
        </div>
        <div class="image-details-preview">
          <img src="${previewSrc}" alt="${img.name}">
          ${!hasConverted && this.previewMode === 'converted' ? '<div class="preview-message">Not converted yet</div>' : ''}
        </div>
        <div class="preview-info">
          <div class="preview-info-item">
            <span class="label">Size:</span>
            <span class="value">${previewMeta.width}×${previewMeta.height}px</span>
          </div>
          <div class="preview-info-item">
            <span class="label">File:</span>
            <span class="value ${previewMeta.file_size_kb > 512 ? 'text-error' : 'text-success'}">${previewMeta.file_size_kb}KB</span>
          </div>
          <div class="preview-info-item">
            <span class="label">Input:</span>
            <span class="value">${meta.format ? meta.format.toUpperCase() : 'Unknown'}</span>
          </div>
          <div class="preview-info-item">
            <span class="label">Output:</span>
            <span class="value">${this.selectedFormat ? this.selectedFormat.toUpperCase() : 'PNG'}</span>
          </div>
        </div>
      </div>
    `;
    
    // Add event listeners for preview mode buttons
    detailsContainer.querySelectorAll('.preview-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = btn.dataset.mode;
        if (mode && !btn.disabled) {
          this.previewMode = mode;
          this.updateImageDetails(img);
        }
      });
    });
  }
  
  async selectOutputDirectory() {
    try {
      const directory = await window.electronAPI.selectDirectory({
        title: 'Select Output Directory'
      });
      
      // The IPC handler returns a string directly (or undefined if canceled)
      if (directory) {
        this.outputDir = directory;
        const outputDirInput = document.getElementById('image-output-dir');
        if (outputDirInput) {
          outputDirInput.value = this.outputDir;
        }
        
        // Update convert button state
        this.updateSelectionCount();
        this.app.showToast('success', 'Output Directory Set', 'Ready to convert images');
      }
    } catch (error) {
      console.error('Error selecting directory:', error);
      this.app.showToast('error', 'Error', 'Failed to select directory');
    }
  }
  
  selectAllImages() {
    this.imageFiles.forEach(img => img.selected = true);
    this.updateImageList();
    this.updateSelectionCount();
  }
  
  deselectAllImages() {
    this.imageFiles.forEach(img => img.selected = false);
    this.updateImageList();
    this.updateSelectionCount();
  }
  
  updateSelectionCount() {
    const selectedCount = this.imageFiles.filter(img => img.selected).length;
    const countEl = document.getElementById('selected-image-count');
    if (countEl) {
      countEl.textContent = selectedCount;
    }
    
    // Enable/disable convert button based on selection and output dir
    const convertBtn = document.getElementById('start-image-conversion');
    if (convertBtn) {
      const canConvert = selectedCount > 0 && this.outputDir;
      convertBtn.disabled = !canConvert;
      
      // Update button text/tooltip to guide user
      if (!this.outputDir) {
        convertBtn.title = '⚠️ Please select output directory first';
        convertBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Select Output Directory First';
      } else if (selectedCount === 0) {
        convertBtn.title = '⚠️ Please select at least one image';
        convertBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Select Images First';
      } else {
        convertBtn.title = `Convert ${selectedCount} selected image(s)`;
        convertBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
      }
    }
  }
  
  async startConversion() {
    const selectedImages = this.imageFiles.filter(img => img.selected);
    
    console.log('[CONVERT] Starting conversion...', {
      selectedCount: selectedImages.length,
      outputDir: this.outputDir,
      format: this.selectedFormat,
      quality: this.quality
    });
    
    if (selectedImages.length === 0) {
      this.app.showToast('warning', 'No Images Selected', 'Please select at least one image to convert');
      return;
    }
    
    if (!this.outputDir) {
      this.app.showToast('warning', 'No Output Directory', 'Please select an output directory first');
      return;
    }
    
    try {
      const statusEl = document.getElementById('image-conversion-status');
      const startBtn = document.getElementById('start-image-conversion');
      
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Converting...';
      }
      if (statusEl) {
        const statusText = statusEl.querySelector('.status-text');
        const progressText = statusEl.querySelector('.progress-text');
        if (statusText) statusText.textContent = 'Processing...';
        if (progressText) progressText.textContent = `0 / ${selectedImages.length} images (0%)`;
      }
      
      const processId = `img_${Date.now()}`;
      const imagePaths = selectedImages.map(img => img.path);
      
      console.log('[CONVERT] Process ID:', processId);
      console.log('[CONVERT] Image paths:', imagePaths);
      
      // Mark selected images as processing
      selectedImages.forEach(img => {
        img.status = 'processing';
      });
      this.updateImageList();
      
      const payload = {
        input_files: imagePaths,
        output_dir: this.outputDir,
        output_format: this.selectedFormat,
        quality: this.quality,
        process_id: processId
      };
      
      console.log('[CONVERT] Sending request:', payload);
      
      const response = await this.app.apiRequest('POST', '/api/image/process-batch', payload);
      
      console.log('[CONVERT] Response:', response);
      
      if (response && response.success) {
        this.currentProcessId = processId;
        this.app.showToast('info', 'Processing Started', `Converting ${selectedImages.length} image(s)...`);
        this.monitorProgress(processId);
      } else {
        throw new Error(response?.error || 'Failed to start conversion');
      }
    } catch (error) {
      console.error('[CONVERT] Error:', error);
      this.app.showToast('error', 'Conversion Failed', error.message || 'Failed to start conversion');
      
      // Reset button state
      const startBtn = document.getElementById('start-image-conversion');
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
      }
      
      // Reset image statuses
      this.imageFiles.forEach(img => {
        if (img.status === 'processing') {
          img.status = null;
        }
      });
      this.updateImageList();
    }
  }
  
  async monitorProgress(processId) {
    const statusEl = document.getElementById('image-conversion-status');
    const startBtn = document.getElementById('start-image-conversion');
    
    let pollCount = 0;
    const maxPolls = 200; // 60 seconds max
    
    const checkProgress = async () => {
      pollCount++;
      
      try {
        const response = await this.app.apiRequest('GET', `/api/image/process-status/${processId}`);
        
        if (response && response.success && response.process) {
          const proc = response.process;
          
          // Update status display
          if (statusEl) {
            const statusText = statusEl.querySelector('.status-text');
            const progressText = statusEl.querySelector('.progress-text');
            if (statusText) {
              statusText.textContent = proc.status === 'completed' ? 'Completed' : 
                                     proc.status === 'failed' ? 'Failed' : 'Processing';
            }
            if (progressText) {
              const totalFiles = proc.total_files || 0;
              const completedFiles = proc.completed_files || 0;
              const progressPercent = proc.progress || 0;
              progressText.textContent = `${completedFiles} / ${totalFiles} images (${progressPercent}%)`;
            }
          }
          
          // REAL-TIME UPDATE: Update list as each image completes
          if (proc.results && proc.results.length > 0) {
            let updated = false;
            proc.results.forEach(result => {
              const img = this.imageFiles.find(img => img.path === result.input_path);
              if (img && result.success && !img.converted) { // Only update if not already updated
                img.converted = `file://${result.output_path}`;
                img.convertedPath = result.output_path;
                img.convertedMetadata = result.final_metadata;
                img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? 'success' : 'warning';
                updated = true;
              } else if (img && !result.success && img.status === 'processing') {
                img.status = 'error';
                updated = true;
              }
            });
            // Update the list view in real-time if we made changes
            if (updated) {
              this.updateImageList();
            }
          }
          
          // Check if completed or failed
          if (proc.status === 'completed') {
            this.handleConversionComplete(proc);
            return;
          } else if (proc.status === 'failed') {
            this.app.showToast('error', 'Conversion Failed', proc.error || 'Unknown error');
            if (statusEl) {
              const statusText = statusEl.querySelector('.status-text');
              if (statusText) statusText.textContent = 'Failed';
            }
            // Still update what we have
            if (proc.results && proc.results.length > 0) {
              proc.results.forEach(result => {
                const img = this.imageFiles.find(img => img.path === result.input_path);
                if (img) {
                  if (result.success) {
                    img.converted = `file://${result.output_path}`;
                    img.convertedPath = result.output_path;
                    img.convertedMetadata = result.final_metadata;
                    img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? 'success' : 'warning';
                  } else {
                    img.status = 'error';
                  }
                }
              });
              this.updateImageList();
            }
            // Reset button
            if (startBtn) {
              startBtn.disabled = false;
              startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
            }
            return;
          }
          
          // Continue monitoring
          setTimeout(checkProgress, 300); // Faster polling for better responsiveness
        } else {
          // Handle case where process is not found or response is invalid
          console.warn('[MONITOR] Invalid response or process not found');
          if (startBtn) {
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
          }
        }
      } catch (error) {
        console.error('Error checking progress:', error);
        if (startBtn) {
          startBtn.disabled = false;
          startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
        }
      }
    };
    
    checkProgress();
  }
  
  handleConversionComplete(proc) {
    const statusEl = document.getElementById('image-conversion-status');
    const startBtn = document.getElementById('start-image-conversion');
    
    if (statusEl) {
      const statusText = statusEl.querySelector('.status-text');
      const progressText = statusEl.querySelector('.progress-text');
      if (statusText) statusText.textContent = 'Completed';
      if (progressText) {
        const successCount = proc.success_count || 0;
        const totalCount = proc.total_files || 0;
        progressText.textContent = `${successCount} successful, ${proc.failed_count || 0} failed`;
      }
    }
    
    // Reset the convert button
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
    }
    
    this.app.showToast('success', 'Conversion Complete', 
      `Successfully converted ${proc.success_count || 0} of ${proc.total_files || 0} images`);
    
    // Update image files with conversion results
    if (proc.results && proc.results.length > 0) {
      proc.results.forEach(result => {
        const img = this.imageFiles.find(img => img.path === result.input_path);
        if (img) {
          if (result.success) {
            img.converted = `file://${result.output_path}`;
            img.convertedPath = result.output_path;
            img.convertedMetadata = result.final_metadata;
            img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? 'success' : 'warning';
          } else {
            img.status = 'error';
          }
        }
      });
      
      this.updateImageList();
      
      // Update preview if current image was converted
      if (this.selectedImageIndex !== null) {
        this.updateImageDetails(this.imageFiles[this.selectedImageIndex]);
      }
    }
    
    
    // Reset image selection statuses
    this.imageFiles.forEach(img => {
      if (img.status === 'processing') {
        img.status = null;
      }
    });
    
    // Update selection count to reflect current state
    this.updateSelectionCount();
  }
  
}

// Export for use in main app
if (typeof window !== 'undefined') {
  window.ImageHandler = ImageHandler;
}
