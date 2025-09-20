/**
 * Performance Turbo Module - Comprehensive Performance Optimization
 * Addresses the lag and performance issues identified in profiler data
 */

class PerformanceTurbo {
  constructor() {
    this.isInitialized = false;
    this.rafId = null;
    this.scrollTicking = false;
    this.resizeTicking = false;
    this.observers = new Map();
    this.eventHandlers = new Map();
    
    // Performance monitoring
    this.performanceMetrics = {
      frameTime: [],
      lastFrameTime: 0,
      fps: 60
    };
    
    this.init();
  }

  init() {
    if (this.isInitialized) return;
    
    console.log('🚀 [TURBO] Initializing Performance Turbo...');
    
    // 1. Optimize CSS and DOM
    this.optimizeCSS();
    
    // 2. Implement efficient scroll handling
    this.optimizeScrolling();
    
    // 3. Optimize modal animations
    this.optimizeModals();
    
    // 4. Implement smart repainting
    this.optimizeRepainting();
    
    // 5. Optimize event handlers
    this.optimizeEventHandlers();
    
    // 6. Implement virtual scrolling for large lists
    this.implementVirtualScrolling();
    
    // 7. Optimize GPU acceleration
    this.optimizeGPUAcceleration();
    
    this.isInitialized = true;
    console.log('✅ [TURBO] Performance optimization complete!');
  }

  optimizeCSS() {
    console.log('🔧 [TURBO] Optimizing CSS...');
    
    // Inject high-performance CSS
    const styleElement = document.createElement('style');
    styleElement.id = 'performance-turbo-styles';
    styleElement.textContent = `
      /* TURBO: Remove unnecessary GPU layers */
      * {
        -webkit-transform: none !important;
        transform: none !important;
      }

      /* TURBO: Optimize only interactive elements */
      .btn, .modal, .form-control:focus, .nav-item:hover {
        will-change: transform, opacity;
        transform: translateZ(0);
      }

      /* TURBO: High-performance animations */
      .modal-overlay.active {
        animation: turboFadeIn 0.1s linear !important;
      }

      .modal {
        animation: turboSlideIn 0.12s cubic-bezier(0.2, 0, 0.2, 1) !important;
      }

      @keyframes turboFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes turboSlideIn {
        from { transform: translate3d(0, -10px, 0); opacity: 0; }
        to { transform: translate3d(0, 0, 0); opacity: 1; }
      }

      /* TURBO: Optimize scrolling containers */
      .media-files-list, .status-content, .tab-content {
        contain: layout style paint;
        overflow-anchor: none;
        -webkit-overflow-scrolling: touch;
        scroll-behavior: auto !important;
      }

      /* TURBO: Prevent layout thrashing */
      .toast {
        position: fixed;
        contain: layout style paint;
        pointer-events: auto;
      }

      /* TURBO: Optimize button interactions */
      .btn {
        contain: layout style;
        transition: background-color 0.08s linear, transform 0.08s linear !important;
      }

      .btn:hover {
        transform: translateY(-1px) translateZ(0);
      }

      .btn:active {
        transform: translateY(0) translateZ(0);
      }

      /* TURBO: Smooth scroll optimization */
      .scrollable {
        scroll-snap-type: y proximity;
        overscroll-behavior: contain;
      }

      /* TURBO: Remove heavy effects on performance-critical elements */
      .modal-overlay {
        backdrop-filter: none !important;
        background: rgba(0, 0, 0, 0.8) !important;
      }

      /* TURBO: Optimize animations for 60fps */
      @media (prefers-reduced-motion: no-preference) {
        * {
          animation-duration: 0.1s !important;
          transition-duration: 0.1s !important;
        }
        
        .status-item {
          animation: none !important;
        }
      }
    `;
    
    document.head.appendChild(styleElement);
  }

  optimizeScrolling() {
    console.log('📜 [TURBO] Optimizing scroll performance...');
    
    // Debounced scroll handler
    const optimizedScrollHandler = this.debounce((e) => {
      if (!this.scrollTicking) {
        requestAnimationFrame(() => {
          // Minimal scroll processing
          this.handleScroll(e);
          this.scrollTicking = false;
        });
        this.scrollTicking = true;
      }
    }, 8); // ~120fps limit

    // Apply to all scrollable containers
    const scrollContainers = document.querySelectorAll('.media-files-list, .status-content, .tab-content');
    scrollContainers.forEach(container => {
      container.addEventListener('scroll', optimizedScrollHandler, { passive: true });
      container.classList.add('scrollable');
    });
  }

