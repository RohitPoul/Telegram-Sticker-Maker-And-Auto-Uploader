#!/usr/bin/env python3
"""
Kill All Python Processes Script
Reliably terminates Python processes used by this app (and optionally all Python)
"""

import os
import sys
import psutil
import signal
import time
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

# Console encoding-safe icons (avoid UnicodeEncodeError on Windows cp1252)
def _supports_unicode():
    enc = getattr(sys.stdout, 'encoding', None) or ''
    return 'UTF-8' in enc.upper()

_UNICODE_OK = _supports_unicode()
ICON_SNAKE = '🐍' if _UNICODE_OK else '[PY]'
ICON_SCAN = '🔍' if _UNICODE_OK else '[SCAN]'
ICON_RESULTS = '📊' if _UNICODE_OK else '[RESULTS]'
ICON_OK = '✅' if _UNICODE_OK else '[OK]'
ICON_INFO = 'ℹ️' if _UNICODE_OK else '[INFO]'
ICON_ERR = '❌' if _UNICODE_OK else '[ERROR]'

# Resolve project root (this file lives in <root>/python/kill_python_processes.py)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT_STR = str(PROJECT_ROOT)

APP_SCRIPT_INDICATORS = {
    'backend.py',
    'sticker_bot.py',
    'telegram_connection_handler.py',
    'video_converter.py',
}


def _is_python_process(proc: psutil.Process) -> bool:
    try:
        name = (proc.info.get('name') or '').lower()
        if 'python' in name:
            return True
        # Fallbacks if name not set
        exe = ''
        try:
            exe = (proc.exe() or '').lower()
        except Exception:
            pass
        if 'python' in exe:
            return True
        cmd0 = ''
        try:
            cl = proc.info.get('cmdline') or []
            cmd0 = (cl[0] if cl else '').lower()
        except Exception:
            cl = []
        return 'python' in cmd0
    except Exception:
        return False


def _belongs_to_our_app(proc: psutil.Process) -> bool:
    """Stronger detection that a python process is part of this repo."""
    try:
        # 1) CWD inside project root
        cwd = proc.info.get('cwd') or ''
        if cwd and cwd.startswith(PROJECT_ROOT_STR):
            return True

        # 2) Any cmdline arg under project root OR contains known scripts
        cmdline = proc.info.get('cmdline') or []
        for arg in cmdline:
            if PROJECT_ROOT_STR in arg:
                return True
            base = os.path.basename(arg)
            if base in APP_SCRIPT_INDICATORS:
                return True

        # 3) Executable in project venv (if any)
        try:
            exe = proc.exe() or ''
            if exe and PROJECT_ROOT_STR in exe:
                return True
        except Exception:
            pass

        return False
    except Exception:
        return False


def _collect_descendant_python(proc: psutil.Process) -> list:
    """Return python children of proc (recursive)."""
    descendants = []
    try:
        for child in proc.children(recursive=True):
            try:
                if _is_python_process(child):
                    descendants.append(child)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
    except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
        pass
    return descendants


def kill_python_processes(target_our_app_only=True, timeout=3.0):
    """
    Kill Python processes – either all or only those related to our app.
    Args:
        target_our_app_only: If True, only kill processes related to this repo
        timeout: seconds to wait for graceful termination before SIGKILL
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
        targets = []

        # First pass: find candidate python processes
        for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'cwd']):
            try:
                if proc.pid == current_pid:
                    continue
                if not _is_python_process(proc):
                    continue

                if target_our_app_only:
                    if not _belongs_to_our_app(proc):
                        continue

                targets.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

        # Add python descendants of our targets (sometimes the root keeps child workers)
        all_targets = {p.pid: p for p in targets}
        for p in list(all_targets.values()):
            for child in _collect_descendant_python(p):
                all_targets.setdefault(child.pid, child)

        logger.info(f"Found {len(all_targets)} Python process(es) to kill (excluding current PID {current_pid})")

        if not all_targets:
            logger.info("No other Python processes found")
            return results

        # Phase 1: Attempt graceful SIGTERM (process and its group)
        is_windows = sys.platform == 'win32'
        for proc in list(all_targets.values()):
            try:
                pid = proc.pid
                name = proc.info.get('name') or proc.name()
                short_cmd = ' '.join((proc.info.get('cmdline') or [])[:3])
                logger.info(f"Terminating PID {pid} [{name}] Cmd: {short_cmd}")

                # Try process group first (Unix/Linux only)
                if not is_windows:
                    try:
                        pgid = os.getpgid(pid)
                        if pgid > 0:
                            os.killpg(pgid, signal.SIGTERM)
                    except Exception:
                        proc.terminate()
                else:
                    # Windows: terminate process and children
                    proc.terminate()
                    # Also try to terminate children on Windows
                    try:
                        for child in proc.children(recursive=True):
                            try:
                                child.terminate()
                            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                                pass
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except Exception as e:
                results["errors"].append(f"TERM failed for {proc.pid}: {e}")

        # Wait up to timeout for them to exit
        end = time.time() + float(timeout)
        remaining = []
        for proc in list(all_targets.values()):
            try:
                wait_left = max(0.0, end - time.time())
                if wait_left:
                    proc.wait(timeout=wait_left)
                else:
                    remaining.append(proc)
            except (psutil.TimeoutExpired, psutil.AccessDenied):
                remaining.append(proc)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                pass

        # Phase 2: SIGKILL any remaining stubborn processes
        for proc in remaining:
            try:
                pid = proc.pid
                if not is_windows:
                    try:
                        pgid = os.getpgid(pid)
                        if pgid > 0:
                            os.killpg(pgid, signal.SIGKILL)
                    except Exception:
                        proc.kill()
                else:
                    # Windows: force kill process and children
                    proc.kill()
                    try:
                        for child in proc.children(recursive=True):
                            try:
                                child.kill()
                            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                                pass
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except Exception as e:
                results["errors"].append(f"KILL failed for {proc.pid}: {e}")

        # Count how many actually died
        killed = 0
        for pid, proc in list(all_targets.items()):
            try:
                if not psutil.pid_exists(pid):
                    killed += 1
                else:
                    # A second short wait to confirm
                    try:
                        proc.wait(timeout=0.5)
                        killed += 1
                    except Exception:
                        pass
            except Exception:
                pass

        results["killed_count"] = killed
        logger.info(f"Kill operation completed. Confirmed {killed} process(es) terminated")

    except Exception as e:
        error_msg = f"Critical error in kill_python_processes: {e}"
        logger.error(error_msg)
        results["success"] = False
        results["errors"].append(error_msg)

    return results


def kill_our_app_processes():
    """
    Kill only Python processes related to our app
    Returns: dict with results
    """
    return kill_python_processes(target_our_app_only=True)


def kill_all_python_processes():
    """
    Kill all Python processes (system-wide)
    Returns: dict with results
    """
    return kill_python_processes(target_our_app_only=False)


def main():
    """Main function for command line usage"""

    # Show current process info
    current_pid = os.getpid()

    # Confirm before killing
    try:
        confirm = input("Are you sure you want to kill ALL Python processes? (y/N): ").strip().lower()
        if confirm not in ['y', 'yes']:
            return
    except KeyboardInterrupt:
        return

    results = kill_python_processes(target_our_app_only=False)


    if results['errors']:
        print(f"Errors: {len(results['errors'])}")
        for error in results['errors']:
            print(f"  - {error}")

    if results['success'] and results['killed_count'] > 0:
    elif results['killed_count'] == 0:
    else:
        print(f"\n{ICON_ERR} Some errors occurred during the kill operation.")

if __name__ == "__main__":
    main()
