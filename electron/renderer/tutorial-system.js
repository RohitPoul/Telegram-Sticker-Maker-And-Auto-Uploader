/**
 * Modern Tutorial System
 * Provides interactive, animated tutorials for the application
 */

class TutorialSystem {
  constructor() {
    this.currentTutorial = null;
    this.currentStep = 0;
    this.isActive = false;
    this.tutorials = new Map();
    this.userProgress = this.loadProgress();
    
    this.overlay = null;
    this.tooltip = null;
    this.spotlight = null;
    this.searchInput = null;
    
    this.init();
  }

  init() {
    // Load tutorial completion status from localStorage
    this.loadProgress();
    
    // Add tutorial CSS if not already added
    this.injectStyles();
    
    // Register default tutorials
    this.registerDefaultTutorials();
    
    // Add keyboard event listeners
    this.addKeyboardListeners();
    
    // Add periodic cleanup for stray elements
    this.setupPeriodicCleanup();
  }

  loadProgress() {
    try {
      const saved = localStorage.getItem("tutorial_progress");
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  }

  saveProgress() {
    localStorage.setItem("tutorial_progress", JSON.stringify(this.userProgress));
  }

  markCompleted(tutorialId) {
    this.userProgress[tutorialId] = {
      completed: true,
      completedAt: Date.now(),
      viewCount: (this.userProgress[tutorialId]?.viewCount || 0) + 1
    };
    this.saveProgress();
  }

  hasCompleted(tutorialId) {
    return this.userProgress[tutorialId]?.completed || false;
  }

  injectStyles() {
    if (document.getElementById("tutorial-system-styles")) return;

    const style = document.createElement("style");
    style.id = "tutorial-system-styles";
    style.textContent = `
      /* Tutorial Overlay - More transparent */
      .tutorial-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.3); /* Even more transparent */
        z-index: 9998;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        /* Ensure visibility */
        visibility: hidden;
        display: block;
      }

      .tutorial-overlay.active {
        opacity: 1;
        pointer-events: all;
        visibility: visible;
      }

      /* Spotlight Effect - Simplified */
      .tutorial-spotlight {
        position: fixed;
        pointer-events: none;
        z-index: 9999;
        border: 2px solid #4CAF50;
        border-radius: 4px;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.4); /* More transparent */
        /* Ensure visibility */
        visibility: hidden;
        display: block;
      }
      
      .tutorial-spotlight.active {
        visibility: visible;
      }

      /* Tutorial Tooltip - Enhanced glass effect */
      .tutorial-tooltip {
        position: fixed;
        background: rgba(30, 30, 30, 0.9); /* Solid background for better performance */
        color: #f5f5f5;
        padding: 0;
        border-radius: 12px;
        max-width: 400px;
        z-index: 10000;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.18);
        /* Removed backdrop-filter for better performance */
        opacity: 0;
        transform: scale(0.95) translateY(10px);
        transition: all 0.2s ease;
        /* Ensure visibility */
        visibility: hidden;
      }

      .tutorial-tooltip.active {
        opacity: 1;
        transform: scale(1) translateY(0);
        visibility: visible;
      }

      .tutorial-tooltip-header {
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .tutorial-tooltip-icon {
        font-size: 24px;
        line-height: 1;
      }

      .tutorial-tooltip-title {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
        flex: 1;
      }

      .tutorial-tooltip-body {
        padding: 16px 20px;
        line-height: 1.5;
      }

      .tutorial-tooltip-body p {
        margin: 0 0 10px 0;
        font-size: 13px;
      }

      .tutorial-tooltip-body p:last-child {
        margin-bottom: 0;
      }

      .tutorial-tip {
        background: rgba(255, 255, 255, 0.12);
        padding: 10px;
        border-radius: 6px;
        margin-top: 10px;
        font-size: 12px;
        display: flex;
        gap: 6px;
        align-items: start;
      }

      .tutorial-tip-icon {
        font-size: 14px;
        line-height: 1;
      }

      .tutorial-tooltip-footer {
        padding: 14px 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .tutorial-progress {
        font-size: 12px;
        opacity: 0.85;
        font-weight: 500;
      }

      .tutorial-actions {
        display: flex;
        gap: 6px;
      }

      .tutorial-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        outline: none;
        background: rgba(255, 255, 255, 0.15);
        color: #f5f5f5;
      }

      .tutorial-btn:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .tutorial-btn-prev:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .tutorial-btn-next {
        background: rgba(76, 175, 80, 0.3);
        color: #f5f5f5;
      }

      .tutorial-btn-next:hover {
        background: rgba(76, 175, 80, 0.4);
      }

      /* Tutorial Menu Modal - Enhanced glass effect */
      .tutorial-menu {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.95);
        background: rgba(30, 30, 30, 0.95); /* Solid background for better performance */
        border-radius: 16px;
        padding: 0;
        max-width: 550px;
        width: 90%;
        max-height: 80vh;
        overflow: hidden;
        z-index: 10001;
        box-shadow: 0 16px 64px rgba(0, 0, 0, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.18);
        /* Removed backdrop-filter for better performance */
        opacity: 0;
        transition: all 0.2s ease;
        /* Ensure visibility */
        visibility: hidden;
        display: block;
      }

      .tutorial-menu.active {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
        visibility: visible;
      }

      .tutorial-menu-header {
        padding: 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        color: #f5f5f5;
      }

      .tutorial-menu-title {
        font-size: 24px;
        font-weight: 600;
        margin: 0 0 6px 0;
      }

      .tutorial-menu-subtitle {
        font-size: 13px;
        opacity: 0.85;
        margin: 0;
      }

      .tutorial-search-container {
        margin-top: 16px;
        position: relative;
      }

      .tutorial-search-input {
        width: 100%;
        padding: 10px 14px 10px 36px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(0, 0, 0, 0.3);
        color: #f5f5f5;
        font-size: 13px;
        outline: none;
      }

      .tutorial-search-input::placeholder {
        color: rgba(255, 255, 255, 0.6);
      }

      .tutorial-search-input:focus {
        border-color: rgba(255, 255, 255, 0.35);
        background: rgba(0, 0, 0, 0.4);
      }

      .tutorial-search-icon {
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: rgba(255, 255, 255, 0.6);
        font-size: 14px;
      }

      .tutorial-menu-content {
        padding: 20px 24px;
        max-height: 50vh;
        overflow-y: auto;
      }

      .tutorial-menu-item {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
        color: #f5f5f5;
        display: flex;
        gap: 14px;
        align-items: center;
      }

      .tutorial-menu-item:hover {
        background: rgba(255, 255, 255, 0.15);
        transform: translateX(2px);
      }

      .tutorial-menu-item-icon {
        font-size: 28px;
        line-height: 1;
      }

      .tutorial-menu-item-content {
        flex: 1;
      }

      .tutorial-menu-item-title {
        font-size: 15px;
        font-weight: 600;
        margin: 0 0 3px 0;
      }

      .tutorial-menu-item-desc {
        font-size: 12px;
        opacity: 0.85;
        margin: 0;
      }

      .tutorial-menu-item-badge {
        background: rgba(76, 175, 80, 0.25);
        color: #4CAF50;
        padding: 3px 10px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .tutorial-menu-footer {
        padding: 16px 24px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        display: flex;
        justify-content: flex-end;
      }

      /* Simplified transitions for better performance */
      .tutorial-tooltip,
      .tutorial-menu,
      .tutorial-overlay {
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      
      /* Keyboard navigation focus */
      .tutorial-menu-item:focus,
      .tutorial-btn:focus {
        outline: 1px solid #4CAF50;
        outline-offset: 1px;
      }
      
      /* Tutorial Launcher Button - Enhanced glass effect */
      .tutorial-launcher {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        border-radius: 50%;
        background: rgba(20, 20, 20, 0.6);
        color: #f5f5f5;
        border: 1px solid rgba(255, 255, 255, 0.18);
        font-size: 20px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        z-index: 9997;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(12px);
      }

      .tutorial-launcher:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
        background: rgba(30, 30, 30, 0.7);
      }

      .tutorial-launcher.hidden {
        opacity: 0;
        pointer-events: none;
      }
    `;

    document.head.appendChild(style);
  }

  registerTutorial(id, config) {
    this.tutorials.set(id, {
      id,
      title: config.title,
      description: config.description,
      icon: config.icon,
      steps: config.steps
    });
  }

  registerDefaultTutorials() {
    // This method is a placeholder - tutorials are registered via tutorial-definitions.js
    // Check if tutorials have been registered
    if (this.tutorials.size === 0) {
      // Try to trigger tutorial registration
      /* global registerAllTutorials */
      if (typeof registerAllTutorials === "function") {
        try {
          registerAllTutorials();
        } catch (e) {
          console.error("Failed to register tutorials:", e);
        }
      }
    }
  }

  addKeyboardListeners() {
    document.addEventListener("keydown", (e) => {
      if (!this.isActive) return;
      
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          this.nextStep();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.previousStep();
          break;
        case "Escape":
          e.preventDefault();
          this.endTutorial();
          break;
      }
    });
  }
  
