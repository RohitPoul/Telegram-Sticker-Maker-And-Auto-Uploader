import os
import subprocess
import logging
import time
import gc
import psutil
from pathlib import Path
import json

# Import the new loggers
from logging_config import video_conversion_logger, hex_edit_logger


class VideoConverterCore:
    def __init__(self):
        # Use the imported video_conversion_logger instead of creating a new logger
        self.logger = video_conversion_logger
        # Default to INFO in this module, but respect global level
        if not self.logger.handlers:
            self.logger.propagate = True
        # Configuration from your original try.py - EXACT VALUES
        self.SUPPORTED_INPUT_FORMATS = [
            "*.mp4", "*.avi", "*.mov", "*.mkv", "*.flv", "*.webm", "*.gif"
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
        
        # Memory management
        self.memory_cleanup_interval = 5  # Cleanup every 5 conversions
        self.conversions_since_cleanup = 0


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
        """Helper to update individual file status with proper change detection"""
        try:
            with self.process_lock:
                if process_id in self.active_processes:
                    if "file_statuses" not in self.active_processes[process_id]:
                        self.active_processes[process_id]["file_statuses"] = {}
                    
                    # Get current file status
                    current_status = self.active_processes[process_id]["file_statuses"].get(file_index, {})
                    
                    # Only update if there are actual changes
                    has_changes = False
                    for key, value in file_data.items():
                        if current_status.get(key) != value:
                            has_changes = True
                            break
                    
                    # Update the file status (with safety check)
                    if file_index not in self.active_processes[process_id]["file_statuses"]:
                        self.active_processes[process_id]["file_statuses"][file_index] = {}
                    self.active_processes[process_id]["file_statuses"][file_index].update(file_data)

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

                    # Only log if there were actual changes
                    if has_changes:
                        self.logger.debug(f"[FILE_STATUS] File {file_index}: {file_data}")
        except Exception as e:
            self.logger.error(f"Error updating file status: {e}")

    def get_video_info(self, input_file):
        """Retrieve video duration and metadata"""
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

            # Get video resolution and pixel format
            res_cmd = [
                'ffprobe', '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height,pix_fmt',
                '-of', 'csv=s=x:p=0',
                input_file
            ]
            resolution_result = subprocess.check_output(res_cmd, stderr=subprocess.DEVNULL)
            parts = resolution_result.decode().strip().split('x')
            width = int(parts[0]) if len(parts) >= 1 else 0
            height = int(parts[1]) if len(parts) >= 2 else 0
            pix_fmt = parts[2] if len(parts) >= 3 else "unknown"

            self.logger.info(f"[INFO] Video info - Duration: {duration}s, Resolution: {width}x{height}, PixFmt: {pix_fmt}")
            return duration, width, height, pix_fmt
            
        except Exception as e:
            self.logger.error(f"Error getting video info for {input_file}: {e}")
            return None, None, None, None

    def has_transparency(self, pix_fmt, input_file):
        """Check if input has alpha channel (transparency)"""
        # Pixel formats with alpha channel
        alpha_formats = ['rgba', 'bgra', 'argb', 'abgr', 'yuva420p', 'yuva444p', 'pal8']
        
        # GIFs often have transparency
        is_gif = input_file.lower().endswith('.gif')
        
        has_alpha = pix_fmt and pix_fmt.lower() in alpha_formats
        
        if is_gif or has_alpha:
            self.logger.info(f"[ALPHA] Input has transparency (pix_fmt: {pix_fmt}, is_gif: {is_gif})")
            return True
        return False

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
                
        except Exception as e:
            self.logger.error(f"[CLEANUP] Memory cleanup error: {e}")

    def convert_video(self, input_file, output_file, process_id=None, file_index=None):
        
        try:
            filename = os.path.basename(input_file)
            self.logger.info(f"[VIDEO] Converting {filename}")
            self.logger.info(f"Input: {input_file}")
            self.logger.info(f"Output: {output_file}")
            
            # Get initial video metadata (now includes pix_fmt)
            duration, width, height, pix_fmt = self.get_video_info(input_file)
            initial_file_size = self.get_file_size(input_file)
            
            # Check for transparency (GIF or alpha channel)
            use_alpha = self.has_transparency(pix_fmt, input_file)
            output_pix_fmt = "yuva420p" if use_alpha else None  # Let FFmpeg choose if no alpha
            
            self.logger.info(f"Metadata: {duration:.2f}s, {width}x{height}, {initial_file_size:.2f} KB, alpha: {use_alpha}")
            
            # CPU-only mode - no GPU detection or monitoring
            self.logger.info(f"[CPU] Using CPU-only processing mode")
            
            # Update file status to "analyzing"
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'analyzing',
                    'progress': 5,
                    'stage': f'Analyzing video... (CPU Mode)',
                    'filename': filename
                })

            # Validate video metadata (already retrieved above)
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

            # Tracking variables for performance metrics
            conversion_attempts = 0
            final_file_size = 0
            final_crf = 0
            final_bitrate = 0
            
            # Initialize conversion start time
            start_time = time.time()

            while attempt <= max_attempts:
                # Check for pause before each attempt
                if process_id:
                    try:
                        with self.process_lock:
                            if process_id in self.active_processes:
                                # Wait while paused
                                while self.active_processes[process_id].get("paused", False):
                                    self.logger.info(f"[PAUSE] Conversion paused for {filename}")
                                    time.sleep(1)
                                    # Check if stopped while paused
                                    if self.active_processes[process_id]["status"] == "stopped":
                                        self.logger.info(f"[ABORT] Conversion stopped while paused")
                                        return False
                    except Exception as e:
                        self.logger.error(f"[PAUSE] Error checking pause in conversion: {e}")
                
                conversion_attempts += 1
                self.logger.debug(f"Conversion Attempt {conversion_attempts} - CRF: {crf}, Bitrate: {initial_bitrate} kbps")
                
                # Calculate progress based on attempt
                base_progress = 15 + (attempt / max_attempts) * 70  # 15-85% range for conversion attempts

                if process_id and file_index is not None:
                    # More frequent progress updates
                    self.update_file_status(process_id, file_index, {
                        'status': 'converting',
                        'progress': int(base_progress),
                        'stage': f'Attempt {attempt}/{max_attempts} - CRF:{crf} BR:{initial_bitrate}k',
                        'filename': filename,
                        'attempt': attempt,
                        'crf': crf,
                        'bitrate': initial_bitrate
                    })

                # Telegram rule: one side must be 512px, other side equal or less
                scale_filter = f"scale='if(gte(iw,ih),{self.SCALE_WIDTH},-2)':'if(gte(iw,ih),-2,{self.SCALE_HEIGHT})'"
                
                self.logger.debug(f"[CPU] Processing {filename} - Pass 1")

                # Pass log base for two-pass; suppress console noise
                pass_log_base = os.path.join(self.TEMP_DIR, f"ffmpeg_pass_{os.getpid()}_{int(time.time())}_{attempt}")
                null_device = "NUL" if os.name == 'nt' else "/dev/null"

                # CPU-only VP9 encoding with two-pass
                convert_cmd = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-y",  # Overwrite output file
                    "-threads", str(max(1, (os.cpu_count() or 4))),
                    "-i", input_file,
                    "-vf", scale_filter,  # Scale to 512px (longest side)
                    "-c:v", "libvpx-vp9",
                ]
                # Add alpha channel support for GIFs/transparent videos
                if output_pix_fmt:
                    convert_cmd.extend(["-pix_fmt", output_pix_fmt])
                convert_cmd.extend([
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
                ])

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

                # Second Pass Command
                convert_cmd = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-y",  # Overwrite output file
                    "-threads", str(max(1, (os.cpu_count() or 4))),
                    "-i", input_file,
                    "-vf", scale_filter,  # Scale to 512px (longest side)
                    "-c:v", "libvpx-vp9",
                ]
                # Add alpha channel support for GIFs/transparent videos
                if output_pix_fmt:
                    convert_cmd.extend(["-pix_fmt", output_pix_fmt])
                convert_cmd.extend([
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
                ])

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
                        'filename': filename,
                        'file_size': file_size_kb
                    })

                # Check if file size is within target range
                if target_range_min <= file_size_kb <= target_range_max:
                    self.logger.info(f"[SUCCESS] {filename}: Output file size is within target range!")
                    if process_id and file_index is not None:
                        self.update_file_status(process_id, file_index, {
                            'status': 'completed',
                            'progress': 100,
                            'stage': f'Completed! {file_size_kb:.1f}KB in {attempt} attempts',
                            'filename': filename,
                            'file_size': file_size_kb,
                            'attempts': attempt
                        })
                    # Record final metrics
                    final_file_size = file_size_kb
                    final_crf = crf
                    final_bitrate = initial_bitrate
                    
                    # Calculate total conversion time
                    total_conversion_time = time.time() - start_time
                    
                    # Simple conversion success log
                    self.logger.info(f"[SUCCESS] {filename}: Converted in {total_conversion_time:.2f}s, {conversion_attempts} attempts, {final_file_size:.2f}KB")
                    
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
                        # CRF at minimum, switch to bitrate increase (with cap to prevent ffmpeg crash)
                        max_bitrate = 50000  # 50 Mbps cap - prevents ffmpeg from crashing on extreme values
                        if initial_bitrate < max_bitrate:
                            initial_bitrate = min(int(initial_bitrate * 1.08), max_bitrate)
                            self.logger.info(f"[ADJUST] {filename}: CRF minimized. Increasing bitrate to {initial_bitrate} kbps")
                        else:
                            # Bitrate maxed out - accept current output as best possible result
                            self.logger.warning(f"[ACCEPT] {filename}: Cannot reach target size. Accepting best output: {file_size_kb:.1f}KB (target was {target_size_kb}KB)")
                            if process_id and file_index is not None:
                                self.update_file_status(process_id, file_index, {
                                    'status': 'completed',
                                    'progress': 100,
                                    'stage': f'Completed! {file_size_kb:.1f}KB (max quality)',
                                    'filename': filename,
                                    'file_size': file_size_kb,
                                    'attempts': attempt
                                })
                            return True

                # Detect plateau in CRF adjustments (faster trigger)
                if size_diff < target_size_kb * 0.04:
                    crf_adjustment_count += 1
                else:
                    crf_adjustment_count = 0

                # If CRF adjustments are not effective, switch to bitrate fine-tuning
                if crf_adjustment_count >= 2:
                    # When bitrate adjustments are needed
                    max_bitrate = 50000  # 50 Mbps cap
                    min_bitrate = 50     # 50 kbps floor
                    
                    if file_size_kb > target_range_max:
                        initial_bitrate = max(int(initial_bitrate * 0.9), min_bitrate)
                        self.logger.info(f"[PLATEAU] {filename}: Plateaued. Reducing bitrate to {initial_bitrate} kbps")
                    elif file_size_kb < target_range_min:
                        # Check if we're already at max bitrate - if so, accept current output
                        if initial_bitrate >= max_bitrate:
                            self.logger.warning(f"[ACCEPT] {filename}: Plateaued at max bitrate. Accepting best output: {file_size_kb:.1f}KB")
                            if process_id and file_index is not None:
                                self.update_file_status(process_id, file_index, {
                                    'status': 'completed',
                                    'progress': 100,
                                    'stage': f'Completed! {file_size_kb:.1f}KB (max quality)',
                                    'filename': filename,
                                    'file_size': file_size_kb,
                                    'attempts': attempt
                                })
                            return True
                        initial_bitrate = min(int(initial_bitrate * 1.1), max_bitrate)
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

            # If max attempts reached without success
            self.logger.error(f"[FAILED] {filename}: Max attempts ({conversion_attempts}) reached")
            
            return False
        
        except Exception as e:
            self.logger.error(f"[ERROR] {filename}: Conversion error: {e}")
            
            # Update status to error
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'error',
                    'progress': 0,
                    'stage': f'Conversion error: {str(e)}',
                    'filename': filename
                })
            
            return False

    def hex_edit_file(self, input_file, output_file, process_id=None, file_index=None):
        """Perform hex editing on a single file with simple 0% ? 100% progress tracking"""
        # Use hex_edit_logger for hex editing logs
        logger = hex_edit_logger
        filename = os.path.basename(input_file)

        try:
            logger.info(f"[HEX] Starting hex edit: {filename}")

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
                logger.info(f"[HEX] Found and replaced hex sequence at position {pos} in {filename}")
            else:
                logger.warning(f"[HEX] Target hex sequence not found in {filename}")

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

            logger.info(f"[HEX] Hex edit completed: {filename}")
            return True

        except Exception as e:
            logger.error(f"[HEX] Hex edit failed for {filename}: {e}")
            if process_id and file_index is not None:
                self.update_file_status(process_id, file_index, {
                    'status': 'error',
                    'progress': 0,
                    'stage': f'Hex edit failed: {str(e)}',
                    'filename': filename
                })
            return False

    def batch_convert(self, input_files, output_dir, process_id):
        """Process files ONE BY ONE sequentially with proper progress tracking and memory management"""
        self.logger.info(f"[BATCH] Starting conversion of {len(input_files)} files")
        self.logger.info(f"[BATCH] Process ID: {process_id}")
        self.logger.info(f"[BATCH] Output dir: {output_dir}")
        self.logger.info(f"[BATCH] Processing Mode: CPU-only")
        
        # Validate inputs
        if not input_files:
            self.logger.error("[BATCH] No input files provided!")
            return []
        
        if not output_dir:
            self.logger.error("[BATCH] No output directory provided!")
            return []
        
        # Log full input file details
        for i, input_file in enumerate(input_files):
            self.logger.info(f"[BATCH] File {i+1}: {input_file}")
            if not os.path.exists(input_file):
                self.logger.error(f"[BATCH] Input file does not exist: {input_file}")
            else:
                file_size = os.path.getsize(input_file)
                self.logger.info(f"[BATCH] File {i+1} size: {file_size} bytes")
        
        # Import StatisticsTracker for centralized stats management
        try:
            from stats_tracker import stats_tracker
        except ImportError as e:
            self.logger.error(f"[BATCH] Failed to import StatisticsTracker: {e}")
            stats_tracker = None
        
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

                # Check for pause or stop
                try:
                    with self.process_lock:
                        if process_id in self.active_processes:
                            # Check if stopped
                            if self.active_processes[process_id]["status"] == "stopped":
                                self.logger.info(f"[ABORT] Process {process_id} stopped by user")
                                break
                            
                            # Check if paused - wait until resumed
                            while self.active_processes[process_id].get("paused", False):
                                self.logger.info(f"[PAUSE] Process {process_id} is paused, waiting...")
                                time.sleep(1)  # Check every second
                                # Check if stopped while paused
                                if self.active_processes[process_id]["status"] == "stopped":
                                    self.logger.info(f"[ABORT] Process {process_id} stopped while paused")
                                    break
                except Exception as e:
                    self.logger.error(f"[PAUSE] Error checking pause state: {e}")
                    pass

                # Convert the file - CPU mode only
                success = self.convert_video(input_file, output_file, process_id, i)

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
            
            # Update statistics using centralized StatisticsTracker
            self.logger.info(f"[BATCH] Updating stats for {len(results)} results")
            for i, result in enumerate(results):
                success = result.get("success", False)
                self.logger.info(f"[BATCH] Result {i}: success={success}")
                if stats_tracker:
                    # Log before increment for traceability
                    if success:
                        self.logger.info("[STATS] conversion success +1 (about to update stats.json)")
                    else:
                        self.logger.info("[STATS] conversion fail +1 (about to update stats.json)")
                    stats_tracker.increment_conversion(success=success)
                else:
                    self.logger.warning(f"[BATCH] StatisticsTracker not available, skipping stats update")
            self.logger.info(f"[BATCH] Stats updated successfully")
            
            return results
            
        except Exception as e:
            self.logger.error(f"[BATCH] Critical error: {str(e)}", exc_info=True)
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
        
        # Update statistics for hex edits using centralized StatisticsTracker
        try:
            # Import StatisticsTracker for centralized stats management
            try:
                from stats_tracker import stats_tracker
            except ImportError as e:
                self.logger.error(f"[HEX] Failed to import StatisticsTracker: {e}")
                stats_tracker = None
            
            for result in results:
                success = result.get("success", False)
                if stats_tracker:
                    # Log before increment for traceability
                    if success:
                        self.logger.info("[STATS] hexedit success +1 (about to update stats.json)")
                    else:
                        self.logger.info("[STATS] hexedit fail +1 (about to update stats.json)")
                    stats_tracker.increment_hexedit(success=success)
                else:
                    self.logger.warning(f"[HEX] StatisticsTracker not available, skipping stats update")
            self.logger.info(f"[HEX COMPLETE] Stats updated for hex edits")
        except Exception as e:
            self.logger.error(f"[HEX COMPLETE] Failed to update stats: {e}")
        
        return results