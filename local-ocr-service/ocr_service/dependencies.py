from __future__ import annotations

import asyncio
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
from term_extractor import extract_term_candidates, get_term_extractor_status
from glossary_db import GlossaryDB

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

DATA_ROOT = Path(__file__).resolve().parents[2] / ".local-data"
values = {
    **{name: value for name, value in globals().items() if not name.startswith("__")},
    "SUPPORTED_LANGS": {"auto", "japan", "korean"},
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
    "OCR_GEOMETRY_CONTRACT_VERSION": "detect-crop-recognize-appearance-layout-v2",
    "DEBUG_DIR": DATA_ROOT / "debug-ocr",
    "SERVICE_DEBUG_ROOT": DATA_ROOT / "debug",
    "CV2_AVAILABLE": CV2_AVAILABLE,
    "_ocr_clients": {},
    "_text_detection_clients": {},
    "_text_recognition_clients": {},
    "_ocr_client_lock": threading.Lock(),
    "_ocr_runtime_lock": asyncio.Lock(),
    "GLOSSARY_DB_PATH": os.environ.get("GLOSSARY_DB_PATH", str(DATA_ROOT / "glossary.db")),
    "_glossary_db": None,
}
runtime.__dict__.update(values)
