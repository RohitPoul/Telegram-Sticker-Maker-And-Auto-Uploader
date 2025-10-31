// Performance Optimizations Module
// This module contains GPU-optimized CSS and JavaScript utilities

class PerformanceOptimizer {
  constructor() {
    this.isGPUAccelerated = this.detectGPUAcceleration();
    this.setupOptimizedAnimations();
    this.initializeVirtualScrolling();
  }

  // Detect if GPU acceleration is available
  detectGPUAcceleration() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return gl && gl instanceof WebGLRenderingContext;
  }

  // Setup hardware-accelerated animations
  setupOptimizedAnimations() {
    // Add GPU-accelerated CSS classes to document head
    const style = document.createElement('style');
    style.textContent = `
      /* GPU-Accelerated Base Classes */
      .gpu-accelerated {
        transform: translateZ(0);
        will-change: transform, opacity;
        backface-visibility: hidden;
        perspective: 1000px;
      }

      .smooth-scroll {
        transform: translateZ(0);
        -webkit-overflow-scrolling: touch;
        will-change: scroll-position;
      }

      /* Modal Optimizations */
      .modal-gpu {
        transform: translateZ(0);
        will-change: transform, opacity;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                    opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .modal-gpu.show {
        transform: translateZ(0) scale(1);
        opacity: 1;
      }

      .modal-gpu.hide {
        transform: translateZ(0) scale(0.95);
        opacity: 0;
      }

      /* Button Optimizations */
      .btn-optimized {
        transform: translateZ(0);
        will-change: transform;
        transition: transform 0.15s ease-out;
      }

      .btn-optimized:hover {
        transform: translateZ(0) translateY(-1px);
      }

      .btn-optimized:active {
        transform: translateZ(0) translateY(0);
      }

      /* List Item Optimizations */
      .list-item-gpu {
        transform: translateZ(0);
        will-change: transform;
        contain: layout style paint;
      }

      /* Scrollbar Optimizations */
      .optimized-scrollbar::-webkit-scrollbar {
        width: 8px;
      }

      .optimized-scrollbar::-webkit-scrollbar-track {
        background: rgba(0,0,0,0.1);
        border-radius: 4px;
      }

      .optimized-scrollbar::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,0.3);
        border-radius: 4px;
        transition: background 0.2s ease;
      }

      .optimized-scrollbar::-webkit-scrollbar-thumb:hover {
        background: rgba(0,0,0,0.5);
      }

      /* Animation Optimization */
      @media (prefers-reduced-motion: reduce) {
        .gpu-accelerated,
        .modal-gpu,
        .btn-optimized {
          transition: none;
          animation: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Apply GPU acceleration to existing elements - SELECTIVE
  optimizeExistingElements() {
    // Only optimize elements that really need it - avoid over-optimization
    
    // Optimize buttons - but only primary action buttons
    const buttons = document.querySelectorAll('.btn-primary, .btn-success, .btn-danger');
    buttons.forEach(button => {
      button.classList.add('btn-optimized');
    });

    // Optimize scrollable areas - but check if they actually scroll
    const scrollAreas = document.querySelectorAll('[style*="overflow-y: auto"], .scrollable');
    scrollAreas.forEach(area => {
      if (area.scrollHeight > area.clientHeight) {
        area.classList.add('smooth-scroll', 'optimized-scrollbar');
      }
    });

    // Skip modal optimization - handled separately
    // Skip list optimization for now - can cause performance issues
    
  }

  // Debounced scroll optimization
  optimizeScrolling() {
    let ticking = false;

    function updateScrolling() {
      // Your scroll handling code here
      ticking = false;
    }

    function requestTick() {
      if (!ticking) {
        requestAnimationFrame(updateScrolling);
        ticking = true;
      }
    }

    // Replace existing scroll listeners with optimized version
    document.addEventListener('scroll', requestTick, { passive: true });
  }

  // Virtual scrolling for large lists
  initializeVirtualScrolling() {
    // Simple virtual scrolling implementation
    this.createVirtualScrollHelper();
  }

  createVirtualScrollHelper() {
    window.createVirtualList = function(container, items, itemHeight, renderItem) {
      const containerHeight = container.clientHeight;
      const visibleCount = Math.ceil(containerHeight / itemHeight) + 2; // Buffer
      let scrollTop = 0;
      let startIndex = 0;
      
      const viewport = document.createElement('div');
      viewport.style.height = `${items.length * itemHeight}px`;
      viewport.style.position = 'relative';
      viewport.classList.add('gpu-accelerated');
      
      const visibleItems = document.createElement('div');
      visibleItems.style.position = 'absolute';
      visibleItems.style.top = '0';
      visibleItems.style.width = '100%';
      visibleItems.classList.add('gpu-accelerated');
      
      viewport.appendChild(visibleItems);
      container.appendChild(viewport);
      
      function update() {
        const newStartIndex = Math.floor(scrollTop / itemHeight);
        const endIndex = Math.min(newStartIndex + visibleCount, items.length);
        
        if (newStartIndex !== startIndex) {
          startIndex = newStartIndex;
          
          // Clear existing items
          visibleItems.innerHTML = '';
          
          // Render visible items
          for (let i = startIndex; i < endIndex; i++) {
            const itemElement = renderItem(items[i], i);
            itemElement.style.position = 'absolute';
            itemElement.style.top = `${i * itemHeight}px`;
            itemElement.style.height = `${itemHeight}px`;
            itemElement.classList.add('list-item-gpu');
            visibleItems.appendChild(itemElement);
          }
        }
      }
      
      container.addEventListener('scroll', function(e) {
        scrollTop = e.target.scrollTop;
        requestAnimationFrame(update);
      }, { passive: true });
      
      update(); // Initial render
      
      return {
        update: update,
        setItems: function(newItems) {
          items = newItems;
          viewport.style.height = `${items.length * itemHeight}px`;
          update();
        }
      };
    };
  }

  // Frame rate monitoring - LIGHTWEIGHT VERSION
  monitorFrameRate() {
    let frames = 0;
    let lastTime = performance.now();
    
    function tick() {
      frames++;
      const currentTime = performance.now();
      
      if (currentTime - lastTime >= 5000) { // Check every 5 seconds instead of 1
        const fps = Math.round((frames * 1000) / (currentTime - lastTime));
        
        // Only warn for extremely low FPS and less frequently
        if (fps < 15) {
          // Silent - extremely low FPS detected
        }
        
        // Send FPS data to main process if available (less frequently)
        if (window.electronAPI && window.electronAPI.sendPerformanceData) {
          window.electronAPI.sendPerformanceData({
            type: 'fps',
            value: fps,
            timestamp: currentTime
          });
        }
        
        frames = 0;
        lastTime = currentTime;
      }
      
      // Use setTimeout instead of requestAnimationFrame to reduce overhead
      setTimeout(tick, 100); // Check 10 times per second instead of 60
    }
    
    setTimeout(tick, 1000); // Start after 1 second
  }

  // Memory cleanup utilities
  setupMemoryCleanup() {
    // Clean up event listeners when elements are removed
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Clean up any custom properties or listeners
            if (node._customListeners) {
              node._customListeners.forEach(({ event, handler }) => {
                node.removeEventListener(event, handler);
              });
            }
          }
        });
      });
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initialize all optimizations - LIGHTWEIGHT VERSION
  initialize() {
    // Only apply essential optimizations
    this.optimizeExistingElements();
    
    // Skip heavy monitoring that causes FPS drops
    // this.monitorFrameRate(); // DISABLED - causes performance issues
    
    this.setupMemoryCleanup();
    
  }
}

// Auto-initialize when loaded
if (typeof window !== 'undefined') {
  window.performanceOptimizer = new PerformanceOptimizer();
  // Initialize after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.performanceOptimizer.initialize();
    });
  } else {
    window.performanceOptimizer.initialize();
  }
}

// Export for module systems
if (typeof module !== 'undefined') {
  module.exports = PerformanceOptimizer;
}