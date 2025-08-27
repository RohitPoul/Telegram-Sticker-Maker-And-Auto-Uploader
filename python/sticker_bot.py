import asyncio
import logging
import os
import time
import re
import threading
from typing import List, Dict, Optional
from dataclasses import dataclass
from enum import Enum
from concurrent.futures import Future

try:
    from telethon import TelegramClient, events
    from telethon.errors import SessionPasswordNeededError, FloodWaitError
    from telethon.tl.types import Message
    TELETHON_AVAILABLE = True
except ImportError:
    TELETHON_AVAILABLE = False

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
        if self.listening:
            return
        
        self.listening = True
        self.logger.info("[LISTEN] Started listening for bot messages")

        @self.client.on(events.NewMessage(from_users=self.bot_peer.id))
        async def message_handler(event):
            if not self.listening:
                return
            
            message = event.message.message
            response = self.matcher.match_response(message)
            response.raw_message = event.message
            
            self.logger.info(f"[DETECT] Bot response: {message[:100]}...")
            self.logger.info(f"[DETECT] Detected type: {response.response_type.value}")
            
            await self.response_queue.put(response)

        self.message_handler = message_handler

    async def stop_listening(self):
        self.listening = False
        if self.message_handler:
            self.client.remove_event_handler(self.message_handler)
        self.logger.info("[STOP] Stopped listening for bot messages")

    async def wait_for_response(self, expected_type: BotResponseType, timeout: float = 30.0):
        self.logger.info(f"[WAIT] Waiting for {expected_type.value}")
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                response = await asyncio.wait_for(self.response_queue.get(), timeout=2.0)
                
                if response.response_type == expected_type:
                    self.logger.info(f"[SUCCESS] Received expected response: {expected_type.value}")
                    return response
                
                if response.response_type == BotResponseType.ERROR_RESPONSE:
                    self.logger.error(f"[ERROR] Bot error response: {response.message}")
                    raise RuntimeError(f"Bot error: {response.message}")
                
                self.logger.warning(f"[WARNING] Unexpected response type: {response.response_type.value}")
                
            except asyncio.TimeoutError:
                continue
        
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

