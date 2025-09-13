"""
FIXED: Thread-safe Telegram Connection Handler with Proper Event Loop Management
Replace your telegram_connection_handler.py with this version
"""
import os
import asyncio
import threading
import logging
import time
import traceback
from typing import Dict, Any
import concurrent.futures

# Configure logging
logger = logging.getLogger(__name__)
if not logger.handlers:
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    logs_dir = os.path.join(project_root, 'logs')
    try:
        os.makedirs(logs_dir, exist_ok=True)
        log_path = os.path.join(logs_dir, 'telegram_connection_debug.log')
        fh = logging.FileHandler(log_path, encoding='utf-8')
        fmt = logging.Formatter('%(asctime)s - %(levelname)s - %(threadName)s - %(name)s - %(message)s')
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except Exception:
        pass
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    ch.setLevel(logging.INFO)  # Only show INFO and above in console, DEBUG goes to file only
    logger.addHandler(ch)
logger.setLevel(logging.DEBUG)

from shared_state import set_current_session_file

# Expose current session file path for other modules expecting it
current_session_file = None

class TelegramConnectionHandler:
    """
    FIXED: Thread-safe Telegram connection handler that actually works with Flask
    """
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
            return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
            
        self._loop = None
        self._client = None
        self._running = False
        self._lock = threading.RLock()
        self._loop_thread = None
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="TelegramLoop")
        self._initialized = True
        logger.debug(f"[INIT] Handler initialized id={id(self)}")
        self._ensure_loop_thread()
        
    def _ensure_loop_thread(self):
        """Ensure we have a dedicated thread running an event loop"""
        with self._lock:
            if self._loop_thread is None or not self._loop_thread.is_alive():
                logger.debug("[LOOP] Starting new event loop thread")
                self._loop = None
                self._running = True
                self._loop_thread = threading.Thread(
                    target=self._run_event_loop, 
                    name="TelegramEventLoop", 
                    daemon=True
                )
                self._loop_thread.start()
                
                # Wait for loop to be ready
                max_wait = 5
                while self._loop is None and max_wait > 0:
                    time.sleep(0.1)
                    max_wait -= 0.1
                    
                if self._loop is None:
                    raise RuntimeError("Failed to start event loop")
                logger.debug("[LOOP] Event loop thread started successfully")
    
    def _run_event_loop(self):
        """Run the event loop in a dedicated thread"""
        try:
            logger.debug("[LOOP] Creating new event loop")
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            logger.debug("[LOOP] Event loop created, starting run_forever()")
            self._loop.run_forever()
        except Exception as e:
            logger.error(f"[LOOP] Event loop error: {e}")
            logger.error(traceback.format_exc())
        finally:
            logger.debug("[LOOP] Event loop stopped")
            if self._loop and not self._loop.is_closed():
                self._loop.close()
            self._running = False
    
    def run_async(self, coro):
        """FIXED: Safely run an async coroutine from any thread"""
        logger.debug(f"[RUN_ASYNC] Starting coroutine: {coro}")
        
        # Ensure loop thread is running
        self._ensure_loop_thread()
        
        if self._loop is None or self._loop.is_closed():
            raise RuntimeError("Event loop is not available")
        
        try:
            # Use asyncio.run_coroutine_threadsafe for cross-thread execution
            future = asyncio.run_coroutine_threadsafe(coro, self._loop)
            result = future.result(timeout=60)  # 60 second timeout
            logger.debug("[RUN_ASYNC] Coroutine completed successfully")
            return result
        except Exception as e:
            logger.error(f"[RUN_ASYNC] Error: {e}")
            logger.error(traceback.format_exc())
            raise
    
    def is_session_valid(self):
        """Check if we have a valid session without reconnecting"""
        if not self._client:
            return False
        
        try:
            # Check if client is connected and authorized
            if not self._client.is_connected():
                return False
            
            # Run async check in the event loop
            async def _check_auth():
                return await self._client.is_user_authorized()
            
            return self.run_async(_check_auth())
        except Exception as e:
            logger.debug(f"[SESSION] Session validation failed: {e}")
            return False
    
    def get_session_info(self):
        """Get information about the current session"""
        if not self._client:
            return {"connected": False, "authorized": False, "session_file": None}
        
        try:
            session_file = None
            if hasattr(self._client, 'session') and getattr(self._client.session, 'filename', None):
                session_file = self._client.session.filename
            
            return {
                "connected": self._client.is_connected(),
                "authorized": self.is_session_valid(),
                "session_file": session_file
            }
        except Exception as e:
            logger.debug(f"[SESSION] Error getting session info: {e}")
            return {"connected": False, "authorized": False, "session_file": None}
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_number: str) -> Dict[str, Any]:
        """FIXED: Connect to Telegram with proper error handling and session reuse"""
        logger.debug(f"[CONNECT] Starting connection for phone: ***{str(phone_number)[-4:]}")
        
        # Check if we already have a valid session
        if self.is_session_valid():
            logger.debug("[CONNECT] Valid session already exists, reusing...")
            return {"success": True, "message": "Using existing valid session"}
        
        # Check if we have a client but it's not connected
        if self._client and not self._client.is_connected():
            logger.debug("[CONNECT] Existing client found but not connected, reconnecting...")
            try:
                # Try to reconnect existing client
                async def _reconnect():
                    await self._client.connect()
                    return await self._client.is_user_authorized()
                
                is_authorized = self.run_async(_reconnect())
                if is_authorized:
                    logger.debug("[CONNECT] Successfully reconnected existing session")
                    return {"success": True, "message": "Reconnected to existing session"}
            except Exception as e:
                logger.warning(f"[CONNECT] Failed to reconnect existing client: {e}")
                self._client = None
        
        async def _connect():
            try:
                # Import here to avoid import issues
                from telethon import TelegramClient
                from telethon.errors import SessionPasswordNeededError
                
                logger.debug("[CONNECT] Creating TelegramClient")
                # Use a stable, reusable session path so user isn't prompted every time
                base_dir = os.path.dirname(__file__)
                stable_session_base = os.path.join(base_dir, "telegram_session")
                
                # Check if session file exists and is valid
                session_file = f"{stable_session_base}.session"
                if os.path.exists(session_file) and os.path.getsize(session_file) > 0:
                    logger.debug(f"[CONNECT] Found existing session file: {session_file}")
                    # Try to use existing session first
                    self._client = TelegramClient(stable_session_base, int(api_id), api_hash)
                else:
                    logger.debug("[CONNECT] No existing session found, creating new one")
                    self._client = TelegramClient(stable_session_base, int(api_id), api_hash)
                
                logger.debug("[CONNECT] Connecting to Telegram...")
                await self._client.connect()
                
                # Record session file path for visibility
                try:
                    if hasattr(self._client, 'session') and getattr(self._client.session, 'filename', None):
                        current_session_file = self._client.session.filename
                        set_current_session_file(current_session_file)
                        logger.debug(f"[CONNECT] Using session file: {current_session_file}")
                except Exception:
                    pass
                
                logger.debug("[CONNECT] Checking authorization status")
                if not await self._client.is_user_authorized():
                    logger.debug("[CONNECT] Not authorized, sending code request")
                    await self._client.send_code_request(phone_number)
                    return {
                        "success": True, 
                        "needs_code": True, 
                        "needs_password": False, 
                        "phone_number": phone_number
                    }
                else:
                    logger.debug("[CONNECT] Already authorized")
                    # Ensure session file path is recorded even in already-authorized path
                    try:
                        if hasattr(self._client, 'session') and getattr(self._client.session, 'filename', None):
                            current_session_file = self._client.session.filename
                            set_current_session_file(current_session_file)
                            logger.debug(f"[CONNECT] Reusing session file: {current_session_file}")
                    except Exception:
                        pass
                    return {
                        "success": True, 
                        "needs_code": False, 
                        "needs_password": False, 
                        "phone_number": phone_number
                    }
                    
            except Exception as e:
                logger.error(f"[CONNECT] Connection error: {e}")
                logger.error(traceback.format_exc())
                return {
                    "success": False, 
                    "error": str(e), 
                    "needs_code": False, 
                    "needs_password": False, 
                    "phone_number": phone_number
                }
        
        try:
            result = self.run_async(_connect())
            logger.debug(f"[CONNECT] Result: {result}")
            return result
        except Exception as e:
            logger.error(f"[CONNECT] Failed: {e}")
            return {
                "success": False, 
                "error": f"Connection failed: {str(e)}", 
                "needs_code": False, 
                "needs_password": False, 
                "phone_number": phone_number
            }

    def verify_code(self, code: str) -> Dict[str, Any]:
        """FIXED: Verify login code"""
        async def _verify():
            try:
                from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError
                
                if not self._client:
                    return {"success": False, "error": "Client not initialized. Call connect first."}
                
                await self._client.sign_in(code=code.strip())
                # Persist session path after successful sign in
                try:
                    if hasattr(self._client, 'session') and getattr(self._client.session, 'filename', None):
                        current_session_file = self._client.session.filename
                        set_current_session_file(current_session_file)
                        logger.debug(f"[VERIFY_CODE] Session stored at: {current_session_file}")
                except Exception:
                    pass
                return {"success": True, "needs_password": False}
                
            except SessionPasswordNeededError:
                return {"success": True, "needs_password": True}
            except PhoneCodeInvalidError:
                return {"success": False, "error": "Invalid verification code", "needs_password": False}
            except Exception as e:
                logger.error(f"[VERIFY_CODE] Error: {e}")
                return {"success": False, "error": f"Code verification failed: {str(e)}", "needs_password": False}
        
        return self.run_async(_verify())

    def verify_password(self, password: str) -> Dict[str, Any]:
        """FIXED: Verify 2FA password"""
        async def _verify():
            try:
                if not self._client:
                    return {"success": False, "error": "Client not initialized. Call connect first."}
                
                await self._client.sign_in(password=password)
                return {"success": True}
                
            except Exception as e:
                logger.error(f"[VERIFY_PASSWORD] Error: {e}")
                return {"success": False, "error": f"Password verification failed: {str(e)}"}
        
        return self.run_async(_verify())

    def is_connected(self) -> bool:
        """Check if client is connected and authorized"""
        async def _check():
            try:
                if not self._client:
                    return False
                if not self._client.is_connected():
                    await self._client.connect()
                return await self._client.is_user_authorized()
            except Exception:
                return False
        
        try:
            return self.run_async(_check())
        except Exception:
            return False
    
    def health_status(self) -> Dict[str, Any]:
        """Return health status for debugging"""
        with self._lock:
            status = {
                "loop_exists": self._loop is not None,
                "loop_closed": (self._loop.is_closed() if self._loop else None),
                "running": self._running,
                "thread_alive": (self._loop_thread.is_alive() if self._loop_thread else None),
                "thread_name": (self._loop_thread.name if self._loop_thread else None),
                "client_exists": self._client is not None,
            }
        logger.debug(f"[HEALTH] {status}")
        return status
    
    def cleanup(self):
        """Clean up all resources"""
        logger.debug("[CLEANUP] Starting cleanup")
        with self._lock:
            try:
                # Disconnect client first
                if self._client:
                    logger.debug("[CLEANUP] Disconnecting client")
                    try:
                        self.run_async(self._client.disconnect())
                    except Exception as e:
                        logger.warning(f"[CLEANUP] Client disconnect error: {e}")
                    self._client = None
                
                # Stop the event loop
                if self._loop and not self._loop.is_closed():
                    logger.debug("[CLEANUP] Stopping event loop")
                    self._loop.call_soon_threadsafe(self._loop.stop)
                
                # Wait for thread to finish
                if self._loop_thread and self._loop_thread.is_alive():
                    logger.debug("[CLEANUP] Waiting for loop thread to finish")
                    self._loop_thread.join(timeout=3)
                
                # Shutdown executor
                if self._executor:
                    logger.debug("[CLEANUP] Shutting down executor")
                    self._executor.shutdown(wait=False)
                
                self._running = False
                self._loop = None
                self._loop_thread = None
                
                # Force cleanup of session files to prevent database locks
                try:
                    import gc
                    gc.collect()
                    logger.debug("[CLEANUP] Forced garbage collection")
                except Exception as e:
                    logger.warning(f"[CLEANUP] Error during garbage collection: {e}")
                
                logger.info("[CLEANUP] Cleanup completed successfully")
                
            except Exception as e:
                logger.error(f"[CLEANUP] Cleanup error: {e}")
                logger.error(traceback.format_exc())
                # Force cleanup even on error
                try:
                    import gc
                    gc.collect()
                    logger.debug("[CLEANUP] Forced garbage collection after error")
                except Exception as gc_e:
                    logger.warning(f"[CLEANUP] Error during garbage collection after error: {gc_e}")

# Global instance
telegram_handler = TelegramConnectionHandler()

def get_telegram_handler():
    """Get the global Telegram handler instance"""
    return telegram_handler