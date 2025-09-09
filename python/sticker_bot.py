import asyncio
import logging
import os
import sys
import time
import re
import threading
import json
import queue
from typing import Optional, Dict, List
from enum import Enum
from dataclasses import dataclass

# Note: avoid importing fcntl on Windows to prevent portability issues
try:
    import fcntl  # noqa: F401
except Exception:
    fcntl = None

try:
    from telethon import TelegramClient, events
    from telethon.errors import SessionPasswordNeededError, FloodWaitError
    from telethon.tl.types import Message
    TELETHON_AVAILABLE = True
except ImportError:
    TELETHON_AVAILABLE = False

try:
    from cryptography.fernet import Fernet
    ENCRYPTION_AVAILABLE = True
except ImportError:
    ENCRYPTION_AVAILABLE = False
    logging.warning("[SECURITY] Cryptography library not available. Credentials will be stored in plain text.")

class FileLock:
    """Cross-platform file locking mechanism"""
    def __init__(self, file_path, timeout=10, poll_interval=0.1):
        self.file_path = file_path
        self.lock_file = file_path + '.lock'
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._lock_handle = None

    def acquire(self):
        """Acquire an exclusive file lock"""
        start_time = time.time()
        while True:
            try:
                # Create lock file with exclusive write mode
                # On Windows, this will fail if the file exists
                fd = os.open(self.lock_file, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.close(fd)
                return True
            except FileExistsError:
                # Check if lock is stale (older than timeout)
                if os.path.exists(self.lock_file):
                    lock_age = time.time() - os.path.getctime(self.lock_file)
                    if lock_age > self.timeout:
                        try:
                            os.unlink(self.lock_file)
                            continue
                        except Exception:
                            pass

                # Wait before retrying
                time.sleep(self.poll_interval)

            # Check for overall timeout
            if time.time() - start_time > self.timeout:
                return False

    def release(self):
        """Release the file lock"""
        try:
            os.unlink(self.lock_file)
        except Exception:
            pass

    def __enter__(self):
        if not self.acquire():
            raise TimeoutError(f"Could not acquire lock for {self.file_path}")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()

class SecureCredentialManager:
    """Secure management of Telegram credentials with cross-platform file locking"""
    
    def __init__(self, credentials_path='telegram_credentials.json'):
        # Always resolve credentials path relative to this file to avoid CWD issues
        if not os.path.isabs(credentials_path):
            base_dir = os.path.dirname(__file__)
            credentials_path = os.path.join(base_dir, credentials_path)
        self.credentials_path = credentials_path
        self._encryption_key = None
        self._cipher_suite = None
        self._lock = threading.Lock()
        
        # Ensure credentials file exists
        if not os.path.exists(credentials_path):
            with open(credentials_path, 'w') as f:
                json.dump({}, f)
        
        # Initialize encryption if available
        if ENCRYPTION_AVAILABLE:
            self._initialize_encryption()
    
    def _initialize_encryption(self):
        """Initialize encryption key and cipher suite"""
        key_path = self.credentials_path + '.key'
        
        # Generate or load encryption key
        if not os.path.exists(key_path):
            self._encryption_key = Fernet.generate_key()
            with open(key_path, 'wb') as key_file:
                key_file.write(self._encryption_key)
        else:
            with open(key_path, 'rb') as key_file:
                self._encryption_key = key_file.read()
        
        self._cipher_suite = Fernet(self._encryption_key)
    
    def _encrypt(self, data: str) -> str:
        """Encrypt data if encryption is available"""
        if not ENCRYPTION_AVAILABLE or not self._cipher_suite:
            return data
        return self._cipher_suite.encrypt(data.encode()).decode()
    
    def _decrypt(self, encrypted_data: str) -> str:
        """Decrypt data if encryption is available"""
        if not ENCRYPTION_AVAILABLE or not self._cipher_suite:
            return encrypted_data
        return self._cipher_suite.decrypt(encrypted_data.encode()).decode()
    
    def save_credentials(self, phone_number: str, api_id: str, api_hash: str):
        """Save Telegram credentials securely with file locking"""
        with self._lock:
            try:
                # Use cross-platform file locking
                with FileLock(self.credentials_path):
                    credentials = {
                        'phone_number': self._encrypt(phone_number),
                        'api_id': self._encrypt(api_id),
                        'api_hash': self._encrypt(api_hash),
                        'last_updated': time.time()
                    }
                    with open(self.credentials_path, 'w') as f:
                        json.dump(credentials, f)
                logging.info("[CREDENTIALS] Credentials saved successfully")
            except Exception as e:
                logging.error(f"[CREDENTIALS] Error saving credentials: {e}")
    
    def get_credentials(self) -> Optional[Dict[str, str]]:
        """Retrieves Telegram credentials with file locking"""
        with self._lock:
            try:
                # Use cross-platform file locking
                with FileLock(self.credentials_path):
                    with open(self.credentials_path, 'r') as f:
                        credentials = json.load(f)
                if not credentials:
                    return None
                return {
                    'phone_number': self._decrypt(credentials['phone_number']),
                    'api_id': self._decrypt(credentials['api_id']),
                    'api_hash': self._decrypt(credentials['api_hash'])
                }
            except Exception as e:
                logging.error(f"[CREDENTIALS] Error retrieving credentials: {e}")
                return None
    
    def clear_credentials(self):
        """Clear saved credentials with file locking"""
        with self._lock:
            try:
                # Use cross-platform file locking
                with FileLock(self.credentials_path):
                    with open(self.credentials_path, 'w') as f:
                        json.dump({}, f)
                logging.info("[CREDENTIALS] Credentials cleared")
            except Exception as e:
                logging.error(f"[CREDENTIALS] Error clearing credentials: {e}")

class BotResponseType(Enum):
    NEW_PACK_CREATED = "new_pack_created"
    PACK_NAME_ACCEPTED = "pack_name_accepted"
    FILE_UPLOADED = "file_uploaded"
    EMOJI_ACCEPTED = "emoji_accepted"
    PACK_PUBLISHED = "pack_published"
    ERROR_RESPONSE = "error_response"
    UNKNOWN = "unknown"

@dataclass
class BotResponse:
    message: str
    response_type: BotResponseType
    timestamp: float
    raw_message: Optional[Message] = None
    confidence: float = 0.0

class AdvancedResponseMatcher:
    """EXACT RESPONSE MATCHING LOGIC FROM PYTHON VERSION"""
    def __init__(self):
        self.patterns = {
            BotResponseType.NEW_PACK_CREATED: [
                r"yay!\s*a\s*new\s*(?:set\s*of\s*)?(?:video\s*)?stickers?",
                r"yay!\s*a\s*new\s*sticker\s*set",
                r"alright!\s*a\s*new\s*sticker\s*pack\s*has\s*been\s*created",
            ],
            BotResponseType.PACK_NAME_ACCEPTED: [
                r"alright!\s*now\s*send\s*me\s*the\s*(?:video\s*)?sticker",
                r"now\s*send\s*me\s*the\s*(?:video\s*)?sticker",
                r"send\s*me\s*the\s*(?:video\s*)?sticker",
            ],
            BotResponseType.FILE_UPLOADED: [
                r"thanks!\s*now\s*send\s*me\s*an\s*emoji",
                r"now\s*send\s*me\s*an\s*emoji\s*that\s*corresponds",
                r"send\s*me\s*an\s*emoji",
            ],
            BotResponseType.EMOJI_ACCEPTED: [
                r"congratulations\.\s*stickers\s*in\s*the\s*set",
                r"stickers\s*in\s*the\s*set:\s*\d+",
                r"to\s*add\s*another\s*(?:video\s*)?sticker",
            ],
            BotResponseType.PACK_PUBLISHED: [
                r"your\s*(?:video\s*)?sticker\s*pack\s*has\s*been\s*published",
                r"sticker\s*pack\s*has\s*been\s*published",
                r"published\s*successfully",
            ],
            BotResponseType.ERROR_RESPONSE: [
                r"sorry,\s*i\s*don't\s*understand",
                r"please\s*try\s*again",
                r"error", r"failed", r"invalid",
            ],
        }

    def match_response(self, message: str, expected_type: BotResponseType = None) -> BotResponse:
        """EXACT MATCHING ALGORITHM FROM PYTHON VERSION"""
        message_lower = message.lower().strip()
        
        if expected_type:
            patterns = self.patterns.get(expected_type, [])
            for pattern in patterns:
                if re.search(pattern, message_lower, re.IGNORECASE):
                    return BotResponse(
                        message=message,
                        response_type=expected_type,
                        timestamp=time.time(),
                        confidence=0.95
                    )

        best_match = None
        best_confidence = 0.0
        
        for response_type, patterns in self.patterns.items():
            for pattern in patterns:
                match = re.search(pattern, message_lower, re.IGNORECASE)
                if match:
                    confidence = len(match.group(0)) / len(message_lower)
                    confidence = min(confidence * 1.2, 1.0)
                    if confidence > best_confidence:
                        best_confidence = confidence
                        best_match = BotResponse(
                            message=message,
                            response_type=response_type,
                            timestamp=time.time(),
                            confidence=confidence
                        )

        return best_match or BotResponse(
            message=message,
            response_type=BotResponseType.UNKNOWN,
            timestamp=time.time(),
            confidence=0.0
        )

class SimpleConversationManager:
    """EXACT CONVERSATION MANAGER FROM PYTHON VERSION"""
    def __init__(self, client: TelegramClient, bot_peer, logger=None):
        self.client = client
        self.bot_peer = bot_peer
        self.logger = logger or logging.getLogger(__name__)
        self.matcher = AdvancedResponseMatcher()
        self.response_queue = asyncio.Queue()
        self.listening = False
        self.message_handler = None

    async def start_listening(self):
        thread_name = threading.current_thread().name
        self.logger.info(f"[DEBUG] start_listening called from thread: {thread_name}")
        
        if self.listening:
            self.logger.info(f"[DEBUG] Already listening, returning")
            return
        
        self.listening = True
        self.logger.info(f"[DEBUG] Started listening for bot messages in thread: {thread_name}")

        @self.client.on(events.NewMessage(from_users=self.bot_peer.id))
        async def message_handler(event):
            if not self.listening:
                return
            
            message = event.message.message
            response = self.matcher.match_response(message)
            response.raw_message = event.message
            
            self.logger.info(f"[DEBUG] Bot response: {message[:100]}...")
            self.logger.info(f"[DEBUG] Detected type: {response.response_type.value}")
            
            await self.response_queue.put(response)

        self.message_handler = message_handler
        self.logger.info(f"[DEBUG] Message handler registered successfully in thread: {thread_name}")

    async def stop_listening(self):
        thread_name = threading.current_thread().name
        self.logger.info(f"[DEBUG] stop_listening called from thread: {thread_name}")
        
        self.listening = False
        if self.message_handler:
            self.logger.info(f"[DEBUG] Removing message handler in thread: {thread_name}")
            self.client.remove_event_handler(self.message_handler)
        self.logger.info(f"[DEBUG] Stopped listening for bot messages in thread: {thread_name}")

    async def wait_for_response(self, expected_type: BotResponseType, timeout: float = 30.0):
        self.logger.info(f"[WAIT] Waiting for {expected_type.value}")
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                # Use a more thread-safe approach to avoid signal issues
                try:
                    response = await asyncio.wait_for(self.response_queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    # Continue waiting - this is expected
                    continue
                
                if response.response_type == expected_type:
                    self.logger.info(f"[SUCCESS] Received expected response: {expected_type.value}")
                    return response
                
                if response.response_type == BotResponseType.ERROR_RESPONSE:
                    self.logger.error(f"[ERROR] Bot error response: {response.message}")
                    raise RuntimeError(f"Bot error: {response.message}")
                
                self.logger.warning(f"[WARNING] Unexpected response type: {response.response_type.value}")
                
            except Exception as e:
                # Log any other errors but continue waiting
                self.logger.warning(f"[WAIT] Error while waiting: {e}")
                await asyncio.sleep(0.1)  # Small delay before retrying
        
        raise TimeoutError(f"Timeout waiting for {expected_type.value}")

    async def send_and_wait(self, message: str, expected_response: BotResponseType, timeout: float = 30.0):
        self.logger.info(f"[MSG] Sending: {message}")
        
        # Clear pending responses
        while not self.response_queue.empty():
            try:
                await self.response_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Send message
        if os.path.exists(message):
            await self.client.send_file(self.bot_peer, message)
            self.logger.info(f"[MSG] Sent file: {os.path.basename(message)}")
        else:
            await self.client.send_message(self.bot_peer, message)
            self.logger.info(f"[MSG] Sent message: {message}")

        # Wait for response
        response = await self.wait_for_response(expected_response, timeout)
        return response


class MediaItem:
    def __init__(self, file_path: str, media_type: str, emoji: str = "😀"):
        self.file_path = file_path
        self.media_type = media_type
        self.emoji = emoji
        self.processed = False
        self.error_message = ""
        self.processing_stage = "pending"

class StickerBotCore:
    def __init__(self, logger=None):
        """
        Initialize StickerBotCore with enhanced connection management
        """
        thread_name = threading.current_thread().name
        telegram_logger.info(f"[DEBUG] StickerBotCore.__init__ called from thread: {thread_name}")
        
        # Existing initialization
        self.logger = logger or logging.getLogger(__name__)
        self.client = None
        self.bot_peer = None
        self.conversation_manager = None
        
        # Connection state tracking
        self._connection_lock = threading.Lock()
        self._last_connection_attempt = None
        self.session_file = None  # Track current session file
        
        telegram_logger.info(f"[DEBUG] StickerBotCore initialized successfully in thread: {thread_name}")
    
    def monitor_session_file(self):
        """Monitor session file and log if it gets deleted"""
        if self.session_file and os.path.exists(self.session_file):
            telegram_logger.info(f"[SESSION] Session file exists: {self.session_file}")
        elif self.session_file:
            telegram_logger.warning(f"[SESSION] Session file DELETED: {self.session_file}")
        else:
            telegram_logger.info(f"[SESSION] No session file tracked")
    
    def cleanup_connection(self):
        """
        Comprehensive method to clean up Telegram connection
        Ensures all resources are properly released
        """
        thread_name = threading.current_thread().name
        telegram_logger.info(f"[DEBUG] cleanup_connection called from thread: {thread_name}")
        
        with self._connection_lock:
            telegram_logger.info(f"[DEBUG] Connection lock acquired in thread: {thread_name}")
            try:
                # Disconnect and log out if client exists
                if self.client:
                    telegram_logger.info(f"[DEBUG] Cleaning up client in thread: {thread_name}")
                    # Use run_telegram_coroutine to ensure thread-safety
                    try:
                        telegram_logger.info(f"[DEBUG] Logging out client in thread: {thread_name}")
                        run_telegram_coroutine(self.client.log_out())
                        telegram_logger.info(f"[DEBUG] Client logged out successfully in thread: {thread_name}")
                    except Exception as e:
                        telegram_logger.warning(f"[DEBUG] Error logging out client in thread {thread_name}: {e}")
                    try:
                        telegram_logger.info(f"[DEBUG] Disconnecting client in thread: {thread_name}")
                        run_telegram_coroutine(self.client.disconnect())
                        telegram_logger.info(f"[DEBUG] Client disconnected successfully in thread: {thread_name}")
                    except Exception as e:
                        telegram_logger.warning(f"[DEBUG] Error disconnecting client in thread {thread_name}: {e}")
                    
                    # Clear client reference
                    self.client = None
                    telegram_logger.info(f"[DEBUG] Client reference cleared in thread: {thread_name}")
                
                # Reset conversation manager
                if self.conversation_manager:
                    telegram_logger.info(f"[DEBUG] Cleaning up conversation manager in thread: {thread_name}")
                    try:
                        run_telegram_coroutine(self.conversation_manager.stop_listening())
                        telegram_logger.info(f"[DEBUG] Conversation manager stopped successfully in thread: {thread_name}")
                    except Exception as e:
                        telegram_logger.warning(f"[DEBUG] Error stopping conversation manager in thread {thread_name}: {e}")
                    self.conversation_manager = None
                    telegram_logger.info(f"[DEBUG] Conversation manager reference cleared in thread: {thread_name}")
                
                # Reset bot peer
                self.bot_peer = None
                telegram_logger.info(f"[DEBUG] Bot peer reference cleared in thread: {thread_name}")
                
                # Smart session cleanup - only remove temporary/invalid sessions
                try:
                    telegram_logger.info(f"[DEBUG] Smart session cleanup in thread: {thread_name}")
                    # Only remove temporary sessions, keep persistent ones
                    temp_session_pattern = f'temp_session_*.session*'
                    for session_file in glob.glob(temp_session_pattern):
                        try:
                            os.remove(session_file)
                            telegram_logger.info(f"[DEBUG] Removed temporary session file: {session_file}")
                        except Exception as e:
                            telegram_logger.warning(f"[DEBUG] Could not remove temp session file {session_file}: {e}")
                            
                    # Force garbage collection to release any lingering connections
                    import gc
                    gc.collect()
                    telegram_logger.info(f"[DEBUG] Forced garbage collection in thread: {thread_name}")
                    
                except Exception as e:
                    telegram_logger.error(f"[DEBUG] Error during session cleanup in thread {thread_name}: {e}")
                
                telegram_logger.info(f"[DEBUG] Connection cleaned up successfully in thread: {thread_name}")
            except Exception as e:
                telegram_logger.error(f"[DEBUG] Error during connection cleanup in thread {thread_name}: {e}")
                telegram_logger.error(f"[DEBUG] Error type: {type(e)}")
                telegram_logger.error(f"[DEBUG] Full traceback: {traceback.format_exc()}")

    def __del__(self):
        # Best-effort cleanup on interpreter shutdown
        try:
            self.cleanup_connection()
        except Exception:
            pass
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_param: str, process_id: str, retry_count: int = 0) -> Dict:
        """
        Simplified Telegram connection method with robust error handling
        
        :param api_id: Telegram API ID
        :param api_hash: Telegram API Hash
        :param phone_number: User's phone number
        :param process_id: Unique process identifier
        :param retry_count: Current retry attempt
        :return: Connection result dictionary
        """
        # DEBUG: Log function entry
        telegram_logger.critical(f"🚀 STICKER_BOT.connect_telegram CALLED WITH: api_id={api_id}, api_hash={api_hash}, phone_param={phone_param}, process_id={process_id}")
        
        # Initialize safe variables to prevent scoping issues
        safe_phone_number = phone_param if phone_param else ''
        safe_api_id = api_id if api_id else ''
        safe_api_hash = api_hash if api_hash else ''
        safe_process_id = process_id if process_id else ''
        
        thread_name = threading.current_thread().name
        telegram_logger.info(f"[DEBUG] connect_telegram called from thread: {thread_name}")
        telegram_logger.info(f"[DEBUG] API ID: {safe_api_id}, API Hash: {safe_api_hash[:10]}..., Phone: {safe_phone_number}")
        
        # Validate inputs
        if not all([safe_api_id, safe_api_hash, safe_phone_number]):
            telegram_logger.warning(f"[DEBUG] Missing required fields in thread: {thread_name}")
            return {
                "success": False, 
                "error": "Missing required connection details",
                "needs_code": False,
                "needs_password": False,
                "phone_number": safe_phone_number
            }
        
        try:
            telegram_logger.info(f"[DEBUG] Starting connection process in thread: {thread_name}")
            
            # Smart session management - reuse existing sessions when possible
            try:
                telegram_logger.info(f"[DEBUG] Checking for existing sessions in thread: {thread_name}")
                # Look for existing persistent sessions
                persistent_sessions = glob.glob('session_*.session')
                if persistent_sessions:
                    telegram_logger.info(f"[DEBUG] Found existing persistent sessions: {persistent_sessions}")
                    # Only clean up temporary sessions
                    temp_sessions = glob.glob('temp_session_*.session*')
                    for temp_file in temp_sessions:
                        try:
                            os.remove(temp_file)
                            telegram_logger.info(f"[DEBUG] Removed temporary session: {temp_file}")
                        except Exception as e:
                            telegram_logger.warning(f"[DEBUG] Could not remove temp session {temp_file}: {e}")
                else:
                    telegram_logger.info(f"[DEBUG] No existing persistent sessions found")
            except Exception as e:
                telegram_logger.warning(f"[DEBUG] Error during session check: {e}")
            
            # Normalize phone number
            safe_phone_number = safe_phone_number.strip()
            if not safe_phone_number.startswith('+'):
                safe_phone_number = f'+{safe_phone_number}'
            
            # Validate API ID
            try:
                safe_api_id = int(str(safe_api_id).strip())
                telegram_logger.info(f"[DEBUG] API ID validated: {safe_api_id}")
            except ValueError:
                telegram_logger.error(f"[DEBUG] Invalid API ID: {safe_api_id}")
                return {
                    "success": False, 
                    "error": "Invalid API ID: Must be numeric",
                    "needs_code": False,
                    "needs_password": False,
                    "phone_number": safe_phone_number
                }
            
            # Smart session creation - reuse existing or create persistent session
            telegram_logger.info(f"[DEBUG] Creating TelegramClient in thread: {thread_name}")
            
            # Check for existing persistent session in current directory and python directory
            persistent_session = None
            session_dirs = ['.', 'python', '..']
            
            for session_dir in session_dirs:
                session_pattern = os.path.join(session_dir, 'session_*.session')
                for session_file in glob.glob(session_pattern):
                    if os.path.exists(session_file):
                        persistent_session = session_file.replace('.session', '')
                        telegram_logger.info(f"[SESSION] Found existing persistent session: {persistent_session}")
                        break
                if persistent_session:
                    break
            
            if persistent_session:
                # Reuse existing session
                try:
                    self.client = TelegramClient(persistent_session, safe_api_id, safe_api_hash)
                    self.session_file = persistent_session
                    telegram_logger.info(f"[SESSION] Reusing persistent session: {persistent_session}")
                except Exception as e:
                    telegram_logger.warning(f"[SESSION] Failed to reuse session {persistent_session}: {e}, creating new")
                    persistent_session = None
            
            if not persistent_session:
                # Create new persistent session in python directory
                import uuid
                session_name = f"session_{uuid.uuid4().hex[:8]}"
                # Ensure session is created in python directory
                if not os.path.exists('python'):
                    os.makedirs('python', exist_ok=True)
                session_path = os.path.join('python', session_name)
                self.client = TelegramClient(session_path, safe_api_id, safe_api_hash)
                self.session_file = session_path
                telegram_logger.info(f"[SESSION] Created new persistent session: {session_path}")
            
            # Connect to Telegram
            telegram_logger.info(f"[TELEGRAM] Connecting to Telegram...")
            try:
                run_telegram_coroutine(self.client.connect())
                telegram_logger.info(f"[DEBUG] Connected to Telegram successfully in thread: {thread_name}")
            except Exception as e:
                telegram_logger.error(f"[DEBUG] Connection error in thread {thread_name}: {e}")
                telegram_logger.error(f"[DEBUG] Connection error type: {type(e)}")
                telegram_logger.error(f"[DEBUG] Connection error traceback: {traceback.format_exc()}")
                raise
            
            # Check authorization status
            telegram_logger.info(f"[DEBUG] Checking authorization status in thread: {thread_name}")
            try:
                is_authorized = run_telegram_coroutine(self.client.is_user_authorized())
                telegram_logger.info(f"[DEBUG] Authorization status: {is_authorized}")
            except Exception as e:
                telegram_logger.error(f"[DEBUG] Authorization check error in thread {thread_name}: {e}")
                telegram_logger.error(f"[DEBUG] Authorization error type: {type(e)}")
                telegram_logger.error(f"[DEBUG] Authorization error traceback: {traceback.format_exc()}")
                raise
            
            if not is_authorized:
                # Send code request if not authorized
                telegram_logger.info(f"[DEBUG] Sending code request in thread: {thread_name}")
                run_telegram_coroutine(self.client.send_code_request(safe_phone_number))
                telegram_logger.info(f"[DEBUG] Code request sent successfully")
                
                return {
                    'success': True,
                    'needs_code': True,
                    'needs_password': False,
                    'phone_number': safe_phone_number
                }
            
            # If already authorized, set up bot interaction
            telegram_logger.info(f"[DEBUG] Getting bot peer in thread: {thread_name}")
            self.bot_peer = run_telegram_coroutine(self.client.get_entity('@stickers'))
            telegram_logger.info(f"[DEBUG] Bot peer obtained: {self.bot_peer}")
            
            telegram_logger.info(f"[DEBUG] Creating conversation manager in thread: {thread_name}")
            self.conversation_manager = SimpleConversationManager(
                self.client, 
                self.bot_peer, 
                self.logger
            )
            
            telegram_logger.info(f"[DEBUG] Starting conversation manager in thread: {thread_name}")
            run_telegram_coroutine(self.conversation_manager.start_listening())
            telegram_logger.info(f"[DEBUG] Conversation manager started successfully")
            
            telegram_logger.info(f"[DEBUG] Connection completed successfully in thread: {thread_name}")
            return {
                'success': True,
                'needs_code': False,
                'needs_password': False,
                'phone_number': safe_phone_number
            }
        
        except Exception as e:
            # Log the error
            telegram_logger.error(f"[DEBUG] Telegram connection error in thread {thread_name}: {e}")
            telegram_logger.error(f"[DEBUG] Error type: {type(e)}")
            telegram_logger.error(f"[DEBUG] Full traceback: {traceback.format_exc()}")
            
            # Handle database lock errors specifically
            if "database is locked" in str(e).lower() or "database is locked" in str(e):
                telegram_logger.error(f"[DATABASE LOCK] Attempting recovery for connection error")
                handle_database_lock_error(e, "telegram connection")
                
                # Attempt retry after cleanup
                if retry_count < 2:
                    telegram_logger.info(f"[RETRY] Attempting connection retry {retry_count + 1}/2")
                    time.sleep(1)  # Brief wait before retry
                    return self.connect_telegram(safe_api_id, safe_api_hash, safe_phone_number, safe_process_id, retry_count + 1)
            
            return {
                "success": False, 
                "error": str(e),
                "needs_code": False,
                "needs_password": False,
                "phone_number": safe_phone_number
            }

    def verify_code(self, code: str) -> Dict:
        """
        Verify the Telegram verification code with enhanced error handling
        
        :param code: Verification code from user
        :return: Verification result
        """
        try:
            # Verify code using the current client
            if not self.client:
                return {"success": False, "error": "No active Telegram client"}
            
            # Use run_telegram_coroutine for thread-safe execution
            result = run_telegram_coroutine(self.client.sign_in(code=code))
            
            # Check if 2FA is required
            if isinstance(result, bool) and result:
                # Setup bot interaction after successful sign-in
                self.bot_peer = run_telegram_coroutine(self.client.get_entity('@stickers'))
                self.conversation_manager = SimpleConversationManager(
                    self.client, 
                    self.bot_peer, 
                    self.logger
                )
                run_telegram_coroutine(self.conversation_manager.start_listening())
                
                return {
                    "success": True,
                    "needs_password": False
                }
            
            # If 2FA is needed
            return {
                "success": True,
                "needs_password": True
            }
                
        except Exception as e:
            error_str = str(e)
            error_type = type(e).__name__
            
            self.logger.error(f"[TELEGRAM] Code verification error: {error_type}: {error_str}")
            self.logger.error(f"[TELEGRAM] Error details - type: {type(e)}, module: {type(e).__module__}")
            
            # Check for SessionPasswordNeededError more robustly
            if ('SessionPasswordNeededError' in error_str or 
                'SessionPasswordNeededError' in error_type or
                'password' in error_str.lower() and 'required' in error_str.lower()):
                self.logger.info("Detected 2FA requirement - returning needs_password=True")
                return {
                    "success": True,
                    "needs_password": True
                }
            
            return {
                "success": False,
                "error": str(e),
                "needs_password": False
            }

    def verify_password(self, password: str) -> Dict:
        """
        Verify two-factor authentication password
        
        :param password: User's 2FA password
        :return: Password verification result
        """
        try:
            if not self.client:
                return {"success": False, "error": "No active Telegram client"}
            
            # Use run_telegram_coroutine for thread-safe execution
            result = run_telegram_coroutine(self.client.sign_in(password=password))
            
            if result:
                # Setup bot interaction after successful 2FA
                self.bot_peer = run_telegram_coroutine(self.client.get_entity('@stickers'))
                self.conversation_manager = SimpleConversationManager(
                    self.client, 
                    self.bot_peer, 
                    self.logger
                )
                run_telegram_coroutine(self.conversation_manager.start_listening())
                
                return {
                    "success": True,
                    "needs_password": False
                }
            
            return {
                "success": False,
                "error": "Invalid password",
                "needs_password": True
            }
            
        except Exception as e:
            self.logger.error(f"[TELEGRAM] Password verification error: {e}")
            
            return {
                "success": False,
                "error": str(e),
                "needs_password": False
            }

    def create_sticker_pack(self, pack_name: str, sticker_type: str, media_files: List[Dict], process_id: str):
        """REAL sticker pack creation with EXACT advanced logic from Python version"""
        try:
            if not self.conversation_manager:
                raise RuntimeError("Not connected to Telegram")

            # Convert to MediaItem objects
            media_items = []
            for media_file in media_files:
                media_item = MediaItem(
                    media_file['file_path'],
                    sticker_type,
                    media_file.get('emoji', '😀')
                )
                media_items.append(media_item)

            # Run creation in asyncio thread
            future = self.asyncio_thread.run_coroutine(
                self._create_sticker_pack_async(pack_name, sticker_type, media_items, process_id)
            )

            result = future.result(timeout=600.0)  # 10 minute timeout
            return result

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error: {e}")
            raise

    async def _create_sticker_pack_async(self, pack_name: str, sticker_type: str, media_items: List[MediaItem], process_id: str):
        """EXACT STICKER CREATION LOGIC FROM PYTHON VERSION"""
        try:
            from backend import active_processes

            self.logger.info(f"[STICKER] Starting pack creation: {pack_name}")

            # Step 1: Create new sticker pack
            command = "/newvideo" if sticker_type == "video" else "/newpack"
            self.logger.info(f"[STICKER] Sending command: {command}")
            
            response = await self.conversation_manager.send_and_wait(
                command, BotResponseType.NEW_PACK_CREATED, timeout=30.0
            )

            self.logger.info(f"[STICKER] Pack creation confirmed: {response.message[:100]}...")

            # Step 2: Send pack name
            self.logger.info(f"[STICKER] Sending pack name: {pack_name}")
            
            response = await self.conversation_manager.send_and_wait(
                pack_name, BotResponseType.PACK_NAME_ACCEPTED, timeout=30.0
            )

            self.logger.info(f"[STICKER] Pack name accepted: {response.message[:100]}...")

            # Step 3: Process each media item
            for i, media_item in enumerate(media_items):
                filename = os.path.basename(media_item.file_path)
                self.logger.info(f"[STICKER] Processing item {i+1}/{len(media_items)}: {filename}")

                # Update progress
                if process_id in active_processes:
                    active_processes[process_id]["progress"] = (i / len(media_items)) * 100
                    active_processes[process_id]["current_file"] = filename
                    active_processes[process_id]["current_stage"] = f"Processing {filename}"

                try:
                    # Upload file
                    media_item.processing_stage = "uploading"
                    self.logger.info(f"[STICKER] Uploading file: {filename}")
                    
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = f"Uploading {filename}..."

                    response = await self.conversation_manager.send_and_wait(
                        media_item.file_path, BotResponseType.FILE_UPLOADED, timeout=60.0
                    )

                    self.logger.info(f"[STICKER] File uploaded successfully: {response.message[:100]}...")

                    # Send emoji
                    media_item.processing_stage = "emoji_sending"
                    self.logger.info(f"[STICKER] Sending emoji: {media_item.emoji}")
                    
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = f"Sending emoji {media_item.emoji}..."

                    response = await self.conversation_manager.send_and_wait(
                        media_item.emoji, BotResponseType.EMOJI_ACCEPTED, timeout=30.0
                    )

                    self.logger.info(f"[STICKER] Emoji accepted: {response.message[:100]}...")

                    # Mark as completed
                    media_item.processed = True
                    media_item.processing_stage = "completed"
                    
                    if process_id in active_processes:
                        active_processes[process_id]["completed_files"] = i + 1
                        active_processes[process_id]["current_stage"] = f"Completed {filename}"

                    self.logger.info(f"[STICKER] Successfully processed: {filename}")

                except Exception as e:
                    error_msg = str(e)
                    self.logger.error(f"[STICKER] Error processing {filename}: {error_msg}")
                    media_item.error_message = error_msg
                    media_item.processing_stage = "error"
                    
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = f"Error with {filename}: {error_msg}"
                    continue

            # Step 4: Publish the pack
            self.logger.info("[STICKER] Publishing sticker pack...")
            
            if process_id in active_processes:
                active_processes[process_id]["current_stage"] = "Publishing pack..."

            response = await self.conversation_manager.send_and_wait(
                "/publish", BotResponseType.PACK_PUBLISHED, timeout=30.0
            )

            self.logger.info(f"[STICKER] Pack published successfully: {response.message[:100]}...")
            self.logger.info("[STICKER] PACK CREATION COMPLETED SUCCESSFULLY!")

            return {"success": True, "message": "Sticker pack created successfully"}

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error: {e}")
            raise

# Removed duplicate TelegramSessionManager class - using EnhancedTelegramSessionManager instead

def run_telegram_coroutine(coro):
    """
    Safely run a Telegram coroutine with proper event loop handling.
    Works correctly in Flask request threads.
    
    :param coro: Coroutine to run
    :return: Result of the coroutine
    """
    thread_name = threading.current_thread().name
    telegram_logger.info(f"[DEBUG] run_telegram_coroutine called from thread: {thread_name}")
    telegram_logger.info(f"[DEBUG] Coroutine type: {type(coro)}")
    
    # Check if we're in the main thread or a Flask thread
    try:
        # Try to get the current event loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                raise RuntimeError("Event loop is closed")
        except RuntimeError:
            # No event loop in this thread, create a new one
            telegram_logger.info(f"[DEBUG] No event loop in thread {thread_name}, creating new one")
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            telegram_logger.info(f"[DEBUG] New event loop created and set in thread: {thread_name}")
        
        # Use locks to prevent concurrent access
        telegram_logger.info(f"[DEBUG] Acquiring locks from thread: {thread_name}")
        with telegram_global_lock, database_global_lock:
            telegram_logger.info(f"[DEBUG] Locks acquired in thread: {thread_name}")
            
            try:
                telegram_logger.info(f"[DEBUG] Running coroutine in thread: {thread_name}")
                
                # Check if the loop is already running (nested call)
                if loop.is_running():
                    telegram_logger.info(f"[DEBUG] Event loop already running, using run_coroutine_threadsafe")
                    import concurrent.futures
                    future = asyncio.run_coroutine_threadsafe(coro, loop)
                    result = future.result(timeout=30)  # 30 second timeout
                else:
                    # Run the coroutine in the event loop
                    result = loop.run_until_complete(coro)
                
                telegram_logger.info(f"[DEBUG] Coroutine completed successfully in thread: {thread_name}")
                return result
                
            except Exception as e:
                # Log any coroutine execution errors
                telegram_logger.error(f"[DEBUG] Coroutine execution error in thread {thread_name}: {e}")
                telegram_logger.error(f"[DEBUG] Error type: {type(e)}")
                telegram_logger.error(f"[DEBUG] Full traceback: {traceback.format_exc()}")
                
                # Handle database lock errors specifically
                if "database is locked" in str(e).lower():
                    handle_database_lock_error(e, "coroutine execution")
                
                raise
                
    except Exception as e:
        telegram_logger.error(f"[DEBUG] Critical error in run_telegram_coroutine: {e}")
        telegram_logger.error(f"[DEBUG] Traceback: {traceback.format_exc()}")
        raise

# Flask routes for sticker bot
from flask import request, jsonify

# Create global sticker bot instance
# Initialize properly to avoid NoneType errors
sticker_bot = None

# Global queue for sticker pack creation tasks
sticker_pack_queue = queue.Queue()
sticker_pack_thread = None

# Global locks to ensure thread-safe operations
telegram_global_lock = threading.Lock()
database_global_lock = threading.RLock()  # Reentrant lock for database operations

# Create a dedicated logger for Telegram operations
telegram_logger = logging.getLogger('TelegramOperations')
telegram_logger.setLevel(logging.INFO)

def handle_database_lock_error(e, operation_name):
    """Handle database lock errors with recovery attempts"""
    thread_name = threading.current_thread().name
    telegram_logger.error(f"[DATABASE] Lock error during {operation_name} in thread {thread_name}: {e}")
  
    # Try to clean up any lingering connections
    try:
        import gc
        gc.collect()
        telegram_logger.info(f"[DATABASE] Forced garbage collection in thread: {thread_name}")
        
        # Log active threads for debugging
        active_threads = [t.name for t in threading.enumerate()]
        telegram_logger.info(f"[DATABASE] Active threads during lock: {active_threads}")
        
        # Smart lock file cleanup - only remove temporary lock files
        lock_patterns = ['*.session-journal', '*.session-wal', 'temp_session_*.session*']
        for pattern in lock_patterns:
            for lock_file in glob.glob(pattern):
                try:
                    os.remove(lock_file)
                    telegram_logger.info(f"[DATABASE] Removed temporary lock file: {lock_file}")
                except Exception as le:
                    telegram_logger.warning(f"[DATABASE] Could not remove lock file {lock_file}: {le}")
    except Exception as cleanup_error:
        telegram_logger.error(f"[DATABASE] Error during lock recovery in thread {thread_name}: {cleanup_error}")

def sticker_pack_worker():
    """Background worker to process sticker pack creation tasks"""
    while True:
        try:
            # Block and wait for a task
            task = sticker_pack_queue.get()
            
            # Unpack task parameters
            pack_name, sticker_type, media_files, process_id = task
            
            # Update process status to processing
            from backend import active_processes, process_lock
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]['status'] = 'processing'
                    active_processes[process_id]['current_stage'] = 'Starting sticker pack creation...'
            
            try:
                # Perform sticker pack creation
                result = sticker_bot.create_sticker_pack(pack_name, sticker_type, media_files, process_id)
                
                # Update process with result
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['result'] = result
                        active_processes[process_id]['status'] = 'completed'
                        active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                        active_processes[process_id]['progress'] = 100
            
            except Exception as e:
                # Log error and update process status
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['status'] = 'error'
                        active_processes[process_id]['current_stage'] = f'Error: {str(e)}'
                        active_processes[process_id]['error'] = str(e)
                
                sticker_bot.logger.error(f"Background sticker pack creation error: {e}")
            
            finally:
                # Mark task as done
                sticker_pack_queue.task_done()
        
        except Exception as e:
            sticker_bot.logger.error(f"Sticker pack worker error: {e}")

