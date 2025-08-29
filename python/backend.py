import os
import sys
import json
import tempfile
import logging
import subprocess
import threading
import time
import uuid
import signal
import atexit
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Setup logging (quiet by default: no stdout)
log_level_name = os.getenv('BACKEND_LOG_LEVEL', 'WARNING').upper()
log_level = getattr(logging, log_level_name, logging.WARNING)

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

# Run GPU preflight check first
try:
    import gpu_preflight
    logger.info("[GPU] Running GPU preflight check...")
    gpu_preflight.main()
except Exception as e:
    logger.warning(f"[GPU] Preflight check failed: {e}")

# Import video converter (after logging configured)
try:
    from video_converter import VideoConverterCore
    video_converter = VideoConverterCore()
    VIDEO_CONVERTER_AVAILABLE = True
    logger.info("[OK] Video converter imported successfully")
    
    # Import GPU manager for stats
    from gpu_manager import GPUManager
    gpu_manager = GPUManager()
    GPU_MANAGER_AVAILABLE = True
    logger.info("[OK] GPU manager imported successfully")
    
    # Import benchmark module
    from benchmark import VideoBenchmark
    BENCHMARK_AVAILABLE = True
    logger.info("[OK] Benchmark module imported successfully")
    
    # Log detected GPUs
    if gpu_manager.gpus:
        logger.info(f"[GPU] Detected {len(gpu_manager.gpus)} GPU(s):")
        for gpu in gpu_manager.gpus:
            logger.info(f"  - {gpu.name} ({gpu.type.value}) - {gpu.memory_total}MB VRAM")
            if gpu.cuda_version:
                logger.info(f"    CUDA {gpu.cuda_version} available")
    else:
        logger.info("[GPU] No GPUs detected - using CPU mode")
        
except ImportError as e:
    logger.warning(f"[ERROR] Video converter import failed: {e}. CWD={os.getcwd()} PYTHONPATH={sys.path}")
    VIDEO_CONVERTER_AVAILABLE = False
    video_converter = None
    GPU_MANAGER_AVAILABLE = False
    gpu_manager = None
    BENCHMARK_AVAILABLE = False
except Exception as e:
    logger.error(f"[ERROR] Video converter initialization failed: {e} ({type(e).__name__})")
    VIDEO_CONVERTER_AVAILABLE = False
    video_converter = None
    GPU_MANAGER_AVAILABLE = False
    gpu_manager = None
    BENCHMARK_AVAILABLE = False

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

# Global variables for tracking processes
active_processes = {}
process_counter = 0
process_lock = threading.Lock()
conversion_threads = {}

# Inject dependencies into video converter after global variables are declared
if VIDEO_CONVERTER_AVAILABLE and video_converter:
    video_converter.active_processes = active_processes
    video_converter.process_lock = process_lock
    logger.info("[OK] Dependencies injected into video converter")
else:
    logger.warning("[WARNING] Video converter not available, skipping dependency injection")

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

# Register cleanup handlers
atexit.register(cleanup_processes)
signal.signal(signal.SIGINT, lambda s, f: cleanup_processes())
signal.signal(signal.SIGTERM, lambda s, f: cleanup_processes())

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

# Health check route
@app.route('/api/health', methods=['GET', 'OPTIONS'], strict_slashes=False)
def health_check():
    if request.method == 'OPTIONS':
        return '', 200
    return jsonify({"status": "healthy", "timestamp": time.time(), "success": True})

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

