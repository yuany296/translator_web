from __future__ import annotations

from ..dependencies import runtime

def create_ocr_image_variants(image_bytes: bytes, mode: str) -> list[dict[str, runtime.Any]]:
    variants = [{'name': 'original', 'path': runtime.write_temp_image_bytes(image_bytes), 'scale': 1.0}]
    if mode != 'enhanced':
        return variants
    try:
        image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
    except Exception:
        return variants
    enhanced = runtime.build_enhanced_grayscale_image(image, invert=False)
    inverted = runtime.build_enhanced_grayscale_image(image, invert=True)
    binary_text = runtime.build_binary_text_image(image)
    variants.append({'name': 'gray_contrast_2x', 'path': runtime.write_temp_pil_image(enhanced), 'scale': runtime.OCR_PREPROCESS_SCALE})
    variants.append({'name': 'inverted_contrast_2x', 'path': runtime.write_temp_pil_image(inverted), 'scale': runtime.OCR_PREPROCESS_SCALE})
    variants.append({'name': 'binary_text_2x', 'path': runtime.write_temp_pil_image(binary_text), 'scale': runtime.OCR_PREPROCESS_SCALE})
    return variants

runtime.create_ocr_image_variants = create_ocr_image_variants

def build_enhanced_grayscale_image(image: runtime.Image.Image, invert: bool) -> runtime.Image.Image:
    gray = runtime.ImageOps.grayscale(image)
    gray = runtime.ImageOps.autocontrast(gray, cutoff=1)
    if invert:
        gray = runtime.ImageOps.invert(gray)
    gray = runtime.ImageEnhance.Contrast(gray).enhance(2.2)
    gray = runtime.ImageEnhance.Sharpness(gray).enhance(1.6)
    if runtime.OCR_PREPROCESS_SCALE > 1:
        width = max(1, image.width * runtime.OCR_PREPROCESS_SCALE)
        height = max(1, image.height * runtime.OCR_PREPROCESS_SCALE)
        gray = gray.resize((width, height), runtime.Image.Resampling.LANCZOS)
    gray = gray.filter(runtime.ImageFilter.SHARPEN)
    return gray.convert('RGB')

runtime.build_enhanced_grayscale_image = build_enhanced_grayscale_image

def build_binary_text_image(image: runtime.Image.Image) -> runtime.Image.Image:
    source = image.convert('RGB')
    output = runtime.Image.new('RGB', source.size, 'white')
    source_pixels = source.load()
    output_pixels = output.load()
    for y in range(source.height):
        for x in range(source.width):
            red, green, blue = source_pixels[x, y]
            brightness = (red + green + blue) / 3
            saturation = max(red, green, blue) - min(red, green, blue)
            dark_neutral = brightness < 205 and saturation < 86
            red_brown_text = red > 70 and red >= green + 16 and (red >= blue + 16) and (brightness < 214)
            if dark_neutral or red_brown_text:
                output_pixels[x, y] = (0, 0, 0)
    if runtime.OCR_PREPROCESS_SCALE > 1:
        output = output.resize((source.width * runtime.OCR_PREPROCESS_SCALE, source.height * runtime.OCR_PREPROCESS_SCALE), runtime.Image.Resampling.LANCZOS)
    return output

runtime.build_binary_text_image = build_binary_text_image

def split_multiline_items(items: list[dict[str, runtime.Any]], variant: dict[str, runtime.Any], lang: str, params: dict[str, float], debug_enabled: bool, debug_stem: str) -> list[dict[str, runtime.Any]]:
    if not items:
        return items
    output: list[dict[str, runtime.Any]] = []
    try:
        image = runtime.Image.open(variant['path']).convert('RGB')
    except Exception:
        return items
    for item in items:
        replacement = runtime.split_multiline_item(image, item, variant, lang, params, debug_enabled, debug_stem)
        output.extend(replacement or [item])
    return output

runtime.split_multiline_items = split_multiline_items

