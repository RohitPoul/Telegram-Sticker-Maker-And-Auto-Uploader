#!/usr/bin/env python3
"""
Shared State Module
Centralized state management to avoid circular imports
"""

import threading
import time
import logging

# Create a dedicated logger for shared state
shared_logger = logging.getLogger('SharedState')
shared_logger.setLevel(logging.INFO)

# Global process tracking
active_processes = {}
process_counter = 0
process_lock = threading.Lock()

# Global conversion threads
conversion_threads = {}

# Global sticker bot instance
sticker_bot = None

# Global telegram connection handler
telegram_handler = None

# Global session file tracking
current_session_file = None

def get_next_process_id():
    """Get the next process ID"""
    global process_counter
    with process_lock:
        process_counter += 1
        return f"sticker_{int(time.time() * 1000)}"

def add_process(process_id, process_data):
    """Add a process to active_processes"""
    with process_lock:
        # Ensure default values for tracking
        process_data.setdefault('failed_files', 0)
        process_data.setdefault('file_statuses', {})
        active_processes[process_id] = process_data
        shared_logger.info(f"Added process {process_id} to active_processes")
        shared_logger.info(f"Current processes: {list(active_processes.keys())}")

def get_process(process_id):
    """Get a process from active_processes"""
    with process_lock:
        return active_processes.get(process_id)

def update_process(process_id, updates):
    """Update a process in active_processes"""
    with process_lock:
        if process_id in active_processes:
            active_processes[process_id].update(updates)
            shared_logger.info(f"Updated process {process_id}")
        else:
            shared_logger.warning(f"Process {process_id} not found for update")

def remove_process(process_id):
    """Remove a process from active_processes"""
    with process_lock:
        if process_id in active_processes:
            del active_processes[process_id]
            shared_logger.info(f"Removed process {process_id}")
        else:
            shared_logger.warning(f"Process {process_id} not found for removal")

def get_all_processes():
    """Get all active processes"""
    with process_lock:
        return active_processes.copy()

def clear_all_processes():
    """Clear all active processes"""
    with process_lock:
        active_processes.clear()
        shared_logger.info("Cleared all active processes")

def set_sticker_bot(bot_instance):
    """Set the global sticker bot instance"""
    global sticker_bot
    sticker_bot = bot_instance
    shared_logger.info("Set global sticker bot instance")

def get_sticker_bot():
    """Get the global sticker bot instance"""
    return sticker_bot

def set_telegram_handler(handler_instance):
    """Set the global telegram handler instance"""
    global telegram_handler
    telegram_handler = handler_instance
    shared_logger.info("Set global telegram handler instance")

def get_telegram_handler():
    """Get the global telegram handler instance"""
    return telegram_handler

def set_current_session_file(session_file):
    """Set the current session file"""
    global current_session_file
    current_session_file = session_file
    shared_logger.info(f"Set current session file: {session_file}")

def get_current_session_file():
    """Get the current session file"""
    return current_session_file