# GPU detection route
@app.route('/api/gpu-detect', methods=['GET', 'OPTIONS'], strict_slashes=False)
def detect_gpus():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        if not GPU_MANAGER_AVAILABLE:
            return jsonify({"success": False, "error": "GPU manager not available"}), 500
        
        gpus = gpu_manager.detect_all_gpus()
        gpu_list = []
        for gpu in gpus:
            gpu_list.append({
                'index': gpu.index,
                'name': gpu.name,
                'type': gpu.type.value,
                'memory_total': gpu.memory_total,
                'memory_used': gpu.memory_used,
                'memory_free': gpu.memory_free,
                'driver_version': gpu.driver_version,
                'cuda_version': gpu.cuda_version,
                'utilization': gpu.utilization,
                'temperature': gpu.temperature
            })
        
        # Check for CUDA availability
        cuda_info = {
            'cuda_available': gpu_manager.cuda_available,
            'cuda_version': gpu_manager.cuda_version,
            'cudnn_available': gpu_manager.cudnn_available
        }
        
        # Check if NVIDIA GPU exists but CUDA not installed
        has_nvidia = any(gpu.type.value == 'nvidia' for gpu in gpus)
        needs_cuda = has_nvidia and not gpu_manager.cuda_available
        
        return jsonify({
            "success": True,
            "gpus": gpu_list,
            "count": len(gpu_list),
            "cuda_info": cuda_info,
            "needs_cuda_install": needs_cuda
        })
    except Exception as e:
        logger.error(f"Error detecting GPUs: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# CUDA installation info route
@app.route('/api/cuda-install-info', methods=['GET', 'OPTIONS'], strict_slashes=False)
def cuda_install_info():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        if not GPU_MANAGER_AVAILABLE:
            return jsonify({"success": False, "error": "GPU manager not available"}), 500
        
        install_info = gpu_manager.get_cuda_install_command()
        
        return jsonify({
            "success": True,
            "install_info": install_info,
            "platform": platform.system()
        })
    except Exception as e:
        logger.error(f"Error getting CUDA install info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# CUDA installer (Windows-first minimal implementation)
@app.route('/api/install-cuda', methods=['POST', 'OPTIONS'], strict_slashes=False)
def install_cuda():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        import platform
        system = platform.system()
        if system != 'Windows':
            return jsonify({
                "success": False,
                "error": "Automated CUDA install is only supported on Windows for now.",
                "hint": "Visit https://developer.nvidia.com/cuda-downloads to install manually"
            }), 400

        # Use winget to install CUDA Toolkit silently
        cmd = [
            'winget', 'install', 'Nvidia.CUDA', '-e', '--silent',
            '--accept-package-agreements', '--accept-source-agreements'
        ]

        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            return jsonify({
                "success": False,
                "error": "winget not found. Install winget or use manual download.",
                "command": 'winget install Nvidia.CUDA -e --silent --accept-package-agreements --accept-source-agreements',
                "url": "https://developer.nvidia.com/cuda-downloads"
            }), 400

        return jsonify({
            "success": True,
            "started": True,
            "message": "CUDA installation started via winget. You may be prompted for permission.",
            "command": 'winget install Nvidia.CUDA -e --silent --accept-package-agreements --accept-source-agreements'
        })
    except Exception as e:
        logger.error(f"Error starting CUDA install: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# Benchmark routes
@app.route('/api/benchmark', methods=['POST', 'OPTIONS'], strict_slashes=False)
def run_benchmark():
    """Run a comprehensive CPU vs GPU benchmark"""
    if request.method == 'OPTIONS':
        return '', 200
    try:
        if not BENCHMARK_AVAILABLE:
            return jsonify({
                'success': False,
                'error': 'Benchmark module not available'
            }), 500
        
        data = request.get_json()
        custom_file = data.get('file') if data else None
        
        logger.info(f"Starting benchmark test{' with custom file: ' + custom_file if custom_file else ''}")
        
        # Create benchmark instance
        benchmark = VideoBenchmark()
        
        # Run comprehensive benchmark
        results = benchmark.run_comprehensive_benchmark(custom_file)
        
        logger.info(f"Benchmark completed successfully")
        
        return jsonify({
            'success': True,
            'results': results
        })
        
    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/benchmark/status', methods=['GET', 'OPTIONS'], strict_slashes=False)
def benchmark_status():
    """Check if benchmark module is available"""
    if request.method == 'OPTIONS':
        return '', 200
    return jsonify({
        'available': BENCHMARK_AVAILABLE,
        'gpu_available': GPU_MANAGER_AVAILABLE and bool(gpu_manager.gpus if GPU_MANAGER_AVAILABLE else False),
        'cuda_available': gpu_manager.cuda_available if GPU_MANAGER_AVAILABLE else False
    })

# System stats route
@app.route('/api/system-stats', methods=['GET', 'OPTIONS'], strict_slashes=False)
def system_stats():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        if not GPU_MANAGER_AVAILABLE:
            # Basic stats without GPU
            import psutil
            memory = psutil.virtual_memory()
            cpu = psutil.cpu_percent(interval=0.1)
            
            return jsonify({
                "success": True,
                "stats": {
                    'cpu': {
                        'count': psutil.cpu_count(logical=False),
                        'threads': psutil.cpu_count(logical=True),
                        'percent': cpu
                    },
                    'memory': {
                        'total': memory.total // (1024 * 1024),
                        'used': memory.used // (1024 * 1024),
                        'free': memory.available // (1024 * 1024),
                        'percent': memory.percent
                    },
                    'gpus': []
                }
            })
        
        stats = gpu_manager.get_current_stats()
        return jsonify({"success": True, "stats": stats})
        
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
        # Clear any session files
        session_files = Path('.').glob('*.session')
        for session_file in session_files:
            try:
                session_file.unlink()
                logger.info(f"Deleted session file: {session_file}")
            except Exception as e:
                logger.warning(f"Failed to delete session file {session_file}: {e}")
        
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
            return jsonify({"success": False, "error": "No data provided"}), 400

        # Extract and validate parameters
        input_files = data.get('files', [])
        output_dir = data.get('output_dir', '')
        settings = data.get('settings', {})
        process_id = f"conversion-{int(time.time())}"  # Generate unique process ID

        logger.info(f"[API] Files: {len(input_files)}")
        logger.info(f"[API] Output: {output_dir}")
        logger.info(f"[API] Process ID: {process_id}")

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

                # Use video converter
                results = video_converter.batch_convert(
                    input_files=input_files,
                    output_dir=output_dir,
                    gpu_mode=settings.get('gpu_mode', 'auto'),
                    process_id=process_id
                )

                # Update final status
                with process_lock:
                    if process_id in active_processes:
                        successful_files = sum(1 for r in results if r.get("success", False))
                        active_processes[process_id].update({
                            "status": "completed",
                            "progress": 100,
                            "completed_files": successful_files,
                            "failed_files": len(results) - successful_files,
                            "current_stage": f"Completed! {successful_files}/{len(results)} files processed",
                            "end_time": time.time(),
                            "results": results,
                            "can_pause": False
                        })
                        logger.info(f"[THREAD] Conversion completed: {successful_files}/{len(results)} successful")

                # Clean up thread reference
                if process_id in conversion_threads:
                    del conversion_threads[process_id]

            except Exception as e:
                logger.error(f"[THREAD] Conversion error: {e}", exc_info=True)
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
            logger.warning(f"[PROGRESS] Process {process_id} not found")
            return jsonify({
                "success": False,
                "error": "Process not found",
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
    pid  = data.get('process_id')
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
        process_id = data.get('process_id')

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
        process_id = data.get('process_id')

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

@app.route('/api/test-conversion', methods=['POST'])
def test_conversion():
    """Test endpoint to verify conversion works"""
    try:
        # Simple test without FFmpeg dependency
        test_file = os.path.join(Config.TEMP_DIR, "test.txt")
        
        # Create a simple test file
        with open(test_file, 'w') as f:
            f.write("Test conversion endpoint working")
        
        return jsonify({
            "success": True,
            "message": "Test conversion completed",
            "file": test_file,
            "ffmpeg_available": True  # We'll check this separately
        })
        
    except Exception as e:
        logger.error(f"Test conversion failed: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/debug/video-converter', methods=['GET'])
def debug_video_converter():
    """Debug endpoint to check video converter status"""
    try:
        status = {
            "video_converter_available": VIDEO_CONVERTER_AVAILABLE,
            "video_converter_object": video_converter is not None,
            "current_directory": os.getcwd(),
            "python_path": sys.path,
            "temp_dir": Config.TEMP_DIR,
            "temp_dir_exists": os.path.exists(Config.TEMP_DIR)
        }
        
        # Test FFmpeg availability
        try:
            subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
            status["ffmpeg_available"] = True
        except (subprocess.CalledProcessError, FileNotFoundError):
            status["ffmpeg_available"] = False
            
        # Test video converter methods if available
        if VIDEO_CONVERTER_AVAILABLE and video_converter:
            status["has_batch_convert"] = hasattr(video_converter, 'batch_convert')
            status["has_active_processes"] = hasattr(video_converter, 'active_processes')
            status["has_process_lock"] = hasattr(video_converter, 'process_lock')
        
        return jsonify({
            "success": True,
            "status": status
        })
        
    except Exception as e:
        logger.error(f"Debug video converter failed: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/api/test', methods=['GET'])
def test_basic():
    """Basic test endpoint"""
    return jsonify({
        "success": True,
        "message": "Basic test endpoint working",
        "timestamp": time.time()
    })

@app.route('/api/debug/simple', methods=['GET'])
def debug_simple():
    """Simple debug endpoint to test route registration"""
    return jsonify({
        "success": True,
        "message": "Simple debug endpoint working",
        "timestamp": time.time()
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

# Error handlers
@app.errorhandler(404)
def not_found(error):
    logger.warning(f"404 error: {request.url}")
    return jsonify({"success": False, "error": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"500 error: {error}")
    return jsonify({"success": False, "error": "Internal server error"}), 500

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

    # Print all registered routes for debugging
    logger.info("--- REGISTERED ROUTES ---")
    for rule in app.url_map.iter_rules():
        logger.info(f"Endpoint: {rule.endpoint}, Methods: {rule.methods}, Route: {rule.rule}")
    logger.info("--- END OF ROUTES ---")
    
    # Test if debug endpoints are accessible
    logger.info("--- TESTING DEBUG ENDPOINTS ---")
    try:
        with app.test_client() as client:
            # Test health endpoint
            response = client.get('/api/health')
            logger.info(f"Health endpoint test: {response.status_code}")
            
            # Test debug endpoints
            response = client.get('/api/debug/video-converter')
            logger.info(f"Video converter debug test: {response.status_code}")
            
            response = client.post('/api/test-conversion')
            logger.info(f"Test conversion endpoint test: {response.status_code}")
            
            # Test basic endpoint
            response = client.get('/api/test')
            logger.info(f"Basic test endpoint test: {response.status_code}")
            
            # Test simple debug endpoint
            response = client.get('/api/debug/simple')
            logger.info(f"Simple debug endpoint test: {response.status_code}")
            
    except Exception as e:
        logger.error(f"Error testing endpoints: {e}")
    logger.info("--- END TESTING ---")

    # Verify video converter integration
    logger.info("Verifying video converter integration...")
    try:
        test_file = Path(Config.TEMP_DIR) / "test.txt"
        test_file.write_text("integration test")
        video_converter.update_file_status("test", 0, {"status": "test"})
        logger.info("[OK] Video converter integration verified")
    except Exception as e:
        logger.error(f"[ERROR] Video converter integration failed: {e}")

    # Run Flask with proper configuration
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
        threaded=True,
        use_reloader=False
    )