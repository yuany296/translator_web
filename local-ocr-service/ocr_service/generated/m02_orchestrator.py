from __future__ import annotations

from ..dependencies import runtime

def normalize_lang(value: str) -> str:
    lang = (value or 'auto').strip().lower()
    if lang not in runtime.SUPPORTED_LANGS:
        return 'auto'
    return lang

runtime.normalize_lang = normalize_lang

def normalize_ocr_mode(value: str) -> str:
    mode = (value or 'fast').strip().lower()
    if mode not in runtime.SUPPORTED_OCR_MODES:
        return 'fast'
    return mode

runtime.normalize_ocr_mode = normalize_ocr_mode

def normalize_ocr_params(payload: runtime.OcrRequest) -> dict[str, float]:
    return {'text_det_thresh': runtime.clamp_float(payload.text_det_thresh, 0.01, 0.99, runtime.DEFAULT_TEXT_DET_THRESH), 'text_det_box_thresh': runtime.clamp_float(payload.text_det_box_thresh, 0.01, 0.99, runtime.DEFAULT_TEXT_DET_BOX_THRESH), 'text_det_unclip_ratio': runtime.clamp_float(payload.text_det_unclip_ratio, 1.0, 5.0, runtime.DEFAULT_TEXT_DET_UNCLIP_RATIO), 'text_rec_score_thresh': runtime.clamp_float(payload.text_rec_score_thresh, 0.0, 1.0, 0.0)}

runtime.normalize_ocr_params = normalize_ocr_params

