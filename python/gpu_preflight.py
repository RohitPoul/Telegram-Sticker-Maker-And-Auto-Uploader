#!/usr/bin/env python
"""
GPU Preflight Check for Video Converter
Ensures optimal GPU utilization by detecting hardware and configuring CUDA support.

This script:
- Detects NVIDIA/AMD/Intel GPUs
- Checks CUDA availability and version
- Verifies FFmpeg GPU support
- Auto-configures for best performance
- Falls back gracefully to CPU if needed
"""

import os
import re
import sys
import json
import shutil
import subprocess
import platform
import time
from typing import Optional, Tuple, Dict, List


def run_command(cmd: List[str], timeout: Optional[int] = 30) -> Tuple[int, str, str]:
    """Run a command and return exit code, stdout, stderr"""
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            shell=False,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return 1, "", "Command timed out"
    except Exception as e:
        return 1, "", str(e)


def detect_nvidia_gpu() -> Tuple[bool, Dict]:
    """Detect NVIDIA GPU using nvidia-smi"""
    info = {
        "has_nvidia": False,
        "driver_version": None,
        "cuda_version": None,
        "gpu_name": None,
        "gpu_memory": None,
        "gpu_count": 0
    }
    
    # Check if nvidia-smi exists
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        print("  nvidia-smi not found in PATH")
        return False, info
    
    # Get basic GPU info
    code, out, err = run_command([nvidia_smi])
    if code != 0:
        print(f"  nvidia-smi failed: {err}")
        return False, info
    
    info["has_nvidia"] = True
    
    # Parse driver and CUDA versions
    driver_match = re.search(r"Driver Version:\s*([0-9.]+)", out)
    cuda_match = re.search(r"CUDA Version:\s*([0-9.]+)", out)
    
    if driver_match:
        info["driver_version"] = driver_match.group(1)
    if cuda_match:
        info["cuda_version"] = cuda_match.group(1)
    
    # Get detailed GPU info
    code, out, err = run_command([
        nvidia_smi, 
        "--query-gpu=name,memory.total,count",
        "--format=csv,noheader,nounits"
    ])
    
    if code == 0 and out:
        lines = out.strip().split('\n')
        if lines:
            parts = lines[0].split(',')
            if len(parts) >= 2:
                info["gpu_name"] = parts[0].strip()
                info["gpu_memory"] = int(float(parts[1].strip()))
                info["gpu_count"] = len(lines)
    
    return True, info


def detect_cuda_toolkit() -> Dict:
    """Check for CUDA toolkit installation"""
    cuda_info = {
        "nvcc_available": False,
        "nvcc_version": None,
        "cuda_path": None
    }
    
    # Check for nvcc
    nvcc = shutil.which("nvcc")
    if nvcc:
        cuda_info["nvcc_available"] = True
        code, out, err = run_command([nvcc, "--version"])
        if code == 0:
            version_match = re.search(r"release (\d+\.\d+)", out)
            if version_match:
                cuda_info["nvcc_version"] = version_match.group(1)
    
    # Check CUDA_PATH environment variable
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path and os.path.exists(cuda_path):
        cuda_info["cuda_path"] = cuda_path
    
    return cuda_info


def check_ffmpeg_gpu_support() -> Dict:
    """Check FFmpeg GPU encoding support"""
    ffmpeg_info = {
        "ffmpeg_available": False,
        "nvenc_available": False,
        "cuda_available": False,
        "qsv_available": False,
        "amf_available": False,
        "filters": {
            "scale_cuda": False,
            "hwupload_cuda": False
        },
        "cuda_filters_available": False
    }
    
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return ffmpeg_info
    
    ffmpeg_info["ffmpeg_available"] = True
    
    # Check for hardware encoders
    code, out, err = run_command([ffmpeg, "-encoders"], timeout=10)
    if code == 0:
        # NVIDIA encoders
        if "h264_nvenc" in out:
            ffmpeg_info["nvenc_available"] = True
        if "cuda" in out.lower():
            ffmpeg_info["cuda_available"] = True
        # Intel Quick Sync
        if "h264_qsv" in out:
            ffmpeg_info["qsv_available"] = True
        # AMD AMF
        if "h264_amf" in out:
            ffmpeg_info["amf_available"] = True
    
    # Check for CUDA preprocessing filters
    code, out, err = run_command([ffmpeg, "-filters"], timeout=10)
    if code == 0:
        if re.search(r"\bscale_cuda\b", out):
            ffmpeg_info["filters"]["scale_cuda"] = True
        if re.search(r"\bhwupload_cuda\b", out):
            ffmpeg_info["filters"]["hwupload_cuda"] = True
        ffmpeg_info["cuda_filters_available"] = (
            ffmpeg_info["filters"]["scale_cuda"] and ffmpeg_info["filters"]["hwupload_cuda"]
        )

    return ffmpeg_info


