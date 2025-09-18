
// Modal Optimizer - DISABLED
// This is a no-operation version to prevent loading errors

class ModalOptimizer {
  constructor() {
    console.log('Modal optimizer disabled - using original modal system');
  }
  
  initialize() {
    // No-op
  }
}

// Auto-initialize (but do nothing)
if (typeof window !== 'undefined') {
  window.modalOptimizer = new ModalOptimizer();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.modalOptimizer.initialize();
    });
  } else {
    window.modalOptimizer.initialize();
  }
}

// Export for module systems
if (typeof module !== 'undefined') {
  module.exports = ModalOptimizer;
}
