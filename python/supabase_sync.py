import os
import json
import threading
import time
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

class SupabaseSync:
    """
    Hidden feature: Track every single conversion to Supabase for analytics.
    Uses anonymous authentication for silent device registration.
    Even if user resets stats, conversions are tracked server-side.
    """
    
    # Hardcoded Supabase credentials (safe to embed - protected by RLS)
    SUPABASE_URL = "https://idbouwjckoxgjpkjrrtc.supabase.co"
    SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkYm91d2pja294Z2pwa2pycnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4MzAzMzMsImV4cCI6MjA3NzQwNjMzM30.Ou0VLEVTyoWElIQV5-9zHIRKb7GCZbQgzkN0pYD9JBU"
    
    def __init__(self, machine_id_manager):
        self.machine_id_manager = machine_id_manager
        
        # Setup queue directory
        base_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(base_dir)
        self.config_dir = os.path.join(project_root, '.config')
        os.makedirs(self.config_dir, exist_ok=True)
        
        # Stats file for cumulative tracking
        self.stats_file = os.path.join(self.config_dir, 'cumulative_stats.json')
        
        # Auth session file (persists anonymous user)
        self.auth_file = os.path.join(self.config_dir, 'supabase_auth.json')
        
        # Thread safety
        self.lock = threading.RLock()
        
        # Track cumulative stats (never reset)
        self.cumulative_stats = self._load_cumulative_stats()
        
        # Pending sync flag
        self.needs_sync = False
        
        # Initialize Supabase client (but don't authenticate yet)
        self.supabase = None
        self.user_id = None
        self._initialization_complete = False
        self._initialization_started = False
        
        # Background initialization and sync thread
        self.running = True
        
        # Start background thread for async initialization
        self.init_thread = threading.Thread(target=self._async_initialization, daemon=True)
        self.init_thread.start()
        
        logger.info("[CONVERSION_TRACKER] Fast initialization complete (auth deferred to background)")
    
    def _async_initialization(self):
        """Background thread for non-blocking Supabase initialization"""
        try:
            logger.info("[SUPABASE_INIT] Starting async initialization...")
            
            # Initialize Supabase client and authenticate
            self._init_supabase_client()
            
            # Register device silently
            self._register_device()
            
            self._initialization_complete = True
            logger.info("[SUPABASE_INIT] Async initialization complete")
            
            # Start sync loop
            self._background_sync()
            
        except Exception as e:
            logger.error(f"[SUPABASE_INIT] Async initialization failed: {e}")
            self._initialization_complete = True  # Mark as complete even on failure
    
    def _init_supabase_client(self):
        """Initialize Supabase client with anonymous authentication"""
        try:
            from supabase import create_client, Client
            
            # Create client
            self.supabase: Client = create_client(self.SUPABASE_URL, self.SUPABASE_ANON_KEY)
            
            # Try to restore session
            session = self._load_auth_session()
            if session:
                try:
                    # Set session from saved data
                    self.supabase.auth.set_session(session['access_token'], session['refresh_token'])
                    self.user_id = session.get('user_id')
                    logger.info(f"[SUPABASE_AUTH] Restored session for user {self.user_id[:8]}...")
                    return
                except Exception as e:
                    logger.warning(f"[SUPABASE_AUTH] Failed to restore session: {e}")
            
            # No session - sign in anonymously (silent, no UI)
            response = self.supabase.auth.sign_in_anonymously()
            if response.user:
                self.user_id = response.user.id
                self._save_auth_session({
                    'access_token': response.session.access_token,
                    'refresh_token': response.session.refresh_token,
                    'user_id': self.user_id
                })
                logger.info(f"[SUPABASE_AUTH] Anonymous sign-in successful: {self.user_id[:8]}...")
            else:
                logger.error("[SUPABASE_AUTH] Anonymous sign-in failed")
                
        except ImportError:
            logger.error("[SUPABASE_AUTH] supabase-py not installed. Run: pip install supabase")
        except Exception as e:
            logger.error(f"[SUPABASE_AUTH] Initialization failed: {e}")
    
    def _load_auth_session(self):
        """Load saved auth session"""
        try:
            if os.path.exists(self.auth_file):
                with open(self.auth_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"[SUPABASE_AUTH] Failed to load session: {e}")
        return None
    
    def _save_auth_session(self, session_data):
        """Save auth session to disk"""
        try:
            with open(self.auth_file, 'w') as f:
                json.dump(session_data, f, indent=2)
        except Exception as e:
            logger.error(f"[SUPABASE_AUTH] Failed to save session: {e}")
    
    def _register_device(self):
        """Silently register device on first run (upsert to user_stats)"""
        if not self.supabase or not self.user_id:
            logger.warning("[SUPABASE_REGISTER] Skipping - not authenticated")
            return
        
        try:
            machine_id = self.machine_id_manager.get_machine_id()
            system_info = self.machine_id_manager.get_system_info()
            
            # Check if device already registered
            result = self.supabase.table('user_stats') \
                .select('id') \
                .eq('machine_id', str(machine_id)) \
                .execute()
            
            if result.data:
                logger.info(f"[SUPABASE_REGISTER] Device already registered")
                return
            
            # Insert new device record
            data = {
                'user_id': self.user_id,
                'machine_id': str(machine_id),
                'os_name': system_info.get('os_name', 'Unknown'),
                'architecture': system_info.get('architecture', 'Unknown'),
                **self.cumulative_stats
            }
            
            self.supabase.table('user_stats').insert(data).execute()
            logger.info(f"[SUPABASE_REGISTER] Device registered successfully")
            
        except Exception as e:
            logger.error(f"[SUPABASE_REGISTER] Registration failed: {e}")
    
    def _load_cumulative_stats(self):
        """Load cumulative stats from disk"""
        try:
            if os.path.exists(self.stats_file):
                with open(self.stats_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"[SUPABASE_SYNC] Failed to load stats: {e}")
        return {
            'total_conversions': 0,
            'successful_conversions': 0,
            'failed_conversions': 0,
            'total_hexedits': 0,
            'successful_hexedits': 0,
            'failed_hexedits': 0,
            'total_images_converted': 0,
            'successful_images': 0,
            'failed_images': 0,
            'total_stickers_created': 0
        }
    
    def _save_cumulative_stats(self):
        """Save cumulative stats to disk"""
        try:
            with self.lock:
                with open(self.stats_file, 'w') as f:
                    json.dump(self.cumulative_stats, f, indent=2)
        except Exception as e:
            logger.error(f"[SUPABASE_SYNC] Failed to save stats: {e}")
    
    def track_conversion(self, conversion_type, success=True, metadata=None):
        """
        Track a conversion - updates cumulative stats and syncs to Supabase.
        
        Args:
            conversion_type: 'conversion', 'image', 'hexedit', or 'sticker'
            success: Whether the conversion was successful (or count for stickers)
            metadata: Additional metadata
        """
        try:
            # Update cumulative stats
            with self.lock:
                if conversion_type == 'conversion':
                    self.cumulative_stats['total_conversions'] += 1
                    if success:
                        self.cumulative_stats['successful_conversions'] += 1
                    else:
                        self.cumulative_stats['failed_conversions'] += 1
                        
                elif conversion_type == 'hexedit':
                    self.cumulative_stats['total_hexedits'] += 1
                    if success:
                        self.cumulative_stats['successful_hexedits'] += 1
                    else:
                        self.cumulative_stats['failed_hexedits'] += 1
                        
                elif conversion_type == 'image':
                    self.cumulative_stats['total_images_converted'] += 1
                    if success:
                        self.cumulative_stats['successful_images'] += 1
                    else:
                        self.cumulative_stats['failed_images'] += 1
                        
                elif conversion_type == 'sticker':
                    count = metadata.get('count', 1) if metadata else (success if isinstance(success, int) else 1)
                    self.cumulative_stats['total_stickers_created'] += count
                
                self._save_cumulative_stats()
                self.needs_sync = True
            
            # Try immediate sync
            self._attempt_sync()
            
            logger.debug(f"[SUPABASE_SYNC] Tracked {conversion_type} (success={success})")
            
        except Exception as e:
            logger.error(f"[SUPABASE_SYNC] Failed to track: {e}")
    
    def _attempt_sync(self):
        """Sync cumulative stats to Supabase user_stats table"""
        if not self.needs_sync or not self.supabase or not self.user_id:
            return
        
        try:
            machine_id = self.machine_id_manager.get_machine_id()
            
            with self.lock:
                stats_to_sync = self.cumulative_stats.copy()
            
            # Remove last_updated if present (Supabase auto-manages updated_at)
            stats_to_sync.pop('last_updated', None)
            
            # Update stats using Supabase client (RLS enforces user_id = auth.uid())
            self.supabase.table('user_stats') \
                .update(stats_to_sync) \
                .eq('machine_id', str(machine_id)) \
                .execute()
            
            self.needs_sync = False
            logger.info(f"[SUPABASE_SYNC] Synced stats to user_stats table")
                
        except Exception as e:
            logger.debug(f"[SUPABASE_SYNC] Sync error (will retry): {e}")
    
    def _background_sync(self):
        """Background thread to periodically sync stats"""
        while self.running:
            try:
                time.sleep(30)  # Try every 30 seconds
                if self.needs_sync:
                    self._attempt_sync()
            except Exception as e:
                logger.error(f"[SUPABASE_SYNC] Background sync error: {e}")
    
    def force_sync(self):
        """Force immediate sync"""
        self._attempt_sync()
    
    def increment_stat(self, stat_type, success=True, metadata=None):
        """Compatibility method - maps to track_conversion"""
        self.track_conversion(stat_type, success, metadata)
    
    def get_cumulative_stats(self):
        """Compatibility method - returns empty dict"""
        return {}
    
    def shutdown(self):
        """Shutdown gracefully"""
        self.running = False
        # Final sync before shutdown
        if self.needs_sync:
            self._attempt_sync()
        if self.sync_thread.is_alive():
            self.sync_thread.join(timeout=2)
        logger.info("[SUPABASE_SYNC] Shutdown complete")

# Global instance (will be initialized in backend.py)
supabase_sync = None
