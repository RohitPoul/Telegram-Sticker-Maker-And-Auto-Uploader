import os
import sys
import json
import logging
import subprocess
import threading
import time
import atexit
import tempfile
import signal
import re
import os
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import traceback
import queue
import platform
import shutil
import uuid

# Stats functions will be defined after logger is initialized

# Add the current directory to Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)
print(f"[INIT] Added to Python path: {current_dir}")
print(f"[INIT] Current working directory: {os.getcwd()}")
print(f"[INIT] Python path: {sys.path[:3]}")

# Import statistics tracker from separate module
from stats_tracker import stats_tracker

# Setup logging (quiet by default: no stdout)
log_level_name = os.getenv('BACKEND_LOG_LEVEL', 'INFO').upper()  # Temporarily set to INFO for debugging
log_level = getattr(logging, log_level_name, logging.ERROR)

handlers = [logging.FileHandler('backend.log', encoding='utf-8')]
if os.getenv('BACKEND_LOG_TO_STDOUT', '0') in ('1', 'true', 'TRUE'):
    handlers.append(logging.StreamHandler(stream=sys.stdout))

logging.basicConfig(
    level=log_level,
    format='%(asctime)s - %(name)s - %(levelname)s: %(message)s',
    handlers=handlers
)

# Fix Unicode encoding issues for Windows without detaching buffers
if sys.platform == 'win32':
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        # Best-effort; keep running even if reconfigure is not available
        pass
logger = logging.getLogger(__name__)

# Statistics are now handled by the centralized StatisticsTracker class
# All stats operations should use stats_tracker.increment_conversion(), 
# stats_tracker.increment_hexedit(), stats_tracker.increment_stickers(), etc.

# Statistics tracker is imported from separate module

# Import video converter (after logging configured)
try:
    print(f"[IMPORT] Attempting to import video_converter from {current_dir}")
    from video_converter import VideoConverterCore
    print(f"[IMPORT] VideoConverterCore imported successfully")
    video_converter = VideoConverterCore()
    print(f"[IMPORT] VideoConverterCore instantiated successfully")
    VIDEO_CONVERTER_AVAILABLE = True
    logger.info("[OK] Video converter imported successfully")

except ImportError as e:
    logger.warning(f"[ERROR] Video converter import failed: {e}. CWD={os.getcwd()} PYTHONPATH={sys.path}")
    VIDEO_CONVERTER_AVAILABLE = False
    video_converter = None

except Exception as e:
    logger.error(f"[ERROR] Video converter initialization failed: {e} ({type(e).__name__})")
    VIDEO_CONVERTER_AVAILABLE = False
    video_converter = None


# Flask app
app = Flask(__name__)

# Configure CORS properly
CORS(app, resources={
    r"/api/*": {
        "origins": "*",
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"]
    }
})

# Import shared state
from shared_state import (
    active_processes, process_lock, process_counter, 
    conversion_threads, get_next_process_id, add_process, 
    get_process, update_process, remove_process, get_all_processes,
    set_sticker_bot, get_sticker_bot, set_telegram_handler, get_telegram_handler
)

# Inject dependencies into video converter after global variables are declared
if VIDEO_CONVERTER_AVAILABLE and video_converter:
    video_converter.active_processes = active_processes
    video_converter.process_lock = process_lock
    logger.info("[OK] Dependencies injected into video converter")
else:
    logger.warning("[WARNING] Video converter not available, skipping dependency injection")

# After creating the Flask app
from telegram_connection_handler import get_telegram_handler

# Initialize the Telegram handler early but PRESERVE existing sessions
telegram_handler = get_telegram_handler()
logger.info("Telegram connection handler initialized with SESSION PRESERVATION in backend")

# MODIFIED: Only clean up lock files and temporary sessions, preserve main sessions
try:
    logger.info("BACKEND STARTUP: Cleaning only temporary files and locks, preserving sessions...")
    # Only clean up SQLite lock files and temporary sessions - NOT main session files
    cleanup_telegram_and_sessions()
    logger.info("BACKEND STARTUP: Lock cleanup completed - sessions preserved")
except Exception as e:
    logger.warning(f"BACKEND STARTUP: Error during lock cleanup: {e}")

# Configuration
class Config:
    SUPPORTED_INPUT_FORMATS = ["*.mp4", "*.avi", "*.mov", "*.mkv", "*.flv", "*.webm"]
    OUTPUT_FORMAT = "webm"
    TARGET_FILE_SIZE_KB = 254
    SCALE_WIDTH = 512
    SCALE_HEIGHT = 512
    HEXEDIT_TARGET_SEQUENCE = bytes([0x44, 0x89, 0x88, 0x40])
    HEXEDIT_REPLACEMENT_BYTES = bytes([0x00, 0x00])
    TEMP_DIR = os.path.join(tempfile.gettempdir(), "VideoConverterTemp")

    @classmethod
    def ensure_temp_dir(cls):
        os.makedirs(cls.TEMP_DIR, exist_ok=True)
        return cls.TEMP_DIR

def cleanup_processes():
    """Clean up all active processes"""
    global active_processes, conversion_threads
    logger.info("[CLEANUP] Starting process cleanup...")
    
    with process_lock:
        # Stop all conversion threads
        for process_id, thread_info in conversion_threads.items():
            if thread_info.get('thread') and thread_info['thread'].is_alive():
                logger.info(f"[CLEANUP] Stopping thread for process {process_id}")
                # Mark process as stopped
                if process_id in active_processes:
                    active_processes[process_id]["status"] = "stopped"
                    active_processes[process_id]["current_stage"] = "Process stopped"
        
        # Clear all processes
        active_processes.clear()
        conversion_threads.clear()
    
    logger.info("[CLEANUP] Process cleanup completed")

def cleanup_telegram_and_sessions():
    """Ensure Telegram disconnect and session files are released on exit."""
    try:
        logger.info("[CLEANUP] Starting comprehensive Telegram cleanup...")
        
        # Clean up sticker bot
        try:
            from sticker_bot import sticker_bot
            if sticker_bot:
                sticker_bot.cleanup_connection()
                logger.info("[CLEANUP] Sticker bot connection cleaned up")
        except Exception as e:
            logger.warning(f"[CLEANUP] Error cleaning up sticker bot: {e}")
        
        # Clean up telegram_connection_handler
        try:
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            if handler:
                # Force disconnect and cleanup
                handler.force_disconnect_and_cleanup()
                logger.info("[CLEANUP] Telegram handler cleaned up")
        except Exception as e:
            logger.warning(f"[CLEANUP] Error cleaning up telegram handler: {e}")
        
        # Force cleanup of all Telegram clients
        try:
            import gc
            gc.collect()
            logger.info("[CLEANUP] Forced garbage collection")
        except Exception as e:
            logger.warning(f"[CLEANUP] Error during garbage collection: {e}")
        
        # Enhanced session cleanup - only remove lock/journal files, keep main session
        session_patterns = [
            'temp_session_*.session*',  # Only temporary sessions
            '*.session-journal',        # SQLite journal files (safe to delete)
            '*.session-wal',           # SQLite WAL files (safe to delete)
            '*.session-shm',           # SQLite shared memory files
            'session_*.session-journal', # Session journal files (safe to delete)
            'session_*.session-wal',    # Session WAL files (safe to delete)
            'telegram_session_*.session-journal', # Phone-specific session journals
            'telegram_session_*.session-wal',     # Phone-specific session WAL files
        ]
        
        # Explicitly protect persistent session files
        protected_patterns = [
            'telegram_session.session',
            'telegram_session_*.session',  # Phone-specific session files (main files)
            'python/telegram_session.session',
            'python/telegram_session_*.session'
        ]
        
        cleaned_count = 0
        for pattern in session_patterns:
            for p in Path('.').glob(pattern):
                # Skip if this matches a protected pattern
                skip_file = False
                for protected in protected_patterns:
                    if p.match(protected):
                        logger.debug(f"[CLEANUP] Skipping protected file: {p}")
                        skip_file = True
                        break
                
                if skip_file:
                    continue
                    
                try:
                    p.unlink()
                    logger.info(f"[CLEANUP] Deleted {pattern}: {p}")
                    cleaned_count += 1
                except Exception as e:
                    logger.warning(f"[CLEANUP] Could not delete {p}: {e}")
        
        # Also clean up in python subdirectory
        python_dir = Path('python')
        if python_dir.exists():
            for pattern in session_patterns:
                for p in python_dir.glob(pattern):
                    # Skip if this matches a protected pattern
                    skip_file = False
                    for protected in protected_patterns:
                        if str(p).endswith(protected.replace('python/', '')):
                            logger.debug(f"[CLEANUP] Skipping protected file: {p}")
                            skip_file = True
                            break
                    
                    if skip_file:
                        continue
                        
                    try:
                        p.unlink()
                        logger.info(f"[CLEANUP] Deleted {pattern} from python/: {p}")
                        cleaned_count += 1
                    except Exception as e:
                        logger.warning(f"[CLEANUP] Could not delete {p}: {e}")
        
        logger.info(f"[CLEANUP] Cleaned up {cleaned_count} session/lock files while preserving persistent sessions")
        
        # Wait a moment for file handles to be released
        import time
        time.sleep(0.5)
        
        # Additionally, kill our app-related Python processes
        try:
            from kill_python_processes import kill_our_app_processes
            kill_results = kill_our_app_processes()
            logger.info(f"[CLEANUP] kill_our_app_processes results: {kill_results}")
        except Exception as e:
            logger.warning(f"[CLEANUP] Could not kill our app processes: {e}")
        
    except Exception as e:
        logger.warning(f"[CLEANUP] Enhanced session cleanup failed: {e}")

