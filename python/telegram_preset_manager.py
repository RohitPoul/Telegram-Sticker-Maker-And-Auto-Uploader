"""
Telegram Credentials Preset Manager
Manages multiple Telegram account credentials with named presets
"""
import os
import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

class TelegramPresetManager:
    def __init__(self):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(base_dir)
        self.config_dir = os.path.join(project_root, '.config')
        os.makedirs(self.config_dir, exist_ok=True)
        
        self.presets_file = os.path.join(self.config_dir, 'telegram_presets.json')
        self.presets = self._load_presets()
        
    def _load_presets(self):
        try:
            if os.path.exists(self.presets_file):
                with open(self.presets_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load presets: {e}")
        return {}
    
    def _save_presets(self):
        try:
            with open(self.presets_file, 'w') as f:
                json.dump(self.presets, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save presets: {e}")
    
    def list_presets(self):
        return list(self.presets.keys())
    
    def save_preset(self, name, api_id, api_hash, phone):
        if not name or not name.strip():
            raise ValueError("Preset name required")
        
        self.presets[name] = {
            'api_id': str(api_id),
            'api_hash': str(api_hash),
            'phone_number': str(phone),
            'updated_at': datetime.now().isoformat()
        }
        self._save_presets()
        return {'success': True, 'message': f'Preset "{name}" saved'}
    
    def load_preset(self, name):
        if name not in self.presets:
            raise ValueError(f'Preset "{name}" not found')
        return self.presets[name]
    
    def delete_preset(self, name):
        if name not in self.presets:
            raise ValueError(f'Preset "{name}" not found')
        del self.presets[name]
        self._save_presets()
        return {'success': True, 'message': f'Preset "{name}" deleted'}

preset_manager = TelegramPresetManager()
