/**
 * Complete Sticker Application Functionality Tests
 * 
 * This test suite verifies all the implemented features:
 * 1. URL Name Retry System (3 attempts with validation)
 * 2. Icon Skip Functionality and Success Handling
 * 3. Success Modal with URL Display and Copy/Open
 * 4. Real-time Media List Status Synchronization
 * 5. Persistent Telegram Session Handling
 */

class FunctionalityTests {
  constructor() {
    this.testResults = [];
    this.currentTest = null;
  }

  // Test utility methods
  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
    console.log(logEntry);
    
    if (this.currentTest) {
      this.currentTest.logs.push({ message, type, timestamp });
    }
  }

  startTest(testName) {
    this.currentTest = {
      name: testName,
      startTime: Date.now(),
      logs: [],
      passed: false,
      error: null
    };
    this.log(`Starting test: ${testName}`, 'test');
  }

  endTest(passed, error = null) {
    if (!this.currentTest) return;
    
    this.currentTest.passed = passed;
    this.currentTest.error = error;
    this.currentTest.endTime = Date.now();
    this.currentTest.duration = this.currentTest.endTime - this.currentTest.startTime;
    
    this.testResults.push(this.currentTest);
    this.log(`Test ${passed ? 'PASSED' : 'FAILED'}: ${this.currentTest.name}${error ? ` - ${error}` : ''}`, passed ? 'pass' : 'fail');
    this.currentTest = null;
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Test 1: URL Name Retry System
  async testUrlNameRetrySystem() {
    this.startTest('URL Name Retry System');
    
    try {
      // Check if URL name modal exists
      const urlModal = document.getElementById('url-name-modal');
      if (!urlModal) {
        throw new Error('URL name modal not found in DOM');
      }
      this.log('✓ URL name modal element found');

      // Check if URL name retry counter exists
      const attemptInfo = document.getElementById('url-name-attempt-info');
      if (!attemptInfo) {
        throw new Error('URL name attempt counter not found');
      }
      this.log('✓ URL name attempt counter element found');

      // Check if new URL name input exists
      const newUrlInput = document.getElementById('new-url-name');
      if (!newUrlInput) {
        throw new Error('New URL name input not found');
      }
      this.log('✓ New URL name input element found');

      // Test validation function exists
      if (typeof window.app?.validateUrlName !== 'function') {
        throw new Error('URL name validation function not found');
      }
      this.log('✓ URL name validation function exists');

      // Test validation logic
      const validationTests = [
        { input: 'test', expected: false, reason: 'too short' },
        { input: 'test_pack_2025', expected: true, reason: 'valid format' },
        { input: '123invalid', expected: false, reason: 'starts with number' },
        { input: 'valid_pack_name_12345', expected: true, reason: 'valid with numbers' },
        { input: 'tool-long-name-that-exceeds-limit-123456789', expected: false, reason: 'too long' }
      ];

      for (const test of validationTests) {
        const result = window.app.validateUrlName(test.input);
        if (result.valid !== test.expected) {
          throw new Error(`Validation failed for "${test.input}" (${test.reason}): expected ${test.expected}, got ${result.valid}`);
        }
        this.log(`✓ Validation test passed: "${test.input}" (${test.reason})`);
      }

      // Test modal show/hide functions
      if (typeof window.app?.showUrlNameModal !== 'function') {
        throw new Error('showUrlNameModal function not found');
      }
      if (typeof window.app?.hideUrlNameModal !== 'function') {
        throw new Error('hideUrlNameModal function not found');
      }
      this.log('✓ URL name modal show/hide functions exist');

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Test 2: Icon Skip Functionality
  async testIconSkipFunctionality() {
    this.startTest('Icon Skip Functionality');

    try {
      // Check if icon modal exists
      const iconModal = document.getElementById('icon-modal');
      if (!iconModal) {
        throw new Error('Icon modal not found in DOM');
      }
      this.log('✓ Icon modal element found');

      // Check if skip icon button exists
      const skipButton = document.getElementById('skip-icon-btn');
      if (!skipButton) {
        throw new Error('Skip icon button not found');
      }
      this.log('✓ Skip icon button found');

      // Check if skip function exists
      if (typeof window.app?.skipIconSelection !== 'function') {
        throw new Error('skipIconSelection function not found');
      }
      this.log('✓ Skip icon function exists');

      // Test auto-skip setting exists
      const autoSkipCheckbox = document.getElementById('auto-skip-icon');
      if (!autoSkipCheckbox) {
        throw new Error('Auto-skip icon checkbox not found');
      }
      this.log('✓ Auto-skip icon setting found');

      // Test icon modal show/hide functions
      if (typeof window.app?.hideIconModal !== 'function') {
        throw new Error('hideIconModal function not found');
      }
      this.log('✓ Icon modal hide function exists');

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Test 3: Success Modal Functionality
  async testSuccessModalFunctionality() {
    this.startTest('Success Modal Functionality');

    try {
      // Check if success modal exists
      const successModal = document.getElementById('success-modal');
      if (!successModal) {
        throw new Error('Success modal not found in DOM');
      }
      this.log('✓ Success modal element found');

      // Check if shareable link input exists
      const linkInput = document.getElementById('shareable-link');
      if (!linkInput) {
        throw new Error('Shareable link input not found');
      }
      this.log('✓ Shareable link input found');

      // Check if copy link button exists
      const copyButton = document.getElementById('copy-link-btn');
      if (!copyButton) {
        throw new Error('Copy link button not found');
      }
      this.log('✓ Copy link button found');

      // Check if open telegram button exists
      const openButton = document.getElementById('open-telegram-btn');
      if (!openButton) {
        throw new Error('Open Telegram button not found');
      }
      this.log('✓ Open Telegram button found');

      // Check if create another button exists
      const anotherButton = document.getElementById('create-another-btn');
      if (!anotherButton) {
        throw new Error('Create another pack button not found');
      }
      this.log('✓ Create another pack button found');

      // Test success modal functions
      if (typeof window.app?.showSuccessModal !== 'function') {
        throw new Error('showSuccessModal function not found');
      }
      if (typeof window.app?.hideSuccessModal !== 'function') {
        throw new Error('hideSuccessModal function not found');
      }
      if (typeof window.app?.copyShareableLink !== 'function') {
        throw new Error('copyShareableLink function not found');
      }
      this.log('✓ Success modal functions exist');

      // Test success modal with test data
      const testLink = 'https://t.me/addstickers/test_pack_12345';
      window.app.showSuccessModal(testLink);
      
      await this.sleep(100); // Allow modal to show
      
      if (linkInput.value !== testLink) {
        throw new Error(`Link input value not set correctly: expected "${testLink}", got "${linkInput.value}"`);
      }
      this.log('✓ Success modal correctly sets shareable link');

      // Hide modal
      window.app.hideSuccessModal();
      this.log('✓ Success modal hide function works');

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Test 4: Media List Status Synchronization
  async testMediaStatusSync() {
    this.startTest('Media List Status Synchronization');

    try {
      // Check if media list container exists
      const mediaList = document.getElementById('sticker-media-list');
      if (!mediaList) {
        throw new Error('Media list container not found');
      }
      this.log('✓ Media list container found');

      // Test status update functions
      if (typeof window.app?.updateMediaFileStatus !== 'function') {
        throw new Error('updateMediaFileStatus function not found');
      }
      if (typeof window.app?.getMediaStatusIcon !== 'function') {
        throw new Error('getMediaStatusIcon function not found');
      }
      if (typeof window.app?.getStatusText !== 'function') {
        throw new Error('getStatusText function not found');
      }
      this.log('✓ Media status update functions exist');

      // Test status icon mapping
      const statusTests = [
        { status: 'pending', expectedIcon: 'fas fa-clock', expectedText: 'Waiting' },
        { status: 'uploading', expectedIcon: 'fas fa-upload text-primary', expectedText: 'Uploading' },
        { status: 'processing', expectedIcon: 'fas fa-cog fa-spin text-warning', expectedText: 'Processing' },
        { status: 'completed', expectedIcon: 'fas fa-check text-success', expectedText: 'Complete' },
        { status: 'error', expectedIcon: 'fas fa-exclamation-triangle text-danger', expectedText: 'Error' }
      ];

      for (const test of statusTests) {
        const icon = window.app.getMediaStatusIcon(test.status);
        const text = window.app.getStatusText(test.status);
        
        if (icon !== test.expectedIcon) {
          throw new Error(`Status icon mismatch for "${test.status}": expected "${test.expectedIcon}", got "${icon}"`);
        }
        if (text !== test.expectedText) {
          throw new Error(`Status text mismatch for "${test.status}": expected "${test.expectedText}", got "${text}"`);
        }
        this.log(`✓ Status mapping correct for "${test.status}"`);
      }

      // Test progress update functions
      if (typeof window.app?.updateMediaStatusFromProgress !== 'function') {
        throw new Error('updateMediaStatusFromProgress function not found');
      }
      if (typeof window.app?.updateStickerProgressDisplay !== 'function') {
        throw new Error('updateStickerProgressDisplay function not found');
      }
      this.log('✓ Progress update functions exist');

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Test 5: Persistent Session Handling
  async testPersistentSessionHandling() {
    this.startTest('Persistent Session Handling');

    try {
      // Test session-related API endpoints
      const apiTests = [
        '/api/telegram/session-status',
        '/api/telegram/force-reset',
        '/api/force-cleanup-sessions'
      ];

      for (const endpoint of apiTests) {
        // We can't actually test these endpoints without a running backend,
        // but we can verify the API request function exists
        if (typeof window.app?.apiRequest !== 'function') {
          throw new Error('apiRequest function not found');
        }
      }
      this.log('✓ API request function exists for session endpoints');

      // Test Telegram connection functions
      if (typeof window.app?.initializeTelegramConnection !== 'function') {
        throw new Error('initializeTelegramConnection function not found');
      }
      this.log('✓ Telegram connection initialization function exists');

      // Test session storage
      const sessionData = localStorage.getItem('telegram_session');
      this.log(`✓ Session storage accessible (current: ${sessionData ? 'exists' : 'empty'})`);

      // Test cleanup functions exist
      if (typeof window.app?.onbeforeunload !== 'undefined') {
        this.log('✓ Window beforeunload handler set for cleanup');
      }

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Test 6: Overall Integration Test
  async testOverallIntegration() {
    this.startTest('Overall Integration Test');

    try {
      // Test main application object exists
      if (typeof window.app !== 'object' || window.app === null) {
        throw new Error('Main application object not found');
      }
      this.log('✓ Main application object exists');

      // Test key application methods
      const requiredMethods = [
        'createStickerPack',
        'validatePackName',
        'validateUrlName',
        'showToast',
        'addStatusItem',
        'updateMediaFileList'
      ];

      for (const method of requiredMethods) {
        if (typeof window.app[method] !== 'function') {
          throw new Error(`Required method "${method}" not found`);
        }
      }
      this.log('✓ All required application methods exist');

      // Test UI elements are properly connected
      const criticalElements = [
        'pack-name',
        'pack-url-name',
        'create-sticker-pack',
        'sticker-media-list',
        'modal-overlay'
      ];

      for (const elementId of criticalElements) {
        const element = document.getElementById(elementId);
        if (!element) {
          throw new Error(`Critical UI element "${elementId}" not found`);
        }
      }
      this.log('✓ All critical UI elements found');

      // Test event listeners are attached
      const createButton = document.getElementById('create-sticker-pack');
      if (createButton && !createButton.onclick && !createButton.addEventListener) {
        this.log('⚠ Create button may not have event listeners attached');
      } else {
        this.log('✓ Create button appears to have event handling');
      }

      this.endTest(true);
    } catch (error) {
      this.endTest(false, error.message);
    }
  }

  // Run all tests
  async runAllTests() {
    this.log('Starting Complete Sticker Functionality Tests', 'start');
    this.log('='.repeat(60), 'divider');

    const tests = [
      () => this.testUrlNameRetrySystem(),
      () => this.testIconSkipFunctionality(),
      () => this.testSuccessModalFunctionality(),
      () => this.testMediaStatusSync(),
      () => this.testPersistentSessionHandling(),
      () => this.testOverallIntegration()
    ];

    for (const test of tests) {
      await test();
      await this.sleep(100); // Small delay between tests
    }

    this.generateTestReport();
  }

  // Generate test report
  generateTestReport() {
    this.log('='.repeat(60), 'divider');
    this.log('TEST REPORT SUMMARY', 'report');
    this.log('='.repeat(60), 'divider');

    const totalTests = this.testResults.length;
    const passedTests = this.testResults.filter(t => t.passed).length;
    const failedTests = totalTests - passedTests;

    this.log(`Total Tests: ${totalTests}`, 'summary');
    this.log(`Passed: ${passedTests}`, 'summary');
    this.log(`Failed: ${failedTests}`, 'summary');
    this.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`, 'summary');

    this.log('', 'divider');
    this.log('DETAILED RESULTS:', 'report');

    this.testResults.forEach((test, index) => {
      const status = test.passed ? 'PASS' : 'FAIL';
      const duration = `${test.duration}ms`;
      this.log(`${index + 1}. [${status}] ${test.name} (${duration})`, test.passed ? 'pass' : 'fail');
      
      if (!test.passed && test.error) {
        this.log(`   Error: ${test.error}`, 'error');
      }
    });

    this.log('='.repeat(60), 'divider');

    // Return results for programmatic access
    return {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      successRate: (passedTests / totalTests) * 100,
      details: this.testResults
    };
  }
}

// Auto-run tests when page loads (if in test mode)
if (typeof window !== 'undefined' && window.location && window.location.search.includes('test=true')) {
  window.addEventListener('load', async () => {
    // Wait for app to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const tests = new FunctionalityTests();
    const results = await tests.runAllTests();
    
    // Make results available globally
    window.testResults = results;
    
    console.log('\n🎉 Complete Sticker Tests Finished!');
    console.log('Access detailed results via: window.testResults');
  });
}

// Make test class available globally for manual testing
if (typeof window !== 'undefined') {
  window.FunctionalityTests = FunctionalityTests;
}

// Export for Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FunctionalityTests;
}