# Register cleanup handlers
atexit.register(cleanup_processes)
atexit.register(cleanup_telegram_and_sessions)

# Global flag to prevent multiple shutdown attempts
_SHUTDOWN_IN_PROGRESS = False

def graceful_shutdown(signum=None, frame=None):
    """Gracefully shut down the backend server."""
    global _SHUTDOWN_IN_PROGRESS
    
    if _SHUTDOWN_IN_PROGRESS:
        return
    
    _SHUTDOWN_IN_PROGRESS = True
    
    logger.info("Initiating graceful shutdown...")
    
    try:
        # Stop any running threads
        for thread in threading.enumerate():
            if thread != threading.main_thread():
                thread.join(timeout=5)
        
        # Close any open file handles or database connections
        # Add any specific cleanup logic here
        
        logger.info("Shutdown complete.")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")
        sys.exit(1)

# Register signal handlers only in main thread
try:
    signal.signal(signal.SIGINT, graceful_shutdown)
    signal.signal(signal.SIGTERM, graceful_shutdown)
except ValueError as e:
    # Signal handlers can only be registered in the main thread
    logger.warning(f"Could not register signal handlers: {e}")
    logger.warning("Signal handlers will not be available in this thread")

def validate_file_access(file_paths):
    """Validate that files exist and are accessible"""
    missing_files = []
    inaccessible_files = []
    
    for file_path in file_paths:
        if not os.path.exists(file_path):
            missing_files.append(file_path)
        elif not os.access(file_path, os.R_OK):
            inaccessible_files.append(file_path)
    
    return missing_files, inaccessible_files

