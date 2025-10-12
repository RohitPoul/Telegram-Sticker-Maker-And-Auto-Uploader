class ComponentOptimizer {
  constructor() {
    this.componentCache = new Map();
    this.renderQueue = [];
    this.isRendering = false;
    this.observers = new Map();
    this.setupOptimizations();
  }

  // Memoization for expensive DOM operations
  memoize(fn, keyFn) {
    const cache = new Map();
    return (...args) => {
      const key = keyFn ? keyFn(...args) : JSON.stringify(args);
      
      if (cache.has(key)) {
        return cache.get(key);
      }
      
      const result = fn.apply(this, args);
      cache.set(key, result);
      
      // Limit cache size
      if (cache.size > 100) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      
      return result;
    };
  }

  // Debounced render function (like React's batching)
  batchRender(renderFn, component) {
    this.renderQueue.push({ renderFn, component });
    
    if (!this.isRendering) {
      this.isRendering = true;
      requestAnimationFrame(() => {
        this.flushRenderQueue();
      });
    }
  }

  flushRenderQueue() {
    const startTime = performance.now();
    
    // Group renders by component to avoid duplicate work
    const componentRenders = new Map();
    
    this.renderQueue.forEach(({ renderFn, component }) => {
      if (!componentRenders.has(component)) {
        componentRenders.set(component, []);
      }
      componentRenders.get(component).push(renderFn);
    });
    
    // Execute batched renders
    componentRenders.forEach((renders, component) => {
      // Only execute the last render for each component
      const lastRender = renders[renders.length - 1];
      lastRender();
    });
    
    this.renderQueue = [];
    this.isRendering = false;
    
    const endTime = performance.now();
    if (endTime - startTime > 16) {
      console.warn(`Slow batch render: ${(endTime - startTime).toFixed(2)}ms`);
    }
  }

  // Virtual DOM-like diff for lists with virtualization
  updateVirtualList(container, newItems, renderItem, keyFn = (item, index) => index, options = {}) {
    const {
      itemHeight = 100, // Increased default height for media items
      bufferSize = 10,   // Buffer for smoother scrolling
      scrollTop = container.scrollTop || 0,
      containerHeight = container.clientHeight || 300
    } = options;

    // Prepare container for virtual scrolling
    container.style.overflowY = 'auto';
    container.style.overflowX = 'hidden';

    // Auto-measure item height if requested or not yet measured
    if (options.autoMeasure || (!container._virtualItemHeight && newItems && newItems.length > 0)) {
      try {
        const probeWrapper = document.createElement('div');
        probeWrapper.style.position = 'absolute';
        probeWrapper.style.visibility = 'hidden';
        probeWrapper.style.pointerEvents = 'none';
        probeWrapper.style.left = '-99999px';
        probeWrapper.style.top = '0';
        probeWrapper.style.width = `${Math.max(container.clientWidth, 300)}px`;

        const probeContent = document.createElement('div');
        const probeRendered = renderItem(newItems[0], 0);
        if (probeRendered instanceof Node) {
          probeContent.appendChild(probeRendered.cloneNode(true));
        } else {
          probeContent.innerHTML = String(probeRendered);
        }
        probeWrapper.appendChild(probeContent);
        document.body.appendChild(probeWrapper);
        const measured = Math.max(1, probeWrapper.offsetHeight || probeContent.offsetHeight || itemHeight);
        document.body.removeChild(probeWrapper);
        container._virtualItemHeight = measured;
      } catch (e) {
        container._virtualItemHeight = itemHeight;
      }
    }

    const effectiveItemHeight = Math.max(1, container._virtualItemHeight || itemHeight);

    // Ensure a single inner spacer element to position absolutely placed children
    let spacer = container._virtualSpacer;
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.style.position = 'relative';
      spacer.style.width = '100%';
      spacer.className = 'virtual-spacer';
      container._virtualSpacer = spacer;
      // Clear container and mount spacer once
      while (container.firstChild) container.removeChild(container.firstChild);
      container.appendChild(spacer);
    }

    // Calculate total height on spacer (not on container)
    const totalHeight = newItems.length * effectiveItemHeight;
    spacer.style.height = `${totalHeight}px`;
    
    // Calculate visible range with proper bounds checking
    const startIndex = Math.max(0, Math.floor(scrollTop / effectiveItemHeight) - bufferSize);
    const endIndex = Math.min(
      newItems.length - 1,
      Math.floor((scrollTop + containerHeight) / effectiveItemHeight) + bufferSize
    );
    
    // Clear existing visible children of spacer
    while (spacer.firstChild) spacer.removeChild(spacer.firstChild);
    
    // Create visible items with proper spacing
    const visibleItems = [];
    for (let i = startIndex; i <= endIndex; i++) {
      if (newItems[i]) {
        visibleItems.push({
          index: i,
          item: newItems[i],
          top: i * effectiveItemHeight
        });
      }
    }
    
    // Create visible elements with proper positioning
    visibleItems.forEach(({ index, item, top }) => {
      const element = document.createElement('div');
      element.dataset.key = keyFn(item, index);
      element.dataset.index = index;
      element.style.position = 'absolute';
      element.style.top = `${top}px`;
      element.style.left = '0';
      element.style.width = '100%';
      element.style.height = `${effectiveItemHeight}px`;
      element.style.boxSizing = 'border-box';
      element.style.zIndex = '1';
      
      // Support both HTML strings and real DOM nodes from renderItem
      const rendered = renderItem(item, index);
      if (rendered instanceof Node) {
        element.appendChild(rendered);
      } else {
        element.innerHTML = String(rendered);
      }
      
      spacer.appendChild(element);
    });
    
    // Add scroll event listener for virtualization
    if (!container._virtualScrollHandler) {
      container._virtualScrollHandler = () => {
        if (container._scrollTimeout) {
          clearTimeout(container._scrollTimeout);
        }
        container._scrollTimeout = setTimeout(() => {
          this.updateVirtualList(container, newItems, renderItem, keyFn, {
            ...options,
            scrollTop: container.scrollTop,
            containerHeight: container.clientHeight
          });
        }, 16); // 60fps
      };
      container.addEventListener('scroll', container._virtualScrollHandler);
    }
  }

  // Virtual DOM-like diff for lists (existing implementation)
  updateList(container, newItems, renderItem, keyFn = (item, index) => index) {
    const existingItems = Array.from(container.children);
    
    // Create a map of existing items by key for efficient lookup
    const existingMap = new Map();
    existingItems.forEach((item, index) => {
      const key = item.dataset.key || keyFn(null, index);
      existingMap.set(key, { element: item, index });
    });
    
    // Create a map of new items by key
    const newMap = new Map();
    newItems.forEach((item, index) => {
      const key = keyFn(item, index);
      newMap.set(key, { item, index });
    });
    
    // Remove items that are no longer in the list
    existingMap.forEach(({ element, index }, key) => {
      if (!newMap.has(key)) {
        container.removeChild(element);
      }
    });
    
    // Update or add items
    newItems.forEach((item, index) => {
      const key = keyFn(item, index);
      const existing = existingMap.get(key);
      
      if (existing) {
        // Update existing item
        const newElement = renderItem(item, index);
        if (newElement instanceof Node) {
          // Replace the content
          existing.element.innerHTML = '';
          existing.element.appendChild(newElement);
        } else {
          existing.element.innerHTML = String(newElement);
        }
        existing.element.dataset.index = index;
      } else {
        // Add new item
        const element = document.createElement('div');
        element.dataset.key = key;
        element.dataset.index = index;
        
        const rendered = renderItem(item, index);
        if (rendered instanceof Node) {
          element.appendChild(rendered);
        } else {
          element.innerHTML = String(rendered);
        }
        
        container.appendChild(element);
      }
    });
  }

  // Optimized DOM updates with requestAnimationFrame
  scheduleUpdate(fn) {
    if (!this.updateScheduled) {
      this.updateScheduled = true;
      requestAnimationFrame(() => {
        fn();
        this.updateScheduled = false;
      });
    }
  }

  // Setup performance optimizations
  setupOptimizations() {
    // Throttle scroll events
    window.addEventListener('scroll', this.throttle((e) => {
      // Handle scroll events for performance
    }, 16), { passive: true });

    // Throttle resize events
    window.addEventListener('resize', this.throttle((e) => {
      // Handle resize events for performance
    }, 100), { passive: true });
  }

  // Utility function for throttling
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

  // Utility function for debouncing
  debounce(func, wait, immediate) {
    let timeout;
    return function() {
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
}