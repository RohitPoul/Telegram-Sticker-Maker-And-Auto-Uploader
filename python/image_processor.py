import os
import subprocess
import logging
import json
from pathlib import Path
from PIL import Image

class ImageProcessor:
    """
    Image processor for Telegram sticker requirements using ImageMagick ONLY
    Requirements:
    - One side exactly 512 pixels, other side 512 or less
    - PNG or WEBP format
    - Maximum file size 512 KB
    - Preserve transparency
    - High quality output
    - ImageMagick is REQUIRED - no fallbacks
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.MAX_FILE_SIZE_KB = 512
        self.TARGET_DIMENSION = 512
        self.SUPPORTED_INPUT_FORMATS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif']
        
        # Check ImageMagick availability and determine command
        self.imagemagick_cmd = None
        self.imagemagick_available = self._check_imagemagick()
        
    def _check_imagemagick(self):
        """Check if ImageMagick is installed and available"""
        # Try 'magick' command first (ImageMagick 7+)
        try:
            result = subprocess.run(
                ['magick', '-version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                self.imagemagick_cmd = 'magick'
                return True
        except (FileNotFoundError, Exception):
            pass
        
        # Try 'convert' command (ImageMagick 6.x)
        try:
            result = subprocess.run(
                ['convert', '-version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                self.imagemagick_cmd = 'convert'
                return True
        except (FileNotFoundError, Exception):
            pass
        
        self.logger.error("[IMAGEMAGICK] ImageMagick not found. Please install ImageMagick.")
        return False
    
    def get_image_metadata(self, image_path):
        """Extract image metadata including dimensions, format, size, and transparency"""
        try:
            # Use PIL for reliable metadata extraction
            with Image.open(image_path) as img:
                width, height = img.size
                format_name = img.format or 'Unknown'
                mode = img.mode
                has_transparency = mode in ('RGBA', 'LA', 'P') or 'transparency' in img.info
                
            file_size_kb = os.path.getsize(image_path) / 1024
            
            metadata = {
                'width': width,
                'height': height,
                'format': format_name,
                'mode': mode,
                'has_transparency': has_transparency,
                'file_size_kb': round(file_size_kb, 2),
                'filename': os.path.basename(image_path)
            }
            
            self.logger.info(f"[METADATA] {os.path.basename(image_path)}: {width}x{height} {format_name}, {file_size_kb:.2f}KB, Transparency: {has_transparency}")
            return metadata
            
        except Exception as e:
            self.logger.error(f"[METADATA] Error reading {image_path}: {e}")
            return None
    
    def calculate_dimensions(self, original_width, original_height):
        """
        Calculate new dimensions following Telegram sticker rules:
        - One side must be exactly 512 pixels
        - Other side can be 512 or less
        - Maintain aspect ratio
        """
        aspect_ratio = original_width / original_height
        
        if original_width >= original_height:
            # Width is larger or equal - set width to 512
            new_width = self.TARGET_DIMENSION
            new_height = int(self.TARGET_DIMENSION / aspect_ratio)
        else:
            # Height is larger - set height to 512
            new_height = self.TARGET_DIMENSION
            new_width = int(self.TARGET_DIMENSION * aspect_ratio)
        
        # Ensure dimensions don't exceed 512
        if new_width > self.TARGET_DIMENSION:
            new_width = self.TARGET_DIMENSION
        if new_height > self.TARGET_DIMENSION:
            new_height = self.TARGET_DIMENSION
            
        # Ensure at least one dimension is exactly 512
        if new_width != self.TARGET_DIMENSION and new_height != self.TARGET_DIMENSION:
            if original_width >= original_height:
                new_width = self.TARGET_DIMENSION
            else:
                new_height = self.TARGET_DIMENSION
        
        self.logger.info(f"[DIMENSIONS] Original: {original_width}x{original_height} -> Target: {new_width}x{new_height}")
        return new_width, new_height
    
    def process_image(self, input_path, output_path, output_format='png', quality=95):
        """
        Process image to meet Telegram sticker requirements using ImageMagick
        
        Args:
            input_path: Path to input image
            output_path: Path to save processed image
            output_format: 'png' or 'webp'
            quality: Quality level (1-100, higher is better)
        
        Returns:
            dict: Processing result with metadata
        """
        try:
            # Get original metadata
            original_metadata = self.get_image_metadata(input_path)
            if not original_metadata:
                return {
                    'success': False,
                    'error': 'Failed to read image metadata'
                }
            
            # Calculate target dimensions
            new_width, new_height = self.calculate_dimensions(
                original_metadata['width'],
                original_metadata['height']
            )
            
            # Determine output format
            output_format = output_format.lower()
            if output_format not in ['png', 'webp']:
                output_format = 'png'
            
            # Ensure output path has correct extension
            output_path = Path(output_path)
            output_path = output_path.with_suffix(f'.{output_format}')
            
            # Use ImageMagick - no fallback, no compromise
            if not self.imagemagick_available:
                return {
                    'success': False,
                    'error': 'ImageMagick is required but not available. Please install ImageMagick.'
                }
            
            self.logger.info(f"[PROCESSING] Converting {os.path.basename(input_path)} to {output_format.upper()} using ImageMagick")
            result = self._process_with_imagemagick(input_path, str(output_path), output_format, quality, new_width, new_height)
            
            if not result['success']:
                return result
            
            # Check if file was created and get final metadata
            if not output_path.exists():
                self.logger.error(f"[PROCESSING] Output file was not created: {output_path}")
                return {
                    'success': False,
                    'error': f'Output file was not created: {output_path}'
                }
            
            final_metadata = self.get_image_metadata(str(output_path))
            
            # Check file size - if over 512KB, reduce quality
            if final_metadata and final_metadata['file_size_kb'] > self.MAX_FILE_SIZE_KB:
                self.logger.warning(f"[SIZE] Output size {final_metadata['file_size_kb']:.2f}KB exceeds {self.MAX_FILE_SIZE_KB}KB, reducing quality")
                
                # Try with lower quality
                reduced_quality = max(50, quality - 20)
                result = self._process_with_imagemagick(input_path, str(output_path), output_format, reduced_quality, new_width, new_height)
                
                if result['success']:
                    final_metadata = self.get_image_metadata(str(output_path))
                    
                    if final_metadata and final_metadata['file_size_kb'] > self.MAX_FILE_SIZE_KB:
                        # If still too large, convert to PNG with maximum compression
                        self.logger.warning(f"[SIZE] Still too large, converting to PNG with maximum compression")
                        result = self._process_with_imagemagick(input_path, str(output_path.with_suffix('.png')), 'png', 50, new_width, new_height)
                        
                        if result['success']:
                            final_metadata = self.get_image_metadata(str(output_path.with_suffix('.png')))
                            output_path = output_path.with_suffix('.png')
            
            self.logger.info(f"[SUCCESS] Processed {os.path.basename(input_path)} -> {final_metadata['file_size_kb']:.2f}KB")
            
            return {
                'success': True,
                'input_path': input_path,
                'output_path': str(output_path),
                'original_metadata': original_metadata,
                'final_metadata': final_metadata,
                'output_format': output_format
            }
            
        except Exception as e:
            self.logger.error(f"[ERROR] Processing failed for {input_path}: {e}")
            import traceback
            self.logger.error(f"[ERROR] Traceback: {traceback.format_exc()}")
            return {
                'success': False,
                'error': str(e)
            }

    def _process_with_imagemagick(self, input_path, output_path, output_format, quality, new_width, new_height):
        """Process image using ImageMagick command line"""
        try:
            # Build ImageMagick command using detected command
            if self.imagemagick_cmd == 'magick':
                # ImageMagick 7+ syntax: magick input [operations] output
                cmd = ['magick', input_path]
            else:
                # ImageMagick 6.x syntax: convert input [operations] output
                cmd = ['convert', input_path]
            
            # Resize image
            cmd.extend(['-resize', f'{new_width}x{new_height}!'])
            
            # Set quality based on format
            if output_format == 'webp':
                cmd.extend(['-quality', str(quality)])
            elif output_format == 'png':
                # PNG quality mapping - INVERTED for consistent user experience:
                # User expects: Higher quality = Larger file size (like WebP)
                # PNG reality: Higher quality = Better compression = Smaller file size
                # So we invert: User quality 50 -> ImageMagick quality 95 (small file)
                #               User quality 95 -> ImageMagick quality 10 (large file)
                if quality <= 50:
                    png_quality = 95  # Small file
                elif quality <= 70:
                    png_quality = 50  # Medium file
                elif quality <= 85:
                    png_quality = 25  # Larger file
                else:
                    png_quality = 10  # Largest file
                cmd.extend(['-quality', str(png_quality)])
            
            # Preserve transparency (use correct syntax)
            cmd.extend(['-alpha', 'set'])
            
            # Output file
            cmd.append(output_path)
            
            self.logger.info(f"[IMAGEMAGICK] Command: {' '.join(cmd)}")
            
            # Execute command
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                self.logger.info(f"[IMAGEMAGICK] Successfully processed {os.path.basename(input_path)}")
                return {'success': True}
            else:
                self.logger.error(f"[IMAGEMAGICK] Command failed: {result.stderr}")
                return {'success': False, 'error': f'ImageMagick command failed: {result.stderr}'}
                
        except subprocess.TimeoutExpired:
            self.logger.error("[IMAGEMAGICK] Command timed out")
            return {'success': False, 'error': 'ImageMagick command timed out'}
        except Exception as e:
            self.logger.error(f"[IMAGEMAGICK] Error: {e}")
            return {'success': False, 'error': str(e)}
    

# Global instance
image_processor = ImageProcessor()