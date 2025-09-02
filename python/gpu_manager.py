import os
import subprocess
import platform
import psutil
import json
import logging
import re
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
    memory_total: int
    memory_used: int
    memory_free: int
    cuda_version: Optional[str] = None

class GPUManager:
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.gpus: List[GPUInfo] = []
        self.cuda_available = False
        self.cuda_version = None
        self.initialization_error = None

        # Monitoring attributes
        self.monitoring_active = False
        self.monitoring_thread = None

        # Detect GPUs and CUDA
        self._detect_gpus()

    def _detect_gpus(self):
        """Detect GPUs and CUDA availability"""
        try:
            self.logger.info("Starting GPU detection...")
            
            # Check CUDA first
            self._check_cuda_availability()

            # Detect NVIDIA GPUs
            nvidia_gpus = self._detect_nvidia_gpus()
            self.gpus.extend(nvidia_gpus)

            # Log detection results
            if self.gpus:
                for gpu in self.gpus:
                    self.logger.info(f"Detected GPU: {gpu.name} (Type: {gpu.type.value})")
                self.logger.info(f"GPU detection completed successfully. Found {len(self.gpus)} GPU(s)")
            else:
                self.logger.warning("No GPUs detected - will use CPU mode")

        except Exception as e:
            self.initialization_error = str(e)
            self.logger.error(f"GPU detection failed: {e}", exc_info=True)
            # Don't re-raise - allow the manager to continue with empty GPU list

    def _check_cuda_availability(self):
        """Check CUDA availability"""
        try:
            self.logger.info("Checking CUDA availability...")
            
            # Try standard CUDA detection methods
            result = subprocess.run(
                ["nvcc", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                match = re.search(r'release (\d+\.\d+)', result.stdout)
                if match:
                    self.cuda_version = match.group(1)
                    self.cuda_available = True
                    self.logger.info(f"CUDA {self.cuda_version} detected")
                else:
                    self.logger.warning("CUDA detected but version parsing failed")
            else:
                self.logger.info("CUDA not found via nvcc command")
                
        except Exception as e:
            self.logger.warning(f"CUDA detection failed: {e}")

    def _detect_nvidia_gpus(self) -> List[GPUInfo]:
        """Detect NVIDIA GPUs"""
        gpus = []
        try:
            self.logger.info("Detecting NVIDIA GPUs...")
            
                        result = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,memory.free", 
                 "--format=csv,noheader,nounits"],
                            capture_output=True,
                            text=True,
                            timeout=5
                        )
                        
                        if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                for line in lines:
                    if line.strip():  # Skip empty lines
                        parts = [p.strip() for p in line.split(',')]
                        if len(parts) >= 5:
                            try:
                                gpu = GPUInfo(
                                    index=int(parts[0]),
                                    name=parts[1],
                                    type=GPUType.NVIDIA,
                                    memory_total=int(float(parts[2])) if parts[2] else 0,
                                    memory_used=int(float(parts[3])) if parts[3] else 0,
                                    memory_free=int(float(parts[4])) if parts[4] else 0,
                                    cuda_version=self.cuda_version if self.cuda_available else None
                                )
                                gpus.append(gpu)
                                self.logger.info(f"Successfully detected NVIDIA GPU: {gpu.name}")
                            except (ValueError, IndexError) as parse_error:
                                self.logger.warning(f"Failed to parse GPU info: {parse_error} for line: {line}")
                self.logger.info(f"Detected {len(gpus)} NVIDIA GPU(s)")
            else:
                self.logger.info("nvidia-smi command failed - no NVIDIA GPUs detected")
                
        except Exception as e:
            self.logger.warning(f"NVIDIA GPU detection failed: {e}")
        
        return gpus

    def get_best_gpu(self) -> Optional[GPUInfo]:
        """Get the best available GPU for processing"""
        if not self.gpus:
            return None
        
        # Sort GPUs by priority: CUDA > GPU > CPU
        # For now, return the first available GPU
        # In the future, this could be enhanced with memory/performance metrics
        return self.gpus[0] if self.gpus else None

    def get_current_stats(self) -> Dict:
        """Get current system and GPU statistics"""
        try:
            stats = {
                'cpu': self.get_cpu_info(),
                'memory': self.get_system_memory(),
                'gpus': []
            }
            
            # Add GPU stats
            for gpu in self.gpus:
                gpu_stats = {
                    'index': gpu.index,
                    'name': gpu.name,
                    'type': gpu.type.value,
                    'memory_total': gpu.memory_total,
                    'memory_used': gpu.memory_used,
                    'memory_free': gpu.memory_free
                }
                stats['gpus'].append(gpu_stats)
                
            return stats
        except Exception as e:
            self.logger.error(f"Failed to get current stats: {e}")
            # Return basic stats on error
            return {
                'cpu': self.get_cpu_info(),
                'memory': self.get_system_memory(),
                'gpus': []
            }

    def get_system_memory(self) -> Dict:
        """Get system RAM information"""
        try:
            memory = psutil.virtual_memory()
            return {
                'total': memory.total // (1024 * 1024),  # MB
                'used': memory.used // (1024 * 1024),
                'free': memory.available // (1024 * 1024),
                'percent': memory.percent
            }
        except Exception as e:
            self.logger.error(f"Failed to get system memory: {e}")
            return {'total': 0, 'used': 0, 'free': 0, 'percent': 0}

    def get_cpu_info(self) -> Dict:
        """Get CPU information"""
        try:
            return {
                'count': psutil.cpu_count(logical=False),
                'threads': psutil.cpu_count(logical=True),
                'percent': psutil.cpu_percent(interval=0.1),
                'frequency': psutil.cpu_freq().current if psutil.cpu_freq() else 0
            }
        except Exception as e:
            self.logger.error(f"Failed to get CPU info: {e}")
            return {'count': 0, 'threads': 0, 'percent': 0, 'frequency': 0}
        
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
        
    def is_healthy(self) -> bool:
        """Check if GPU manager is in a healthy state"""
        return self.initialization_error is None

    def start_monitoring(self, interval=2.0):
        """Start GPU monitoring thread"""
        try:
            import threading
            import time

            def monitor_gpu():
            while self.monitoring_active:
                try:
                        # Collect and log GPU stats
                        if self.gpus:
                    for gpu in self.gpus:
                                gpu_stats = self._get_gpu_stats(gpu)
                                self.logger.info(f"GPU Monitoring: {gpu.name} - {gpu_stats}")
                    except Exception as e:
                        self.logger.warning(f"GPU monitoring error: {e}")
                                
                    time.sleep(interval)
            
            self.monitoring_active = True
            self.monitoring_thread = threading.Thread(target=monitor_gpu, daemon=True)
            self.monitoring_thread.start()
            self.logger.info("GPU monitoring started")
                    
                except Exception as e:
            self.logger.error(f"Failed to start GPU monitoring: {e}")
            self.monitoring_active = False
        
    def stop_monitoring(self):
        """Stop GPU monitoring thread"""
        try:
        self.monitoring_active = False
            if hasattr(self, 'monitoring_thread') and self.monitoring_thread:
                self.monitoring_thread.join(timeout=3)
                self.logger.info("GPU monitoring stopped")
        except Exception as e:
            self.logger.error(f"Error stopping GPU monitoring: {e}")

    def _get_gpu_stats(self, gpu):
        """Get current stats for a specific GPU"""
        try:
            # Placeholder for actual GPU stats retrieval
            # You might want to use nvidia-smi or other GPU-specific tools
            return {
                'memory_used': gpu.memory_used,
                'memory_free': gpu.memory_free,
                'memory_total': gpu.memory_total
            }
        except Exception as e:
            self.logger.warning(f"Failed to get GPU stats for {gpu.name}: {e}")
            return {}
