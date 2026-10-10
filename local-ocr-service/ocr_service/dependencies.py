from __future__ import annotations

import asyncio  # noqa: F401 - 通过 runtime.asyncio 供 pipeline 模块使用 to_thread
import base64
import io
import json
import math
import os
import shutil
import sys
import tempfile
import threading
import time
import types
import unicodedata
from pathlib import Path
from typing import Any

os.environ.setdefault("FLAGS_use_onednn", "0")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("ONEDNN_VERBOSE", "0")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

if os.environ.get("LOCAL_OCR_DISABLE_MODELSCOPE", "1") != "0":
    modelscope_stub = types.ModuleType("modelscope")

    def _disabled_modelscope_download(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("ModelScope is disabled for the local OCR service.")

    modelscope_stub.snapshot_download = _disabled_modelscope_download
    sys.modules.setdefault("modelscope", modelscope_stub)

from fastapi import HTTPException, Request
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
from term_extractor import (
    extract_term_candidates,
    extract_term_candidates_with_stats,
    get_term_extractor_status,
)
from glossary_db import GlossaryDB
from translation_store import TranslationStore

try:
    from paddleocr import PaddleOCR, TextDetection, TextRecognition
except Exception as exc:  # pragma: no cover
    PaddleOCR = TextDetection = TextRecognition = None
    PADDLEOCR_IMPORT_ERROR = exc
else:
    PADDLEOCR_IMPORT_ERROR = None

try:
    import paddle
except Exception as exc:  # pragma: no cover
    paddle = None
    PADDLE_IMPORT_ERROR = exc
else:
    PADDLE_IMPORT_ERROR = PADDLEOCR_IMPORT_ERROR

CV2_AVAILABLE = False
try:
    import cv2  # type: ignore[import-untyped]
    import numpy as np  # type: ignore[import-untyped]
    CV2_AVAILABLE = True
except ImportError:  # pragma: no cover
    cv2 = np = None

from .runtime import runtime

def predict_concurrency_from_env() -> int:
    """Paddle 推理并发上限：默认 1（与改造前一致，单卡最安全）。"""
    raw = os.environ.get("LOCAL_OCR_PREDICT_CONCURRENCY", "1")
    try:
        return max(1, int(raw))
    except ValueError:
        return 1

DATA_ROOT = Path(__file__).resolve().parents[2] / ".local-data"
values = {
    **{name: value for name, value in globals().items() if not name.startswith("__")},
    "SUPPORTED_LANGS": {"auto", "japan", "korean", "en", "ch", "chinese_cht"},
    "SUPPORTED_OCR_MODES": {"fast", "enhanced"},
    "OCR_PREPROCESS_SCALE": 2,
    "DEFAULT_OCR_DEVICE": "gpu:0",
    "DEFAULT_TEXT_DET_THRESH": 0.3,
    "DEFAULT_TEXT_DET_BOX_THRESH": 0.6,
    "DEFAULT_TEXT_DET_UNCLIP_RATIO": 1.2,
    "SOLID_BACKGROUND_MAX_LAB_VARIANCE": 90.0,
    "SOLID_BACKGROUND_MAX_DELTA_E_P90": 20.0,
    "SOLID_BACKGROUND_MIN_DOMINANT_COVERAGE": 0.78,
    "VERTICAL_ORIENTATION_TIE_MARGIN": 0.08,
    "VERTICAL_CROP_MIN_ASPECT_RATIO": 1.4,
    "OCR_GEOMETRY_CONTRACT_VERSION": "detect-crop-recognize-appearance-layout-v7",
    # /ocr/timings 保留的最近请求数（分阶段 p50/p95）。
    "OCR_TIMINGS_WINDOW": 200,
    "DEBUG_DIR": DATA_ROOT / "debug-ocr",
    "SERVICE_DEBUG_ROOT": DATA_ROOT / "debug",
    "CV2_AVAILABLE": CV2_AVAILABLE,
    "_ocr_clients": {},
    "_text_detection_clients": {},
    "_text_recognition_clients": {},
    "_ocr_client_lock": threading.Lock(),
    # 推理槽位：只序列化 Paddle 的 predict，其余工作（解码/裁剪/外观分析/写盘）可并行。
    # det 与 rec 是不同模型实例，各自一把槽位，让 A 页识别与 B 页检测重叠。
    "OCR_PREDICT_CONCURRENCY": predict_concurrency_from_env(),
    "_ocr_predict_semaphore": threading.Semaphore(predict_concurrency_from_env()),
    "_ocr_det_semaphore": threading.Semaphore(predict_concurrency_from_env()),
    "_ocr_rec_semaphore": threading.Semaphore(predict_concurrency_from_env()),
    "ocr_warmup_state": None,
    "GLOSSARY_DB_PATH": os.environ.get("GLOSSARY_DB_PATH", str(DATA_ROOT / "glossary.db")),
    "TRANSLATION_DB_PATH": os.environ.get("TRANSLATION_DB_PATH", str(DATA_ROOT / "translations.db")),
    "EXTENSION_ORIGIN_PATTERN": r"^chrome-extension://[a-p]{32}$",
    "TranslationStore": TranslationStore,
    "_glossary_db": None,
    "_glossary_db": None,
    "_translation_store": None,
    "_translation_stream_provider": None,
}
runtime.__dict__.update(values)
print(
    "[MangaTranslator] 本地译文库服务已启动（无鉴权，仅供本机扩展使用），"
    f"译文库：{runtime.TRANSLATION_DB_PATH}",
    flush=True,
)
