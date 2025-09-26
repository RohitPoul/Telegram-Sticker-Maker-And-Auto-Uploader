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
    const newKeys = newItems.map(keyFn);
    const existingKeys = existingItems.map((el, i) => el.dataset.key || i);
    
    // Find items to remove, add, and update
    const toRemove = [];
    const toAdd = [];
    const toUpdate = [];
    
    // Check existing items
    existingItems.forEach((el, index) => {
      const key = el.dataset.key || index;
      const newIndex = newKeys.indexOf(key);
      
      if (newIndex === -1) {
        toRemove.push(el);
      } else {
        toUpdate.push({ element: el, newItem: newItems[newIndex], newIndex });
      }
    });
    
    // Check for new items
    newItems.forEach((item, index) => {
      const key = keyFn(item, index);
      if (!existingKeys.includes(key)) {
        toAdd.push({ item, index, key });
      }
    });
    
    // Batch DOM operations
    this.batchRender(() => {
      // Remove old items
      toRemove.forEach(el => {
        el.style.transition = 'opacity 0.2s ease-out';
        el.style.opacity = '0';
        setTimeout(() => {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        }, 200);
      });
      
      // Update existing items
      toUpdate.forEach(({ element, newItem, newIndex }) => {
        const newContent = renderItem(newItem, newIndex);
        if (element.innerHTML !== newContent) {
          element.innerHTML = newContent;
        }
      });
      
      // Add new items
      toAdd.forEach(({ item, index, key }) => {
        const element = document.createElement('div');
        element.dataset.key = key;
        element.innerHTML = renderItem(item, index);
        element.style.opacity = '0';
        element.style.transition = 'opacity 0.2s ease-in';
        
        // Insert at correct position
        const referenceNode = container.children[index];
        if (referenceNode) {
          container.insertBefore(element, referenceNode);
        } else {
          container.appendChild(element);
        }
        
        // Fade in
        requestAnimationFrame(() => {
          element.style.opacity = '1';
        });
      });
    }, container);
  }

  // Optimized event handling (like React's SyntheticEvents)
  setupEventDelegation(container, eventType, selector, handler) {
    const delegatedHandler = (e) => {
      const target = e.target.closest(selector);
      if (target && container.contains(target)) {
        handler.call(target, e);
      }
    };
    
    container.addEventListener(eventType, delegatedHandler, {
      passive: eventType.startsWith('touch') || eventType === 'scroll'
    });
    
    return () => {
      container.removeEventListener(eventType, delegatedHandler);
    };
  }

  // Component lifecycle management
  createComponent(definition) {
    const component = {
      element: null,
      state: {},
      props: {},
      mounted: false,
      ...definition
    };
    
    // Add state management
    component.setState = (newState) => {
      const prevState = { ...component.state };
      component.state = { ...component.state, ...newState };
      
      // Only re-render if state actually changed
      if (JSON.stringify(prevState) !== JSON.stringify(component.state)) {
        this.batchRender(() => {
          if (component.render) {
            component.render();
          }
        }, component);
      }
    };
    
    // Add prop updates
    component.setProps = (newProps) => {
      const prevProps = { ...component.props };
      component.props = { ...component.props, ...newProps };
      
      // Only re-render if props actually changed
      if (JSON.stringify(prevProps) !== JSON.stringify(component.props)) {
        this.batchRender(() => {
          if (component.render) {
            component.render();
          }
        }, component);
      }
    };
    
    // Lifecycle methods
    component.mount = (container) => {
      if (component.beforeMount) {
        component.beforeMount();
      }
      
      component.element = container;
      component.mounted = true;
      
      if (component.render) {
        component.render();
      }
      
      if (component.afterMount) {
        component.afterMount();
      }
    };
    
    component.unmount = () => {
      if (component.beforeUnmount) {
        component.beforeUnmount();
      }
      
      component.mounted = false;
      
      if (component.afterUnmount) {
        component.afterUnmount();
      }
    };
    
    return component;
  }

  // Intersection Observer for lazy loading
  setupLazyLoading(elements, callback, options = {}) {
    const defaultOptions = {
      root: null,
      rootMargin: '50px',
      threshold: 0.1
    };
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          callback(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { ...defaultOptions, ...options });
    
    elements.forEach((el) => {
      observer.observe(el);
    });
    
    return observer;
  }

  // Memory leak prevention
  setupComponentCleanup() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Clean up component references
            if (node._component) {
              if (node._component.unmount) {
                node._component.unmount();
              }
              delete node._component;
            }
            
            // Clean up event listeners
            if (node._listeners) {
              node._listeners.forEach(({ event, handler }) => {
                node.removeEventListener(event, handler);
              });
              delete node._listeners;
            }
            
            // Clean up observers
            if (node._observers) {
              node._observers.forEach((observer) => {
                observer.disconnect();
              });
              delete node._observers;
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

  // Performance monitoring for components
  measureComponent(component, operation, fn) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    
    const duration = end - start;
    if (duration > 16) {
      console.warn(`Slow component ${operation}:`, {
        component: component.constructor.name || 'Anonymous',
        duration: `${duration.toFixed(2)}ms`
      });
    }
    
    return result;
  }

  setupOptimizations() {
    // Setup component cleanup
    this.setupComponentCleanup();
    
    // Add helper functions to window
    window.createOptimizedComponent = (definition) => this.createComponent(definition);
    window.updateOptimizedList = (container, items, render, key) => 
      this.updateList(container, items, render, key);
    window.updateVirtualList = (container, items, render, key, options) => 
      this.updateVirtualList(container, items, render, key, options);
    window.setupEventDelegation = (container, event, selector, handler) => 
      this.setupEventDelegation(container, event, selector, handler);
    window.setupLazyLoading = (elements, callback, options) => 
      this.setupLazyLoading(elements, callback, options);
  }

  initialize() {
    console.log('Component optimizer initialized - vanilla JS with React-like optimizations!');
  }
}

// Auto-initialize
if (typeof window !== 'undefined') {
  window.componentOptimizer = new ComponentOptimizer();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.componentOptimizer.initialize();
    });
  } else {
    window.componentOptimizer.initialize();
  }
}

// Export for module systems
if (typeof module !== 'undefined') {
  module.exports = ComponentOptimizer;
}