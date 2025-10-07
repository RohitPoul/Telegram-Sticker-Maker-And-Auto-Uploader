import os
import subprocess
import logging
import json
from pathlib import Path
from PIL import Image
import io

class ImageProcessor:
    """
    Image processor for Telegram sticker requirements using ImageMagick
    Requirements:
    - One side exactly 512 pixels, other side 512 or less
    - PNG or WEBP format
    - Maximum file size 512 KB
    - Preserve transparency
    - High quality output
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.MAX_FILE_SIZE_KB = 512
        self.TARGET_DIMENSION = 512
        self.SUPPORTED_INPUT_FORMATS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif']
        
        # Check ImageMagick availability
        self.imagemagick_available = self._check_imagemagick()
        
    def _check_imagemagick(self):
        """Check if ImageMagick is installed and available"""
        try:
            result = subprocess.run(
                ['magick', '-version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                self.logger.info("[IMAGEMAGICK] ImageMagick is available")
                return True
            else:
                self.logger.warning("[IMAGEMAGICK] ImageMagick found but version check failed")
                return False
        except FileNotFoundError:
            # Try 'convert' command (older ImageMagick versions)
            try:
                result = subprocess.run(
                    ['convert', '-version'],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    self.logger.info("[IMAGEMAGICK] ImageMagick (convert) is available")
                    return True
            except:
                pass
            self.logger.error("[IMAGEMAGICK] ImageMagick not found. Please install ImageMagick.")
            return False
        except Exception as e:
            self.logger.error(f"[IMAGEMAGICK] Error checking ImageMagick: {e}")
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
        Process image to meet Telegram sticker requirements using PIL/Pillow
        This avoids subprocess issues by using pure Python image processing
        
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
            
            # Process image using PIL/Pillow
            self.logger.info(f"[PROCESSING] Converting {os.path.basename(input_path)} to {output_format.upper()} using PIL")
            self.logger.info(f"[PROCESSING] Target dimensions: {new_width}x{new_height}")
            
            from PIL import Image
            
            # Open and resize image
            with Image.open(input_path) as img:
                # Resize image
                resized_img = img.resize((new_width, new_height), Image.LANCZOS)
                
                # Handle transparency
                if resized_img.mode in ('RGBA', 'LA') or (resized_img.mode == 'P' and 'transparency' in resized_img.info):
                    # Ensure we have an alpha channel
                    if resized_img.mode != 'RGBA':
                        resized_img = resized_img.convert('RGBA')
                else:
                    # Convert to RGB if no transparency
                    resized_img = resized_img.convert('RGB')
                
                # Save image with appropriate settings
                save_kwargs = {}
                if output_format == 'png':
                    save_kwargs.update({
                        'optimize': True,
                        'compress_level': 9
                    })
                elif output_format == 'webp':
                    save_kwargs.update({
                        'quality': quality,
                        'method': 6,
                        'lossless': False
                    })
                
                # Save the image
                resized_img.save(str(output_path), format=output_format.upper(), **save_kwargs)
            
            # Check if file was created and get final metadata
            self.logger.info(f"[PROCESSING] Checking if output file was created: {output_path}")
            self.logger.info(f"[PROCESSING] Output file exists: {os.path.exists(output_path)}")
            
            if not output_path.exists():
                self.logger.error(f"[PROCESSING] Output file was not created: {output_path}")
                return {
                    'success': False,
                    'error': f'Output file was not created: {output_path}'
                }
            
            final_metadata = self.get_image_metadata(str(output_path))
            
            # Check file size - if over 512KB, reduce quality (for WebP only)
            if final_metadata and final_metadata['file_size_kb'] > self.MAX_FILE_SIZE_KB:
                if output_format == 'webp':
                    self.logger.warning(f"[SIZE] Output size {final_metadata['file_size_kb']:.2f}KB exceeds {self.MAX_FILE_SIZE_KB}KB, reducing quality")
                    # Try with lower quality
                    with Image.open(input_path) as img:
                        resized_img = img.resize((new_width, new_height), Image.LANCZOS)
                        if resized_img.mode in ('RGBA', 'LA') or (resized_img.mode == 'P' and 'transparency' in resized_img.info):
                            if resized_img.mode != 'RGBA':
                                resized_img = resized_img.convert('RGBA')
                        else:
                            resized_img = resized_img.convert('RGB')
                        
                        # Save with lower quality
                        resized_img.save(str(output_path), format='WEBP', quality=50, method=6, lossless=False)
                    
                    final_metadata = self.get_image_metadata(str(output_path))
                    
                    if final_metadata and final_metadata['file_size_kb'] > self.MAX_FILE_SIZE_KB:
                        # If still too large, convert to PNG
                        self.logger.warning(f"[SIZE] WebP still too large, converting to PNG")
                        with Image.open(input_path) as img:
                            resized_img = img.resize((new_width, new_height), Image.LANCZOS)
                            if resized_img.mode in ('RGBA', 'LA') or (resized_img.mode == 'P' and 'transparency' in resized_img.info):
                                if resized_img.mode != 'RGBA':
                                    resized_img = resized_img.convert('RGBA')
                            else:
                                resized_img = resized_img.convert('RGB')
                            
                            output_path = output_path.with_suffix('.png')
                            resized_img.save(str(output_path), format='PNG', optimize=True, compress_level=9)
                        
                        final_metadata = self.get_image_metadata(str(output_path))
                else:
                    # For PNG, we've already used maximum compression
                    self.logger.warning(f"[SIZE] PNG output size {final_metadata['file_size_kb']:.2f}KB exceeds {self.MAX_FILE_SIZE_KB}KB but cannot reduce further")
            
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
    
    def process_batch(self, input_files, output_dir, output_format='png', quality=95, progress_callback=None):
        """
        Process multiple images in batch
        
        Args:
            input_files: List of input file paths
            output_dir: Directory to save processed images
            output_format: 'png' or 'webp'
            quality: Quality level (1-100)
            progress_callback: Optional callback function(current, total, result)
        
        Returns:
            list: List of processing results
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        results = []
        total = len(input_files)
        
        for idx, input_file in enumerate(input_files):
            self.logger.info(f"[BATCH] Processing {idx + 1}/{total}: {os.path.basename(input_file)}")
            
            # Generate output filename
            input_path = Path(input_file)
            output_filename = f"{input_path.stem}_processed.{output_format}"
            output_path = output_dir / output_filename
            
            # Process image
            result = self.process_image(input_file, str(output_path), output_format, quality)
            results.append(result)
            
            # Call progress callback if provided
            if progress_callback:
                progress_callback(idx + 1, total, result)
        
        self.logger.info(f"[BATCH] Completed: {sum(1 for r in results if r['success'])}/{total} successful")
        return results


# Global instance
image_processor = ImageProcessor()
