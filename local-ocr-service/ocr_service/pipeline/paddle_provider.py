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
        # 日文不能用 japan_PP-OCRv3_mobile_rec：它在竖排漫画台词上会整行崩掉。
        # 实测同一块 CMOA 裁图（人眼可读「殺すモノをきっ」）：v3 mobile 无论原始/摆正/加白边/
        # 反色/2x 都只有 0.21~0.34 分并吐「桜すでくを」「成すでくでらの」，v5 是 0.95~0.99。
        # 横排同样 v5 更准（0.981→1.000，モ→毛 的那个错没了）。v5 是 PP-OCRv5 统一模型，
        # 保留日文字形（戦/図/訳/弁/悪/圧/郷 逐字正确，不会写成简体），源文与缓存身份不受影响；
        # 它与 ch 共用同一个模型文件，不额外占磁盘。
        return 'PP-OCRv5_server_rec'
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
    with runtime.predict_guard():
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

def warmup_languages() -> list[str]:
    """启动预热的识别语言，默认与 lang=auto 实际会跑的两条一致。"""
    raw = str(runtime.os.environ.get('LOCAL_OCR_WARMUP_LANGS', 'japan,korean') or '')
    langs = [item.strip() for item in raw.split(',') if item.strip()]
    valid = [lang for lang in langs if lang in runtime.SUPPORTED_LANGS]
    return valid or ['japan', 'korean']

runtime.warmup_languages = warmup_languages

def warm_up_ocr_models() -> dict[str, runtime.Any]:
    """后台预热检测与识别模型。

    模型是懒加载的：服务起来后第一个真实请求要等 10s 左右（实测首请求 detectPrimary 10.1s、
    单请求 totalMs p95 16.9s）。这里用一张小图把 det 与各识别模型先加载好，把这段成本
    从「用户翻到第一页」挪到「服务启动」。
    注意：检测客户端按阈值缓存，这里用扩展的默认阈值（0.3/0.6/1.2）预热，
    设置里改过阈值时仍会重新加载。
    """
    if runtime.PADDLE_IMPORT_ERROR is not None or not runtime.CV2_AVAILABLE:
        state = {'ok': False, 'reason': 'paddle or cv2 unavailable'}
        runtime.ocr_warmup_state = state
        return state
    if runtime.env_bool('LOCAL_OCR_DISABLE_WARMUP', False):
        state = {'ok': False, 'reason': 'warmup disabled by LOCAL_OCR_DISABLE_WARMUP'}
        runtime.ocr_warmup_state = state
        print(f'[local-ocr] warmup {state}', flush=True)
        return state
    started = runtime.time.perf_counter()
    try:
        image = runtime.np.full((96, 96, 3), 255, dtype=runtime.np.uint8)
        encoded, buffer = runtime.cv2.imencode('.png', image)
        if not encoded:
            raise RuntimeError('warmup image encode failed')
        params = {
            'text_det_thresh': runtime.DEFAULT_TEXT_DET_THRESH,
            'text_det_box_thresh': runtime.DEFAULT_TEXT_DET_BOX_THRESH,
            'text_det_unclip_ratio': runtime.DEFAULT_TEXT_DET_UNCLIP_RATIO,
            'text_rec_score_thresh': 0.0,
        }
        runtime._run_detection_only(buffer.tobytes(), 'japan', params)
        row = {'detection_index': 0, 'region_id': 'warmup', 'orientation': 0, 'variant': 'warmup', 'image': image}
        for lang in warmup_languages():
            runtime.recognize_candidate_rows([dict(row)], [lang])
        state = {'ok': True, 'ms': round((runtime.time.perf_counter() - started) * 1000.0, 1), 'langs': warmup_languages()}
    except Exception as exc:  # noqa: BLE001 - 预热失败只能记日志，不能影响服务启动
        state = {'ok': False, 'error': str(exc)}
    runtime.ocr_warmup_state = state
    print(f'[local-ocr] warmup {state}', flush=True)
    return state

runtime.warm_up_ocr_models = warm_up_ocr_models
