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

def _quantized_bucket_hex(key: runtime.Any) -> str:
    """24 级量化桶的桶中心色（keys*24+12 clip 到 0..255 后转 hex）。"""
    center = runtime.np.clip(key * 24 + 12, 0, 255)
    return runtime.bgr_to_hex([int(value) for value in center])


def _rgb_distance(first: list[int], second: list[int]) -> float:
    """RGB 欧氏距离（与墨色筛选的 INK_DISTANCE_THRESHOLD 同款口径）。"""
    return runtime.math.sqrt(sum((a - b) ** 2 for a, b in zip(first, second)))


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
    # 墨色主色挑选（与扩展侧 sampleBubbleAppearance::pickDominantInkBucket 同口径）：
    # 第一层（v2）：像素数最多的桶可能是**白描边**而不是笔画（浅色背景上白描边
    # 对比度不足 2，按像素数降序取第一个与背景对比度 >= INK_BACKGROUND_MIN_CONTRAST
    # 的桶即可跳过）；全部不满足时回退旧行为：像素数最多者。
    # 第二层（v3/v4）白描边守卫：白描边在各种背景上都能靠对比度或像素数当选
    # （粉字案白桶 ct 15.6 当选；渐变红字案白桶 ct 4.5 当选、红笔画 ct 1.0~1.8
    # 全被 ct>=2 跳过）—— TOP 桶无彩（chroma < 20）且近白（min(r,g,b) >= 200）
    # 时，按「色度 + 与背景 RGB 距离 + 像素数」找彩色笔画候选：chroma >= 40、
    # RGB 欧氏距离 >= 60（亮度对比度不可靠，不能再用 ct 过滤候选）、
    # count >= max(64, 0.5% × 全部墨色像素) 且 count >= 4% × TOP.count；
    # 找到即让位给色度最高者（并列取像素多者），不比总量（厚描边下彩色合计
    # 远小于白桶）；无候选维持 TOP（之后仍由 choose_readable_text_colors 兜底）。
    order = runtime.np.argsort(-counts, kind='stable')
    bucket_hexes = [_quantized_bucket_hex(key) for key in keys]
    top_index = -1
    for index in order.tolist():
        if runtime.contrast_ratio(bucket_hexes[index], bg_color) >= INK_BACKGROUND_MIN_CONTRAST:
            top_index = index
            break
    if top_index < 0:
        top_index = int(runtime.np.argmax(counts))
    top_hex = bucket_hexes[top_index]
    top_rgb = runtime.hex_to_bgr(top_hex)[::-1]
    if min(top_rgb) >= NEAR_WHITE_MIN_CHANNEL and runtime.color_chroma(top_hex) < WHITE_OUTLINE_MAX_CHROMA:
        background_rgb = runtime.hex_to_bgr(bg_color)[::-1]
        minimum_by_ink = max(STROKE_GUARD_MIN_BUCKET_COUNT, STROKE_GUARD_TOTAL_INK_RATIO * int(counts.sum()))
        minimum_by_top = STROKE_GUARD_TOP_COUNT_RATIO * int(counts[top_index])
        best_index = -1
        best_rank = None
        for index in order.tolist():
            if index == top_index or int(counts[index]) < minimum_by_ink or int(counts[index]) < minimum_by_top:
                continue
            chroma = runtime.color_chroma(bucket_hexes[index])
            if chroma < STROKE_GUARD_COLOURED_CHROMA:
                continue
            bucket_rgb = runtime.hex_to_bgr(bucket_hexes[index])[::-1]
            if _rgb_distance(bucket_rgb, background_rgb) < STROKE_GUARD_MIN_BG_DISTANCE:
                continue
            rank = (chroma, int(counts[index]))
            if best_rank is None or rank > best_rank:
                best_rank = rank
                best_index = index
        if best_index >= 0:
            return bucket_hexes[best_index]
    return top_hex

runtime.sample_text_ink_color = sample_text_ink_color

