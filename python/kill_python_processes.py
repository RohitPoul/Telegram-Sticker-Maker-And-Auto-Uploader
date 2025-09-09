#!/usr/bin/env python3
"""
Kill All Python Processes Script
Safely terminates all Python processes on the system
"""

import os
import sys
import psutil
import signal
import time
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

def kill_python_processes():
    """
    Kill all Python processes except the current one
    Returns: dict with results
    """
    results = {
        "success": True,
        "killed_count": 0,
        "errors": [],
        "current_pid": os.getpid()
    }
    
    try:
        current_pid = os.getpid()
        python_processes = []
        
        # Find all Python processes
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                # Check if it's a Python process
                if proc.info['name'] and 'python' in proc.info['name'].lower():
                    # Skip current process
                    if proc.info['pid'] != current_pid:
                        python_processes.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        
        logger.info(f"Found {len(python_processes)} Python processes to kill (excluding current PID {current_pid})")
        
        if not python_processes:
            logger.info("No other Python processes found")
            return results
        
        # Kill each process
        for proc in python_processes:
            try:
                pid = proc.info['pid']
                name = proc.info['name']
                cmdline = ' '.join(proc.info['cmdline'][:3]) if proc.info['cmdline'] else 'Unknown'
                
                logger.info(f"Killing Python process: PID {pid}, Name: {name}, Cmd: {cmdline}")
                
                # Try graceful termination first
                proc.terminate()
                
                # Wait a bit for graceful shutdown
                try:
                    proc.wait(timeout=3)
                    logger.info(f"Process {pid} terminated gracefully")
                except psutil.TimeoutExpired:
                    # Force kill if it doesn't terminate gracefully
                    logger.warning(f"Process {pid} didn't terminate gracefully, force killing...")
                    proc.kill()
                    proc.wait(timeout=2)
                    logger.info(f"Process {pid} force killed")
                
                results["killed_count"] += 1
                
            except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                error_msg = f"Could not kill process {proc.info['pid']}: {e}"
                logger.warning(error_msg)
                results["errors"].append(error_msg)
            except Exception as e:
                error_msg = f"Unexpected error killing process {proc.info['pid']}: {e}"
                logger.error(error_msg)
                results["errors"].append(error_msg)
        
        logger.info(f"Kill operation completed. Killed {results['killed_count']} processes")
        
    except Exception as e:
        error_msg = f"Critical error in kill_python_processes: {e}"
        logger.error(error_msg)
        results["success"] = False
        results["errors"].append(error_msg)
    
    return results

def main():
    """Main function for command line usage"""
    print("🐍 Python Process Killer")
    print("=" * 40)
    
    # Show current process info
    current_pid = os.getpid()
    print(f"Current process PID: {current_pid}")
    print(f"Current process name: {psutil.Process(current_pid).name()}")
    print()
    
    # Confirm before killing
    try:
        confirm = input("Are you sure you want to kill ALL Python processes? (y/N): ").strip().lower()
        if confirm not in ['y', 'yes']:
            print("Operation cancelled.")
            return
    except KeyboardInterrupt:
        print("\nOperation cancelled.")
        return
    
    print("\n🔍 Scanning for Python processes...")
    results = kill_python_processes()
    
    print("\n📊 Results:")
    print(f"Success: {results['success']}")
    print(f"Processes killed: {results['killed_count']}")
    
    if results['errors']:
        print(f"Errors: {len(results['errors'])}")
        for error in results['errors']:
            print(f"  - {error}")
    
    if results['success'] and results['killed_count'] > 0:
        print("\n✅ All Python processes have been terminated!")
    elif results['killed_count'] == 0:
        print("\nℹ️  No Python processes were found to kill.")
    else:
        print("\n❌ Some errors occurred during the kill operation.")

if __name__ == "__main__":
    main()
