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
        content: 'This tutorial guides you through getting Telegram API credentials needed for sticker creation.',
        tip: 'This is a one-time setup. Credentials are saved securely.',
        position: 'center'
      },
      {
        icon: '🌐',
        title: 'Visit Telegram API Site',
        content: 'Open <strong>my.telegram.org</strong> in your browser. Click "API development tools" after logging in.',
        tip: 'Login with your phone number and verification code.',
        position: 'center'
      },
      {
        icon: '📱',
        title: 'Login to Telegram',
        content: 'Enter your phone number with country code (e.g., +1234567890). Check your Telegram app for the verification code.',
        tip: 'Code expires quickly - enter it within 1-2 minutes.',
        position: 'center'
      },
      {
        icon: '📝',
        title: 'Create Application',
        content: 'Fill in the form:<br>• App title: Any name (e.g., "My Sticker Bot")<br>• Short name: Any short name<br>• Platform: Other',
        tip: 'The app title is just for your reference.',
        position: 'center'
      },
      {
        icon: '🎯',
        title: 'Copy Your Credentials',
        content: 'You\'ll see <strong>api_id</strong> (a number) and <strong>api_hash</strong> (a long string). Copy both carefully.',
        tip: 'Keep these credentials safe! They\'re like passwords.',
        position: 'center'
      },
      {
        icon: '✅',
        title: 'Enter in App',
        content: 'Return to this app and enter your API ID and API Hash in the settings. You\'re all set!',
        tip: 'Credentials will be saved and encrypted locally.',
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
        content: 'Converts videos to <strong>&lt;256KB WebM</strong> format, perfect for Telegram stickers.',
        tip: 'Supports MP4, AVI, MOV, MKV, FLV, WEBM input formats.',
        target: '.nav-item[data-tab="video-converter"]',
        position: 'bottom',
        before: () => {
          // Switch to video converter tab
          const tab = document.querySelector('.nav-item[data-tab="video-converter"]');
          if (tab) tab.click();
        }
      },
      {
        icon: '📁',
        title: 'Add Your Videos',
        content: 'Click "Add Videos" button or drag-and-drop video files. Multiple files supported.',
        tip: 'You can add entire folders of videos at once.',
        target: '#add-videos',
        position: 'bottom'
      },
      {
        icon: '📊',
        title: 'Output Directory',
        content: 'Choose where converted files will be saved. Default is a "converted" folder next to originals.',
        tip: 'Converted files are named: originalname_converted.webm',
        target: '#video-output-dir',
        position: 'bottom'
      },
      {
        icon: '⚙️',
        title: 'How It Works',
        content: '<strong>Automatic optimization:</strong><br>• Target: 254KB (Telegram limit is 256KB)<br>• Resolution: 512×512 with aspect ratio preserved<br>• Format: WebM (VP9 codec)<br>• Quality: Auto-adjusted until size is perfect',
        tip: 'The converter tries multiple times with different settings to hit the target size.',
        position: 'center'
      },
      {
        icon: '🚀',
        title: 'Start Conversion',
        content: 'Click "Start Conversion" to begin. Progress shown for each file in real-time.',
        tip: 'Conversion uses CPU by default. GPU acceleration available if configured.',
        target: '#start-video-conversion',
        position: 'top'
      },
      {
        icon: '📈',
        title: 'Monitor Progress',
        content: 'Watch as files are converted. Each file shows:<br>• Current attempt and CRF value<br>• File size progress<br>• Completion status',
        tip: 'Files typically take 20-60 seconds each depending on length.',
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
        content: 'Uses <strong>bit manipulation</strong> to trick Telegram into thinking videos longer than 3 seconds are shorter.',
        tip: 'This doesn\'t trim the video - it just changes metadata!',
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
        content: '<strong>Magic trick:</strong> Changes internal video metadata so Telegram accepts videos longer than 3 seconds without trimming them.',
        tip: 'Video plays normally - only the reported duration changes.',
        position: 'center'
      },
      {
        icon: '📁',
        title: 'Add Videos to Edit',
        content: 'Use the same "Add Videos" button. Select WebM files that need duration adjustment.',
        tip: 'Use Video Converter first, then Hex Edit if needed.',
        target: '#add-videos',
        position: 'bottom'
      },
      {
        icon: '💾',
        title: 'Choose Output',
        content: 'Output directory is shared with Video Converter for convenience.',
        tip: 'Hex edited files are named: originalname_hexedited.webm',
        target: '#video-output-dir',
        position: 'bottom'
      },
      {
        icon: '⚡',
        title: 'Process Files',
        content: 'Click "Start Hex Edit" to process. Very fast - typically completes in under 1 second per file.',
        tip: 'This modifies binary data, not video content.',
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
        content: 'First, connect using your API credentials (from Telegram API Setup tutorial). Enter phone number and verification code.',
        tip: 'Session is saved - you only need to login once.',
        target: '#telegram-api-id',
        position: 'bottom'
      },
      {
        icon: '📦',
        title: 'Pack Details',
        content: '<strong>Pack Name:</strong> Display name (1-64 chars)<br><strong>URL Name:</strong> Unique identifier (5-32 chars, letters/numbers/_)<br><br>Example URL: t.me/addstickers/your_url_name',
        tip: 'URL name must start with a letter and be unique across all of Telegram.',
        target: '#pack-name',
        position: 'bottom'
      },
      {
        icon: '🖼️',
        title: 'Choose Sticker Type',
        content: 'Select <strong>Image</strong> or <strong>Video</strong> stickers. All files in a pack must be the same type.',
        tip: 'Video stickers are more eye-catching but larger file size.',
        target: '#select-image-type',
        position: 'right'
      },
      {
        icon: '📂',
        title: 'Add Sticker Files',
        content: 'First select media type (Image/Video), then click "Add" button. Add your converted files.',
        tip: 'Files should already be converted to proper format and size.',
        target: '#add-media',
        position: 'bottom'
      },
      {
        icon: '😀',
        title: 'Assign Emojis',
        content: 'Each sticker needs an emoji. Click files in the list to assign emojis, or use the default 😀.',
        tip: 'Choose emojis that match the sticker\'s meaning.',
        target: '#sticker-media-list',
        position: 'left'
      },
      {
        icon: '🎬',
        title: 'Icon Selection',
        content: '<strong>Auto-Skip Icon:</strong> Automatically skips icon selection step (recommended for quick creation).<br><br>Uncheck to manually upload a pack icon.',
        tip: 'Icons are optional and can be added later.',
        target: '#auto-skip-icon',
        position: 'left'
      },
      {
        icon: '🚀',
        title: 'Create Pack',
        content: 'Click "Create Sticker Pack" to start. The bot will:<br>1. Create pack<br>2. Upload each sticker<br>3. Publish pack<br>4. Return shareable link',
        tip: 'This process takes 2-5 seconds per sticker.',
        target: '#create-sticker-pack',
        position: 'top'
      },
      {
        icon: '🎉',
        title: 'Share Your Pack',
        content: 'Once complete, you\'ll get a link like: <strong>t.me/addstickers/your_pack</strong><br><br>Share this link with anyone!',
        tip: 'You can create unlimited sticker packs.',
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
        title: 'Welcome to Telegram Sticker Creator!',
        content: 'This app helps you create Telegram video sticker packs easily. Let\'s take a quick tour!',
        tip: 'You can replay any tutorial anytime from the 🎓 button.',
        position: 'center'
      },
      {
        icon: '🎯',
        title: 'Your Journey Starts Here',
        content: 'Creating stickers is a 3-step process:<br>1. Convert videos to Telegram format<br>2. (Optional) Use Hex Editor for longer videos<br>3. Create and publish your sticker pack',
        tip: 'Each step has its own tutorial - click the 🎓 button anytime!',
        position: 'center'
      },
      {
        icon: '🎬',
        title: 'Video Converter',
        content: 'Converts any video to Telegram sticker format: <strong>&lt;256KB, 512×512, WebM</strong>.',
        tip: 'This is where you start - convert videos first.',
        target: '.nav-item[data-tab="video-converter"]',
        position: 'bottom'
      },
      {
        icon: '🔧',
        title: 'Hex Editor (Advanced)',
        content: 'Tricks Telegram into accepting videos longer than 3 seconds without trimming.',
        tip: 'Optional step - use only if videos are >3sec.',
        target: '#start-hex-edit',
        position: 'top'
      },
      {
        icon: '🎨',
        title: 'Sticker Bot',
        content: 'Creates and publishes your sticker pack to Telegram automatically.',
        tip: 'Final step - uploads all stickers and creates the pack.',
        target: '.nav-item[data-tab="sticker-bot"]',
        position: 'bottom'
      },
      {
        icon: '📊',
        title: 'Statistics',
        content: 'Track your progress: files converted, stickers created, and more.',
        tip: 'Stats are saved locally.',
        target: '.nav-item[data-tab="settings"]',
        position: 'bottom'
      },
      {
        icon: '🎓',
        title: 'Need Help?',
        content: 'Click the 🎓 button anytime to see all tutorials and guides.',
        tip: 'Start with "Getting Telegram API Credentials" if you\'re new.',
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
        content: 'To create sticker packs, you need to connect to Telegram using your account.',
        tip: 'Your credentials are encrypted and stored locally.',
        position: 'center'
      },
      {
        icon: '🔑',
        title: 'API Credentials',
        content: 'Enter your <strong>API ID</strong> and <strong>API Hash</strong> from my.telegram.org.<br><br>Don\'t have them? Run the "Getting Telegram API Credentials" tutorial first.',
        tip: 'These are like app passwords - keep them safe.',
        target: '#telegram-api-id',
        position: 'bottom'
      },
      {
        icon: '📱',
        title: 'Phone Number',
        content: 'Enter your phone number with country code (e.g., +1234567890).',
        tip: 'This is your Telegram account phone number.',
        target: '#telegram-phone',
        position: 'bottom'
      },
      {
        icon: '🔢',
        title: 'Verification Code',
        content: 'Click Connect, then check your Telegram app for a login code. Enter it when prompted.',
        tip: 'Code expires quickly - enter it within 1-2 minutes.',
        position: 'center'
      },
      {
        icon: '🔐',
        title: 'Two-Factor Auth (if enabled)',
        content: 'If you have 2FA enabled on Telegram, you\'ll need to enter your password as well.',
        tip: 'This is your cloud password, not the login code.',
        position: 'center'
      },
      {
        icon: '✅',
        title: 'Connected!',
        content: 'Once connected, the green status will show. Your session is saved - you won\'t need to login again.',
        tip: 'Click Disconnect if you want to logout.',
        position: 'center'
      }
    ]
  });

  console.log(`✅ Registered ${tutorialSystem.tutorials.size} tutorials`);
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