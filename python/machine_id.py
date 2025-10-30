import os
import uuid
import platform
import json
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

class MachineIDManager:
    """Generate and manage unique machine ID for analytics"""
    
    def __init__(self):
        # Store machine ID in a hidden config file
        base_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(base_dir)
        self.config_dir = os.path.join(project_root, '.config')
        self.machine_id_file = os.path.join(self.config_dir, 'machine_id.json')
        
        # Ensure config directory exists
        os.makedirs(self.config_dir, exist_ok=True)
        
        # Load or generate machine ID
        self.machine_id = self._load_or_generate_machine_id()
        self.system_info = self._get_system_info()
    
    def _load_or_generate_machine_id(self):
        """Load existing machine ID or generate a new one"""
        try:
            if os.path.exists(self.machine_id_file):
                with open(self.machine_id_file, 'r') as f:
                    data = json.load(f)
                    machine_id = data.get('machine_id')
                    if machine_id:
                        logger.info(f"Loaded existing machine ID: {machine_id}")
                        return machine_id
        except Exception as e:
            logger.warning(f"Could not load machine ID: {e}")
        
        # Generate new machine ID
        machine_id = str(uuid.uuid4())
        self._save_machine_id(machine_id)
        logger.info(f"Generated new machine ID: {machine_id}")
        return machine_id
    
    def _save_machine_id(self, machine_id):
        """Save machine ID to file"""
        try:
            data = {
                'machine_id': machine_id,
                'created_at': self._get_timestamp()
            }
            with open(self.machine_id_file, 'w') as f:
                json.dump(data, f, indent=2)
            logger.info(f"Saved machine ID to {self.machine_id_file}")
        except Exception as e:
            logger.error(f"Failed to save machine ID: {e}")
    
    def _get_system_info(self):
        """Get system information"""
        try:
            return {
                'os_name': platform.system(),
                'os_version': platform.version(),
                'os_release': platform.release(),
                'architecture': platform.machine(),
                'processor': platform.processor(),
                'platform': platform.platform()
            }
        except Exception as e:
            logger.error(f"Failed to get system info: {e}")
            return {
                'os_name': 'Unknown',
                'architecture': 'Unknown'
            }
    
    def _get_timestamp(self):
        """Get current timestamp in ISO format"""
        from datetime import datetime
        return datetime.utcnow().isoformat()
    
    def get_machine_id(self):
        """Get the machine ID"""
        return self.machine_id
    
    def get_system_info(self):
        """Get system information"""
        return self.system_info
    
    def get_full_info(self):
        """Get machine ID and system info combined"""
        return {
            'machine_id': self.machine_id,
            **self.system_info
        }

# Global instance
machine_id_manager = MachineIDManager()