  // Setup periodic cleanup to remove stray elements
  setupPeriodicCleanup() {
    // Run cleanup every 30 seconds when tutorial is not active
    setInterval(() => {
      if (!this.isActive) {
        this.cleanupTutorialElements();
      }
    }, 30000); // 30 seconds
  }

  async startTutorial(tutorialId) {
    const tutorial = this.tutorials.get(tutorialId);
    if (!tutorial) {
      console.error(`Tutorial ${tutorialId} not found`);
      return;
    }

    this.currentTutorial = tutorial;
    this.currentStep = 0;
    this.isActive = true;

    // Create overlay and tooltip
    this.createOverlay();
    this.createTooltip();

    // Show first step
    await this.showStep(0);
  }

  createOverlay() {
    if (this.overlay) return;

    this.overlay = document.createElement("div");
    this.overlay.className = "tutorial-overlay";
    document.body.appendChild(this.overlay);

    // Faster activation
    requestAnimationFrame(() => {
      this.overlay.classList.add("active");
    });
  }

  createTooltip() {
    if (this.tooltip) return;

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tutorial-tooltip";
    document.body.appendChild(this.tooltip);
  }

  async showStep(stepIndex) {
    if (!this.currentTutorial || stepIndex >= this.currentTutorial.steps.length) {
      this.endTutorial();
      return;
    }

    this.currentStep = stepIndex;
    const step = this.currentTutorial.steps[stepIndex];

    // Execute before callback if exists
    if (step.before && typeof step.before === "function") {
      await step.before();
    }

    // Update spotlight
    this.updateSpotlight(step.target);

    // Update tooltip
    this.updateTooltip(step);

    // Position tooltip
    this.positionTooltip(step);

    // Show tooltip with faster timing
    requestAnimationFrame(() => {
      this.tooltip.classList.add("active");
    });
  }