def choose_readable_text_colors(original: str, background: str) -> tuple[str, str]:
    """与扩展侧 rendering/bubble-colors.js::chooseReadableTextColors 同口径。

    只看对比度会把"旁白蓝字"这类低对比但明显有彩色的墨色压成黑字白边：实测
    复杂插画背景上蓝字的对比度到不了 4.5，规则于是改写成黑字，用户看到的正是
    "原图蓝字白边、译文黑字白边"。因此这里与扩展侧一样保留彩色墨色：
    对比度 >= 4.5 直接用；或者色度 >= 40 也保留（v4：不再要求对比度下限——
    渐变红字与中灰蓝背景亮度几乎相同（ct 1.0），ct >= 2.2 会把真彩字拒成黑字；
    彩色墨色的可读性由必渲染的白/黑描边保证）。灰阶（chroma < 40）路径不变。
    """
    ink = str(original or '').strip()
    bg = str(background or '').strip() or '#ffffff'
    ink_contrast = runtime.contrast_ratio(ink, bg) if ink else 0.0
    keep_ink = bool(ink) and (
        ink_contrast >= READABLE_CONTRAST or
        runtime.color_chroma(ink) >= COLOURED_INK_CHROMA
    )
    if keep_ink:
        text = ink
    else:
        text = '#000000' if runtime.contrast_ratio('#000000', bg) >= runtime.contrast_ratio('#ffffff', bg) else '#ffffff'
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

# 保留原图墨色的门槛（与扩展侧 rendering/bubble-colors.js 一致）：
# 对比度 >= 4.5 直接用原墨色；或者色度 >= 40 也保留（v4：彩色字可读性由必渲染
# 的描边保证，不再要求对比度下限——渐变红字与中灰蓝背景亮度几乎相同（ct 1.0），
# ct >= 2.2 会把真彩字拒成黑字）。灰阶（chroma < 40）路径不变。
READABLE_CONTRAST = 4.5
COLOURED_INK_CHROMA = 40
# 墨色主色挑选的背景对比度门槛（与扩展侧 bubble-colors.js INK_BACKGROUND_MIN_CONTRAST
# 一致）：v2 引入，用于 TOP 桶挑选（跳过低对比的浅底白描边）；v4 起它只影响 TOP
# 的位次，不再代表"没采到"——守卫与 choose_readable_text_colors 会另行判别。
INK_BACKGROUND_MIN_CONTRAST = 2
# 白描边守卫（与扩展侧 bubble-colors.js 同口径）：白描边靠对比度或像素数总能当选
# （浅底 ct < 2 被 v2 跳过、深底 ct 15.6 当选、中灰蓝底 ct 4.5 当选而真笔画
# ct 1.0~1.8 被埋），判别尺不能只靠亮度对比度 —— TOP 桶无彩（chroma < 20）且
# 近白（min(r,g,b) >= 200）时，在其余桶里找彩色笔画候选：chroma >= 40、与背景
# RGB 欧氏距离 >= 60（色相不同，亮度可比）、count >= max(64, 0.5% × 全部墨色
# 像素) 且 count >= 4% × TOP.count；找到即让位给色度最高者（并列取像素多者），
# 不比总量（厚描边下彩色合计远小于白桶），否则维持 TOP。
WHITE_OUTLINE_MAX_CHROMA = 20
NEAR_WHITE_MIN_CHANNEL = 200
STROKE_GUARD_MIN_BUCKET_COUNT = 64
STROKE_GUARD_COLOURED_CHROMA = 40
STROKE_GUARD_MIN_BG_DISTANCE = 60
STROKE_GUARD_TOTAL_INK_RATIO = 0.005
STROKE_GUARD_TOP_COUNT_RATIO = 0.04

def color_chroma(value: str) -> int:
    """色度 = max(R,G,B) - min(R,G,B)：用来区分"有彩色倾向的墨色"和灰阶。"""
    red, green, blue = runtime.hex_to_bgr(value)[::-1]
    return max(red, green, blue) - min(red, green, blue)

runtime.color_chroma = color_chroma