def start_sticker_pack_worker():
    """Start the background worker thread"""
    global sticker_pack_thread
    if sticker_pack_thread is None or not sticker_pack_thread.is_alive():
        sticker_pack_thread = threading.Thread(target=sticker_pack_worker, daemon=True)
        sticker_pack_thread.start()

def register_sticker_routes(app):
    """Register sticker bot routes with the Flask app"""
    global sticker_bot
    thread_name = threading.current_thread().name
    telegram_logger.info(f"[DEBUG] register_sticker_routes called from thread: {thread_name}")
    telegram_logger.info(f"[DEBUG] Registering routes with Flask app: {app}")
    
    # Initialize sticker_bot if not already done
    if sticker_bot is None:
        telegram_logger.info(f"[DEBUG] Initializing sticker_bot in register_sticker_routes")
        sticker_bot = StickerBotCore()
        telegram_logger.info(f"[DEBUG] sticker_bot initialized successfully")
    
    @app.route('/api/sticker/connect', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def connect_sticker_bot():
        """ULTIMATE FIX - This function is guaranteed to work without scoping errors"""
        thread_name = threading.current_thread().name
        telegram_logger.info(f"[DEBUG] Flask route /api/sticker/connect called from thread: {thread_name}")
        
        # Initialize ALL variables at the very beginning to prevent ANY scoping issues
        safe_phone_number = ''
        safe_api_id = ''
        safe_api_hash = ''
        safe_process_id = ''
        success = False
        error_message = ''
        needs_code = False
        needs_password = False
        
        if request.method == 'OPTIONS':
            telegram_logger.info(f"[DEBUG] OPTIONS request, returning 200")
            return '', 200
            
        try:
            telegram_logger.info(f"[DEBUG] Processing POST request in thread: {thread_name}")
            
            # Safe data extraction with null checks
            try:
                # Log raw request data for debugging
                raw_data = request.get_data(as_text=True)
                telegram_logger.info(f"[TRACE] Raw request data: {raw_data}")

                data = request.get_json()
                telegram_logger.info(f"[TRACE] Parsed JSON data: {data}")

                if not data:
                    telegram_logger.warning(f"[DEBUG] No JSON data received in thread: {thread_name}")
                    return jsonify({
                        "success": False, 
                        "error": "No data provided", 
                        "phone_number": safe_phone_number,
                        "needs_code": False,
                        "needs_password": False
                    }), 400
                
                # Explicitly log each field for tracing
                telegram_logger.info(f"[TRACE] Extracting fields: {list(data.keys())}")
                safe_api_id = data.get('api_id', '')
                safe_api_hash = data.get('api_hash', '')
                safe_phone_number = data.get('phone_number', '')
                safe_process_id = data.get('process_id', '')

                telegram_logger.info(f"[TRACE] Extracted values: api_id={safe_api_id}, api_hash={safe_api_hash}, phone_number={safe_phone_number}, process_id={safe_process_id}")
                
            except Exception as data_error:
                telegram_logger.error(f"[DEBUG] Error parsing JSON data in thread {thread_name}: {data_error}")
                telegram_logger.error(f"[DEBUG] Error details: {traceback.format_exc()}")
                return jsonify({
                    "success": False, 
                    "error": f"Invalid JSON data: {str(data_error)}", 
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                }), 400
            
            telegram_logger.info(f"[DEBUG] Request data - API ID: {safe_api_id}, Phone: {safe_phone_number}, Process ID: {safe_process_id}")

            # Early validation to prevent processing with missing data
            if not all([safe_api_id, safe_api_hash, safe_phone_number]):
                telegram_logger.warning(f"[DEBUG] Missing required fields in thread: {thread_name}")
                return jsonify({
                    "success": False, 
                    "error": "Missing required fields", 
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                }), 400

            # ULTIMATE FIX - Now implement the actual working logic
            telegram_logger.critical(f"🚀 ULTIMATE FIX: Processing connection with api_id={safe_api_id}, phone={safe_phone_number}")
            
            # Use the thread-safe handler for actual connection
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                result = handler.connect_telegram(safe_api_id, safe_api_hash, safe_phone_number)
                telegram_logger.info(f"[DEBUG] Handler result: {result}")
                return jsonify(result)
            except Exception as handler_error:
                telegram_logger.error(f"[DEBUG] Handler error: {handler_error}")
                # Fallback to working response
                return jsonify({
                    "success": False,
                    "error": f"Connection error: {str(handler_error)}",
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                })

        except Exception as e:
            telegram_logger.error(f"[DEBUG] Flask route error in thread {thread_name}: {e}")
            telegram_logger.error(f"[DEBUG] Error type: {type(e)}")
            telegram_logger.error(f"[DEBUG] Full traceback: {traceback.format_exc()}")
            # Use safe_phone_number which is always defined
            return jsonify({
                "success": False, 
                "error": str(e), 
                "phone_number": safe_phone_number,
                "needs_code": False,
                "needs_password": False
            }), 500

    @app.route('/api/sticker/verify-code', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def verify_code():
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            code = data.get('code', '') if data else ''

            if not code:
                return jsonify({"success": False, "error": "Code is required"}), 400

            # Use thread-safe handler
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                result = handler.verify_code(code)
                return jsonify(result)
            except ImportError:
                # Fallback to sticker_bot
                if sticker_bot is None:
                    return jsonify({"success": False, "error": "Telegram service not initialized"}), 500
                result = sticker_bot.verify_code(code)
                return jsonify(result)

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/verify-password', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def verify_password():
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            password = data.get('password', '') if data else ''

            if not password:
                return jsonify({"success": False, "error": "Password is required"}), 400

            # Use thread-safe handler
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                result = handler.verify_password(password)
                return jsonify(result)
            except ImportError:
                # Fallback to sticker_bot
                if sticker_bot is None:
                    return jsonify({"success": False, "error": "Telegram service not initialized"}), 500
                result = sticker_bot.verify_password(password)
                return jsonify(result)

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/create-pack', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def create_sticker_pack():
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            pack_name = data.get('pack_name', '') if data else ''
            sticker_type = data.get('sticker_type', 'video') if data else 'video'
            media_files = data.get('media_files', []) if data else []
            process_id = data.get('process_id', f'sticker_{int(time.time())}') if data else f'sticker_{int(time.time())}'

            # Import active_processes from backend
            from backend import active_processes, process_lock

            # Check for existing process
            with process_lock:
                if process_id in active_processes:
                    existing_process = active_processes[process_id]
                    if existing_process.get('status') in ['processing', 'initializing']:
                        return jsonify({
                            "success": False, 
                            "error": "A process with this ID is already in progress",
                            "existing_process_status": existing_process.get('status')
                        }), 400

            if not pack_name:
                return jsonify({"success": False, "error": "Pack name is required"}), 400

            if not media_files:
                return jsonify({"success": False, "error": "No media files provided"}), 400

            # Start background worker if not already running
            start_sticker_pack_worker()

            # Add process to active_processes immediately for tracking
            with process_lock:
                active_processes[process_id] = {
                    "status": "queued",
                    "current_stage": "Waiting in queue...",
                    "progress": 0,
                    "total_files": len(media_files),
                    "completed_files": 0,
                    "start_time": time.time(),
                    "type": "sticker_pack",
                    "pack_name": pack_name,
                    "sticker_type": sticker_type
                }

            # Add task to queue
            sticker_pack_queue.put((pack_name, sticker_type, media_files, process_id))

            # Immediately return process ID for tracking
            return jsonify({
                "success": True, 
                "process_id": process_id,
                "message": "Sticker pack creation queued"
            })

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/reset-connection', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def reset_sticker_connection():
        """
        API endpoint to reset Telegram connection
        Provides a way to manually clear and reset the connection
        """
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            # Clean up existing connection
            sticker_bot.cleanup_connection()
            return jsonify({"success": True, "message": "Connection reset successfully"})
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

import os
import sys
import traceback
import logging
import sqlite3
import threading
import time
import re
import glob
import json

# Enhanced logging configuration
import logging
import os

# Ensure logs directory exists with absolute path
import os
import sys

# Get the absolute path to the project root
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LOGS_DIR = os.path.join(PROJECT_ROOT, 'logs')

# Create logs directory if it doesn't exist
os.makedirs(LOGS_DIR, exist_ok=True)

# Detailed logging configuration with multiple handlers
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        # Log to file with comprehensive details (UTF-8)
        logging.FileHandler(os.path.join(LOGS_DIR, 'telegram_connection_debug.log'), mode='w', encoding='utf-8')
    ]
)

# Create a dedicated logger for Telegram connection with file and console logging
telegram_logger = logging.getLogger('TelegramConnection')
telegram_logger.setLevel(logging.DEBUG)

# Create file handler
file_handler = logging.FileHandler(os.path.join(LOGS_DIR, 'telegram_connection_debug.log'), mode='w', encoding='utf-8')
file_handler.setLevel(logging.DEBUG)

# Create console handler
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.DEBUG)

# Create formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)

# Add handlers to the logger (file only to avoid Windows console encoding issues)
telegram_logger.addHandler(file_handler)

# Log the log file location for easy reference
print(f"Telegram Connection Logs will be written to: {os.path.join(LOGS_DIR, 'telegram_connection_debug.log')}")


# Removed duplicate connect_telegram_with_debug method and monkey patch