  updateSpotlight(target) {
    // Remove old spotlight
    if (this.spotlight) {
      this.spotlight.remove();
    }

    if (!target) {
      this.spotlight = null;
      return;
    }

    // Get target element
    const element = typeof target === "string" ? document.querySelector(target) : target;
    if (!element) return;

    // Create spotlight
    this.spotlight = document.createElement("div");
    this.spotlight.className = "tutorial-spotlight";
    document.body.appendChild(this.spotlight);

    // Position spotlight
    const rect = element.getBoundingClientRect();
    const padding = 6;

    this.spotlight.style.top = `${rect.top - padding}px`;
    this.spotlight.style.left = `${rect.left - padding}px`;
    this.spotlight.style.width = `${rect.width + padding * 2}px`;
    this.spotlight.style.height = `${rect.height + padding * 2}px`;

    // Make target element clickable if needed
    element.style.position = "relative";
    element.style.zIndex = "10000";
  }

  updateTooltip(step) {
    const totalSteps = this.currentTutorial.steps.length;
    const currentStep = this.currentStep + 1;

    this.tooltip.innerHTML = `
      <div class="tutorial-tooltip-header">
        <div class="tutorial-tooltip-icon">${step.icon || "💡"}</div>
        <h3 class="tutorial-tooltip-title">${step.title}</h3>
      </div>
      <div class="tutorial-tooltip-body">
        <p>${step.content}</p>
        ${step.tip ? `
          <div class="tutorial-tip">
            <span class="tutorial-tip-icon">✨</span>
            <span>${step.tip}</span>
          </div>
        ` : ""}
      </div>
      <div class="tutorial-tooltip-footer">
        <div class="tutorial-progress">${currentStep} / ${totalSteps}</div>
        <div class="tutorial-actions">
          <button class="tutorial-btn tutorial-btn-skip" data-action="skip">
            Skip
          </button>
          <button class="tutorial-btn tutorial-btn-prev" 
                  data-action="prev"
                  ${this.currentStep === 0 ? "disabled" : ""}>
            Prev
          </button>
          <button class="tutorial-btn tutorial-btn-next" data-action="next">
            ${currentStep === totalSteps ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    `;
    
    // Add event listeners to the action buttons
    const skipBtn = this.tooltip.querySelector('[data-action="skip"]');
    const prevBtn = this.tooltip.querySelector('[data-action="prev"]');
    const nextBtn = this.tooltip.querySelector('[data-action="next"]');
    
    if (skipBtn) {
      skipBtn.addEventListener("click", () => this.endTutorial());
    }
    
    if (prevBtn) {
      prevBtn.addEventListener("click", () => this.previousStep());
    }
    
    if (nextBtn) {
      nextBtn.addEventListener("click", () => this.nextStep());
    }
  }