def check_pytorch_cuda() -> Dict:
    """Check PyTorch CUDA support"""
    pytorch_info = {
        "torch_available": False,
        "torch_version": None,
        "torch_cuda_available": False,
        "torch_cuda_version": None
    }
    
    try:
        import torch
        pytorch_info["torch_available"] = True
        pytorch_info["torch_version"] = torch.__version__
        pytorch_info["torch_cuda_available"] = torch.cuda.is_available()
        if hasattr(torch.version, 'cuda'):
            pytorch_info["torch_cuda_version"] = torch.version.cuda
    except ImportError:
        pass
    except Exception as e:
        print(f"  PyTorch check error: {e}")
    
    return pytorch_info


def suggest_cuda_installation(nvidia_info: Dict) -> List[str]:
    """Suggest CUDA installation based on system"""
    suggestions = []
    
    if not nvidia_info.get("has_nvidia"):
        return ["No NVIDIA GPU detected - CUDA not applicable"]
    
    if not nvidia_info.get("cuda_version"):
        suggestions.append("NVIDIA GPU detected but CUDA not installed!")
        
        if platform.system() == "Windows":
            suggestions.extend([
                "To install CUDA (recommended for 5-10x faster processing):",
                "  1. Using winget: winget install Nvidia.CUDA",
                "  2. Or download from: https://developer.nvidia.com/cuda-downloads",
                "  3. Choose CUDA 11.8 or 12.1 for best compatibility"
            ])
        elif platform.system() == "Linux":
            suggestions.extend([
                "To install CUDA:",
                "  sudo apt-get update",
                "  sudo apt-get install nvidia-cuda-toolkit",
                "Or visit: https://developer.nvidia.com/cuda-downloads"
            ])
    else:
        cuda_ver = nvidia_info.get("cuda_version", "")
        suggestions.append(f"✓ CUDA {cuda_ver} is installed")
        
        # Check if version is optimal
        try:
            major_minor = float(re.match(r'(\d+\.\d+)', cuda_ver).group(1))
            if major_minor < 11.0:
                suggestions.append("  ⚠ Consider upgrading to CUDA 11.8+ for better performance")
        except:
            pass
    
    return suggestions


def get_optimal_gpu_config(nvidia_info: Dict, cuda_info: Dict, ffmpeg_info: Dict) -> Dict:
    """Determine optimal GPU configuration for video conversion"""
    config = {
        "mode": "cpu",
        "encoder": "libvpx-vp9",
        "hwaccel": None,
        "hwaccel_device": None,
        "scale_filter": "scale",
        "reason": []
    }
    
    if not nvidia_info.get("has_nvidia"):
        config["reason"].append("No NVIDIA GPU detected - using CPU")
        return config
    
    # We have NVIDIA GPU
    config["mode"] = "gpu"
    gpu_name = nvidia_info.get("gpu_name", "NVIDIA GPU")
    gpu_memory = nvidia_info.get("gpu_memory", 0)
    
    # Check for CUDA support in FFmpeg
    if ffmpeg_info.get("nvenc_available") and ffmpeg_info.get("cuda_available"):
        config["mode"] = "cuda"
        config["hwaccel"] = "cuda"
        config["hwaccel_device"] = "0"
        config["scale_filter"] = "scale_cuda"
        config["reason"].append(f"✓ CUDA acceleration available for {gpu_name} ({gpu_memory}MB)")
        
        # For WebM we still use libvpx-vp9, but with CUDA preprocessing
        config["encoder"] = "libvpx-vp9"
        config["reason"].append("✓ Using CUDA for preprocessing + VP9 for WebM output")
        
    elif ffmpeg_info.get("nvenc_available"):
        config["mode"] = "nvenc"
        config["hwaccel"] = "cuda"
        config["reason"].append(f"✓ NVENC hardware encoding available for {gpu_name}")
        config["encoder"] = "libvpx-vp9"  # Still VP9 for WebM
        
    else:
        config["reason"].append(f"⚠ {gpu_name} detected but FFmpeg lacks CUDA support")
        config["reason"].append("  Rebuild FFmpeg with --enable-cuda --enable-nvenc")
    
    return config


