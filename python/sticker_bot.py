import asyncio
import logging
import os
import sys
import time
import re
import threading
import json
import queue
import glob
import uuid
import traceback
from typing import Optional, Dict, List
from enum import Enum
from dataclasses import dataclass

# Note: avoid importing fcntl on Windows to prevent portability issues
try:
    import fcntl  # noqa: F401
except Exception:
    pass

def run_telegram_coroutine(coro):
    """
    Helper function to run async coroutines in sync context
    Uses the telegram handler's event loop for consistency
    """
    try:
        from telegram_connection_handler import get_telegram_handler
        handler = get_telegram_handler()
        if handler:
            return handler.run_async(coro)
        else:
            # Fallback: create new event loop
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(coro)
            finally:
                loop.close()
    except Exception as e:
        logging.error(f"Error running telegram coroutine: {e}")
        raise

def validate_url_name(url_name):
    """Validate URL name according to Telegram sticker pack rules"""
    # Length validation (5-32 characters)
    if len(url_name) < 5:
        return {'valid': False, 'error': 'URL name must be at least 5 characters long'}
    if len(url_name) > 32:
        return {'valid': False, 'error': 'URL name must be no more than 32 characters long'}
    
    # Character validation (only letters, numbers, underscores)
    if not re.match(r'^[a-zA-Z0-9_]+$', url_name):
        return {'valid': False, 'error': 'URL name can only contain letters, numbers, and underscores'}
    
    # Starting character validation (must start with letter)
    if not re.match(r'^[a-zA-Z]', url_name):
        return {'valid': False, 'error': 'URL name must start with a letter'}
    
    return {'valid': True}

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
    URL_NAME_REQUEST = "url_name_request"
    URL_NAME_ACCEPTED = "url_name_accepted"
    URL_NAME_TAKEN = "url_name_taken"
    FILE_UPLOADED = "file_uploaded"
    EMOJI_ACCEPTED = "emoji_accepted"
    PACK_PUBLISHED = "pack_published"
    ICON_REQUEST = "icon_request"
    ICON_ACCEPTED = "icon_accepted"
    PACK_SUCCESS = "pack_success"
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
            BotResponseType.URL_NAME_REQUEST: [
                r"please\s*provide\s*a\s*short\s*name\s*for\s*your\s*set",
                r"please\s*provide\s*a\s*short\s*name",
                r"short\s*name\s*for\s*your\s*set",
                r"i'll\s*use\s*it\s*to\s*create\s*a\s*link",
            ],
            BotResponseType.URL_NAME_ACCEPTED: [
                r"alright!\s*now\s*send\s*me\s*the\s*(?:video\s*)?sticker",
                r"now\s*send\s*me\s*the\s*(?:video\s*)?sticker",
                r"send\s*me\s*the\s*(?:video\s*)?sticker",
            ],
            BotResponseType.URL_NAME_TAKEN: [
                r"sorry,\s*this\s*short\s*name\s*is\s*already\s*taken",
                r"this\s*short\s*name\s*is\s*already\s*taken",
                r"short\s*name\s*is\s*already\s*taken",
                r"name\s*is\s*already\s*taken",
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
            BotResponseType.ICON_REQUEST: [
                r"you\s*can\s*set\s*an\s*icon\s*for\s*your\s*(?:video\s*)?sticker\s*set",
                r"to\s*set\s*an\s*icon.*send\s*me\s*a\s*webm\s*file",
                r"you\s*can\s*/skip\s*this\s*step",
                r"send\s*me\s*a\s*webm\s*file\s*up\s*to\s*32\s*kb",
            ],
            BotResponseType.ICON_ACCEPTED: [
                r"thanks!\s*stickers?\s*in\s*the\s*set:\s*\d+",
                r"stickers?\s*in\s*the\s*set:\s*\d+",
                r"your\s*(?:video\s*)?sticker\s*pack\s*has\s*been\s*published",
                r"sticker\s*pack\s*has\s*been\s*published",
            ],
            BotResponseType.PACK_SUCCESS: [
                r"kaboom!\s*i've\s*just\s*published\s*your\s*sticker\s*set",
                r"here's\s*your\s*link:\s*https://t\.me/addstickers/",
                r"you\s*can\s*share\s*it\s*with\s*other\s*telegram\s*users",
                r"https://t\.me/addstickers/",
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

    async def send_file_and_wait(self, file_path: str, expected_response: BotResponseType, timeout: float = 60.0):
        """Send a file and wait for the expected response"""
        self.logger.info(f"[FILE] Sending file: {file_path}")
        
        # Clear pending responses
        while not self.response_queue.empty():
            try:
                await self.response_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Send file
        await self.client.send_file(self.bot_peer, file_path)
        self.logger.info(f"[FILE] Sent file: {os.path.basename(file_path)}")

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
        logging.info(f"[DEBUG] StickerBotCore.__init__ called from thread: {thread_name}")
        
        # Existing initialization
        self.logger = logger or logging.getLogger(__name__)
        self.client = None
        self.bot_peer = None
        self.conversation_manager = None
        
        # Connection state tracking
        self._connection_lock = threading.Lock()
        self._last_connection_attempt = None
        self.session_file = None  # Track current session file
        
        logging.info(f"[DEBUG] StickerBotCore initialized successfully in thread: {thread_name}")
    
    def monitor_session_file(self):
        """Monitor session file and log if it gets deleted"""
        if self.session_file and os.path.exists(self.session_file):
            logging.info(f"[SESSION] Session file exists: {self.session_file}")
        elif self.session_file:
            logging.warning(f"[SESSION] Session file DELETED: {self.session_file}")
        else:
            logging.info(f"[SESSION] No session file tracked")
    
    def cleanup_connection(self):
        """
        Gentle connection cleanup for session reuse implementation
        Disconnects but preserves sessions for reuse
        """
        thread_name = threading.current_thread().name
        logging.info(f"[STICKER_CLEANUP] Starting gentle cleanup in thread: {thread_name}")
        
        with self._connection_lock:
            try:
                # STEP 1: Stop conversation manager first
                if self.conversation_manager:
                    logging.info(f"[STICKER_CLEANUP] Stopping conversation manager...")
                    try:
                        run_telegram_coroutine(self.conversation_manager.stop_listening())
                        logging.info(f"[STICKER_CLEANUP] Conversation manager stopped successfully")
                    except Exception as e:
                        logging.warning(f"[STICKER_CLEANUP] Error stopping conversation manager: {e}")
                    self.conversation_manager = None
                
                # STEP 2: Use telegram handler for gentle cleanup (preserves sessions)
                try:
                    from telegram_connection_handler import get_telegram_handler
                    handler = get_telegram_handler()
                    if handler:
                        logging.info(f"[STICKER_CLEANUP] Using handler for gentle disconnect...")
                        handler.force_disconnect_and_cleanup()  # This is now gentle
                        logging.info(f"[STICKER_CLEANUP] Handler gentle disconnect completed")
                    else:
                        logging.warning(f"[STICKER_CLEANUP] No handler available for cleanup")
                except Exception as e:
                    logging.error(f"[STICKER_CLEANUP] Handler cleanup error: {e}")
                
                # STEP 3: Clear our references (but don't destroy session files)
                self.client = None
                self.bot_peer = None
                # Don't clear session_file - keep it for potential reuse
                
                # STEP 4: Optional garbage collection
                try:
                    import gc
                    gc.collect()
                    logging.info(f"[STICKER_CLEANUP] Garbage collection completed")
                except Exception as e:
                    logging.warning(f"[STICKER_CLEANUP] Error during garbage collection: {e}")
                
                logging.info(f"[STICKER_CLEANUP] Gentle cleanup finished successfully")
                
            except Exception as e:
                logging.error(f"[STICKER_CLEANUP] Critical cleanup error: {e}")
                logging.error(f"[STICKER_CLEANUP] Error type: {type(e)}")
                logging.error(f"[STICKER_CLEANUP] Full traceback: {traceback.format_exc()}")
                # Even on error, try to clear our references
                self.conversation_manager = None
                self.client = None
                self.bot_peer = None

    def create_sticker_pack(self, pack_name: str, pack_url_name: str, sticker_type: str, media_files: List[Dict], process_id: str, auto_skip_icon: bool = True):
        """REAL sticker pack creation with EXACT advanced logic from Python version"""
        try:
            self.logger.info(f"[STICKER] Starting create_sticker_pack with process_id: {process_id}")
            self.logger.info(f"[STICKER] Pack name: {pack_name}")
            self.logger.info(f"[STICKER] Sticker type: {sticker_type}")
            self.logger.info(f"[STICKER] Media files count: {len(media_files)}")
            self.logger.info(f"[STICKER] Auto-skip icon: {auto_skip_icon}")
            
            # Check current connection status
            self.logger.info(f"[STICKER] Current conversation_manager: {self.conversation_manager}")
            self.logger.info(f"[STICKER] Current client: {self.client}")
            self.logger.info(f"[STICKER] Current bot_peer: {self.bot_peer}")
            
            # Check if we have a conversation manager, if not try to set it up from existing connection
            if not self.conversation_manager:
                self.logger.info("[STICKER] No conversation manager found, attempting to set up from existing connection")
                try:
                    # Try to get the client from the telegram handler
                    from telegram_connection_handler import get_telegram_handler
                    handler = get_telegram_handler()
                    if handler and handler._client:
                        self.logger.info("[STICKER] Found existing client in handler, setting up conversation manager")
                        
                        # Use the handler's event loop to get the bot peer
                        async def setup_conversation_manager():
                            try:
                                # Get bot peer using the handler's event loop
                                bot_peer = await handler._client.get_entity('@stickers')
                                self.logger.info(f"[STICKER] Bot peer obtained: {bot_peer}")
                                
                                # Set up the client and bot peer
                                self.client = handler._client
                                self.bot_peer = bot_peer
                                
                                # Create conversation manager
                                self.conversation_manager = SimpleConversationManager(
                                    self.client, 
                                    self.bot_peer, 
                                    self.logger
                                )
                                
                                # Start listening
                                await self.conversation_manager.start_listening()
                                self.logger.info("[STICKER] Conversation manager set up successfully")
                                return True
                            except Exception as e:
                                self.logger.error(f"[STICKER] Error setting up conversation manager: {e}")
                                self.logger.error(f"[STICKER] Error type: {type(e)}")
                                self.logger.error(f"[STICKER] Full traceback: {traceback.format_exc()}")
                                return False
                        
                        # Run the setup in the handler's event loop
                        success = handler.run_async(setup_conversation_manager())
                        if not success:
                            raise RuntimeError("Failed to set up conversation manager")
                    else:
                        raise RuntimeError("No existing Telegram connection found")
                except Exception as e:
                    self.logger.error(f"[STICKER] Failed to set up conversation manager: {e}")
                    self.logger.error(f"[STICKER] Error type: {type(e)}")
                    self.logger.error(f"[STICKER] Full traceback: {traceback.format_exc()}")
                    raise RuntimeError("Not connected to Telegram")
            
            if not self.conversation_manager:
                raise RuntimeError("Not connected to Telegram")
            
            # Verify conversation manager is properly set up
            if not self.conversation_manager.listening:
                self.logger.warning("[STICKER] Conversation manager not listening, attempting to restart...")
                try:
                    # Use run_telegram_coroutine to handle the async call
                    run_telegram_coroutine(self.conversation_manager.start_listening())
                    self.logger.info("[STICKER] Conversation manager restarted successfully")
                except Exception as e:
                    self.logger.error(f"[STICKER] Failed to restart conversation manager: {e}")
                    raise RuntimeError("Failed to start conversation manager")

            # Convert to MediaItem objects
            media_items = []
            for media_file in media_files:
                media_item = MediaItem(
                    media_file['file_path'],
                    sticker_type,
                    media_file.get('emoji', '😀')
                )
                media_items.append(media_item)

            self.logger.info(f"[STICKER] Created {len(media_items)} media items for process {process_id}")

            # Run creation using the existing run_telegram_coroutine function
            result = run_telegram_coroutine(
                self._create_sticker_pack_async(pack_name, pack_url_name, sticker_type, media_items, process_id, auto_skip_icon)
            )

            self.logger.info(f"[STICKER] Pack creation completed for process {process_id}")
            return result

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error for process {process_id}: {e}")
            raise

    async def _create_sticker_pack_async(self, pack_name: str, pack_url_name: str, sticker_type: str, media_items: List[MediaItem], process_id: str, auto_skip_icon: bool = True):
        """EXACT STICKER CREATION LOGIC FROM PYTHON VERSION"""
        try:
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock, add_process, update_process
            self.logger.info(f"[STICKER] Successfully imported active_processes, current processes: {list(active_processes.keys())}")

            self.logger.info(f"[STICKER] Starting pack creation: {pack_name}")
            self.logger.info(f"[STICKER] Process ID: {process_id}")
            self.logger.info(f"[STICKER] Available processes: {list(active_processes.keys())}")

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

            # Step 3: Upload stickers
            for i, media_item in enumerate(media_items):
                filename = os.path.basename(media_item.file_path)
                self.logger.info(f"[STICKER] Processing sticker {i+1}/{len(media_items)}: {filename}")
                
                # Update process status
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['current_file'] = filename
                        active_processes[process_id]['current_stage'] = f'Uploading sticker {i+1}/{len(media_items)}...'
                        active_processes[process_id]['progress'] = (i / len(media_items)) * 100

                try:
                    # Upload file
                    self.logger.info(f"[STICKER] Uploading file: {filename}")
                    response = await self.conversation_manager.send_file_and_wait(
                        media_item.file_path, BotResponseType.FILE_UPLOADED, timeout=60.0
                    )

                    self.logger.info(f"[STICKER] File uploaded: {response.message[:100]}...")

                    # Send emoji
                    self.logger.info(f"[STICKER] Sending emoji: {media_item.emoji}")
                    response = await self.conversation_manager.send_and_wait(
                        media_item.emoji, BotResponseType.EMOJI_ACCEPTED, timeout=30.0
                    )

                    self.logger.info(f"[STICKER] Emoji accepted: {response.message[:100]}...")

                    # Update progress
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]['completed_files'] = i + 1
                            active_processes[process_id]['progress'] = ((i + 1) / len(media_items)) * 100
                            active_processes[process_id]['current_stage'] = f'Completed {filename}'

                except Exception as e:
                    self.logger.error(f"[STICKER] Error processing {filename}: {e}")
                    # Continue with next file instead of failing completely
                    continue

            # Step 4: Publish pack
            self.logger.info(f"[STICKER] Publishing pack...")
            response = await self.conversation_manager.send_and_wait(
                "/publish", BotResponseType.PACK_PUBLISHED, timeout=30.0
            )

            self.logger.info(f"[STICKER] Pack published: {response.message[:100]}...")

            # Update final status
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]['status'] = 'completed'
                    active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                    active_processes[process_id]['progress'] = 100

            return {"success": True, "message": "Sticker pack created successfully"}

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error: {e}")
            raise

    def is_connected(self):
        """Check if Telegram connection is available - SESSION REUSE VERSION"""
        try:
            logging.info("[STICKER_CONNECTION] Checking connection status for session reuse...")
            
            # For session reuse, we check the actual connection status from handler
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                
                if not handler:
                    logging.info("[STICKER_CONNECTION] No handler available - disconnected")
                    return False
                
                # Check if handler has an active connection
                has_connection = handler.has_active_connection()
                logging.info(f"[STICKER_CONNECTION] Handler connection status: {has_connection}")
                
                if not has_connection:
                    logging.info("[STICKER_CONNECTION] No active connection in handler")
                    return False
                
                # If handler has connection, ensure we have bot interaction set up
                if not self.conversation_manager and handler._client:
                    logging.info("[STICKER_CONNECTION] Setting up bot interaction from handler's connection...")
                    try:
                        async def setup_bot_interaction():
                            self.client = handler._client
                            self.bot_peer = await self.client.get_entity('@stickers')
                            self.conversation_manager = SimpleConversationManager(
                                self.client, 
                                self.bot_peer, 
                                self.logger
                            )
                            await self.conversation_manager.start_listening()
                            return True
                        
                        handler.run_async(setup_bot_interaction())
                        logging.info("[STICKER_CONNECTION] Bot interaction set up successfully")
                    except Exception as e:
                        logging.error(f"[STICKER_CONNECTION] Error setting up bot interaction: {e}")
                        return False
                
                # Final check - do we have everything needed?
                connected = (self.conversation_manager is not None and 
                           self.client is not None and 
                           self.bot_peer is not None)
                
                logging.info(f"[STICKER_CONNECTION] Final status: {connected}")
                return connected
            
            except Exception as e:
                logging.error(f"[STICKER_CONNECTION] Error checking connection: {e}")
                return False
            
        except Exception as e:
            logging.error(f"[STICKER_CONNECTION] Critical error in connection check: {e}")
            logging.error(f"[STICKER_CONNECTION] Error type: {type(e)}")
            logging.error(f"[STICKER_CONNECTION] Full traceback: {traceback.format_exc()}")
            return False

    def __del__(self):
        # Best-effort cleanup on interpreter shutdown
        try:
            self.cleanup_connection()
        except Exception:
            pass
    
    def connect_telegram(self, api_id: str, api_hash: str, phone_param: str, process_id: str, retry_count: int = 0) -> Dict:
        """
        Session reuse Telegram connection - uses existing sessions when possible
        
        :param api_id: Telegram API ID
        :param api_hash: Telegram API Hash
        :param phone_number: User's phone number
        :param process_id: Unique process identifier
        :param retry_count: Current retry attempt
        :return: Connection result dictionary
        """
        # DEBUG: Log function entry
        logging.info(f"🚀 STICKER_BOT.connect_telegram SESSION REUSE STARTING")
        logging.info(f"📱 Phone: ***{str(phone_param)[-4:]}, Process: {process_id}")
        
        # Initialize safe variables to prevent scoping issues
        safe_phone_number = phone_param if phone_param else ''
        safe_api_id = api_id if api_id else ''
        safe_api_hash = api_hash if api_hash else ''
        safe_process_id = process_id if process_id else ''
        
        thread_name = threading.current_thread().name
        logging.info(f"[STICKER_CONNECT] Session reuse connection in thread: {thread_name}")
        
        # Validate inputs
        if not all([safe_api_id, safe_api_hash, safe_phone_number]):
            logging.warning(f"[STICKER_CONNECT] Missing required fields")
            return {
                "success": False, 
                "error": "Missing required connection details",
                "needs_code": False,
                "needs_password": False,
                "phone_number": safe_phone_number
            }
        
        try:
            # Use the handler for session reuse connection
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            
            if not handler:
                logging.error("[STICKER_CONNECT] No telegram handler available")
                return {
                    "success": False, 
                    "error": "Telegram handler not available",
                    "needs_code": False,
                    "needs_password": False,
                    "phone_number": safe_phone_number
                }
            
            # Request session reuse connection
            logging.info("[STICKER_CONNECT] Requesting session reuse connection from handler...")
            result = handler.connect_telegram(safe_api_id, safe_api_hash, safe_phone_number)
            
            # Update our references if connection successful
            if result.get('success') and not result.get('needs_code') and not result.get('needs_password'):
                try:
                    # Get the client from the handler
                    self.client = handler._client
                    
                    # Set up bot interaction using the handler's event loop
                    async def setup_bot_interaction():
                        self.bot_peer = await self.client.get_entity('@stickers')
                        self.conversation_manager = SimpleConversationManager(
                            self.client, 
                            self.bot_peer, 
                            self.logger
                        )
                        await self.conversation_manager.start_listening()
                        return True
                    
                    # Run setup on handler's event loop
                    handler.run_async(setup_bot_interaction())
                    logging.info(f"[STICKER_CONNECT] Bot interaction set up successfully")
                    
                    # Log session reuse information
                    if result.get('reused_session'):
                        logging.info(f"[STICKER_CONNECT] ✅ Successfully reused existing session")
                    elif result.get('existing_session'):
                        logging.info(f"[STICKER_CONNECT] ✅ Used existing authorized session")
                    else:
                        logging.info(f"[STICKER_CONNECT] ✅ Created new session")
                    
                except Exception as e:
                    logging.error(f"[STICKER_CONNECT] Error setting up bot interaction: {e}")
                    # Don't fail the connection, just log the error
            
            logging.info(f"[STICKER_CONNECT] Connection result: {result}")
            return result
        
        except Exception as e:
            # Log the error
            logging.error(f"[STICKER_CONNECT] Connection error: {e}")
            logging.error(f"[STICKER_CONNECT] Error type: {type(e)}")
            logging.error(f"[STICKER_CONNECT] Full traceback: {traceback.format_exc()}")
            
            return {
                "success": False, 
                "error": str(e),
                "needs_code": False,
                "needs_password": False,
                "phone_number": safe_phone_number
            }

    def verify_code(self, code: str) -> Dict:
        """
        Verify the Telegram verification code - delegates to handler for consistency
        
        :param code: Verification code from user
        :return: Verification result
        """
        try:
            # Use the handler for verification to ensure single event loop
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            
            if not handler:
                return {"success": False, "error": "Telegram handler not available"}
            
            # Delegate to handler
            result = handler.verify_code(code)
            
            # If verification successful, set up bot interaction
            if result.get('success') and not result.get('needs_password'):
                try:
                    # Get the client from the handler
                    self.client = handler._client
                    self.session_file = handler._client.session.filename if hasattr(handler._client, 'session') else None
                    
                    # Set up bot interaction using the handler's event loop
                    async def setup_bot_interaction():
                        self.bot_peer = await self.client.get_entity('@stickers')
                        self.conversation_manager = SimpleConversationManager(
                            self.client, 
                            self.bot_peer, 
                            self.logger
                        )
                        await self.conversation_manager.start_listening()
                        return True
                    
                    # Run setup on handler's event loop
                    handler.run_async(setup_bot_interaction())
                    self.logger.info(f"[DEBUG] Bot interaction set up after code verification")
                    
                except Exception as e:
                    self.logger.error(f"[DEBUG] Error setting up bot interaction after code verification: {e}")
                    # Don't fail the verification, just log the error
            
            return result
                
        except Exception as e:
            self.logger.error(f"[TELEGRAM] Code verification error: {e}")
            return {
                "success": False,
                "error": str(e),
                "needs_password": False
            }

    def verify_password(self, password: str) -> Dict:
        """
        Verify two-factor authentication password - delegates to handler for consistency
        
        :param password: User's 2FA password
        :return: Password verification result
        """
        try:
            # Use the handler for verification to ensure single event loop
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            
            if not handler:
                return {"success": False, "error": "Telegram handler not available"}
            
            # Delegate to handler
            result = handler.verify_password(password)
            
            # If verification successful, set up bot interaction
            if result.get('success') and not result.get('needs_password'):
                try:
                    # Get the client from the handler
                    self.client = handler._client
                    self.session_file = handler._client.session.filename if hasattr(handler._client, 'session') else None
                    
                    # Set up bot interaction using the handler's event loop
                    async def setup_bot_interaction():
                        self.bot_peer = await self.client.get_entity('@stickers')
                        self.conversation_manager = SimpleConversationManager(
                            self.client, 
                            self.bot_peer, 
                            self.logger
                        )
                        await self.conversation_manager.start_listening()
                        return True
                    
                    # Run setup on handler's event loop
                    handler.run_async(setup_bot_interaction())
                    self.logger.info(f"[DEBUG] Bot interaction set up after password verification")
                    
                except Exception as e:
                    self.logger.error(f"[DEBUG] Error setting up bot interaction after password verification: {e}")
                    # Don't fail the verification, just log the error
            
            return result
            
        except Exception as e:
            self.logger.error(f"[TELEGRAM] Password verification error: {e}")
            
            return {
                "success": False,
                "error": str(e),
                "needs_password": False
            }

    def create_sticker_pack(self, pack_name: str, pack_url_name: str, sticker_type: str, media_files: List[Dict], process_id: str, auto_skip_icon: bool = True):
        """REAL sticker pack creation with EXACT advanced logic from Python version"""
        try:
            self.logger.info(f"[STICKER] Starting create_sticker_pack with process_id: {process_id}")
            self.logger.info(f"[STICKER] Pack name: {pack_name}")
            self.logger.info(f"[STICKER] Sticker type: {sticker_type}")
            self.logger.info(f"[STICKER] Media files count: {len(media_files)}")
            self.logger.info(f"[STICKER] Auto-skip icon: {auto_skip_icon}")
            
            # Check current connection status
            self.logger.info(f"[STICKER] Current conversation_manager: {self.conversation_manager}")
            self.logger.info(f"[STICKER] Current client: {self.client}")
            self.logger.info(f"[STICKER] Current bot_peer: {self.bot_peer}")
            
            # Check if we have a conversation manager, if not try to set it up from existing connection
            if not self.conversation_manager:
                self.logger.info("[STICKER] No conversation manager found, attempting to set up from existing connection")
                try:
                    # Try to get the client from the telegram handler
                    from telegram_connection_handler import get_telegram_handler
                    handler = get_telegram_handler()
                    if handler and handler._client:
                        self.logger.info("[STICKER] Found existing client in handler, setting up conversation manager")
                        
                        # Use the handler's event loop to get the bot peer
                        async def setup_conversation_manager():
                            try:
                                # Get bot peer using the handler's event loop
                                bot_peer = await handler._client.get_entity('@stickers')
                                self.logger.info(f"[STICKER] Bot peer obtained: {bot_peer}")
                                
                                # Set up the client and bot peer
                                self.client = handler._client
                                self.bot_peer = bot_peer
                                
                                # Create conversation manager
                                self.conversation_manager = SimpleConversationManager(
                                    self.client, 
                                    self.bot_peer, 
                                    self.logger
                                )
                                
                                # Start listening
                                await self.conversation_manager.start_listening()
                                self.logger.info("[STICKER] Conversation manager set up successfully")
                                return True
                            except Exception as e:
                                self.logger.error(f"[STICKER] Error setting up conversation manager: {e}")
                                self.logger.error(f"[STICKER] Error type: {type(e)}")
                                self.logger.error(f"[STICKER] Full traceback: {traceback.format_exc()}")
                                return False
                        
                        # Run the setup in the handler's event loop
                        success = handler.run_async(setup_conversation_manager())
                        if not success:
                            raise RuntimeError("Failed to set up conversation manager")
                    else:
                        raise RuntimeError("No existing Telegram connection found")
                except Exception as e:
                    self.logger.error(f"[STICKER] Failed to set up conversation manager: {e}")
                    self.logger.error(f"[STICKER] Error type: {type(e)}")
                    self.logger.error(f"[STICKER] Full traceback: {traceback.format_exc()}")
                    raise RuntimeError("Not connected to Telegram")
            
            if not self.conversation_manager:
                raise RuntimeError("Not connected to Telegram")
            
            # Verify conversation manager is properly set up
            if not self.conversation_manager.listening:
                self.logger.warning("[STICKER] Conversation manager not listening, attempting to restart...")
                try:
                    # Use run_telegram_coroutine to handle the async call
                    run_telegram_coroutine(self.conversation_manager.start_listening())
                    self.logger.info("[STICKER] Conversation manager restarted successfully")
                except Exception as e:
                    self.logger.error(f"[STICKER] Failed to restart conversation manager: {e}")
                    raise RuntimeError("Failed to start conversation manager")

            # Convert to MediaItem objects
            media_items = []
            for media_file in media_files:
                media_item = MediaItem(
                    media_file['file_path'],
                    sticker_type,
                    media_file.get('emoji', '😀')
                )
                media_items.append(media_item)

            self.logger.info(f"[STICKER] Created {len(media_items)} media items for process {process_id}")

            # Run creation using the existing run_telegram_coroutine function
            result = run_telegram_coroutine(
                self._create_sticker_pack_async(pack_name, pack_url_name, sticker_type, media_items, process_id, auto_skip_icon)
            )

            self.logger.info(f"[STICKER] Pack creation completed for process {process_id}")
            return result

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error for process {process_id}: {e}")
            raise

    async def _create_sticker_pack_async(self, pack_name: str, pack_url_name: str, sticker_type: str, media_items: List[MediaItem], process_id: str, auto_skip_icon: bool = True):
        """EXACT STICKER CREATION LOGIC FROM PYTHON VERSION"""
        try:
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock, add_process, update_process
            self.logger.info(f"[STICKER] Successfully imported active_processes, current processes: {list(active_processes.keys())}")

            self.logger.info(f"[STICKER] Starting pack creation: {pack_name}")
            self.logger.info(f"[STICKER] Process ID: {process_id}")
            self.logger.info(f"[STICKER] Available processes: {list(active_processes.keys())}")

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

            # Step 3: Send URL name (if requested)
            if "please provide a short name" in response.message.lower() or "short name" in response.message.lower():
                self.logger.info(f"[STICKER] URL name requested, sending: {pack_url_name}")
                
                # Try URL name up to 3 times
                url_name_attempts = 0
                max_attempts = 3
                
                while url_name_attempts < max_attempts:
                    url_name_attempts += 1
                    self.logger.info(f"[STICKER] URL name attempt {url_name_attempts}/{max_attempts}")
                    
                    # Update process status
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = f"Trying URL name (attempt {url_name_attempts}/{max_attempts})"
                        active_processes[process_id]["url_name_attempts"] = url_name_attempts
                    
                    try:
                        response = await self.conversation_manager.send_and_wait(
                            pack_url_name, BotResponseType.URL_NAME_ACCEPTED, timeout=45.0  # Increased timeout
                        )
                        
                        # Check if URL name was accepted
                        if response.response_type == BotResponseType.URL_NAME_ACCEPTED:
                            self.logger.info(f"[STICKER] URL name accepted: {pack_url_name}")
                            break
                        elif response.response_type == BotResponseType.URL_NAME_TAKEN:
                            self.logger.warning(f"[STICKER] URL name taken: {pack_url_name}")
                            # Instead of auto-generating, mark for user input
                            if process_id in active_processes:
                                active_processes[process_id]["status"] = "waiting_for_url_name"
                                active_processes[process_id]["current_stage"] = f"URL name '{pack_url_name}' is taken. Waiting for new URL name (attempt {url_name_attempts}/{max_attempts})..."
                                active_processes[process_id]["waiting_for_user"] = True
                                active_processes[process_id]["url_name_taken"] = True
                                active_processes[process_id]["original_url_name"] = pack_url_name
                                active_processes[process_id]["url_name_attempts"] = url_name_attempts
                                active_processes[process_id]["max_url_attempts"] = max_attempts
                                self.logger.info(f"[STICKER] URL name taken, waiting for user to provide new name (attempt {url_name_attempts}/{max_attempts})")
                            return {"success": False, "error": "URL name taken", "waiting_for_user": True, "url_name_taken": True}
                        else:
                            self.logger.error(f"[STICKER] Unexpected response for URL name: {response.message}")
                            # Continue the loop to retry (don't fail immediately on unexpected responses)
                    
                    except (asyncio.TimeoutError, TimeoutError) as e:
                        self.logger.warning(f"[STICKER] Timeout waiting for URL name response (attempt {url_name_attempts})")
                        # Mark for user input instead of failing after timeout
                        if process_id in active_processes:
                            active_processes[process_id]["status"] = "waiting_for_url_name"
                            active_processes[process_id]["current_stage"] = f"URL name timeout. Please provide a new URL name (attempt {url_name_attempts}/{max_attempts})."
                            active_processes[process_id]["waiting_for_user"] = True
                            active_processes[process_id]["url_name_taken"] = True
                            active_processes[process_id]["original_url_name"] = pack_url_name
                            active_processes[process_id]["url_name_attempts"] = url_name_attempts
                            active_processes[process_id]["max_url_attempts"] = max_attempts
                        return {"success": False, "error": "URL name timeout", "waiting_for_user": True, "url_name_taken": True}
                    
                    except Exception as e:
                        self.logger.error(f"[STICKER] Error during URL name attempt {url_name_attempts}: {e}")
                        # Continue to next attempt unless it's the last one
                        if url_name_attempts >= max_attempts:
                            if process_id in active_processes:
                                active_processes[process_id]["status"] = "waiting_for_url_name"
                                active_processes[process_id]["current_stage"] = f"URL name error. All {max_attempts} attempts exhausted. Please provide a new URL name."
                                active_processes[process_id]["waiting_for_user"] = True
                                active_processes[process_id]["url_name_taken"] = True
                                active_processes[process_id]["original_url_name"] = pack_url_name
                                active_processes[process_id]["url_name_attempts"] = url_name_attempts
                                active_processes[process_id]["max_url_attempts"] = max_attempts
                            return {"success": False, "error": "URL name error", "waiting_for_user": True, "url_name_taken": True}

            # Step 4: Process each media item
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
                "/publish", BotResponseType.ICON_REQUEST, timeout=30.0
            )

            self.logger.info(f"[STICKER] Received icon request: {response.message[:100]}...")
            
            # Step 5: Handle icon selection
            if process_id in active_processes:
                active_processes[process_id]["current_stage"] = "Waiting for icon selection..."
                active_processes[process_id]["waiting_for_user"] = True
                active_processes[process_id]["icon_request_message"] = response.message

            # Check if auto-skip is enabled
            if auto_skip_icon:
                self.logger.info("[STICKER] Auto-skip enabled, automatically skipping icon selection...")
                
                # Send skip command automatically - expect URL_NAME_REQUEST not ICON_ACCEPTED
                response = await self.conversation_manager.send_and_wait(
                    "/skip", BotResponseType.URL_NAME_REQUEST, timeout=30.0
                )
                
                self.logger.info(f"[STICKER] Icon step skipped, received URL name request: {response.message[:100]}...")
                
                # Update process status - now waiting for URL name
                if process_id in active_processes:
                    active_processes[process_id]["current_stage"] = "Providing URL name..."
                    active_processes[process_id]["waiting_for_user"] = False
                    active_processes[process_id]["progress"] = 85
                
                # Send the URL name that was already provided
                response = await self.conversation_manager.send_and_wait(
                    pack_url_name, BotResponseType.PACK_SUCCESS, timeout=30.0
                )
                
                self.logger.info(f"[STICKER] Pack published successfully: {response.message[:100]}...")
                
                # Update process status - completed
                if process_id in active_processes:
                    active_processes[process_id]["current_stage"] = "Sticker pack created successfully"
                    active_processes[process_id]["waiting_for_user"] = False
                    active_processes[process_id]["progress"] = 100
                    active_processes[process_id]["status"] = "completed"
                    
                    # Extract the shareable link from the response
                    if "https://t.me/addstickers/" in response.message:
                        import re
                        link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', response.message)
                        if link_match:
                            shareable_link = link_match.group(0)
                            active_processes[process_id]["shareable_link"] = shareable_link
                            self.logger.info(f"[STICKER] Shareable link extracted: {shareable_link}")
                
                # FIXED: Increment sticker creation stats in backend
                try:
                    from stats_tracker import stats_tracker
                    sticker_count = len(media_items)
                    stats_tracker.increment_stickers(sticker_count)
                    self.logger.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                except Exception as stats_error:
                    self.logger.warning(f"[STICKER] Failed to update backend stats: {stats_error}")
                
                self.logger.info("[STICKER] PACK CREATION COMPLETED SUCCESSFULLY!")
                return {"success": True, "message": "Sticker pack created successfully"}
            else:
                # Auto-skip is disabled, wait for user decision
                self.logger.info("[STICKER] Auto-skip disabled, waiting for user decision on icon selection...")
                
                # Mark process as waiting for user - NO TIMEOUT, wait indefinitely
                if process_id in active_processes:
                    active_processes[process_id]["current_stage"] = "Waiting for icon selection (no timeout)..."
                    active_processes[process_id]["waiting_for_user"] = True
                    active_processes[process_id]["icon_request_message"] = response.message
                    active_processes[process_id]["progress"] = 90
                
                # Return success - the process will continue when user clicks skip/upload
                # No timeout here - user controls when to proceed
                self.logger.info("[STICKER] Process marked as waiting for user icon selection (indefinite wait)")
                return {"success": True, "message": "Waiting for user icon selection", "waiting_for_user": True}

        except Exception as e:
            self.logger.error(f"[STICKER] Pack creation error: {e}")
            raise