class AsyncioEventLoopThread:
    """EXACT ASYNCIO THREAD MANAGER FROM PYTHON VERSION"""
    def __init__(self):
        self.loop = None
        self.thread = None
        self._stopping = False
        self.logger = logging.getLogger(__name__)

    def start(self):
        if self.thread is not None:
            return
        
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_event_loop, daemon=True)
        self.thread.start()
        time.sleep(0.1)

    def _run_event_loop(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        except Exception as e:
            self.logger.error(f"[LOOP] Event loop error: {e}")
        finally:
            self.loop.close()

    def stop(self):
        self._stopping = True
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread:
            self.thread.join(timeout=10.0)

    def run_coroutine(self, coro) -> Future:
        if not self.loop or self.loop.is_closed():
            raise RuntimeError("Event loop is not running")
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future

class MediaItem:
    def __init__(self, file_path: str, media_type: str, emoji: str = "😀"):
        self.file_path = file_path
        self.media_type = media_type
        self.emoji = emoji
        self.processed = False
        self.error_message = ""
        self.processing_stage = "pending"

class StickerBotCore:
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.client = None
        self.bot_peer = None
        self.conversation_manager = None
        self.code_pending = False
        self.password_pending = False
        self.phone_number = ""
        self.asyncio_thread = AsyncioEventLoopThread()
        self.asyncio_thread.start()
        self.logger.info("[INIT] Sticker Bot Core initialized")

    def connect_telegram(self, api_id: str, api_hash: str, phone_number: str, process_id: str) -> Dict:
        """REAL Telegram connection with EXACT logic from Python version"""
        try:
            if not TELETHON_AVAILABLE:
                raise RuntimeError("Telethon library not available")

            self.phone_number = phone_number

            # Run connection in asyncio thread
            future = self.asyncio_thread.run_coroutine(
                self._connect_telegram_async(api_id, api_hash, phone_number)
            )

            result = future.result(timeout=30.0)
            return result

        except Exception as e:
            self.logger.error(f"[TELEGRAM] Connection error: {e}")
            return {"success": False, "error": str(e)}

    async def _connect_telegram_async(self, api_id: str, api_hash: str, phone_number: str):
        """EXACT CONNECTION LOGIC FROM PYTHON VERSION"""
        try:
            session_name = f'session_{phone_number.replace("+", "").replace(" ", "")}'
            self.client = TelegramClient(session_name, int(api_id), api_hash)
            
            await self.client.connect()

            if await self.client.is_user_authorized():
                self.logger.info("[TELEGRAM] Already authorized")
                
                # Setup bot connection
                self.bot_peer = await self.client.get_entity('@stickers')
                self.conversation_manager = SimpleConversationManager(self.client, self.bot_peer, self.logger)
                await self.conversation_manager.start_listening()
                
                return {"success": True, "needs_code": False, "needs_password": False}
            else:
                await self.client.send_code_request(phone_number)
                self.code_pending = True
                return {"success": True, "needs_code": True, "needs_password": False}

        except Exception as e:
            self.logger.error(f"[TELEGRAM] Async connection error: {e}")
            return {"success": False, "error": str(e)}

    def verify_code(self, code: str) -> Dict:
        """REAL code verification"""
        try:
            if not self.client or not self.code_pending:
                return {"success": False, "error": "No code verification pending"}

            future = self.asyncio_thread.run_coroutine(self._verify_code_async(code))
            result = future.result(timeout=15.0)
            return result

        except Exception as e:
            self.logger.error(f"[TELEGRAM] Code verification error: {e}")
            return {"success": False, "error": str(e)}

    async def _verify_code_async(self, code: str):
        try:
            try:
                await self.client.sign_in(self.phone_number, code)
                self.code_pending = False
                
                # Setup bot connection
                self.bot_peer = await self.client.get_entity('@stickers')
                self.conversation_manager = SimpleConversationManager(self.client, self.bot_peer, self.logger)
                await self.conversation_manager.start_listening()
                
                return {"success": True, "needs_password": False}
                
            except SessionPasswordNeededError:
                self.password_pending = True
                self.code_pending = False
                return {"success": True, "needs_password": True}
                
        except Exception as e:
            return {"success": False, "error": str(e)}

    def verify_password(self, password: str) -> Dict:
        """REAL password verification"""
        try:
            if not self.client or not self.password_pending:
                return {"success": False, "error": "No password verification pending"}

            future = self.asyncio_thread.run_coroutine(self._verify_password_async(password))
            result = future.result(timeout=15.0)
            return result

        except Exception as e:
            self.logger.error(f"[TELEGRAM] Password verification error: {e}")
            return {"success": False, "error": str(e)}

    async def _verify_password_async(self, password: str):
        try:
            await self.client.sign_in(password=password)
            self.password_pending = False
            
            # Setup bot connection
            self.bot_peer = await self.client.get_entity('@stickers')
            self.conversation_manager = SimpleConversationManager(self.client, self.bot_peer, self.logger)
            await self.conversation_manager.start_listening()
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}

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

# Flask routes for sticker bot
from flask import request, jsonify

# Create global sticker bot instance
sticker_bot = StickerBotCore()

def register_sticker_routes(app):
    """Register sticker bot routes with the Flask app"""
    
    @app.route('/api/sticker/connect', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def connect_sticker_bot():
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            api_id = data.get('api_id', '')
            api_hash = data.get('api_hash', '')
            phone_number = data.get('phone_number', '')
            process_id = data.get('process_id', '')

            if not all([api_id, api_hash, phone_number]):
                return jsonify({"success": False, "error": "Missing required fields"}), 400

            result = sticker_bot.connect_telegram(api_id, api_hash, phone_number, process_id)
            return jsonify(result)

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route('/api/sticker/verify-code', methods=['POST', 'OPTIONS'], strict_slashes=False)
    def verify_code():
        if request.method == 'OPTIONS':
            return '', 200
            
        try:
            data = request.get_json()
            code = data.get('code', '')

            if not code:
                return jsonify({"success": False, "error": "Code is required"}), 400

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
            password = data.get('password', '')

            if not password:
                return jsonify({"success": False, "error": "Password is required"}), 400

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
            pack_name = data.get('pack_name', '')
            sticker_type = data.get('sticker_type', 'video')
            media_files = data.get('media_files', [])
            process_id = data.get('process_id', '')

            if not pack_name:
                return jsonify({"success": False, "error": "Pack name is required"}), 400

            if not media_files:
                return jsonify({"success": False, "error": "No media files provided"}), 400

            def creation_thread():
                try:
                    sticker_bot.create_sticker_pack(pack_name, sticker_type, media_files, process_id)
                except Exception as e:
                    logging.error(f"Sticker creation error: {e}")

            thread = threading.Thread(target=creation_thread, daemon=True)
            thread.start()

            return jsonify({"success": True, "process_id": process_id})

        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500
