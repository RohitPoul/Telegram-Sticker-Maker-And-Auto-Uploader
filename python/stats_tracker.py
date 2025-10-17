import os
import json
import threading
import time
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

class StatisticsTracker:
    def __init__(self):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        # Fix path: stats.json is in logs/ directory relative to project root, not python/../logs/
        project_root = os.path.dirname(base_dir)  # Go up from python/ to project root
        logs_dir = os.path.join(project_root, 'logs')
        os.makedirs(logs_dir, exist_ok=True)
        self.stats_file = Path(os.path.join(logs_dir, 'stats.json'))
        self.lock = threading.Lock()
        self.stats_cache = None
        self.last_read_time = 0
        self.CACHE_TIMEOUT = 10  # Cache stats for 10 seconds to reduce I/O
        
        # Ensure initial stats file exists
        self.initialize_stats_file()

    def get_default_stats(self):
        """Get default statistics structure."""
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
            "total_stickers_created": 0
        }

    def initialize_stats_file(self):
        """Ensure stats file exists with default values."""
        try:
            if not self.stats_file.exists():
                default_stats = self.get_default_stats()
                with open(self.stats_file, 'w') as f:
                    json.dump(default_stats, f, indent=2)
                logger.info(f"Created stats file: {self.stats_file}")
        except Exception as e:
            logger.error(f"Failed to initialize stats file: {e}")

    def load_stats(self):
        """Load stats from file, with caching to prevent multiple reads."""
        current_time = time.time()
        
        # Use cached stats if within timeout
        if (self.stats_cache is not None and 
            current_time - self.last_read_time < self.CACHE_TIMEOUT):
            return self.stats_cache

        try:
            with self.lock:
                with open(self.stats_file, 'r') as f:
                    stats = json.load(f)
                
                # Update cache
                self.stats_cache = stats
                self.last_read_time = current_time
                
                return stats
        except FileNotFoundError:
            self.initialize_stats_file()
            return self.load_stats()
        except Exception as e:
            logger.error(f"Could not load stats: {e}")
            return self.get_default_stats()

    def save_stats(self, stats):
        """Save stats to file."""
        try:
            with self.lock:
                with open(self.stats_file, 'w') as f:
                    json.dump(stats, f, indent=2)
                # Update cache without debug logging
                self.stats_cache = stats
                self.last_read_time = time.time()
        except Exception as e:
            logger.error(f"Could not save stats to {self.stats_file}: {e}")

    def increment_conversion(self, success=True):
        """Increment conversion stats."""
        stats = self.load_stats()
        before_total = stats.get("total_conversions", 0)
        before_ok = stats.get("successful_conversions", 0)
        before_fail = stats.get("failed_conversions", 0)
        stats["total_conversions"] = before_total + 1
        if success:
            stats["successful_conversions"] = before_ok + 1
        else:
            stats["failed_conversions"] = before_fail + 1
        self.save_stats(stats)
        logger.info(
            f"[STATS] conversion +1 ({'success' if success else 'fail'}) → totals: "
            f"total={stats['total_conversions']} ok={stats['successful_conversions']} fail={stats['failed_conversions']} "
            f"(@ {self.stats_file})"
        )

    def increment_hexedit(self, success=True):
        """Increment hex edit stats."""
        stats = self.load_stats()
        before_total = stats.get("total_hexedits", 0)
        before_ok = stats.get("successful_hexedits", 0)
        before_fail = stats.get("failed_hexedits", 0)
        stats["total_hexedits"] = before_total + 1
        if success:
            stats["successful_hexedits"] = before_ok + 1
        else:
            stats["failed_hexedits"] = before_fail + 1
        self.save_stats(stats)
        logger.info(
            f"[STATS] hexedit +1 ({'success' if success else 'fail'}) → totals: "
            f"total={stats['total_hexedits']} ok={stats['successful_hexedits']} fail={stats['failed_hexedits']} "
            f"(@ {self.stats_file})"
        )

    def increment_image_conversion(self, success=True):
        """Increment image conversion stats."""
        stats = self.load_stats()
        before_total = stats.get("total_images_converted", 0)
        before_ok = stats.get("successful_images", 0)
        before_fail = stats.get("failed_images", 0)
        stats["total_images_converted"] = before_total + 1
        if success:
            stats["successful_images"] = before_ok + 1
        else:
            stats["failed_images"] = before_fail + 1
        self.save_stats(stats)
        logger.info(
            f"[STATS] image +1 ({'success' if success else 'fail'}) → totals: "
            f"total={stats['total_images_converted']} ok={stats['successful_images']} fail={stats['failed_images']} "
            f"(@ {self.stats_file})"
        )

    def increment_stickers(self, count=1):
        """Increment sticker creation stats."""
        stats = self.load_stats()
        before = stats.get("total_stickers_created", 0)
        stats["total_stickers_created"] = before + max(int(count), 0)
        self.save_stats(stats)
        logger.info(
            f"[STATS] stickers +{max(int(count), 0)} → total_stickers_created={stats['total_stickers_created']} (@ {self.stats_file})"
        )

    def get_stats(self):
        """Get current stats without session/uptime fields; strip legacy keys if present."""
        try:
            stats = self.load_stats()
            # Strip legacy keys
            if isinstance(stats, dict):
                stats.pop("session_started", None)
                stats.pop("uptime_seconds", None)
            # Ensure all expected keys exist
            for key in [
                "total_conversions", "successful_conversions", "failed_conversions",
                "total_hexedits", "successful_hexedits", "failed_hexedits",
                "total_images_converted", "successful_images", "failed_images",
                "total_stickers_created"
            ]:
                if key not in stats:
                    stats[key] = 0
            return stats
        except Exception as e:
            logger.error(f"[STATS] Error retrieving stats: {e}")
            default_stats = self.get_default_stats()
            try:
                self.save_stats(default_stats)
            except Exception as save_error:
                logger.error(f"[STATS] Failed to save default stats: {save_error}")
            return default_stats

    def reset_stats(self):
        """Reset all stats."""
        stats = {
            "total_conversions": 0, 
            "successful_conversions": 0, 
            "failed_conversions": 0,
            "total_hexedits": 0, 
            "successful_hexedits": 0, 
            "failed_hexedits": 0,
            "total_images_converted": 0,
            "successful_images": 0,
            "failed_images": 0,
            "total_stickers_created": 0
        }
        self.save_stats(stats)

# Global instance
stats_tracker = StatisticsTracker()