# Removed duplicate TelegramSessionManager class - using EnhancedTelegramSessionManager instead

def run_telegram_coroutine(coro):
    """
    Safely run a Telegram coroutine with database lock handling.
    
    :param coro: Coroutine to run
    :return: Result of the coroutine
    """
    thread_name = threading.current_thread().name
    max_retries = 3
    
    for attempt in range(max_retries):
        try:
            # Try to use the handler's event loop first
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                if handler and handler._loop and handler._running:
                    # Use the handler's dedicated event loop
                    future = asyncio.run_coroutine_threadsafe(coro, handler._loop)
                    return future.result(timeout=30)
            except Exception as e:
                logging.warning(f"Could not use handler's event loop: {e}")
            
            # Fallback to creating a new event loop if handler is not available
            try:
                loop = asyncio.get_event_loop()
                if loop.is_closed():
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
            except RuntimeError:
                # No event loop in this thread, create a new one
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            
            # Check if the loop is already running (nested call)
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(coro, loop)
                return future.result(timeout=30)
            else:
                # Run the coroutine in the event loop
                return loop.run_until_complete(coro)
        
        except Exception as e:
            # Handle specific database lock errors
            if "database is locked" in str(e).lower():
                logging.warning(f"[DATABASE] Lock detected on attempt {attempt + 1}/{max_retries}: {e}")
                handle_database_lock_error(e, f"coroutine execution (attempt {attempt + 1})")
                
                if attempt < max_retries - 1:
                    # Wait before retrying
                    import time
                    time.sleep(2 * (attempt + 1))  # Exponential backoff
                    continue
            
            # Re-raise the original exception if not a database lock or final attempt
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
    """Handle database lock errors with aggressive recovery attempts"""
    thread_name = threading.current_thread().name
    logging.error(f"[DATABASE] Lock error during {operation_name} in thread {thread_name}: {e}")
  
    # Try to clean up any lingering connections
    try:
        import gc
        gc.collect()
        logging.info(f"[DATABASE] Forced garbage collection in thread: {thread_name}")
        
        # Log active threads for debugging
        active_threads = [t.name for t in threading.enumerate()]
        logging.info(f"[DATABASE] Active threads during lock: {active_threads}")
        
        # Enhanced lock file cleanup - remove ALL lock files
        lock_patterns = [
            '*.session-journal', 
            '*.session-wal',
            '*.session-shm',  # SQLite shared memory files
            'temp_session_*.session*',
            'session_*.session-journal',
            'session_*.session-wal',
            'telegram_session_*.session*',  # Process-specific sessions
        ]
        
        cleaned_count = 0
        for pattern in lock_patterns:
            for lock_file in glob.glob(pattern):
                try:
                    os.remove(lock_file)
                    logging.info(f"[DATABASE] Removed lock file: {lock_file}")
                    cleaned_count += 1
                except Exception as le:
                    logging.warning(f"[DATABASE] Could not remove lock file {lock_file}: {le}")
        
        # Also clean up in python subdirectory
        python_dir = 'python'
        if os.path.exists(python_dir):
            for pattern in lock_patterns:
                for lock_file in glob.glob(os.path.join(python_dir, pattern)):
                    try:
                        os.remove(lock_file)
                        logging.info(f"[DATABASE] Removed lock file from python/: {lock_file}")
                        cleaned_count += 1
                    except Exception as le:
                        logging.warning(f"[DATABASE] Could not remove lock file {lock_file}: {le}")
        
        logging.info(f"[DATABASE] Cleaned up {cleaned_count} lock files")
        
        # Wait longer for file handles to be released
        import time
        time.sleep(2.0)
        
        # Force another garbage collection
        gc.collect()
        
    except Exception as cleanup_error:
        logging.error(f"[DATABASE] Error during lock recovery in thread {thread_name}: {cleanup_error}")