  optimizeModals() {
    console.log('🪟 [TURBO] Optimizing modal performance...');
    
    // Override modal show/hide with high-performance versions
    const originalShowMethods = new Map();
    
    // Enhanced modal visibility handling
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const target = mutation.target;
          if (target.classList.contains('modal-overlay')) {
            this.optimizeModalVisibility(target);
          }
        }
      });
    });

    // Watch for modal changes
    document.addEventListener('DOMNodeInserted', (e) => {
      if (e.target.classList && e.target.classList.contains('modal-overlay')) {
        observer.observe(e.target, { attributes: true, attributeFilter: ['style', 'class'] });
        this.optimizeModalElement(e.target);
      }
    }, true);
  }

  optimizeModalElement(modalElement) {
    // Force GPU acceleration only when visible
    modalElement.style.willChange = 'auto';
    modalElement.style.contain = 'layout style paint';
    
    // Optimize modal content
    const modal = modalElement.querySelector('.modal');
    if (modal) {
      modal.style.contain = 'layout style paint';
      modal.style.willChange = 'auto';
    }
  }

  optimizeModalVisibility(modalElement) {
    const isVisible = modalElement.style.display !== 'none' && 
                     modalElement.classList.contains('active');
    
    if (isVisible) {
      modalElement.style.willChange = 'opacity';
      // Remove GPU acceleration after animation
      setTimeout(() => {
        modalElement.style.willChange = 'auto';
      }, 150);
    } else {
      modalElement.style.willChange = 'auto';
    }
  }

  optimizeRepainting() {
    console.log('🎨 [TURBO] Optimizing repainting...');
    
    // Batch DOM updates
    this.batchedUpdates = [];
    this.updateScheduled = false;
    
    this.scheduleUpdate = () => {
      if (!this.updateScheduled) {
        this.updateScheduled = true;
        requestAnimationFrame(() => {
          this.flushUpdates();
          this.updateScheduled = false;
        });
      }
    };
  }

  flushUpdates() {
    const updates = this.batchedUpdates.splice(0);
    
    // Group updates by element to minimize reflows
    const updatesByElement = new Map();
    updates.forEach(update => {
      if (!updatesByElement.has(update.element)) {
        updatesByElement.set(update.element, []);
      }
      updatesByElement.get(update.element).push(update);
    });
    
    // Apply all updates for each element at once
    updatesByElement.forEach((elementUpdates, element) => {
      elementUpdates.forEach(update => update.fn());
    });
  }

  optimizeEventHandlers() {
    console.log('⚡ [TURBO] Optimizing event handlers...');
    
    // Debounced resize handler
    const optimizedResizeHandler = this.debounce(() => {
      if (!this.resizeTicking) {
        requestAnimationFrame(() => {
          this.handleResize();
          this.resizeTicking = false;
        });
        this.resizeTicking = true;
      }
    }, 16); // 60fps

    window.addEventListener('resize', optimizedResizeHandler, { passive: true });
    
    // Optimize click handlers with event delegation
    document.addEventListener('click', this.handleDelegatedClick.bind(this), { passive: false });
  }

  handleDelegatedClick(e) {
    // Fast path for common button clicks
    if (e.target.classList.contains('btn')) {
      this.optimizeButtonClick(e.target);
    }
  }

  optimizeButtonClick(button) {
    // Immediate visual feedback
    button.style.transform = 'translateY(1px) translateZ(0)';
    
    // Reset after short delay
    requestAnimationFrame(() => {
      button.style.transform = '';
    });
  }

  implementVirtualScrolling() {
    console.log('📋 [TURBO] Implementing virtual scrolling...');
    
    const listContainers = document.querySelectorAll('.media-files-list, .status-list');
    
    listContainers.forEach(container => {
      this.enableVirtualScrolling(container);
    });
  }

  enableVirtualScrolling(container) {
    const items = Array.from(container.children);
    if (items.length < 20) return; // Only virtualize large lists
    
    const itemHeight = items[0]?.offsetHeight || 60;
    const visibleCount = Math.ceil(container.offsetHeight / itemHeight) + 2; // Buffer
    
    let startIndex = 0;
    let endIndex = Math.min(visibleCount, items.length);
    
    const updateVisibleItems = () => {
      const scrollTop = container.scrollTop;
      startIndex = Math.floor(scrollTop / itemHeight);
      endIndex = Math.min(startIndex + visibleCount, items.length);
      
      // Hide items outside visible range
      items.forEach((item, index) => {
        if (index < startIndex || index >= endIndex) {
          item.style.display = 'none';
        } else {
          item.style.display = '';
        }
      });
    };
    
    const throttledUpdate = this.throttle(updateVisibleItems, 8); // ~120fps
    container.addEventListener('scroll', throttledUpdate, { passive: true });
    
    // Initial update
    updateVisibleItems();
  }

  optimizeGPUAcceleration() {
    console.log('🎮 [TURBO] Optimizing GPU acceleration...');
    
    // Smart GPU layer management
    const interactiveElements = document.querySelectorAll('.btn, .modal, .nav-item');
    
    interactiveElements.forEach(element => {
      this.setupSmartGPUAcceleration(element);
    });
  }

  setupSmartGPUAcceleration(element) {
    let isActive = false;
    
    const enableGPU = () => {
      if (!isActive) {
        element.style.willChange = 'transform, opacity';
        element.style.transform = 'translateZ(0)';
        isActive = true;
      }
    };
    
    const disableGPU = () => {
      if (isActive) {
        element.style.willChange = 'auto';
        element.style.transform = '';
        isActive = false;
      }
    };
    
    // Enable GPU acceleration on interaction
    element.addEventListener('mouseenter', enableGPU, { passive: true });
    element.addEventListener('focus', enableGPU, { passive: true });
    
    // Disable after interaction
    element.addEventListener('mouseleave', () => {
      setTimeout(disableGPU, 100);
    }, { passive: true });
    element.addEventListener('blur', () => {
      setTimeout(disableGPU, 100);
    }, { passive: true });
  }

  handleScroll(e) {
    // Minimal scroll processing to prevent blocking
    const container = e.target;
    const scrollPercent = container.scrollTop / (container.scrollHeight - container.offsetHeight);
    
    // Only update scroll indicators if needed
    if (Math.abs(scrollPercent - (container._lastScrollPercent || 0)) > 0.01) {
      container._lastScrollPercent = scrollPercent;
      this.updateScrollIndicators(container, scrollPercent);
    }
  }

  updateScrollIndicators(container, scrollPercent) {
    // Batched update for scroll indicators
    this.batchedUpdates.push({
      element: container,
      fn: () => {
        const indicator = container.querySelector('.scroll-indicator');
        if (indicator) {
          indicator.style.transform = `translateY(${scrollPercent * 100}%)`;
        }
      }
    });
    this.scheduleUpdate();
  }

  handleResize() {
    // Efficient resize handling
    const containers = document.querySelectorAll('.scrollable');
    containers.forEach(container => {
      if (container._virtualScrollEnabled) {
        this.updateVirtualScrolling(container);
      }
    });
  }

  // Utility functions
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }

  // Performance monitoring
  startPerformanceMonitoring() {
    const monitor = () => {
      const now = performance.now();
      const frameTime = now - this.performanceMetrics.lastFrameTime;
      
      this.performanceMetrics.frameTime.push(frameTime);
      if (this.performanceMetrics.frameTime.length > 60) {
        this.performanceMetrics.frameTime.shift();
      }
      
      // Calculate average FPS
      const avgFrameTime = this.performanceMetrics.frameTime.reduce((a, b) => a + b, 0) / this.performanceMetrics.frameTime.length;
      this.performanceMetrics.fps = Math.round(1000 / avgFrameTime);
      
      this.performanceMetrics.lastFrameTime = now;
      
      // Update performance display if available
      const fpsDisplay = document.querySelector('.fps-display');
      if (fpsDisplay) {
        fpsDisplay.textContent = `${this.performanceMetrics.fps} FPS`;
      }
      
      this.rafId = requestAnimationFrame(monitor);
    };
    
    this.rafId = requestAnimationFrame(monitor);
  }

  stopPerformanceMonitoring() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // Cleanup
  destroy() {
    this.stopPerformanceMonitoring();
    
    // Remove event listeners
    this.eventHandlers.forEach((handler, element) => {
      element.removeEventListener('scroll', handler);
    });
    
    // Remove performance styles
    const performanceStyles = document.getElementById('performance-turbo-styles');
    if (performanceStyles) {
      performanceStyles.remove();
    }
    
    this.isInitialized = false;
    console.log('🧹 [TURBO] Performance optimization cleaned up');
  }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.performanceTurbo = new PerformanceTurbo();
  });
} else {
  window.performanceTurbo = new PerformanceTurbo();
}

export default PerformanceTurbo;