"""
Thread-safe Telegram connection handler that works with Flask
Solves the 'no current event loop in thread' issue
"""

import asyncio
import threading
import logging
import traceback
import time
import re
import os
import glob
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any
from flask import jsonify

# Configure logging
logger = logging.getLogger(__name__)

# Global session tracking
current_session_file = None

class TelegramConnectionHandler:
    """
    Thread-safe wrapper for Telegram operations with simplified event loop management.
    """
    
    def __init__(self):
        self._loop = None
        self._thread = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="TelegramWorker")
        self._client = None
        self._running = False
        self._lock = threading.Lock()
        
        # Start the event loop thread
        self._start_event_loop()
    
    def _start_event_loop(self):
        """Start a dedicated thread with event loop for Telegram operations"""
        try:
            # Create a new event loop in a separate thread
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(
                target=self._run_event_loop, 
                name="TelegramEventLoopThread", 
                daemon=True
            )
            self._thread.start()
            self._running = True
        except Exception as e:
            logger.error(f"Failed to start event loop: {e}")
            self._running = False
    
    def _run_event_loop(self):
        """Run the event loop in a separate thread"""
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_forever()
        except Exception as e:
            logger.error(f"Event loop error: {e}")
        finally:
            self._running = False
    
    def run_async(self, coro):
        """
        Run an async coroutine from any thread safely.
        Uses the dedicated event loop thread.
        """
        if not self._running or not self._loop:
            raise RuntimeError("Event loop is not running")
        
        try:
            future = asyncio.run_coroutine_threadsafe(coro, self._loop)
            return future.result(timeout=30)
        except Exception as e:
            logger.error(f"Error running async operation: {e}")
            raise
    
    def _validate_inputs(self, api_id: str, api_hash: str, phone_param: str) -> Dict[str, Any]:
        """
        Validate all input parameters with detailed checks
        """
        errors = {}
        normalized_phone = phone_param or ''  # Initialize with input value

        # API ID validation
        if not api_id:
            errors['api_id'] = "API ID is required"
        else:
            try:
                int(api_id)  # Ensure it's a valid integer
            except ValueError:
                errors['api_id'] = "API ID must be a numeric value"

        # API Hash validation
        if not api_hash:
            errors['api_hash'] = "API Hash is required"
        elif len(api_hash) < 32:  # Basic length check
            errors['api_hash'] = "Invalid API Hash format"

        # Phone number validation and normalization
        if not normalized_phone:
            errors['phone_number'] = "Phone number is required"
        else:
            normalized_phone = str(normalized_phone).strip()
            if not normalized_phone.startswith('+'):
                normalized_phone = f'+{normalized_phone}'
                
            phone_regex = r'^\+?1?\d{10,14}$'
            if not re.match(phone_regex, normalized_phone):
                errors['phone_number'] = "Invalid phone number format"

        return {
            'is_valid': len(errors) == 0,
            'errors': errors,
            'normalized_phone': normalized_phone  # Always returns a value
        }

    def connect_telegram_FIXED(self, api_id: str, api_hash: str, phone_param: str) -> Dict:
        """
        Connect to Telegram (thread-safe wrapper) — unified and loop-safe
        """
        from telethon import TelegramClient
        logger.critical(f"🔧 HANDLER CALLED WITH PARAMS: api_id={api_id}, api_hash={api_hash}, phone_param={phone_param}")

        # Initialize phone_number at the very beginning to prevent scoping issues
        safe_phone_number = phone_param or ''
        
        try:
            logger.critical(f"[CRITICAL] Input parameters:")
            logger.critical(f"[CRITICAL] api_id: {api_id} (type: {type(api_id)})")
            logger.critical(f"[CRITICAL] api_hash: {str(api_hash)[:5]}... (type: {type(api_hash)})")
            logger.critical(f"[CRITICAL] phone_number: {safe_phone_number} (type: {type(safe_phone_number)})")

            # Perform input validation
            validation_result = self._validate_inputs(api_id, api_hash, safe_phone_number)
        
            # Log validation results
            logger.critical("[CRITICAL] Input Validation Results:")
            logger.critical(f"[CRITICAL] Validation Status: {'PASSED' if validation_result['is_valid'] else 'FAILED'}")
            
            # If validation fails, return error response
            if not validation_result['is_valid']:
                logger.critical(f"[CRITICAL] Validation Errors: {validation_result['errors']}")
                return {
                    'success': False,
                    'error': "Invalid input parameters",
                    'validation_errors': validation_result['errors'],
                    'needs_code': False,
                    'needs_password': False,
                    'phone_number': safe_phone_number
                }

            # Use normalized phone number from validation
            safe_phone_number = validation_result['normalized_phone']
            logger.critical(f"[CRITICAL] Using normalized phone: {safe_phone_number}")

            # Unify everything on the handler's event loop with a single persistent session
            async def _connect_on_handler_loop():
                try:
                    import os
                    global current_session_file

                    # Stable persistent session in the python/ directory (no more UUID spam)
                    base_dir = os.path.dirname(__file__)
                    session_path = os.path.join(base_dir, 'session_main')
                    current_session_file = session_path  # tracked by backend session-status
                    logger.critical(f"[CRITICAL] Using persistent session: {session_path}")

                    # Create client ON THIS LOOP and keep it for future calls
                    self._client = TelegramClient(session_path, int(api_id), api_hash)
                    await self._client.connect()
                    logger.critical("[CRITICAL] Connected successfully on handler loop")

                    is_authorized = await self._client.is_user_authorized()
                    logger.critical(f"[CRITICAL] Authorization status: {is_authorized}")

                    if not is_authorized:
                        await self._client.send_code_request(safe_phone_number)
                        logger.critical("[CRITICAL] Code request sent successfully")
                        return {
                            'success': True,
                            'needs_code': True,
                            'needs_password': False,
                            'phone_number': safe_phone_number
                        }

                    # Already authorized — good to go
                    return {
                        'success': True,
                        'needs_code': False,
                        'needs_password': False,
                        'phone_number': safe_phone_number
                    }

                except Exception as e:
                    logger.critical(f"[CRITICAL] Connection error on handler loop: {e}")
                    return {
                        'success': False,
                        'error': str(e),
                        'needs_code': False,
                        'needs_password': False,
                        'phone_number': safe_phone_number
                    }

            # Run everything on our dedicated event loop (no extra threads)
            return self.run_async(_connect_on_handler_loop())

        except Exception as e:
            logger.critical(f"[CRITICAL] Connection error: {e}")
            return {
                'success': False,
                'error': str(e),
                'needs_code': False,
                'needs_password': False,
                'phone_number': safe_phone_number
            }
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_number: str) -> Dict:
        """Wrapper to call the fixed version"""
        logger.critical("🔧 WRAPPER CALLED - calling fixed version")
        return self.connect_telegram_FIXED(api_id, api_hash, phone_number)
    
    def verify_code(self, code: str) -> Dict:
        """
        Verify the Telegram code (thread-safe) - uses same event loop as connection
        """
        async def _verify():
            try:
                if not self._client:
                    return {'success': False, 'error': 'No active client'}
                
                await self._client.sign_in(code=code)
                
                return {
                    'success': True,
                    'needs_password': False
                }
                
            except Exception as e:
                # Check for SessionPasswordNeededError more robustly
                error_str = str(e)
                error_type = type(e).__name__
                
                # Log the error for debugging
                logger.info(f"Code verification error: {error_type}: {error_str}")
                logger.info(f"Error details - type: {type(e)}, module: {type(e).__module__}")
                
                if ('SessionPasswordNeededError' in error_str or 
                    'SessionPasswordNeededError' in error_type or
                    'password' in error_str.lower() and 'required' in error_str.lower()):
                    logger.info("Detected 2FA requirement - returning needs_password=True")
                    return {
                        'success': True,
                        'needs_password': True
                    }
                
                logger.info(f"Non-2FA error: {error_str}")
                return {
                    'success': False,
                    'error': str(e),
                    'needs_password': False
                }
        
        return self.run_async(_verify())
    
    def verify_password(self, password: str) -> Dict:
        """
        Verify 2FA password (thread-safe) - uses same event loop as connection
        """
        async def _verify_password():
            try:
                if not self._client:
                    return {'success': False, 'error': 'No active client'}
                
                await self._client.sign_in(password=password)
                
                return {
                    'success': True,
                    'needs_password': False
                }
                
            except Exception as e:
                return {
                    'success': False,
                    'error': str(e),
                    'needs_password': False
                }
        
        return self.run_async(_verify_password())
    
    def cleanup(self):
        """Clean up resources - properly disconnects client on same event loop"""
        if self._client:
            try:
                async def _disconnect():
                    await self._client.disconnect()
                
                self.run_async(_disconnect())
                self._client = None  # Clear reference after disconnect
            except Exception as e:
                logger.warning(f"Error during client cleanup: {e}")
        
        if self._loop and self._running:
            self._loop.call_soon_threadsafe(self._loop.stop)
        
        if self._thread:
            self._thread.join(timeout=5)
        
        self._executor.shutdown(wait=False)

# Global instance for the application
telegram_handler = None

def get_telegram_handler():
    """Get or create the global telegram handler"""
    global telegram_handler
    if telegram_handler is None:
        try:
            telegram_handler = TelegramConnectionHandler()
            logger.info("Telegram handler created successfully")
        except Exception as e:
            logger.error(f"Failed to create telegram handler: {e}")
            raise
    return telegram_handler