def write_gpu_config(config: Dict):
    """Write GPU configuration to file for backend to use"""
    config_path = os.path.join(os.path.dirname(__file__), "gpu_config.json")
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    print(f"\nConfiguration saved to: {config_path}")


def main():
    print("=" * 60)
    print("GPU PREFLIGHT CHECK FOR VIDEO CONVERTER")
    print("=" * 60)
    
    print(f"\nSystem: {platform.system()} {platform.release()}")
    print(f"Python: {sys.version.split()[0]}")
    print(f"Executable: {sys.executable}")
    
    # 1. Detect NVIDIA GPU
    print("\n[1/5] Detecting NVIDIA GPU...")
    has_nvidia, nvidia_info = detect_nvidia_gpu()
    print(f"  NVIDIA GPU: {'YES' if has_nvidia else 'NO'}")
    if has_nvidia:
        print(f"  Name: {nvidia_info.get('gpu_name', 'Unknown')}")
        print(f"  Memory: {nvidia_info.get('gpu_memory', 0)}MB")
        print(f"  Driver: {nvidia_info.get('driver_version', 'Unknown')}")
        print(f"  CUDA Version: {nvidia_info.get('cuda_version', 'Not available')}")
    
    # 2. Check CUDA Toolkit
    print("\n[2/5] Checking CUDA Toolkit...")
    cuda_info = detect_cuda_toolkit()
    print(f"  NVCC: {'YES' if cuda_info['nvcc_available'] else 'NO'}")
    if cuda_info['nvcc_version']:
        print(f"  NVCC Version: {cuda_info['nvcc_version']}")
    
    # 3. Check FFmpeg GPU Support
    print("\n[3/5] Checking FFmpeg GPU Support...")
    ffmpeg_info = check_ffmpeg_gpu_support()
    print(f"  FFmpeg: {'YES' if ffmpeg_info['ffmpeg_available'] else 'NO'}")
    if ffmpeg_info['ffmpeg_available']:
        print(f"  NVENC: {'YES' if ffmpeg_info['nvenc_available'] else 'NO'}")
        print(f"  CUDA: {'YES' if ffmpeg_info['cuda_available'] else 'NO'}")
    
    # 4. Check PyTorch (optional)
    print("\n[4/5] Checking PyTorch CUDA Support...")
    pytorch_info = check_pytorch_cuda()
    if pytorch_info['torch_available']:
        print(f"  PyTorch: {pytorch_info['torch_version']}")
        print(f"  CUDA Available: {'YES' if pytorch_info['torch_cuda_available'] else 'NO'}")
        if pytorch_info['torch_cuda_version']:
            print(f"  CUDA Version: {pytorch_info['torch_cuda_version']}")
    else:
        print("  PyTorch: Not installed (not required for video conversion)")
    
    # 5. Determine Optimal Configuration
    print("\n[5/5] Determining Optimal Configuration...")
    optimal_config = get_optimal_gpu_config(nvidia_info, cuda_info, ffmpeg_info)
    
    print(f"\n{'=' * 60}")
    print("RECOMMENDED CONFIGURATION")
    print('=' * 60)
    print(f"Mode: {optimal_config['mode'].upper()}")
    for reason in optimal_config['reason']:
        print(f"  {reason}")
    
    # CUDA Installation Suggestions
    if has_nvidia and not nvidia_info.get('cuda_version'):
        print(f"\n{'=' * 60}")
        print("CUDA INSTALLATION RECOMMENDED")
        print('=' * 60)
        suggestions = suggest_cuda_installation(nvidia_info)
        for suggestion in suggestions:
            print(suggestion)
    
    # Save configuration
    full_config = {
        "nvidia": nvidia_info,
        "cuda_toolkit": cuda_info,
        "ffmpeg": ffmpeg_info,
        "pytorch": pytorch_info,
        "optimal": optimal_config,
        "timestamp": str(time.time())
    }
    
    write_gpu_config(full_config)
    
    print(f"\n{'=' * 60}")
    print("PREFLIGHT CHECK COMPLETE")
    print('=' * 60)
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
