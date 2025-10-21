<h1 align="center">Telegram Sticker Maker & Auto Uploader</h1>
<p align="center">Convert videos and images to Telegram‑ready stickers, then publish full packs in minutes — no terminal needed.</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white&style=for-the-badge" />
  <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white&style=for-the-badge" />
  <img alt="Flask" src="https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white&style=for-the-badge" />
  <img alt="Telethon" src="https://img.shields.io/badge/Telethon-2CA5E0?logo=telegram&logoColor=white&style=for-the-badge" />
  <img alt="FFmpeg" src="https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white&style=for-the-badge" />
  <img alt="ImageMagick" src="https://img.shields.io/badge/ImageMagick-000000?style=for-the-badge" />
  <img alt="Cross platform" src="https://img.shields.io/badge/OS-Windows%20%7C%20macOS%20%7C%20Linux-555?style=for-the-badge" />
</p>
<p align="center">
  <a href="#-installers"><img alt="Release" src="https://img.shields.io/badge/Release-Coming%20Soon-ff9800?style=for-the-badge" /></a>
  <a href="https://github.com/USER/REPO/releases"><img alt="Downloads" src="https://img.shields.io/badge/Downloads-GitHub%20Releases-2ea44f?style=for-the-badge" /></a>
  <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-Welcome-0aa8d1?style=for-the-badge" />
  <img alt="License" src="https://img.shields.io/badge/License-All%20rights%20reserved-555?style=for-the-badge" />
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Inter&size=20&duration=3500&pause=1000&color=36C5F0&center=true&vCenter=true&width=700&lines=Convert+videos+%E2%86%92+WebM;Convert+images+%E2%86%92+512px+PNG%2FWEBP;Auto-upload+entire+sticker+packs;Guided+Telegram+auth+%26+pack+creation" alt="Typing animation" />
</p>

<!-- HERO: Add a wide screenshot or GIF at assets/hero.png (recommended width ~1200px) -->
<!-- Example placeholder: assets/hero.png -->

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-installers">Installers</a> •
  <a href="#-quickstart">Quickstart</a> •
  <a href="#-usage">Usage</a> •
  <a href="#-feature-tour">Feature Tour</a> •
  <a href="#-configuration">Configuration</a> •
  <a href="#-troubleshooting">Troubleshooting</a> •
  <a href="#-faq">FAQ</a>
</p>

---

## ✨ Features (What you get)
- Batch Video Converter: drag & drop, per‑file and overall progress, pause/resume, optional Hex‑Edit post‑step
- Batch Image Converter: 512px max, PNG/WEBP, ≤ 512KB, transparency preserved
- One‑click Sticker Pack Creator: Telethon‑powered flow, no @Stickers chat needed
- Smart Emojis: set per‑file or bulk (All / Random / Sequential / Theme groups)
- Icon Handling: upload 100x100 ≤ 32KB WebM icon or auto‑skip to use the first sticker
- URL Name Flow: guided retries (up to 3 attempts) until you get an available link
- Local‑only Data: stats, logs, and credentials stay on your machine; clear/reset anytime

## 📦 Installers
Installers are coming soon for a pro, one‑click setup. When you publish, replace these links with real release assets:

<p align="center">
  <a href="https://github.com/USER/REPO/releases/latest"><img src="https://img.shields.io/badge/Windows-EXE-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows installer"/></a>
  <a href="https://github.com/USER/REPO/releases/latest"><img src="https://img.shields.io/badge/macOS-DMG-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS installer"/></a>
  <a href="https://github.com/USER/REPO/releases/latest"><img src="https://img.shields.io/badge/Linux-AppImage%2FDEB-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux installer"/></a>
</p>

Or run from source now (see Quickstart).

## 🚀 Quickstart

1) Install FFmpeg & ImageMagick
- Linux: `sudo apt-get update && sudo apt-get install -y ffmpeg imagemagick`
- macOS: `brew install ffmpeg imagemagick`
- Windows: `choco install ffmpeg imagemagick -y`

2) Install Python deps
```bash
python3 -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r python/requirements.txt
```

3) Get Telegram API credentials
- Visit https://my.telegram.org/apps → create app → copy your API ID & API Hash

4) Run the desktop app
```bash
npx electron electron/main.js
```

