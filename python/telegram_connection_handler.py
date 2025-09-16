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
    Session Reuse Handler - Uses existing sessions when available, creates new ones only when needed
    Prevents database locks by proper session management
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
        self._current_session_file = None
        self._session_phone = None
        logger.debug(f"[INIT] Session Reuse Handler initialized id={id(self)}")
        
        # Clean up only very old sessions (30+ days) and corrupted files
        self._cleanup_old_sessions_on_startup()
        
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
        """Check if we have a valid session that can be reused"""
        try:
            if not self._client:
                logger.debug("[SESSION] No client available")
                return False
            
            if not self._current_session_file or not os.path.exists(self._current_session_file):
                logger.debug("[SESSION] No session file or file doesn't exist")
                return False
            
            # Check if client is connected and authorized
            async def _check_session():
                try:
                    if not self._client.is_connected():
                        await self._client.connect()
                    
                    is_authorized = await self._client.is_user_authorized()
                    logger.debug(f"[SESSION] Authorization status: {is_authorized}")
                    return is_authorized
                except Exception as e:
                    logger.warning(f"[SESSION] Session validation error: {e}")
                    return False
            
            result = self.run_async(_check_session())
            logger.info(f"[SESSION] Session validation result: {result}")
            return result
            
        except Exception as e:
            logger.warning(f"[SESSION] Error checking session validity: {e}")
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
            return {"connected": False, "authorized": False, "session_file": None, "phone": None}
        
        try:
            return {
                "connected": self._client.is_connected(),
                "authorized": self.is_session_valid(),
                "session_file": self._current_session_file,
                "phone": self._session_phone
            }
        except Exception as e:
            logger.debug(f"[SESSION] Error getting session info: {e}")
            return {"connected": False, "authorized": False, "session_file": None, "phone": None}
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_number: str) -> Dict[str, Any]:
        """Connect to Telegram - Reuse existing session if valid, create new if needed"""
        logger.info(f"[CONNECT] Session reuse connection requested for phone: ***{str(phone_number)[-4:]}")
        
        with self._lock:
            # STEP 1: Check if we have a valid existing session for this phone
            if self._session_phone == phone_number and self.is_session_valid():
                logger.info("[CONNECT] Valid existing session found, reusing...")
                return {
                    "success": True, 
                    "needs_code": False, 
                    "needs_password": False, 
                    "phone_number": phone_number,
                    "session_file": self._current_session_file,
                    "reused_session": True
                }
            
            # STEP 2: Clean up old session if phone number changed or session invalid
            if self._client and (self._session_phone != phone_number or not self.is_session_valid()):
                logger.info("[CONNECT] Cleaning up old/invalid session...")
                try:
                    async def _cleanup_old():
                        try:
                            if self._client.is_connected():
                                await self._client.disconnect()
                        except Exception as e:
                            logger.debug(f"[CONNECT] Error during old session cleanup: {e}")
                    
                    self.run_async(_cleanup_old())
                except Exception as e:
                    logger.debug(f"[CONNECT] Error during cleanup: {e}")
                finally:
                    self._client = None
                    self._current_session_file = None
                    self._session_phone = None
            
            # STEP 3: Create new session with persistent filename
            async def _connect():
                try:
                    from telethon import TelegramClient
                    
                    # Use phone-based session file for persistence
                    base_dir = os.path.dirname(__file__)
                    # Clean phone number for filename
                    clean_phone = phone_number.replace("+", "").replace(" ", "").replace("-", "")
                    session_file = os.path.join(base_dir, f"telegram_session_{clean_phone}")
                    
                    logger.info(f"[CONNECT] Creating/using session: {session_file}")
                    self._client = TelegramClient(session_file, int(api_id), api_hash)
                    self._current_session_file = session_file
                    self._session_phone = phone_number
                    
                    await self._client.connect()
                    
                    # Check if already authorized
                    if await self._client.is_user_authorized():
                        logger.info("[CONNECT] Session already authorized!")
                        return {
                            "success": True, 
                            "needs_code": False, 
                            "needs_password": False, 
                            "phone_number": phone_number,
                            "session_file": session_file,
                            "existing_session": True
                        }
                    else:
                        # Need to authorize
                        logger.info("[CONNECT] Session needs authorization - sending code request")
                        try:
                            await self._client.send_code_request(phone_number)
                            return {
                                "success": True, 
                                "needs_code": True, 
                                "needs_password": False, 
                                "phone_number": phone_number,
                                "session_file": session_file
                            }
                        except Exception as code_error:
                            # Handle FloodWaitError specifically
                            if "FloodWaitError" in str(type(code_error)) or "wait" in str(code_error).lower():
                                # Extract wait time from error message
                                import re
                                wait_match = re.search(r'(\d+)', str(code_error))
                                wait_seconds = int(wait_match.group(1)) if wait_match else 0
                                
                                # Convert to human readable time
                                def convert_to_human_readable(seconds):
                                    hours = seconds // 3600
                                    minutes = (seconds % 3600) // 60
                                    secs = seconds % 60
                                    
                                    time_str = ""
                                    if hours > 0:
                                        time_str += f"{hours} hour{'s' if hours != 1 else ''} "
                                    if minutes > 0:
                                        time_str += f"{minutes} minute{'s' if minutes != 1 else ''} "
                                    if secs > 0 or not time_str:
                                        time_str += f"{secs} second{'s' if secs != 1 else ''}"
                                    return time_str
                                
                                time_str = convert_to_human_readable(wait_seconds)
                                
                                logger.warning(f"[CONNECT] Telegram rate limit: wait {time_str}")
                                return {
                                    "success": False, 
                                    "error": f"Telegram rate limit: Please wait {time_str.strip()} before requesting another code. This is Telegram's anti-spam protection.",
                                    "rate_limited": True,
                                    "wait_seconds": wait_seconds,
                                    "wait_time_human": time_str.strip(),
                                    "phone_number": phone_number
                                }
                            else:
                                raise code_error
                        
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
                logger.info(f"[CONNECT] Session reuse connection result: {result}")
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
        """Disconnect current session but preserve it for reuse"""
        logger.info("[DISCONNECT] Disconnecting current session (preserving for reuse)...")
        
        with self._lock:
            try:
                # STEP 1: Disconnect client but don't log out (preserve session)
                if self._client:
                    logger.info("[DISCONNECT] Disconnecting client (keeping session)...")
                    try:
                        async def _gentle_disconnect():
                            try:
                                if self._client.is_connected():
                                    # Just disconnect, don't log out to preserve session
                                    await self._client.disconnect()
                                    logger.info("[DISCONNECT] Client disconnected (session preserved)")
                            except Exception as e:
                                logger.warning(f"[DISCONNECT] Error during disconnect: {e}")
                        
                        self.run_async(_gentle_disconnect())
                    except Exception as e:
                        logger.warning(f"[DISCONNECT] Client disconnect error: {e}")
                    # Don't clear client reference - keep it for potential reuse
                
                logger.info("[DISCONNECT] Gentle disconnect completed")
                
            except Exception as e:
                logger.error(f"[DISCONNECT] Error during gentle disconnect: {e}")
                logger.error(traceback.format_exc())
    
    def cleanup(self):
        """Legacy cleanup method - delegates to force cleanup"""
        self.force_disconnect_and_cleanup()
    
    def cleanup_invalid_session(self):
        """Remove current session if it's invalid and prepare for new connection"""
        logger.info("[CLEANUP_SESSION] Cleaning up invalid session...")
        
        with self._lock:
            try:
                # Disconnect current client
                if self._client:
                    try:
                        async def _disconnect():
                            if self._client.is_connected():
                                await self._client.disconnect()
                        self.run_async(_disconnect())
                    except Exception as e:
                        logger.warning(f"[CLEANUP_SESSION] Error disconnecting: {e}")
                
                # Remove current session file if it exists and is invalid
                if self._current_session_file and os.path.exists(self._current_session_file):
                    try:
                        os.remove(self._current_session_file)
                        logger.info(f"[CLEANUP_SESSION] Removed invalid session: {self._current_session_file}")
                    except Exception as e:
                        logger.warning(f"[CLEANUP_SESSION] Could not remove session file: {e}")
                
                # Reset state
                self._client = None
                self._current_session_file = None
                self._session_phone = None
                
                logger.info("[CLEANUP_SESSION] Invalid session cleanup completed")
                return 1
                
            except Exception as e:
                logger.error(f"[CLEANUP_SESSION] Error during session cleanup: {e}")
                return 0
    
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
            "phone": None,
            "session_reused": False
        }
        
        if self._client:
            try:
                status["session_file"] = self._current_session_file
                status["phone"] = self._session_phone
                status["connected"] = self.has_active_connection()
                status["authorized"] = status["connected"]
                status["ready_for_stickers"] = status["authorized"]
                status["session_reused"] = bool(self._current_session_file and os.path.exists(self._current_session_file))
            except Exception as e:
                logger.debug(f"[STATUS] Error getting connection status: {e}")
        
        return status
    
    def cleanup_expired_sessions(self):
        """Clean up only expired or corrupted session files, keep valid ones"""
        try:
            import glob
            import time
            
            base_dir = os.path.dirname(__file__)
            session_pattern = os.path.join(base_dir, "telegram_session_*.session*")
            
            current_time = time.time()
            cleaned_count = 0
            
            for session_file in glob.glob(session_pattern):
                try:
                    # Skip if it's our current session
                    if session_file == self._current_session_file:
                        continue
                    
                    # Check if session is older than 7 days or corrupted
                    file_age = current_time - os.path.getctime(session_file)
                    if file_age > (7 * 24 * 3600):  # 7 days
                        os.remove(session_file)
                        logger.info(f"[CLEANUP] Removed old session: {session_file}")
                        cleaned_count += 1
                except Exception as e:
                    logger.warning(f"[CLEANUP] Could not process {session_file}: {e}")
            
            if cleaned_count > 0:
                logger.info(f"[CLEANUP] Cleaned {cleaned_count} expired session files")
            else:
                logger.debug("[CLEANUP] No expired sessions found to clean")
                
        except Exception as e:
            logger.warning(f"[CLEANUP] Error during expired session cleanup: {e}")
    
    def _cleanup_old_sessions_on_startup(self):
        """Gentle startup cleanup - only remove very old sessions and corrupted lock files"""
        try:
            import glob
            import time
            
            base_dir = os.path.dirname(__file__)
            current_time = time.time()
            cleaned_count = 0
            
            # Clean up very old sessions (30+ days) - these are likely abandoned
            old_session_pattern = os.path.join(base_dir, "telegram_session_*.session*")
            for session_file in glob.glob(old_session_pattern):
                try:
                    file_age = current_time - os.path.getctime(session_file)
                    if file_age > (30 * 24 * 3600):  # 30 days
                        os.remove(session_file)
                        logger.info(f"[STARTUP_CLEANUP] Removed very old session: {session_file}")
                        cleaned_count += 1
                except Exception as e:
                    logger.warning(f"[STARTUP_CLEANUP] Could not remove old session {session_file}: {e}")
            
            # Clean up orphaned lock files and temp files that can cause database locks
            lock_patterns = [
                os.path.join(base_dir, "*.session-journal"),
                os.path.join(base_dir, "*.session-wal"), 
                os.path.join(base_dir, "*.session-shm"),
                os.path.join(base_dir, "*.lock"),
                os.path.join(base_dir, "*temp*session*")
            ]
            
            for pattern in lock_patterns:
                for lock_file in glob.glob(pattern):
                    try:
                        # Only remove files older than 1 hour to avoid interfering with active processes
                        file_age = current_time - os.path.getctime(lock_file)
                        if file_age > 3600:  # 1 hour
                            os.remove(lock_file)
                            logger.info(f"[STARTUP_CLEANUP] Removed orphaned lock file: {lock_file}")
                            cleaned_count += 1
                    except Exception as e:
                        logger.warning(f"[STARTUP_CLEANUP] Could not remove lock file {lock_file}: {e}")
            
            if cleaned_count > 0:
                logger.info(f"[STARTUP_CLEANUP] Gentle cleanup: removed {cleaned_count} old/orphaned files")
            else:
                logger.debug("[STARTUP_CLEANUP] No old files found to clean")
                
        except Exception as e:
            logger.warning(f"[STARTUP_CLEANUP] Error during gentle startup cleanup: {e}")
    


# Global instance
telegram_handler = TelegramConnectionHandler()

def get_telegram_handler():
    """Get the global Telegram handler instance"""
    return telegram_handler