def split_multiline_item(image: runtime.Image.Image, item: dict[str, runtime.Any], variant: dict[str, runtime.Any], lang: str, params: dict[str, float], debug_enabled: bool, debug_stem: str) -> list[dict[str, runtime.Any]] | None:
    box = item.get('box')
    if not isinstance(box, dict) or not runtime.should_try_multiline_split(box):
        return None
    left = max(0, int(float(box.get('left') or 0)))
    top = max(0, int(float(box.get('top') or 0)))
    right = min(image.width, int(float(box.get('left') or 0) + float(box.get('width') or 0)))
    bottom = min(image.height, int(float(box.get('top') or 0) + float(box.get('height') or 0)))
    if right <= left or bottom <= top:
        return None
    crop = image.crop((left, top, right, bottom)).convert('RGB')
    segments = runtime.detect_horizontal_text_segments(crop)
    if len(segments) < 2:
        return None
    line_items: list[dict[str, runtime.Any]] = []
    for line_index, (line_top, line_bottom) in enumerate(segments, start=1):
        line_crop = crop.crop((0, line_top, crop.width, line_bottom)).convert('RGB')
        line_path = runtime.write_temp_pil_image(line_crop)
        try:
            raw = runtime.predict_with_lang(str(line_path), lang, params)
            extracted = runtime.extract_items(raw, filter_symbols=True, min_score=0.0)
        finally:
            line_path.unlink(missing_ok=True)
        for line_item in extracted:
            line_box = line_item.get('box')
            if not isinstance(line_box, dict):
                continue
            line_box['left'] = float(line_box.get('left') or 0.0) + left
            line_box['top'] = float(line_box.get('top') or 0.0) + top + line_top
            line_item['lineSplitFrom'] = item.get('text', '')
            line_item['lineSplitVariant'] = variant.get('name', '')
            line_item['lineSplitIndex'] = line_index
            line_items.append(line_item)
        if debug_enabled:
            runtime.save_line_split_crop(line_crop, debug_stem, variant, lang, item, line_index)
    if len(line_items) < 2:
        return None
    original_hangul = runtime.count_hangul(str(item.get('text') or ''))
    split_hangul = sum((runtime.count_hangul(str(line.get('text') or '')) for line in line_items))
    if split_hangul < max(2, original_hangul):
        return None
    return runtime.sort_items(line_items)

runtime.split_multiline_item = split_multiline_item

def should_try_multiline_split(box: dict[str, runtime.Any]) -> bool:
    width = float(box.get('width') or 0.0)
    height = float(box.get('height') or 0.0)
    if width <= 0 or height <= 0:
        return False
    return height >= 130 and height >= width * 0.55

runtime.should_try_multiline_split = should_try_multiline_split

def detect_horizontal_text_segments(crop: runtime.Image.Image) -> list[tuple[int, int]]:
    gray = runtime.ImageOps.grayscale(crop)
    pixels = gray.load()
    row_scores: list[int] = []
    for y in range(gray.height):
        count = 0
        for x in range(gray.width):
            if pixels[x, y] < 205:
                count += 1
        row_scores.append(count)
    threshold = max(3, int(gray.width * 0.018))
    segments: list[tuple[int, int]] = []
    start: int | None = None
    gap = 0
    for y, score in enumerate(row_scores):
        if score >= threshold:
            if start is None:
                start = y
            gap = 0
            continue
        if start is not None:
            gap += 1
            if gap >= 5:
                end = y - gap + 1
                if end - start >= 8:
                    segments.append((max(0, start - 3), min(gray.height, end + 3)))
                start = None
                gap = 0
    if start is not None and gray.height - start >= 8:
        segments.append((max(0, start - 3), gray.height))
    return runtime.merge_close_segments(segments, gray.height)

runtime.detect_horizontal_text_segments = detect_horizontal_text_segments

def merge_close_segments(segments: list[tuple[int, int]], height: int) -> list[tuple[int, int]]:
    if not segments:
        return []
    merged = [segments[0]]
    for start, end in segments[1:]:
        last_start, last_end = merged[-1]
        if start - last_end <= 4:
            merged[-1] = (last_start, end)
        else:
            merged.append((start, end))
    return [(max(0, start), min(height, end)) for start, end in merged if end > start]

runtime.merge_close_segments = merge_close_segments

def save_line_split_crop(image: runtime.Image.Image, stem: str, variant: dict[str, runtime.Any], lang: str, item: dict[str, runtime.Any], line_index: int) -> None:
    output_dir = runtime.service_debug_dir('crops') / runtime.safe_debug_stem(stem)
    output_dir.mkdir(parents=True, exist_ok=True)
    text_slug = runtime.safe_debug_stem(str(item.get('text') or 'line'))[:24]
    path = output_dir / f"{runtime.safe_debug_stem(str(variant.get('name') or 'variant'))}-{lang}-line-{line_index:02d}-{text_slug}.png"
    image.save(path)

runtime.save_line_split_crop = save_line_split_crop

def write_temp_image_bytes(image_bytes: bytes) -> runtime.Path:
    with runtime.tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp.write(image_bytes)
        return runtime.Path(tmp.name)

runtime.write_temp_image_bytes = write_temp_image_bytes

def write_temp_pil_image(image: runtime.Image.Image) -> runtime.Path:
    with runtime.tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        image.save(tmp, format='PNG')
        return runtime.Path(tmp.name)

runtime.write_temp_pil_image = write_temp_pil_image

def normalize_item_box_scale(item: dict[str, runtime.Any], scale: float) -> None:
    if scale <= 0 or abs(scale - 1.0) < 0.001:
        return
    box = item.get('box')
    if not isinstance(box, dict):
        return
    for key in ('left', 'top', 'width', 'height'):
        if runtime.is_number(box.get(key)):
            box[key] = float(box[key]) / scale
    polygon = item.get('polygon')
    if isinstance(polygon, list):
        item['polygon'] = [[float(point[0]) / scale, float(point[1]) / scale] for point in polygon if isinstance(point, (list, tuple)) and len(point) >= 2 and runtime.is_number(point[0]) and runtime.is_number(point[1])]

runtime.normalize_item_box_scale = normalize_item_box_scale
