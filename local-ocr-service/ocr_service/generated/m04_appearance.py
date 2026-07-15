from __future__ import annotations

from ..dependencies import runtime

def union_dilated_mask_polygon(mask: runtime.Any, points: list[list[int]], radius: int) -> runtime.Any:
    """将一个像素多边形膨胀后并入已有 mask。"""
    polygon_mask = runtime.np.zeros(mask.shape, dtype=runtime.np.uint8)
    runtime.cv2.fillPoly(polygon_mask, [runtime.np.asarray(points, dtype=runtime.np.int32)], 255)
    kernel_size = max(1, int(radius) * 2 + 1)
    kernel = runtime.cv2.getStructuringElement(runtime.cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return runtime.cv2.bitwise_or(mask, runtime.cv2.dilate(polygon_mask, kernel, iterations=1))

runtime.union_dilated_mask_polygon = union_dilated_mask_polygon

def normalize_percent_mask_polygon(value: runtime.Any, image_width: int, image_height: int) -> list[list[int]]:
    """把百分比 polygon 或完整 box 转成图像像素多边形。"""
    if not isinstance(value, dict):
        return []
    coordinate_space = str(value.get('coordinateSpace') or value.get('coordinate_space') or 'percent').strip().lower()
    if coordinate_space not in {'percent', 'percentage', 'percent-v1'}:
        return []

    def to_pixel(raw: runtime.Any, extent: int) -> int | None:
        try:
            number = float(raw)
        except (TypeError, ValueError):
            return None
        if not runtime.math.isfinite(number):
            return None
        return int(max(0, min(extent - 1, round(number * extent / 100.0))))
    polygon = value.get('polygon')
    if isinstance(polygon, list) and len(polygon) >= 3:
        points: list[list[int]] = []
        for point in polygon:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                raw_x, raw_y = (point[0], point[1])
            elif isinstance(point, dict):
                raw_x, raw_y = (point.get('x'), point.get('y'))
            else:
                continue
            x = to_pixel(raw_x, image_width)
            y = to_pixel(raw_y, image_height)
            if x is not None and y is not None:
                points.append([x, y])
        if len(points) >= 3:
            return points
    box = value.get('box') if isinstance(value.get('box'), dict) else value
    try:
        left = float(box.get('x', box.get('left')))
        top = float(box.get('y', box.get('top')))
        width = float(box.get('w', box.get('width')))
        height = float(box.get('h', box.get('height')))
    except (AttributeError, TypeError, ValueError):
        return []
    if not all((runtime.math.isfinite(number) for number in (left, top, width, height))) or width <= 0 or height <= 0:
        return []
    left_px = to_pixel(left, image_width)
    top_px = to_pixel(top, image_height)
    right_px = to_pixel(left + width, image_width)
    bottom_px = to_pixel(top + height, image_height)
    if None in (left_px, top_px, right_px, bottom_px) or right_px <= left_px or bottom_px <= top_px:
        return []
    return [[left_px, top_px], [right_px, top_px], [right_px, bottom_px], [left_px, bottom_px]]

runtime.normalize_percent_mask_polygon = normalize_percent_mask_polygon

def normalize_mask_polygon(polygon: runtime.Any, box: dict[str, runtime.Any], image_width: int, image_height: int) -> list[list[int]]:
    if isinstance(polygon, list) and len(polygon) >= 3:
        points: list[list[int]] = []
        for point in polygon:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                x, y = (point[0], point[1])
            elif isinstance(point, dict):
                x, y = (point.get('x'), point.get('y'))
            else:
                continue
            try:
                points.append([int(max(0, min(image_width - 1, round(float(x))))), int(max(0, min(image_height - 1, round(float(y)))))])
            except (TypeError, ValueError):
                continue
        if len(points) >= 3:
            return points
    left = max(0.0, float(box.get('left') or 0))
    top = max(0.0, float(box.get('top') or 0))
    right = min(float(image_width - 1), left + max(1.0, float(box.get('width') or 0)))
    bottom = min(float(image_height - 1), top + max(1.0, float(box.get('height') or 0)))
    return [[int(round(left)), int(round(top))], [int(round(right)), int(round(top))], [int(round(right)), int(round(bottom))], [int(round(left)), int(round(bottom))]]

runtime.normalize_mask_polygon = normalize_mask_polygon

def calculate_background_color_variance(roi: runtime.Any, dominant_bgr: runtime.Any) -> float:
    """排除与主背景明暗反差明显的文字像素后，计算整个背景块的 Lab 颜色方差。"""
    if roi is None or roi.size == 0:
        return float('inf')
    gray = runtime.cv2.cvtColor(roi, runtime.cv2.COLOR_BGR2GRAY)
    dominant_gray = float(runtime.cv2.cvtColor(runtime.np.asarray(dominant_bgr, dtype=runtime.np.uint8).reshape(1, 1, 3), runtime.cv2.COLOR_BGR2GRAY)[0, 0])
    if dominant_gray >= 140:
        background_mask = gray >= max(32.0, dominant_gray - 72.0)
    elif dominant_gray <= 110:
        background_mask = gray <= min(223.0, dominant_gray + 72.0)
    else:
        background_mask = runtime.np.abs(gray.astype(runtime.np.float32) - dominant_gray) <= 72.0
    minimum_pixels = max(32, int(gray.size * 0.35))
    if int(runtime.np.count_nonzero(background_mask)) < minimum_pixels:
        return float('inf')
    lab_pixels = runtime.cv2.cvtColor(roi, runtime.cv2.COLOR_BGR2LAB)[background_mask].astype(runtime.np.float32)
    if len(lab_pixels) < minimum_pixels:
        return float('inf')
    channel_variance = runtime.np.var(lab_pixels, axis=0)
    return float(runtime.np.mean(channel_variance))

runtime.calculate_background_color_variance = calculate_background_color_variance

def visual_regions_match(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    first_box, second_box = (first.get('box', {}), second.get('box', {}))
    left = max(float(first_box.get('left') or 0), float(second_box.get('left') or 0))
    top = max(float(first_box.get('top') or 0), float(second_box.get('top') or 0))
    right = min(float(first_box.get('left') or 0) + float(first_box.get('width') or 0), float(second_box.get('left') or 0) + float(second_box.get('width') or 0))
    bottom = min(float(first_box.get('top') or 0) + float(first_box.get('height') or 0), float(second_box.get('top') or 0) + float(second_box.get('height') or 0))
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(1.0, float(first_box.get('width') or 0) * float(first_box.get('height') or 0))
    second_area = max(1.0, float(second_box.get('width') or 0) * float(second_box.get('height') or 0))
    first_color = runtime.np.asarray(runtime.hex_to_bgr(str(first.get('bg_color') or '')), dtype=runtime.np.int16)
    second_color = runtime.np.asarray(runtime.hex_to_bgr(str(second.get('bg_color') or '')), dtype=runtime.np.int16)
    return overlap / min(first_area, second_area) >= 0.68 and float(runtime.np.linalg.norm(first_color - second_color)) <= 64

runtime.visual_regions_match = visual_regions_match

def visual_region_quality(region: dict[str, runtime.Any]) -> tuple[float, float]:
    """同一物理容器的多个候选中，优先保留更可靠且更完整的轮廓。"""
    box = region.get('box') or {}
    area = max(0.0, float(box.get('width') or 0) * float(box.get('height') or 0))
    return (float(region.get('confidence') or 0.0), area)

runtime.visual_region_quality = visual_region_quality

def find_best_visual_region(box: dict[str, runtime.Any], regions: list[dict[str, runtime.Any]]) -> dict[str, runtime.Any] | None:
    """为文字框选择真实包含它、覆盖充分且面积较小的容器。"""
    if not box or not regions:
        return None
    box_left = float(box.get('left') or 0)
    box_top = float(box.get('top') or 0)
    box_width = max(0.0, float(box.get('width') or 0))
    box_height = max(0.0, float(box.get('height') or 0))
    box_right = box_left + box_width
    box_bottom = box_top + box_height
    box_area = max(1.0, box_width * box_height)
    center_x = box_left + box_width / 2
    center_y = box_top + box_height / 2
    candidates: list[tuple[tuple[float, float, float, float], dict[str, runtime.Any]]] = []
    for region in regions:
        region_box = region.get('box') or {}
        region_left = float(region_box.get('left') or 0)
        region_top = float(region_box.get('top') or 0)
        region_width = max(0.0, float(region_box.get('width') or 0))
        region_height = max(0.0, float(region_box.get('height') or 0))
        region_right = region_left + region_width
        region_bottom = region_top + region_height
        overlap = max(0.0, min(box_right, region_right) - max(box_left, region_left)) * max(0.0, min(box_bottom, region_bottom) - max(box_top, region_top))
        overlap_ratio = overlap / box_area
        polygon = region.get('polygon') or []
        polygon_contains_center = False
        if len(polygon) >= 3:
            contour = runtime.np.asarray(polygon, dtype=runtime.np.float32).reshape((-1, 1, 2))
            polygon_contains_center = runtime.cv2.pointPolygonTest(contour, (center_x, center_y), False) >= 0
        box_contains_center = region_left <= center_x <= region_right and region_top <= center_y <= region_bottom
        if not (polygon_contains_center and overlap_ratio >= 0.18 or (box_contains_center and overlap_ratio >= 0.55)):
            continue
        region_area = max(1.0, region_width * region_height)
        score = (1.0 if polygon_contains_center else 0.0, overlap_ratio, -region_area, float(region.get('confidence') or 0.0))
        candidates.append((score, region))
    return max(candidates, key=lambda entry: entry[0])[1] if candidates else None

runtime.find_best_visual_region = find_best_visual_region

def box_belongs_to_visual_region(box: dict[str, runtime.Any], region: dict[str, runtime.Any]) -> bool:
    return runtime.find_best_visual_region(box, [region]) is not None

runtime.box_belongs_to_visual_region = box_belongs_to_visual_region

def apply_visual_style_to_item(item: dict[str, runtime.Any], image: runtime.Any, region: dict[str, runtime.Any] | None) -> None:
    box = item.get('box') or {}
    polygon = item.get('polygon') or []
    bg_color = str(region.get('bg_color') if region else runtime.sample_box_background_color(image, box))
    ink_color = runtime.sample_text_ink_color(image, polygon, box, bg_color)
    text_color, stroke_color = runtime.choose_readable_text_colors(ink_color, bg_color)
    item['region_id'] = str(region.get('id') if region else '')
    item['region_type'] = str(region.get('region_type') if region else 'effect_text')
    item['region_polygon'] = region.get('polygon') if region else None
    item['region_box'] = region.get('box') if region else None
    item['bg_color'] = bg_color if region else ''
    item['text_color'] = text_color
    item['stroke_color'] = stroke_color
    item['region_confidence'] = float(region.get('confidence') if region else 0.0)

runtime.apply_visual_style_to_item = apply_visual_style_to_item

def sample_box_background_color(image: runtime.Any, box: dict[str, runtime.Any]) -> str:
    height, width = image.shape[:2]
    left = max(0, int(float(box.get('left') or 0)))
    top = max(0, int(float(box.get('top') or 0)))
    right = min(width, int(runtime.math.ceil(left + float(box.get('width') or 0))))
    bottom = min(height, int(runtime.math.ceil(top + float(box.get('height') or 0))))
    if right <= left or bottom <= top:
        return '#ffffff'
    roi = image[top:bottom, left:right]
    border = max(1, min(roi.shape[:2]) // 8)
    pixels = runtime.np.concatenate((roi[:border].reshape(-1, 3), roi[-border:].reshape(-1, 3), roi[:, :border].reshape(-1, 3), roi[:, -border:].reshape(-1, 3)))
    return runtime.bgr_to_hex([int(value) for value in runtime.np.median(pixels, axis=0)])

runtime.sample_box_background_color = sample_box_background_color

def sample_text_ink_color(image: runtime.Any, polygon: runtime.Any, box: dict[str, runtime.Any], bg_color: str) -> str:
    height, width = image.shape[:2]
    left = max(0, int(float(box.get('left') or 0)))
    top = max(0, int(float(box.get('top') or 0)))
    right = min(width, int(runtime.math.ceil(left + float(box.get('width') or 0))))
    bottom = min(height, int(runtime.math.ceil(top + float(box.get('height') or 0))))
    if right <= left or bottom <= top:
        return '#111827'
    roi = image[top:bottom, left:right]
    background = runtime.np.asarray(runtime.hex_to_bgr(bg_color), dtype=runtime.np.int16)
    pixels = roi.reshape(-1, 3)
    distances = runtime.np.linalg.norm(pixels.astype(runtime.np.int16) - background, axis=1)
    ink = pixels[distances >= 42]
    if len(ink) < 8:
        return '#111827' if runtime.relative_luminance(bg_color) > 0.45 else '#ffffff'
    quantized = (ink // 24).astype(runtime.np.int16)
    keys, counts = runtime.np.unique(quantized, axis=0, return_counts=True)
    dominant = runtime.np.clip(keys[int(runtime.np.argmax(counts))] * 24 + 12, 0, 255)
    return runtime.bgr_to_hex([int(value) for value in dominant])

runtime.sample_text_ink_color = sample_text_ink_color

def choose_readable_text_colors(original: str, background: str) -> tuple[str, str]:
    if runtime.contrast_ratio(original, background) >= 4.5:
        text = original
    else:
        text = '#000000' if runtime.contrast_ratio('#000000', background) >= runtime.contrast_ratio('#ffffff', background) else '#ffffff'
    stroke = '#ffffff' if runtime.relative_luminance(text) < 0.45 else '#000000'
    return (text, stroke)

runtime.choose_readable_text_colors = choose_readable_text_colors

def bgr_to_hex(bgr: list[int]) -> str:
    return f'#{int(bgr[2]):02x}{int(bgr[1]):02x}{int(bgr[0]):02x}'

runtime.bgr_to_hex = bgr_to_hex

def hex_to_bgr(value: str) -> list[int]:
    raw = str(value or '#ffffff').lstrip('#')
    if len(raw) != 6:
        raw = 'ffffff'
    red, green, blue = (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    return [blue, green, red]

runtime.hex_to_bgr = hex_to_bgr

def relative_luminance(value: str) -> float:
    bgr = runtime.hex_to_bgr(value)
    channels = [bgr[2] / 255, bgr[1] / 255, bgr[0] / 255]
    linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722

runtime.relative_luminance = relative_luminance

def contrast_ratio(first: str, second: str) -> float:
    high, low = sorted((runtime.relative_luminance(first), runtime.relative_luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)

runtime.contrast_ratio = contrast_ratio
