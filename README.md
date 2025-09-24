# Complete Sticker

A desktop application for creating and managing Telegram sticker packs. Built with Electron (frontend) and Python (backend).

## Overview

This application automates the process of converting media files to Telegram sticker format and uploading them as sticker packs. It handles video conversion using FFmpeg and interfaces with Telegram through the Telethon library.

## Features

### Media Processing
- Video conversion to WebM format (VP9 codec) with 512×512 resolution
- FFmpeg integration with GPU acceleration support (CUDA, AMF, QSV)
- Batch file processing
- Automatic format detection

### Telegram Integration
- Telegram API authentication (phone number, SMS, 2FA)
- Automated sticker pack creation
- Session management with persistent connections
- Emoji assignment for stickers

### User Interface
- Electron-based cross-platform desktop app
- Drag and drop file support
- Real-time progress tracking
- Dark theme

## Technical Stack

- **Frontend**: Electron, JavaScript, CSS
- **Backend**: Python 3.12+, Flask API
- **Telegram Client**: Telethon (async)
- **Media Processing**: FFmpeg
- **System Monitoring**: psutil

## Installation

### Requirements
- Python 3.12 or higher
- Node.js 18+ and npm
- FFmpeg (optional, for GPU acceleration)
- 4GB RAM minimum
- 2GB free disk space

### Setup

```bash
# Clone repository
git clone https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader.git
cd Telegram-Sticker-Maker-And-Auto-Uploader

# Install Python dependencies
pip install -r python/requirements.txt

# Install Node.js dependencies
npm install

# Start application
npm start
```

## Usage

1. **Start the application**
   ```bash
   npm start
   ```

2. **Configure Telegram credentials**
   - Obtain API credentials from [my.telegram.org](https://my.telegram.org)
   - Enter phone number and verification code
   - Session is saved for future use

3. **Add media files**
   - Drag and drop files or use file selector
   - Supported formats: images and videos
   - Files are automatically validated

4. **Configure sticker pack**
   - Set pack name (1-64 characters)
   - Set URL name (5-32 characters, alphanumeric + underscores)
   - Choose sticker type (Image or Video)

5. **Create pack**
   - Review settings and click create
   - Monitor progress in real-time
   - Pack URL is provided upon completion

## Configuration

### Environment Variables
```bash
STICKER_CACHE_SIZE=1024      # Cache size in MB
STICKER_MAX_CONCURRENT=4     # Max concurrent conversions
STICKER_LOG_LEVEL=INFO       # Logging level
```

## Recent Updates

### v1.4.7 (September 24, 2024)
- Fixed modal display issues
- Enhanced process ID coordination
- Improved UI responsiveness
- Updated documentation

### v1.4.6 (September 23, 2024)
- Fixed URL modal "Try This Name" button
- Added missing updatePackActions() method
- Changed modal themes from error-red to choice-blue
- Removed duplicate CSS code

### v1.4.5 (September 22, 2024)
- Resolved modal display stability issues
- Updated UI theme to light pink
- Improved suggestion layout responsiveness
- Added keyboard shortcuts (Ctrl+C, Enter)

## Testing

```bash
# Run the application
npm start
```

Test the following features:
1. Create sticker pack with different file types
2. Test input validation on pack name and URL name
3. Verify session persistence on app restart
4. Test success modal functionality

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/issues)
- **Documentation**: Check the repository wiki
- **Contact**: [Rohit Poul](https://github.com/RohitPoul)