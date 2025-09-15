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
    Clean Disconnection Workflow Handler - Always starts fresh, properly disconnects
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
        self._startup_cleanup_done = False
        logger.debug(f"[INIT] Handler initialized id={id(self)}")
        
        # CRITICAL: Force clean start - remove ALL session files on initialization
        self._force_clean_startup()
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
    
    def ensure_event_loop(self):
        """Public method to ensure event loop is ready"""
        self._ensure_loop_thread()
    
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
        """Check if we have a valid session - ALWAYS FALSE for clean workflow"""
        # For clean disconnection workflow, we never want to reuse sessions
        # Always return False to force fresh connections
        logger.info("[SESSION] Clean workflow: session is always invalid (fresh start required)")
        return False
    
    def has_active_connection(self):
        """Check if there's actually an active connection right now"""
        if not self._client:
            return False
        
        try:
            # Run async check in the event loop
            async def _check_connection():
                try:
                    # Check if client is connected and authorized
                    if not self._client.is_connected():
                        return False
                    
                    # Check if user is authorized
                    is_authorized = await self._client.is_user_authorized()
                    logger.debug(f"[CONNECTION] Current authorization status: {is_authorized}")
                    return is_authorized
                    
                except Exception as e:
                    logger.debug(f"[CONNECTION] Connection check failed: {e}")
                    return False
            
            return self.run_async(_check_connection())
        except Exception as e:
            logger.debug(f"[CONNECTION] Connection validation failed: {e}")
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
        """Connect to Telegram - ALWAYS FRESH SESSION as per requirements"""
        logger.info(f"[CONNECT] FRESH CONNECTION requested for phone: ***{str(phone_number)[-4:]}")
        
        with self._lock:
            # STEP 1: Force disconnect and logout any existing client
            if self._client:
                try:
                    async def _force_disconnect():
                        try:
                            if self._client.is_connected():
                                logger.info("[CONNECT] Logging out existing client...")
                                await self._client.log_out()
                                await self._client.disconnect()
                                logger.info("[CONNECT] Existing client disconnected and logged out")
                        except Exception as e:
                            logger.debug(f"[CONNECT] Error during forced disconnect: {e}")
                    
                    self.run_async(_force_disconnect())
                except Exception as e:
                    logger.debug(f"[CONNECT] Error during cleanup: {e}")
                finally:
                    self._client = None
            
            # STEP 2: FORCE CLEAN ALL SESSION FILES - start completely fresh
            logger.info("[CONNECT] Removing ALL existing session files for fresh start...")
            self._cleanup_all_session_files()
            
            # STEP 3: Create completely new session
            async def _connect():
                try:
                    from telethon import TelegramClient
                    
                    # Use timestamp-based session file to avoid any conflicts
                    base_dir = os.path.dirname(__file__)
                    import time
                    session_file = os.path.join(base_dir, f"telegram_session_fresh_{int(time.time())}")
                    
                    logger.info(f"[CONNECT] Creating FRESH session: {session_file}")
                    self._client = TelegramClient(session_file, int(api_id), api_hash)
                    
                    await self._client.connect()
                    
                    # Since we start fresh, we always need to authorize
                    logger.info("[CONNECT] Fresh session - sending code request")
                    await self._client.send_code_request(phone_number)
                    return {
                        "success": True, 
                        "needs_code": True, 
                        "needs_password": False, 
                        "phone_number": phone_number,
                        "session_file": session_file
                    }
                        
                except Exception as e:
                    logger.error(f"[CONNECT] Connection error: {e}")
                    return {
                        "success": False, 
                        "error": str(e), 
                        "needs_code": False, 
                        "needs_password": False, 
                        "phone_number": phone_number
                    }
            
            try:
                result = self.run_async(_connect())
                logger.info(f"[CONNECT] Fresh connection result: {result}")
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
        """Verify login code - SIMPLIFIED"""
        async def _verify():
            try:
                from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError
                
                if not self._client:
                    return {"success": False, "error": "Client not initialized. Call connect first."}
                
                await self._client.sign_in(code=code.strip())
                logger.debug("[VERIFY_CODE] Code verification successful")
                return {"success": True, "needs_password": False}
                
            except SessionPasswordNeededError:
                logger.debug("[VERIFY_CODE] 2FA password required")
                return {"success": True, "needs_password": True}
            except PhoneCodeInvalidError:
                logger.debug("[VERIFY_CODE] Invalid verification code")
                return {"success": False, "error": "Invalid verification code", "needs_password": False}
            except Exception as e:
                logger.error(f"[VERIFY_CODE] Error: {e}")
                return {"success": False, "error": f"Code verification failed: {str(e)}", "needs_password": False}
        
        return self.run_async(_verify())

    def verify_password(self, password: str) -> Dict[str, Any]:
        """Verify 2FA password - SIMPLIFIED"""
        async def _verify():
            try:
                if not self._client:
                    return {"success": False, "error": "Client not initialized. Call connect first."}
                
                await self._client.sign_in(password=password)
                logger.debug("[VERIFY_PASSWORD] Password verification successful")
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
    
    def force_disconnect_and_cleanup(self):
        """FORCE complete disconnection and cleanup - implements clean workflow"""
        logger.info("[FORCE_CLEANUP] Starting COMPLETE disconnection and cleanup...")
        
        with self._lock:
            try:
                # STEP 1: Force logout and disconnect client
                if self._client:
                    logger.info("[FORCE_CLEANUP] Logging out and disconnecting client...")
                    try:
                        async def _force_logout():
                            try:
                                if self._client.is_connected():
                                    # Log out to invalidate the session on Telegram's side
                                    await self._client.log_out()
                                    logger.info("[FORCE_CLEANUP] Logged out from Telegram")
                                    
                                    # Disconnect to close the connection
                                    await self._client.disconnect()
                                    logger.info("[FORCE_CLEANUP] Disconnected from Telegram")
                            except Exception as e:
                                logger.warning(f"[FORCE_CLEANUP] Error during logout/disconnect: {e}")
                                # Try force disconnect even if logout fails
                                try:
                                    await self._client.disconnect()
                                except Exception as e2:
                                    logger.warning(f"[FORCE_CLEANUP] Error during force disconnect: {e2}")
                        
                        self.run_async(_force_logout())
                    except Exception as e:
                        logger.warning(f"[FORCE_CLEANUP] Client cleanup error: {e}")
                    finally:
                        self._client = None
                        logger.info("[FORCE_CLEANUP] Client reference cleared")
                
                # STEP 2: Stop the event loop
                if self._loop and not self._loop.is_closed():
                    logger.info("[FORCE_CLEANUP] Stopping event loop")
                    try:
                        self._loop.call_soon_threadsafe(self._loop.stop)
                    except Exception as e:
                        logger.warning(f"[FORCE_CLEANUP] Error stopping loop: {e}")
                
                # STEP 3: Wait for thread to finish
                if self._loop_thread and self._loop_thread.is_alive():
                    logger.info("[FORCE_CLEANUP] Waiting for loop thread to finish")
                    self._loop_thread.join(timeout=5)  # Increased timeout
                
                # STEP 4: Shutdown executor
                if self._executor:
                    logger.info("[FORCE_CLEANUP] Shutting down executor")
                    self._executor.shutdown(wait=False)
                
                # STEP 5: Reset all state
                self._running = False
                self._loop = None
                self._loop_thread = None
                
                # STEP 6: FORCE cleanup of ALL session files
                logger.info("[FORCE_CLEANUP] Removing ALL session files...")
                self._cleanup_all_session_files()
                
                # STEP 7: Force garbage collection
                try:
                    import gc
                    gc.collect()
                    logger.info("[FORCE_CLEANUP] Forced garbage collection")
                except Exception as gc_e:
                    logger.warning(f"[FORCE_CLEANUP] Error during garbage collection: {gc_e}")
                
                logger.info("[FORCE_CLEANUP] COMPLETE cleanup finished successfully")
                
            except Exception as e:
                logger.error(f"[FORCE_CLEANUP] CRITICAL cleanup error: {e}")
                logger.error(traceback.format_exc())
                # Even on error, try to clean session files
                try:
                    self._cleanup_all_session_files()
                    logger.info("[FORCE_CLEANUP] Session files cleaned despite error")
                except Exception as cleanup_e:
                    logger.error(f"[FORCE_CLEANUP] Failed to clean session files: {cleanup_e}")
    
    def cleanup(self):
        """Legacy cleanup method - delegates to force cleanup"""
        self.force_disconnect_and_cleanup()
    
    def cleanup_invalid_session(self):
        """Remove all session files and force disconnect"""
        logger.info("[CLEANUP_SESSION] Starting complete session cleanup and disconnect...")
        
        # Force complete disconnection and cleanup
        self.force_disconnect_and_cleanup()
        
        logger.info("[CLEANUP_SESSION] Complete session cleanup finished")
        return 1
    
    def is_connected_and_ready(self):
        """Check if client is connected, authorized, and ready for sticker operations"""
        return self.has_active_connection()
    
    def get_connection_status(self):
        """Get detailed connection status for UI"""
        status = {
            "connected": False,
            "authorized": False,
            "ready_for_stickers": False,
            "session_file": None,
            "clean_state": True  # Always clean in this workflow
        }
        
        if self._client:
            try:
                status["session_file"] = getattr(self._client.session, 'filename', None)
                status["connected"] = self.has_active_connection()
                status["authorized"] = status["connected"]
                status["ready_for_stickers"] = status["authorized"]
            except Exception as e:
                logger.debug(f"[STATUS] Error getting connection status: {e}")
        
        return status
    
    def _force_clean_startup(self):
        """FORCE clean startup - remove ALL sessions before initializing"""
        if self._startup_cleanup_done:
            return
            
        logger.info("[STARTUP_CLEANUP] Removing ALL existing session files for clean start...")
        try:
            import glob
            import time
            
            base_dir = os.path.dirname(__file__)
            
            # Remove ALL session-related files with aggressive patterns
            patterns = [
                os.path.join(base_dir, "telegram_session*"),
                os.path.join(base_dir, "*.session*"),
                os.path.join(base_dir, "*.session-journal"),
                os.path.join(base_dir, "*.session-wal"),
                os.path.join(base_dir, "*.session-shm"),
                # Also check parent directory
                os.path.join(os.path.dirname(base_dir), "telegram_session*"),
                os.path.join(os.path.dirname(base_dir), "*.session*")
            ]
            
            cleaned_count = 0
            for pattern in patterns:
                for file_path in glob.glob(pattern):
                    try:
                        # Extra check to avoid removing important files
                        if 'session' in os.path.basename(file_path).lower():
                            os.remove(file_path)
                            logger.info(f"[STARTUP_CLEANUP] Removed: {file_path}")
                            cleaned_count += 1
                    except Exception as e:
                        logger.warning(f"[STARTUP_CLEANUP] Could not remove {file_path}: {e}")
            
            logger.info(f"[STARTUP_CLEANUP] Cleaned {cleaned_count} session files at startup")
            
            # Small delay to ensure file system has processed the deletions
            time.sleep(0.1)
            
            self._startup_cleanup_done = True
            
        except Exception as e:
            logger.error(f"[STARTUP_CLEANUP] Error during startup cleanup: {e}")
    
    def _cleanup_all_session_files(self):
        """Clean ALL session files - comprehensive cleanup"""
        try:
            import glob
            import time
            
            base_dir = os.path.dirname(__file__)
            
            # Remove ALL session-related files with comprehensive patterns
            patterns = [
                os.path.join(base_dir, "telegram_session*"),
                os.path.join(base_dir, "*.session*"),
                os.path.join(base_dir, "*.session-journal"),
                os.path.join(base_dir, "*.session-wal"), 
                os.path.join(base_dir, "*.session-shm"),
                # Also check parent directory
                os.path.join(os.path.dirname(base_dir), "telegram_session*"),
                os.path.join(os.path.dirname(base_dir), "*.session*"),
                # Check for any missed session files
                os.path.join(base_dir, "*fresh*"),
                os.path.join(base_dir, "*temp*session*")
            ]
            
            cleaned_count = 0
            for pattern in patterns:
                for file_path in glob.glob(pattern):
                    try:
                        # Safety check to avoid removing non-session files
                        filename = os.path.basename(file_path).lower()
                        if any(keyword in filename for keyword in ['session', 'fresh', 'temp']):
                            os.remove(file_path)
                            logger.info(f"[CLEANUP] Removed: {file_path}")
                            cleaned_count += 1
                    except Exception as e:
                        logger.warning(f"[CLEANUP] Could not remove {file_path}: {e}")
            
            if cleaned_count > 0:
                logger.info(f"[CLEANUP] Cleaned {cleaned_count} session files")
            else:
                logger.debug("[CLEANUP] No session files found to clean")
                
            # Force garbage collection and small delay
            import gc
            gc.collect()
            time.sleep(0.1)
            
        except Exception as e:
            logger.warning(f"[CLEANUP] Error during session file cleanup: {e}")

# Global instance
telegram_handler = TelegramConnectionHandler()

def get_telegram_handler():
    """Get the global Telegram handler instance"""
    return telegram_handler