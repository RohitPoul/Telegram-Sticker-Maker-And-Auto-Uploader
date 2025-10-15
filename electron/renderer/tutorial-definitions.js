/**
 * Tutorial Definitions
 * Contains all tutorial content and step definitions
 */

// Register all tutorials when loaded
document.addEventListener('DOMContentLoaded', () => {
  registerAllTutorials();
});

function registerAllTutorials() {
  // 1. Telegram API Setup Tutorial
  tutorialSystem.registerTutorial('telegram-api-setup', {
    title: '🔐 Telegram API Setup',
    description: 'Get API credentials to create sticker packs',
    icon: '🔑',
    steps: [
      {
        icon: '👋',
        title: 'Welcome!',
        content: 'Get Telegram API credentials to create sticker packs. One-time setup.',
        tip: 'Takes 2 minutes. Credentials save automatically.',
        position: 'center'
      },
      {
        icon: '🌐',
        title: 'Visit Telegram API Site',
        content: 'Go to <strong>my.telegram.org</strong> and login with your phone number.',
        tip: 'Click "API development tools" after login.',
        position: 'center'
      },
      {
        icon: '📱',
        title: 'Get Verification Code',
        content: 'Enter your phone number (e.g., +1234567890). Check Telegram for the code.',
        tip: 'Code expires in 1-2 minutes. Enter it quickly.',
        position: 'center'
      },
      {
        icon: '📝',
        title: 'Create App',
        content: 'Fill the form:<br>• <strong>App title:</strong> Any name<br>• <strong>Short name:</strong> Any name<br>• <strong>Platform:</strong> Other',
        tip: 'Names don\'t matter. Pick anything.',
        position: 'center'
      },
      {
        icon: '🎯',
        title: 'Copy Credentials',
        content: 'Copy <strong>api_id</strong> (number) and <strong>api_hash</strong> (long text).',
        tip: 'Keep these safe like passwords.',
        position: 'center'
      },
      {
        icon: '✅',
        title: 'Enter in App',
        content: 'Paste API ID and API Hash in this app. Done!',
        tip: 'Credentials encrypt and save locally.',
        position: 'center'
      }
    ]
  });

  // 2. Video Converter Tutorial
  tutorialSystem.registerTutorial('video-converter', {
    title: '🎬 Video Converter',
    description: 'Convert videos to Telegram sticker format (<256KB)',
    icon: '🎬',
    steps: [
      {
        icon: '🎬',
        title: 'Video Converter',
        content: 'Converts videos to <strong>WebM under 256KB</strong>. Perfect for Telegram stickers.',
        tip: 'Accepts: MP4, AVI, MOV, MKV, FLV, WEBM.',
        target: '.nav-item[data-tab="video-converter"]',
        position: 'bottom',
        before: () => {
          const tab = document.querySelector('.nav-item[data-tab="video-converter"]');
          if (tab) tab.click();
        }
      },
      {
        icon: '📁',
        title: 'Add Videos',
        content: 'Click "Add Videos" or drag-and-drop files. Supports multiple files.',
        tip: 'Can add entire folders at once.',
        target: '#add-videos',
        position: 'bottom'
      },
      {
        icon: '📊',
        title: 'Output Folder',
        content: 'Pick where converted files save. Default: "converted" folder next to originals.',
        tip: 'Files named: originalname_converted.webm',
        target: '#video-output-dir',
        position: 'bottom'
      },
      {
        icon: '⚙️',
        title: 'How It Works',
        content: '<strong>Auto-optimization:</strong><br>• Target: 254KB<br>• Size: 512×512<br>• Format: WebM VP9<br>• Quality: Auto-adjusted',
        tip: 'Tries multiple quality settings until size is perfect.',
        position: 'center'
      },
      {
        icon: '🚀',
        title: 'Start Conversion',
        content: 'Click "Start Conversion". Watch real-time progress for each file.',
        tip: 'Uses CPU by default. GPU available if configured.',
        target: '#start-video-conversion',
        position: 'top'
      },
      {
        icon: '📈',
        title: 'Track Progress',
        content: 'Each file shows:<br>• Attempt number<br>• File size<br>• Status',
        tip: 'Takes 20-60 seconds per file.',
        target: '#video-conversion-status',
        position: 'top'
      }
    ]
  });

  // 3. Hex Edit Tutorial
  tutorialSystem.registerTutorial('hex-edit', {
    title: '🔧 Hex Editor',
    description: 'Trick Telegram into accepting >3sec videos',
    icon: '🔧',
    steps: [
      {
        icon: '🔧',
        title: 'Hex Editor',
        content: 'Tricks Telegram into accepting videos longer than 3 seconds.',
        tip: 'Changes metadata, not the video itself.',
        target: '#start-hex-edit',
        position: 'top',
        before: () => {
          const tab = document.querySelector('.nav-item[data-tab="video-converter"]');
          if (tab) tab.click();
        }
      },
      {
        icon: '🎯',
        title: 'What It Does',
        content: 'Modifies video metadata so Telegram accepts longer videos without trimming.',
        tip: 'Video plays normally. Only duration data changes.',
        position: 'center'
      },
      {
        icon: '📁',
        title: 'Add Videos',
        content: 'Click "Add Videos". Pick WebM files needing duration adjustment.',
        tip: 'Convert first, then hex edit if needed.',
        target: '#add-videos',
        position: 'bottom'
      },
      {
        icon: '💾',
        title: 'Output Folder',
        content: 'Same folder as Video Converter. Easy to find.',
        tip: 'Files named: originalname_hexedited.webm',
        target: '#video-output-dir',
        position: 'bottom'
      },
      {
        icon: '⚡',
        title: 'Process',
        content: 'Click "Start Hex Edit". Super fast - under 1 second per file.',
        tip: 'Changes binary data only.',
        target: '#start-hexedit',
        position: 'top'
      }
    ]
  });

  // 4. Sticker Bot Tutorial
  tutorialSystem.registerTutorial('sticker-bot', {
    title: '🎨 Sticker Pack Creator',
    description: 'Create and publish Telegram sticker packs',
    icon: '🎨',
    steps: [
      {
        icon: '🎨',
        title: 'Sticker Pack Creator',
        content: 'Automatically creates and uploads sticker packs to Telegram using the @stickers bot.',
        tip: 'You must be connected to Telegram first!',
        target: '.nav-item[data-tab="sticker-bot"]',
        position: 'bottom',
        before: () => {
          const tab = document.querySelector('.nav-item[data-tab="sticker-bot"]');
          if (tab) tab.click();
        }
      },
      {
        icon: '🔐',
        title: 'Connect to Telegram',
        content: 'Enter your API credentials, phone number, and verification code to connect.',
        tip: 'Login once. Session saves automatically.',
        target: '#telegram-api-id',
        position: 'bottom'
      },
      {
        icon: '📦',
        title: 'Pack Details',
        content: '<strong>Pack Name:</strong> Display name (1-64 characters)<br><strong>URL Name:</strong> Unique link (5-32 characters, start with letter, use letters/numbers/_)<br><br>Your pack will be at: <strong>t.me/addstickers/your_url_name</strong>',
        tip: 'URL name must be unique. Green glow = available, red glow = invalid.',
        target: '#pack-name',
        position: 'bottom'
      },
      {
        icon: '🖼️',
        title: 'Choose Sticker Type',
        content: 'Pick <strong>Image</strong> or <strong>Video</strong>. All stickers in a pack must match.',
        tip: 'Video stickers are animated, image stickers are static.',
        target: '#select-image-type',
        position: 'right'
      },
      {
        icon: '📂',
        title: 'Add Sticker Files',
        content: 'Select media type first, then click "Add" to choose files. Max 120 files per pack.',
        tip: 'Use converted files (WebM for video, PNG/WebP for images).',
        target: '#add-media',
        position: 'bottom'
      },
      {
        icon: '😀',
        title: 'Assign Emojis',
        content: 'Click any sticker to assign an emoji. Each sticker needs one.',
        tip: 'Pick emojis that match your sticker. Default is ❤️.',
        target: '#sticker-media-list',
        position: 'left'
      },
      {
        icon: '⚡',
        title: 'Auto-Skip Icon',
        content: 'Toggle ON to skip icon selection (faster). Toggle OFF to upload a custom pack icon.',
        tip: 'Icons are optional. You can add them later.',
        target: '#auto-skip-icon',
        position: 'left'
      },
      {
        icon: '🚀',
        title: 'Create Pack',
        content: 'Click "Create Sticker Pack". Watch progress in the status section below. Takes 2-5 seconds per sticker.',
        tip: 'Notifications show when each sticker uploads. Click to dismiss.',
        target: '#create-sticker-pack',
        position: 'top'
      },
      {
        icon: '🎉',
        title: 'Success!',
        content: 'You\'ll get a shareable link: <strong>t.me/addstickers/your_pack</strong><br><br>Copy and share it anywhere!',
        tip: 'Create unlimited packs. Each needs a unique URL name.',
        position: 'center'
      }
    ]
  });

  // 5. First Time User Experience
  tutorialSystem.registerTutorial('first-time', {
    title: '🚀 Quick Start Guide',
    description: 'Overview of all features - perfect for first-time users',
    icon: '🚀',
    steps: [
      {
        icon: '👋',
        title: 'Welcome!',
        content: 'Create Telegram video sticker packs in 3 easy steps. Let\'s tour the app!',
        tip: 'Replay tutorials anytime from 🎓 button.',
        position: 'center'
      },
      {
        icon: '🎯',
        title: '3 Simple Steps',
        content: '1. Convert videos<br>2. (Optional) Hex edit for >3sec videos<br>3. Create and publish pack',
        tip: 'Each step has its own tutorial. Click 🎓 anytime.',
        position: 'center'
      },
      {
        icon: '🎬',
        title: 'Step 1: Video Converter',
        content: 'Converts videos to <strong>WebM under 256KB, 512×512</strong>.',
        tip: 'Start here - convert first.',
        target: '.nav-item[data-tab="video-converter"]',
        position: 'bottom'
      },
      {
        icon: '🔧',
        title: 'Step 2: Hex Editor',
        content: 'Tricks Telegram into accepting videos longer than 3 seconds.',
        tip: 'Optional. Only for >3sec videos.',
        target: '#start-hex-edit',
        position: 'top'
      },
      {
        icon: '🎨',
        title: 'Step 3: Sticker Bot',
        content: 'Creates and publishes pack to Telegram automatically.',
        tip: 'Final step. Uploads everything.',
        target: '.nav-item[data-tab="sticker-bot"]',
        position: 'bottom'
      },
      {
        icon: '📊',
        title: 'Track Progress',
        content: 'View stats: files converted, packs created, and more.',
        tip: 'All stats save locally.',
        target: '.nav-item[data-tab="settings"]',
        position: 'bottom'
      },
      {
        icon: '🎓',
        title: 'Need Help?',
        content: 'Click 🎓 anytime for tutorials and guides.',
        tip: 'New? Start with "Telegram API Setup".',
        position: 'center'
      }
    ]
  });

  // 6. Telegram Connection Tutorial
  tutorialSystem.registerTutorial('telegram-connection', {
    title: '🔌 Connecting to Telegram',
    description: 'How to authenticate with Telegram for sticker creation',
    icon: '🔌',
    steps: [
      {
        icon: '🔌',
        title: 'Telegram Connection',
        content: 'Connect to Telegram to create sticker packs.',
        tip: 'Credentials encrypt and save locally.',
        position: 'center'
      },
      {
        icon: '🔑',
        title: 'API Credentials',
        content: 'Enter <strong>API ID</strong> and <strong>API Hash</strong> from my.telegram.org.<br><br>No credentials? Run "Telegram API Setup" tutorial first.',
        tip: 'Keep them safe like passwords.',
        target: '#telegram-api-id',
        position: 'bottom'
      },
      {
        icon: '📱',
        title: 'Phone Number',
        content: 'Enter phone with country code (e.g., +1234567890).',
        tip: 'Your Telegram account number.',
        target: '#telegram-phone',
        position: 'bottom'
      },
      {
        icon: '🔢',
        title: 'Verification Code',
        content: 'Click Connect. Check Telegram app for login code. Enter when prompted.',
        tip: 'Enter within 1-2 minutes before expiry.',
        position: 'center'
      },
      {
        icon: '🔐',
        title: 'Two-Factor Auth',
        content: 'If 2FA is enabled, enter your cloud password.',
        tip: 'This is different from the login code.',
        position: 'center'
      },
      {
        icon: '✅',
        title: 'Connected!',
        content: 'Green status shows you\'re connected. Session saved - no need to login again.',
        tip: 'Click Disconnect to logout anytime.',
        position: 'center'
      }
    ]
  });

}

// Auto-show first-time tutorial if user hasn't seen it
function checkFirstTimeUser() {
  // Removed automatic first-time tutorial prompt
  // Users can access tutorials manually via the 🎓 button
  return;
}

// Run first-time check when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkFirstTimeUser);
} else {
  checkFirstTimeUser();
}