def clamp_float(value: runtime.Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number < minimum:
        return minimum
    if number > maximum:
        return maximum
    return number

runtime.clamp_float = clamp_float

def env_bool(name: str, fallback: bool) -> bool:
    raw = runtime.os.environ.get(name)
    if raw is None:
        return fallback
    return raw.strip().lower() not in {'0', 'false', 'no', 'off', ''}

runtime.env_bool = env_bool

def env_float(name: str, fallback: float) -> float:
    raw = runtime.os.environ.get(name)
    if raw is None:
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback

runtime.env_float = env_float

def decode_data_url(value: str) -> bytes:
    raw = (value or '').strip()
    if not raw:
        raise runtime.HTTPException(status_code=400, detail='image is empty')
    marker = 'base64,'
    if marker in raw:
        raw = raw.split(marker, 1)[1]
    try:
        return runtime.base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise runtime.HTTPException(status_code=400, detail=f'invalid base64 image: {exc}') from exc

runtime.decode_data_url = decode_data_url

def run_ocr(image_bytes: bytes, lang: str, mode: str, params: dict[str, float], debug: bool, debug_id: str) -> dict[str, runtime.Any]:
    if mode in runtime.SUPPORTED_OCR_MODES and runtime.CV2_AVAILABLE and (runtime.TextDetection is not None) and (runtime.TextRecognition is not None):
        try:
            return runtime.run_fast_perspective_ocr(image_bytes, lang, params, debug, debug_id, mode)
        except Exception as exc:
            print(f'[local-ocr] detect/crop/recognize failed, using fallback OCR: {exc}', flush=True)
    image_width, image_height = runtime.get_image_size(image_bytes)
    variants = runtime.create_ocr_image_variants(image_bytes, mode)
    debug_paths: dict[str, str] = {}
    debug_enabled = debug or runtime.os.environ.get('LOCAL_OCR_DEBUG_ALWAYS', '1') != '0'
    debug_stem = runtime.safe_debug_stem(debug_id or f'{int(runtime.time.time() * 1000)}')
    return_raw = runtime.env_bool('OCR_RETURN_RAW', debug)
    filter_ui_text = runtime.env_bool('OCR_FILTER_UI_TEXT', not return_raw)
    merge_lines = runtime.env_bool('OCR_MERGE_LINES', True)
    min_score = runtime.env_float('OCR_MIN_SCORE', 0.0 if return_raw else params['text_rec_score_thresh'])
    if debug_enabled:
        debug_paths['input'] = runtime.save_debug_input(image_bytes, debug_id)
        debug_paths['plugin_input'] = runtime.save_service_plugin_input(image_bytes, debug_stem)
        debug_paths['input_received'] = runtime.save_service_input_received(image_bytes, debug_stem)
        debug_paths['input_to_paddle'] = runtime.save_service_input_to_paddle(variants, debug_stem)
    try:
        langs = ['japan', 'korean'] if lang == 'auto' else [lang]
        items: list[dict[str, runtime.Any]] = []
        raw_items: list[dict[str, runtime.Any]] = []
        raw_result_paths: list[str] = []
        crop_paths: list[str] = []
        for variant in variants:
            for current_lang in langs:
                raw_result = runtime.predict_with_variant_lang(str(variant['path']), variant, current_lang, params)
                variant_items = runtime.extract_items(raw_result, filter_symbols=filter_ui_text, min_score=min_score)
                if merge_lines:
                    variant_items = runtime.split_multiline_items(variant_items, variant, current_lang, params, debug_enabled, debug_stem)
                if not return_raw:
                    variant_items = runtime.filter_variant_items_for_normal_mode(variant_items, variant, current_lang)
                if debug_enabled:
                    raw_result_paths.append(runtime.save_service_raw_result(raw_result, variant_items, debug_stem, variant, current_lang))
                    crop_paths.extend(runtime.save_service_crops(variant['path'], variant_items, debug_stem, variant, current_lang))
                for item in variant_items:
                    raw_copy = dict(item)
                    raw_copy['lang'] = current_lang
                    raw_copy['variant'] = variant['name']
                    raw_items.append(raw_copy)
                    runtime.normalize_item_box_scale(item, float(variant['scale']))
                    item['lang'] = current_lang
                    item['variant'] = variant['name']
                    items.append(item)
        runtime.annotate_variant_support(items)
        normalized = runtime.sort_items(runtime.apply_korean_contextual_corrections(runtime.reconstruct_enhanced_items(items) if mode == 'enhanced' else runtime.dedupe_items(items)))
        if not return_raw and filter_ui_text:
            normalized = [item for item in normalized if not runtime.is_symbol_only_text(item.get('text'))]
        regions = runtime.annotate_visual_regions(image_bytes, normalized)
        boxes = runtime.response_boxes(normalized)
        counts = {'paddle_raw_items': len(raw_items), 'filtered_items': len(items), 'merged_blocks': len(normalized), 'variants': len(variants), 'langs': len(langs)}
        for item in normalized:
            item['geometryReliability'] = 'fallback'
        result_payload = {'items': normalized, 'boxes': boxes, 'regions': regions, 'imageWidth': image_width, 'imageHeight': image_height, 'debug': debug_paths, 'counts': counts, 'geometryReliability': 'fallback', 'detectedRegions': [], 'recognizedRegions': []}
        if return_raw:
            result_payload['rawItems'] = raw_items
        if debug_enabled:
            debug_paths['raw_result'] = raw_result_paths
            debug_paths['crops'] = crop_paths
            debug_paths['boxes'] = runtime.save_debug_boxes(image_bytes, normalized, debug_id)
            debug_paths['vis'] = runtime.save_service_vis(image_bytes, normalized, debug_stem)
            debug_paths['result_json'] = runtime.save_service_result_json(result_payload, debug_stem)
            debug_paths['latest_index'] = runtime.save_service_latest_debug_index(debug_paths, debug_stem)
        print(f"[local-ocr] counts raw_items={counts['paddle_raw_items']} filtered_items={counts['filtered_items']} merged_blocks={counts['merged_blocks']} return_raw={return_raw} filter_ui_text={filter_ui_text} merge_lines={merge_lines}", flush=True)
        return result_payload
    finally:
        for variant in variants:
            variant['path'].unlink(missing_ok=True)

runtime.run_ocr = run_ocr

def response_boxes(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    return [{'box': item.get('box'), 'polygon': item.get('polygon'), 'text': item.get('text', ''), 'score': float(item.get('score') or 0.0), 'det_score': float(item.get('det_score') or 0.0), 'rotation_deg': float(item.get('rotation_deg') or 0.0), 'orientation_applied': int(item.get('orientation_applied') or 0), 'region_id': str(item.get('region_id') or ''), 'region_type': str(item.get('region_type') or 'plain_text'), 'region_polygon': item.get('region_polygon'), 'bg_color': str(item.get('bg_color') or ''), 'text_color': str(item.get('text_color') or ''), 'stroke_color': str(item.get('stroke_color') or ''), 'region_confidence': float(item.get('region_confidence') or 0.0)} for item in items]

runtime.response_boxes = response_boxes
