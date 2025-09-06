"""
Thread-safe Telegram connection handler that works with Flask
Solves the 'no current event loop in thread' issue
"""

import asyncio
import threading
import logging
import time
import queue
import re
from typing import Optional, Dict, Any
from concurrent.futures import ThreadPoolExecutor

# Configure logging
logger = logging.getLogger(__name__)

class TelegramConnectionHandler:
    """
    Thread-safe wrapper for Telegram operations.
    Uses a dedicated thread with its own event loop.
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
        def run_loop():
            # Create and set the event loop for this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            self._running = True
            
            try:
                # Keep the loop running
                loop.run_forever()
            finally:
                loop.close()
                self._running = False
        
        self._thread = threading.Thread(target=run_loop, name="TelegramEventLoop", daemon=True)
        self._thread.start()
        
        # Wait for loop to be ready
        while self._loop is None or not self._running:
            time.sleep(0.01)
        
        logger.info("Telegram event loop started successfully")
    
    def run_async(self, coro):
        """
        Run an async coroutine from any thread safely.
        Returns the result or raises an exception.
        """
        if not self._loop or not self._running:
            raise RuntimeError("Event loop is not running")
        
        # Schedule the coroutine in the event loop thread
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        
        try:
            # Wait for result with timeout
            result = future.result(timeout=30)
            return result
        except Exception as e:
            logger.error(f"Error running async operation: {e}")
            logger.error(f"Error type: {type(e)}")
            logger.error(f"Error details: {str(e)}")
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
        Connect to Telegram (thread-safe wrapper)
        """
        from telethon import TelegramClient
        
        # DEBUGGING: Log function entry
        logger.critical(f"🔧 HANDLER CALLED WITH PARAMS: api_id={api_id}, api_hash={api_hash}, phone_param={phone_param}")

        # Initialize phone_number at the very beginning to prevent scoping issues
        safe_phone_number = phone_param or ''
        
        try:
            logger.critical(f"[CRITICAL] Input parameters:")
            logger.critical(f"[CRITICAL] api_id: {api_id} (type: {type(api_id)})")
            logger.critical(f"[CRITICAL] api_hash: {api_hash[:5]}... (type: {type(api_hash)})")
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
                    'phone_number': safe_phone_number  # Use safe_phone_number here
                }

            # Use normalized phone number from validation
            safe_phone_number = validation_result['normalized_phone']
            logger.critical(f"[CRITICAL] Using normalized phone: {safe_phone_number}")
            
            # Define the async function with explicit context passing
            async def _connect():
                try:
                    logger.critical(f"[CRITICAL] _connect() started")
                    logger.critical(f"[CRITICAL] Using phone_number: {safe_phone_number}")
                    
                    # Validate phone number again inside async function
                    if not safe_phone_number:
                        logger.critical("[CRITICAL] phone_number is empty in _connect()")
                        return {
                            'success': False,
                            'error': "Phone number is required",
                            'needs_code': False,
                            'needs_password': False,
                            'phone_number': safe_phone_number
                        }
                    
                    # Create client with in-memory session
                    logger.critical(f"[CRITICAL] Creating TelegramClient with API ID: {api_id}")
                    client = TelegramClient(None, int(api_id), api_hash)
                    
                    # Connect
                    logger.critical("[CRITICAL] Connecting to Telegram...")
                    await client.connect()
                    logger.critical("[CRITICAL] Connected successfully")
                    
                    # Check if authorized
                    logger.critical("[CRITICAL] Checking authorization...")
                    is_authorized = await client.is_user_authorized()
                    logger.critical(f"[CRITICAL] Authorization status: {is_authorized}")
                    
                    if not is_authorized:
                        # Send code request
                        logger.critical(f"[CRITICAL] Sending code request to phone: {safe_phone_number}")
                        await client.send_code_request(safe_phone_number)
                        logger.critical("[CRITICAL] Code request sent successfully")
                        self._client = client
                        return {
                            'success': True,
                            'needs_code': True,
                            'needs_password': False,
                            'phone_number': safe_phone_number
                        }
                    
                    # Already authorized
                    logger.critical("[CRITICAL] User already authorized, setting up bot interaction")
                    self._client = client
                    return {
                        'success': True,
                        'needs_code': False,
                        'needs_password': False,
                        'phone_number': safe_phone_number
                    }
                    
                except Exception as e:
                    # Comprehensive error logging
                    logger.critical(f"[CRITICAL] Connection error in _connect(): {e}")
                    logger.critical(f"[CRITICAL] Error type: {type(e)}")
                    logger.critical(f"[CRITICAL] Phone number: {safe_phone_number}")
                    logger.critical(f"[CRITICAL] Full traceback:\n{traceback.format_exc()}")
                    
                    return {
                        'success': False,
                        'error': str(e),
                        'needs_code': False,
                        'needs_password': False,
                        'phone_number': safe_phone_number
                    }
            
            # Run in the event loop thread
            logger.critical("[CRITICAL] Running _connect() in event loop thread")
            return self.run_async(_connect())
            
        except Exception as e:
            logger.critical(f"[CRITICAL] Connection error: {e}")
            return {
                'success': False,
                'error': str(e),
                'needs_code': False,
                'needs_password': False,
                'phone_number': safe_phone_number  # This is now always defined
            }
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_number: str) -> Dict:
        """Wrapper to call the fixed version"""
        logger.critical("🔧 WRAPPER CALLED - calling fixed version")
        return self.connect_telegram_FIXED(api_id, api_hash, phone_number)
    
    def verify_code(self, code: str) -> Dict:
        """
        Verify the Telegram code (thread-safe)
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
        Verify 2FA password (thread-safe)
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
        """Clean up resources"""
        if self._client:
            try:
                async def _disconnect():
                    await self._client.disconnect()
                
                self.run_async(_disconnect())
            except:
                pass
        
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
        telegram_handler = TelegramConnectionHandler()
    return telegram_handler