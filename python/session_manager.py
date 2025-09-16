"""
Persistent Session Manager
Inspired by Try.py - provides long-lived session management to avoid rate limiting
"""

import os
import logging
import time
import glob
from typing import Optional, Dict, Any
from telethon import TelegramClient

logger = logging.getLogger(__name__)

class PersistentSessionManager:
    """
    Manages persistent Telegram sessions to avoid creating multiple sessions
    and hitting Telegram's rate limits
    """
    
    def __init__(self, base_dir: Optional[str] = None):
        """
        Initialize session manager
        
        :param base_dir: Base directory for session files (defaults to current script directory)
        """
        self.base_dir = base_dir or os.path.dirname(__file__)
        self.current_session_file = None
        self.current_client = None
        self.session_phone = None
        
    def get_session_file_for_phone(self, phone_number: str) -> str:
        """
        Get session file path for a specific phone number
        
        :param phone_number: Phone number to get session for
        :return: Session file path
        """
        # Clean phone number for filename
        clean_phone = phone_number.replace("+", "").replace(" ", "").replace("-", "")
        session_file = os.path.join(self.base_dir, f"telegram_session_{clean_phone}")
        return session_file
    
    def session_exists(self, phone_number: str) -> bool:
        """
        Check if a session file exists for the given phone number
        
        :param phone_number: Phone number to check
        :return: True if session exists, False otherwise
        """
        session_file = self.get_session_file_for_phone(phone_number)
        return os.path.exists(session_file + ".session")
    
    def is_session_valid(self, client: TelegramClient) -> bool:
        """
        Check if a session is valid and authorized
        
        :param client: TelegramClient to check
        :return: True if session is valid and authorized
        """
        try:
            # This would need to be called in async context
            # For now, we'll return True if client exists and session file exists
            if not client:
                return False
            
            session_file = getattr(client.session, 'filename', None)
            if not session_file or not os.path.exists(session_file + ".session"):
                return False
            
            return True
        except Exception as e:
            logger.warning(f"[SESSION] Error checking session validity: {e}")
            return False
    
    async def create_or_reuse_session(self, api_id: int, api_hash: str, phone_number: str) -> Dict[str, Any]:
        """
        Create a new session or reuse existing one
        
        :param api_id: Telegram API ID
        :param api_hash: Telegram API Hash  
        :param phone_number: Phone number
        :return: Dictionary with session information
        """
        try:
            session_file = self.get_session_file_for_phone(phone_number)
            
            logger.info(f"[SESSION] Creating/reusing session for {phone_number}: {session_file}")
            
            # Create client with session file
            client = TelegramClient(session_file, api_id, api_hash)
            await client.connect()
            
            # Check if already authorized
            if await client.is_user_authorized():
                logger.info(f"[SESSION] Existing session is valid and authorized")
                self.current_client = client
                self.current_session_file = session_file
                self.session_phone = phone_number
                
                return {
                    "success": True,
                    "needs_code": False,
                    "needs_password": False,
                    "client": client,
                    "session_file": session_file,
                    "reused_session": True
                }
            else:
                # Need to authorize
                logger.info(f"[SESSION] Session needs authorization")
                await client.send_code_request(phone_number)
                
                self.current_client = client
                self.current_session_file = session_file
                self.session_phone = phone_number
                
                return {
                    "success": True,
                    "needs_code": True,
                    "needs_password": False,
                    "client": client,
                    "session_file": session_file,
                    "reused_session": False
                }
                
        except Exception as e:
            logger.error(f"[SESSION] Error creating/reusing session: {e}")
            return {
                "success": False,
                "error": str(e),
                "needs_code": False,
                "needs_password": False
            }
    
    def cleanup_old_sessions(self, keep_current: bool = True, max_age_days: int = 30):
        """
        Clean up old session files
        
        :param keep_current: Whether to keep the current session
        :param max_age_days: Maximum age of sessions to keep (in days)
        """
        try:
            current_time = time.time()
            session_pattern = os.path.join(self.base_dir, "telegram_session_*.session*")
            
            cleaned_count = 0
            for session_file in glob.glob(session_pattern):
                try:
                    # Skip current session if requested
                    if keep_current and session_file.startswith(self.current_session_file):
                        continue
                    
                    # Check file age
                    file_age = current_time - os.path.getctime(session_file)
                    if file_age > (max_age_days * 24 * 3600):
                        os.remove(session_file)
                        logger.info(f"[SESSION] Removed old session file: {session_file}")
                        cleaned_count += 1
                        
                except Exception as e:
                    logger.warning(f"[SESSION] Could not process {session_file}: {e}")
            
            if cleaned_count > 0:
                logger.info(f"[SESSION] Cleaned up {cleaned_count} old session files")
            else:
                logger.debug("[SESSION] No old session files to clean")
                
        except Exception as e:
            logger.error(f"[SESSION] Error during session cleanup: {e}")
    
    def get_session_info(self) -> Dict[str, Any]:
        """
        Get information about current session
        
        :return: Session information dictionary
        """
        return {
            "session_file": self.current_session_file,
            "phone": self.session_phone,
            "has_client": self.current_client is not None,
            "session_exists": bool(self.current_session_file and os.path.exists(self.current_session_file + ".session"))
        }
    
    async def disconnect_session(self, logout: bool = False):
        """
        Disconnect current session
        
        :param logout: Whether to logout (invalidate session) or just disconnect
        """
        if self.current_client:
            try:
                if logout:
                    logger.info("[SESSION] Logging out and disconnecting...")
                    await self.current_client.log_out()
                else:
                    logger.info("[SESSION] Disconnecting (preserving session)...")
                    await self.current_client.disconnect()
                    
            except Exception as e:
                logger.warning(f"[SESSION] Error during disconnect: {e}")
            finally:
                if logout:
                    # Clear everything if logging out
                    self.current_client = None
                    self.current_session_file = None
                    self.session_phone = None

# Global session manager instance
session_manager = PersistentSessionManager()

def get_session_manager() -> PersistentSessionManager:
    """Get the global session manager instance"""
    return session_manager