  positionTooltip(step) {
    if (!step.target) {
      // Center tooltip if no target
      this.tooltip.style.top = "50%";
      this.tooltip.style.left = "50%";
      this.tooltip.style.transform = "translate(-50%, -50%)";
      return;
    }

    const element = typeof step.target === "string" ? 
                    document.querySelector(step.target) : step.target;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const spacing = 15;

    let top, left;

    // Position based on preference
    switch (step.position || "bottom") {
      case "top":
        top = rect.top - tooltipRect.height - spacing;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        break;
      case "bottom":
        top = rect.bottom + spacing;
        left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        break;
      case "left":
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.left - tooltipRect.width - spacing;
        break;
      case "right":
        top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.right + spacing;
        break;
    }

    // Keep tooltip in viewport
    if (top < 10) top = 10;
    if (left < 10) left = 10;
    if (top + tooltipRect.height > window.innerHeight - 10) {
      top = window.innerHeight - tooltipRect.height - 10;
    }
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }

    this.tooltip.style.top = `${top}px`;
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.transform = "none";
  }

  async nextStep() {
    const step = this.currentTutorial.steps[this.currentStep];

    // Execute after callback if exists
    if (step.after && typeof step.after === "function") {
      await step.after();
    }

    this.tooltip.classList.remove("active");

    // Faster transition
    requestAnimationFrame(() => {
      if (this.currentStep >= this.currentTutorial.steps.length - 1) {
        this.endTutorial();
      } else {
        this.showStep(this.currentStep + 1);
      }
    });
  }

  previousStep() {
    if (this.currentStep <= 0) return;

    this.tooltip.classList.remove("active");

    // Faster transition
    requestAnimationFrame(() => {
      this.showStep(this.currentStep - 1);
    });
  }

  endTutorial() {
    // Mark as completed
    if (this.currentTutorial) {
      this.markCompleted(this.currentTutorial.id);
    }

    // Remove UI elements with enhanced cleanup
    if (this.overlay) {
      this.overlay.classList.remove("active");
      // Ensure overlay is removed from DOM
      setTimeout(() => {
        if (this.overlay && this.overlay.parentNode) {
          this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
      }, 200);
    }

    if (this.tooltip) {
      this.tooltip.classList.remove("active");
      // Ensure tooltip is removed from DOM
      setTimeout(() => {
        if (this.tooltip && this.tooltip.parentNode) {
          this.tooltip.parentNode.removeChild(this.tooltip);
        }
        this.tooltip = null;
      }, 200);
    }

    if (this.spotlight) {
      // Ensure spotlight is removed from DOM
      if (this.spotlight.parentNode) {
        this.spotlight.parentNode.removeChild(this.spotlight);
      }
      this.spotlight = null;
    }

    // Reset state
    this.currentTutorial = null;
    this.currentStep = 0;
    this.isActive = false;

    // Reset any modified z-indexes
    document.querySelectorAll('[style*="z-index: 10000"]').forEach(el => {
      el.style.zIndex = "";
    });
    
    // Additional cleanup for any remaining tutorial elements
    this.cleanupTutorialElements();
  }

  showTutorialMenu() {
    // Ensure tutorials are loaded before showing menu
    if (this.tutorials.size === 0) {
      // Try to register tutorials if not already done
      this.registerDefaultTutorials();
      
      // If still no tutorials, show error
      if (this.tutorials.size === 0) {
        return;
      }
    }
    
    const menu = document.createElement("div");
    menu.className = "tutorial-menu";
    
    // Build menu content safely
    let tutorialItemsHTML = "";
    Array.from(this.tutorials.values()).forEach(tutorial => {
      tutorialItemsHTML += `
        <div class="tutorial-menu-item" tabindex="0" data-tutorial-id="${tutorial.id}">
          <div class="tutorial-menu-item-icon">${tutorial.icon}</div>
          <div class="tutorial-menu-item-content">
            <h4 class="tutorial-menu-item-title">${tutorial.title}</h4>
            <p class="tutorial-menu-item-desc">${tutorial.description}</p>
          </div>
          ${this.hasCompleted(tutorial.id) ? '<span class="tutorial-menu-item-badge">✓ Completed</span>' : ""}
        </div>
      `;
    });
    
    menu.innerHTML = `
      <div class="tutorial-menu-header">
        <h2 class="tutorial-menu-title">📚 Tutorials</h2>
        <p class="tutorial-menu-subtitle">Learn how to use all features</p>
        <div class="tutorial-search-container">
          <i class="fas fa-search tutorial-search-icon"></i>
          <input type="text" class="tutorial-search-input" placeholder="Search tutorials..." id="tutorial-search">
        </div>
      </div>
      <div class="tutorial-menu-content" id="tutorial-menu-content">
        ${tutorialItemsHTML}
      </div>
      <div class="tutorial-menu-footer">
        <button class="tutorial-btn tutorial-btn-next" id="tutorial-close-btn">
          Close
        </button>
      </div>
    `;

    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = "tutorial-overlay";
    overlay.onclick = () => this.closeTutorialMenu();
    document.body.appendChild(overlay);

    document.body.appendChild(menu);

    // Add search functionality
    const searchInput = menu.querySelector("#tutorial-search");
    const menuContent = menu.querySelector("#tutorial-menu-content");
    
    searchInput.addEventListener("input", (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const tutorialItems = menuContent.querySelectorAll(".tutorial-menu-item");
      
      tutorialItems.forEach(item => {
        const title = item.querySelector(".tutorial-menu-item-title").textContent.toLowerCase();
        const description = item.querySelector(".tutorial-menu-item-desc").textContent.toLowerCase();
        
        if (title.includes(searchTerm) || description.includes(searchTerm)) {
          item.style.display = "flex";
        } else {
          item.style.display = "none";
        }
      });
    });

    // Add event listeners for tutorial items
    const tutorialItems = menu.querySelectorAll(".tutorial-menu-item");
    tutorialItems.forEach(item => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tutorialId = item.getAttribute("data-tutorial-id");
        if (tutorialId) {
          // Close the menu first, then start the tutorial
          this.closeTutorialMenu();
          // Use a small delay to ensure the menu is closed before starting tutorial
          setTimeout(() => {
            this.startTutorial(tutorialId);
          }, 100);
        }
      });
      
      // Also support Enter key for accessibility
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const tutorialId = item.getAttribute("data-tutorial-id");
          if (tutorialId) {
            // Close the menu first, then start the tutorial
            this.closeTutorialMenu();
            // Use a small delay to ensure the menu is closed before starting tutorial
            setTimeout(() => {
              this.startTutorial(tutorialId);
            }, 100);
          }
        }
      });
    });
    
    // Add event listener for close button
    const closeBtn = menu.querySelector("#tutorial-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        this.closeTutorialMenu();
      });
    }

    // Focus search input when menu opens
    setTimeout(() => {
      searchInput.focus();
    }, 50);

    // Faster activation
    requestAnimationFrame(() => {
      overlay.classList.add("active");
      menu.classList.add("active");
    });

    this.currentMenu = { menu, overlay, searchInput };
  }

  closeTutorialMenu() {
    if (!this.currentMenu) return;

    const { menu, overlay } = this.currentMenu;

    menu.classList.remove("active");
    overlay.classList.remove("active");

    setTimeout(() => {
      // Ensure menu and overlay are removed from DOM
      if (menu && menu.parentNode) {
        menu.parentNode.removeChild(menu);
      }
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 200);

    this.currentMenu = null;
    
    // Additional cleanup for any remaining tutorial elements
    this.cleanupTutorialElements();
  }
  
  // Additional cleanup method to ensure no tutorial elements remain
  cleanupTutorialElements() {
    // Remove any stray tutorial elements
    document.querySelectorAll(".tutorial-overlay, .tutorial-tooltip, .tutorial-spotlight, .tutorial-menu").forEach(el => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    });
    
    // Reset any remaining z-index modifications
    document.querySelectorAll('[style*="z-index"]').forEach(el => {
      if (el.style.zIndex && el.style.zIndex.includes("10000")) {
        el.style.zIndex = "";
      }
    });
    
    // Reset pointer events on body if accidentally set
    if (document.body.style.pointerEvents) {
      document.body.style.pointerEvents = "";
    }
  }

  createLauncher() {
    // Check if launcher already exists
    if (document.querySelector(".tutorial-launcher")) return;

    // Create launcher button
    const launcher = document.createElement("button");
    launcher.className = "tutorial-launcher";
    launcher.innerHTML = "🎓";
    launcher.title = "Tutorials & Help";
    
    // Ensure launcher doesn't block interactions
    launcher.style.pointerEvents = "auto";
    
    // Add click event to show tutorial menu
    launcher.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      this.showTutorialMenu();
    });

    // Add to document
    document.body.appendChild(launcher);
    
    // Ensure launcher is always visible and doesn't interfere
    setTimeout(() => {
      if (launcher && launcher.parentNode) {
        launcher.style.zIndex = "9997"; // Ensure proper z-index
        launcher.style.pointerEvents = "auto"; // Ensure clickable
      }
    }, 100);
  }
}

// Create global instance and expose it globally
const tutorialSystem = new TutorialSystem();

// Make tutorialSystem available to other scripts
if (typeof window !== "undefined") {
  window.tutorialSystem = tutorialSystem;
}
