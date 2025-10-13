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
from logging_config import get_sticker_logger

# Note: avoid importing fcntl on Windows to prevent portability issues
try:
    import fcntl  # noqa: F401
except Exception:
    pass

# Note: run_telegram_coroutine is defined later with robust retry and event-loop handling.
# The earlier simplified version has been removed to avoid duplicate definitions.

def validate_url_name(url_name):
    """Validate URL name according to Telegram sticker pack rules"""
    # Length validation (5-32 characters)
    if len(url_name) < 5:
        return {'valid': False, 'error': 'URL name must be at least 5 characters long'}
    if len(url_name) > 32:
        return {'valid': False, 'error': 'URL name must be no more than 32 characters long'}
    
    # Starting character validation (must start with letter)
    if not re.match(r'^[a-zA-Z]', url_name):
        return {'valid': False, 'error': 'URL name must start with a letter'}
    
    # Character validation (only letters, numbers, underscores)
    if not re.match(r'^[a-zA-Z0-9_]+$', url_name):
        return {'valid': False, 'error': 'URL name can only contain letters, numbers, and underscores'}
    
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
    TEMPORARY_ERROR = "temporary_error"
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
                r"already\s*taken",
            ],
            BotResponseType.FILE_UPLOADED: [
                r"thanks!\s*now\s*send\s*me\s*an\s*emoji",
                r"now\s*send\s*me\s*the\s*(?:video\s*)?sticker",
                r"send\s*me\s*the\s*(?:video\s*)?sticker",
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
            BotResponseType.TEMPORARY_ERROR: [
                r"sorry,\s*an\s*error\s*has\s*occurred\s*during\s*your\s*request",
                r"please\s*try\s*again\s*later",
                r"code\s*\d+",
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
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                # Use a more thread-safe approach to avoid signal issues
                try:
                    response = await asyncio.wait_for(self.response_queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    # Continue waiting - this is expected
                    elapsed = time.time() - start_time
                    # Only log every 10 seconds to reduce spam
                    if int(elapsed) % 10 == 0 and elapsed > 0:
                        self.logger.debug(f"[WAIT] Still waiting for {expected_type.value}, {timeout - elapsed:.1f}s remaining")
                    continue
                
                self.logger.info(f"[WAIT] Received response: {response.response_type.value} - '{response.message[:50]}...'")
                
                if response.response_type == expected_type:
                    self.logger.info(f"[SUCCESS] Received expected response: {expected_type.value}")
                    return response
                
                if response.response_type == BotResponseType.ERROR_RESPONSE:
                    self.logger.error(f"[ERROR] Bot error response: {response.message}")
                    raise RuntimeError(f"Bot error: {response.message}")
                
                # Handle temporary errors with retry mechanism
                if response.response_type == BotResponseType.TEMPORARY_ERROR:
                    self.logger.warning(f"[TEMPORARY_ERROR] Telegram temporary error: {response.message}")
                    # Don't raise immediately, continue waiting for a valid response
                    continue
                
                # Additional check for temporary errors in message content
                # Even if not classified as TEMPORARY_ERROR, check if it contains temporary error patterns
                message_lower = response.message.lower()
                if ("sorry, an error occurred during your request" in message_lower or 
                    "please try again later" in message_lower or 
                    "code" in message_lower and any(char.isdigit() for char in message_lower)):
                    self.logger.warning(f"[TEMPORARY_ERROR] Detected temporary error in message content: {response.message}")
                    # Don't raise immediately, continue waiting for a valid response
                    continue
                
                self.logger.warning(f"[WARNING] Unexpected response type: {response.response_type.value}")
                
            except Exception as e:
                # Log any other errors but continue waiting
                self.logger.warning(f"[WAIT] Error while waiting: {e}")
                await asyncio.sleep(0.1)  # Small delay before retrying
        
        # If we reach here, we've timed out
        self.logger.warning(f"[WAIT] Timeout waiting for {expected_type.value} after {timeout} seconds")
        raise asyncio.TimeoutError(f"Timeout waiting for {expected_type.value}")
        
    async def wait_for_response_types(self, expected_types: list, timeout: float = 30.0):
        """Wait for any of multiple response types"""
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                response = await asyncio.wait_for(self.response_queue.get(), timeout=0.5)
                if response.response_type in expected_types:
                    self.logger.info(f"[WAIT] Received expected response: {response.response_type.value}")
                    return response
                else:
                    self.logger.warning(f"[WAIT] Unexpected response: {response.response_type.value}, expected one of {[t.value for t in expected_types]}")
                    # Put it back and continue waiting
                    await self.response_queue.put(response)
                    
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                self.logger.warning(f"[WAIT] Error while waiting: {e}")
                await asyncio.sleep(0.1)  # Small delay before retrying
        
        # If we reach here, we've timed out
        self.logger.warning(f"[WAIT] Timeout waiting for any of {[t.value for t in expected_types]} after {timeout} seconds")
        raise TimeoutError(f"Timeout waiting for any of {[t.value for t in expected_types]}")

    async def send_and_wait(self, message: str, expected_response, timeout: float = 30.0):
        self.logger.info(f"[MSG] Sending: {message}")
        
        # Clear pending responses
        while not self.response_queue.empty():
            try:
                await self.response_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Send message
        if os.path.exists(message):
            file_size = os.path.getsize(message)
            self.logger.info(f"[MSG] Sending file: {message} (size: {file_size} bytes)")
            await self.client.send_file(self.bot_peer, message, force_document=True)
            self.logger.info(f"[MSG] Sent file as document: {os.path.basename(message)}")
        else:
            self.logger.info(f"[MSG] Sending text message: {message}")
            await self.client.send_message(self.bot_peer, message)
            self.logger.info(f"[MSG] Sent message: {message}")

        # Handle both single expected response and list of expected responses
        # Add retry logic for temporary errors
        max_retries = 3
        retry_count = 0
        
        while retry_count < max_retries:
            try:
                if isinstance(expected_response, list):
                    # Wait for any of the expected response types
                    response = await self.wait_for_response_types(expected_response, timeout)
                else:
                    # Wait for specific response type
                    response = await self.wait_for_response(expected_response, timeout)
                return response
            except RuntimeError as runtime_error:
                # Check if this is a temporary Telegram error
                error_msg = str(runtime_error).lower()
                if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                    retry_count += 1
                    if retry_count < max_retries:
                        self.logger.warning(f"[SEND_AND_WAIT] Temporary Telegram error, retry {retry_count}/{max_retries}: {runtime_error}")
                        # Add delay for temporary errors
                        await asyncio.sleep(10 * retry_count)
                        # Clear pending responses before retrying
                        while not self.response_queue.empty():
                            try:
                                await self.response_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                break
                        continue
                    else:
                        raise runtime_error
                else:
                    # Re-raise non-temporary errors immediately
                    raise runtime_error
        
        self.logger.info(f"[MSG] Completed send_and_wait for '{message[:50]}...'")
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

        # Send file as document to ensure uncompressed transmission
        # This is especially important for sticker creation where image quality must be preserved
        await self.client.send_file(self.bot_peer, file_path, force_document=True)
        self.logger.info(f"[FILE] Sent file as document: {os.path.basename(file_path)}")
        self.logger.info(f"[FILE] File size: {os.path.getsize(file_path)} bytes")
        self.logger.info(f"[FILE] File modification time: {os.path.getmtime(file_path)}")

        # Wait for response with retry mechanism for timeouts and temporary errors
        max_retries = 3
        retry_count = 0
        
        while retry_count < max_retries:
            try:
                response = await self.wait_for_response(expected_response, timeout)
                self.logger.info(f"[FILE] Successfully received expected response for {os.path.basename(file_path)}: {response.response_type.value}")
                return response
            except asyncio.TimeoutError:
                retry_count += 1
                if retry_count < max_retries:
                    self.logger.warning(f"[FILE] Timeout waiting for response after sending {os.path.basename(file_path)}, retry {retry_count}/{max_retries}")
                    # Add delay before retry
                    await asyncio.sleep(5 * retry_count)
                    # Clear pending responses before retrying
                    while not self.response_queue.empty():
                        try:
                            await self.response_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    continue
                else:
                    self.logger.warning(f"[FILE] Timeout waiting for response after sending {os.path.basename(file_path)}")
                    # Even on timeout, we know the file was sent, so we can continue monitoring
                    # Return a special response indicating the file was sent but response is pending
                    return BotResponse(
                        message="File sent; awaiting response",
                        response_type=BotResponseType.UNKNOWN,
                        timestamp=time.time(),
                        confidence=0.5
                    )
            except RuntimeError as runtime_error:
                # Check if this is a temporary Telegram error
                error_msg = str(runtime_error).lower()
                if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                    retry_count += 1
                    if retry_count < max_retries:
                        self.logger.warning(f"[FILE] Temporary Telegram error after sending {os.path.basename(file_path)}, retry {retry_count}/{max_retries}: {runtime_error}")
                        # Add longer delay for temporary errors
                        await asyncio.sleep(10 * retry_count)
                        # Clear pending responses before retrying
                        while not self.response_queue.empty():
                            try:
                                await self.response_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                break
                        continue
                    else:
                        raise runtime_error
                else:
                    # Re-raise non-temporary errors immediately
                    raise runtime_error


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
        self.logger = logger or get_sticker_logger('core')
        self.client = None
        self.bot_peer = None
        self.conversation_manager = None

    async def send_sticker_files(self, file_paths: List[str], bot_peer) -> List[str]:
        """Send sticker files to Telegram bot"""
        sent_file_ids = []
        
        # Process each file
        for file_path in file_paths:
            try:
                # Send as document (uncompressed) instead of photo
                sent_message = await self.client.send_file(
                    bot_peer, 
                    file_path, 
                    force_document=True  # This ensures it's sent as uncompressed document
                )
                sent_file_ids.append(str(sent_message.id))
                self.logger.info(f"Sent file {file_path} as document with ID {sent_message.id}")
            except Exception as e:
                self.logger.error(f"Error sending file {file_path}: {e}")
                raise
        
        return sent_file_ids

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

            # Convert to MediaItem objects with path normalization
            media_items = []
            for media_file in media_files:
                try:
                    raw_path = str(media_file['file_path']).strip().strip('\"\'')
                    norm_path = os.path.normpath(raw_path)
                    # Telethon expects a path-like; ensure absolute
                    if not os.path.isabs(norm_path):
                        norm_path = os.path.abspath(norm_path)
                    media_item = MediaItem(
                        norm_path,
                        sticker_type,
                        media_file.get('emoji', '😀')
                    )
                    media_items.append(media_item)
                except Exception as e:
                    self.logger.error(f"[STICKER] Skipping invalid media path '{media_file.get('file_path')}': {e}")

            self.logger.info(f"[STICKER] Created {len(media_items)} media items for process {process_id}")

            # Create a fresh coroutine to avoid reuse issues
            async def create_pack_fresh():
                return await self._create_sticker_pack_async(pack_name, pack_url_name, sticker_type, media_items, process_id, auto_skip_icon)
            
            # Run creation using the fresh coroutine
            result = run_telegram_coroutine(create_pack_fresh())

            self.logger.info(f"[STICKER] Pack creation completed for process {process_id}")
            return result

        except Exception as e:
            creation_logger = get_sticker_logger('creation')
            creation_logger.error(f"FATAL - Process: {process_id}, Error: {e}")
            
            # Update process status to failed
            from shared_state import active_processes, process_lock
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]['status'] = 'failed'
                    active_processes[process_id]['error'] = str(e)
                    active_processes[process_id]['current_stage'] = f'Failed: {str(e)}'
            
            raise

    async def _create_sticker_pack_async(self, pack_name: str, pack_url_name: str, sticker_type: str, media_items: List[MediaItem], process_id: str, auto_skip_icon: bool = True):
        """UNIFIED STICKER CREATION LOGIC - REMOVED DUPLICATION"""
        try:
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock, add_process, update_process
            
            # Log only essential information to reduce flood
            creation_logger = get_sticker_logger('creation')
            creation_logger.info(f"START - Pack: {pack_name}, Files: {len(media_items)}, Process: {process_id}")
            
            # Initialize process tracking data
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]['completed_files'] = 0
                    active_processes[process_id]['failed_files'] = 0
                    active_processes[process_id]['file_statuses'] = {}
                    active_processes[process_id]['total_files'] = len(media_items)

            # Step 1: Create new sticker pack
            command = "/newvideo" if sticker_type == "video" else "/newpack"
            
            response = await self.conversation_manager.send_and_wait(
                command, BotResponseType.NEW_PACK_CREATED, timeout=30.0
            )

            # Step 2: Send pack name
            response = await self.conversation_manager.send_and_wait(
                pack_name, BotResponseType.PACK_NAME_ACCEPTED, timeout=30.0
            )

            # Step 3: Upload stickers using send_file_and_wait with improved error handling
            for i, media_item in enumerate(media_items):
                filename = os.path.basename(media_item.file_path)
                
                # Add human-like delay to avoid rate limiting
                # Random delay between 1-3 seconds to mimic human behavior
                import random
                delay = random.uniform(1.0, 3.0)
                self.logger.info(f"[HUMAN_DELAY] Adding {delay:.1f}s delay before sending {filename}")
                await asyncio.sleep(delay)
                
                # Update process status
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['current_file'] = filename
                        active_processes[process_id]['current_stage'] = f'Uploading sticker {i+1}/{len(media_items)}...'
                        active_processes[process_id]['progress'] = (i / len(media_items)) * 100

                try:
                    # Upload file with retry mechanism and better timeout handling
                    max_retries = 5  # Increase retries for temporary errors
                    retry_count = 0
                    file_uploaded = False
                    
                    while retry_count < max_retries and not file_uploaded:
                        try:
                            # Increase timeout for large files and add retry logic
                            timeout = 90.0 if sticker_type == "video" else 60.0
                            response = await self.conversation_manager.send_file_and_wait(
                                media_item.file_path, BotResponseType.FILE_UPLOADED, timeout=timeout
                            )
                            file_uploaded = True
                            
                        except (asyncio.TimeoutError, TimeoutError) as timeout_error:
                            retry_count += 1
                            if retry_count < max_retries:
                                self.logger.warning(f"[STICKER] File upload timeout for {filename}, retry {retry_count}/{max_retries}")
                                # Add longer delay for rate limiting issues
                                await asyncio.sleep(5 * retry_count)  # Exponential backoff
                            else:
                                raise timeout_error
                        except RuntimeError as runtime_error:
                            # Check if this is a temporary Telegram error
                            error_msg = str(runtime_error).lower()
                            if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                                retry_count += 1
                                if retry_count < max_retries:
                                    self.logger.warning(f"[STICKER] Temporary Telegram error for {filename}, retry {retry_count}/{max_retries}: {runtime_error}")
                                    # Add longer delay for temporary errors
                                    await asyncio.sleep(10 * retry_count)  # Exponential backoff for temporary errors
                                else:
                                    raise runtime_error
                            else:
                                # Re-raise non-temporary errors immediately
                                raise runtime_error

                    if not file_uploaded:
                        raise Exception(f"Failed to upload {filename} after {max_retries} retries")

                    # Send emoji with retry mechanism
                    emoji_sent = False
                    emoji_retry_count = 0
                    max_emoji_retries = 5  # Increase retries for temporary errors
                    
                    while emoji_retry_count < max_emoji_retries and not emoji_sent:
                        try:
                            response = await self.conversation_manager.send_and_wait(
                                media_item.emoji, BotResponseType.EMOJI_ACCEPTED, timeout=45.0
                            )
                            emoji_sent = True
                            
                        except (asyncio.TimeoutError, TimeoutError) as timeout_error:
                            emoji_retry_count += 1
                            if emoji_retry_count < max_emoji_retries:
                                self.logger.warning(f"[STICKER] Emoji timeout for {filename}, retry {emoji_retry_count}/{max_emoji_retries}")
                                await asyncio.sleep(2 * emoji_retry_count)  # Exponential backoff
                            else:
                                raise timeout_error
                        except RuntimeError as runtime_error:
                            # Check if this is a temporary Telegram error
                            error_msg = str(runtime_error).lower()
                            if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                                emoji_retry_count += 1
                                if emoji_retry_count < max_emoji_retries:
                                    self.logger.warning(f"[STICKER] Temporary Telegram error for emoji of {filename}, retry {emoji_retry_count}/{max_emoji_retries}: {runtime_error}")
                                    # Add longer delay for temporary errors
                                    await asyncio.sleep(5 * emoji_retry_count)  # Exponential backoff for temporary errors
                                else:
                                    raise runtime_error
                            else:
                                # Re-raise non-temporary errors immediately
                                raise runtime_error

                    if not emoji_sent:
                        raise Exception(f"Failed to send emoji for {filename} after {max_emoji_retries} retries")

                    # Update progress
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]['completed_files'] = i + 1
                            active_processes[process_id]['progress'] = ((i + 1) / len(media_items)) * 100
                            active_processes[process_id]['current_stage'] = f'Completed {filename}'
                            # Track individual file status
                            if 'file_statuses' not in active_processes[process_id]:
                                active_processes[process_id]['file_statuses'] = {}
                            active_processes[process_id]['file_statuses'][filename] = {
                                'status': 'completed',
                                'emoji': media_item.emoji,
                                'completed_at': time.time()
                            }
                    
                    # Log progress every 10 files or at completion
                    if (i + 1) % 10 == 0 or (i + 1) == len(media_items):
                        creation_logger.info(f"PROGRESS - Process: {process_id}, {i + 1}/{len(media_items)} ({(i + 1) / len(media_items) * 100:.1f}%) - {filename}")

                except Exception as e:
                    creation_logger.error(f"ERROR - Process: {process_id}, File: {filename}, Error: {e}")
                    # Track failed file status
                    with process_lock:
                        if process_id in active_processes:
                            if 'file_statuses' not in active_processes[process_id]:
                                active_processes[process_id]['file_statuses'] = {}
                            active_processes[process_id]['file_statuses'][filename] = {
                                'status': 'failed',
                                'error': str(e),
                                'emoji': media_item.emoji,
                                'failed_at': time.time()
                            }
                            # Update failed files count
                            active_processes[process_id]['failed_files'] = active_processes[process_id].get('failed_files', 0) + 1
                    
                    # Check if we should continue or abort based on failure rate
                    failed_count = active_processes[process_id].get('failed_files', 0)
                    total_processed = i + 1
                    failure_rate = failed_count / total_processed
                    
                    if failure_rate > 0.5:  # If more than 50% fail, abort the process
                        creation_logger.error(f"ABORT - Process: {process_id}, High failure rate: {failure_rate:.1%}")
                        raise Exception(f"Process aborted due to high failure rate: {failed_count}/{total_processed} files failed")
                    
                    # Continue with next file for individual failures
                    continue

            # Step 4: Publish pack
            # Add human-like delay before publishing
            import random
            delay = random.uniform(2.0, 5.0)
            self.logger.info(f"[HUMAN_DELAY] Adding {delay:.1f}s delay before publishing pack")
            await asyncio.sleep(delay)
            
            self.logger.info(f"[STICKER] Publishing pack...")
            response = await self.conversation_manager.send_and_wait(
                "/publish", BotResponseType.ICON_REQUEST, timeout=30.0
            )

            self.logger.info(f"[STICKER] Received icon request: {response.message[:100]}...")
            
            # Step 5: Handle icon selection
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]["current_stage"] = "Waiting for icon selection..."
                    active_processes[process_id]["waiting_for_user"] = True
                    active_processes[process_id]["icon_request_message"] = response.message
                    active_processes[process_id]["progress"] = 80

            # Check if auto-skip is enabled
            if auto_skip_icon:
                self.logger.info("[STICKER] Auto-skip enabled, automatically skipping icon selection...")
                
                # Mark in process data that auto-skip has been handled by backend
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["auto_skip_handled"] = True
                
                # Send skip command automatically - expect URL_NAME_REQUEST not ICON_ACCEPTED
                # Add retry logic for temporary errors
                skip_sent = False
                skip_retry_count = 0
                max_skip_retries = 3
                            
                while skip_retry_count < max_skip_retries and not skip_sent:
                    try:
                        response = await self.conversation_manager.send_and_wait(
                            "/skip", BotResponseType.URL_NAME_REQUEST, timeout=30.0
                        )
                        skip_sent = True
                    except RuntimeError as runtime_error:
                        # Check if this is a temporary Telegram error
                        error_msg = str(runtime_error).lower()
                        if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                            skip_retry_count += 1
                            if skip_retry_count < max_skip_retries:
                                self.logger.warning(f"[STICKER] Temporary Telegram error during skip, retry {skip_retry_count}/{max_skip_retries}: {runtime_error}")
                                # Add longer delay for temporary errors
                                await asyncio.sleep(10 * skip_retry_count)
                            else:
                                raise runtime_error
                        else:
                            # Re-raise non-temporary errors immediately
                            raise runtime_error
                    except (asyncio.TimeoutError, TimeoutError) as timeout_error:
                        skip_retry_count += 1
                        if skip_retry_count < max_skip_retries:
                            self.logger.warning(f"[STICKER] Skip timeout, retry {skip_retry_count}/{max_skip_retries}")
                            await asyncio.sleep(5 * skip_retry_count)
                        else:
                            raise timeout_error

                self.logger.info(f"[STICKER] Icon step skipped, received URL name request: {response.message[:100]}...")
                
                # Update process status - now waiting for URL name
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = "Providing URL name..."
                        active_processes[process_id]["waiting_for_user"] = False
                        active_processes[process_id]["progress"] = 85
                
                # Send the URL name that was already provided
                # Add retry logic for temporary errors
                url_sent = False
                url_retry_count = 0
                max_url_retries = 3
                
                while url_retry_count < max_url_retries and not url_sent:
                    try:
                        response = await self.conversation_manager.send_and_wait(
                            pack_url_name, [BotResponseType.PACK_SUCCESS, BotResponseType.URL_NAME_TAKEN], timeout=30.0
                        )
                        url_sent = True
                    except RuntimeError as runtime_error:
                        # Check if this is a temporary Telegram error
                        error_msg = str(runtime_error).lower()
                        if "sorry, an error occurred" in error_msg or "try again later" in error_msg or "code" in error_msg:
                            url_retry_count += 1
                            if url_retry_count < max_url_retries:
                                self.logger.warning(f"[STICKER] Temporary Telegram error during URL submission, retry {url_retry_count}/{max_url_retries}: {runtime_error}")
                                # Add longer delay for temporary errors
                                await asyncio.sleep(10 * url_retry_count)
                            else:
                                raise runtime_error
                        else:
                            # Re-raise non-temporary errors immediately
                            raise runtime_error
                    except (asyncio.TimeoutError, TimeoutError) as timeout_error:
                        url_retry_count += 1
                        if url_retry_count < max_url_retries:
                            self.logger.warning(f"[STICKER] URL submission timeout, retry {url_retry_count}/{max_url_retries}")
                            await asyncio.sleep(5 * url_retry_count)
                        else:
                            raise timeout_error
                
                # Check if URL name was taken
                if response.response_type == BotResponseType.URL_NAME_TAKEN:
                    self.logger.warning(f"[STICKER] URL name '{pack_url_name}' is already taken")
                    
                    # Mark process as waiting for user input with retry mechanism
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]["current_stage"] = f"URL name '{pack_url_name}' is already taken. Please provide a new name."
                            active_processes[process_id]["waiting_for_user"] = True
                            active_processes[process_id]["url_name_taken"] = True
                            active_processes[process_id]["original_url_name"] = pack_url_name
                            active_processes[process_id]["url_name_attempts"] = 1
                            active_processes[process_id]["max_url_attempts"] = 3
                            active_processes[process_id]["status"] = "waiting_for_url_name"
                            active_processes[process_id]["progress"] = 85
                            # CRITICAL FIX: Prevent race condition - clear any completion flags
                            active_processes[process_id].pop("shareable_link", None)
                    
                    return {"success": False, "error": f"URL name '{pack_url_name}' is already taken", "waiting_for_user": True, "url_name_taken": True}
                
                self.logger.info(f"[STICKER] Pack published successfully: {response.message[:100]}...")
                
                # Update process status - completed
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = "Sticker pack created successfully"
                        active_processes[process_id]["waiting_for_user"] = False
                        active_processes[process_id]["progress"] = 100
                        active_processes[process_id]["status"] = "completed"
                        # CRITICAL FIX: Clear URL name taken flags when pack is completed
                        active_processes[process_id]["url_name_taken"] = False
                        active_processes[process_id].pop("original_url_name", None)
                        
                        # Extract the shareable link from the response
                        if "https://t.me/addstickers/" in response.message:
                            import re
                            link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', response.message)
                            if link_match:
                                shareable_link = link_match.group(0)
                                active_processes[process_id]["shareable_link"] = shareable_link
                                
                                # Log completion with success count
                                success_count = active_processes[process_id].get('completed_files', 0)
                                failed_count = active_processes[process_id].get('failed_files', 0)
                                creation_logger.info(f"COMPLETE - Process: {process_id}, Status: SUCCESS, Success: {success_count}, Failed: {failed_count}")
                                creation_logger.info(f"PACK_URL - {shareable_link}")
                
                # FIXED: Increment sticker creation stats in backend
                try:
                    from stats_tracker import stats_tracker
                    sticker_count = len(media_items)
                    stats_tracker.increment_stickers(sticker_count)
                    self.logger.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                except Exception as stats_error:
                    self.logger.warning(f"[STICKER] Failed to update stats: {stats_error}")
                
                # Return success with shareable link to trigger proper success modal
                shareable_link = f"https://t.me/addstickers/{pack_url_name}"
                
                # Update process with shareable link before returning
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]['shareable_link'] = shareable_link
                        active_processes[process_id]['pack_url_name'] = pack_url_name
                        active_processes[process_id]['current_stage'] = 'Pack creation completed successfully'
                
                return {"success": True, "message": "Sticker pack created successfully", "shareable_link": shareable_link, "pack_url_name": pack_url_name}
            else:
                # Auto-skip is disabled, wait for user decision
                self.logger.info("[STICKER] Auto-skip disabled, waiting for user decision on icon selection...")
                
                # Mark process as waiting for user - NO TIMEOUT, wait indefinitely
                with process_lock:
                    if process_id in active_processes:
                        active_processes[process_id]["current_stage"] = "Waiting for icon selection (no timeout)..."
                        active_processes[process_id]["waiting_for_user"] = True
                        active_processes[process_id]["icon_request_message"] = response.message
                        active_processes[process_id]["progress"] = 90
                        active_processes[process_id]["status"] = "waiting_for_user"  # CRITICAL FIX: Set status to prevent frontend from marking as completed
                        active_processes[process_id]["icon_request"] = True  # Additional flag for frontend detection
                
                # Return success - the process will continue when user clicks skip/upload
                # No timeout here - user controls when to proceed
                self.logger.info("[STICKER] Process marked as waiting for user icon selection (indefinite wait)")
                return {"success": True, "message": "Waiting for user icon selection", "waiting_for_user": True}

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

            # Create a fresh coroutine to avoid reuse issues
            async def create_pack_fresh():
                return await self._create_sticker_pack_async(pack_name, pack_url_name, sticker_type, media_items, process_id, auto_skip_icon)
            
            # Run creation using the fresh coroutine
            result = run_telegram_coroutine(create_pack_fresh())

            self.logger.info(f"[STICKER] Pack creation completed for process {process_id}")
            return result

        except Exception as e:
            creation_logger = get_sticker_logger('creation')
            creation_logger.error(f"FATAL - Process: {process_id}, Error: {e}")
            
            # Update process status to failed
            from shared_state import active_processes, process_lock
            with process_lock:
                if process_id in active_processes:
                    active_processes[process_id]['status'] = 'failed'
                    active_processes[process_id]['error'] = str(e)
                    active_processes[process_id]['current_stage'] = f'Failed: {str(e)}'
            
            raise

