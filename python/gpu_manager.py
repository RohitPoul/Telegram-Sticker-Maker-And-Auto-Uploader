import os
import subprocess
import platform
import psutil
import json
import logging
import threading
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

class GPUType(Enum):
    NVIDIA = "nvidia"
    AMD = "amd"
    INTEL = "intel"
    APPLE = "apple"
    UNKNOWN = "unknown"

@dataclass
class GPUInfo:
    index: int
    name: str
    type: GPUType
    memory_total: int  # MB
    memory_used: int   # MB
    memory_free: int   # MB
    utilization: float  # percentage
    temperature: float  # celsius
    driver_version: str
    cuda_version: Optional[str] = None
    compute_capability: Optional[str] = None
    memory_utilization: float = 0  # Memory utilization percentage
    power_draw: float = 0  # Watts
    core_clock: int = 0  # MHz
    memory_clock: int = 0  # MHz

class GPUManager:
    """Comprehensive GPU detection and management with fallback support"""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.gpus: List[GPUInfo] = []
        self.cpu_count = psutil.cpu_count()
        self.monitoring_thread = None
        self.monitoring_active = False
        self.stats_callback = None
        self.memory_threshold = 90  # Warning at 90% memory usage
        self.cuda_available = False
        self.cuda_version = None
        self.cudnn_available = False
        
        # Check CUDA availability first
        self.check_cuda_availability()
        
        # Detect available GPUs on initialization
        self.detect_all_gpus()
    
    def check_cuda_availability(self):
        """Check if CUDA is available and get version information"""
        try:
            # Check for CUDA toolkit
            result = subprocess.run(
                ["nvcc", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                # Parse CUDA version
                import re
                match = re.search(r'release (\d+\.\d+)', result.stdout)
                if match:
                    self.cuda_version = match.group(1)
                    self.cuda_available = True
                    self.logger.info(f"CUDA {self.cuda_version} detected")
            
            # Check for cuDNN
            try:
                import ctypes
                if platform.system() == "Windows":
                    cudnn = ctypes.WinDLL("cudnn64_8.dll")
                    self.cudnn_available = True
                    self.logger.info("cuDNN detected")
            except:
                pass
                
        except (subprocess.TimeoutExpired, FileNotFoundError):
            self.logger.info("CUDA toolkit not found")
            
        # Check if NVIDIA GPU exists but CUDA is not installed
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0 and result.stdout.strip():
                if not self.cuda_available:
                    self.logger.warning("NVIDIA GPU detected but CUDA not installed")
                    # This info will be used to prompt user for CUDA installation
                    
        except:
            pass
    
    def get_cuda_install_command(self) -> Dict[str, str]:
        """Get platform-specific CUDA installation command"""
        if platform.system() == "Windows":
            return {
                "url": "https://developer.nvidia.com/cuda-downloads",
                "command": "winget install Nvidia.CUDA",
                "manual_url": "https://developer.nvidia.com/cuda-11-8-0-download-archive",
                "description": "CUDA Toolkit 11.8 or later recommended for optimal performance"
            }
        elif platform.system() == "Linux":
            return {
                "url": "https://developer.nvidia.com/cuda-downloads",
                "command": "sudo apt-get install nvidia-cuda-toolkit",
                "manual_url": "https://developer.nvidia.com/cuda-downloads?target_os=Linux",
                "description": "CUDA Toolkit for Linux"
            }
        else:
            return {
                "url": "https://developer.nvidia.com/cuda-downloads",
                "command": "",
                "manual_url": "https://developer.nvidia.com/cuda-downloads",
                "description": "CUDA Toolkit"
            }
        
    def detect_all_gpus(self) -> List[GPUInfo]:
        """Detect all available GPUs from different vendors"""
        self.gpus = []
        
        # Try NVIDIA GPUs
        nvidia_gpus = self._detect_nvidia_gpus()
        self.gpus.extend(nvidia_gpus)
        
        # Try AMD GPUs
        amd_gpus = self._detect_amd_gpus()
        self.gpus.extend(amd_gpus)
        
        # Try Intel GPUs
        intel_gpus = self._detect_intel_gpus()
        self.gpus.extend(intel_gpus)
        
        # Try Apple Silicon (for macOS)
        if platform.system() == "Darwin":
            apple_gpus = self._detect_apple_gpus()
            self.gpus.extend(apple_gpus)
        
        self.logger.info(f"Detected {len(self.gpus)} GPU(s)")
        return self.gpus
    
    def _detect_nvidia_gpus(self) -> List[GPUInfo]:
        """Detect NVIDIA GPUs using nvidia-smi"""
        gpus = []
        try:
            # Check if nvidia-smi is available
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,driver_version",
                 "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                for line in lines:
                    if line:
                        parts = [p.strip() for p in line.split(',')]
                        if len(parts) >= 8:
                            gpu = GPUInfo(
                                index=int(parts[0]),
                                name=parts[1],
                                type=GPUType.NVIDIA,
                                memory_total=int(float(parts[2])) if parts[2] else 0,
                                memory_used=int(float(parts[3])) if parts[3] else 0,
                                memory_free=int(float(parts[4])) if parts[4] else 0,
                                utilization=float(parts[5]) if parts[5] else 0,
                                temperature=float(parts[6]) if parts[6] and parts[6] != 'N/A' else 0,
                                driver_version=parts[7]
                            )
                            
                            # Add CUDA version if available
                            if self.cuda_available:
                                gpu.cuda_version = self.cuda_version
                            else:
                                gpu.cuda_version = None
                            
                            gpus.append(gpu)
                            self.logger.info(f"Detected NVIDIA GPU: {gpu.name}")
                            
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
            self.logger.debug(f"NVIDIA GPU detection failed: {e}")
            
        return gpus
    
    def _detect_amd_gpus(self) -> List[GPUInfo]:
        """Detect AMD GPUs"""
        gpus = []
        try:
            # Try rocm-smi for AMD GPUs
            result = subprocess.run(
                ["rocm-smi", "--showid", "--showname", "--showmeminfo", "vram"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                # Parse AMD GPU info
                lines = result.stdout.strip().split('\n')
                gpu_index = 0
                for line in lines:
                    if "GPU" in line and ":" in line:
                        name = line.split(':')[1].strip() if ':' in line else "AMD GPU"
                        gpu = GPUInfo(
                            index=gpu_index,
                            name=name,
                            type=GPUType.AMD,
                            memory_total=0,
                            memory_used=0,
                            memory_free=0,
                            utilization=0,
                            temperature=0,
                            driver_version="AMD Driver"
                        )
                        gpus.append(gpu)
                        gpu_index += 1
                        self.logger.info(f"Detected AMD GPU: {name}")
                        
        except (subprocess.TimeoutExpired, FileNotFoundError):
            # Try alternative detection for Windows
            if platform.system() == "Windows":
                gpus.extend(self._detect_amd_gpus_windows())
                
        except Exception as e:
            self.logger.debug(f"AMD GPU detection failed: {e}")
            
        return gpus
    
    def _detect_amd_gpus_windows(self) -> List[GPUInfo]:
        """Detect AMD GPUs on Windows using WMI"""
        gpus = []
        try:
            # Use PowerShell to query WMI for AMD GPUs
            ps_script = """
            Get-WmiObject Win32_VideoController | 
            Where-Object {$_.Name -like '*AMD*' -or $_.Name -like '*Radeon*'} | 
            Select-Object Name, AdapterRAM, DriverVersion | 
            ConvertTo-Json
            """
            
            result = subprocess.run(
                ["powershell", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0 and result.stdout:
                data = json.loads(result.stdout)
                if not isinstance(data, list):
                    data = [data]
                    
                for idx, item in enumerate(data):
                    gpu = GPUInfo(
                        index=idx,
                        name=item.get('Name', 'AMD GPU'),
                        type=GPUType.AMD,
                        memory_total=int(item.get('AdapterRAM', 0)) // (1024 * 1024) if item.get('AdapterRAM') else 0,
                        memory_used=0,
                        memory_free=0,
                        utilization=0,
                        temperature=0,
                        driver_version=item.get('DriverVersion', 'Unknown')
                    )
                    gpus.append(gpu)
                    self.logger.info(f"Detected AMD GPU (Windows): {gpu.name}")
                    
        except Exception as e:
            self.logger.debug(f"AMD GPU Windows detection failed: {e}")
            
        return gpus
    
    def _detect_intel_gpus(self) -> List[GPUInfo]:
        """Detect Intel integrated GPUs"""
        gpus = []
        try:
            if platform.system() == "Windows":
                # Use PowerShell to query WMI for Intel GPUs
                ps_script = """
                Get-WmiObject Win32_VideoController | 
                Where-Object {$_.Name -like '*Intel*'} | 
                Select-Object Name, AdapterRAM, DriverVersion | 
                ConvertTo-Json
                """
                
                result = subprocess.run(
                    ["powershell", "-Command", ps_script],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                
                if result.returncode == 0 and result.stdout:
                    data = json.loads(result.stdout)
                    if not isinstance(data, list):
                        data = [data]
                        
                    for idx, item in enumerate(data):
                        gpu = GPUInfo(
                            index=idx,
                            name=item.get('Name', 'Intel GPU'),
                            type=GPUType.INTEL,
                            memory_total=int(item.get('AdapterRAM', 0)) // (1024 * 1024) if item.get('AdapterRAM') else 0,
                            memory_used=0,
                            memory_free=0,
                            utilization=0,
                            temperature=0,
                            driver_version=item.get('DriverVersion', 'Unknown')
                        )
                        gpus.append(gpu)
                        self.logger.info(f"Detected Intel GPU: {gpu.name}")
                        
            elif platform.system() == "Linux":
                # Try to detect Intel GPU on Linux
                result = subprocess.run(
                    ["lspci", "-nn"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                
                if result.returncode == 0:
                    lines = result.stdout.strip().split('\n')
                    intel_gpu_count = 0
                    for line in lines:
                        if 'Intel' in line and ('VGA' in line or 'Display' in line):
                            # Extract GPU name
                            name = "Intel GPU"
                            if ':' in line:
                                parts = line.split(':')
                                if len(parts) >= 3:
                                    name = parts[2].strip()
                                    
                            gpu = GPUInfo(
                                index=intel_gpu_count,
                                name=name,
                                type=GPUType.INTEL,
                                memory_total=0,
                                memory_used=0,
                                memory_free=0,
                                utilization=0,
                                temperature=0,
                                driver_version="Intel Driver"
                            )
                            gpus.append(gpu)
                            intel_gpu_count += 1
                            self.logger.info(f"Detected Intel GPU (Linux): {name}")
                            
        except Exception as e:
            self.logger.debug(f"Intel GPU detection failed: {e}")
            
        return gpus
    
    def _detect_apple_gpus(self) -> List[GPUInfo]:
        """Detect Apple Silicon GPUs"""
        gpus = []
        try:
            # Use system_profiler to get GPU info on macOS
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-json"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                data = json.loads(result.stdout)
                displays = data.get('SPDisplaysDataType', [])
                
                for idx, display in enumerate(displays):
                    gpu_name = display.get('sppci_model', 'Apple GPU')
                    gpu = GPUInfo(
                        index=idx,
                        name=gpu_name,
                        type=GPUType.APPLE,
                        memory_total=display.get('spdisplays_vram', 0),
                        memory_used=0,
                        memory_free=0,
                        utilization=0,
                        temperature=0,
                        driver_version=display.get('spdisplays_metal', 'Metal')
                    )
                    gpus.append(gpu)
                    self.logger.info(f"Detected Apple GPU: {gpu_name}")
                    
        except Exception as e:
            self.logger.debug(f"Apple GPU detection failed: {e}")
            
        return gpus
    
    def _get_cuda_version(self) -> Optional[str]:
        """Get CUDA version if available"""
        try:
            result = subprocess.run(
                ["nvcc", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                for line in lines:
                    if 'release' in line.lower():
                        # Extract version number
                        import re
                        match = re.search(r'release (\d+\.\d+)', line)
                        if match:
                            return match.group(1)
                            
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
            
        return None
    
    def get_system_memory(self) -> Dict:
        """Get system RAM information"""
        memory = psutil.virtual_memory()
        return {
            'total': memory.total // (1024 * 1024),  # MB
            'used': memory.used // (1024 * 1024),
            'free': memory.available // (1024 * 1024),
            'percent': memory.percent
        }
    
    def get_cpu_info(self) -> Dict:
        """Get CPU information"""
        return {
            'count': psutil.cpu_count(logical=False),
            'threads': psutil.cpu_count(logical=True),
            'percent': psutil.cpu_percent(interval=0.1),
            'frequency': psutil.cpu_freq().current if psutil.cpu_freq() else 0
        }
    
    def select_best_gpu(self, prefer_type: Optional[GPUType] = None) -> Optional[GPUInfo]:
        """Select the best available GPU with heavy preference for CUDA-enabled GPUs"""
        if not self.gpus:
            return None
            
        # Priority order: NVIDIA with CUDA >> NVIDIA > AMD > Intel > Apple > Unknown
        priority_order = {
            GPUType.NVIDIA: 4,
            GPUType.AMD: 3,
            GPUType.INTEL: 2,
            GPUType.APPLE: 1,
            GPUType.UNKNOWN: 0
        }
        
        # Score each GPU based on type priority, CUDA, memory, and availability
        scored_gpus = []
        for gpu in self.gpus:
            # Base score from GPU type
            type_score = priority_order.get(gpu.type, 0) * 1000
            
            # MASSIVE bonus for CUDA-enabled NVIDIA GPUs
            cuda_bonus = 0
            if gpu.type == GPUType.NVIDIA and gpu.cuda_version:
                cuda_bonus = 10000  # Huge bonus for CUDA
                self.logger.info(f"GPU {gpu.name} has CUDA {gpu.cuda_version} - adding bonus score")
            
            # Memory score (more memory is better)
            memory_score = (gpu.memory_total // 100) if gpu.memory_total > 0 else 0
            
            # Availability score (lower usage is better)
            if gpu.memory_total > 0:
                usage_percent = (gpu.memory_used / gpu.memory_total) * 100
                availability_score = max(0, 100 - usage_percent)
            else:
                availability_score = 50  # Default score if memory info not available
                
            total_score = type_score + cuda_bonus + memory_score + availability_score
            scored_gpus.append((gpu, total_score))
            
        # Sort by score (highest first)
        scored_gpus.sort(key=lambda x: x[1], reverse=True)
        
        # Return the best GPU if it's usable (below memory threshold)
        for gpu, score in scored_gpus:
            if gpu.memory_total > 0:
                usage_percent = (gpu.memory_used / gpu.memory_total) * 100
                if usage_percent < self.memory_threshold:
                    self.logger.info(f"Selected GPU: {gpu.name} (Score: {score}, Usage: {usage_percent:.1f}%)")
                    return gpu
            else:
                # If no memory info, still use it
                self.logger.info(f"Selected GPU: {gpu.name} (Score: {score})")
                return gpu
                    
        # If all GPUs are above threshold, return the best one anyway
        if scored_gpus:
            best_gpu = scored_gpus[0][0]
            self.logger.warning(f"All GPUs above memory threshold, using: {best_gpu.name}")
            return best_gpu
            
        return None
    
    def get_ffmpeg_gpu_params(self, gpu: Optional[GPUInfo] = None) -> Tuple[List[str], str]:
        """Get FFmpeg parameters for GPU acceleration based on GPU type"""
        if not gpu:
            # CPU fallback
            return [], "cpu"
            
        if gpu.type == GPUType.NVIDIA:
            # NVIDIA NVENC parameters
            return [
                "-hwaccel", "cuda",
                "-hwaccel_output_format", "cuda"
            ], "nvidia"
            
        elif gpu.type == GPUType.AMD:
            # AMD AMF/VCE parameters
            if platform.system() == "Windows":
                return [
                    "-hwaccel", "d3d11va",
                    "-hwaccel_output_format", "d3d11"
                ], "amd"
            else:
                # Linux AMD
                return [
                    "-vaapi_device", "/dev/dri/renderD128",
                    "-hwaccel", "vaapi",
                    "-hwaccel_output_format", "vaapi"
                ], "amd"
                
        elif gpu.type == GPUType.INTEL:
            # Intel Quick Sync Video
            if platform.system() == "Windows":
                return [
                    "-hwaccel", "qsv",
                    "-c:v", "h264_qsv"
                ], "intel"
            else:
                # Linux Intel
                return [
                    "-vaapi_device", "/dev/dri/renderD128",
                    "-hwaccel", "vaapi"
                ], "intel"
                
        elif gpu.type == GPUType.APPLE:
            # Apple VideoToolbox
            return [
                "-hwaccel", "videotoolbox"
            ], "apple"
            
        return [], "cpu"
    
    def get_encoder_for_gpu(self, gpu: Optional[GPUInfo], codec: str = "h264") -> str:
        """Get the appropriate encoder for the GPU type"""
        if not gpu:
            # CPU encoders
            if codec == "h264":
                return "libx264"
            elif codec == "vp9":
                return "libvpx-vp9"
            return codec
            
        if gpu.type == GPUType.NVIDIA:
            if codec == "h264":
                return "h264_nvenc"
            elif codec == "hevc":
                return "hevc_nvenc"
            elif codec == "vp9":
                return "libvpx-vp9"  # VP9 doesn't have NVENC support
                
        elif gpu.type == GPUType.AMD:
            if codec == "h264":
                return "h264_amf" if platform.system() == "Windows" else "h264_vaapi"
            elif codec == "hevc":
                return "hevc_amf" if platform.system() == "Windows" else "hevc_vaapi"
                
        elif gpu.type == GPUType.INTEL:
            if codec == "h264":
                return "h264_qsv" if platform.system() == "Windows" else "h264_vaapi"
            elif codec == "hevc":
                return "hevc_qsv" if platform.system() == "Windows" else "hevc_vaapi"
                
        elif gpu.type == GPUType.APPLE:
            if codec == "h264":
                return "h264_videotoolbox"
            elif codec == "hevc":
                return "hevc_videotoolbox"
                
        # Fallback to CPU encoder
        return self.get_encoder_for_gpu(None, codec)
    
    def start_monitoring(self, callback=None, interval=1.0):
        """Start monitoring GPU and system resources"""
        if self.monitoring_active:
            return
            
        self.stats_callback = callback
        self.monitoring_active = True
        
        def monitor():
            while self.monitoring_active:
                try:
                    stats = self.get_current_stats()
                    if self.stats_callback:
                        self.stats_callback(stats)
                        
                    # Check for memory warnings
                    for gpu in self.gpus:
                        if gpu.memory_total > 0:
                            usage_percent = (gpu.memory_used / gpu.memory_total) * 100
                            if usage_percent > self.memory_threshold:
                                self.logger.warning(f"GPU {gpu.name} memory usage high: {usage_percent:.1f}%")
                                
                    time.sleep(interval)
                    
                except Exception as e:
                    self.logger.error(f"Monitoring error: {e}")
                    time.sleep(interval)
                    
        self.monitoring_thread = threading.Thread(target=monitor, daemon=True)
        self.monitoring_thread.start()
        
    def stop_monitoring(self):
        """Stop monitoring resources"""
        self.monitoring_active = False
        if self.monitoring_thread:
            self.monitoring_thread.join(timeout=5)
            
    def get_current_stats(self) -> Dict:
        """Get current system and GPU statistics"""
        stats = {
            'cpu': self.get_cpu_info(),
            'memory': self.get_system_memory(),
            'gpus': []
        }
        
        # Update GPU stats
        for gpu in self.gpus:
            if gpu.type == GPUType.NVIDIA:
                # Update NVIDIA GPU stats
                self._update_nvidia_gpu_stats(gpu)
                
            gpu_stats = {
                'index': gpu.index,
                'name': gpu.name,
                'type': gpu.type.value,
                'memory_total': gpu.memory_total,
                'memory_used': gpu.memory_used,
                'memory_free': gpu.memory_free,
                'utilization': gpu.utilization,
                'temperature': gpu.temperature
            }
            stats['gpus'].append(gpu_stats)
            
        return stats
    
    def _update_nvidia_gpu_stats(self, gpu: GPUInfo):
        """Update NVIDIA GPU statistics with more detailed metrics"""
        try:
            # Get comprehensive GPU stats
            result = subprocess.run(
                ["nvidia-smi", f"--id={gpu.index}",
                 "--query-gpu=memory.used,memory.free,memory.total,utilization.gpu,utilization.memory,temperature.gpu,power.draw,clocks.current.graphics,clocks.current.memory",
                 "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=2
            )
            
            if result.returncode == 0:
                parts = [p.strip() for p in result.stdout.strip().split(',')]
                if len(parts) >= 6:
                    gpu.memory_used = int(float(parts[0])) if parts[0] else gpu.memory_used
                    gpu.memory_free = int(float(parts[1])) if parts[1] else gpu.memory_free
                    gpu.memory_total = int(float(parts[2])) if parts[2] else gpu.memory_total
                    gpu.utilization = float(parts[3]) if parts[3] else gpu.utilization
                    
                    # Additional metrics for detailed monitoring
                    if len(parts) >= 9:
                        gpu.memory_utilization = float(parts[4]) if parts[4] else 0
                        gpu.temperature = float(parts[5]) if parts[5] and parts[5] != 'N/A' else gpu.temperature
                        gpu.power_draw = float(parts[6]) if parts[6] and parts[6] != 'N/A' else 0
                        gpu.core_clock = int(float(parts[7])) if parts[7] and parts[7] != 'N/A' else 0
                        gpu.memory_clock = int(float(parts[8])) if parts[8] and parts[8] != 'N/A' else 0
                    
        except Exception as e:
            self.logger.debug(f"Failed to update NVIDIA GPU stats: {e}")
            
    def cleanup(self):
        """Cleanup resources and stop monitoring"""
        self.stop_monitoring()
        
    def get_gpu_memory_usage(self, gpu_index: int = 0) -> Tuple[int, int, float]:
        """Get GPU memory usage (used, total, percent)"""
        if gpu_index < len(self.gpus):
            gpu = self.gpus[gpu_index]
            if gpu.memory_total > 0:
                percent = (gpu.memory_used / gpu.memory_total) * 100
                return gpu.memory_used, gpu.memory_total, percent
        return 0, 0, 0.0
