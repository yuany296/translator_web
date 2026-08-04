from __future__ import annotations

from ..dependencies import runtime

def _component_looks_like_caret(mask: runtime.Any, stat: runtime.Any) -> bool:
    x, y, width, height, area = (int(value) for value in stat)
    if width < 3 or height < 3 or area <= 0:
        return False
    crop = mask[y:y + height, x:x + width] > 0
    density = float(runtime.np.count_nonzero(crop)) / max(1, crop.size)
    top = crop[:max(1, height // 3)]
    bottom = crop[-max(1, height // 3):]
    top_x = runtime.np.where(top)[1]
    bottom_x = runtime.np.where(bottom)[1]
    if top_x.size == 0 or bottom_x.size == 0:
        return False
    top_span = int(runtime.np.ptp(top_x)) + 1
    bottom_span = int(runtime.np.ptp(bottom_x)) + 1
    middle = crop[height * 2 // 3:, width // 3:max(width // 3 + 1, width * 2 // 3)]
    middle_ink = int(runtime.np.count_nonzero(middle))
    return (
        0.08 <= density <= 0.7
        and bottom_span >= top_span * 1.25
        and middle_ink <= max(2, int(middle.size * 0.15))
    )

def detect_trailing_double_caret(image: runtime.Any) -> bool:
    """Detect two small raised carets at the visual end of a horizontal crop."""
    if not runtime.CV2_AVAILABLE or image is None:
        return False
    pixels = runtime.np.asarray(image)
    if pixels.ndim not in (2, 3) or pixels.size == 0:
        return False
    gray = (
        runtime.cv2.cvtColor(pixels, runtime.cv2.COLOR_BGR2GRAY)
        if pixels.ndim == 3
        else pixels
    )
    _, dark_ink = runtime.cv2.threshold(
        gray, 0, 255, runtime.cv2.THRESH_BINARY_INV + runtime.cv2.THRESH_OTSU
    )
    light_ink = runtime.cv2.bitwise_not(dark_ink)
    mask = min(
        (dark_ink, light_ink),
        key=lambda value: int(runtime.np.count_nonzero(value)),
    )
    count, _, stats, _ = runtime.cv2.connectedComponentsWithStats(mask, 8)
    min_area = max(4, int(mask.shape[0] * mask.shape[1] * 0.0005))
    components = [
        stats[index]
        for index in range(1, count)
        if int(stats[index, runtime.cv2.CC_STAT_AREA]) >= min_area
    ]
    if len(components) < 3:
        return False
    components.sort(key=lambda stat: int(stat[runtime.cv2.CC_STAT_LEFT]))
    first, second = components[-2:]
    left = min(int(stat[runtime.cv2.CC_STAT_LEFT]) for stat in components)
    top = min(int(stat[runtime.cv2.CC_STAT_TOP]) for stat in components)
    right = max(
        int(stat[runtime.cv2.CC_STAT_LEFT] + stat[runtime.cv2.CC_STAT_WIDTH])
        for stat in components
    )
    bottom = max(
        int(stat[runtime.cv2.CC_STAT_TOP] + stat[runtime.cv2.CC_STAT_HEIGHT])
        for stat in components
    )
    ink_width = max(1, right - left)
    ink_height = max(1, bottom - top)
    pair = [first, second]
    widths = [int(stat[runtime.cv2.CC_STAT_WIDTH]) for stat in pair]
    heights = [int(stat[runtime.cv2.CC_STAT_HEIGHT]) for stat in pair]
    tops = [int(stat[runtime.cv2.CC_STAT_TOP]) for stat in pair]
    bottoms = [tops[index] + heights[index] for index in range(2)]
    pair_gap = int(second[runtime.cv2.CC_STAT_LEFT]) - (
        int(first[runtime.cv2.CC_STAT_LEFT]) + widths[0]
    )
    preceding = components[:-2]
    has_tall_preceding_ink = any(
        int(stat[runtime.cv2.CC_STAT_TOP] + stat[runtime.cv2.CC_STAT_HEIGHT])
        >= top + ink_height * 0.85
        for stat in preceding
    )
    return (
        int(first[runtime.cv2.CC_STAT_LEFT]) >= left + ink_width * 0.45
        and max(heights) <= ink_height * 0.5
        and max(bottoms) <= top + ink_height * 0.6
        and min(widths) / max(widths) >= 0.7
        and min(heights) / max(heights) >= 0.72
        and max(tops) - min(tops) <= max(heights) * 0.3
        and pair_gap <= max(widths) * 0.5
        and has_tall_preceding_ink
        and all(_component_looks_like_caret(mask, stat) for stat in pair)
    )

runtime.detect_trailing_double_caret = detect_trailing_double_caret

def normalize_symbol_emoticon_text(
    text: str,
    lang: str,
    image: runtime.Any,
) -> str:
    """Restore raised ASCII-style emoticons that Korean OCR folds into a syllable."""
    value = str(text or '').strip()
    if (
        lang == 'korean'
        and value
        and '\uac00' <= value[-1] <= '\ud7af'
        and runtime.detect_trailing_double_caret(image)
    ):
        return f'{value[:-1]}^^'
    return value

runtime.normalize_symbol_emoticon_text = normalize_symbol_emoticon_text

def recognize_candidate_rows(rows: list[dict[str, runtime.Any]], languages: list[str]) -> list[dict[str, runtime.Any]]:
    """按语言批量识别透视候选，输出仍与候选索引一一对应。"""
    output: list[dict[str, runtime.Any]] = []
    if not rows:
        return output
    images = [row['image'] for row in rows]
    for current_lang in languages:
        client = runtime.get_text_recognition_client(current_lang)
        results = runtime.as_list(client.predict(images, batch_size=min(16, len(images))))
        for index, result in enumerate(results[:len(rows)]):
            mapping = runtime.result_to_mapping(result) or {}
            text = runtime.scalar_result_value(mapping.get('rec_text'), '')
            score = runtime.scalar_result_value(mapping.get('rec_score'), 0.0)
            candidate = {key: value for key, value in rows[index].items() if key != 'image'}
            normalized_text = runtime.normalize_symbol_emoticon_text(
                str(text or ''),
                current_lang,
                rows[index]['image'],
            )
            output.append({**candidate, 'text': normalized_text, 'score': float(score) if runtime.is_number(score) else 0.0, 'lang': current_lang})
    return output

runtime.recognize_candidate_rows = recognize_candidate_rows

def scalar_result_value(value: runtime.Any, fallback: runtime.Any) -> runtime.Any:
    plain = runtime.to_plain(value)
    if isinstance(plain, (list, tuple)):
        return plain[0] if plain else fallback
    return fallback if plain is None else plain

runtime.scalar_result_value = scalar_result_value

def count_target_script_chars(text: str, lang: str) -> int:
    raw = str(text or '')
    if lang == 'korean':
        return len([char for char in raw if '가' <= char <= '\ud7af'])
    if lang == 'japan':
        return len([char for char in raw if '\u3040' <= char <= 'ヿ' or '一' <= char <= '鿿'])
    if lang == 'en':
        return len([char for char in raw if char.isascii() and char.isalpha()])
    return len([char for char in raw if '一' <= char <= '鿿'])

runtime.count_target_script_chars = count_target_script_chars

def recognition_quality(row: dict[str, runtime.Any]) -> float:
    text = str(row.get('text') or '').strip()
    script_chars = runtime.count_target_script_chars(text, str(row.get('lang') or ''))
    meaningful = sum((1 for char in text if char.isalnum() or '\u3040' <= char <= '\ud7af'))
    return float(row.get('score') or 0.0) + min(script_chars, 12) * 0.025 + min(meaningful, 20) * 0.003

runtime.recognition_quality = recognition_quality

def select_best_recognition(rows: list[dict[str, runtime.Any]], detection: dict[str, runtime.Any] | None=None) -> dict[str, runtime.Any]:
    """识别质量接近时用检测几何稳定竖排方向，明显更优的结果仍优先。"""
    candidates = [row for row in rows if isinstance(row, dict)]
    if not candidates:
        return {}
    best = max(candidates, key=runtime.recognition_quality)
    rotation = float((detection or {}).get('rotation_deg') or 0.0)
    if abs(rotation) < 45:
        return best
    preferred_orientation = 90 if rotation > 0 else -90
    preferred_rows = [row for row in candidates if int(row.get('orientation') or 0) == preferred_orientation]
    if not preferred_rows:
        return best
    preferred = max(preferred_rows, key=runtime.recognition_quality)
    if preferred is best:
        return best
    best_script_chars = runtime.count_target_script_chars(str(best.get('text') or ''), str(best.get('lang') or ''))
    preferred_script_chars = runtime.count_target_script_chars(str(preferred.get('text') or ''), str(preferred.get('lang') or ''))
    if best_script_chars > 0 and preferred_script_chars > 0 and (runtime.recognition_quality(best) - runtime.recognition_quality(preferred) <= runtime.VERTICAL_ORIENTATION_TIE_MARGIN):
        return preferred
    return best

runtime.select_best_recognition = select_best_recognition

def _run_slice_ocr_pipeline(
    image_bytes: bytes,
    lang: str,
    params: dict[str, float],
    debug: bool=False,
    debug_id: str='',
    mode: str='fast',
    seam_rows: list[int] | None=None,
) -> dict[str, runtime.Any]:
    """合并主/宽松检测框，透视裁剪后批量识别所有唯一候选。"""
    image_width, image_height = runtime.get_image_size(image_bytes)
    primary_detections = runtime._run_detection_only(image_bytes, lang, params)
    recovery_params = {**params, 'text_det_thresh': min(float(params['text_det_thresh']), 0.2), 'text_det_box_thresh': min(float(params['text_det_box_thresh']), 0.42)}
    recovery_detections: list[dict[str, runtime.Any]] = []
    try:
        recovery_detections = runtime._run_detection_only(image_bytes, lang, recovery_params)
    except Exception as exc:
        print(f'[slice-ocr] relaxed detection failed, using primary detections: {exc}', flush=True)
    detections, recovery_added = runtime.merge_detection_passes(primary_detections, recovery_detections)
    normalized_seam_rows = runtime.normalize_seam_rows(seam_rows, image_height)
    seam_recovery_bytes = runtime.build_seam_recovery_image_bytes(
        image_bytes,
        normalized_seam_rows,
    )
    seam_recovery_added = 0
    if seam_recovery_bytes:
        seam_detections = runtime._run_detection_only(
            seam_recovery_bytes,
            lang,
            recovery_params,
        )
        seam_detections = [
            detection for detection in seam_detections
            if runtime.detection_touches_seam(detection, normalized_seam_rows)
        ]
        detections, seam_recovery_added = runtime.merge_detection_passes(
            detections,
            seam_detections,
        )
    enhanced_added = 0
    if mode == 'enhanced':
        source_image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
        enhanced_image = runtime.build_enhanced_grayscale_image(source_image, False)
        enhanced_buffer = runtime.io.BytesIO()
        enhanced_image.save(enhanced_buffer, format='PNG')
        enhanced_detections = runtime._run_detection_only(enhanced_buffer.getvalue(), lang, recovery_params)
        detections, enhanced_added = runtime.merge_detection_passes(detections, enhanced_detections)
    candidate_rows: list[dict[str, runtime.Any]] = []
    detected_regions: list[dict[str, runtime.Any]] = []
    failed_detections = 0
    for det_index, det in enumerate(detections):
        region_id = f"region-{det_index:04d}-" + '-'.join(f"{point[0]:.1f},{point[1]:.1f}" for point in det['polygon'])
        crop_result = runtime._deskew_crop_region(image_bytes, det['polygon'], region_id)
        if crop_result is None:
            failed_detections += 1
            continue
        deskewed_bytes = crop_result['imageBytes']
        detected_region = {**crop_result['detectedRegion'], 'detectionScore': float(det.get('det_score') or 0.0)}
        detected_regions.append(detected_region)
        crop = runtime.decode_cv_image(deskewed_bytes)
        height, width = crop.shape[:2]
        orientations = [(90, runtime.cv2.rotate(crop, runtime.cv2.ROTATE_90_CLOCKWISE)), (-90, runtime.cv2.rotate(crop, runtime.cv2.ROTATE_90_COUNTERCLOCKWISE))] if runtime.is_confident_vertical_crop(width, height) else [(0, crop)]
        for orientation, candidate in orientations:
            candidate_rows.append({'detection_index': det_index, 'region_id': region_id, 'orientation': orientation, 'variant': 'original', 'image': candidate})
        if seam_recovery_bytes and runtime.detection_touches_seam(det, normalized_seam_rows):
            repaired_crop = runtime._deskew_crop_region(
                seam_recovery_bytes,
                det['polygon'],
                region_id,
            )
            if repaired_crop is not None:
                repaired_image = runtime.decode_cv_image(repaired_crop['imageBytes'])
                candidate_rows.append({
                    'detection_index': det_index,
                    'region_id': region_id,
                    'orientation': 0,
                    'variant': 'seam_recovery',
                    'image': repaired_image,
                })
        if debug:
            debug_dir = runtime.service_debug_dir('slice_crops')
            debug_dir.mkdir(parents=True, exist_ok=True)
            (debug_dir / f'slice-{runtime.safe_debug_stem(debug_id)}-{det_index:03d}.png').write_bytes(deskewed_bytes)
    if failed_detections > 0:
        raise RuntimeError(f'perspective crop failed for {failed_detections} detection(s)')
    languages = ['japan', 'korean'] if lang == 'auto' else [lang]
    recognized = runtime.recognize_candidate_rows(candidate_rows, languages)
    primary_best = {det_index: runtime.select_best_recognition([row for row in recognized if row['detection_index'] == det_index], detections[det_index]) for det_index in range(len(detections))}
    primary_best = {index: row for index, row in primary_best.items() if row}
    weak_indexes = {detection_index for detection_index, row in primary_best.items() if row['orientation'] == 0 and (row['score'] < 0.72 or runtime.count_target_script_chars(row['text'], row['lang']) == 0)}
    retry_rows = [{**row, 'orientation': 180, 'image': runtime.cv2.rotate(row['image'], runtime.cv2.ROTATE_180)} for row in candidate_rows if row['detection_index'] in weak_indexes and row['orientation'] == 0]
    recognized.extend(runtime.recognize_candidate_rows(retry_rows, languages))
    best_by_detection = {det_index: runtime.select_best_recognition([row for row in recognized if row['detection_index'] == det_index], detections[det_index]) for det_index in range(len(detections))}
    best_by_detection = {index: row for index, row in best_by_detection.items() if row}
    raw_items: list[dict[str, runtime.Any]] = []
    for det_index, det in enumerate(detections):
        row = best_by_detection.get(det_index, {})
        raw_items.append({'region_id': str(row.get('region_id') or f'region-{det_index:04d}'), 'text': str(row.get('text') or '').strip(), 'score': float(row.get('score') or 0.0), 'box': det['box'], 'polygon': det['polygon'], 'det_score': float(det.get('det_score') or 0.0), 'rotation_deg': float(det.get('rotation_deg') or 0.0), 'orientation_applied': int(row.get('orientation') or 0), 'lang': str(row.get('lang') or lang), 'variant': str(row.get('variant') or f'perspective_{mode}_raw')})
    recognized_items: list[dict[str, runtime.Any]] = []
    min_score = float(params.get('text_rec_score_thresh') or 0.0)
    for det_index, row in best_by_detection.items():
        text = str(row.get('text') or '').strip()
        if not text or float(row.get('score') or 0.0) < min_score or runtime.is_symbol_only_text(text):
            continue
        det = detections[det_index]
        region_id = str(row.get('region_id') or detected_regions[det_index]['regionId'])
        recognized_items.append({'region_id': region_id, 'member_region_ids': [region_id], 'text': text, 'score': float(row['score']), 'box': det['box'], 'polygon': det['polygon'], 'det_score': float(det.get('det_score') or 0.0), 'rotation_deg': float(det.get('rotation_deg') or 0.0), 'orientation_applied': int(row['orientation']), 'lang': row['lang'], 'variant': str(row.get('variant') or f'perspective_{mode}')})
    normalized = runtime.sort_items(runtime.dedupe_items(recognized_items))
    regions = runtime.annotate_visual_regions(image_bytes, normalized)
    recognized_regions = [{'regionId': item['region_id'], 'text': item['text'], 'confidence': item['score'], 'language': item['lang'], 'appliedOrientation': item['orientation_applied']} for item in normalized]
    semantic_blocks = [{'id': f"block-{index:04d}", 'memberRegionIds': item['member_region_ids'], 'originalText': item['text'], 'readingOrder': index} for index, item in enumerate(normalized)]
    return {'items': normalized, 'rawItems': raw_items, 'boxes': runtime.response_boxes(normalized), 'regions': regions, 'detectedRegions': detected_regions, 'recognizedRegions': recognized_regions, 'semanticBlocks': semantic_blocks, 'geometryReliability': 'detected', 'imageWidth': image_width, 'imageHeight': image_height, 'deskew': True, 'detections': len(detections), 'recognized': len(normalized), 'counts': {'paddle_raw_items': len(recognized), 'filtered_items': len(recognized_items), 'merged_blocks': len(normalized), 'variants': 1 + int(mode == 'enhanced') + int(bool(seam_recovery_bytes)), 'langs': len(languages), 'primary_detections': len(primary_detections), 'recovery_detections': len(recovery_detections), 'recovery_added': recovery_added, 'enhanced_added': enhanced_added, 'seam_recovery_added': seam_recovery_added}}

runtime._run_slice_ocr_pipeline = _run_slice_ocr_pipeline

def run_fast_perspective_ocr(
    image_bytes: bytes,
    lang: str,
    params: dict[str, float],
    debug: bool,
    debug_id: str,
    mode: str='fast',
    seam_rows: list[int] | None=None,
) -> dict[str, runtime.Any]:
    result = runtime._run_slice_ocr_pipeline(
        image_bytes,
        lang,
        params,
        debug,
        debug_id,
        mode,
        seam_rows,
    )
    if debug or runtime.os.environ.get('LOCAL_OCR_DEBUG_ALWAYS', '1') != '0':
        debug_stem = runtime.safe_debug_stem(debug_id or f'{int(runtime.time.time() * 1000)}')
        debug_paths = {'input': runtime.save_debug_input(image_bytes, debug_id), 'plugin_input': runtime.save_service_plugin_input(image_bytes, debug_stem), 'vis': runtime.save_service_vis(image_bytes, result['items'], debug_stem)}
        result['debug'] = debug_paths
        debug_paths['result_json'] = runtime.save_service_result_json(result, debug_stem)
    else:
        result['debug'] = {}
    return result

runtime.run_fast_perspective_ocr = run_fast_perspective_ocr