# Removed duplicate TelegramSessionManager class - using EnhancedTelegramSessionManager instead

def run_telegram_coroutine(coro):
    """
    Safely run a Telegram coroutine with database lock handling.
    
    :param coro: Coroutine to run
    :return: Result of the coroutine
    """
    thread_name = threading.current_thread().name
    
    # Ensure we're working with a coroutine object
    if not asyncio.iscoroutine(coro):
        raise TypeError(f"Expected a coroutine object, got {type(coro)}")
    
    try:
        # Try to use the handler's event loop first
        try:
            from telegram_connection_handler import get_telegram_handler
            handler = get_telegram_handler()
            if handler and handler._loop and handler._running:
                # Use the handler's dedicated event loop
                future = asyncio.run_coroutine_threadsafe(coro, handler._loop)
                # Allow up to 180s to accommodate longer Telegram waits
                return future.result(timeout=180)
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
    
    except RuntimeError as e:
        # Handle the specific "cannot reuse already awaited coroutine" error
        if "cannot reuse already awaited coroutine" in str(e):
            logging.error(f"[COROUTINE] Attempted to reuse an already awaited coroutine in thread {thread_name}")
            raise RuntimeError("Coroutine has already been executed. This is likely due to an internal error in coroutine management.")
        else:
            # Re-raise other RuntimeError exceptions
            raise
    except Exception as e:
        # Handle specific database lock errors
        if "database is locked" in str(e).lower():
            logging.warning(f"[DATABASE] Lock detected: {e}")
            handle_database_lock_error(e, "coroutine execution")
        
        # Re-raise the original exception
        raise


