# Telegram Sticker Maker & Auto Uploader

Desktop app to convert videos/images to Telegram stickers and automatically upload full packs.

![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white&style=flat-square)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white&style=flat-square)
![Telethon](https://img.shields.io/badge/Telethon-2CA5E0?logo=telegram&logoColor=white&style=flat-square)

---

## Features

### Media Converters
- **Video Converter** — Batch convert videos to WebM (Telegram video stickers)
  - Drag & drop support
  - Per-file and overall progress tracking
  - Pause/resume operations
  - Optional Hex-Edit post-processing
  
- **Image Converter** — Batch convert images to 512px PNG/WEBP
  - Auto-resize while preserving aspect ratio
  - Quality controls
  - Transparency preserved
  - Output stays under 512KB limit

### Sticker Pack Automation
- **Create New Packs** — Full pack creation via Telethon (no @Stickers bot chat needed)
- **Add to Existing Packs** — Append stickers to your existing packs
- **Smart Emoji Assignment** — Per-sticker, bulk apply, random, sequential, or theme-based
- **Icon Handling** — Upload custom 100×100 WebM icon or auto-skip to use first sticker
- **URL Name Retries** — Guided flow with up to 3 attempts if name is taken

### Account Management
- **Telegram Presets** — Save, load, and switch between multiple Telegram accounts
- **Secure Credentials** — Stored locally, encrypted when `cryptography` package is installed

### User Experience
- **Interactive Tutorials** — Built-in guided walkthroughs for all features
- **Splash Screen** — Modern loading screen during startup
- **Keyboard Shortcuts**:
  - `Ctrl+N` — Add files
  - `Ctrl+Enter` — Start conversion/creation
  - `Ctrl+R` — Reset Sticker form
  - `Esc` — Close modals
  - `F5` — Refresh backend status

---

## Requirements

- **FFmpeg** — Video processing
- **ImageMagick** — Image processing
- **Python 3.8+** — Backend server
- **Node.js** — Electron runtime

---

## Installation

### 1. Install System Dependencies

```bash
# Linux
sudo apt-get update && sudo apt-get install -y ffmpeg imagemagick

# macOS
brew install ffmpeg imagemagick

# Windows
choco install ffmpeg imagemagick -y
```

### 2. Install Python Dependencies

```bash
cd python
pip install -r requirements.txt
```

### 3. Get Telegram API Credentials

1. Go to https://my.telegram.org/apps
2. Create a new application
3. Copy your **API ID** and **API Hash**

### 4. Run the App

```bash
npm start
# or
npx electron .
```

---

## Usage

### Converting Media
1. Open **Video Converter** or **Image Converter** tab
2. Add files (drag & drop or click "Add")
3. Select output directory
4. Click **Convert**

### Creating Sticker Packs
1. Go to **Sticker Bot** tab
2. Enter your API ID, API Hash, and phone number
3. Click **Connect** → Enter verification code (and 2FA password if enabled)
4. Add your converted media files
5. Assign emojis (per-file or use bulk options)
6. Set Pack Name and URL
7. Click **Create Sticker Pack**

### Adding to Existing Packs
1. Connect to Telegram (same as above)
2. Select "Add to Existing Pack" mode
3. Enter the pack's short name (from `t.me/addstickers/YOUR_PACK_NAME`)
4. Add media files and assign emojis
5. Click **Add to Pack**

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_GPU` | Enable GPU acceleration | `0` |
| `ELECTRON_DEVTOOLS` | Open DevTools on launch | `0` |
| `BACKEND_LOG_LEVEL` | Log level: INFO/WARNING/ERROR | `WARNING` |
| `BACKEND_LOG_TO_STDOUT` | Also log to stdout | `0` |

Example:
```bash
BACKEND_LOG_LEVEL=INFO npm start
```

---

## Project Structure

```
├── electron/
│   ├── main.js              # Electron main process
│   ├── preload.js           # IPC bridge
│   ├── splash.html          # Loading screen
│   └── renderer/            # Frontend (HTML/CSS/JS)
├── python/
│   ├── backend.py           # Flask API server
│   ├── video_converter.py   # Video processing
│   ├── image_processor.py   # Image processing
│   ├── sticker_bot.py       # Telegram sticker automation
│   └── telegram_connection_handler.py
└── logs/                    # Application logs
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| FFmpeg/ImageMagick not found | Install and add to PATH. Check in Settings. |
| Telegram code invalid | Wait a moment and retry. Respect rate limits. |
| 2FA password wrong | Enter your Telegram cloud password, not phone passcode. |
| URL name taken | Use the retry dialog to pick a different name. |
| Backend unresponsive | Use "Kill Python Processes" in Settings, then restart. |
| Pack creation stuck | Check if Telegram sent any messages to your account. |

---

## Telegram Sticker Limits

- Max **120 stickers** per pack
- Video stickers: **512×512**, up to **3 seconds**, WebM format
- Image stickers: **512×512** max dimension, PNG/WEBP format
- Pack icon: **100×100**, WebM, under 32KB (or use first sticker)

---

## License

All rights reserved. Contact the author for usage permissions.
