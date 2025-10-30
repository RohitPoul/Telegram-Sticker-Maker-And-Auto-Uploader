/**
 * Image Handler Module
 * Handles image conversion for Telegram stickers
 */

class ImageHandler {
  constructor(app) {
    this.app = app;
    this.imageFiles = []; // Each item: {path, name, thumbnail, metadata, converted, convertedMetadata, status, selected}
    this.selectedFormat = "png";
    this.quality = 95;
    this.outputDir = "";
    this.currentProcessId = null;
    this.selectedImageIndex = null;
    this.previewMode = "original"; // 'original' or 'converted'

    this.init();
  }

  // Ensure UI and state are reset when images are cleared/removed
  resetConversionUI() {
    this.currentProcessId = null;
    this.previewMode = "original";

    const statusEl = document.getElementById("image-conversion-status");
    if (statusEl) {
      const statusText = statusEl.querySelector(".status-text");
      const progressText = statusEl.querySelector(".progress-text");
      if (statusText) statusText.textContent = "Ready";
      if (progressText) progressText.textContent = "";
    }

    const convertBtn = document.getElementById("start-image-conversion");
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
    const convertBtn = document.getElementById("start-image-conversion");
    if (convertBtn) {
      convertBtn.disabled = true; // Disabled until images selected and output dir set
    }
  }

