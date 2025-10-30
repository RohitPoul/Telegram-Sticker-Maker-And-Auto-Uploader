import os
import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

class SupabaseSync:
    """Sync user statistics to Supabase for analytics"""
    
    def __init__(self, machine_id_manager):
        self.machine_id_manager = machine_id_manager
        self.supabase_url = os.getenv('SUPABASE_URL', '')
        self.supabase_key = os.getenv('SUPABASE_KEY', '')
        self.enabled = bool(self.supabase_url and self.supabase_key)
        
        # Cumulative stats file (never reset)
        base_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(base_dir)
        self.config_dir = os.path.join(project_root, '.config')
        os.makedirs(self.config_dir, exist_ok=True)
        self.cumulative_stats_file = os.path.join(self.config_dir, 'cumulative_stats.json')
        
        # Lock for thread safety
        self.lock = threading.Lock()
        
        # Load cumulative stats
        self.cumulative_stats = self._load_cumulative_stats()
        
        # Sync queue for batching updates
        self.sync_queue = []
        self.last_sync_time = 0
        self.sync_interval = 30  # Sync every 30 seconds
        
        if self.enabled:
            logger.info("Supabase sync enabled")
            # Start background sync thread
            self.sync_thread = threading.Thread(target=self._background_sync, daemon=True)
            self.sync_thread.start()
        else:
            logger.warning("Supabase sync disabled - missing SUPABASE_URL or SUPABASE_KEY")
    
    def _load_cumulative_stats(self):
        """Load cumulative stats from file"""
        try:
            if os.path.exists(self.cumulative_stats_file):
                with open(self.cumulative_stats_file, 'r') as f:
                    stats = json.load(f)
                    logger.info(f"Loaded cumulative stats: {stats}")
                    return stats
        except Exception as e:
            logger.warning(f"Could not load cumulative stats: {e}")
        
        # Return default stats
        return self._get_default_stats()
    
    def _get_default_stats(self):
        """Get default cumulative stats structure"""
        return {
            "total_conversions": 0,
            "successful_conversions": 0,
            "failed_conversions": 0,
            "total_hexedits": 0,
            "successful_hexedits": 0,
            "failed_hexedits": 0,
            "total_images_converted": 0,
            "successful_images": 0,
            "failed_images": 0,
            "total_stickers_created": 0,
            "last_updated": None
        }
    
    def _save_cumulative_stats(self):
        """Save cumulative stats to file"""
        try:
            with self.lock:
                self.cumulative_stats['last_updated'] = datetime.utcnow().isoformat()
                with open(self.cumulative_stats_file, 'w') as f:
                    json.dump(self.cumulative_stats, f, indent=2)
                logger.debug(f"Saved cumulative stats to {self.cumulative_stats_file}")
        except Exception as e:
            logger.error(f"Failed to save cumulative stats: {e}")
    
    def increment_stat(self, stat_type, success=True):
        """
        Increment a cumulative stat
        stat_type: 'conversion', 'hexedit', 'image', or 'sticker'
        """
        with self.lock:
            if stat_type == 'conversion':
                self.cumulative_stats['total_conversions'] += 1
                if success:
                    self.cumulative_stats['successful_conversions'] += 1
                else:
                    self.cumulative_stats['failed_conversions'] += 1
            
            elif stat_type == 'hexedit':
                self.cumulative_stats['total_hexedits'] += 1
                if success:
                    self.cumulative_stats['successful_hexedits'] += 1
                else:
                    self.cumulative_stats['failed_hexedits'] += 1
            
            elif stat_type == 'image':
                self.cumulative_stats['total_images_converted'] += 1
                if success:
                    self.cumulative_stats['successful_images'] += 1
                else:
                    self.cumulative_stats['failed_images'] += 1
            
            elif stat_type == 'sticker':
                count = success if isinstance(success, int) else 1
                self.cumulative_stats['total_stickers_created'] += count
            
            # Save to file
            self._save_cumulative_stats()
            
            # Queue for sync
            if self.enabled:
                self.sync_queue.append({
                    'type': stat_type,
                    'success': success,
                    'timestamp': datetime.utcnow().isoformat()
                })
    
    def _background_sync(self):
        """Background thread to sync stats to Supabase"""
        while True:
            try:
                time.sleep(self.sync_interval)
                
                # Check if there are updates to sync
                if len(self.sync_queue) > 0 or (time.time() - self.last_sync_time) > 300:
                    self._sync_to_supabase()
                    
            except Exception as e:
                logger.error(f"Error in background sync: {e}")
    
    def _sync_to_supabase(self):
        """Sync cumulative stats to Supabase"""
        if not self.enabled:
            return
        
        try:
            import requests
            
            machine_id = self.machine_id_manager.get_machine_id()
            system_info = self.machine_id_manager.get_system_info()
            
            # Prepare data for Supabase
            data = {
                'machine_id': machine_id,
                'os_name': system_info.get('os_name', 'Unknown'),
                'architecture': system_info.get('architecture', 'Unknown'),
                'os_version': system_info.get('os_version', ''),
                'platform': system_info.get('platform', ''),
                **self.cumulative_stats
            }
            
            # Remove last_updated from the data sent to Supabase (it has its own timestamp)
            data.pop('last_updated', None)
            
            # Upsert to Supabase (insert or update)
            headers = {
                'apikey': self.supabase_key,
                'Authorization': f'Bearer {self.supabase_key}',
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            }
            
            url = f"{self.supabase_url}/rest/v1/user_stats"
            
            response = requests.post(url, json=data, headers=headers, timeout=10)
            
            if response.status_code in [200, 201]:
                logger.info(f"Successfully synced stats to Supabase for machine {machine_id}")
                self.last_sync_time = time.time()
                # Clear sync queue
                with self.lock:
                    self.sync_queue.clear()
            else:
                logger.error(f"Failed to sync to Supabase: {response.status_code} - {response.text}")
                
        except Exception as e:
            logger.error(f"Error syncing to Supabase: {e}")
    
    def force_sync(self):
        """Force immediate sync to Supabase"""
        if self.enabled:
            self._sync_to_supabase()
    
    def get_cumulative_stats(self):
        """Get current cumulative stats"""
        with self.lock:
            return self.cumulative_stats.copy()

# Global instance will be initialized in backend.py
supabase_sync = None
