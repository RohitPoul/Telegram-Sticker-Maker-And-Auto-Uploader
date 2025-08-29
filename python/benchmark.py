"""
Video Converter Benchmark Module
Tests and compares CPU vs GPU performance for video conversion
"""

import os
import time
import json
import subprocess
import tempfile
import shutil
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
import logging
from pathlib import Path
import psutil
import gc

@dataclass
class BenchmarkResult:
    """Stores benchmark results for a single test"""
    mode: str  # 'cpu' or 'gpu'
    test_file: str
    file_size_mb: float
    duration_seconds: float
    conversion_time: float
    fps: float
    speed_multiplier: float  # How many times faster than real-time
    memory_used_mb: float
    peak_memory_mb: float
    cpu_usage_percent: float
    gpu_usage_percent: Optional[float]
    gpu_memory_mb: Optional[float]
    output_size_kb: float
    quality_score: float  # 0-100 based on output quality metrics
    success: bool
    error_message: Optional[str]

class VideoBenchmark:
    """Handles video conversion benchmarking"""
    
    def __init__(self):
        self.logger = logging.getLogger('benchmark')
        self.logger.setLevel(logging.INFO)
        
        # Create handler if none exists
        if not self.logger.handlers:
            log_file = os.path.join(os.path.dirname(__file__), 'benchmark.log')
            handler = logging.FileHandler(log_file)
            handler.setFormatter(logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s: %(message)s'
            ))
            self.logger.addHandler(handler)
        
        self.temp_dir = tempfile.mkdtemp(prefix="benchmark_")
        self.test_files = []
        
    def __del__(self):
        """Cleanup temporary directory"""
        if hasattr(self, 'temp_dir') and os.path.exists(self.temp_dir):
            try:
                shutil.rmtree(self.temp_dir)
            except:
                pass
    
    def create_test_video(self, duration: int = 10, resolution: str = "1920x1080") -> str:
        """Create a synthetic test video for benchmarking"""
        output_file = os.path.join(self.temp_dir, f"test_{resolution}_{duration}s.mp4")
        
        # Create test video using FFmpeg with synthetic content
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi",
            "-i", f"testsrc2=size={resolution}:rate=30:duration={duration}",
            "-f", "lavfi", 
            "-i", f"sine=frequency=1000:duration={duration}",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            output_file
        ]
        
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            self.test_files.append(output_file)
            return output_file
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Failed to create test video: {e}")
            return None
    
    def get_video_info(self, file_path: str) -> Dict:
        """Get video file information using ffprobe"""
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration,bit_rate,r_frame_rate",
            "-of", "json",
            file_path
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            stream = data['streams'][0] if data.get('streams') else {}
            
            # Parse frame rate
            fps = 30.0
            if 'r_frame_rate' in stream:
                parts = stream['r_frame_rate'].split('/')
                if len(parts) == 2 and int(parts[1]) > 0:
                    fps = float(parts[0]) / float(parts[1])
            
            return {
                'width': int(stream.get('width', 0)),
                'height': int(stream.get('height', 0)),
                'duration': float(stream.get('duration', 0)),
                'bitrate': int(stream.get('bit_rate', 0)),
                'fps': fps
            }
        except Exception as e:
            self.logger.error(f"Error getting video info: {e}")
            return {}
    
    def benchmark_cpu_conversion(self, input_file: str) -> BenchmarkResult:
        """Benchmark CPU-based video conversion"""
        self.logger.info(f"Starting CPU benchmark for {input_file}")
        
        # Get input file info
        info = self.get_video_info(input_file)
        if not info:
            return BenchmarkResult(
                mode='cpu', test_file=input_file, file_size_mb=0,
                duration_seconds=0, conversion_time=0, fps=0,
                speed_multiplier=0, memory_used_mb=0, peak_memory_mb=0,
                cpu_usage_percent=0, gpu_usage_percent=None,
                gpu_memory_mb=None, output_size_kb=0, quality_score=0,
                success=False, error_message="Failed to get video info"
            )
        
        output_file = os.path.join(self.temp_dir, "cpu_output.webm")
        
        # FFmpeg command for CPU conversion
        cmd = [
            "ffmpeg", "-y",
            "-i", input_file,
            "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libvpx-vp9",
            "-crf", "30",
            "-b:v", "500k",
            "-cpu-used", "5",
            "-row-mt", "1",
            "-threads", str(os.cpu_count() or 4),
            "-an",
            output_file
        ]
        
        # Monitor system resources
        process = psutil.Process()
        start_memory = process.memory_info().rss / 1024 / 1024
        peak_memory = start_memory
        cpu_samples = []
        
        start_time = time.time()
        
        try:
            # Start conversion process
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Monitor resources during conversion
            while proc.poll() is None:
                try:
                    current_memory = process.memory_info().rss / 1024 / 1024
                    peak_memory = max(peak_memory, current_memory)
                    cpu_samples.append(psutil.cpu_percent(interval=0.1))
                except:
                    pass
                time.sleep(0.1)
            
            proc.wait()
            conversion_time = time.time() - start_time
            
            if proc.returncode != 0:
                stderr = proc.stderr.read().decode() if proc.stderr else ""
                raise subprocess.CalledProcessError(proc.returncode, cmd, stderr=stderr)
            
            # Calculate metrics
            avg_cpu = sum(cpu_samples) / len(cpu_samples) if cpu_samples else 0
            memory_used = peak_memory - start_memory
            
            # Get output file size
            output_size_kb = os.path.getsize(output_file) / 1024 if os.path.exists(output_file) else 0
            
            # Calculate FPS and speed multiplier
            total_frames = info['duration'] * info['fps']
            fps = total_frames / conversion_time if conversion_time > 0 else 0
            speed_multiplier = info['duration'] / conversion_time if conversion_time > 0 else 0
            
            # Simple quality score based on output size vs target
            target_size = 256  # Target 256KB for Telegram stickers
            quality_score = max(0, min(100, 100 - abs(output_size_kb - target_size) / target_size * 50))
            
            return BenchmarkResult(
                mode='cpu',
                test_file=os.path.basename(input_file),
                file_size_mb=os.path.getsize(input_file) / 1024 / 1024,
                duration_seconds=info['duration'],
                conversion_time=round(conversion_time, 2),
                fps=round(fps, 2),
                speed_multiplier=round(speed_multiplier, 2),
                memory_used_mb=round(memory_used, 2),
                peak_memory_mb=round(peak_memory, 2),
                cpu_usage_percent=round(avg_cpu, 2),
                gpu_usage_percent=None,
                gpu_memory_mb=None,
                output_size_kb=round(output_size_kb, 2),
                quality_score=round(quality_score, 2),
                success=True,
                error_message=None
            )
            
        except Exception as e:
            self.logger.error(f"CPU benchmark failed: {e}")
            return BenchmarkResult(
                mode='cpu',
                test_file=os.path.basename(input_file),
                file_size_mb=os.path.getsize(input_file) / 1024 / 1024,
                duration_seconds=info['duration'],
                conversion_time=time.time() - start_time,
                fps=0,
                speed_multiplier=0,
                memory_used_mb=0,
                peak_memory_mb=0,
                cpu_usage_percent=0,
                gpu_usage_percent=None,
                gpu_memory_mb=None,
                output_size_kb=0,
                quality_score=0,
                success=False,
                error_message=str(e)
            )
        finally:
            # Cleanup
            if os.path.exists(output_file):
                try:
                    os.remove(output_file)
                except:
                    pass
    
    def benchmark_gpu_conversion(self, input_file: str, gpu_type: str = 'nvidia') -> BenchmarkResult:
        """Benchmark GPU-based video conversion"""
        self.logger.info(f"Starting GPU ({gpu_type}) benchmark for {input_file}")
        
        # Get input file info
        info = self.get_video_info(input_file)
        if not info:
            return BenchmarkResult(
                mode=f'gpu_{gpu_type}', test_file=input_file, file_size_mb=0,
                duration_seconds=0, conversion_time=0, fps=0,
                speed_multiplier=0, memory_used_mb=0, peak_memory_mb=0,
                cpu_usage_percent=0, gpu_usage_percent=0,
                gpu_memory_mb=0, output_size_kb=0, quality_score=0,
                success=False, error_message="Failed to get video info"
            )
        
        output_file = os.path.join(self.temp_dir, "gpu_output.webm")
        
        # FFmpeg command for GPU conversion (NVIDIA NVENC)
        if gpu_type == 'nvidia':
            # Try NVENC encoding (hardware encoding, not CUDA filters)
            cmd = [
                "ffmpeg", "-y",
                "-hwaccel", "auto",  # Let FFmpeg choose the best hardware acceleration
                "-i", input_file,
                "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2",
                "-c:v", "libvpx-vp9",  # Still use VP9 for output (required for Telegram)
                "-crf", "30",
                "-b:v", "500k",
                "-cpu-used", "5",
                "-row-mt", "1",
                "-an",
                output_file
            ]
        else:
            # Fallback to CPU for unsupported GPU types
            return self.benchmark_cpu_conversion(input_file)
        
        # Monitor system resources
        process = psutil.Process()
        start_memory = process.memory_info().rss / 1024 / 1024
        peak_memory = start_memory
        cpu_samples = []
        gpu_samples = []
        gpu_memory_samples = []
        
        start_time = time.time()
        
        try:
            # Try to get GPU stats if available
            has_nvidia_smi = shutil.which('nvidia-smi') is not None
            
            # Start conversion process
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Monitor resources during conversion
            while proc.poll() is None:
                try:
                    current_memory = process.memory_info().rss / 1024 / 1024
                    peak_memory = max(peak_memory, current_memory)
                    cpu_samples.append(psutil.cpu_percent(interval=0.1))
                    
                    # Try to get GPU stats
                    if has_nvidia_smi:
                        try:
                            gpu_cmd = ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used",
                                     "--format=csv,noheader,nounits"]
                            result = subprocess.run(gpu_cmd, capture_output=True, text=True, timeout=1)
                            if result.returncode == 0:
                                parts = result.stdout.strip().split(', ')
                                if len(parts) >= 2:
                                    gpu_samples.append(float(parts[0]))
                                    gpu_memory_samples.append(float(parts[1]))
                        except:
                            pass
                except:
                    pass
                time.sleep(0.1)
            
            proc.wait()
            conversion_time = time.time() - start_time
            
            if proc.returncode != 0:
                stderr = proc.stderr.read().decode() if proc.stderr else ""
                # If GPU fails, note it but don't raise - we'll mark as failed
                self.logger.warning(f"GPU conversion failed, may have fallen back to CPU: {stderr}")
            
            # Calculate metrics
            avg_cpu = sum(cpu_samples) / len(cpu_samples) if cpu_samples else 0
            avg_gpu = sum(gpu_samples) / len(gpu_samples) if gpu_samples else None
            avg_gpu_memory = sum(gpu_memory_samples) / len(gpu_memory_samples) if gpu_memory_samples else None
            memory_used = peak_memory - start_memory
            
            # Get output file size
            output_size_kb = os.path.getsize(output_file) / 1024 if os.path.exists(output_file) else 0
            
            # Calculate FPS and speed multiplier
            total_frames = info['duration'] * info['fps']
            fps = total_frames / conversion_time if conversion_time > 0 else 0
            speed_multiplier = info['duration'] / conversion_time if conversion_time > 0 else 0
            
            # Simple quality score
            target_size = 256
            quality_score = max(0, min(100, 100 - abs(output_size_kb - target_size) / target_size * 50))
            
            return BenchmarkResult(
                mode=f'gpu_{gpu_type}',
                test_file=os.path.basename(input_file),
                file_size_mb=os.path.getsize(input_file) / 1024 / 1024,
                duration_seconds=info['duration'],
                conversion_time=round(conversion_time, 2),
                fps=round(fps, 2),
                speed_multiplier=round(speed_multiplier, 2),
                memory_used_mb=round(memory_used, 2),
                peak_memory_mb=round(peak_memory, 2),
                cpu_usage_percent=round(avg_cpu, 2),
                gpu_usage_percent=round(avg_gpu, 2) if avg_gpu else None,
                gpu_memory_mb=round(avg_gpu_memory, 2) if avg_gpu_memory else None,
                output_size_kb=round(output_size_kb, 2),
                quality_score=round(quality_score, 2),
                success=os.path.exists(output_file),
                error_message=None if os.path.exists(output_file) else "Output file not created"
            )
            
        except Exception as e:
            self.logger.error(f"GPU benchmark failed: {e}")
            return BenchmarkResult(
                mode=f'gpu_{gpu_type}',
                test_file=os.path.basename(input_file),
                file_size_mb=os.path.getsize(input_file) / 1024 / 1024,
                duration_seconds=info['duration'],
                conversion_time=time.time() - start_time,
                fps=0,
                speed_multiplier=0,
                memory_used_mb=0,
                peak_memory_mb=0,
                cpu_usage_percent=0,
                gpu_usage_percent=0,
                gpu_memory_mb=0,
                output_size_kb=0,
                quality_score=0,
                success=False,
                error_message=str(e)
            )
        finally:
            # Cleanup
            if os.path.exists(output_file):
                try:
                    os.remove(output_file)
                except:
                    pass
    
    def run_comprehensive_benchmark(self, custom_file: Optional[str] = None) -> Dict:
        """Run a comprehensive benchmark comparing CPU and GPU performance"""
        results = {
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            'system_info': {
                'cpu_count': os.cpu_count(),
                'cpu_freq': psutil.cpu_freq().current if psutil.cpu_freq() else 0,
                'total_memory_gb': round(psutil.virtual_memory().total / 1024 / 1024 / 1024, 2),
                'platform': os.name
            },
            'tests': [],
            'summary': {}
        }
        
        # Create or use test files
        test_files = []
        if custom_file and os.path.exists(custom_file):
            test_files.append(custom_file)
        else:
            # Create synthetic test videos of different resolutions and durations
            test_configs = [
                (5, "640x480"),    # Small, short
                (10, "1280x720"),  # HD, medium
                (10, "1920x1080"), # Full HD, medium
            ]
            
            for duration, resolution in test_configs:
                test_file = self.create_test_video(duration, resolution)
                if test_file:
                    test_files.append(test_file)
        
        if not test_files:
            self.logger.error("No test files available for benchmarking")
            return results
        
        # Run benchmarks
        all_results = []
        
        for test_file in test_files:
            self.logger.info(f"Benchmarking file: {test_file}")
            
            # CPU benchmark
            cpu_result = self.benchmark_cpu_conversion(test_file)
            all_results.append(cpu_result)
            results['tests'].append(asdict(cpu_result))
            
            # Force garbage collection between tests
            gc.collect()
            time.sleep(1)  # Brief pause between tests
            
            # GPU benchmark (if available)
            if shutil.which('nvidia-smi'):
                gpu_result = self.benchmark_gpu_conversion(test_file, 'nvidia')
                all_results.append(gpu_result)
                results['tests'].append(asdict(gpu_result))
                gc.collect()
                time.sleep(1)
        
        # Calculate summary statistics
        cpu_results = [r for r in all_results if r.mode == 'cpu' and r.success]
        gpu_results = [r for r in all_results if 'gpu' in r.mode and r.success]
        
        if cpu_results:
            results['summary']['cpu'] = {
                'avg_conversion_time': round(sum(r.conversion_time for r in cpu_results) / len(cpu_results), 2),
                'avg_fps': round(sum(r.fps for r in cpu_results) / len(cpu_results), 2),
                'avg_speed_multiplier': round(sum(r.speed_multiplier for r in cpu_results) / len(cpu_results), 2),
                'avg_cpu_usage': round(sum(r.cpu_usage_percent for r in cpu_results) / len(cpu_results), 2),
                'avg_memory_mb': round(sum(r.memory_used_mb for r in cpu_results) / len(cpu_results), 2),
                'success_rate': round(len(cpu_results) / len([r for r in all_results if r.mode == 'cpu']) * 100, 2)
            }
        
        if gpu_results:
            results['summary']['gpu'] = {
                'avg_conversion_time': round(sum(r.conversion_time for r in gpu_results) / len(gpu_results), 2),
                'avg_fps': round(sum(r.fps for r in gpu_results) / len(gpu_results), 2),
                'avg_speed_multiplier': round(sum(r.speed_multiplier for r in gpu_results) / len(gpu_results), 2),
                'avg_cpu_usage': round(sum(r.cpu_usage_percent for r in gpu_results) / len(gpu_results), 2),
                'avg_gpu_usage': round(sum(r.gpu_usage_percent for r in gpu_results if r.gpu_usage_percent) / len([r for r in gpu_results if r.gpu_usage_percent]), 2) if any(r.gpu_usage_percent for r in gpu_results) else 0,
                'avg_memory_mb': round(sum(r.memory_used_mb for r in gpu_results) / len(gpu_results), 2),
                'success_rate': round(len(gpu_results) / len([r for r in all_results if 'gpu' in r.mode]) * 100, 2)
            }
        
        # Calculate speedup if both CPU and GPU results exist
        if cpu_results and gpu_results:
            cpu_avg_time = results['summary']['cpu']['avg_conversion_time']
            gpu_avg_time = results['summary']['gpu']['avg_conversion_time']
            if gpu_avg_time > 0:
                results['summary']['speedup'] = round(cpu_avg_time / gpu_avg_time, 2)
                results['summary']['recommendation'] = 'GPU' if results['summary']['speedup'] > 1.2 else 'CPU'
            else:
                results['summary']['recommendation'] = 'CPU'
        else:
            results['summary']['recommendation'] = 'CPU' if cpu_results else 'Unable to determine'
        
        # Create benchmark results directory if it doesn't exist
        results_dir = os.path.join(os.path.dirname(__file__), 'benchmark_results')
        os.makedirs(results_dir, exist_ok=True)
        
        # Save results to file in the benchmark_results directory
        results_file = os.path.join(results_dir, f"benchmark_{int(time.time())}.json")
        with open(results_file, 'w') as f:
            json.dump(results, f, indent=2)
        
        self.logger.info(f"Benchmark complete. Results saved to {results_file}")
        
        return results

