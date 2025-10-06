# Telegram Utilities

**Advanced Video Converter, Image Processor & Telegram Sticker Pack Creator**

[![Version](https://img.shields.io/badge/version-1.5.0-blue.svg)](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12+-blue.svg)](https://python.org)
[![Electron](https://img.shields.io/badge/electron-latest-lightgrey.svg)](https://electronjs.org)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey.svg)](#installation)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Contributing](#contributing) • [Support](#support)

## Overview

Telegram Utilities is a cross-platform desktop application that provides a complete suite of tools for working with Telegram media. Built with modern web technologies and robust backend processing, it offers intuitive interfaces for converting media files to Telegram's specifications and automating the sticker pack creation process.

### Key Capabilities
- **Video Conversion**: Convert videos to Telegram's WebM format with optimized settings
- **Image Processing**: Process images to Telegram sticker specifications (512×512)
- **Sticker Pack Creation**: Automated creation and management of Telegram sticker packs
- **Cross-Platform Support**: Works on Windows, macOS, and Linux
- **Session Persistence**: Secure storage of Telegram credentials and sessions

## Features

<table>
<tr>
<td width="50%">

### 🎥 Video Converter
- **Format Support**: MP4, MOV, AVI, MKV, FLV, WebM
- **Telegram Optimization**: Automatic conversion to WebM (VP9) with 512×512 resolution
- **Batch Processing**: Handle multiple files simultaneously with progress tracking
- **Hardware Acceleration**: CPU-optimized processing for reliable performance
- **Quality Control**: Maintains quality while meeting Telegram's file size limits
- **Format Detection**: Automatic input format recognition

### 🖼️ Image Converter
- **Format Support**: PNG, JPG, JPEG, GIF, WEBP, BMP, TIFF
- **Telegram Sticker Format**: Automatic resizing to 512×512 with transparency support
- **Multiple Output Formats**: PNG or WebP output with quality control
- **Size Optimization**: Automatic compression to meet Telegram's 512KB limit
- **Batch Processing**: Process multiple images with progress tracking

</td>
<td width="50%">

### 🤖 Telegram Sticker Bot
- **Secure Authentication**: Phone + SMS + 2FA support
- **Session Management**: Persistent login with automatic reconnection
- **Pack Creation**: Automated sticker pack setup and publishing
- **Emoji Assignment**: Smart emoji mapping for stickers
- **URL Generation**: Custom pack URL name validation
- **Auto-Skip Options**: Configurable icon selection automation
- **Multi-Format Support**: Create both image and video sticker packs

### 🖥️ User Experience
- **Modern Interface**: Clean, responsive Electron-based UI
- **Drag & Drop**: Intuitive file management
- **Real-time Feedback**: Live progress and status updates
- **Dark Theme**: Eye-friendly interface design
- **Cross-Platform**: Consistent experience across operating systems
- **Tab-Based Navigation**: Easy access to all features

</td>
</tr>
</table>

## Architecture

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|----------|
| **Frontend** | Electron + JavaScript (ES2023) | Cross-platform desktop interface |
| **Backend** | Python 3.12+ + Flask | API server and core processing |
| **Video Processing** | FFmpeg | Video conversion pipeline |
| **Image Processing** | Pillow + ImageMagick | Image processing and optimization |
| **Telegram Client** | Telethon (AsyncIO) | Telegram API integration |
| **Session Management** | Encrypted local storage | Secure credential persistence |
| **System Monitoring** | psutil | Resource monitoring and optimization |

### System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | Windows 10, macOS 10.14, Ubuntu 18.04 | Latest versions |
| **RAM** | 4GB | 8GB+ |
| **Storage** | 2GB free space | 5GB+ |
| **Python** | 3.12+ | Latest stable |
| **Node.js** | 18+ | Latest LTS |

## Installation

### Prerequisites

Before installing Telegram Utilities, ensure you have the following dependencies installed:

1. **Python 3.12+**
2. **Node.js 18+**
3. **FFmpeg** (for video conversion)
4. **ImageMagick** (for image processing)

### Installing Dependencies

#### FFmpeg Installation
```bash
# Windows (using Chocolatey)
choco install ffmpeg

# macOS (using Homebrew)
brew install ffmpeg

# Linux (Ubuntu/Debian)
sudo apt install ffmpeg
```

#### ImageMagick Installation
```bash
# Windows (using Chocolatey)
choco install imagemagick

# macOS (using Homebrew)
brew install imagemagick

# Linux (Ubuntu/Debian)
sudo apt install imagemagick
```

### Quick Start

```bash
# Clone the repository
git clone https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader.git
cd Telegram-Sticker-Maker-And-Auto-Uploader

# Install dependencies
pip install -r python/requirements.txt
npm install

# Launch application
npm start
```

### Detailed Installation

<details>
<summary><strong>🐍 Python Setup</strong></summary>

```bash
# Verify Python version
python --version  # Should be 3.12+

# Create virtual environment (recommended)
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install Python dependencies
pip install -r python/requirements.txt
```

</details>

<details>
<summary><strong>📦 Node.js Setup</strong></summary>

```bash
# Verify Node.js version
node --version  # Should be 18+
npm --version

# Install Node.js dependencies
npm install

# Optional: Install with yarn
yarn install
```

</details>

## Usage

### Getting Started

#### 1. 🚀 Launch Application
```bash
npm start
```

#### 2. 🔐 Telegram Authentication
1. Visit [my.telegram.org](https://my.telegram.org) to obtain API credentials
2. Enter your **API ID** and **API Hash**
3. Provide your **phone number** (with country code)
4. Enter the **verification code** sent to your Telegram
5. If enabled, enter your **2FA password**

> 💡 **Tip**: Your session is securely saved and will persist between app restarts

#### 3. 📁 Add Media Files

**Video Converter Supported Formats:**
- **Videos**: MP4, MOV, AVI, MKV, FLV, WebM

**Image Converter Supported Formats:**
- **Images**: PNG, JPG, JPEG, GIF, WEBP, BMP, TIFF

**Methods to Add Files:**
- **Drag & Drop**: Simply drag files into the application window
- **File Browser**: Click "Add Files" to browse and select
- **Batch Import**: Select multiple files at once

#### 4. ⚙️ Configure Settings

**Video Converter Settings:**
- **Output Directory**: Select where converted videos will be saved
- **Quality Settings**: Adjust quality parameters for output files

**Image Converter Settings:**
- **Output Format**: Choose between PNG or WebP
- **Quality Level**: Adjust compression quality (50-100)
- **Output Directory**: Select where processed images will be saved

**Sticker Pack Settings:**
- **Pack Name**: Display name for your sticker pack (1-64 characters)
- **URL Name**: Unique identifier (5-32 characters, alphanumeric + underscores)
- **Sticker Type**: Choose between Image or Video stickers
- **Auto-Skip Icon**: Toggle to automatically skip icon selection

#### 5. 🎨 Emoji Assignment
- **Auto-Assignment**: Intelligent emoji suggestions
- **Manual Selection**: Choose specific emojis for each sticker
- **Bulk Operations**: Apply emojis to multiple stickers

#### 6. 📤 Create & Publish
1. **Review**: Check all settings and file list
2. **Create**: Click "Create Sticker Pack"
3. **Monitor**: Track progress in real-time
4. **Complete**: Receive shareable pack URL

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# Logging Configuration
BACKEND_LOG_LEVEL=INFO            # Logging level (DEBUG, INFO, WARNING, ERROR)
BACKEND_LOG_TO_STDOUT=0           # Log to stdout (0 or 1)

# Telegram Settings
TELEGRAM_SESSION_TIMEOUT=3600     # Session timeout in seconds
TELEGRAM_RETRY_ATTEMPTS=3         # Number of retry attempts
TELEGRAM_REQUEST_DELAY=1          # Delay between requests in seconds
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit          # Unit tests
npm run test:integration   # Integration tests
npm run test:e2e          # End-to-end tests

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Development Mode

```bash
# Start in development mode with hot reload
npm run dev

# Start backend only
npm run dev:backend

# Start frontend only
npm run dev:frontend

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix
```

### Debugging

```bash
# Enable debug mode
BACKEND_LOG_LEVEL=DEBUG npm start

# Generate debug report
npm run debug:report

# Check system compatibility
npm run check:system
```

## Contributing

We welcome contributions from the community! Please follow these guidelines to ensure a smooth collaboration process.

### 🚀 Quick Start for Contributors

1. **Fork & Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/Telegram-Sticker-Maker-And-Auto-Uploader.git
   cd Telegram-Sticker-Maker-And-Auto-Uploader
   ```

2. **Set Up Development Environment**
   ```bash
   # Install dependencies
   pip install -r python/requirements.txt
   npm install
   
   # Install development tools
   pip install -r requirements-dev.txt
   npm install --dev
   ```

3. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

### 📋 Development Guidelines

#### Code Style
- **Python**: Follow [PEP 8](https://pep8.org/) with line length of 88 characters
- **JavaScript**: Use [ESLint](https://eslint.org/) with Airbnb configuration
- **CSS**: Follow [BEM methodology](http://getbem.com/)
- **Commits**: Use [Conventional Commits](https://conventionalcommits.org/)

#### Commit Message Format
```
type(scope): brief description

[optional body]

[optional footer]
```

**Examples:**
```bash
feat(ui): add drag and drop file upload
fix(api): resolve session timeout issue
docs(readme): update installation instructions
```

### 🧪 Testing Requirements

- **Unit Tests**: All new functions must have unit tests
- **Integration Tests**: API endpoints require integration tests
- **E2E Tests**: UI features need end-to-end test coverage
- **Code Coverage**: Maintain minimum 80% coverage

```bash
# Before submitting PR
npm run test:all
npm run lint
npm run build
```

### 📝 Pull Request Process

1. **Pre-submission Checklist**
   - [ ] Code follows style guidelines
   - [ ] Tests pass and coverage is maintained
   - [ ] Documentation is updated
   - [ ] CHANGELOG.md is updated
   - [ ] No merge conflicts

2. **PR Description Template**
   ```markdown
   ## Description
   Brief description of changes
   
   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update
   
   ## Testing
   - [ ] Unit tests pass
   - [ ] Integration tests pass
   - [ ] Manual testing completed
   
   ## Screenshots (if applicable)
   Add screenshots of UI changes
   ```

### 🐛 Reporting Issues

Use our issue templates for:
- **Bug Reports**: Include system info, steps to reproduce, expected vs actual behavior
- **Feature Requests**: Describe the use case, proposed solution, and alternatives
- **Performance Issues**: Include profiling data and system specifications

### 🎯 Areas for Contribution

- **🌐 Internationalization**: Add support for more languages
- **🎨 UI/UX**: Improve interface design and user experience
- **⚡ Performance**: Optimize processing speed and memory usage
- **🔌 Integrations**: Add support for other platforms
- **📖 Documentation**: Improve guides and API documentation
- **🧪 Testing**: Expand test coverage and add edge cases

## Troubleshooting

### Common Issues

<details>
<summary><strong>🔐 Authentication Issues</strong></summary>

**Problem**: "Invalid API credentials"
```bash
# Solution:
1. Verify API ID and Hash from my.telegram.org
2. Ensure phone number includes country code (+1234567890)
3. Check for typos in credentials
4. Clear session data: rm -rf sessions/
```

**Problem**: "Session expired"
```bash
# Solution:
1. Restart the application
2. Re-authenticate with fresh credentials
3. Check internet connection
```

</details>

<details>
<summary><strong>🎥 Media Processing Issues</strong></summary>

**Problem**: "FFmpeg not found"
```bash
# Windows (using Chocolatey)
choco install ffmpeg

# macOS (using Homebrew)
brew install ffmpeg

# Linux (Ubuntu/Debian)
sudo apt install ffmpeg
```

**Problem**: "ImageMagick not found"
```bash
# Windows (using Chocolatey)
choco install imagemagick

# macOS (using Homebrew)
brew install imagemagick

# Linux (Ubuntu/Debian)
sudo apt install imagemagick
```

**Problem**: "Conversion failed"
```bash
# Check file format support
# Supported: PNG, JPG, GIF, MP4, MOV, AVI
# Convert unsupported formats first
```

</details>

<details>
<summary><strong>💾 Performance Issues</strong></summary>

**Problem**: "High memory usage"
```bash
# Reduce concurrent processing
export STICKER_MAX_CONCURRENT=2

# Lower cache size
export STICKER_CACHE_SIZE=512

# Enable memory optimization
export STICKER_MEMORY_OPTIMIZATION=true
```

</details>

### Getting Help

- **📚 Documentation**: [Wiki](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/wiki)
- **💬 Discussions**: [GitHub Discussions](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/discussions)
- **🐛 Bug Reports**: [GitHub Issues](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/issues)
- **💡 Feature Requests**: [GitHub Issues](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/issues/new?template=feature_request.md)

## License

```
MIT License

Copyright (c) 2024 Rohit Poul

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Acknowledgments

- **[Telegram](https://telegram.org/)** for providing the Bot API and platform
- **[FFmpeg](https://ffmpeg.org/)** for powerful media processing capabilities
- **[ImageMagick](https://imagemagick.org/)** for image processing capabilities
- **[Electron](https://electronjs.org/)** for cross-platform desktop framework
- **[Telethon](https://docs.telethon.dev/)** for excellent Python Telegram client
- **[Flask](https://flask.palletsprojects.com/)** for lightweight web framework
- All contributors who help improve this project

---

<div align="center">

**Star ⭐ this repository if you find it helpful!**

[![GitHub stars](https://img.shields.io/github/stars/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader?style=social)](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader?style=social)](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/network)
[![GitHub watchers](https://img.shields.io/github/watchers/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader?style=social)](https://github.com/RohitPoul/Telegram-Sticker-Maker-And-Auto-Uploader/watchers)

**Made with ❤️ by [Rohit Poul](https://github.com/RohitPoul)**

</div>