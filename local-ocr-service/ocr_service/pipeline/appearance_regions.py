from __future__ import annotations

from ..dependencies import runtime

def annotate_visual_regions(image_bytes: bytes, items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    """Merge adjacent OCR lines and validate solid backgrounds at near and far scales."""
    if not runtime.CV2_AVAILABLE or not items:
        return []
    encoded = runtime.np.frombuffer(image_bytes, dtype=runtime.np.uint8)
    image = runtime.cv2.imdecode(encoded, runtime.cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        return []
    height, width = image.shape[:2]
    scale = min(1.0, 760.0 / max(width, height))
    sample = runtime.cv2.resize(image, None, fx=scale, fy=scale, interpolation=runtime.cv2.INTER_AREA) if scale < 1 else image
    lab = runtime.cv2.cvtColor(sample, runtime.cv2.COLOR_BGR2LAB)
    regions: list[dict[str, runtime.Any]] = []
    for block in runtime.merge_visual_text_blocks(items):
        candidate = runtime.detect_solid_region_for_box(sample, lab, block['box'], scale, [item.get('polygon') for item in block['items'] if item.get('polygon')])
        if candidate:
            candidate['id'] = f'region-{len(regions) + 1}'
            regions.append(candidate)
        for item in block['items']:
            runtime.apply_visual_style_to_item(item, image, candidate)
    return regions

runtime.annotate_visual_regions = annotate_visual_regions

def merge_visual_text_blocks(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    """Merge only clearly adjacent OCR lines before background classification."""
    blocks: list[dict[str, runtime.Any]] = []
    ordered = sorted(items, key=lambda value: (float((value.get('box') or {}).get('top') or 0), float((value.get('box') or {}).get('left') or 0)))
    for item in ordered:
        box = item.get('box') if isinstance(item.get('box'), dict) else None
        if not box:
            continue
        block = next((candidate for candidate in blocks if runtime.text_boxes_belong_to_same_block(candidate['box'], box)), None)
        if block is None:
            blocks.append({'box': dict(box), 'items': [item]})
        else:
            block['items'].append(item)
            block['box'] = runtime.union_boxes(block['box'], box)
    split_blocks: list[dict[str, runtime.Any]] = []
    for block in blocks:
        split_blocks.extend(runtime.split_visual_text_block_paragraphs(block))
    for block in split_blocks:
        block['box']['line_height'] = float(runtime.np.median([float((item.get('box') or {}).get('height') or 0) for item in block['items']]))
    return split_blocks

runtime.merge_visual_text_blocks = merge_visual_text_blocks

def split_visual_text_block_paragraphs(block: dict[str, runtime.Any]) -> list[dict[str, runtime.Any]]:
    """Split a broad solid panel into visually distinct multi-line paragraphs."""
    rows: list[dict[str, runtime.Any]] = []
    for item in sorted(block.get('items') or [], key=lambda value: (float((value.get('box') or {}).get('top') or 0), float((value.get('box') or {}).get('left') or 0))):
        item_box = item.get('box') if isinstance(item.get('box'), dict) else None
        if not item_box:
            continue
        row = next((candidate for candidate in rows if runtime.visual_text_boxes_share_row(candidate['box'], item_box)), None)
        if row is None:
            rows.append({'box': dict(item_box), 'items': [item]})
        else:
            row['items'].append(item)
            row['box'] = runtime.union_boxes(row['box'], item_box)
    rows.sort(key=lambda value: (float(value['box'].get('top') or 0), float(value['box'].get('left') or 0)))

    def split_rows(values: list[dict[str, runtime.Any]]) -> list[list[dict[str, runtime.Any]]]:
        if len(values) < 4:
            return [values]
        for index in range(2, len(values) - 1):
            if runtime.is_visual_paragraph_boundary(values[index - 1]['box'], values[index]['box']):
                return split_rows(values[:index]) + split_rows(values[index:])
        return [values]
    results: list[dict[str, runtime.Any]] = []
    for paragraph_rows in split_rows(rows):
        paragraph_items = [item for row in paragraph_rows for item in row['items']]
        if not paragraph_items:
            continue
        paragraph_box = dict(paragraph_items[0]['box'])
        for item in paragraph_items[1:]:
            paragraph_box = runtime.union_boxes(paragraph_box, item['box'])
        results.append({'box': paragraph_box, 'items': paragraph_items})
    return results or [block]

runtime.split_visual_text_block_paragraphs = split_visual_text_block_paragraphs

def visual_text_boxes_share_row(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    first_top = float(first.get('top') or 0)
    second_top = float(second.get('top') or 0)
    first_height = max(1.0, float(first.get('height') or 0))
    second_height = max(1.0, float(second.get('height') or 0))
    overlap = min(first_top + first_height, second_top + second_height) - max(first_top, second_top)
    return overlap >= min(first_height, second_height) * 0.45

runtime.visual_text_boxes_share_row = visual_text_boxes_share_row

def is_visual_paragraph_boundary(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    first_left = float(first.get('left') or 0)
    second_left = float(second.get('left') or 0)
    first_width = max(1.0, float(first.get('width') or 0))
    second_width = max(1.0, float(second.get('width') or 0))
    first_height = max(1.0, float(first.get('height') or 0))
    second_height = max(1.0, float(second.get('height') or 0))
    first_bottom = float(first.get('top') or 0) + first_height
    second_top = float(second.get('top') or 0)
    average_height = max(1.0, (first_height + second_height) / 2)
    vertical_gap = max(0.0, second_top - first_bottom)
    overlap = max(0.0, min(first_left + first_width, second_left + second_width) - max(first_left, second_left))
    overlap_ratio = overlap / max(1.0, min(first_width, second_width))
    center_offset = abs(first_left + first_width / 2 - (second_left + second_width / 2))
    width_ratio = min(first_width, second_width) / max(first_width, second_width)
    large_blank_break = vertical_gap >= average_height * 1.1
    shifted_layout_break = vertical_gap >= average_height * 0.65 and center_offset >= average_height * 2.5 and (width_ratio < 0.62) and (overlap_ratio < 0.68)
    return large_blank_break or shifted_layout_break

runtime.is_visual_paragraph_boundary = is_visual_paragraph_boundary

def text_boxes_belong_to_same_block(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    first_left, first_top = (float(first.get('left') or 0), float(first.get('top') or 0))
    second_left, second_top = (float(second.get('left') or 0), float(second.get('top') or 0))
    first_width, first_height = (float(first.get('width') or 0), float(first.get('height') or 0))
    second_width, second_height = (float(second.get('width') or 0), float(second.get('height') or 0))
    vertical_gap = max(0.0, second_top - (first_top + first_height), first_top - (second_top + second_height))
    horizontal_overlap = max(0.0, min(first_left + first_width, second_left + second_width) - max(first_left, second_left))
    center_distance = abs(first_left + first_width / 2 - (second_left + second_width / 2))
    average_height = max(1.0, (first_height + second_height) / 2)
    return vertical_gap <= average_height * 1.15 and (horizontal_overlap / max(1.0, min(first_width, second_width)) >= 0.2 or center_distance <= max(first_width, second_width) * 0.35)

runtime.text_boxes_belong_to_same_block = text_boxes_belong_to_same_block

def union_boxes(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> dict[str, float]:
    left = min(float(first.get('left') or 0), float(second.get('left') or 0))
    top = min(float(first.get('top') or 0), float(second.get('top') or 0))
    right = max(float(first.get('left') or 0) + float(first.get('width') or 0), float(second.get('left') or 0) + float(second.get('width') or 0))
    bottom = max(float(first.get('top') or 0) + float(first.get('height') or 0), float(second.get('top') or 0) + float(second.get('height') or 0))
    return {'left': left, 'top': top, 'width': right - left, 'height': bottom - top}

runtime.union_boxes = union_boxes

def detect_solid_region_for_box(image: runtime.Any, lab: runtime.Any, source_box: dict[str, runtime.Any], scale: float, text_polygons: list[runtime.Any] | None=None) -> dict[str, runtime.Any] | None:
    """近区必须通过；远区仅在指标通过时用于扩大纯色覆盖区域。"""
    image_height, image_width = image.shape[:2]
    left = max(0, int(float(source_box.get('left') or 0) * scale))
    top = max(0, int(float(source_box.get('top') or 0) * scale))
    right = min(image_width, int(runtime.math.ceil((float(source_box.get('left') or 0) + float(source_box.get('width') or 0)) * scale)))
    bottom = min(image_height, int(runtime.math.ceil((float(source_box.get('top') or 0) + float(source_box.get('height') or 0)) * scale)))
    if right - left < 4 or bottom - top < 4:
        return None
    line_height = max(1, int(runtime.math.ceil(float(source_box.get('line_height') or source_box.get('height') or 0) * scale)))
    near = runtime.measure_solid_background_scale(lab, (left, top, right, bottom), 0.12, 0.35, text_polygons or [], scale, line_height)
    if near is None:
        return None
    far = runtime.measure_solid_background_scale(lab, (left, top, right, bottom), 0.28, 1.0, text_polygons or [], scale, line_height, enforce_thresholds=False)
    if far is None:
        return None
    far_x, far_y, far_w, far_h = far['roi']
    if far_x <= 1 and far_x + far_w >= image_width - 1 or (far_y <= 1 and far_y + far_h >= image_height - 1):
        return None
    selected = far if far['passes_thresholds'] else near
    statistics = [near, far] if far['passes_thresholds'] else [near]
    x, y, w, h = selected['roi']
    dominant_bgr = selected['median_bgr']
    polygon = [[round(x / scale, 2), round(y / scale, 2)], [round((x + w) / scale, 2), round(y / scale, 2)], [round((x + w) / scale, 2), round((y + h) / scale, 2)], [round(x / scale, 2), round((y + h) / scale, 2)]]
    bgr = [int(value) for value in dominant_bgr]
    brightness = (bgr[2] * 299 + bgr[1] * 587 + bgr[0] * 114) / 1000
    region_type = runtime.classify_solid_region_type(image, (x, y, w, h), bgr)
    return {'id': '', 'region_type': region_type, 'polygon': polygon, 'box': {'left': round(x / scale, 2), 'top': round(y / scale, 2), 'width': round(w / scale, 2), 'height': round(h / scale, 2)}, 'bg_color': runtime.bgr_to_hex(bgr), 'confidence': round(min((stat['dominant_coverage'] for stat in statistics)), 4), 'rectangularity': 1.0, 'brightness': round(brightness, 2), 'background_variance': round(max((stat['lab_variance'] for stat in statistics)), 4), 'delta_e_p90': round(max((stat['delta_e_p90'] for stat in statistics)), 4), 'dominant_coverage': round(min((stat['dominant_coverage'] for stat in statistics)), 4), 'sampling_strategy': 'near_priority', 'far_scale_passed': bool(far['passes_thresholds'])}

runtime.detect_solid_region_for_box = detect_solid_region_for_box

def measure_solid_background_scale(lab: runtime.Any, text_box: tuple[int, int, int, int], pad_x_ratio: float, pad_y_ratio: float, text_polygons: list[runtime.Any], scale: float, vertical_reference: int, enforce_thresholds: bool=True) -> dict[str, runtime.Any] | None:
    """测量单个采样尺度；结构风险始终拒绝，颜色阈值可仅记录不拒绝。"""
    image_height, image_width = lab.shape[:2]
    left, top, right, bottom = text_box
    box_width, box_height = (right - left, bottom - top)
    pad_x = max(2, int(runtime.math.ceil(box_width * pad_x_ratio)))
    pad_y = max(2, int(runtime.math.ceil(vertical_reference * pad_y_ratio)))
    roi_left, roi_top = (max(0, left - pad_x), max(0, top - pad_y))
    roi_right, roi_bottom = (min(image_width, right + pad_x), min(image_height, bottom + pad_y))
    roi_lab = lab[roi_top:roi_bottom, roi_left:roi_right]
    if roi_lab.size == 0:
        return None
    text_mask = runtime.np.zeros(roi_lab.shape[:2], dtype=runtime.np.uint8)
    polygons = text_polygons or [[[left / scale, top / scale], [right / scale, top / scale], [right / scale, bottom / scale], [left / scale, bottom / scale]]]
    for polygon in polygons:
        points = runtime.np.asarray([[round(float(point[0]) * scale) - roi_left, round(float(point[1]) * scale) - roi_top] for point in polygon if isinstance(point, (list, tuple)) and len(point) >= 2], dtype=runtime.np.int32)
        if len(points) >= 3:
            runtime.cv2.fillPoly(text_mask, [points], 1)
    outside = roi_lab[text_mask == 0]
    minimum_samples = max(48, int(roi_lab.shape[0] * roi_lab.shape[1] * 0.2))
    if len(outside) < minimum_samples:
        return None
    median_lab = runtime.np.median(outside, axis=0)
    all_distances = runtime.np.linalg.norm(roi_lab.astype(runtime.np.float32) - median_lab.astype(runtime.np.float32), axis=2)
    outside_outliers = ((text_mask == 0) & (all_distances > runtime.SOLID_BACKGROUND_MAX_DELTA_E_P90)).astype(runtime.np.uint8)
    if runtime.has_interior_spanning_outlier(outside_outliers):
        return None
    keep_mask = (text_mask == 0) | (all_distances <= runtime.SOLID_BACKGROUND_MAX_DELTA_E_P90)
    pixels = roi_lab[keep_mask].astype(runtime.np.float32)
    if len(pixels) < minimum_samples:
        return None
    distances = runtime.np.linalg.norm(pixels - median_lab.astype(runtime.np.float32), axis=1)
    dominant_pixels = pixels[distances <= runtime.SOLID_BACKGROUND_MAX_DELTA_E_P90]
    if len(dominant_pixels) < minimum_samples and enforce_thresholds:
        return None
    variance_pixels = dominant_pixels if len(dominant_pixels) else pixels
    lab_variance = float(runtime.np.mean(runtime.np.var(variance_pixels, axis=0)))
    delta_e_p90 = float(runtime.np.percentile(distances, 90))
    dominant_coverage = float(runtime.np.mean(distances <= runtime.SOLID_BACKGROUND_MAX_DELTA_E_P90))
    passes_thresholds = bool(len(dominant_pixels) >= minimum_samples and lab_variance <= runtime.SOLID_BACKGROUND_MAX_LAB_VARIANCE and (delta_e_p90 <= runtime.SOLID_BACKGROUND_MAX_DELTA_E_P90) and (dominant_coverage >= runtime.SOLID_BACKGROUND_MIN_DOMINANT_COVERAGE))
    if enforce_thresholds and (not passes_thresholds):
        return None
    median_bgr = runtime.cv2.cvtColor(runtime.np.uint8([[runtime.np.clip(median_lab, 0, 255)]]), runtime.cv2.COLOR_LAB2BGR)[0, 0]
    return {'roi': (roi_left, roi_top, roi_right - roi_left, roi_bottom - roi_top), 'median_bgr': median_bgr, 'lab_variance': lab_variance, 'delta_e_p90': delta_e_p90, 'dominant_coverage': dominant_coverage, 'passes_thresholds': passes_thresholds}

runtime.measure_solid_background_scale = measure_solid_background_scale

def has_interior_spanning_outlier(mask: runtime.Any) -> bool:
    """Reject scene boundaries, but keep paired edges that enclose a solid text panel."""
    if mask is None or mask.size == 0 or int(runtime.np.count_nonzero(mask)) == 0:
        return False
    height, width = mask.shape[:2]
    count, _labels, stats, _centroids = runtime.cv2.connectedComponentsWithStats(mask, 8)
    edge_margin_y = max(2, int(round(height * 0.06)))
    spanning_components: list[tuple[bool, bool]] = []
    for label in range(1, count):
        x, y, component_width, component_height, area = [int(value) for value in stats[label]]
        if area < 12:
            continue
        spans_width = component_width >= width * 0.72
        crosses_interior_horizontally = spans_width and y + component_height > edge_margin_y and (y < height - edge_margin_y)
        if crosses_interior_horizontally:
            touches_top = y <= edge_margin_y
            touches_bottom = y + component_height >= height - edge_margin_y
            spanning_components.append((touches_top, touches_bottom))
    if not spanning_components:
        return False
    has_top_edge = any((touches_top for touches_top, _touches_bottom in spanning_components))
    has_bottom_edge = any((touches_bottom for _touches_top, touches_bottom in spanning_components))
    all_components_touch_outer_edge = all((touches_top or touches_bottom for touches_top, touches_bottom in spanning_components))
    if has_top_edge and has_bottom_edge and all_components_touch_outer_edge:
        return False
    return True

runtime.has_interior_spanning_outlier = has_interior_spanning_outlier

def classify_solid_region_type(image: runtime.Any, roi: tuple[int, int, int, int], bgr: list[int]) -> str:
    """Classify a validated local solid region for presentation metadata."""
    if not runtime.CV2_AVAILABLE:
        return 'caption_panel'
    image_height, image_width = image.shape[:2]
    x, y, w, h = roi
    pad = max(3, min(18, int(round(min(w, h) * 0.08))))
    outer_left, outer_top = (max(0, x - pad), max(0, y - pad))
    outer_right, outer_bottom = (min(image_width, x + w + pad), min(image_height, y + h + pad))
    if outer_right <= outer_left or outer_bottom <= outer_top:
        return 'caption_panel'
    outer = image[outer_top:outer_bottom, outer_left:outer_right]
    mask = runtime.np.ones(outer.shape[:2], dtype=runtime.np.uint8)
    inner_left, inner_top = (x - outer_left, y - outer_top)
    inner_right, inner_bottom = (inner_left + w, inner_top + h)
    mask[max(0, inner_top):max(0, inner_bottom), max(0, inner_left):max(0, inner_right)] = 0
    ring = outer[mask == 1]
    if len(ring) < 24:
        return 'caption_panel'
    background = runtime.np.asarray(bgr, dtype=runtime.np.int16)
    ring_distance = runtime.np.linalg.norm(ring.astype(runtime.np.int16) - background, axis=1)
    bright_background = runtime.relative_luminance(runtime.bgr_to_hex([int(value) for value in bgr])) >= 0.72
    has_border = float(runtime.np.mean(ring_distance >= 70)) >= 0.04
    return 'speech_bubble' if bright_background and has_border else 'caption_panel'

runtime.classify_solid_region_type = classify_solid_region_type

def build_cleaned_image_data_url(image_bytes: bytes, items: list[dict[str, runtime.Any]], supplemental_masks: list[dict[str, runtime.Any]] | None=None) -> str | None:
    """Inpaint complex-background OCR polygons and return the cleaned base image."""
    if not runtime.CV2_AVAILABLE:
        return None
    encoded = runtime.np.frombuffer(image_bytes, dtype=runtime.np.uint8)
    image = runtime.cv2.imdecode(encoded, runtime.cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        return None
    mask = runtime.build_complex_text_inpaint_mask(image.shape[:2], items, supplemental_masks)
    if mask is None or int(runtime.np.count_nonzero(mask)) == 0:
        return None
    cleaned = runtime.cv2.inpaint(image, mask, 3, runtime.cv2.INPAINT_TELEA)
    ok, buffer = runtime.cv2.imencode('.png', cleaned)
    if not ok:
        return None
    payload = runtime.base64.b64encode(buffer.tobytes()).decode('ascii')
    return f'data:image/png;base64,{payload}'

runtime.build_cleaned_image_data_url = build_cleaned_image_data_url

def build_complex_text_inpaint_mask(shape: tuple[int, int], items: list[dict[str, runtime.Any]], supplemental_masks: list[dict[str, runtime.Any]] | None=None) -> runtime.Any | None:
    """合并 OCR 文字框与额外百分比几何，生成 2-8px 膨胀后的擦除掩膜。"""
    image_height, image_width = shape
    mask = runtime.np.zeros((image_height, image_width), dtype=runtime.np.uint8)
    changed = False
    for item in items:
        if str(item.get('region_id') or '').strip():
            continue
        box = item.get('box') if isinstance(item.get('box'), dict) else None
        if not box:
            continue
        box_height = max(1.0, float(box.get('height') or 0))
        polygon = item.get('polygon')
        points = runtime.normalize_mask_polygon(polygon, box, image_width, image_height)
        if len(points) < 3:
            continue
        radius = int(max(2, min(8, round(box_height * 0.08))))
        mask = runtime.union_dilated_mask_polygon(mask, points, radius)
        changed = True
    masks = supplemental_masks if isinstance(supplemental_masks, list) else []
    for value in masks[:200]:
        points = runtime.normalize_percent_mask_polygon(value, image_width, image_height)
        if len(points) < 3:
            continue
        polygon_height = max((point[1] for point in points)) - min((point[1] for point in points))
        radius = int(max(2, min(8, round(max(1, polygon_height) * 0.08))))
        mask = runtime.union_dilated_mask_polygon(mask, points, radius)
        changed = True
    return mask if changed else None

runtime.build_complex_text_inpaint_mask = build_complex_text_inpaint_mask