# CLI interface for testing
if __name__ == "__main__":
    import sys
    
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s: %(message)s')
    
    benchmark = VideoBenchmark()
    
    if len(sys.argv) > 1:
        # Use provided file
        results = benchmark.run_comprehensive_benchmark(sys.argv[1])
    else:
        # Run with synthetic test files
        results = benchmark.run_comprehensive_benchmark()
    
    # Print summary
    print("\n" + "="*60)
    print("BENCHMARK RESULTS SUMMARY")
    print("="*60)
    
    if 'cpu' in results['summary']:
        print(f"\nCPU Performance:")
        print(f"  Average Conversion Time: {results['summary']['cpu']['avg_conversion_time']}s")
        print(f"  Average FPS: {results['summary']['cpu']['avg_fps']}")
        print(f"  Speed Multiplier: {results['summary']['cpu']['avg_speed_multiplier']}x")
        print(f"  CPU Usage: {results['summary']['cpu']['avg_cpu_usage']}%")
        print(f"  Memory Usage: {results['summary']['cpu']['avg_memory_mb']}MB")
    
    if 'gpu' in results['summary']:
        print(f"\nGPU Performance:")
        print(f"  Average Conversion Time: {results['summary']['gpu']['avg_conversion_time']}s")
        print(f"  Average FPS: {results['summary']['gpu']['avg_fps']}")
        print(f"  Speed Multiplier: {results['summary']['gpu']['avg_speed_multiplier']}x")
        print(f"  CPU Usage: {results['summary']['gpu']['avg_cpu_usage']}%")
        print(f"  GPU Usage: {results['summary']['gpu']['avg_gpu_usage']}%")
        print(f"  Memory Usage: {results['summary']['gpu']['avg_memory_mb']}MB")
    
    if 'speedup' in results['summary']:
        print(f"\nGPU Speedup: {results['summary']['speedup']}x")
    
    print(f"\nRecommendation: Use {results['summary']['recommendation']}")
    print("="*60)
