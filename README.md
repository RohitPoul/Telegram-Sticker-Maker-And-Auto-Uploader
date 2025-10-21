# Telegram Sticker Maker & Auto Uploader

A cross‑platform desktop app (Electron + Python) to:
- Convert videos and images into Telegram‑compatible sticker media
- Create sticker packs and upload them to Telegram via an integrated, guided UI
- Track usage statistics and manage sessions/logs locally

This README documents the real features present in this repository. No placeholders are used.

## Contents
- Overview
- Features
- Tech stack
- Requirements
- Quick start
- Usage (step‑by‑step)
  - Video Converter
  - Image Converter
  - Sticker Pack automation
  - Settings and Stats
- Keyboard shortcuts
- Configuration (env vars)
- Data and logs
- API (local backend)
- Troubleshooting
- Roadmap (installer)
- Contributing
- Security & privacy
- License

## Overview
- GUI: Electron app under `electron/` with tabs for Video Converter, Image Converter, Sticker Bot, Settings, and About.
- Backend: Flask server under `python/` (spawns automatically from the Electron app) exposing REST APIs for conversion, images, Telegram auth, and sticker automation.
- System tools: FFmpeg (video) and ImageMagick (images) are used when available.

## Features
- Video Converter (GUI)
  - Batch add videos; choose output directory; start/pause/resume processing
  - Progress per file and for the whole batch; drag & drop supported
  - Optional “Hex Edit” post‑processing step (batch)
  - Live system stats (CPU, RAM) in the UI
- Image Converter (GUI)
  - Batch convert to Telegram sticker constraints: 512 px max dimension, PNG/WEBP, up to 512 KB
  - Adjustable quality, transparency preserved, drag & drop, per‑file preview
- Sticker Pack automation (GUI + Telethon)
  - Connect to Telegram using API ID, API Hash, and phone number (with code and optional 2FA)
  - Prepare a pack (image or video stickers), assign emojis (including apply‑to‑all, random, sequential, theme groups), set Pack Name and URL Name
  - Icon handling: upload a WebM icon (100x100, ≤ 32 KB) or auto‑skip to use the first sticker
  - URL Name conflict flow: guided retries with up to 3 attempts; success modal with shareable link
  - Supports up to 120 media items per pack
- Settings & Stats
  - Clear logs and credentials, export/reset usage stats, kill app‑related Python processes safely
  - Stats stored locally at `logs/stats.json`; visible in Settings

## Tech stack
- Desktop UI: Electron (HTML/CSS/Vanilla JS) — see `electron/`
- Backend: Python + Flask + Flask‑CORS — see `python/backend.py`
- Telegram client: Telethon (sticker automation) — see `python/sticker_bot.py`, `python/telegram_connection_handler.py`
- Media tooling: FFmpeg (video), ImageMagick (images), Pillow (metadata)
- System info: psutil
- Logging: rotating log files under `python/logs/`

## Requirements
- Node.js (for running Electron via `npx electron`)
- Python 3.8+ (tested with modern 3.x)
- FFmpeg in PATH (video features)
- ImageMagick in PATH (image features)
- Python deps (pip): `python/requirements.txt`

Install FFmpeg + ImageMagick
- Linux (Debian/Ubuntu):
  ```bash
  sudo apt-get update && sudo apt-get install -y ffmpeg imagemagick
  ```
- macOS (Homebrew):
  ```bash
  brew install ffmpeg imagemagick
  ```
- Windows (Chocolatey):
  ```bash
  choco install ffmpeg imagemagick -y
  ```

Install Python dependencies
```bash
python3 -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r python/requirements.txt
```

## Quick start
Run the desktop app from source
```bash
# from repo root
npx electron electron/main.js
```
Backend only (for API testing)
```bash
python3 python/backend.py
```

## Usage (step‑by‑step)
### 1) Video Converter
1) Open the “Video Converter” tab
2) Add videos (button or drag & drop)
3) Choose “Output Directory”
4) Start Conversion; monitor per‑file and overall progress
5) Use Pause/Resume when needed
6) Optional: Run “Hex Edit” on resulting WebM files

Notes
- FFmpeg must be installed and visible in PATH
- Converted files are written to your selected output directory

### 2) Image Converter
1) Open “Image Converter” tab
2) Add images (PNG/JPG/WEBP) and optionally preview
3) Choose output format (PNG/WEBP) and quality
4) Pick output directory
5) Click Convert; watch the status area for progress

Notes
- ImageMagick must be installed and visible in PATH
- Output meets Telegram rules: 512 px max side, PNG/WEBP, ≤ 512 KB, transparency preserved

### 3) Sticker Pack automation
1) Connect to Telegram (Sticker Bot tab)
   - Enter API ID, API Hash, and phone number
   - Click “Connect to Telegram” and complete code + optional 2FA prompts
