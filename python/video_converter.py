import os
import subprocess
import logging
import time
import gc
import psutil
from pathlib import Path
from gpu_manager import GPUManager, GPUType, GPUInfo

class VideoConverterCore:
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        # Default to INFO in this module, but respect global level
        if not self.logger.handlers:
            self.logger.propagate = True

        # Configuration from your original try.py - EXACT VALUES
        self.SUPPORTED_INPUT_FORMATS = [
            "*.mp4", "*.avi", "*.mov", "*.mkv", "*.flv", "*.webm"
        ]
        self.OUTPUT_FORMAT = "webm"
        self.TARGET_FILE_SIZE_KB = 254  # Your exact target
        self.SCALE_WIDTH = 512
        self.SCALE_HEIGHT = 512
        self.HEXEDIT_TARGET_SEQUENCE = bytes([0x44, 0x89, 0x88, 0x40])
        self.HEXEDIT_REPLACEMENT_BYTES = bytes([0x00, 0x00])

        # Create temp directory
        self.TEMP_DIR = os.path.join(os.path.expanduser("~"), "VideoConverterTemp")
        os.makedirs(self.TEMP_DIR, exist_ok=True)

        # Performance-oriented tuning
        self.VPX_CPU_USED = 5  # slightly faster preset
        self.MAX_ATTEMPTS = 99999  # Essentially infinite attempts - user will improve core logic
        
        # Initialize GPU Manager
        self.gpu_manager = GPUManager()
        self.selected_gpu = None
        self.gpu_mode = "auto"  # auto, cpu, nvidia, amd, intel
        
        # Load GPU configuration from preflight check
        self.gpu_config = self._load_gpu_config()
        
        # Memory management
        self.memory_cleanup_interval = 5  # Cleanup every 5 conversions
        self.conversions_since_cleanup = 0
    
    def _load_gpu_config(self):
        """Load GPU configuration from preflight check"""
        try:
            import json
            config_path = os.path.join(os.path.dirname(__file__), "gpu_config.json")
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    config = json.load(f)
                    self.logger.info(f"[GPU] Loaded configuration: {config.get('optimal', {}).get('mode', 'unknown')}")
                    return config
        except Exception as e:
            self.logger.warning(f"[GPU] Could not load config: {e}")
        return {}

    def update_process_status(self, process_id, update_data):
        """Helper to update process status in backend"""
        try:
            with self.process_lock:
                if process_id in self.active_processes:
                    self.active_processes[process_id].update(update_data)
                    # Keep detailed status logs at DEBUG only
                    self.logger.debug(f"[STATUS] Updated process {process_id}: {update_data}")
        except Exception as e:
            self.logger.error(f"Error updating process status: {e}")

    def update_file_status(self, process_id, file_index, file_data):
        """Helper to update individual file status"""
        try:
            with self.process_lock:
                if process_id in self.active_processes:
                    if "file_statuses" not in self.active_processes[process_id]:
                        self.active_processes[process_id]["file_statuses"] = {}
                    self.active_processes[process_id]["file_statuses"][file_index] = file_data

                    # Recalculate aggregate metrics to reflect current file progress immediately
                    proc = self.active_processes[process_id]
                    file_statuses = proc.get("file_statuses", {})

                    # Completed files count based on statuses
                    completed_files = sum(1 for fs in file_statuses.values() if fs.get('status') == 'completed')
                    proc["completed_files"] = completed_files

                    # Overall progress as average of per-file progress
                    total_files = proc.get("total_files") or len(file_statuses) or 1
                    total_progress = 0.0
                    for fs in file_statuses.values():
                        p = fs.get('progress', 0) or 0
                        try:
                            p = max(0, min(100, float(p)))
                        except Exception:
                            p = 0.0
                        total_progress += p
                    proc["progress"] = round(total_progress / total_files, 1)

                    # Current file name
                    try:
                        if isinstance(file_index, int) and file_statuses.get(file_index):
                            proc["current_file"] = file_statuses[file_index].get("filename", proc.get("current_file", ""))
                    except Exception:
                        pass

                    self.logger.debug(f"[FILE_STATUS] File {file_index}: {file_data}")
        except Exception as e:
            self.logger.error(f"Error updating file status: {e}")

    def get_video_info(self, input_file):
        """Retrieve video duration and metadata - YOUR EXACT METHOD"""
        try:
            self.logger.info(f"[INFO] Getting video info for: {input_file}")
            
            # Get video duration
            duration_cmd = [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                input_file
            ]
            duration_result = subprocess.check_output(duration_cmd, stderr=subprocess.DEVNULL)
            duration = float(duration_result.decode().strip())

            # Get video resolution
            res_cmd = [
                'ffprobe', '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height',
                '-of', 'csv=s=x:p=0',
                input_file
            ]
            resolution_result = subprocess.check_output(res_cmd, stderr=subprocess.DEVNULL)
            resolution = resolution_result.decode().strip().split('x')
            width, height = map(int, resolution)

            self.logger.info(f"[INFO] Video info - Duration: {duration}s, Resolution: {width}x{height}")
            return duration, width, height
            
        except Exception as e:
            self.logger.error(f"Error getting video info for {input_file}: {e}")
            return None, None, None

    def get_file_size(self, filename):
        """Get file size in KB"""
        try:
            if os.path.exists(filename):
                size_kb = os.path.getsize(filename) / 1024
                return size_kb
            return 0
        except Exception as e:
            self.logger.error(f"Error getting file size for {filename}: {e}")
            return 0

    def detect_gpu(self):
        """Automatic GPU detection - selects best GPU, falls back to CPU"""
        try:
            # Get available GPUs
            gpus = self.gpu_manager.gpus
            
            if not gpus:
                self.logger.info("[GPU] No GPU detected, using CPU")
                self.selected_gpu = None
                return 'cpu'
            
            # Select the best available GPU automatically
            self.selected_gpu = self.gpu_manager.get_best_gpu()
            
            if self.selected_gpu:
                self.logger.info(f"[GPU] Auto-selected: {self.selected_gpu.name} ({self.selected_gpu.type.value})")
                self.logger.info(f"[GPU] Memory: {self.selected_gpu.memory_used}MB/{self.selected_gpu.memory_total}MB")
                return self.selected_gpu.type.value
            else:
                self.logger.info("[GPU] No suitable GPU found, falling back to CPU")
                self.selected_gpu = None
                return 'cpu'
                
        except Exception as e:
            self.logger.error(f"[GPU] Detection error: {e}, falling back to CPU")
            self.selected_gpu = None
            return 'cpu'
    
    def cleanup_memory(self):
        """Cleanup memory to prevent leaks"""
        try:
            # Force garbage collection
            gc.collect()
            
            # Clean up temp files older than 1 hour
            temp_files = Path(self.TEMP_DIR).glob("*")
            current_time = time.time()
            for temp_file in temp_files:
                if temp_file.is_file():
                    file_age = current_time - temp_file.stat().st_mtime
                    if file_age > 3600:  # 1 hour
                        try:
                            temp_file.unlink()
                            self.logger.debug(f"[CLEANUP] Deleted old temp file: {temp_file}")
                        except:
                            pass
            
            # Log memory status
            memory = psutil.virtual_memory()
            self.logger.info(f"[MEMORY] System RAM: {memory.used // (1024*1024)}MB/{memory.total // (1024*1024)}MB ({memory.percent}%)")
            
            if self.selected_gpu:
                gpu_mem_used, gpu_mem_total, gpu_mem_percent = self.gpu_manager.get_gpu_memory_usage(self.selected_gpu.index)
                self.logger.info(f"[MEMORY] GPU: {gpu_mem_used}MB/{gpu_mem_total}MB ({gpu_mem_percent:.1f}%)")
                
        except Exception as e:
            self.logger.error(f"[CLEANUP] Memory cleanup error: {e}")

    def convert_video(self, input_file, output_file, gpu_mode='auto', process_id=None, file_index=None):
        """
        Enhanced conversion with multi-GPU support and memory management
        """
        try:
            filename = os.path.basename(input_file)
            self.logger.info(f"[CONVERT] Attempting conversion for {filename}")
            
            # Always use automatic GPU detection
            gpu_type = self.detect_gpu()
            
            # Get system stats before conversion
            system_stats = self.gpu_manager.get_current_stats()
            
            # Update file status to "analyzing"
            if process_id and file_index is not None:
                gpu_info = f"GPU: {self.selected_gpu.name}" if self.selected_gpu else "CPU Mode"
                self.update_file_status(process_id, file_index, {
                    'status': 'analyzing',
                    'progress': 5,
                    'stage': f'Analyzing video... ({gpu_info})',
                    'filename': filename,
                    'gpu_info': gpu_info,
                    'system_stats': system_stats
                })

            # Get video metadata
            duration, width, height = self.get_video_info(input_file)
            if not duration or duration <= 0:
                self.logger.error(f"[ERROR] Invalid video duration for {filename}")
                if process_id and file_index is not None:
                    self.update_file_status(process_id, file_index, {
                        'status': 'error',
                        'progress': 0,
                        'stage': 'Error: Invalid video',
                        'filename': filename
                    })
                return False

            self.logger.info(f"[INFO] {filename}: Duration={duration:.2f}s, Resolution={width}x{height}")

            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'preparing',
                    'progress': 10,
                    'stage': f'Duration: {duration:.1f}s, Size: {width}x{height}',
                    'filename': filename
                })

            # Initialize conversion parameters - YOUR EXACT VALUES
            target_size_kb = self.TARGET_FILE_SIZE_KB
            initial_bitrate = max(int((target_size_kb * 8) / duration), 50)

            # Target size range
            target_range_min = target_size_kb * 0.90
            target_range_max = target_size_kb * 1.0

            self.logger.info(f"[TARGET] {filename}: Target: {target_size_kb}KB (Range: {target_range_min:.1f}-{target_range_max:.1f}KB)")

            # CRF and bitrate adjustment parameters (faster convergence)
            crf = 30  # Starting CRF
            max_crf = 50
            min_crf = 1

            # Tracking variables
            attempt = 1
            max_attempts = self.MAX_ATTEMPTS
            crf_adjustment_count = 0
            last_file_size = 0

            while attempt <= max_attempts:
                try:
                    self.logger.info(f"[ATTEMPT] {filename}: ATTEMPT {attempt}/{max_attempts} - CRF:{crf}, Bitrate:{initial_bitrate}k")

                    # Calculate progress based on attempt
                    base_progress = 15 + (attempt / max_attempts) * 70  # 15-85% range for conversion attempts

                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'converting',
                            'progress': int(base_progress),
                            'stage': f'Attempt {attempt}/{max_attempts} - CRF:{crf} BR:{initial_bitrate}k',
                            'filename': filename
                        })

                    # For now, force CPU mode to ensure stability
                    # We'll re-enable GPU after fixing the CUDA issues
                    use_cuda_preproc = False
                    
                    # CPU path - always use this for now
                    ffmpeg_pre_args = []
                    scale_filter = (
                        f"scale={self.SCALE_WIDTH}:{self.SCALE_HEIGHT}:force_original_aspect_ratio=decrease,"
                        f"pad={self.SCALE_WIDTH}:{self.SCALE_HEIGHT}:(ow-iw)/2:(oh-ih)/2"
                    )
                    self.logger.info(f"[FFMPEG] Using CPU processing for {filename} (GPU temporarily disabled for stability)")

                    # Pass log base for two-pass; suppress console noise
                    pass_log_base = os.path.join(self.TEMP_DIR, f"ffmpeg_pass_{os.getpid()}_{int(time.time())}_{attempt}")
                    null_device = "NUL" if os.name == 'nt' else "/dev/null"

                    # FFmpeg command configuration - YOUR EXACT COMMAND
                    convert_cmd = [
                        "ffmpeg",
                        "-hide_banner",
                        "-loglevel", "error",
                        "-y",  # Overwrite output file
                        "-threads", str(max(1, (os.cpu_count() or 4))),
                    ] + ffmpeg_pre_args + [
                        "-i", input_file,
                        "-vf", scale_filter,  # Scaling with padding
                        "-c:v", "libvpx-vp9",
                        "-crf", str(crf),
                        "-b:v", f"{initial_bitrate}k",
                        "-maxrate", f"{int(initial_bitrate * 1.5)}k",
                        "-bufsize", f"{int(initial_bitrate * 3)}k",
                        "-row-mt", "1",  # Multi-threading
                        "-tile-columns", "4",
                        "-cpu-used", str(self.VPX_CPU_USED),
                        "-pass", "1",
                        "-passlogfile", pass_log_base,
                        "-f", "null",
                        null_device,
                    ]

                    self.logger.info(f"[PASS1] {filename}: Starting FFmpeg Pass 1...")

                    # Update progress for pass 1
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'converting',
                            'progress': int(base_progress + 5),
                            'stage': f'Pass 1/2 - CRF:{crf}',
                            'filename': filename
                        })

                    # First Pass
                    result = subprocess.run(convert_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                    # Second Pass Command - rebuild it properly
                    convert_cmd = [
                        "ffmpeg",
                        "-hide_banner",
                        "-loglevel", "error",
                        "-y",  # Overwrite output file
                        "-threads", str(max(1, (os.cpu_count() or 4))),
                    ] + ffmpeg_pre_args + [
                        "-i", input_file,
                        "-vf", scale_filter,  # Scaling with padding
                        "-c:v", "libvpx-vp9",
                        "-crf", str(crf),
                        "-b:v", f"{initial_bitrate}k",
                        "-maxrate", f"{int(initial_bitrate * 1.5)}k",
                        "-bufsize", f"{int(initial_bitrate * 3)}k",
                        "-row-mt", "1",  # Multi-threading
                        "-tile-columns", "4",
                        "-cpu-used", str(self.VPX_CPU_USED),
                        "-pass", "2",
                        "-passlogfile", pass_log_base,
                        "-an",  # No audio
                        "-f", "webm",
                        output_file,
                    ]

                    self.logger.info(f"[PASS2] {filename}: Starting FFmpeg Pass 2...")

                    # Update progress for pass 2
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'converting',
                            'progress': int(base_progress + 10),
                            'stage': f'Pass 2/2 - CRF:{crf}',
                            'filename': filename
                        })

                    result = subprocess.run(convert_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                    # Verify output file
                    if not os.path.exists(output_file):
                        self.logger.error(f"[ERROR] {filename}: Output file not found: {output_file}")
                        if process_id and file_index is not None:
                            self.update_file_status(process_id, file_index, {
                                'status': 'error',
                                'progress': 0,
                                'stage': 'Error: Output file not created',
                                'filename': filename
                            })
                        return False

                    # Get file size
                    file_size_kb = self.get_file_size(output_file)
                    if file_size_kb == 0:
                        self.logger.error(f"[ERROR] {filename}: Output file size is zero")
                        if process_id and file_index is not None:
                            self.update_file_status(process_id, file_index, {
                                'status': 'error',
                                'progress': 0,
                                'stage': 'Error: Zero file size',
                                'filename': filename
                            })
                        return False

                    self.logger.info(f"[SIZE] {filename}: Attempt {attempt}: Output size = {file_size_kb:.2f} KB, "
                                   f"Target size = {target_size_kb} KB, "
                                   f"CRF = {crf}, Bitrate = {initial_bitrate} kbps")

                    # Update progress with size check
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'checking',
                            'progress': 85,
                            'stage': f'Size: {file_size_kb:.1f}KB (Target: {target_size_kb}KB)',
                            'filename': filename
                        })

                    # Check if file size is within target range
                    if target_range_min <= file_size_kb <= target_range_max:
                        self.logger.info(f"[SUCCESS] {filename}: Output file size is within target range!")
                        if process_id and file_index is not None:
                            self.update_file_status(process_id, file_index, {
                                'status': 'completed',
                                'progress': 100,
                                'stage': f'Completed! {file_size_kb:.1f}KB in {attempt} attempts',
                                'filename': filename
                            })
                        return True

                    # Size difference for detecting plateaus - YOUR EXACT LOGIC
                    size_diff = abs(file_size_kb - last_file_size)
                    last_file_size = file_size_kb

                    # CRF Adjustment Phase (bigger steps early)
                    if file_size_kb > target_range_max:
                        # File too large - increase CRF to reduce quality
                        if crf < max_crf:
                            crf = min(crf + (3 if attempt <= 4 else 2), max_crf)
                            self.logger.info(f"[ADJUST] {filename}: Increasing CRF to {crf} to reduce file size")
                        else:
                            # CRF at maximum, switch to bitrate reduction
                            initial_bitrate = int(initial_bitrate * 0.92)
                            self.logger.info(f"[ADJUST] {filename}: CRF maxed out. Reducing bitrate to {initial_bitrate} kbps")
                    elif file_size_kb < target_range_min:
                        # File too small - decrease CRF to improve quality
                        if crf > min_crf:
                            crf = max(crf - (3 if attempt <= 4 else 2), min_crf)
                            self.logger.info(f"[ADJUST] {filename}: Decreasing CRF to {crf} to increase file size")
                        else:
                            # CRF at minimum, switch to bitrate increase
                            initial_bitrate = int(initial_bitrate * 1.08)
                            self.logger.info(f"[ADJUST] {filename}: CRF minimized. Increasing bitrate to {initial_bitrate} kbps")

                    # Detect plateau in CRF adjustments (faster trigger)
                    if size_diff < target_size_kb * 0.04:
                        crf_adjustment_count += 1
                    else:
                        crf_adjustment_count = 0

                    # If CRF adjustments are not effective, switch to bitrate fine-tuning
                    if crf_adjustment_count >= 2:
                        # When bitrate adjustments are needed
                        if file_size_kb > target_range_max:
                            initial_bitrate = int(initial_bitrate * 0.9)  # Reduce bitrate more aggressively
                            self.logger.info(f"[PLATEAU] {filename}: Plateaued. Reducing bitrate to {initial_bitrate} kbps")
                        elif file_size_kb < target_range_min:
                            initial_bitrate = int(initial_bitrate * 1.1)  # Increase bitrate more aggressively
                            self.logger.info(f"[PLATEAU] {filename}: Plateaued. Increasing bitrate to {initial_bitrate} kbps")

                        # Reset adjustment tracking
                        crf_adjustment_count = 0

                    attempt += 1

                    # Clean up temp files
                    try:
                        for temp_file in [f"{pass_log_base}-0.log", f"{pass_log_base}-0.log.mbtree"]:
                            if os.path.exists(temp_file):
                                os.remove(temp_file)
                    except Exception:
                        pass

                except subprocess.CalledProcessError as e:
                    self.logger.error(f"[ERROR] {filename}: FFmpeg command failed on attempt {attempt}: {e}")
                    stderr_output = e.stderr.decode() if e.stderr else "No error output"
                    self.logger.error(f"FFmpeg stderr: {stderr_output}")
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'error',
                            'progress': 0,
                            'stage': f'FFmpeg error on attempt {attempt}',
                            'filename': filename
                        })
                    return False
                except Exception as e:
                    self.logger.error(f"[ERROR] {filename}: Unexpected error on attempt {attempt}: {e}")
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'error',
                            'progress': 0,
                            'stage': f'Unexpected error: {str(e)}',
                            'filename': filename
                        })
                    return False

            self.logger.error(f"[ERROR] {filename}: Failed to achieve target size after {max_attempts} attempts.")
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'error',
                    'progress': 0,
                    'stage': f'Failed after {max_attempts} attempts',
                    'filename': filename
                })
            return False

        except Exception as e:
            self.logger.error(f"[ERROR] {filename}: Video conversion failed: {e}")
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'error',
                    'progress': 0,
                    'stage': f'Conversion failed: {str(e)}',
                    'filename': filename
                })
            return False

    def hex_edit_file(self, input_file, output_file, process_id=None, file_index=None):
        """Perform hex editing on a single file with simple 0% → 100% progress tracking"""
        filename = os.path.basename(input_file)

        try:
            self.logger.info(f"[HEX] Starting hex edit: {filename}")

            # Start processing - show 0%
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'processing',
                    'progress': 0,
                    'stage': 'Processing hex edit...',
                    'filename': filename
                })

            # Read the input file
            with open(input_file, 'rb') as f:
                data = bytearray(f.read())

            # Find and replace the target sequence
            target_found = False
            pos = data.find(self.HEXEDIT_TARGET_SEQUENCE)

            if pos != -1:
                # Replace bytes immediately following the target sequence
                start = pos + len(self.HEXEDIT_TARGET_SEQUENCE)
                end = start + len(self.HEXEDIT_REPLACEMENT_BYTES)
                if end <= len(data):
                    data[start:end] = self.HEXEDIT_REPLACEMENT_BYTES
                else:
                    raise ValueError("Replacement would exceed file bounds")
                target_found = True
                self.logger.info(f"[HEX] Found and replaced hex sequence at position {pos} in {filename}")
            else:
                self.logger.warning(f"[HEX] Target hex sequence not found in {filename}")

            # Write the modified data to output file
            with open(output_file, 'wb') as f:
                f.write(data)

            # Mark as completed - show 100%
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'completed',
                    'progress': 100,
                    'stage': f'Hex edit completed! {"Pattern found" if target_found else "Pattern not found"}',
                    'filename': filename
                })

            self.logger.info(f"[HEX] Hex edit completed: {filename}")
            return True

        except Exception as e:
            self.logger.error(f"[HEX] Hex edit failed for {filename}: {e}")
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'error',
                    'progress': 0,
                    'stage': f'Hex edit failed: {str(e)}',
                    'filename': filename
                })
            return False

    def batch_convert(self, input_files, output_dir, gpu_mode, process_id):
        """Process files ONE BY ONE sequentially with proper progress tracking and memory management"""
        self.logger.info(f"[BATCH] Starting conversion of {len(input_files)} files")
        self.logger.info(f"[BATCH] Process ID: {process_id}")
        self.logger.info(f"[BATCH] Output dir: {output_dir}")
        self.logger.info(f"[BATCH] GPU Mode: {gpu_mode}")
        
        # Start resource monitoring
        self.gpu_manager.start_monitoring(interval=2.0)
        
        try:
            results = []

            if not os.path.exists(output_dir):
                os.makedirs(output_dir)
                self.logger.info(f"[BATCH] Created output directory: {output_dir}")

            self.logger.info(f"[BATCH] Starting batch conversion of {len(input_files)} files")

            # Initialize file status tracking
            try:
                with self.process_lock:
                    if process_id in self.active_processes:
                        self.active_processes[process_id]["file_statuses"] = {}
                        for i, input_file in enumerate(input_files):
                            filename = os.path.basename(input_file)
                            self.active_processes[process_id]["file_statuses"][i] = {
                                'status': 'pending',
                                'progress': 0,
                                'stage': 'Ready to convert',
                                'filename': filename
                            }
                        self.logger.info(f"[BATCH] Initialized file status tracking for {len(input_files)} files")
            except Exception as e:
                self.logger.error(f"Error initializing file statuses: {e}")

            completed_files = 0

            # Process each file sequentially
            for i, input_file in enumerate(input_files):
                filename = os.path.basename(input_file)
                filename_no_ext = os.path.splitext(filename)[0]
                output_file = os.path.join(output_dir, f"{filename_no_ext}_converted.{self.OUTPUT_FORMAT}")

                self.logger.info(f"[PROCESSING] Starting file {i+1}/{len(input_files)}: {input_file}")

                # Mark current file as starting and ensure only current file shows converting
                # Set previous file to completed (100%) if convert_video returned success

                # Mark current file as starting
                self.update_file_status(process_id, i, {
                    'status': 'starting',
                    'progress': 0,
                    'stage': 'Starting conversion...',
                    'filename': filename
                })

                # Abort if user pressed STOP in GUI
                try:
                    with self.process_lock:
                        if process_id in self.active_processes and self.active_processes[process_id]["status"] == "stopped":
                            self.logger.info(f"[ABORT] Process {process_id} stopped by user")
                            break
                except Exception:
                    pass

                # Convert the file
                success = self.convert_video(input_file, output_file, gpu_mode, process_id, i)

                if success:
                    completed_files += 1
                    self.logger.info(f"[RESULT] File {filename} succeeded")
                else:
                    self.logger.error(f"[RESULT] File {filename} failed")

                results.append({
                    "input_file": input_file,
                    "output_file": output_file,
                    "success": success,
                    "file_size": self.get_file_size(output_file) if success and os.path.exists(output_file) else 0
                })
                
                # Perform memory cleanup periodically
                self.conversions_since_cleanup += 1
                if self.conversions_since_cleanup >= self.memory_cleanup_interval:
                    self.logger.info("[BATCH] Performing scheduled memory cleanup")
                    self.cleanup_memory()
                    self.conversions_since_cleanup = 0

                # Immediately set next file to converting state (UI hint) if exists and process not stopped
                try:
                    with self.process_lock:
                        if process_id in self.active_processes and i + 1 < len(input_files):
                            next_file = input_files[i + 1]
                            next_name = os.path.basename(next_file)
                            # Only set if it hasn't started yet
                            fs = self.active_processes[process_id]["file_statuses"].get(i + 1, {})
                            if fs.get('status') in (None, 'pending', 'starting', 'preparing', 'analyzing'):
                                self.active_processes[process_id]["file_statuses"][i + 1] = {
                                    'status': 'converting',
                                    'progress': fs.get('progress', 0) or 0,
                                    'stage': fs.get('stage', 'Preparing...'),
                                    'filename': next_name
                                }
                                # Also update top-level hints
                                self.active_processes[process_id]["current_file"] = next_name
                                self.active_processes[process_id]["current_stage"] = f"Converting {next_name} ({i+2}/{len(input_files)})"
                except Exception:
                    pass

            # Update final progress
            try:
                with self.process_lock:
                    if process_id in self.active_processes:
                        self.active_processes[process_id]["progress"] = 100
                        self.active_processes[process_id]["completed_files"] = completed_files
                        self.active_processes[process_id]["failed_files"] = len(input_files) - completed_files
                        self.active_processes[process_id]["current_stage"] = f"Batch conversion completed! {completed_files}/{len(input_files)} files processed successfully"
                        # CRITICAL FIX: Set process status to completed
                        self.active_processes[process_id]["status"] = "completed"
                        self.logger.info(f"[FINAL] Updated final progress: {completed_files}/{len(input_files)} successful")
            except Exception as e:
                self.logger.error(f"Error updating final progress: {e}")

            self.logger.info(f"[COMPLETE] Batch conversion completed. Success: {completed_files}/{len(results)}")
            
            # Final memory cleanup
            self.cleanup_memory()
            
            # Stop monitoring
            self.gpu_manager.stop_monitoring()
            
            return results
            
        except Exception as e:
            self.logger.error(f"[BATCH] Critical error: {str(e)}", exc_info=True)
            # Ensure monitoring stops on error
            self.gpu_manager.stop_monitoring()
            raise

    def batch_hex_edit(self, input_files, output_dir, process_id):
        """Process hex editing for multiple files sequentially"""
        results = []

        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
            self.logger.info(f"[HEX BATCH] Created output directory: {output_dir}")

        self.logger.info(f"[HEX BATCH] Starting hex edit of {len(input_files)} files")

        # File status tracking is already initialized in backend.py
        # Just log that we're starting the batch process
        self.logger.info(f"[HEX BATCH] Starting batch hex edit for {len(input_files)} files")
        try:
            with self.process_lock:
                if process_id in self.active_processes:
                    self.logger.info(f"[HEX BATCH] Process {process_id} found with {len(self.active_processes[process_id].get('file_statuses', {}))} files tracked")
                else:
                    self.logger.error(f"[HEX BATCH] Process {process_id} not found in active processes!")
        except Exception as e:
            self.logger.error(f"Error checking hex edit process: {e}")

        completed_files = 0

        # Process each file sequentially
        for i, input_file in enumerate(input_files):
            filename = os.path.basename(input_file)
            filename_no_ext = os.path.splitext(filename)[0]
            output_file = os.path.join(output_dir, f"{filename_no_ext}_hexedited{os.path.splitext(filename)[1]}")

            self.logger.info(f"[HEX PROCESSING] Processing file {i+1}/{len(input_files)}: {filename}")

            # Update overall progress
            try:
                with self.process_lock:
                    if process_id in self.active_processes:
                        overall_progress = (i / len(input_files)) * 100
                        self.active_processes[process_id]["progress"] = overall_progress
                        self.active_processes[process_id]["current_file"] = filename
                        self.active_processes[process_id]["current_stage"] = f"Hex editing {filename} ({i+1}/{len(input_files)})"
                        self.active_processes[process_id]["completed_files"] = completed_files
                        self.logger.debug(f"[HEX PROGRESS] Overall progress: {overall_progress:.1f}%")
            except Exception as e:
                self.logger.error(f"Error updating hex edit overall progress: {e}")

            # Abort if user pressed STOP in GUI
            try:
                with self.process_lock:
                    if process_id in self.active_processes and self.active_processes[process_id]["status"] == "stopped":
                        self.logger.info(f"[ABORT] Process {process_id} stopped by user")
                        break
            except Exception:
                pass

            # Hex edit the file
            success = self.hex_edit_file(input_file, output_file, process_id, i)

            if success:
                completed_files += 1
                self.logger.info(f"[HEX SUCCESS] File {i+1}/{len(input_files)} completed: {filename}")
            else:
                self.logger.error(f"[HEX FAILED] File {i+1}/{len(input_files)} failed: {filename}")

            results.append({
                "input_file": input_file,
                "output_file": output_file,
                "success": success,
                "file_size": self.get_file_size(output_file) if success and os.path.exists(output_file) else 0
            })

        # Update final progress
        try:
            with self.process_lock:
                if process_id in self.active_processes:
                    self.active_processes[process_id]["progress"] = 100
                    self.active_processes[process_id]["completed_files"] = completed_files
                    self.active_processes[process_id]["failed_files"] = len(input_files) - completed_files
                    self.active_processes[process_id]["current_stage"] = f"Hex edit completed! {completed_files}/{len(input_files)} files processed successfully"
                    # CRITICAL FIX: Set process status to completed
                    self.active_processes[process_id]["status"] = "completed"
                    self.logger.info(f"[HEX FINAL] Updated final progress: {completed_files}/{len(input_files)} successful")
        except Exception as e:
            self.logger.error(f"Error updating hex edit final progress: {e}")

        self.logger.info(f"[HEX COMPLETE] Batch hex edit completed. Success: {completed_files}/{len(results)}")
        return results