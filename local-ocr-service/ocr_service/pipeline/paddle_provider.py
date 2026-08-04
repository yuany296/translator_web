from __future__ import annotations

from ..dependencies import runtime

def get_ocr(lang: str, params: dict[str, float]) -> runtime.Any:
    return runtime.get_ocr_for_models(lang, runtime.get_ocr_version(lang), runtime.get_detection_model_name(lang), runtime.get_recognition_model_name(lang))

runtime.get_ocr = get_ocr

def get_ocr_for_models(lang: str, ocr_version: str, det_model: str, rec_model: str) -> runtime.Any:
    with runtime._ocr_client_lock:
        device = runtime.get_runtime_device()
        key = runtime.build_ocr_client_key(lang, device, ocr_version, det_model, rec_model)
        client = runtime._ocr_clients.get(key)
        if client is not None:
            return client
        client = runtime.create_ocr_client(lang, device, ocr_version, det_model, rec_model)
        runtime._ocr_clients[key] = client
        return client

runtime.get_ocr_for_models = get_ocr_for_models

def build_ocr_client_key(lang: str, device: str, ocr_version: str, det_model: str, rec_model: str) -> str:
    return '|'.join([lang, device, ocr_version, det_model, rec_model])

runtime.build_ocr_client_key = build_ocr_client_key

def get_ocr_version(lang: str) -> str:
    return 'PP-OCRv5'

runtime.get_ocr_version = get_ocr_version

def get_detection_model_name(lang: str) -> str:
    return 'PP-OCRv5_server_det'

runtime.get_detection_model_name = get_detection_model_name

def get_recognition_model_name(lang: str) -> str:
    if lang == 'korean':
        return 'korean_PP-OCRv5_mobile_rec'
    if lang == 'japan':
        return 'japan_PP-OCRv3_mobile_rec'
    if lang == 'en':
        return 'en_PP-OCRv5_mobile_rec'
    if lang in {'ch', 'chinese_cht'}:
        return 'PP-OCRv5_server_rec'
    return 'PP-OCRv5_mobile_rec'

runtime.get_recognition_model_name = get_recognition_model_name

def create_ocr_client(lang: str, device: str, ocr_version: str, det_model: str, rec_model: str) -> runtime.Any:
    kwargs = {'lang': lang, 'device': device, 'ocr_version': ocr_version, 'text_detection_model_name': det_model, 'text_recognition_model_name': rec_model, 'use_doc_orientation_classify': False, 'use_doc_unwarping': False, 'use_textline_orientation': False}
    if device == 'cpu':
        kwargs.update({'enable_mkldnn': False, 'cpu_threads': 4})
    try:
        return runtime.PaddleOCR(**kwargs)
    except TypeError:
        return runtime.PaddleOCR(lang=lang, use_angle_cls=False, use_gpu=device != 'cpu')

runtime.create_ocr_client = create_ocr_client

def predict_with_lang(image_path: str, lang: str, params: dict[str, float]) -> runtime.Any:
    client = runtime.get_ocr(lang, params)
    return runtime.predict_with_client(client, image_path, params)

runtime.predict_with_lang = predict_with_lang

def predict_with_variant_lang(image_path: str, variant: dict[str, runtime.Any], lang: str, params: dict[str, float]) -> runtime.Any:
    if runtime.should_use_korean_v3_fallback(variant, lang):
        client = runtime.get_ocr_for_models(lang, 'PP-OCRv3', 'PP-OCRv3_mobile_det', 'korean_PP-OCRv3_mobile_rec')
        return runtime.predict_with_client(client, image_path, params)
    return runtime.predict_with_lang(image_path, lang, params)

runtime.predict_with_variant_lang = predict_with_variant_lang

def should_use_korean_v3_fallback(variant: dict[str, runtime.Any], lang: str) -> bool:
    return lang == 'korean' and str(variant.get('name') or '') == 'binary_text_2x' and runtime.env_bool('LOCAL_OCR_KOREAN_V3_FALLBACK', True)

runtime.should_use_korean_v3_fallback = should_use_korean_v3_fallback

def predict_with_client(client: runtime.Any, image_path: str, params: dict[str, float]) -> runtime.Any:
    predict_kwargs = {'use_doc_orientation_classify': False, 'use_doc_unwarping': False, 'use_textline_orientation': False, 'text_det_thresh': params['text_det_thresh'], 'text_det_box_thresh': params['text_det_box_thresh'], 'text_det_unclip_ratio': params['text_det_unclip_ratio'], 'text_rec_score_thresh': params['text_rec_score_thresh']}
    if hasattr(client, 'predict'):
        return client.predict(image_path, **predict_kwargs)
    return client.ocr(image_path, cls=False)

runtime.predict_with_client = predict_with_client

def filter_variant_items_for_normal_mode(items: list[dict[str, runtime.Any]], variant: dict[str, runtime.Any], lang: str) -> list[dict[str, runtime.Any]]:
    if not runtime.should_use_korean_v3_fallback(variant, lang):
        return items
    return [item for item in items if float(item.get('score') or 0.0) >= 0.88]

runtime.filter_variant_items_for_normal_mode = filter_variant_items_for_normal_mode

def get_runtime_device() -> str:
    requested = runtime.os.environ.get('LOCAL_OCR_DEVICE', runtime.DEFAULT_OCR_DEVICE).strip().lower()
    if requested == 'auto':
        requested = 'gpu:0'
    if requested in {'gpu', 'cuda'}:
        requested = 'gpu:0'
    if requested.startswith('gpu:'):
        if not runtime.is_cuda_available():
            raise RuntimeError('GPU OCR requested but Paddle CUDA is unavailable. Activate the conda env with GPU Paddle installed.')
        return requested
    if requested == 'cpu':
        return 'cpu'
    raise RuntimeError(f'Unsupported LOCAL_OCR_DEVICE: {requested}')

runtime.get_runtime_device = get_runtime_device

def is_cuda_available() -> bool:
    if runtime.paddle is None:
        return False
    try:
        if not bool(runtime.paddle.is_compiled_with_cuda()):
            return False
        return int(runtime.paddle.device.cuda.device_count()) > 0
    except Exception:
        return False

runtime.is_cuda_available = is_cuda_available
