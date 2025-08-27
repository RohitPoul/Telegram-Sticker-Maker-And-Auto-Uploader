# Telegram Sticker Maker & Auto Uploader

Status: Under construction — code upload coming soon.

A desktop app to create and publish Telegram sticker packs. Electron UI + Python backend with FFmpeg for media processing and Telethon for Telegram automation.

## Highlights
- Video converter for Telegram stickers
  - WebM (VP9), 512×512 padded, target ≈254KB
  - Batch conversion with per‑file progress and error resilience
  - Optional hex‑edit pass for edge cases
- Sticker pack automation
  - Telegram login (phone, code, optional 2FA)
  - Create packs, upload media (image/video), map emojis
  - Publish when complete
- Acceleration & stats
  - Auto-detect NVIDIA/AMD/Intel; CPU fallback by default
  - Safe CUDA preprocessing (only when FFmpeg exposes scale_cuda + hwupload_cuda)
  - Windows one‑click CUDA installer prompt (winget), user‑consented
  - Live CPU/RAM/GPU stats in UI

## Stack
- Electron (UI)
- Python (Flask, Telethon, psutil)
- FFmpeg/ffprobe (VP9), optional CUDA preprocessing

## Current Status
- CPU path is default for stability
- CUDA preprocessing auto‑enabled only when safe
- More GPU paths will be enabled incrementally

## Roadmap
- Re‑enable GPU preprocessing by default when broadly safe
- Expand AMD/Intel acceleration paths
- Guided first‑run setup & diagnostics
- Packaged builds

---
Questions/feedback welcome. This README will be updated when the initial code lands.