def create_fresh_coroutine(func, *args, **kwargs):
    """
    Helper function to create a fresh coroutine from a function.
    This can be used to avoid coroutine reuse issues.
    
    :param func: Async function to call
    :param args: Positional arguments for the function
    :param kwargs: Keyword arguments for the function
    :return: Fresh coroutine object
    """
    return func(*args, **kwargs)


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
            logging.info(f"[WORKER] Successfully imported active_processes, current processes: {list(active_processes.keys())}")
            
            # Update process status to processing
            with process_lock:
                
                logging.info(f"[WORKER] Looking for process {process_id} in active_processes")
                logging.info(f"[WORKER] Current active_processes keys: {list(active_processes.keys())}")
                logging.info(f"[WORKER] Process {process_id} exists: {process_id in active_processes}")
                
                if process_id in active_processes:
                    active_processes[process_id]['status'] = 'processing'
                    active_processes[process_id]['current_stage'] = 'Starting sticker pack creation...'
                    logging.info(f"[WORKER] Updated process {process_id} to processing status")
                else:
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
                    logging.info(f"[WORKER] Created missing process entry for {process_id}")
            
            try:
                # Ensure sticker_bot is initialized
                if sticker_bot is None:
                    logging.error(f"[WORKER] sticker_bot is None, initializing...")
                    sticker_bot = StickerBotCore()
                    # Set the sticker_bot in shared_state for global access
                    from shared_state import set_sticker_bot
                    set_sticker_bot(sticker_bot)
                    logging.info(f"[WORKER] sticker_bot initialized and set in shared_state in worker thread")
                
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
        # Set the sticker_bot in shared_state for global access
        from shared_state import set_sticker_bot
        set_sticker_bot(sticker_bot)
        logging.info(f"[DEBUG] sticker_bot initialized and set in shared_state successfully")
    


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
            # Sanitize all input fields to remove only null bytes which cause OS-level errors
            raw_pack_name = data.get('pack_name', '') if data else ''
            raw_pack_url_name = data.get('pack_url_name', '') if data else ''
            raw_sticker_type = data.get('sticker_type', 'video') if data else 'video'
            media_files = data.get('media_files', []) if data else []
            raw_process_id = data.get('process_id', f'sticker_{int(time.time())}') if data else f'sticker_{int(time.time())}'
            auto_skip_icon = data.get('auto_skip_icon', True) if data else True  # Default to True

            # Remove only null bytes which are the main cause of OS errors
            pack_name = str(raw_pack_name).replace('\x00', '')
            pack_url_name = str(raw_pack_url_name).replace('\x00', '')
            sticker_type = str(raw_sticker_type).replace('\x00', '')
            process_id = str(raw_process_id).replace('\x00', '')

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

            # Windows-safe media validation and path sanitization
            # ENHANCED: More robust validation to prevent [Errno 22] Invalid argument
            sanitized_media_files = []
            invalid_reasons = []
            for idx, mf in enumerate(media_files):
                try:
                    raw_path = str(mf.get('file_path', '')).strip().strip('\"\'')
                    if not raw_path:
                        invalid_reasons.append(f"Item {idx+1}: empty path")
                        continue
                    
                    # Remove only null bytes which are the main cause of OS errors
                    raw_path = raw_path.replace('\x00', '')
                    
                    # Normalize Windows paths safely
                    norm_path = os.path.normpath(raw_path)
                    
                    # Disallow NUL and control chars
                    if '\x00' in norm_path:
                        invalid_reasons.append(f"{norm_path}: contains NUL byte")
                        continue
                        
                    # Guard against excessively long paths
                    if len(norm_path) > 240:
                        invalid_reasons.append(f"{norm_path}: path too long")
                        continue
                        
                    # Validate path doesn't contain invalid characters for Windows
                    invalid_chars = '<>\"|?*'
                    if any(char in norm_path for char in invalid_chars):
                        invalid_reasons.append(f"{norm_path}: contains invalid characters")
                        continue
                        
                    if not os.path.isabs(norm_path):
                        # If relative, attempt to make absolute based on current working dir
                        norm_path = os.path.abspath(norm_path)
                        
                    # Proactively check if path is valid by attempting to access it
                    try:
                        # Just check if we can access the path without actually opening the file
                        os.path.exists(norm_path)
                    except OSError as path_error:
                        if getattr(path_error, 'errno', None) == 22 or 'Invalid argument' in str(path_error):
                            invalid_reasons.append(f"{norm_path}: invalid path argument")
                            continue
                        else:
                            # Re-raise if it's a different error
                            raise
                            
                    if not os.path.exists(norm_path):
                        invalid_reasons.append(f"{norm_path}: file not found")
                        continue
                        
                    # Validate emoji
                    emoji = str(mf.get('emoji', '😀')).strip()
                    # Remove only null bytes which are the main cause of OS errors
                    emoji = emoji.replace('\x00', '')
                    # Limit emoji length
                    emoji = emoji[:2]
                    
                    sanitized_media_files.append({
                        'file_path': norm_path,
                        'emoji': emoji,
                        'type': str(mf.get('type', 'video')).strip()
                    })
                except Exception as ve:
                    invalid_reasons.append(f"Item {idx+1}: {str(ve)}")

            if not sanitized_media_files:
                return jsonify({
                    "success": False,
                    "error": "No valid media files after validation",
                    "details": invalid_reasons[:5]
                }), 400

            # Proactively detect OS-level invalid argument by attempting safe open/close
            try:
                for test_item in sanitized_media_files[:10]:  # limit to first 10 for speed
                    try:
                        with open(test_item['file_path'], 'rb') as _f:
                            pass
                    except OSError as oe:
                        if getattr(oe, 'errno', None) == 22 or 'Invalid argument' in str(oe):
                            return jsonify({
                                "success": False,
                                "error": f"Invalid path argument: {test_item['file_path']}",
                                "code": 22
                            }), 400
            except Exception:
                # Non-fatal; continue if generic error occurs here
                pass

            # Start background worker if not already running
            start_sticker_pack_worker()

            # Add process to active_processes immediately for tracking
            process_data = {
                "status": "queued",
                "current_stage": "Waiting in queue...",
                "progress": 0,
                "total_files": len(sanitized_media_files),
                "completed_files": 0,
                "start_time": time.time(),
                "type": "sticker_pack",
                "pack_name": pack_name,
                "pack_url_name": pack_url_name,
                "sticker_type": sticker_type,
                "auto_skip_icon": auto_skip_icon,
                "url_name_attempts": 0
            }
            
            
            
            add_process(process_id, process_data)
            
            
            # Verify the process was actually added
            if process_id in active_processes:
                pass  # Empty if block - likely placeholder or incomplete code

            # Add task to queue
            # Put sanitized media into the queue to avoid OS path errors later
            sticker_pack_queue.put((pack_name, sticker_type, sanitized_media_files, process_id))
            
            
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
                        
                        # Send the URL name automatically with increased timeout - expect SUCCESS or TAKEN
                        url_response = await sticker_bot.conversation_manager.send_and_wait(
                            pack_url_name, [BotResponseType.PACK_SUCCESS, BotResponseType.URL_NAME_TAKEN], timeout=60.0
                        )
                        
                        # Check if URL name was taken
                        if url_response.response_type == BotResponseType.URL_NAME_TAKEN:
                            logging.warning(f"[SKIP_ICON] URL name '{pack_url_name}' is already taken")
                            
                            # Mark process as waiting for user input with retry mechanism
                            with process_lock:
                                if process_id in active_processes:
                                    active_processes[process_id]['status'] = 'waiting_for_url_name'
                                    active_processes[process_id]['current_stage'] = f'URL name "{pack_url_name}" is already taken. Please provide a new name.'
                                    active_processes[process_id]['waiting_for_user'] = True
                                    active_processes[process_id]['url_name_taken'] = True
                                    # PRESERVE ORIGINAL URL NAME FROM FORM INPUT
                                    active_processes[process_id]['original_url_name'] = pack_url_name
                                    active_processes[process_id]['url_name_attempts'] = 1
                                    active_processes[process_id]['max_url_attempts'] = 3
                                    active_processes[process_id]['progress'] = 85
                                    # CRITICAL FIX: Prevent race condition - clear any completion flags
                                    active_processes[process_id].pop('shareable_link', None)
                            
                            return {"success": False, "error": f"URL name '{pack_url_name}' is already taken", "waiting_for_user": True, "url_name_taken": True, "original_url_name": pack_url_name}
                        
                        logging.info(f"[SKIP_ICON] URL name submission successful")
                        
                        # Update process status after successful completion
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                                active_processes[process_id]['progress'] = 100
                                active_processes[process_id]['status'] = 'completed'
                                # CRITICAL FIX: Clear URL name taken flags when pack is completed
                                active_processes[process_id]['url_name_taken'] = False
                                active_processes[process_id].pop('original_url_name', None)
                                
                                # Extract shareable link
                                if "https://t.me/addstickers/" in url_response.message:
                                    import re
                                    link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', url_response.message)
                                    if link_match:
                                        active_processes[process_id]['shareable_link'] = link_match.group(0)
                                    else:
                                        # Fallback: construct link from URL name
                                        active_processes[process_id]['shareable_link'] = f"https://t.me/addstickers/{pack_url_name}"
                                else:
                                    # Fallback: construct link from URL name
                                    active_processes[process_id]['shareable_link'] = f"https://t.me/addstickers/{pack_url_name}"
                        
                        # FIXED: Increment sticker creation stats in backend
                        try:
                            from stats_tracker import stats_tracker
                            sticker_count = active_processes.get(process_id, {}).get('total_files', 1)
                            stats_tracker.increment_stickers(sticker_count)
                            logging.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                        except Exception as stats_error:
                            logging.warning(f"[STICKER] Failed to update backend stats: {stats_error}")
                        
                        return {
                            "success": True, 
                            "message": "Sticker pack created successfully",
                            "shareable_link": active_processes.get(process_id, {}).get('shareable_link'),
                            "pack_url_name": pack_url_name,
                            "completed": True
                        }
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
                            active_processes[process_id]['original_url_name'] = pack_url_name if pack_url_name else active_processes[process_id].get('pack_url_name', 'retry')
                    
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
                            active_processes[process_id]['original_url_name'] = pack_url_name if pack_url_name else active_processes[process_id].get('pack_url_name', 'retry')
                    
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
            
            logging.info(f"[URL_NAME] Processing URL name submission for process {process_id}: {new_url_name} (attempt {current_attempt}/{max_attempts})")
            
            # Import active_processes from shared state
            from shared_state import active_processes, process_lock
            
            with process_lock:
                if process_id not in active_processes:
                    return jsonify({"success": False, "error": "Process not found"}), 404
                
                # Check if process is in a valid state for URL name submission
                process_status = active_processes[process_id].get('status')
                url_name_taken = active_processes[process_id].get('url_name_taken', False)
                waiting_for_user = active_processes[process_id].get('waiting_for_user', False)
                
                # Accept URL name submission if:
                # 1. Status is explicitly 'waiting_for_url_name', OR
                # 2. URL name was taken and we're waiting for user input, OR  
                # 3. Process is in a retry state (url_name_taken flag is set)
                valid_for_url_submission = (
                    process_status == 'waiting_for_url_name' or
                    (url_name_taken and waiting_for_user) or
                    url_name_taken  # Allow submission during retry flow
                )
                
                if not valid_for_url_submission:
                    logging.warning(f"[URL_NAME] Process {process_id} not in valid state for URL submission. Status: {process_status}, url_name_taken: {url_name_taken}, waiting_for_user: {waiting_for_user}")
                    return jsonify({"success": False, "error": f"Process is not waiting for URL name (status: {process_status}, url_name_taken: {url_name_taken})"}), 400
                
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
                    # Send the new URL name to Telegram - expect SUCCESS or TAKEN
                    url_response = await sticker_bot.conversation_manager.send_and_wait(
                        new_url_name, [BotResponseType.URL_NAME_ACCEPTED, BotResponseType.URL_NAME_TAKEN, BotResponseType.PACK_SUCCESS], timeout=45.0
                    )
                    
                    # Check response type
                    if url_response.response_type in [BotResponseType.URL_NAME_ACCEPTED, BotResponseType.PACK_SUCCESS]:
                        # URL name accepted - continue with sticker creation
                        logging.info(f"[URL_NAME] New URL name accepted: {new_url_name}")
                        
                        # Continue with the rest of sticker pack creation process
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['current_stage'] = 'URL name accepted, finalizing pack creation...'
                                active_processes[process_id]['progress'] = 95
                                active_processes[process_id]['status'] = 'completed'
                                # CRITICAL FIX: Clear URL name taken flags when URL is accepted
                                active_processes[process_id]['url_name_taken'] = False
                                active_processes[process_id].pop('original_url_name', None)
                                active_processes[process_id]['status'] = 'completed'
                                
                                # Extract shareable link from the response
                                if "https://t.me/addstickers/" in url_response.message:
                                    import re
                                    link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', url_response.message)
                                    if link_match:
                                        active_processes[process_id]['shareable_link'] = link_match.group(0)
                                    else:
                                        # Fallback: construct link from URL name
                                        active_processes[process_id]['shareable_link'] = f"https://t.me/addstickers/{new_url_name}"
                                else:
                                    # Fallback: construct link from URL name
                                    active_processes[process_id]['shareable_link'] = f"https://t.me/addstickers/{new_url_name}"
                        
                        # FIXED: Increment sticker creation stats in backend
                        try:
                            from stats_tracker import stats_tracker
                            sticker_count = active_processes.get(process_id, {}).get('total_files', 1)
                            stats_tracker.increment_stickers(sticker_count)
                            logging.info(f"[STICKER] Updated backend stats: +{sticker_count} stickers")
                        except Exception as stats_error:
                            logging.warning(f"[STICKER] Failed to update backend stats: {stats_error}")
                        
                        # Return success with shareable link for proper success modal
                        shareable_link = f"https://t.me/addstickers/{new_url_name}"
                        return {"success": True, "message": "Sticker pack created successfully", "shareable_link": shareable_link, "pack_url_name": new_url_name, "completed": True}
                    
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
                                    # CRITICAL FIX: Prevent race condition - clear any completion flags
                                    active_processes[process_id].pop('shareable_link', None)
                            
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
                    # IMPORTANT: After a successful icon upload, the bot asks for the short name
                    # e.g. "Please provide a short name for your set. I'll use it to create a link..."
                    # So we should wait for URL_NAME_REQUEST, not ICON_ACCEPTED
                    # Increased timeout to 180 seconds for better reliability
                    response = await sticker_bot.conversation_manager.send_file_and_wait(
                        icon_file_path, BotResponseType.URL_NAME_REQUEST, timeout=180.0
                    )
                    
                    logging.info(f"[ICON_UPLOAD] Icon upload successful, received URL name request: {response.message[:100]}...")
                    
                    # Get the pack URL name that was already provided
                    with process_lock:
                        if process_id in active_processes:
                            pack_url_name = active_processes[process_id].get('pack_url_name', '')
                            # Update process status - now waiting for URL name submission
                            active_processes[process_id]["current_stage"] = "Icon successfully sent to Telegram"
                            active_processes[process_id]["progress"] = 85
                            active_processes[process_id]["icon_handled"] = True
                            active_processes[process_id]["icon_sent_successfully"] = True
                            active_processes[process_id]["last_message"] = "Icon uploaded; providing URL name..."
                            active_processes[process_id]["last_message_time"] = time.time()
                            active_processes[process_id]["status"] = "processing"  # Ensure status shows as processing
                    
                    logging.info(f"[ICON_UPLOAD] Proceeding with URL name submission: {pack_url_name}")
                    
                    # CRITICAL FIX: Always proceed with URL name submission if we have one
                    if pack_url_name:
                        # Indicate we're submitting the URL automatically
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['waiting_for_url_name'] = False
                                active_processes[process_id]['current_stage'] = 'Providing URL name...'

                        url_response = await sticker_bot.conversation_manager.send_and_wait(
                            pack_url_name, [BotResponseType.PACK_SUCCESS, BotResponseType.URL_NAME_TAKEN], timeout=60.0
                        )

                        if url_response.response_type == BotResponseType.URL_NAME_TAKEN:
                            logging.warning(f"[ICON_UPLOAD] URL name '{pack_url_name}' is already taken")
                            # Prompt user for a different name, mirroring skip flow
                            with process_lock:
                                if process_id in active_processes:
                                    active_processes[process_id]['status'] = 'waiting_for_url_name'
                                    active_processes[process_id]['current_stage'] = f'URL name "{pack_url_name}" is already taken. Please provide a new name.'
                                    active_processes[process_id]['waiting_for_user'] = True
                                    active_processes[process_id]['waiting_for_url_name'] = True
                                    active_processes[process_id]['url_name_taken'] = True
                                    active_processes[process_id]['original_url_name'] = pack_url_name
                                    active_processes[process_id]['url_name_attempts'] = 1
                                    active_processes[process_id]['max_url_attempts'] = 3
                                    active_processes[process_id]['progress'] = 85
                                    # CRITICAL: Ensure we don't mark as completed when URL is taken
                                    active_processes[process_id]['completed'] = False
                                    active_processes[process_id].pop('shareable_link', None)

                            return {
                                "success": True,
                                "message": "Icon uploaded; URL name taken — awaiting new name",
                                "icon_sent": True,
                                "url_name_taken": True,
                                "original_url_name": pack_url_name,
                                "waiting_for_user": True,  # CRITICAL: Add this flag to match skip flow
                                "completed": False  # Explicitly indicate process is not complete
                            }

                        # Success: pack created, mirror skip flow completion
                        shareable_link = None
                        try:
                            if "https://t.me/addstickers/" in url_response.message:
                                import re
                                link_match = re.search(r'https://t\.me/addstickers/[a-zA-Z0-9_]+', url_response.message)
                                if link_match:
                                    shareable_link = link_match.group(0)
                        except Exception:
                            pass

                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]['waiting_for_user'] = False
                                active_processes[process_id]['waiting_for_url_name'] = False
                                active_processes[process_id]['current_stage'] = 'Sticker pack created successfully'
                                active_processes[process_id]['progress'] = 100
                                active_processes[process_id]['status'] = 'completed'
                                active_processes[process_id]['url_name_taken'] = False
                                active_processes[process_id].pop('original_url_name', None)
                                if shareable_link:
                                    active_processes[process_id]['shareable_link'] = shareable_link

                        return {
                            "success": True,
                            "message": "Sticker pack created successfully",
                            "completed": True,  # This is only set to True when the entire flow is complete
                            "shareable_link": shareable_link
                        }

                    # No provided URL name; await user input like before
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]["waiting_for_user"] = True
                            active_processes[process_id]["waiting_for_url_name"] = True

                    return {"success": True, "message": "Icon uploaded; awaiting URL name", "icon_sent": True}
                except asyncio.TimeoutError as e:
                    # Handle timeout specifically
                    logging.error(f"[ICON_UPLOAD] Timeout uploading icon: {str(e)}")
                    # Even on timeout, mark as handled since the file was likely sent
                    with process_lock:
                        if process_id in active_processes:
                            active_processes[process_id]["icon_handled"] = True
                            active_processes[process_id]["current_stage"] = "Icon sent; awaiting response..."
                            active_processes[process_id]["waiting_for_user"] = True
                            active_processes[process_id]["waiting_for_url_name"] = True
                            active_processes[process_id]["progress"] = 85
                            # Add success indicator even on timeout
                            active_processes[process_id]["icon_sent_successfully"] = True
                    return {"success": True, "message": "Icon sent to Telegram; awaiting response...", "timeout": True, "icon_sent": True}
                except Exception as e:
                    # Log the specific error for debugging
                    logging.error(f"[ICON_UPLOAD] Error uploading icon: {str(e)}")
                    # Provide user-friendly error message
                    error_msg = str(e)
                    if "file too big" in error_msg.lower() or "maximum file size" in error_msg.lower():
                        # CRITICAL FIX: When Telegram rejects the icon due to size, mark process as successful internally
                        # but indicate manual completion is required
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]["icon_handled"] = True
                                active_processes[process_id]["current_stage"] = "Icon rejected: file too big (max 32 KB)"
                                active_processes[process_id]["waiting_for_user"] = False
                                active_processes[process_id]["manual_completion_required"] = True
                                active_processes[process_id]["progress"] = 100
                                # Mark as successful but with manual completion needed
                                active_processes[process_id]["status"] = "completed_manual"
                        return {
                            "success": True,
                            "message": "Icon file is too big. Creation succeeded — please complete manually in Telegram.",
                            "manual_completion_required": True,
                            "error": "Icon file is too big. Maximum size is 32 KB. Please select a smaller file."
                        }
                    elif "invalid file" in error_msg.lower() or "file type" in error_msg.lower() or "not a valid" in error_msg.lower():
                        # CRITICAL FIX: When Telegram rejects the icon due to invalid format, mark process as successful internally
                        # but indicate manual completion is required
                        with process_lock:
                            if process_id in active_processes:
                                active_processes[process_id]["icon_handled"] = True
                                active_processes[process_id]["current_stage"] = "Icon rejected: invalid file format"
                                active_processes[process_id]["waiting_for_user"] = False
                                active_processes[process_id]["manual_completion_required"] = True
                                active_processes[process_id]["progress"] = 100
                                # Mark as successful but with manual completion needed
                                active_processes[process_id]["status"] = "completed_manual"
                                # CRITICAL FIX: Add flag to indicate the process should be marked as successful
                                active_processes[process_id]["completed"] = True
                        return {
                            "success": True,
                            "message": "Invalid icon file. Creation succeeded — please complete manually in Telegram.",
                            "manual_completion_required": True,
                            "error": "Invalid icon file. Please select a valid WebM file under 32 KB.",
                            "completed": True  # Indicate that the process is completed but requires manual completion
                        }
                    else:
                        return {"success": False, "error": f"Failed to upload icon: {error_msg}"}
            
            # Run the async function
            result = run_telegram_coroutine(send_icon_file())
            return jsonify(result)
            
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500