  setupEventListeners() {
    // Add images button
    const addImagesBtn = document.getElementById("add-images");
    if (addImagesBtn) {
      addImagesBtn.addEventListener("click", () => this.selectImages());
    }

    // Clear images button
    const clearImagesBtn = document.getElementById("clear-images");
    if (clearImagesBtn) {
      clearImagesBtn.addEventListener("click", () => this.clearImages());
    }

    // Format selector (works with all styles)
    const formatBtns = document.querySelectorAll(".format-btn, .format-btn-compact, .format-toggle-btn");
    formatBtns.forEach(btn => {
      btn.addEventListener("click", (_e) => {
        formatBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.selectedFormat = btn.dataset.format;
      });
    });

    // Quality slider
    const qualitySlider = document.getElementById("image-quality");
    const qualityValue = document.getElementById("image-quality-value");
    if (qualitySlider && qualityValue) {
      qualitySlider.addEventListener("input", (e) => {
        this.quality = parseInt(e.target.value);
        qualityValue.textContent = this.quality;
      });
    }

    // Output directory browser
    const browseOutputBtn = document.getElementById("browse-image-output");
    if (browseOutputBtn) {
      browseOutputBtn.addEventListener("click", () => this.selectOutputDirectory());
    }

    // Start conversion button
    const startConversionBtn = document.getElementById("start-image-conversion");
    if (startConversionBtn) {
      startConversionBtn.addEventListener("click", () => {
        this.startConversion();
      });
    }

    // Select all button
    const selectAllBtn = document.getElementById("select-all-images");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => this.selectAllImages());
    }

    // Deselect all button  
    const deselectAllBtn = document.getElementById("deselect-all-images");
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener("click", () => this.deselectAllImages());
    }

  }

  async checkImageMagick() {
    try {
      const response = await this.app.apiRequest("GET", "/api/image/check-imagemagick");
      if (response && response.success) {
        if (!response.available) {
          this.app.showToast("warning", "ImageMagick Not Found",
            "ImageMagick is required for image conversion. Please install it to use this feature.");
        }
      }
    } catch (error) {
      console.error("Error checking ImageMagick:", error);
    }
  }

  async selectImages() {
    try {
      const filePaths = await window.electronAPI.selectFiles({
        title: "Select Images",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif"] }
        ]
      });

      // The IPC handler returns an array directly (or empty array if canceled)
      if (filePaths && Array.isArray(filePaths) && filePaths.length > 0) {
        // Add new images to the list with immediate metadata loading
        const newImages = [];
        for (const filePath of filePaths) {
          if (!this.imageFiles.some(img => img.path === filePath)) {
            const newImg = {
              path: filePath,
              name: filePath.split("/").pop().split("\\").pop(),
              thumbnail: null,
              metadata: null,
              selected: true // Auto-select new images
            };
            this.imageFiles.push(newImg);
            newImages.push(newImg);
          }
        }

        await this.updateImageList();

        // Load metadata immediately for all new images
        const metadataPromises = newImages.map((img, _idx) => {
          const globalIndex = this.imageFiles.indexOf(img);
          return this.loadImageMetadata(globalIndex);
        });

        // Wait for all metadata to load, then update list again
        Promise.all(metadataPromises).then(() => {
          this.updateImageList();
          this.updateSelectionCount();
        });

        this.app.showToast("success", "Images Added", `Added ${filePaths.length} image(s)`);
      }
    } catch (error) {
      console.error("Error selecting images:", error);
      this.app.showToast("error", "Error", "Failed to select images");
    }
  }

  clearImages() {
    if (this.imageFiles.length === 0) return;

    // Clean up data URLs and object references
    this.imageFiles.forEach(img => {
      if (img.thumbnail && img.thumbnail.startsWith("blob:")) {
        URL.revokeObjectURL(img.thumbnail);
      }
      if (img.converted && img.converted.startsWith("blob:")) {
        URL.revokeObjectURL(img.converted);
      }
      // Clear references
      img.thumbnail = null;
      img.converted = null;
      img.metadata = null;
      img.convertedMetadata = null;
    });

    const count = this.imageFiles.length;
    this.imageFiles = [];
    this.selectedImageIndex = null;
    this.previewMode = "original";
    this.updateImageList();
    this.updateImageDetails(null);
    this.app.showToast("success", "Images Cleared", `Removed ${count} image(s)`);
    this.resetConversionUI();

    // Force garbage collection hint
    if (window.gc) window.gc();
  }

  async updateImageList() {
    const fileList = document.getElementById("image-file-list");
    const fileCount = document.getElementById("image-file-count");

    if (!fileList) return;

    if (this.imageFiles.length === 0) {
      fileList.innerHTML = `
        <div class="empty-state-mini">
          <i class="fas fa-image"></i>
          <p>No images</p>
        </div>
      `;
      if (fileCount) fileCount.textContent = "0";
      return;
    }

    if (fileCount) fileCount.textContent = this.imageFiles.length;

    // Use virtual scrolling for large lists (100+ images)
    if (this.imageFiles.length > 100) {
      this.renderVirtualImageList(fileList);
      return;
    }

    // Store scroll position
    const scrollPos = fileList.scrollTop;

    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    fileList.classList.remove("image-preview-grid");
    fileList.classList.add("image-list-compact");

    for (let i = 0; i < this.imageFiles.length; i++) {
      const img = this.imageFiles[i];
      const imgItem = document.createElement("div");
      imgItem.className = "image-list-item";
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
      const originalSize = img.metadata ? img.metadata.file_size_kb : "?";
      const convertedSize = img.convertedMetadata ? img.convertedMetadata.file_size_kb : null;
      const sizeStatus = img.metadata && img.metadata.file_size_kb > 512 ? "size-over-limit" : "size-ok";
      const convertedSizeStatus = convertedSize && convertedSize <= 512 ? "size-ok" : (convertedSize ? "size-over-limit" : "");

      imgItem.innerHTML = `
        <div class="image-list-checkbox">
          <input type="checkbox" id="img-check-${i}" ${img.selected ? "checked" : ""}>
          <label for="img-check-${i}"></label>
        </div>
        <div class="image-list-thumbnails">
          <div class="image-list-thumb">
            <img src="${img.thumbnail}" alt="${img.name}" loading="lazy">
            <div class="image-list-thumb-label">Original</div>
          </div>
          <div class="image-list-thumb ${!img.converted ? "placeholder" : ""}">
            ${img.converted ? `<img src="${img.converted}" alt="Converted" loading="lazy">` : ""}
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
            ` : img.status === "error" && img.errorMessage ? `
              <div class="image-list-stat" style="color: var(--error-color);" title="${img.errorMessage}">
                <i class="fas fa-exclamation-circle image-list-stat-icon"></i>
                <span>Failed</span>
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
        checkbox.addEventListener("change", (e) => {
          e.stopPropagation();
          img.selected = checkbox.checked;
          this.updateSelectionCount();
        });
      }

      // Add click handler to show preview (not the checkbox area)
      imgItem.addEventListener("click", (e) => {
        if (!e.target.closest(".image-list-remove") && !e.target.closest(".image-list-checkbox")) {
          this.selectImage(i);
        }
      });

      // Open fullscreen viewer on thumbnail click
      const origThumb = imgItem.querySelector(".image-list-thumb:first-child img");
      const convThumb = imgItem.querySelector(".image-list-thumb:nth-child(2) img");
      if (origThumb) {
        origThumb.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openFullscreenViewer(`file://${img.path}`, `${img.name} • Original`);
        });
      }
      if (convThumb) {
        convThumb.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openFullscreenViewer(img.converted, `${img.name} • Converted`);
        });
      }

      // Add remove button handler
      const removeBtn = imgItem.querySelector(".image-list-remove");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeImage(i);
      });

      fragment.appendChild(imgItem);
    }

    // Clear and append all at once for better performance
    fileList.innerHTML = "";
    fileList.appendChild(fragment);

    // Restore scroll position
    fileList.scrollTop = scrollPos;
  }

  renderVirtualImageList(container) {
    // Virtual scrolling for large image lists
    const itemHeight = 80; // Height of each image list item
    const visibleHeight = container.clientHeight || 400;
    const totalHeight = this.imageFiles.length * itemHeight;

    container.classList.add("image-list-compact");
    container.style.position = "relative";
    container.style.overflowY = "auto";

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
    container.innerHTML = "";
    container.appendChild(spacer);

    let lastRenderTop = 0;
    const renderBuffer = 5;

    const renderVisibleItems = () => {
      const scrollTop = container.scrollTop;
      const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - renderBuffer);
      const endIndex = Math.min(
        this.imageFiles.length,
        Math.ceil((scrollTop + visibleHeight) / itemHeight) + renderBuffer
      );

      // Only re-render if scrolled significantly
      if (Math.abs(scrollTop - lastRenderTop) < itemHeight / 2 && itemsContainer.children.length > 0) return;
      lastRenderTop = scrollTop;

      // Create visible items
      const fragment = document.createDocumentFragment();

      for (let i = startIndex; i < endIndex; i++) {
        const element = this.createImageListItem(i);
        element.style.position = "absolute";
        element.style.top = (i * itemHeight) + "px";
        element.style.left = "0";
        element.style.right = "0";
        element.style.height = itemHeight + "px";
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

  createImageListItem(i) {
    const img = this.imageFiles[i];
    const imgItem = document.createElement("div");
    imgItem.className = "image-list-item";
    imgItem.dataset.index = i;

    if (img.status) {
      imgItem.classList.add(`status-${img.status}`);
    }

    if (!img.thumbnail) {
      img.thumbnail = `file://${img.path}`;
    }

    const originalSize = img.metadata ? img.metadata.file_size_kb : "?";
    const convertedSize = img.convertedMetadata ? img.convertedMetadata.file_size_kb : null;
    const sizeStatus = img.metadata && img.metadata.file_size_kb > 512 ? "size-over-limit" : "size-ok";
    const convertedSizeStatus = convertedSize && convertedSize <= 512 ? "size-ok" : (convertedSize ? "size-over-limit" : "");

    imgItem.innerHTML = `
      <div class="image-list-checkbox">
        <input type="checkbox" id="img-check-${i}" ${img.selected ? "checked" : ""}>
        <label for="img-check-${i}"></label>
      </div>
      <div class="image-list-thumbnails">
        <div class="image-list-thumb">
          <img src="${img.thumbnail}" alt="${img.name}" loading="lazy">
          <div class="image-list-thumb-label">Original</div>
        </div>
        <div class="image-list-thumb ${!img.converted ? "placeholder" : ""}">
          ${img.converted ? `<img src="${img.converted}" alt="Converted" loading="lazy">` : ""}
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
          ` : img.status === "error" && img.errorMessage ? `
            <div class="image-list-stat" style="color: var(--error-color);" title="${img.errorMessage}">
              <i class="fas fa-exclamation-circle image-list-stat-icon"></i>
              <span>Failed</span>
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
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        img.selected = checkbox.checked;
        this.updateSelectionCount();
      });
    }

    // Add click handler
    imgItem.addEventListener("click", (e) => {
      if (!e.target.closest(".image-list-remove") && !e.target.closest(".image-list-checkbox")) {
        this.selectImage(i);
      }
    });

    // Add remove button handler
    const removeBtn = imgItem.querySelector(".image-list-remove");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeImage(i);
    });

    return imgItem;
  }

  async loadImageMetadata(index) {
    const img = this.imageFiles[index];
    if (!img) return;

    try {
      const response = await this.app.apiRequest("POST", "/api/image/metadata", {
        image_path: img.path
      });

      if (response && response.success && response.metadata) {
        img.metadata = response.metadata;
        // Metadata will be displayed on next list update
      }
    } catch (error) {
      console.error("Error loading metadata:", error);
      const metaEl = document.getElementById(`image-meta-${index}`);
      if (metaEl) {
        metaEl.textContent = "Error loading info";
      }
    }
  }

  removeImage(index) {
    // Clean up resources before removing
    const img = this.imageFiles[index];
    if (img) {
      if (img.thumbnail && img.thumbnail.startsWith("blob:")) {
        URL.revokeObjectURL(img.thumbnail);
      }
      if (img.converted && img.converted.startsWith("blob:")) {
        URL.revokeObjectURL(img.converted);
      }
    }

    this.imageFiles.splice(index, 1);
    if (this.selectedImageIndex === index) {
      this.selectedImageIndex = null;
      this.previewMode = "original";
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
    document.querySelectorAll(".image-list-item").forEach((item, i) => {
      item.classList.toggle("selected", i === index);
    });

    // Reset preview mode to original when selecting new image
    this.previewMode = "original";
    this.updateImageDetails(img);
  }

  openFullscreenViewer(src, title = "") {
    try {
      if (window.ImageViewer && typeof window.ImageViewer.open === "function") {
        window.ImageViewer.open({ src, title });
      }
    } catch (_e) {
      // Intentionally ignore fullscreen viewer errors
    }
  }

  updateImageDetails(img) {
    const detailsContainer = document.getElementById("image-details-container");
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
    if (this.previewMode === "converted" && hasConverted) {
      previewSrc = img.converted;
      previewMeta = img.convertedMetadata;
    } else {
      previewSrc = `file://${img.path}`;
      previewMeta = meta;
    }

    detailsContainer.innerHTML = `
      <div class="image-details-content">
        <div class="preview-controls">
          <button class="preview-mode-btn ${this.previewMode === "original" ? "active" : ""}" data-mode="original">
            <i class="fas fa-image"></i> Original
          </button>
          <button class="preview-mode-btn ${this.previewMode === "converted" ? "active" : ""}" data-mode="converted" ${!hasConverted ? "disabled" : ""}>
            <i class="fas fa-check-circle"></i> Converted
          </button>
        </div>
        <div class="image-details-preview">
          <img src="${previewSrc}" alt="${img.name}">
          ${!hasConverted && this.previewMode === "converted" ? '<div class="preview-message">Not converted yet</div>' : ""}
        </div>
        <div class="preview-info">
          <div class="preview-info-item">
            <span class="label">Size:</span>
            <span class="value">${previewMeta.width}×${previewMeta.height}px</span>
          </div>
          <div class="preview-info-item">
            <span class="label">File:</span>
            <span class="value ${previewMeta.file_size_kb > 512 ? "text-error" : "text-success"}">${previewMeta.file_size_kb}KB</span>
          </div>
          <div class="preview-info-item">
            <span class="label">Input:</span>
            <span class="value">${meta.format ? meta.format.toUpperCase() : "Unknown"}</span>
          </div>
          <div class="preview-info-item">
            <span class="label">Output:</span>
            <span class="value">${this.selectedFormat ? this.selectedFormat.toUpperCase() : "PNG"}</span>
          </div>
        </div>
      </div>
    `;

    // Add event listeners for preview mode buttons
    detailsContainer.querySelectorAll(".preview-mode-btn").forEach(btn => {
      btn.addEventListener("click", (_e) => {
        const mode = btn.dataset.mode;
        if (mode && !btn.disabled) {
          this.previewMode = mode;
          this.updateImageDetails(img);
        }
      });
    });

    // Fullscreen on main preview click
    const mainPreview = detailsContainer.querySelector(".image-details-preview img");
    if (mainPreview) {
      mainPreview.addEventListener("click", () => {
        const title = this.previewMode === "converted" ? `${img.name} • Converted` : `${img.name} • Original`;
        this.openFullscreenViewer(mainPreview.src, title);
      });
    }
  }

  async selectOutputDirectory() {
    try {
      const directory = await window.electronAPI.selectDirectory({
        title: "Select Output Directory"
      });

      // The IPC handler returns a string directly (or undefined if canceled)
      if (directory) {
        this.outputDir = directory;
        const outputDirInput = document.getElementById("image-output-dir");
        if (outputDirInput) {
          outputDirInput.value = this.outputDir;
        }

        // Update convert button state
        this.updateSelectionCount();
        this.app.showToast("success", "Output Directory Set", "Ready to convert images");
      }
    } catch (error) {
      console.error("Error selecting directory:", error);
      this.app.showToast("error", "Error", "Failed to select directory");
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
    const countEl = document.getElementById("selected-image-count");
    if (countEl) {
      countEl.textContent = selectedCount;
    }

    // Enable/disable convert button based on selection and output dir
    const convertBtn = document.getElementById("start-image-conversion");
    if (convertBtn) {
      const canConvert = selectedCount > 0 && this.outputDir;
      convertBtn.disabled = !canConvert;

      // Update button text/tooltip to guide user
      if (!this.outputDir) {
        convertBtn.title = "⚠️ Please select output directory first";
        convertBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Select Output Directory First';
      } else if (selectedCount === 0) {
        convertBtn.title = "⚠️ Please select at least one image";
        convertBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Select Images First';
      } else {
        convertBtn.title = `Convert ${selectedCount} selected image(s)`;
        convertBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
      }
    }
  }

  async startConversion() {
    const selectedImages = this.imageFiles.filter(img => img.selected);

    if (selectedImages.length === 0) {
      this.app.showToast("warning", "No Images Selected", "Please select at least one image to convert");
      return;
    }

    if (!this.outputDir) {
      this.app.showToast("warning", "No Output Directory", "Please select an output directory first");
      return;
    }

    try {
      const statusEl = document.getElementById("image-conversion-status");
      const startBtn = document.getElementById("start-image-conversion");

      if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Converting...';
      }
      if (statusEl) {
        const statusText = statusEl.querySelector(".status-text");
        const progressText = statusEl.querySelector(".progress-text");
        if (statusText) statusText.textContent = "Processing...";
        if (progressText) progressText.textContent = `0 / ${selectedImages.length} images (0%)`;
      }

      const processId = `img_${Date.now()}`;
      const imagePaths = selectedImages.map(img => img.path);

      // Mark selected images as processing
      selectedImages.forEach(img => {
        img.status = "processing";
      });
      this.updateImageList();

      const payload = {
        input_files: imagePaths,
        output_dir: this.outputDir,
        output_format: this.selectedFormat,
        quality: this.quality,
        process_id: processId
      };

      console.log("[IMAGE] Sending batch request:", payload);
      const response = await this.app.apiRequest("POST", "/api/image/process-batch", payload);
      console.log("[IMAGE] Batch response:", response);

      if (response && response.success) {
        this.currentProcessId = processId;
        this.app.showToast("info", "Processing Started", `Converting ${selectedImages.length} image(s)...`);
        this.monitorProgress(processId);
      } else {
        throw new Error(response?.error || "Failed to start conversion");
      }
    } catch (error) {
      console.error("Conversion error:", error);
      this.app.showToast("error", "Conversion Failed", error.message || "Failed to start conversion");

      // Reset button state
      const startBtn = document.getElementById("start-image-conversion");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
      }

      // Reset image statuses
      this.imageFiles.forEach(img => {
        if (img.status === "processing") {
          img.status = null;
        }
      });
      this.updateImageList();
    }
  }

  async monitorProgress(processId) {
    const statusEl = document.getElementById("image-conversion-status");
    const startBtn = document.getElementById("start-image-conversion");

    let pollCount = 0;
    const maxPolls = 200; // 60 seconds max

    const checkProgress = async () => {
      pollCount++;

      try {
        const response = await this.app.apiRequest("GET", `/api/image/process-status/${processId}`);
        console.log("[MONITOR] Progress check response:", response);

        if (response && response.success && response.process) {
          const proc = response.process;

          // Update status display
          if (statusEl) {
            const statusText = statusEl.querySelector(".status-text");
            const progressText = statusEl.querySelector(".progress-text");
            if (statusText) {
              statusText.textContent = proc.status === "completed" ? "Completed" :
                proc.status === "failed" ? "Failed" : "Processing";
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
                img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? "success" : "warning";
                updated = true;
              } else if (img && !result.success && img.status === "processing") {
                img.status = "error";
                updated = true;
              }
            });
            // Update the list view in real-time if we made changes
            if (updated) {
              this.updateImageList();
            }
          }

          // Check if completed or failed
          console.log("[MONITOR] Current status:", proc.status, "Progress:", proc.progress);
          
          if (proc.status === "completed") {
            console.log("[MONITOR] Conversion completed", proc);
            this.handleConversionComplete(proc);
            return;
          } else if (proc.status === "failed") {
            console.error("[MONITOR] Conversion failed", proc);
            const errorMsg = proc.error || proc.message || "Conversion process failed";
            this.app.showToast("error", "Conversion Failed", errorMsg);
            if (statusEl) {
              const statusText = statusEl.querySelector(".status-text");
              if (statusText) statusText.textContent = "Failed";
            }
            // Still update what we have and extract specific error
            if (proc.results && proc.results.length > 0) {
              console.log("[MONITOR] Updating results despite failure", proc.results);

              // Get the first error message for display
              const firstError = proc.results.find(r => !r.success && r.error);
              if (firstError && firstError.error) {
                // Check for ImageMagick missing
                if (firstError.error.includes("magick") || firstError.error.includes("ImageMagick")) {
                  this.app.showToast("error", "ImageMagick Not Found",
                    "Please install ImageMagick: sudo apt install imagemagick");
                } else {
                  this.app.showToast("error", "Conversion Error", firstError.error);
                }
              }

              proc.results.forEach(result => {
                const img = this.imageFiles.find(img => img.path === result.input_path);
                if (img) {
                  if (result.success) {
                    img.converted = `file://${result.output_path}`;
                    img.convertedPath = result.output_path;
                    img.convertedMetadata = result.final_metadata;
                    img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? "success" : "warning";
                  } else {
                    img.status = "error";
                    img.errorMessage = result.error || "Conversion failed";
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
          console.warn("[MONITOR] Invalid response or process not found", response);

          // If we've polled too many times, give up
          if (pollCount >= maxPolls) {
            this.app.showToast("error", "Conversion Timeout", "Process monitoring timed out");
            if (startBtn) {
              startBtn.disabled = false;
              startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
            }
            return;
          }

          // Otherwise, continue polling
          setTimeout(checkProgress, 500);
        }
      } catch (error) {
        console.error("[MONITOR] Error checking progress:", error);

        // If we've polled too many times, give up
        if (pollCount >= maxPolls) {
          this.app.showToast("error", "Conversion Error", error.message || "Failed to monitor conversion");
          if (startBtn) {
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
          }
          return;
        }

        // Otherwise, retry
        setTimeout(checkProgress, 500);
      }
    };

    checkProgress();
  }

  handleConversionComplete(proc) {
    console.log("[IMAGE] handleConversionComplete called", proc);
    const statusEl = document.getElementById("image-conversion-status");
    const startBtn = document.getElementById("start-image-conversion");

    if (statusEl) {
      const statusText = statusEl.querySelector(".status-text");
      const progressText = statusEl.querySelector(".progress-text");
      if (statusText) statusText.textContent = "Completed";
      if (progressText) {
        const successCount = proc.success_count || 0;
        progressText.textContent = `${successCount} successful, ${proc.failed_count || 0} failed`;
      }
    }

    // Reset the convert button
    console.log("[IMAGE] Resetting button, startBtn:", startBtn);
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="fas fa-magic"></i> Convert';
      console.log("[IMAGE] Button reset complete");
    } else {
      console.error("[IMAGE] startBtn not found!");
    }

    this.app.showToast("success", "Conversion Complete",
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
            img.status = result.final_metadata && result.final_metadata.file_size_kb <= 512 ? "success" : "warning";
          } else {
            img.status = "error";
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
      if (img.status === "processing") {
        img.status = null;
      }
    });

    // Update selection count to reflect current state
    this.updateSelectionCount();
  }

}

// Export for use in main app
if (typeof window !== "undefined") {
  window.ImageHandler = ImageHandler;
}