@app.route('/api/clear-sticker-processes', methods=['POST', 'OPTIONS'], strict_slashes=False)
def clear_sticker_processes():
    """Clear all active sticker-related processes"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        with process_lock:
            # Find and remove sticker-related processes
            sticker_processes = {}
            for process_id, process_data in list(active_processes.items()):
                if process_data.get('type') == 'sticker' or process_id.startswith('sticker_'):
                    sticker_processes[process_id] = process_data
                    del active_processes[process_id]
            
            logger.info(f"[API] Cleared {len(sticker_processes)} sticker processes: {list(sticker_processes.keys())}")
        
        return jsonify({
            "success": True,
            "message": f"Cleared {len(sticker_processes)} sticker processes",
            "cleared_processes": list(sticker_processes.keys())
        })
        
    except Exception as e:
        logger.error(f"[API] Error clearing sticker processes: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Health check route
@app.route('/api/health', methods=['GET', 'OPTIONS'], strict_slashes=False)
def health_check():
    if request.method == 'OPTIONS':
        return '', 200
    
    # Check FFmpeg availability
    ffmpeg_available = False
    try:
        import subprocess
        result = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True, timeout=2)
        ffmpeg_available = result.returncode == 0
    except:
        ffmpeg_available = False
    
    return jsonify({
        "status": "healthy", 
        "timestamp": time.time(), 
        "success": True,
        "data": {
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "ffmpeg_available": ffmpeg_available
        }
    })





@app.route('/api/restart', methods=['POST', 'OPTIONS'], strict_slashes=False)
def restart_backend():
    """Restart the backend server"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        # Schedule a restart after sending response
        def restart():
            time.sleep(1)
            os._exit(0)  # This will cause the process to restart if managed by a process manager
        
        import threading
        threading.Thread(target=restart).start()
        
        return jsonify({
            'success': True,
            'message': 'Backend restart initiated'
        })
    except Exception as e:
        logger.error(f"Failed to restart backend: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# System info route
@app.route('/api/system-info', methods=['GET', 'OPTIONS'], strict_slashes=False)
def system_info():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        import platform
        info = {
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "platform": platform.system(),
            "platform_release": platform.release(),
            "platform_version": platform.version(),
            "architecture": platform.machine(),
            "processor": platform.processor()
        }
        return jsonify({"success": True, "data": info})
    except Exception as e:
        logger.error(f"Error getting system info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# System stats route
@app.route('/api/get-file-info', methods=['POST', 'OPTIONS'], strict_slashes=False)
def get_file_info():
    """Get detailed file metadata"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        data = request.get_json()
        file_path = data.get('path', '') if data else ''
        
        if not file_path or not os.path.exists(file_path):
            return jsonify({"success": False, "error": "File not found"}), 404
        
        # Get basic file stats
        stats = os.stat(file_path)
        file_info = {
            "name": os.path.basename(file_path),
            "size": stats.st_size,
            "size_formatted": format_file_size(stats.st_size),
            "modified": stats.st_mtime,
            "created": stats.st_ctime,
            "format": get_file_format(file_path)
        }
        
        # For images, get dimensions
        if file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp')):
            try:
                from PIL import Image
                with Image.open(file_path) as img:
                    file_info["width"], file_info["height"] = img.size
                    file_info["dimensions"] = f"{img.size[0]} × {img.size[1]}"
                    file_info["type"] = "image"
            except Exception as e:
                logger.warning(f"Could not get image info for {file_path}: {e}")
                file_info["type"] = "image"
        
        # For videos, get duration and dimensions
        elif file_path.lower().endswith(('.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv')):
            try:
                import subprocess
                import json
                
                # Get video metadata using ffprobe
                cmd = [
                    'ffprobe',
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_format',
                    '-show_streams',
                    file_path
                ]
                
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    metadata = json.loads(result.stdout)
                    
                    # Get duration
                    if 'format' in metadata and 'duration' in metadata['format']:
                        duration = float(metadata['format']['duration'])
                        file_info["duration"] = duration
                        file_info["duration_formatted"] = format_duration(duration)
                    
                    # Get dimensions and codec info from video stream
                    for stream in metadata.get('streams', []):
                        if stream.get('codec_type') == 'video':
                            file_info["width"] = stream.get('width')
                            file_info["height"] = stream.get('height')
                            if file_info["width"] and file_info["height"]:
                                file_info["dimensions"] = f"{file_info['width']} × {file_info['height']}"
                            file_info["codec"] = stream.get('codec_name', 'Unknown')
                            file_info["fps"] = eval(stream.get('r_frame_rate', '0/1')) if '/' in str(stream.get('r_frame_rate', '')) else 0
                            break
                    
                    file_info["type"] = "video"
                else:
                    logger.warning(f"ffprobe failed for {file_path}: {result.stderr}")
                    file_info["type"] = "video"
                    
            except Exception as e:
                logger.warning(f"Could not get video info for {file_path}: {e}")
                file_info["type"] = "video"
        else:
            # Other file types
            file_info["type"] = "other"
        
        return jsonify({"success": True, "data": file_info})
        
    except Exception as e:
        logger.error(f"Error getting file info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

def format_file_size(size_bytes):
    """Format file size in human readable format"""
    if size_bytes == 0:
        return "0 B"
    
    size_names = ["B", "KB", "MB", "GB", "TB"]
    import math
    i = int(math.floor(math.log(size_bytes, 1024)))
    p = math.pow(1024, i)
    s = round(size_bytes / p, 2)
    return f"{s} {size_names[i]}"

def format_duration(seconds):
    """Format duration in human readable format"""
    if seconds < 60:
        return f"{int(seconds)}s"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}m {secs}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        return f"{hours}h {minutes}m {secs}s"

def get_file_format(file_path):
    """Get file format/extension"""
    ext = os.path.splitext(file_path)[1].lower()
    return ext[1:] if ext else "unknown"

@app.route('/api/system-stats', methods=['GET', 'OPTIONS'], strict_slashes=False)
def system_stats():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # CPU and memory stats with live monitoring
        import psutil
        memory = psutil.virtual_memory()
        cpu_freq = psutil.cpu_freq()
        
        return jsonify({
            "success": True,
            "stats": {
                'cpu': {
                    'count': psutil.cpu_count(logical=False),
                    'threads': psutil.cpu_count(logical=True),
                    'percent': psutil.cpu_percent(interval=0.1),
                    'frequency': cpu_freq.current if cpu_freq else 0
                },
                'memory': {
                    'total': memory.total // (1024 * 1024),
                    'used': memory.used // (1024 * 1024),
                    'free': memory.available // (1024 * 1024),
                    'percent': memory.percent
                }
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting system stats: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# FFmpeg status route
@app.route('/api/ffmpeg-status', methods=['GET', 'OPTIONS'], strict_slashes=False)
def ffmpeg_status():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # Check if ffmpeg is available
        result = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True, timeout=5)
        ffmpeg_available = result.returncode == 0
        version_info = result.stdout.split('\n')[0] if ffmpeg_available else None
        
        return jsonify({
            "success": True,
            "data": {
                "ffmpeg_available": ffmpeg_available,
                "version": version_info
            }
        })
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return jsonify({
            "success": True,
            "data": {
                "ffmpeg_available": False,
                "version": None
            }
        })
    except Exception as e:
        logger.error(f"Error checking ffmpeg status: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Clear session route
@app.route('/api/clear-session', methods=['POST', 'OPTIONS'], strict_slashes=False)
def clear_session():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # Smart session clearing - only clear temporary sessions
        temp_session_files = Path('.').glob('temp_session_*.session*')
        cleared_count = 0
        for session_file in temp_session_files:
            try:
                session_file.unlink()
                logger.info(f"Deleted temporary session file: {session_file}")
                cleared_count += 1
            except Exception as e:
                logger.warning(f"Failed to delete temp session file {session_file}: {e}")
        
        # Also clear lock files
        lock_files = Path('.').glob('*.session-journal')
        for lock_file in lock_files:
            try:
                lock_file.unlink()
                logger.info(f"Deleted session lock file: {lock_file}")
                cleared_count += 1
            except Exception as e:
                logger.warning(f"Failed to delete lock file {lock_file}: {e}")
        
        logger.info(f"Cleared {cleared_count} temporary session files")
        
        # Clear any temp files
        if os.path.exists(Config.TEMP_DIR):
            try:
                import shutil
                shutil.rmtree(Config.TEMP_DIR)
                logger.info(f"Cleared temp directory: {Config.TEMP_DIR}")
            except Exception as e:
                logger.warning(f"Failed to clear temp directory: {e}")
        
        return jsonify({"success": True, "message": "Session cleared"})
    except Exception as e:
        logger.error(f"Error clearing session: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Video analysis route
@app.route('/api/analyze-video', methods=['POST', 'OPTIONS'], strict_slashes=False)
def analyze_video():
    if request.method == 'OPTIONS':
        return '', 200

    try:
        data = request.get_json()
        if not data or 'file_path' not in data:
            return jsonify({"success": False, "error": "No file path provided"}), 400

        file_path = data['file_path']
        
        if not os.path.exists(file_path):
            return jsonify({"success": False, "error": "File not found"}), 404

        if not VIDEO_CONVERTER_AVAILABLE:
            return jsonify({"success": False, "error": "Video converter not available"}), 500

        # Get video info
        duration, width, height = video_converter.get_video_info(file_path)
        file_size = os.path.getsize(file_path)

        # Format the data
        size_mb = file_size / (1024 * 1024)
        duration_str = f"{duration:.1f}s" if duration else "Unknown"
        size_str = f"{size_mb:.1f}MB" if file_size else "Unknown"

        return jsonify({
            "success": True,
            "data": {
                "duration": duration_str,
                "size": size_str,
                "width": width,
                "height": height,
                "file_size_bytes": file_size
            }
        })

    except Exception as e:
        logger.error(f"Video analysis error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# COMPLETELY FIXED Video conversion route
@app.route('/api/convert-videos', methods=['POST', 'OPTIONS'], strict_slashes=False)
def start_video_conversion():
    global process_counter, conversion_threads
    
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        logger.info("[API] start_video_conversion endpoint called")
        
        # Get and validate JSON data
        data = request.get_json()
        if not data:
            logger.error("[API] No JSON data received")
            logger.error(f"[API] Request headers: {request.headers}")
            logger.error(f"[API] Request method: {request.method}")
            logger.error(f"[API] Request content type: {request.content_type}")
            return jsonify({"success": False, "error": "No data provided"}), 400

        # Log received data for debugging
        logger.info(f"[API] Received conversion request data: {data}")
        logger.info(f"[API] Request content type: {request.content_type}")
        logger.info(f"[API] Request method: {request.method}")
        logger.info(f"[API] Request headers: {dict(request.headers)}")

        # Extract and validate parameters
        input_files = data.get('files', [])
        output_dir = data.get('output_dir', '')
        settings = data.get('settings', {})
        process_id = data.get('process_id', f"conversion-{int(time.time())}")  # Generate unique process ID

        logger.info(f"[API] Files: {len(input_files)}")
        logger.info(f"[API] Output: {output_dir}")
        logger.info(f"[API] Process ID: {process_id}")

        # Check for existing process
        with process_lock:
            if process_id in active_processes:
                existing_process = active_processes[process_id]
                if existing_process.get('status') in ['processing', 'initializing']:
                    return jsonify({
                        "success": False, 
                        "error": "A process with this ID is already in progress",
                        "existing_process_status": existing_process.get('status')
                    }), 400

        if not input_files:
            return jsonify({"success": False, "error": "No files provided"}), 400
        if not output_dir:
            return jsonify({"success": False, "error": "No output directory provided"}), 400

        # Validate file access
        missing_files, inaccessible_files = validate_file_access(input_files)
        if missing_files:
            logger.error(f"[API] Missing files: {missing_files}")
            return jsonify({
                "success": False,
                "error": f"Files not found: {missing_files[:3]}..."
            }), 400

        if inaccessible_files:
            logger.error(f"[API] Inaccessible files: {inaccessible_files}")
            return jsonify({
                "success": False,
                "error": f"Cannot read files: {inaccessible_files[:3]}..."
            }), 400

        # Create output directory
        try:
            os.makedirs(output_dir, exist_ok=True)
            logger.info(f"[API] Output directory ready: {output_dir}")
        except Exception as e:
            logger.error(f"[API] Cannot create output directory: {e}")
            return jsonify({
                "success": False,
                "error": f"Cannot create output directory: {str(e)}"
            }), 400

        # Check video converter availability
        if not VIDEO_CONVERTER_AVAILABLE or not video_converter:
            logger.error("[API] Video converter not available")
            return jsonify({
                "success": False,
                "error": "Video converter module not loaded"
            }), 500

        # CRITICAL FIX: Initialize process tracking ATOMICALLY AND FIRST
        with process_lock:
            logger.info(f"[API] Initializing process {process_id}")
            
            # Initialize process data
            active_processes[process_id] = {
                "type": "video_conversion",
                "total_files": len(input_files),
                "completed_files": 0,
                "failed_files": 0,
                "progress": 0,
                "status": "initializing",
                "current_file": "",
                "current_stage": "Initializing conversion...",
                "file_statuses": {},
                "start_time": time.time(),
                "input_files": input_files.copy(),
                "output_dir": output_dir,
                "settings": settings.copy(),
                "paused": False,
                "can_pause": True
            }

            # Initialize file statuses immediately
            for i, input_file in enumerate(input_files):
                filename = os.path.basename(input_file)
                active_processes[process_id]["file_statuses"][i] = {
                    'status': 'pending',
                    'progress': 0,
                    'stage': 'Ready to convert',
                    'filename': filename
                }
            
            logger.info(f"[API] Process {process_id} initialized successfully with {len(input_files)} files")
            logger.info(f"[API] Active processes now: {list(active_processes.keys())}")

        # Pre-flight FFmpeg check
        import shutil
        if shutil.which('ffmpeg') is None:
            return jsonify({"success": False, "error": "FFmpeg not found"}), 500

        # Start conversion in background thread
        def conversion_thread():
            try:
                logger.info(f"[THREAD] Starting conversion thread for {process_id}")
                
                # Update status to processing
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["status"] = "processing"
                        active_processes[process_id]["current_stage"] = "Starting batch conversion..."

                # Check if video converter is available
                if not VIDEO_CONVERTER_AVAILABLE or not video_converter:
                    logger.error(f"[THREAD] Video converter not available!")
                    raise Exception("Video converter not available")

                logger.info(f"[THREAD] Calling video_converter.batch_convert with {len(input_files)} files")

                # Use video converter with timeout protection
                try:
                    results = video_converter.batch_convert(
                        input_files=input_files,
                        output_dir=output_dir,
                        process_id=process_id
                    )
                except Exception as convert_error:
                    logger.error(f"[THREAD] Conversion failed: {convert_error}")
                    results = [{"success": False, "error": str(convert_error)} for _ in input_files]
                
                logger.info(f"[THREAD] batch_convert returned {len(results)} results")

                # Update final status
                with process_lock:
                    if process_id in active_processes:
                        successful_files = sum(1 for r in results if r.get("success", False))
                        active_processes[process_id].update({
                            "status": "completed" if successful_files > 0 else "failed",
                            "progress": 100,
                            "completed_files": successful_files,
                            "failed_files": len(results) - successful_files,
                            "current_stage": f"Completed! {successful_files}/{len(results)} files processed",
                            "end_time": time.time(),
                            "results": results,
                            "can_pause": False
                        })
                        
                        logger.info(f"[THREAD] Conversion completed: {successful_files}/{len(results)} successful")
    
            except Exception as e:
                logger.error(f"[THREAD] Critical error in conversion thread: {e}")
                logger.error(traceback.format_exc())
                
                # Increment failed stats if the entire thread fails using centralized StatisticsTracker
                try:
                    stats_tracker.increment_conversion(success=False)
                except Exception as stats_error:
                    logger.error(f"[THREAD] Failed to increment failed stats: {stats_error}")
                
                # Update process status to failed
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id].update({
                            "status": "failed",
                            "current_stage": f"Conversion failed: {str(e)}",
                            "end_time": time.time(),
                            "can_pause": False
                        })
                
                raise

        # Start the thread and track it
        thread = threading.Thread(target=conversion_thread, daemon=True)
        thread.start()
        
        # Store thread reference for cleanup
        conversion_threads[process_id] = {
            "thread": thread,
            "start_time": time.time()
        }

        logger.info(f"[API] Conversion started successfully! Process ID: {process_id}")
        
        # Verify process exists before returning
        with process_lock:
            if process_id not in active_processes:
                logger.error(f"[API] CRITICAL: Process {process_id} not found after initialization!")
                return jsonify({"success": False, "error": "Process initialization failed"}), 500

        response = {
            "success": True,
            "data": {
                "process_id": process_id  # Let the UI know!
            }
        }
        
        # Add detailed logging
        logger.info(f"[API] Sending response: {response}")
        logger.info(f"[API] Response data keys: {list(response['data'].keys())}")
        logger.info(f"[API] Process ID in response: {response['data'].get('process_id')}")
        logger.info(f"[API] Response JSON: {json.dumps(response)}")
        
        return jsonify(response), 200

    except Exception as e:
        logger.error(f"[API] Critical error in start_video_conversion: {e}", exc_info=True)
        return jsonify({"success": False, "error": f"Server error: {str(e)}"}), 500

# COMPLETELY FIXED Progress tracking route - Fixed route parameter
@app.route('/api/conversion-progress/<process_id>', methods=['GET', 'OPTIONS'])
def get_conversion_progress(process_id):
    """
    Returns JSON with current progress for a running process.
    The renderer polls this every 750 ms.
    """
    if request.method == 'OPTIONS':
        return '', 200
    
    with process_lock:
        proc = active_processes.get(process_id)
        if not proc:
            # Provide detailed debugging information
            available_processes = list(active_processes.keys())
            logger.warning(f"[PROGRESS] Process {process_id} not found. Available processes: {available_processes}")
            return jsonify({
                "success": False,
                "error": f"Process {process_id} not found. Available processes: {available_processes}",
                "available_processes": available_processes,
                "process_count": len(active_processes),
                "status": 404
            }), 404
        
        # Add detailed logging for debugging
        file_statuses = proc.get('file_statuses', {})
        logger.info(f"[PROGRESS] Process {process_id} status: {proc.get('status', 'unknown')}")
        logger.info(f"[PROGRESS] Process {process_id} progress: {proc.get('progress', 0)}")
        logger.info(f"[PROGRESS] Process {process_id} file_statuses count: {len(file_statuses)}")
        if file_statuses:
            for idx, fs in file_statuses.items():
                logger.info(f"[PROGRESS] File {idx}: status={fs.get('status')}, progress={fs.get('progress')}, stage={fs.get('stage')}")
        
        response_data = {
            "success": True,
            "data": {
                "progress": proc.get("progress", 0),
                "status": proc.get("status", "unknown"),
                "current_stage": proc.get("current_stage", ""),
                "current_file": proc.get("current_file", ""),
                "total_files": proc.get("total_files", 0),
                "completed_files": proc.get("completed_files", 0),
                "failed_files": proc.get("failed_files", 0),
                "file_statuses": proc.get("file_statuses", {}),
                "paused": proc.get("paused", False),
                "can_pause": proc.get("can_pause", False)
            }
        }
        
        logger.info(f"[PROGRESS] Returning response for {process_id}: {response_data}")
        
        return jsonify(response_data)

@app.route('/api/process-status/<process_id>', methods=['GET', 'OPTIONS'])
def get_process_status(process_id):
    """
    OPTIMIZED: Returns JSON with current status for any process - reduced logging for performance.
    """
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        # FIXED: Sanitize process_id to prevent [Errno 22] Invalid argument
        safe_process_id = re.sub(r'[^a-zA-Z0-9_-]', '_', str(process_id))[:50]
        
        with process_lock:
            if safe_process_id not in active_processes:
                # Look for original process_id as fallback
                if process_id in active_processes:
                    safe_process_id = process_id
                else:
                    return jsonify({"success": False, "error": "Process not found"}), 404
            
            process_data = active_processes[safe_process_id]
            
            # Calculate progress percentage
            total_files = process_data.get('total_files', 1)
            completed_files = process_data.get('completed_files', 0)
            failed_files = process_data.get('failed_files', 0)
            
            if total_files > 0:
                progress_percentage = ((completed_files + failed_files) / total_files) * 100
            else:
                progress_percentage = 0
            
            response_data = {
                "process_id": safe_process_id,
                "status": process_data.get('status', 'unknown'),
                "current_stage": process_data.get('current_stage', 'Unknown'),
                "progress": round(progress_percentage, 2),
                "total_files": total_files,
                "completed_files": completed_files,
                "failed_files": failed_files,
                "current_file": process_data.get('current_file', ''),
                "start_time": process_data.get('start_time', 0),
                "type": process_data.get('type', 'unknown'),
                "file_statuses": process_data.get('file_statuses', {}),
                "paused": process_data.get('paused', False),
                # OPTIMIZED: Add fields for sticker creation
                "waiting_for_user": process_data.get('waiting_for_user', False),
                "waiting_for_url_name": process_data.get('waiting_for_url_name', False),
                "icon_request_message": process_data.get('icon_request_message', ''),
                # ENHANCED: Include auto-skip flag to prevent duplicate skip commands
                "auto_skip_icon": process_data.get('auto_skip_icon', True),
                # Include flag to indicate if auto-skip has been handled by backend
                "auto_skip_handled": process_data.get('auto_skip_handled', False),
                # ENHANCED: Include shareable link for completed sticker packs with detailed logging
                "shareable_link": process_data.get('shareable_link', ''),
                "url_name_taken": process_data.get('url_name_taken', False),
                "original_url_name": process_data.get('original_url_name', ''),
                "url_name_attempts": process_data.get('url_name_attempts', 0),
                "max_url_attempts": process_data.get('max_url_attempts', 3)
            }

            # ENHANCED DEBUG: Log detailed information for completed processes
            if process_data.get('status') == 'completed':
                logger.info(f"[API] COMPLETED PROCESS DEBUG for {safe_process_id}:")
                logger.info(f"[API]   - Status: {process_data.get('status')}")
                logger.info(f"[API]   - Shareable link: {process_data.get('shareable_link', 'NOT_FOUND')}")
                logger.info(f"[API]   - All process data keys: {list(process_data.keys())}")
                logger.info(f"[API]   - Response data shareable_link: {response_data.get('shareable_link', 'NOT_FOUND')}")
            
            return jsonify({
                "success": True,
                "data": response_data
            })
    except Exception as e:
        logger.error(f"Error getting process status for {process_id}: {e}")
        return jsonify({"success": False, "error": "Internal server error"}), 500

@app.route('/api/debug/active-processes', methods=['GET', 'OPTIONS'])
def debug_active_processes():
    """OPTIMIZED: Debug endpoint with reduced logging"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        with process_lock:
            return jsonify({
                "success": True,
                "data": {
                    "processes": list(active_processes.keys()),
                    "count": len(active_processes),
                    "details": {pid: {"type": pdata.get('type', 'unknown'), "status": pdata.get('status', 'unknown')} for pid, pdata in active_processes.items()}
                }
            })
    except Exception as e:
        logger.error(f"Debug API error: {e}")
        return jsonify({"success": False, "error": "Internal server error"}), 500

# New route to stop a process
@app.route('/api/stop-process', methods=['POST','OPTIONS'], strict_slashes=False)
def stop_process():
    """
    Hard-stop an active process (conversion or hex-edit).  
    Renderer calls this when user deletes a file or closes the GUI.
    """
    if request.method == 'OPTIONS':
        return '', 200

    data = request.get_json(force=True)
    pid  = data.get('process_id', '') if data else ''
    if not pid:
        return jsonify({"success":False,"error":"process_id required"}),400

    with process_lock:
        if pid == 'ALL':
            # Stop all processes gracefully
            for p in active_processes.values():
                p["status"] = "stopped"
                p["current_stage"] = "Stopped by user"
                p["can_pause"] = False
                p["paused"] = False
            # Threads are daemonic and will exit; cleanup maps
            active_processes.clear()
            conversion_threads.clear()
            return jsonify({"success": True})

        proc = active_processes.get(pid)
        if not proc:
            return jsonify({"success":False,"error":"Process not found"}),404
        proc["status"]         = "stopped"
        proc["current_stage"]  = "Stopped by user"
        proc["can_pause"]      = False
        proc["paused"]         = False
        # Thread will read this flag on next loop iteration
    return jsonify({"success":True})

# Pause operation route
@app.route('/api/pause-operation', methods=['POST', 'OPTIONS'], strict_slashes=False)
def pause_operation():
    if request.method == 'OPTIONS':
        return '', 200

    try:
        data = request.get_json()
        process_id = data.get('process_id', '') if data else ''

        with process_lock:
            if process_id not in active_processes:
                return jsonify({"success": False, "error": "Process not found"}), 404

            active_processes[process_id]["paused"] = True
            active_processes[process_id]["current_stage"] = "Operation paused by user"

        logger.info(f"[API] Process {process_id} paused")
        return jsonify({"success": True, "message": "Operation paused"})

    except Exception as e:
        logger.error(f"[API] Pause operation error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Resume operation route
@app.route('/api/resume-operation', methods=['POST', 'OPTIONS'], strict_slashes=False)
def resume_operation():
    if request.method == 'OPTIONS':
        return '', 200

    try:
        data = request.get_json()
        process_id = data.get('process_id', '') if data else ''

        with process_lock:
            if process_id not in active_processes:
                return jsonify({"success": False, "error": "Process not found"}), 404

            active_processes[process_id]["paused"] = False
            active_processes[process_id]["current_stage"] = "Operation resumed"

        logger.info(f"[API] Process {process_id} resumed")
        return jsonify({"success": True, "message": "Operation resumed"})

    except Exception as e:
        logger.error(f"[API] Resume operation error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# COMPLETELY FIXED Hex edit route
@app.route('/api/hex-edit', methods=['POST', 'OPTIONS'], strict_slashes=False)
def hex_edit_files():
    global process_counter, conversion_threads
    
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        logger.info("[API] hex_edit_files endpoint called")
        
        # Get JSON data
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400

        input_files = data.get('files', [])
        output_dir = data.get('output_dir', '')
        process_id = data.get('process_id', '') or f"hex_{int(time.time())}_{uuid.uuid4().hex[:8]}"

        logger.info(f"[API] Received hex edit request: {len(input_files)} files")
        logger.info(f"[API] Process ID: {process_id}")

        if not input_files:
            return jsonify({"success": False, "error": "No files provided"}), 400
        if not output_dir:
            return jsonify({"success": False, "error": "No output directory provided"}), 400

        # Validate files exist and are webm
        invalid_files = []
        for file_path in input_files:
            if not os.path.exists(file_path):
                invalid_files.append(f"File not found: {file_path}")
            elif not file_path.lower().endswith('.webm'):
                invalid_files.append(f"Not a WEBM file: {file_path}")

        if invalid_files:
            return jsonify({
                "success": False,
                "error": f"Invalid files: {invalid_files}"
            }), 400

        # Create output directory
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            return jsonify({
                "success": False,
                "error": f"Cannot create output directory: {str(e)}"
            }), 400

        # Check if video converter is available
        if not VIDEO_CONVERTER_AVAILABLE or not video_converter:
            return jsonify({
                "success": False,
                "error": "Video converter not available"
            }), 500

        # Initialize process tracking ATOMICALLY
        with process_lock:
            active_processes[process_id] = {
                "type": "hex_edit",
                "total_files": len(input_files),
                "completed_files": 0,
                "failed_files": 0,
                "progress": 0,
                "status": "initializing",
                "current_file": "",
                "current_stage": "Initializing hex edit...",
                "file_statuses": {},
                "start_time": time.time(),
                "input_files": input_files,
                "output_dir": output_dir,
                "paused": False,
                "can_pause": True
            }

            # Initialize file statuses immediately
            for i, input_file in enumerate(input_files):
                filename = os.path.basename(input_file)
                active_processes[process_id]["file_statuses"][i] = {
                    'status': 'pending',
                    'progress': 0,
                    'stage': 'Waiting for hex edit...',
                    'filename': filename
                }

        # Start hex edit in background thread
        def hex_edit_thread():
            try:
                logger.info(f"[THREAD] Starting hex edit thread for {process_id}")

                # Update status to processing
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["status"] = "processing"
                        active_processes[process_id]["current_stage"] = "Starting batch hex edit..."

                # Use video converter for batch hex editing
                results = video_converter.batch_hex_edit(
                    input_files=input_files,
                    output_dir=output_dir,
                    process_id=process_id
                )

                # Update final status
                with process_lock:
                    if process_id in active_processes:
                        successful_files = sum(1 for r in results if r.get("success"))
                        active_processes[process_id].update({
                            "status": "completed",
                            "progress": 100,
                            "completed_files": successful_files,
                            "failed_files": len(results) - successful_files,
                            "current_stage": f"Hex edit completed! {successful_files}/{len(results)} files processed",
                            "end_time": time.time(),
                            "results": results,
                            "can_pause": False
                        })
                        
                        # Statistics are now updated in video_converter.py

                # Clean up thread reference
                if process_id in conversion_threads:
                    del conversion_threads[process_id]

                logger.info(f"[THREAD] Hex edit thread completed for {process_id}")

            except Exception as e:
                logger.error(f"[THREAD] Hex edit thread error for {process_id}: {e}")
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id].update({
                            "status": "error",
                            "current_stage": f"Error: {str(e)}",
                            "end_time": time.time(),
                            "can_pause": False
                        })
                
                # Clean up thread reference
                if process_id in conversion_threads:
                    del conversion_threads[process_id]

        # Start the thread and track it
        thread = threading.Thread(target=hex_edit_thread, daemon=True)
        thread.start()
        
        # Store thread reference for cleanup
        conversion_threads[process_id] = {
            "thread": thread,
            "start_time": time.time()
        }

        return jsonify({"success": True, "process_id": process_id})

    except Exception as e:
        logger.error(f"[API] Hex edit error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Clean up finished processes route
@app.route('/api/cleanup-processes', methods=['POST', 'OPTIONS'], strict_slashes=False)
def cleanup_finished_processes():
    if request.method == 'OPTIONS':
        return '', 200

    try:
        with process_lock:
            finished_processes = []
            current_time = time.time()
            
            for process_id, process in list(active_processes.items()):
                # Remove processes that have been completed for more than 5 minutes
                if (process.get('status') in ['completed', 'error'] and 
                    process.get('end_time', 0) > 0 and 
                    current_time - process.get('end_time', 0) > 300):
                    
                    finished_processes.append(process_id)
                    del active_processes[process_id]
                    
                    # Also clean up thread reference
                    if process_id in conversion_threads:
                        del conversion_threads[process_id]
            
            logger.info(f"[CLEANUP] Cleaned up {len(finished_processes)} finished processes")
            
            return jsonify({
                "success": True,
                "cleaned_processes": finished_processes,
                "remaining_processes": list(active_processes.keys())
            })

    except Exception as e:
        logger.error(f"[API] Process cleanup error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Debug endpoint for active processes
@app.route('/api/debug/processes', methods=['GET'], strict_slashes=False)
def get_active_processes():
    """Debug endpoint to see active processes"""
    with process_lock:
        processes_info = {}
        for pid, process in active_processes.items():
            processes_info[pid] = {
                "type": process.get("type"),
                "status": process.get("status"),
                "progress": process.get("progress"),
                "total_files": process.get("total_files"),
                "completed_files": process.get("completed_files"),
                "current_stage": process.get("current_stage"),
                "can_pause": process.get("can_pause", False),
                "paused": process.get("paused", False)
            }
    
    return jsonify({
        "success": True,
        "active_processes": processes_info,
        "count": len(processes_info)
    })


# Import and register sticker bot routes (if available)
try:
    from sticker_bot import register_sticker_routes
    
    # Register all sticker bot routes properly
    register_sticker_routes(app)
    logger.info("Sticker bot routes registered successfully")

except ImportError as e:
    logger.warning(f"Could not import sticker bot routes: {e}")
except Exception as e:
    logger.error(f"Error registering sticker bot routes: {e}")

@app.route('/api/backend-status', methods=['GET', 'OPTIONS'], strict_slashes=False)
def backend_status():
    """Get real backend status with live monitoring"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # Check if backend is responsive with live stats
        status = "Connected"
        try:
            # Live health check with CPU/memory monitoring
            import psutil
            cpu_usage = psutil.cpu_percent()
            memory_usage = psutil.virtual_memory().percent
            status = f"Connected (CPU: {cpu_usage:.1f}%, RAM: {memory_usage:.1f}%)"
        except:
            status = "Connected"
        
        return jsonify({
            "success": True, 
            "status": status,
            "uptime": stats_tracker.get_stats().get("uptime_seconds", 0)
        })
    except Exception as e:
        logger.error(f"Error getting backend status: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/database-stats', methods=['GET', 'OPTIONS'], strict_slashes=False)
def get_database_stats():
    """Get database statistics from centralized StatisticsTracker"""
    logger.info("[API] Received database-stats request")
    
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        stats = stats_tracker.get_stats()
        logger.info(f"[API] Retrieved database stats: {stats}")
        return jsonify({
            "success": True,
            "data": stats
        })
    except Exception as e:
        logger.error(f"[API] Error fetching database stats: {str(e)}", exc_info=True)
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/reset-stats', methods=['POST', 'OPTIONS'], strict_slashes=False)
def reset_stats():
    """Reset all statistics"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        stats_tracker.reset_stats()
        return jsonify({"success": True, "message": "Statistics reset successfully"})
    except Exception as e:
        logger.error(f"Error resetting stats: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/stats/increment-stickers', methods=['POST', 'OPTIONS'], strict_slashes=False)
def increment_sticker_stats():
    """Increment sticker creation statistics"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        data = request.get_json()
        count = data.get('count', 1) if data else 1
        
        # Validate count
        try:
            count = max(int(count), 0)
        except (ValueError, TypeError):
            count = 1
        
        # Increment stats
        stats_tracker.increment_stickers(count)
        
        logger.info(f"[STATS] Incremented sticker creation count by {count}")
        
        return jsonify({
            "success": True,
            "message": f"Sticker stats incremented by {count}",
            "count": count
        })
        
    except Exception as e:
        logger.error(f"Error incrementing sticker stats: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/clear-logs', methods=['POST', 'OPTIONS'], strict_slashes=False)
def clear_logs():
    """Clear application logs"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # Only clear important logs - backend.log and connection debug log
        log_files = [
            "backend.log",
            "python/backend.log",
            "logs/telegram_connection_debug.log"
        ]
        
        cleared_files = []
        for log_file in log_files:
            if os.path.exists(log_file):
                try:
                    with open(log_file, 'w') as f:
                        f.write("")  # Clear the file
                    cleared_files.append(log_file)
                except Exception as e:
                    logger.warning(f"Could not clear {log_file}: {e}")
        
        return jsonify({
            "success": True, 
            "message": f"Cleared {len(cleared_files)} log files",
            "cleared_files": cleared_files
        })
    except Exception as e:
        logger.error(f"Error clearing logs: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/clear-credentials', methods=['POST', 'OPTIONS'], strict_slashes=False)
def clear_credentials():
    """Clear saved credentials"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        credential_files = [
            "python/telegram_credentials.json",
            "telegram_credentials.json"
        ]
        
        cleared_files = []
        for cred_file in credential_files:
            if os.path.exists(cred_file):
                try:
                    os.remove(cred_file)
                    cleared_files.append(cred_file)
                except Exception as e:
                    logger.warning(f"Could not remove {cred_file}: {e}")
        
        return jsonify({
            "success": True, 
            "message": f"Cleared {len(cleared_files)} credential files",
            "cleared_files": cleared_files
        })
    except Exception as e:
        logger.error(f"Error clearing credentials: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/kill-python-processes', methods=['POST', 'OPTIONS'], strict_slashes=False)
def kill_python_processes():
    """Kill all Python processes except the current one"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        # Import the kill script
        from kill_python_processes import kill_python_processes
        
        logger.info("Kill Python processes requested")
        results = kill_python_processes()
        
        if results['success']:
            message = f"Killed {results['killed_count']} Python processes"
            if results['errors']:
                message += f" (with {len(results['errors'])} warnings)"
            
            return jsonify({
                "success": True,
                "message": message,
                "killed_count": results['killed_count'],
                "errors": results['errors']
            })
        else:
            return jsonify({
                "success": False,
                "error": "Failed to kill Python processes",
                "details": results['errors']
            }), 500
            
    except Exception as e:
        logger.error(f"Error killing Python processes: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/force-cleanup-sessions', methods=['POST', 'OPTIONS'], strict_slashes=False)
def force_cleanup_sessions():
    """Force cleanup of all session files and lock files"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        logger.info("Force cleanup sessions requested")
        
        # Call the cleanup function
        cleanup_telegram_and_sessions()
        
        # Also try to kill any lingering Python processes (only our app's processes)
        try:
            from kill_python_processes import kill_our_app_processes
            kill_results = kill_our_app_processes()
            logger.info(f"Kill results: {kill_results}")
        except Exception as e:
            logger.warning(f"Could not kill Python processes: {e}")
        
        return jsonify({
            "success": True, 
            "message": "Force cleanup completed - all session files and lock files removed"
        })
        
    except Exception as e:
        logger.error(f"Error during force cleanup: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/kill-our-processes', methods=['POST', 'OPTIONS'], strict_slashes=False)
def kill_our_processes():
    """Kill only Python processes related to our app"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        logger.info("Kill our app processes requested")
        
        # Import the kill script
        from kill_python_processes import kill_our_app_processes
        
        results = kill_our_app_processes()
        
        if results['success']:
            message = f"Killed {results['killed_count']} of our app's Python processes"
            if results['errors']:
                message += f" (with {len(results['errors'])} warnings)"
            
            return jsonify({
                "success": True,
                "message": message,
                "killed_count": results['killed_count'],
                "errors": results['errors']
            })
        else:
            return jsonify({
                "success": False,
                "error": "Failed to kill our app's processes",
                "details": results['errors']
            }), 500
            
    except Exception as e:
        logger.error(f"Error killing our app's processes: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Error handlers
@app.errorhandler(404)
def not_found(error):
    logger.warning(f"404 error: {request.url}")
    return jsonify({"success": False, "error": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"500 error: {error}")
    return jsonify({"success": False, "error": "Internal server error"}), 500

@app.route('/api/telegram/session-status', methods=['GET', 'OPTIONS'], strict_slashes=False)
def telegram_session_status():
    """Get Telegram session file status with proper disconnection detection"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        from sticker_bot import sticker_bot
        from telegram_connection_handler import get_telegram_handler
        
        session_info = {
            "session_file": None,
            "session_exists": False,
            "session_valid": False
        }
        
        # Check telegram_connection_handler first (primary source)
        handler = get_telegram_handler()
        if handler:
            logger.debug("[SESSION_STATUS] Checking handler session...")
            try:
                # Check if handler has a client
                if handler._client:
                    # Get session file from client
                    if hasattr(handler._client, 'session') and getattr(handler._client.session, 'filename', None):
                        session_file = handler._client.session.filename
                        session_info["session_file"] = session_file
                        session_info["session_exists"] = os.path.exists(session_file)
                        
                        # Check if actually connected and authorized (not just file exists)
                        try:
                            async def _check_real_connection():
                                if not handler._client.is_connected():
                                    return False
                                return await handler._client.is_user_authorized()
                            
                            session_valid = handler.run_async(_check_real_connection())
                            session_info["session_valid"] = session_valid
                            logger.debug(f"[SESSION_STATUS] Real connection status: {session_valid}")
                        except Exception as e:
                            logger.debug(f"[SESSION_STATUS] Connection check failed: {e}")
                            session_info["session_valid"] = False
                        
                        return jsonify({
                            "success": True,
                            "data": session_info
                        })
                else:
                    logger.debug("[SESSION_STATUS] No client in handler")
            except Exception as e:
                logger.debug(f"[SESSION_STATUS] Handler check failed: {e}")
        
        # Fallback: Check for session files manually
        logger.debug("[SESSION_STATUS] Checking for session files manually...")
        base_dir = os.path.dirname(os.path.abspath(__file__))
        potential_session_files = [
            os.path.join(base_dir, "telegram_session.session"),
            os.path.join(base_dir, "../telegram_session.session"),
        ]
        
        for session_file in potential_session_files:
            if os.path.exists(session_file) and os.path.getsize(session_file) > 0:
                logger.debug(f"[SESSION_STATUS] Found session file: {session_file}")
                session_info["session_file"] = session_file
                session_info["session_exists"] = True
                
                # File exists but we don't know if it's connected - mark as invalid
                # since the handler doesn't have a valid client
                session_info["session_valid"] = False
                logger.debug("[SESSION_STATUS] Session file exists but no active connection")
                break
        
        # Final fallback: check sticker_bot
        if not session_info["session_exists"] and sticker_bot and hasattr(sticker_bot, 'session_file') and sticker_bot.session_file:
            session_file = sticker_bot.session_file
            if os.path.exists(session_file):
                session_info["session_file"] = session_file
                session_info["session_exists"] = True
                session_info["session_valid"] = False  # Conservative - no active connection
        
        logger.debug(f"[SESSION_STATUS] Final result: {session_info}")
        return jsonify({
            "success": True,
            "data": session_info
        })
    except Exception as e:
        logger.error(f"Error checking session status: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/telegram/cleanup-session', methods=['POST', 'OPTIONS'], strict_slashes=False)
def cleanup_telegram_session():
    """Clean up invalid Telegram session files"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        from telegram_connection_handler import get_telegram_handler
        
        handler = get_telegram_handler()
        if handler:
            removed_count = handler.cleanup_invalid_session()
            return jsonify({
                "success": True,
                "message": f"Cleaned up {removed_count} session files",
                "removed_count": removed_count
            })
        else:
            return jsonify({
                "success": False,
                "error": "Telegram handler not available"
            }), 500
            
    except Exception as e:
        logger.error(f"Error cleaning up session: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/telegram/force-reset', methods=['POST', 'OPTIONS'], strict_slashes=False)
def force_reset_telegram():
    """FORCE complete Telegram reset - implements clean workflow requirement"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        logger.info("[FORCE_RESET] Starting COMPLETE Telegram reset...")
        
        # Step 1: Reset sticker bot
        try:
            from sticker_bot import sticker_bot
            if sticker_bot:
                logger.info("[FORCE_RESET] Cleaning up sticker bot...")
                sticker_bot.cleanup_connection()
                logger.info("[FORCE_RESET] Sticker bot cleanup completed")
        except Exception as e:
            logger.warning(f"[FORCE_RESET] Error cleaning up sticker bot: {e}")
        
        # Step 2: Force handler cleanup
        try:
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            if handler:
                logger.info("[FORCE_RESET] Force disconnecting and cleaning up handler...")
                handler.force_disconnect_and_cleanup()
                logger.info("[FORCE_RESET] Handler cleanup completed")
        except Exception as e:
            logger.warning(f"[FORCE_RESET] Error cleaning up handler: {e}")
        
        # Step 3: Comprehensive session cleanup
        try:
            logger.info("[FORCE_RESET] Running comprehensive session cleanup...")
            cleanup_telegram_and_sessions()
            logger.info("[FORCE_RESET] Session cleanup completed")
        except Exception as e:
            logger.warning(f"[FORCE_RESET] Error during session cleanup: {e}")
        
        # Step 4: Kill any lingering Python processes
        try:
            from kill_python_processes import kill_our_app_processes
            kill_results = kill_our_app_processes()
            logger.info(f"[FORCE_RESET] Process cleanup: {kill_results}")
        except Exception as e:
            logger.warning(f"[FORCE_RESET] Error killing processes: {e}")
        
        logger.info("[FORCE_RESET] COMPLETE reset finished successfully")
        
        return jsonify({
            "success": True, 
            "message": "Complete Telegram reset performed - all sessions and connections cleared"
        })
        
    except Exception as e:
        logger.error(f"[FORCE_RESET] Critical error during force reset: {e}")
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

@app.route('/api/telegram/connection-status', methods=['GET', 'OPTIONS'], strict_slashes=False)
def get_telegram_connection_status():
    """Get comprehensive Telegram connection status for clean workflow"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        status = {
            "connected": False,
            "authorized": False,
            "ready_for_stickers": False,
            "session_file": None,
            "clean_state": True,  # Always clean in our workflow
            "handler_status": "unknown",
            "sticker_bot_status": "unknown"
        }
        
        # Check handler status
        try:
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            if handler:
                handler_status = handler.get_connection_status()
                status.update(handler_status)
                status["handler_status"] = "available"
                
                # For clean workflow, we only consider connections ready if they're active
                status["connected"] = handler.has_active_connection()
                status["authorized"] = status["connected"]
                
            else:
                status["handler_status"] = "not_available"
        except Exception as e:
            logger.debug(f"[CONNECTION_STATUS] Handler check error: {e}")
            status["handler_status"] = "error"
        
        # Check sticker bot status
        try:
            from sticker_bot import sticker_bot
            if sticker_bot:
                bot_connected = sticker_bot.is_connected()
                status["sticker_bot_status"] = "connected" if bot_connected else "disconnected"
                status["ready_for_stickers"] = bot_connected
            else:
                status["sticker_bot_status"] = "not_initialized"
        except Exception as e:
            logger.debug(f"[CONNECTION_STATUS] Sticker bot check error: {e}")
            status["sticker_bot_status"] = "error"
        
        return jsonify({
            "success": True,
            "data": status
        })
        
    except Exception as e:
        logger.error(f"[CONNECTION_STATUS] Error getting connection status: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/telegram/connect', methods=['POST', 'OPTIONS'], strict_slashes=False)
def connect_telegram():
    """Connect to Telegram using clean workflow - always fresh connection"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        # Get JSON data
        data = request.get_json()
        logger.info(f"[CONNECT] Clean workflow connection request")
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400
        
        # Extract connection parameters
        api_id = data.get('api_id')
        api_hash = data.get('api_hash')
        phone_number = data.get('phone_number')
        process_id = data.get('process_id')
        logger.info(f"[CONNECT] Process: {process_id}, Phone: ***{str(phone_number)[-4:]}")
        
        # Validate inputs
        if not all([api_id, api_hash, phone_number]):
            return jsonify({
                "success": False, 
                "error": "Missing required connection details: api_id, api_hash, phone_number"
            }), 400
        
        # Use the clean workflow connection handler
        from telegram_connection_handler import get_telegram_handler
        handler = get_telegram_handler()
        
        if not handler:
            return jsonify({
                "success": False, 
                "error": "Telegram handler not available"
            }), 500
        
        # Ensure event loop is ready
        try:
            handler.ensure_event_loop()
        except Exception as e:
            logger.error(f"[CONNECT] Event loop setup error: {e}")
            return jsonify({
                "success": False, 
                "error": "Failed to initialize connection system"
            }), 500
        
        # Attempt FRESH connection (always clean as per requirements)
        logger.info("[CONNECT] Starting FRESH connection...")
        result = handler.connect_telegram(api_id, api_hash, phone_number)
        logger.info(f"[CONNECT] Connection result: {result}")
        
        return jsonify(result)
    
    except Exception as e:
        logger.error(f"[CONNECT] Connection error: {e}", exc_info=True)
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

@app.route('/api/telegram/verify-code', methods=['POST', 'OPTIONS'], strict_slashes=False)
def verify_telegram_code():
    """Verify Telegram code for clean workflow"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400
        
        code = data.get('code')
        if not code:
            return jsonify({"success": False, "error": "Code is required"}), 400
        
        # Use handler for code verification
        from telegram_connection_handler import get_telegram_handler
        handler = get_telegram_handler()
        
        if not handler:
            return jsonify({
                "success": False, 
                "error": "Telegram handler not available"
            }), 500
        
        result = handler.verify_code(code)
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"[VERIFY_CODE] Error: {e}")
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

@app.route('/api/telegram/verify-password', methods=['POST', 'OPTIONS'], strict_slashes=False)
def verify_telegram_password():
    """Verify Telegram 2FA password for clean workflow"""
    if request.method == 'OPTIONS':
        return '', 200
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400
        
        password = data.get('password')
        if not password:
            return jsonify({"success": False, "error": "Password is required"}), 400
        
        # Use handler for password verification
        from telegram_connection_handler import get_telegram_handler
        handler = get_telegram_handler()
        
        if not handler:
            return jsonify({
                "success": False, 
                "error": "Telegram handler not available"
            }), 500
        
        result = handler.verify_password(password)
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"[VERIFY_PASSWORD] Error: {e}")
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

if __name__ == '__main__':
    # Check FFmpeg availability
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
        logger.info("FFmpeg check passed.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        logger.error("ERROR: FFmpeg not found. Please install FFmpeg and add it to your PATH.")
        sys.exit(1)

    # Ensure temp directory exists
    Config.ensure_temp_dir()

    logger.info("Backend server starting...")

    # Run Flask with proper configuration
    logger.info(f"Backend starting on host: 0.0.0.0, port: 5000")
    logger.info(f"Current working directory: {os.getcwd()}")
    logger.info(f"Python path: {sys.path}")
    
    try:
        app.run(
            host="0.0.0.0",
            port=5000,
            debug=False,
            threaded=True,
            use_reloader=False
        )
    except Exception as e:
        logger.critical(f"FATAL: Backend startup failed: {e}", exc_info=True)
        sys.exit(1)