2) Import media and assign emojis
   - Choose “Images” or “Videos”, then “Add” (drag & drop supported)
   - Open Emoji modal to set per‑file emojis (Set/All/Random/Sequential/Theme)
3) Configure the pack
   - Pack Name and URL Name (validated in UI)
   - Choose sticker type (image or video)
   - Icon: upload WebM 100x100 ≤ 32 KB, or enable Auto‑skip to use the first sticker
4) Create the pack
   - Progress shows current file and counts; Cancel if needed
   - If URL Name is taken, a retry dialog guides up to three attempts
   - On success, a shareable link is shown with “Open in Telegram”

### 4) Settings and Stats
- System Information panel (app version, FFmpeg status, platform)
- Database Info (totals for conversions, hex edits, image conversions, stickers)
- Export Stats (JSON) and Reset Stats
- Clear Logs and Clear Credentials
- Kill Python Processes (critical; terminates this app’s backend and related processes)

## Keyboard shortcuts
- Ctrl/Cmd + N: Add files (contextual)
- Ctrl/Cmd + Enter: Start conversion/creation (contextual)
- Ctrl/Cmd + R: Reset Sticker form
- Esc: Close modals
- F5: Refresh backend status

## Configuration (env vars)
Electron (app startup)
- ENABLE_GPU=1 — opt‑in GPU acceleration (default is software rendering)
- ELECTRON_DEVTOOLS=1 — open DevTools on launch (dev only)

Backend (Python)
- BACKEND_LOG_LEVEL=INFO|WARNING|ERROR (default WARNING)
- BACKEND_LOG_TO_STDOUT=1 — also log to stdout

Example
```bash
BACKEND_LOG_LEVEL=INFO BACKEND_LOG_TO_STDOUT=1 npx electron electron/main.js
```

## Data and logs
- Stats: `logs/stats.json` (project root)
- Backend log: `python/backend.log`
- Rotating module logs: `python/logs/`
  - `video_conversion.log`
  - `hex_edit.log`
  - `sticker_bot.log`, `sticker_bot_errors.log`, `telegram_connection.log`

## API (local backend)
Base URL: `http://127.0.0.1:5000`

Health & system
- GET `/api/health`
- GET `/api/system-stats`
- GET `/api/database-stats`
- POST `/api/reset-stats`
- POST `/api/clear-logs`

Video
- POST `/api/convert-videos` — body: `{ files, output_dir, process_id? }`
- GET `/api/conversion-progress/<process_id>`
- POST `/api/hex-edit` — body: `{ files, output_dir }`
- POST `/api/stop-process` | `/api/pause-operation` | `/api/resume-operation`

Images
- GET `/api/image/check-imagemagick`
- POST `/api/image/metadata`
- POST `/api/image/process`
- POST `/api/image/process-batch`
- GET `/api/image/process-status/<process_id>`
- POST `/api/image/convert-single`

Telegram connection
- GET `/api/telegram/connection-status`
- POST `/api/telegram/connect`
- POST `/api/telegram/verify-code`
- POST `/api/telegram/verify-password`
- POST `/api/telegram/cleanup-session` | `/api/telegram/force-reset`

Sticker automation
- POST `/api/sticker/create-pack`
- POST `/api/sticker/skip-icon`
- POST `/api/sticker/upload-icon`
- POST `/api/sticker/submit-url-name`

Maintenance
- POST `/api/clear-session`
- POST `/api/clear-credentials`
- POST `/api/kill-our-processes`

## Troubleshooting
- FFmpeg/ImageMagick not found: install and ensure they’re in PATH; use the checks in Settings
- Telegram code invalid or 2FA failed: retry carefully; respect Telegram rate limits (the UI surfaces wait messages)
- URL name taken: follow the guided retry dialog (up to 3 attempts)
- Backend unresponsive: use “Kill Python Processes” from Settings, then relaunch the app

## Roadmap (installer)
- Packaged installers (e.g., AppImage/DEB, Windows .exe, macOS .dmg) are planned but not included yet in this repository. For now, run from source as shown above.

## Contributing
- Open issues and PRs with clear reproduction steps
- Keep changes scoped; follow existing patterns in `electron/` and `python/`
- Do not commit secrets; use environment variables locally

## Security & privacy
- Telegram credentials are stored at `python/telegram_credentials.json`
  - If `cryptography` is installed, they are encrypted; otherwise stored as plain text
  - You can clear credentials from Settings or via POST `/api/clear-credentials`
- No external telemetry; stats are local (`logs/stats.json`).

## License
No LICENSE file is present in this repository. By default, all rights are reserved by the author. If you plan to use or distribute this project, please contact the author or add an explicit license to the repository.