## 🧭 Usage (60‑second overview)
1) Convert your media (Video/Image tabs) → pick output → Convert
2) Open Sticker Bot tab → enter API ID, API Hash, phone → Connect → enter code (and 2FA if set)
3) Add stickers → set emojis (bulk options available) → set Pack Name + URL → Create Pack → get shareable link

## 🎬 Feature Tour

<!-- Add GIFs/screenshots to the paths below. Keep width ~900–1200px for readability. -->

### Video Converter (WebM stickers)
- Batch add, drag & drop, progress bars, pause/resume, optional Hex‑Edit
- Output is Telegram‑ready video stickers
<!-- Add GIF: assets/screens/video-converter.gif -->

### Image Converter (PNG/WEBP)
- Auto‑resize to 512px max, quality controls, transparency preserved
<!-- Add GIF: assets/screens/image-converter.gif -->

### Sticker Pack Automation
- Connect via Telethon, add media, smart emoji assignment, icon flow, URL retries
<!-- Add GIF: assets/screens/sticker-bot-connect.gif -->
<!-- Add GIF: assets/screens/create-pack.gif -->
<!-- Add PNG: assets/screens/success-link.png -->

## ⚙️ Configuration

Electron (startup)
- `ENABLE_GPU=1` — opt‑in GPU acceleration
- `ELECTRON_DEVTOOLS=1` — open DevTools on launch (dev only)

Backend (Python)
- `BACKEND_LOG_LEVEL=INFO|WARNING|ERROR` (default WARNING)
- `BACKEND_LOG_TO_STDOUT=1` — also log to stdout

Example
```bash
BACKEND_LOG_LEVEL=INFO BACKEND_LOG_TO_STDOUT=1 npx electron electron/main.js
```

## ⌨️ Keyboard Shortcuts
- Ctrl/Cmd + N — Add files (contextual)
- Ctrl/Cmd + Enter — Start conversion/creation (contextual)
- Ctrl/Cmd + R — Reset Sticker form
- Esc — Close modals
- F5 — Refresh backend status

## 🗂 Project Structure
```text
.
├─ electron/
│  ├─ main.js
│  └─ preload.js
├─ python/
│  ├─ backend.py
│  ├─ video_converter.py
│  ├─ image_processor.py
│  ├─ sticker_bot.py
│  ├─ telegram_connection_handler.py
│  └─ ...
├─ logs/
│  └─ stats.json
├─ assets/                # Put your media here
│  ├─ hero.png            # Top hero banner (screenshot or GIF)
│  └─ screens/
│     ├─ video-converter.gif
│     ├─ image-converter.gif
│     ├─ sticker-bot-connect.gif
│     ├─ create-pack.gif
│     └─ success-link.png
└─ README.md
```

## 🧾 Data & Logs
- Stats: `logs/stats.json`
- Backend log: `python/backend.log`
- Rotating logs: `python/logs/` (video_conversion.log, hex_edit.log, sticker_bot*.log, telegram_connection.log)
- Credentials: `python/telegram_credentials.json` (encrypted if `cryptography` is installed)

<details>
<summary><b>📚 Local backend API (for developers)</b></summary>

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
</details>

## 🧩 Troubleshooting
- FFmpeg/ImageMagick not found → install and ensure they’re in PATH (check in Settings)
- Telegram code invalid or 2FA failed → retry carefully; respect rate limits
- URL name taken → use the guided retry dialog (up to 3 attempts)
- Backend unresponsive → use “Kill Python Processes” in Settings, then relaunch

## ❓ FAQ
- Do I need to chat with @Stickers? → No, the app handles pack creation via Telethon.
- What sticker limits apply? → Up to 120 items per pack (Telegram limit at the time of writing).
- Can I skip the icon? → Yes; enable Auto‑skip and the first sticker will be used.
- Where is my data stored? → Locally on your machine (see Data & Logs).

## 🔒 Security & Privacy
- Credentials are kept at `python/telegram_credentials.json` (encrypted when possible)
- No external telemetry; usage stats are stored locally only

## 🤝 Contributing
PRs are welcome — please follow existing patterns in `electron/` and `python/` and keep changes focused.

## 📜 License
No LICENSE file is present. By default, all rights are reserved by the author. If you plan to use or distribute this project, please contact the author or add an explicit license.

---

<p align="center">
  If this helped you, consider starring the repo ⭐ and sharing your sticker pack!
</p>