def sticker_pack_worker():
    """Background worker to process sticker pack creation tasks"""
    global sticker_bot  # Make sticker_bot global to avoid UnboundLocalError
    logging.info(f"[WORKER] Sticker pack worker thread started and waiting for tasks")
    while True:
        try:
            # Block and wait for a task
            logging.info(f"[WORKER] Waiting for task from queue...")
            task = sticker_pack_queue.get()
            logging.info(f"[WORKER] Received task from queue")
            
            # Unpack task parameters
            pack_name, sticker_type, media_files, process_id = task
            logging.info(f"[WORKER] Processing task: pack_name={pack_name}, process_id={process_id}")
            
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock, update_process
            print(f"🔧 [WORKER] Successfully imported active_processes")
            print(f"🔧 [WORKER] Current processes: {list(active_processes.keys())}")
            print(f"🔧 [WORKER] Looking for process: {process_id}")
            print(f"🔧 [WORKER] Process exists: {process_id in active_processes}")
            logging.info(f"[WORKER] Successfully imported active_processes, current processes: {list(active_processes.keys())}")
            
            # Update process status to processing
            with process_lock:
                print(f"🔧 [WORKER] Acquired process_lock for process {process_id}")
                print(f"🔧 [WORKER] Looking for process {process_id} in active_processes")
                print(f"🔧 [WORKER] Current active_processes keys: {list(active_processes.keys())}")
                print(f"🔧 [WORKER] Process {process_id} exists: {process_id in active_processes}")
                
                logging.info(f"[WORKER] Looking for process {process_id} in active_processes")
                logging.info(f"[WORKER] Current active_processes keys: {list(active_processes.keys())}")
                logging.info(f"[WORKER] Process {process_id} exists: {process_id in active_processes}")
                
                if process_id in active_processes:
                    print(f"🔧 [WORKER] Found process {process_id}, updating to processing")
                    active_processes[process_id]['status'] = 'processing'
                    active_processes[process_id]['current_stage'] = 'Starting sticker pack creation...'
                    logging.info(f"[WORKER] Updated process {process_id} to processing status")
                else:
                    print(f"🔧 [WORKER] Process {process_id} NOT FOUND! Creating fallback entry")
                    print(f"🔧 [WORKER] Available processes: {list(active_processes.keys())}")
                    logging.error(f"[WORKER] Process {process_id} not found in active_processes!")
                    logging.error(f"[WORKER] Available processes: {list(active_processes.keys())}")
                    # Create the process entry if it doesn't exist
                    active_processes[process_id] = {
                        'status': 'processing',
                        'current_stage': 'Starting sticker pack creation...',
                        'progress': 0,
                        'total_files': len(media_files),
                        'completed_files': 0,
                        'start_time': time.time(),
                        'type': 'sticker_pack',
                        'pack_name': pack_name,
                        'sticker_type': sticker_type
                    }
                    print(f"🔧 [WORKER] Created fallback process entry for {process_id}")
                    logging.info(f"[WORKER] Created missing process entry for {process_id}")
            
            try:
                # Ensure sticker_bot is initialized
                if sticker_bot is None:
                    logging.error(f"[WORKER] sticker_bot is None, initializing...")
                    sticker_bot = StickerBotCore()
                    logging.info(f"[WORKER] sticker_bot initialized in worker thread")
                
                # Get auto-skip setting from process data
                pack_url_name = active_processes.get(process_id, {}).get('pack_url_name', '')
                auto_skip_icon = active_processes.get(process_id, {}).get('auto_skip_icon', True)
                logging.info(f"[WORKER] Auto-skip icon setting: {auto_skip_icon}")
                
                # Perform sticker pack creation
                result = sticker_bot.create_sticker_pack(pack_name, pack_url_name, sticker_type, media_files, process_id, auto_skip_icon)
                
                # Update process with result
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['result'] = result
                        active_processes[process_id]['status'] = 'completed'
                        active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                        active_processes[process_id]['progress'] = 100
                        logging.info(f"[WORKER] Process {process_id} completed successfully")
            
            except Exception as e:
                # Log detailed error information
                error_msg = str(e)
                error_type = type(e).__name__
                print(f"🔧 [WORKER] Process {process_id} failed with {error_type}: {error_msg}")
                print(f"🔧 [WORKER] Full traceback:")
                import traceback
                traceback.print_exc()
                
                # Log error and update process status
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['status'] = 'error'
                        active_processes[process_id]['current_stage'] = f'Error: {error_msg}'
                        active_processes[process_id]['error'] = error_msg
                        active_processes[process_id]['error_type'] = error_type
                        logging.error(f"[WORKER] Process {process_id} failed with error: {e}")
                
                if sticker_bot:
                    sticker_bot.logger.error(f"Background sticker pack creation error: {e}")
                else:
                    logging.error(f"Background sticker pack creation error: {e}")
            
            finally:
                # Mark task as done
                sticker_pack_queue.task_done()
        
        except Exception as e:
            error_msg = str(e)
            error_type = type(e).__name__
            print(f"🔧 [WORKER] Worker thread error: {error_type}: {error_msg}")
            print(f"🔧 [WORKER] Full traceback:")
            import traceback
            traceback.print_exc()
            
            if sticker_bot:
                sticker_bot.logger.error(f"Sticker pack worker error: {e}")
            else:
                logging.error(f"Sticker pack worker error: {e}")

