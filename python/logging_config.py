"""
Professional logging configuration for the sticker bot application.
This module sets up proper file-based logging with rotation and filtering.
"""

import logging
import logging.handlers
import os
import sys
from datetime import datetime
from pathlib import Path

class StickerBotLogger:
    """Professional logger configuration for sticker bot operations."""
    
    def __init__(self, log_dir="logs"):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(exist_ok=True)
        self.setup_logging()
    
    def setup_logging(self):
        """Configure logging with file rotation and proper formatting."""
        
        # Create formatters
        detailed_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        simple_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%H:%M:%S'
        )
        
        # Main application logger
        main_logger = logging.getLogger('sticker_bot')
        main_logger.setLevel(logging.WARNING)  # Only warnings and errors
        
        # Remove existing handlers to avoid duplicates
        main_logger.handlers.clear()
        
        # File handler with rotation (10MB max, keep 5 files)
        main_log_file = self.log_dir / 'sticker_bot.log'
        file_handler = logging.handlers.RotatingFileHandler(
            main_log_file,
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(detailed_formatter)
        main_logger.addHandler(file_handler)
        
        # Error-only file handler
        error_log_file = self.log_dir / 'sticker_bot_errors.log'
        error_handler = logging.handlers.RotatingFileHandler(
            error_log_file,
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3,
            encoding='utf-8'
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(detailed_formatter)
        main_logger.addHandler(error_handler)
        
        # Console handler (only for errors and critical messages)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(logging.ERROR)
        console_handler.setFormatter(simple_formatter)
        main_logger.addHandler(console_handler)
        
        # Sticker creation specific logger
        sticker_logger = logging.getLogger('sticker_bot.creation')
        sticker_logger.setLevel(logging.INFO)  # Keep INFO for creation progress
        
        # Sticker creation log file
        sticker_log_file = self.log_dir / 'sticker_creation.log'
        sticker_file_handler = logging.handlers.RotatingFileHandler(
            sticker_log_file,
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3,
            encoding='utf-8'
        )
        sticker_file_handler.setLevel(logging.INFO)
        sticker_file_handler.setFormatter(detailed_formatter)
        sticker_logger.addHandler(sticker_file_handler)
        
        # Telegram connection logger
        telegram_logger = logging.getLogger('sticker_bot.telegram')
        telegram_logger.setLevel(logging.WARNING)  # Only warnings and errors
        
        # Telegram connection log file
        telegram_log_file = self.log_dir / 'telegram_connection.log'
        telegram_file_handler = logging.handlers.RotatingFileHandler(
            telegram_log_file,
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3,
            encoding='utf-8'
        )
        telegram_file_handler.setLevel(logging.WARNING)
        telegram_file_handler.setFormatter(detailed_formatter)
        telegram_logger.addHandler(telegram_file_handler)
        
        # Suppress noisy third-party loggers
        logging.getLogger('telethon').setLevel(logging.WARNING)
        logging.getLogger('asyncio').setLevel(logging.WARNING)
        logging.getLogger('urllib3').setLevel(logging.WARNING)
        logging.getLogger('requests').setLevel(logging.WARNING)
        
        # Log startup message (only to file, not console)
        main_logger.info("Sticker Bot logging system initialized")
    
    def get_logger(self, name):
        """Get a logger instance for a specific component."""
        return logging.getLogger(f'sticker_bot.{name}')
    
    def log_sticker_creation_start(self, pack_name, file_count, process_id):
        """Log the start of a sticker creation process."""
        logger = self.get_logger('creation')
        logger.info(f"START - Pack: {pack_name}, Files: {file_count}, Process: {process_id}")
    
    def log_sticker_creation_progress(self, process_id, completed, total, current_file):
        """Log progress of sticker creation."""
        logger = self.get_logger('creation')
        progress_percent = (completed / total) * 100 if total > 0 else 0
        logger.info(f"PROGRESS - Process: {process_id}, {completed}/{total} ({progress_percent:.1f}%) - {current_file}")
    
    def log_sticker_creation_complete(self, process_id, success_count, failed_count, pack_url=None):
        """Log completion of sticker creation."""
        logger = self.get_logger('creation')
        status = "SUCCESS" if failed_count == 0 else "PARTIAL"
        logger.info(f"COMPLETE - Process: {process_id}, Status: {status}, Success: {success_count}, Failed: {failed_count}")
        if pack_url:
            logger.info(f"PACK_URL - {pack_url}")
    
    def log_sticker_creation_error(self, process_id, error_message, file_name=None):
        """Log errors during sticker creation."""
        logger = self.get_logger('creation')
        if file_name:
            logger.error(f"ERROR - Process: {process_id}, File: {file_name}, Error: {error_message}")
        else:
            logger.error(f"ERROR - Process: {process_id}, Error: {error_message}")

# Global logger instance
sticker_logger = StickerBotLogger()

def get_sticker_logger(name=None):
    """Get a logger instance for the sticker bot."""
    if name:
        return sticker_logger.get_logger(name)
    return logging.getLogger('sticker_bot')

def setup_sticker_logging():
    """Initialize the sticker bot logging system."""
    return sticker_logger