def start_sticker_pack_worker():
    """Start the background worker thread"""
    global sticker_pack_thread
    if sticker_pack_thread is None or not sticker_pack_thread.is_alive():
        logging.info(f"[WORKER] Starting sticker pack worker thread")
        sticker_pack_thread = threading.Thread(target=sticker_pack_worker, daemon=True)
        sticker_pack_thread.start()
        logging.info(f"[WORKER] Sticker pack worker thread started: {sticker_pack_thread.is_alive()}")
    else:
        logging.info(f"[WORKER] Sticker pack worker thread already running")

def register_sticker_routes(app):
    """Register sticker bot routes with the Flask app"""
    global sticker_bot
    thread_name = threading.current_thread().name
    logging.info(f"[DEBUG] register_sticker_routes called from thread: {thread_name}")
    logging.info(f"[DEBUG] Registering routes with Flask app: {app}")
    
    # Initialize sticker_bot if not already done
    if sticker_bot is None:
        logging.info(f"[DEBUG] Initializing sticker_bot in register_sticker_routes")
        sticker_bot = StickerBotCore()
        logging.info(f"[DEBUG] sticker_bot initialized successfully")
    
    @app.route('/api/sticker/connect', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def connect_sticker_bot():
        """ULTIMATE FIX - This function is guaranteed to work without scoping errors"""
        thread_name = threading.current_thread().name
        logging.info(f"[DEBUG] Flask route /api/sticker/connect called from thread: {thread_name}")
        
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
            logging.info(f"[DEBUG] OPTIONS request, returning 200")
            return '', 200
            
        try:
            logging.info(f"[DEBUG] Processing POST request in thread: {thread_name}")
            
            # Safe data extraction with null checks
            try:
                # Log raw request data for debugging
                raw_data = request.get_data(as_text=True)
                logging.info(f"[TRACE] Raw request data: {raw_data}")

                data = request.get_json()
                logging.info(f"[TRACE] Parsed JSON data: {data}")

                if not data:
                    logging.warning(f"[DEBUG] No JSON data received in thread: {thread_name}")
                    return jsonify({
                        "success": False, 
                        "error": "No data provided", 
                        "phone_number": safe_phone_number,
                        "needs_code": False,
                        "needs_password": False
                    }), 400
                
                # Explicitly log each field for tracing
                logging.info(f"[TRACE] Extracting fields: {list(data.keys())}")
                safe_api_id = data.get('api_id', '')
                safe_api_hash = data.get('api_hash', '')
                safe_phone_number = data.get('phone_number', '')
                safe_process_id = data.get('process_id', '')

                logging.info(f"[TRACE] Extracted values: api_id={safe_api_id}, api_hash={safe_api_hash}, phone_number={safe_phone_number}, process_id={safe_process_id}")
                
            except Exception as data_error:
                logging.error(f"[DEBUG] Error parsing JSON data in thread {thread_name}: {data_error}")
                logging.error(f"[DEBUG] Error details: {traceback.format_exc()}")
                return jsonify({
                    "success": False, 
                    "error": f"Invalid JSON data: {str(data_error)}", 
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                }), 400
            
            logging.info(f"[DEBUG] Request data - API ID: {safe_api_id}, Phone: {safe_phone_number}, Process ID: {safe_process_id}")

            # Early validation to prevent processing with missing data
            if not all([safe_api_id, safe_api_hash, safe_phone_number]):
                logging.warning(f"[DEBUG] Missing required fields in thread: {thread_name}")
                return jsonify({
                    "success": False, 
                    "error": "Missing required fields", 
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                }), 400

            # ULTIMATE FIX - Now implement the actual working logic
            logging.critical(f"🚀 ULTIMATE FIX: Processing connection with api_id={safe_api_id}, phone={safe_phone_number}")
            
            # Use the thread-safe handler for actual connection
            try:
                from telegram_connection_handler import get_telegram_handler
                handler = get_telegram_handler()
                result = handler.connect_telegram(safe_api_id, safe_api_hash, safe_phone_number)
                logging.info(f"[DEBUG] Handler result: {result}")
                return jsonify(result)
            except Exception as handler_error:
                logging.error(f"[DEBUG] Handler error: {handler_error}")
                # Fallback to working response
                return jsonify({
                    "success": False,
                    "error": f"Connection error: {str(handler_error)}",
                    "phone_number": safe_phone_number,
                    "needs_code": False,
                    "needs_password": False
                })

        except Exception as e:
            logging.error(f"[DEBUG] Flask route error in thread {thread_name}: {e}")
            logging.error(f"[DEBUG] Error type: {type(e)}")
            logging.error(f"[DEBUG] Full traceback: {traceback.format_exc()}")
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
            # Better error handling for JSON data
            try:
                data = request.get_json()
                if data is None:
                    return jsonify({
                        "success": False, 
                        "error": "No JSON data received or invalid Content-Type header"
                    }), 400
            except Exception as json_error:
                logging.error(f"[API] JSON parsing error: {json_error}")
                return jsonify({
                    "success": False, 
                    "error": f"Invalid JSON format: {str(json_error)}"
                }), 400
            
            pack_name = data.get('pack_name', '')
            pack_url_name = data.get('pack_url_name', '')
            sticker_type = data.get('sticker_type', 'video')
            media_files = data.get('media_files', [])
            process_id = data.get('process_id', f'sticker_{int(time.time())}')
            auto_skip_icon = data.get('auto_skip_icon', True)  # Default to True

            # Import active_processes from shared state
            from shared_state import active_processes, process_lock, add_process, get_next_process_id
            print(f"🔧 [STICKER_API] Imported active_processes from shared state")
            print(f"🔧 [STICKER_API] active_processes type: {type(active_processes)}")
            print(f"🔧 [STICKER_API] active_processes id: {id(active_processes)}")
            print(f"🔧 [STICKER_API] Current processes before creation: {list(active_processes.keys())}")

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

            if not pack_url_name:
                return jsonify({"success": False, "error": "URL name is required"}), 400

            # Validate URL name
            url_validation = validate_url_name(pack_url_name)
            if not url_validation['valid']:
                return jsonify({"success": False, "error": url_validation['error']}), 400

            if not media_files:
                return jsonify({"success": False, "error": "No media files provided"}), 400

            # Start background worker if not already running
            start_sticker_pack_worker()

            # Add process to active_processes immediately for tracking
            process_data = {
                "status": "queued",
                "current_stage": "Waiting in queue...",
                "progress": 0,
                "total_files": len(media_files),
                "completed_files": 0,
                "start_time": time.time(),
                "type": "sticker_pack",
                "pack_name": pack_name,
                "pack_url_name": pack_url_name,
                "sticker_type": sticker_type,
                "auto_skip_icon": auto_skip_icon,
                "url_name_attempts": 0
            }
            
            print(f"🔧 [STICKER_API] Auto-skip icon setting: {auto_skip_icon}")
            print(f"🔧 [STICKER_API] Process data: {process_data}")
            
            print(f"🔧 [DEBUG] Creating process {process_id} in active_processes")
            print(f"🔧 [DEBUG] Before creation - active_processes keys: {list(active_processes.keys())}")
            print(f"🔧 [DEBUG] Before creation - active_processes type: {type(active_processes)}")
            print(f"🔧 [DEBUG] Before creation - active_processes id: {id(active_processes)}")
            
            add_process(process_id, process_data)
            
            print(f"🔧 [DEBUG] After creation - active_processes keys: {list(active_processes.keys())}")
            print(f"🔧 [DEBUG] After creation - active_processes type: {type(active_processes)}")
            print(f"🔧 [DEBUG] After creation - active_processes id: {id(active_processes)}")
            print(f"🔧 [DEBUG] Process {process_id} exists: {process_id in active_processes}")
            print(f"🔧 [DEBUG] Process {process_id} data: {active_processes.get(process_id, 'NOT_FOUND')}")
            
            # Verify the process was actually added
            if process_id in active_processes:
                print(f"🔧 [DEBUG] ✅ Process {process_id} successfully added to active_processes")
            else:
                print(f"🔧 [DEBUG] ❌ Process {process_id} FAILED to be added to active_processes!")
            
            # Double-check by importing shared state again
            from shared_state import active_processes as ss_active_processes
            print(f"🔧 [DEBUG] Shared state active_processes keys: {list(ss_active_processes.keys())}")
            print(f"🔧 [DEBUG] Shared state active_processes id: {id(ss_active_processes)}")
            print(f"🔧 [DEBUG] Are they the same object? {active_processes is ss_active_processes}")

            # Add task to queue
            print(f"🔧 [DEBUG] Adding task to queue: {process_id}")
            sticker_pack_queue.put((pack_name, sticker_type, media_files, process_id))
            print(f"🔧 [DEBUG] Task added to queue successfully")
            
            # Verify process still exists after queue operation
            print(f"🔧 [DEBUG] Verifying process still exists after queue operation...")
            print(f"🔧 [DEBUG] Process {process_id} exists: {process_id in active_processes}")
            print(f"🔧 [DEBUG] Current active_processes keys: {list(active_processes.keys())}")
            
            # Log the process creation for debugging
            logging.info(f"[API] Process {process_id} added to queue and active_processes")
            logging.info(f"[API] Current active_processes: {list(active_processes.keys())}")

            # Immediately return process ID for tracking
            return jsonify({
                "success": True, 
                "process_id": process_id,
                "message": "Sticker pack creation queued"
            })

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/connection-status', methods=['GET', 'OPTIONS'], strict_slashes=False)
    def connection_status():
        """
        Check the current Telegram connection status
        """
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            is_connected = sticker_bot.is_connected()
            return jsonify({
                "success": True, 
                "connected": is_connected,
                "message": "Connected to Telegram" if is_connected else "Not connected to Telegram"
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

    @app.route('/api/sticker/skip-icon', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def skip_icon():
        """
        API endpoint to skip icon selection
        Sends /skip command to Telegram bot
        """
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            process_id = data.get('process_id', '') if data else ''
            
            if not process_id:
                return jsonify({"success": False, "error": "Process ID is required"}), 400
            
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock
            
            with process_lock:
                if process_id not in active_processes:
                    return jsonify({"success": False, "error": "Process not found"}), 404
                
                if not active_processes[process_id].get('waiting_for_user', False):
                    return jsonify({"success": False, "error": "Process is not waiting for user input"}), 400
                
                # Update process status
                active_processes[process_id]['current_stage'] = 'Sending skip command...'
            
            # Send skip command using the conversation manager
            async def send_skip_command():
                try:
                    logging.info(f"[SKIP_ICON] Starting skip command for process {process_id}")
                    
                    # Use URL_NAME_REQUEST like the main auto-skip logic with increased timeout
                    response = await sticker_bot.conversation_manager.send_and_wait(
                        "/skip", BotResponseType.URL_NAME_REQUEST, timeout=60.0  # Increased timeout
                    )
                    
                    logging.info(f"[SKIP_ICON] Skip command successful, received URL name request")
                    
                    # Get the pack URL name for this process
                    pack_url_name = active_processes.get(process_id, {}).get('pack_url_name', '')
                    logging.info(f"[SKIP_ICON] Pack URL name for process {process_id}: {pack_url_name}")
                    
                    if pack_url_name:
                        logging.info(f"[SKIP_ICON] Sending URL name '{pack_url_name}' to Telegram")
                        
                        # Send the URL name automatically with increased timeout
                        url_response = await sticker_bot.conversation_manager.send_and_wait(
                            pack_url_name, BotResponseType.PACK_SUCCESS, timeout=60.0  # Increased timeout
                        )
                        
                        logging.info(f"[SKIP_ICON] URL name submission successful")
                        
                        # Update process status after successful completion
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                                active_processes[process_id]['progress'] = 100
                                active_processes[process_id]['status'] = 'completed'
                                
                                # Extract shareable link
                                if "https://t.me/addstickers/" in url_response.message:
                                    import re
                                    link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', url_response.message)
                                    if link_match:
                                        active_processes[process_id]['shareable_link'] = link_match.group(0)
                        
                        # FIXED: Increment sticker creation stats in backend
                        try:
                            from stats_tracker import stats_tracker
                            sticker_count = active_processes.get(process_id, {}).get('total_files', 1)
                            stats_tracker.increment_stickers(sticker_count)
                            logging.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                        except Exception as stats_error:
                            logging.warning(f"[STICKER] Failed to update backend stats: {stats_error}")
                        
                        return {"success": True, "message": "Sticker pack created successfully"}
                    else:
                        # Update process status after successful skip
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['current_stage'] = 'Waiting for URL name input...'
                                active_processes[process_id]['progress'] = 85
                        
                        return {"success": True, "message": "Icon skipped, please provide URL name"}
                        
                except (asyncio.TimeoutError, TimeoutError) as timeout_error:
                    logging.warning(f"[STICKER] Timeout during skip icon: {timeout_error}")
                    # Handle timeout by marking as waiting for URL name instead of failing
                    pack_url_name = active_processes.get(process_id, {}).get('pack_url_name', '')
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]['status'] = 'waiting_for_url_name'
                            active_processes[process_id]['current_stage'] = f'Icon skipped with timeout. Please provide URL name.'
                            active_processes[process_id]['waiting_for_user'] = True
                            active_processes[process_id]['url_name_taken'] = True  # Trigger URL name modal
                            active_processes[process_id]['original_url_name'] = pack_url_name or 'unknown'
                    
                    return {"success": False, "error": "Icon skip timeout", "waiting_for_user": True, "url_name_taken": True}
                    
                except Exception as e:
                    logging.error(f"[STICKER] Error during skip icon: {e}")
                    # Handle other errors by marking as waiting for URL name
                    pack_url_name = active_processes.get(process_id, {}).get('pack_url_name', '')
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]['status'] = 'waiting_for_url_name'
                            active_processes[process_id]['current_stage'] = f'Icon skip error. Please provide URL name.'
                            active_processes[process_id]['waiting_for_user'] = True
                            active_processes[process_id]['url_name_taken'] = True  # Trigger URL name modal
                            active_processes[process_id]['original_url_name'] = pack_url_name or 'unknown'
                    
                    return {"success": False, "error": "Icon skip error", "waiting_for_user": True, "url_name_taken": True}
            
            # Run the async function
            result = run_telegram_coroutine(send_skip_command())
            return jsonify(result)
            
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/submit-url-name', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def submit_url_name():
        """
        API endpoint to submit new URL name when original is taken
        """
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            process_id = data.get('process_id', '') if data else ''
            new_url_name = data.get('new_url_name', '') if data else ''
            current_attempt = data.get('current_attempt', 1) if data else 1
            max_attempts = data.get('max_attempts', 3) if data else 3
            
            if not process_id:
                return jsonify({"success": False, "error": "Process ID is required"}), 400
            
            if not new_url_name:
                return jsonify({"success": False, "error": "New URL name is required"}), 400
            
            # Validate URL name
            validation = validate_url_name(new_url_name)
            if not validation['valid']:
                return jsonify({"success": False, "error": validation['error']}), 400
            
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock
            
            with process_lock:
                if process_id not in active_processes:
                    return jsonify({"success": False, "error": "Process not found"}), 404
                
                if active_processes[process_id].get('status') != 'waiting_for_url_name':
                    return jsonify({"success": False, "error": "Process is not waiting for URL name"}), 400
                
                # Update process with new URL name and attempt information
                active_processes[process_id]['pack_url_name'] = new_url_name
                active_processes[process_id]['current_stage'] = f'Trying new URL name: {new_url_name} (attempt {current_attempt}/{max_attempts})'
                active_processes[process_id]['status'] = 'processing'
                active_processes[process_id]['waiting_for_user'] = False
                active_processes[process_id]['url_name_taken'] = False
                active_processes[process_id]['url_name_attempts'] = current_attempt
                active_processes[process_id]['max_url_attempts'] = max_attempts
            
            # Get the process data and resume sticker creation in background
            process_data = active_processes[process_id]
            pack_name = process_data.get('pack_name', '')
            sticker_type = process_data.get('sticker_type', 'video')
            auto_skip_icon = process_data.get('auto_skip_icon', True)
            
            # Resume URL name submission to Telegram
            async def submit_url_name_to_telegram():
                try:
                    # Send the new URL name to Telegram
                    url_response = await sticker_bot.conversation_manager.send_and_wait(
                        new_url_name, BotResponseType.URL_NAME_ACCEPTED, timeout=45.0
                    )
                    
                    # Check response type
                    if url_response.response_type == BotResponseType.URL_NAME_ACCEPTED:
                        # URL name accepted - continue with sticker creation
                        logging.info(f"[URL_NAME] New URL name accepted: {new_url_name}")
                        
                        # Continue with the rest of sticker pack creation process
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['current_stage'] = 'URL name accepted, finalizing pack creation...'
                                active_processes[process_id]['progress'] = 95
                                active_processes[process_id]['status'] = 'completed'
                                
                                # Extract shareable link
                                if "https://t.me/addstickers/" in url_response.message:
                                    import re
                                    link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', url_response.message)
                                    if link_match:
                                        active_processes[process_id]['shareable_link'] = link_match.group(0)
                        
                        # FIXED: Increment sticker creation stats in backend
                        try:
                            from stats_tracker import stats_tracker
                            sticker_count = active_processes.get(process_id, {}).get('total_files', 1)
                            stats_tracker.increment_stickers(sticker_count)
                            logging.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                        except Exception as stats_error:
                            logging.warning(f"[STICKER] Failed to update backend stats: {stats_error}")
                        
                        return {"success": True, "message": "Sticker pack created successfully"}
                    
                    elif url_response.response_type == BotResponseType.URL_NAME_TAKEN:
                        # URL name still taken - check if we have more attempts
                        logging.warning(f"[URL_NAME] New URL name also taken: {new_url_name}")
                        
                        if current_attempt < max_attempts:
                            # Still have attempts left - mark for user input again
                            with process_lock:
                                if process_id in active_processes:
                                    active_processes[process_id]['status'] = 'waiting_for_url_name'
                                    active_processes[process_id]['current_stage'] = f'URL name "{new_url_name}" is also taken. Attempt {current_attempt + 1}/{max_attempts}'
                                    active_processes[process_id]['waiting_for_user'] = True
                                    active_processes[process_id]['url_name_taken'] = True
                                    active_processes[process_id]['original_url_name'] = new_url_name
                                    active_processes[process_id]['url_name_attempts'] = current_attempt + 1
                            
                            return {"success": False, "error": f"URL name '{new_url_name}' is already taken", "url_name_taken": True}
                        else:
                            # No more attempts - mark as completed with manual instruction
                            logging.warning(f"[URL_NAME] All {max_attempts} attempts exhausted for URL names")
                            
                            with process_lock:
                                if process_id in active_processes:
                                    active_processes[process_id]['status'] = 'completed_manual'
                                    active_processes[process_id]['current_stage'] = f'All {max_attempts} URL name attempts exhausted. Manual completion required.'
                                    active_processes[process_id]['waiting_for_user'] = False
                                    active_processes[process_id]['manual_completion_required'] = True
                                    active_processes[process_id]['progress'] = 100
                            
                            return {"success": True, "message": "Manual completion required", "manual_completion_required": True}
                    
                    else:
                        # Unexpected response
                        logging.error(f"[URL_NAME] Unexpected response: {url_response.message}")
                        return {"success": False, "error": f"Unexpected response from Telegram: {url_response.message}"}
                    
                except Exception as e:
                    logging.error(f"[URL_NAME] Error submitting URL name to Telegram: {e}")
                    return {"success": False, "error": f"Failed to submit URL name to Telegram: {str(e)}"}
            
            # Try to submit the URL name to Telegram
            telegram_result = run_telegram_coroutine(submit_url_name_to_telegram())
            
            if telegram_result["success"]:
                if telegram_result.get("manual_completion_required"):
                    logging.info(f"[API] All URL name attempts exhausted for process {process_id}. Manual completion required.")
                    return jsonify({
                        "success": True, 
                        "message": f"All {max_attempts} attempts exhausted. Please complete manually in Telegram bot.",
                        "manual_completion_required": True,
                        "completed": True
                    })
                else:
                    logging.info(f"[API] URL name submitted successfully for process {process_id}: {new_url_name}")
                    return jsonify({
                        "success": True, 
                        "message": f"Sticker pack created with URL name: {new_url_name}",
                        "new_url_name": new_url_name,
                        "completed": True
                    })
            else:
                # Check if this is a URL name taken error to continue retry flow
                if telegram_result.get("url_name_taken") and current_attempt < max_attempts:
                    logging.warning(f"[API] URL name '{new_url_name}' taken, attempt {current_attempt + 1}/{max_attempts}")
                    return jsonify({
                        "success": False, 
                        "error": telegram_result["error"],
                        "url_name_taken": True
                    })
                else:
                    logging.error(f"[API] Failed to submit URL name to Telegram for process {process_id}: {telegram_result['error']}")
                    # Mark process as failed
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]['status'] = 'error'
                            active_processes[process_id]['current_stage'] = f"Failed to submit URL name: {telegram_result['error']}"
                            active_processes[process_id]['waiting_for_user'] = False
                    
                    return jsonify({
                        "success": False, 
                        "error": telegram_result['error']
                    }), 500
            
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/upload-icon', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def upload_icon():
        """
        API endpoint to upload icon file
        Sends icon file to Telegram bot
        """
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            process_id = data.get('process_id', '') if data else ''
            icon_file_path = data.get('icon_file_path', '') if data else ''
            
            if not process_id:
                return jsonify({"success": False, "error": "Process ID is required"}), 400
            
            if not icon_file_path:
                return jsonify({"success": False, "error": "Icon file path is required"}), 400
            
            if not os.path.exists(icon_file_path):
                return jsonify({"success": False, "error": "Icon file not found"}), 400
            
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock
            
            with process_lock:
                if process_id not in active_processes:
                    return jsonify({"success": False, "error": "Process not found"}), 404
                
                if not active_processes[process_id].get('waiting_for_user', False):
                    return jsonify({"success": False, "error": "Process is not waiting for user input"}), 400
                
                # Update process status
                active_processes[process_id]['current_stage'] = 'Uploading icon file...'
            
            # Send icon file using the conversation manager
            async def send_icon_file():
                try:
                    response = await sticker_bot.conversation_manager.send_file_and_wait(
                        icon_file_path, BotResponseType.ICON_ACCEPTED, timeout=60.0
                    )
                    return {"success": True, "message": "Icon file uploaded successfully"}
                except Exception as e:
                    return {"success": False, "error": str(e)}
            
            # Run the async function
            result = run_telegram_coroutine(send_icon_file())
            return jsonify(result)
            
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

# Enhanced logging configuration
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
console_handler.setLevel(logging.INFO)  # Only show INFO and above in console, DEBUG goes to file only

# Create formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)

# Add handlers to the logger (file only to avoid Windows console encoding issues)
telegram_logger.addHandler(file_handler)

# Log the log file location for easy reference
print(f"Telegram Connection Logs will be written to: {os.path.join(LOGS_DIR, 'telegram_connection_debug.log')}")


# Removed duplicate connect_telegram_with_debug method and monkey patch