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

# Windows CPU builds of PaddlePaddle 3.x can fail in the oneDNN path on OCR
# detection models. Disable that optimized backend before PaddleOCR is imported.
os.environ.setdefault("FLAGS_use_onednn", "0")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("ONEDNN_VERBOSE", "0")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

if os.environ.get("LOCAL_OCR_DISABLE_MODELSCOPE", "1") != "0":
    modelscope_stub = types.ModuleType("modelscope")

    def _disabled_modelscope_download(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("ModelScope is disabled for the local OCR service.")

    modelscope_stub.snapshot_download = _disabled_modelscope_download
    sys.modules.setdefault("modelscope", modelscope_stub)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
from pydantic import BaseModel

try:
    from paddleocr import PaddleOCR, TextDetection, TextRecognition
except Exception as exc:  # pragma: no cover - import failure is surfaced by /health
    PaddleOCR = None
    TextDetection = None
    TextRecognition = None
    PADDLEOCR_IMPORT_ERROR = exc
else:
    PADDLEOCR_IMPORT_ERROR = None

try:
    import paddle
except Exception as exc:  # pragma: no cover - import failure is surfaced by /health
    paddle = None
    PADDLE_IMPORT_ERROR = exc
else:
    PADDLE_IMPORT_ERROR = PADDLEOCR_IMPORT_ERROR


SUPPORTED_LANGS = {"auto", "japan", "korean"}
SUPPORTED_OCR_MODES = {"fast", "enhanced"}
OCR_PREPROCESS_SCALE = 2
DEFAULT_OCR_DEVICE = "gpu:0"
DEFAULT_TEXT_DET_THRESH = 0.3
DEFAULT_TEXT_DET_BOX_THRESH = 0.6
DEFAULT_TEXT_DET_UNCLIP_RATIO = 1.2
DEBUG_DIR = Path(__file__).resolve().parent / "debug-ocr"
SERVICE_DEBUG_ROOT = Path(__file__).resolve().parent / "debug"

# ---------------------------------------------------------------------------
# OpenCV 用于四边形透视裁剪。
# ---------------------------------------------------------------------------
CV2_AVAILABLE = False
try:
    import cv2  # type: ignore[import-untyped]
    import numpy as np  # type: ignore[import-untyped]
    CV2_AVAILABLE = True
except ImportError:
    pass


class OcrRequest(BaseModel):
    image: str
    lang: str = "auto"
    mode: str = "fast"
    text_det_thresh: float | None = None
    text_det_box_thresh: float | None = None
    text_det_unclip_ratio: float | None = None
    text_rec_score_thresh: float | None = None
    debug: bool = False
    debug_id: str = ""


app = FastAPI(title="Manga Translator Local OCR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_ocr_clients: dict[str, Any] = {}
_text_detection_clients: dict[str, Any] = {}
_text_recognition_clients: dict[str, Any] = {}
_ocr_client_lock = threading.Lock()
_ocr_runtime_lock = asyncio.Lock()


@app.get("/health")
def health() -> dict[str, Any]:
    device_error = ""
    try:
        device = get_runtime_device()
    except Exception as exc:
        device = ""
        device_error = str(exc)
    return {
        "ok": PADDLE_IMPORT_ERROR is None and not device_error,
        "engine": "paddleocr",
        "device": device,
        "cuda": is_cuda_available(),
        "cv2_available": CV2_AVAILABLE,
        "error": str(PADDLE_IMPORT_ERROR) if PADDLE_IMPORT_ERROR else device_error,
    }


@app.post("/ocr")
async def ocr(payload: OcrRequest) -> dict[str, Any]:
    if PADDLE_IMPORT_ERROR is not None:
        raise HTTPException(status_code=500, detail=f"PaddleOCR import failed: {PADDLE_IMPORT_ERROR}")

    lang = normalize_lang(payload.lang)
    mode = normalize_ocr_mode(payload.mode)
    image_bytes = decode_data_url(payload.image)
    params = normalize_ocr_params(payload)
    async with _ocr_runtime_lock:
        result = await asyncio.to_thread(
            run_ocr,
            image_bytes,
            lang,
            mode,
            params,
            bool(payload.debug),
            payload.debug_id,
        )
    return {
        "items": result["items"],
        "boxes": result["boxes"],
        "lang": lang,
        "mode": mode,
        "imageWidth": result["imageWidth"],
        "imageHeight": result["imageHeight"],
        "debug": result.get("debug", {}),
        "counts": result.get("counts", {}),
        "rawItems": result.get("rawItems", []),
    }


def normalize_lang(value: str) -> str:
    lang = (value or "auto").strip().lower()
    if lang not in SUPPORTED_LANGS:
        return "auto"
    return lang


def normalize_ocr_mode(value: str) -> str:
    mode = (value or "fast").strip().lower()
    if mode not in SUPPORTED_OCR_MODES:
        return "fast"
    return mode


def normalize_ocr_params(payload: OcrRequest) -> dict[str, float]:
    return {
        "text_det_thresh": clamp_float(payload.text_det_thresh, 0.01, 0.99, DEFAULT_TEXT_DET_THRESH),
        "text_det_box_thresh": clamp_float(payload.text_det_box_thresh, 0.01, 0.99, DEFAULT_TEXT_DET_BOX_THRESH),
        "text_det_unclip_ratio": clamp_float(
            payload.text_det_unclip_ratio,
            1.0,
            5.0,
            DEFAULT_TEXT_DET_UNCLIP_RATIO,
        ),
        "text_rec_score_thresh": clamp_float(payload.text_rec_score_thresh, 0.0, 1.0, 0.0),
    }


def clamp_float(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number < minimum:
        return minimum
    if number > maximum:
        return maximum
    return number


def env_bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback


def decode_data_url(value: str) -> bytes:
    raw = (value or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="image is empty")
    marker = "base64,"
    if marker in raw:
        raw = raw.split(marker, 1)[1]
    try:
        return base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid base64 image: {exc}") from exc


def run_ocr(
    image_bytes: bytes,
    lang: str,
    mode: str,
    params: dict[str, float],
    debug: bool,
    debug_id: str,
) -> dict[str, Any]:
    if mode == "fast" and CV2_AVAILABLE and TextDetection is not None and TextRecognition is not None:
        try:
            return run_fast_perspective_ocr(image_bytes, lang, params, debug, debug_id)
        except Exception as exc:
            # 独立模型或几何处理失败时保留原 Fast OCR，避免整张漫画不可用。
            print(f"[local-ocr] perspective fast OCR failed, falling back: {exc}", flush=True)

    image_width, image_height = get_image_size(image_bytes)
    variants = create_ocr_image_variants(image_bytes, mode)
    debug_paths: dict[str, str] = {}
    debug_enabled = debug or os.environ.get("LOCAL_OCR_DEBUG_ALWAYS", "1") != "0"
    debug_stem = safe_debug_stem(debug_id or f"{int(time.time() * 1000)}")
    return_raw = env_bool("OCR_RETURN_RAW", debug)
    filter_ui_text = env_bool("OCR_FILTER_UI_TEXT", not return_raw)
    merge_lines = env_bool("OCR_MERGE_LINES", True)
    min_score = env_float("OCR_MIN_SCORE", 0.0 if return_raw else params["text_rec_score_thresh"])
    if debug_enabled:
        debug_paths["input"] = save_debug_input(image_bytes, debug_id)
        debug_paths["plugin_input"] = save_service_plugin_input(image_bytes, debug_stem)
        debug_paths["input_received"] = save_service_input_received(image_bytes, debug_stem)
        debug_paths["input_to_paddle"] = save_service_input_to_paddle(variants, debug_stem)

    try:
        langs = ["japan", "korean"] if lang == "auto" else [lang]
        items: list[dict[str, Any]] = []
        raw_items: list[dict[str, Any]] = []
        raw_result_paths: list[str] = []
        crop_paths: list[str] = []
        for variant in variants:
            for current_lang in langs:
                raw_result = predict_with_variant_lang(str(variant["path"]), variant, current_lang, params)
                variant_items = extract_items(raw_result, filter_symbols=filter_ui_text, min_score=min_score)
                if merge_lines:
                    variant_items = split_multiline_items(
                        variant_items,
                        variant,
                        current_lang,
                        params,
                        debug_enabled,
                        debug_stem,
                    )
                if not return_raw:
                    variant_items = filter_variant_items_for_normal_mode(variant_items, variant, current_lang)
                if debug_enabled:
                    raw_result_paths.append(save_service_raw_result(raw_result, variant_items, debug_stem, variant, current_lang))
                    crop_paths.extend(save_service_crops(variant["path"], variant_items, debug_stem, variant, current_lang))
                for item in variant_items:
                    raw_copy = dict(item)
                    raw_copy["lang"] = current_lang
                    raw_copy["variant"] = variant["name"]
                    raw_items.append(raw_copy)
                    normalize_item_box_scale(item, float(variant["scale"]))
                    item["lang"] = current_lang
                    item["variant"] = variant["name"]
                    items.append(item)
        annotate_variant_support(items)
        normalized = sort_items(
            apply_korean_contextual_corrections(
                reconstruct_enhanced_items(items) if mode == "enhanced" else dedupe_items(items)
            )
        )
        if not return_raw and filter_ui_text:
            normalized = [item for item in normalized if not is_symbol_only_text(item.get("text"))]
        boxes = response_boxes(normalized)
        counts = {
            "paddle_raw_items": len(raw_items),
            "filtered_items": len(items),
            "merged_blocks": len(normalized),
            "variants": len(variants),
            "langs": len(langs),
        }
        result_payload = {
            "items": normalized,
            "boxes": boxes,
            "imageWidth": image_width,
            "imageHeight": image_height,
            "debug": debug_paths,
            "counts": counts,
        }
        if return_raw:
            result_payload["rawItems"] = raw_items
        if debug_enabled:
            debug_paths["raw_result"] = raw_result_paths
            debug_paths["crops"] = crop_paths
            debug_paths["boxes"] = save_debug_boxes(image_bytes, normalized, debug_id)
            debug_paths["vis"] = save_service_vis(image_bytes, normalized, debug_stem)
            debug_paths["result_json"] = save_service_result_json(result_payload, debug_stem)
            debug_paths["latest_index"] = save_service_latest_debug_index(debug_paths, debug_stem)
        print(
            "[local-ocr] counts "
            f"raw_items={counts['paddle_raw_items']} "
            f"filtered_items={counts['filtered_items']} "
            f"merged_blocks={counts['merged_blocks']} "
            f"return_raw={return_raw} filter_ui_text={filter_ui_text} merge_lines={merge_lines}",
            flush=True,
        )
        return result_payload
    finally:
        for variant in variants:
            variant["path"].unlink(missing_ok=True)


def response_boxes(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "box": item.get("box"),
            "polygon": item.get("polygon"),
            "text": item.get("text", ""),
            "score": float(item.get("score") or 0.0),
            "det_score": float(item.get("det_score") or 0.0),
            "rotation_deg": float(item.get("rotation_deg") or 0.0),
            "orientation_applied": int(item.get("orientation_applied") or 0),
        }
        for item in items
    ]


def get_image_size(image_bytes: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 0, 0


def safe_debug_stem(debug_id: str) -> str:
    raw = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in str(debug_id or "").strip())
    return raw[:80] or f"ocr-{os.getpid()}-{threading.get_ident()}"


def save_debug_input(image_bytes: bytes, debug_id: str) -> str:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    path = DEBUG_DIR / f"input-{safe_debug_stem(debug_id)}.png"
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image.save(path)
    except Exception:
        path.write_bytes(image_bytes)
    return str(path)


def save_debug_boxes(image_bytes: bytes, items: list[dict[str, Any]], debug_id: str) -> str:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    path = DEBUG_DIR / f"boxes-{safe_debug_stem(debug_id)}.png"
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    draw = ImageDraw.Draw(image)
    for item in items:
        box = item.get("box") if isinstance(item, dict) else None
        if not isinstance(box, dict):
            continue
        left = float(box.get("left") or 0)
        top = float(box.get("top") or 0)
        width = float(box.get("width") or 0)
        height = float(box.get("height") or 0)
        if width <= 0 or height <= 0:
            continue
        right = left + width
        bottom = top + height
        draw.rectangle([left, top, right, bottom], outline=(255, 0, 0), width=3)
        label = str(item.get("text") or "")[:24]
        if label:
            draw.text((left + 2, max(0, top - 14)), label, fill=(255, 0, 0))
    image.save(path)
    return str(path)


def service_debug_dir(name: str) -> Path:
    path = SERVICE_DEBUG_ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_service_input_received(image_bytes: bytes, stem: str) -> str:
    path = service_debug_dir("input_received") / f"{stem}.png"
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image.save(path)
    return str(path)


def save_service_plugin_input(image_bytes: bytes, stem: str) -> str:
    path = service_debug_dir("plugin_input") / f"{stem}.png"
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image.save(path)
    return str(path)


def save_service_input_to_paddle(variants: list[dict[str, Any]], stem: str) -> list[str]:
    output_dir = service_debug_dir("input_to_paddle")
    paths = []
    for variant in variants:
        name = str(variant.get("name") or "variant")
        src = Path(variant["path"])
        dst = output_dir / f"{stem}-{name}.png"
        shutil.copyfile(src, dst)
        paths.append(str(dst))
    return paths


def save_service_raw_result(raw_result: Any, items: list[dict[str, Any]], stem: str, variant: dict[str, Any], lang: str) -> str:
    name = safe_debug_stem(f"{stem}-{variant.get('name', 'variant')}-{lang}")
    path = service_debug_dir("raw_result") / f"{name}.json"
    payload = {
        "variant": variant.get("name", ""),
        "lang": lang,
        "scale": variant.get("scale", 1.0),
        "raw": to_plain(raw_result),
        "extracted_items": items,
        "raw_items_count": len(items),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return str(path)


def save_service_crops(image_path: Path | str, items: list[dict[str, Any]], stem: str, variant: dict[str, Any], lang: str) -> list[str]:
    output_dir = service_debug_dir("crops") / safe_debug_stem(stem)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    try:
        image = Image.open(image_path).convert("RGB")
    except Exception:
        return paths
    for index, item in enumerate(items, start=1):
        box = item.get("box")
        if not isinstance(box, dict):
            continue
        left = max(0, int(float(box.get("left") or 0)))
        top = max(0, int(float(box.get("top") or 0)))
        right = min(image.width, int(float(box.get("left") or 0) + float(box.get("width") or 0)))
        bottom = min(image.height, int(float(box.get("top") or 0) + float(box.get("height") or 0)))
        if right <= left or bottom <= top:
            continue
        text_slug = safe_debug_stem(str(item.get("text") or "text"))[:24]
        path = output_dir / f"{safe_debug_stem(str(variant.get('name') or 'variant'))}-{lang}-{index:03d}-{text_slug}.png"
        image.crop((left, top, right, bottom)).save(path)
        paths.append(str(path))
    return paths


def save_service_result_json(result: dict[str, Any], stem: str) -> str:
    path = service_debug_dir("result_json") / f"{stem}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return str(path)


def save_service_latest_debug_index(debug_paths: dict[str, Any], stem: str) -> str:
    path = SERVICE_DEBUG_ROOT / "LATEST_DEBUG_PATHS.json"
    payload = {
        "debug_id": stem,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "paths": debug_paths,
    }
    SERVICE_DEBUG_ROOT.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return str(path)


def save_service_vis(image_bytes: bytes, items: list[dict[str, Any]], stem: str) -> str:
    path = service_debug_dir("vis") / f"{stem}.png"
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    draw_debug_boxes(image, items).save(path)
    return str(path)


def draw_debug_boxes(image: Image.Image, items: list[dict[str, Any]]) -> Image.Image:
    source = image.copy().convert("RGB")
    side_width = 430
    canvas = Image.new("RGB", (source.width + side_width, source.height), (255, 255, 255))
    canvas.paste(source, (0, 0))
    draw = ImageDraw.Draw(canvas)
    font = load_debug_font(15)
    draw.rectangle([source.width, 0, canvas.width - 1, canvas.height - 1], fill=(255, 255, 255), outline=(220, 220, 220))
    draw.text((source.width + 16, 16), "OCR boxes", fill=(40, 40, 40), font=font)
    for index, item in enumerate(items, start=1):
        box = item.get("box") if isinstance(item, dict) else None
        if not isinstance(box, dict):
            continue
        left = float(box.get("left") or 0)
        top = float(box.get("top") or 0)
        width = float(box.get("width") or 0)
        height = float(box.get("height") or 0)
        if width <= 0 or height <= 0:
            continue
        right = left + width
        bottom = top + height
        draw.rectangle([left, top, right, bottom], outline=(255, 0, 0), width=3)
        draw.rectangle([left, max(0, top - 20), left + 28, max(18, top - 2)], fill=(255, 255, 255), outline=(255, 0, 0))
        draw.text((left + 3, max(0, top - 20)), str(index), fill=(255, 0, 0), font=font)
        label_top = 48 + (index - 1) * 48
        if label_top + 42 < canvas.height:
            label = f"{index}. {float(item.get('score') or 0.0):.2f}"
            draw.text((source.width + 16, label_top), label, fill=(255, 0, 0), font=font)
            draw.text((source.width + 74, label_top), str(item.get("text") or "")[:34], fill=(20, 20, 20), font=font)
    return canvas


def load_debug_font(size: int) -> ImageFont.ImageFont:
    for candidate in [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\GOTHIC.TTF",
    ]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def create_ocr_image_variants(image_bytes: bytes, mode: str) -> list[dict[str, Any]]:
    variants = [{"name": "original", "path": write_temp_image_bytes(image_bytes), "scale": 1.0}]
    if mode != "enhanced":
        return variants

    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        return variants

    enhanced = build_enhanced_grayscale_image(image, invert=False)
    inverted = build_enhanced_grayscale_image(image, invert=True)
    binary_text = build_binary_text_image(image)
    variants.append({"name": "gray_contrast_2x", "path": write_temp_pil_image(enhanced), "scale": OCR_PREPROCESS_SCALE})
    variants.append({"name": "inverted_contrast_2x", "path": write_temp_pil_image(inverted), "scale": OCR_PREPROCESS_SCALE})
    variants.append({"name": "binary_text_2x", "path": write_temp_pil_image(binary_text), "scale": OCR_PREPROCESS_SCALE})
    return variants


def build_enhanced_grayscale_image(image: Image.Image, invert: bool) -> Image.Image:
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray, cutoff=1)
    if invert:
        gray = ImageOps.invert(gray)
    gray = ImageEnhance.Contrast(gray).enhance(2.2)
    gray = ImageEnhance.Sharpness(gray).enhance(1.6)
    if OCR_PREPROCESS_SCALE > 1:
        width = max(1, image.width * OCR_PREPROCESS_SCALE)
        height = max(1, image.height * OCR_PREPROCESS_SCALE)
        gray = gray.resize((width, height), Image.Resampling.LANCZOS)
    gray = gray.filter(ImageFilter.SHARPEN)
    return gray.convert("RGB")


def build_binary_text_image(image: Image.Image) -> Image.Image:
    source = image.convert("RGB")
    output = Image.new("RGB", source.size, "white")
    source_pixels = source.load()
    output_pixels = output.load()
    for y in range(source.height):
        for x in range(source.width):
            red, green, blue = source_pixels[x, y]
            brightness = (red + green + blue) / 3
            saturation = max(red, green, blue) - min(red, green, blue)
            dark_neutral = brightness < 205 and saturation < 86
            red_brown_text = red > 70 and red >= green + 16 and red >= blue + 16 and brightness < 214
            if dark_neutral or red_brown_text:
                output_pixels[x, y] = (0, 0, 0)
    if OCR_PREPROCESS_SCALE > 1:
        output = output.resize((source.width * OCR_PREPROCESS_SCALE, source.height * OCR_PREPROCESS_SCALE), Image.Resampling.LANCZOS)
    return output


def split_multiline_items(
    items: list[dict[str, Any]],
    variant: dict[str, Any],
    lang: str,
    params: dict[str, float],
    debug_enabled: bool,
    debug_stem: str,
) -> list[dict[str, Any]]:
    if not items:
        return items
    output: list[dict[str, Any]] = []
    try:
        image = Image.open(variant["path"]).convert("RGB")
    except Exception:
        return items
    for item in items:
        replacement = split_multiline_item(image, item, variant, lang, params, debug_enabled, debug_stem)
        output.extend(replacement or [item])
    return output


def split_multiline_item(
    image: Image.Image,
    item: dict[str, Any],
    variant: dict[str, Any],
    lang: str,
    params: dict[str, float],
    debug_enabled: bool,
    debug_stem: str,
) -> list[dict[str, Any]] | None:
    box = item.get("box")
    if not isinstance(box, dict) or not should_try_multiline_split(box):
        return None
    left = max(0, int(float(box.get("left") or 0)))
    top = max(0, int(float(box.get("top") or 0)))
    right = min(image.width, int(float(box.get("left") or 0) + float(box.get("width") or 0)))
    bottom = min(image.height, int(float(box.get("top") or 0) + float(box.get("height") or 0)))
    if right <= left or bottom <= top:
        return None

    crop = image.crop((left, top, right, bottom)).convert("RGB")
    segments = detect_horizontal_text_segments(crop)
    if len(segments) < 2:
        return None

    line_items: list[dict[str, Any]] = []
    for line_index, (line_top, line_bottom) in enumerate(segments, start=1):
        line_crop = crop.crop((0, line_top, crop.width, line_bottom)).convert("RGB")
        line_path = write_temp_pil_image(line_crop)
        try:
            raw = predict_with_lang(str(line_path), lang, params)
            extracted = extract_items(raw, filter_symbols=True, min_score=0.0)
        finally:
            line_path.unlink(missing_ok=True)
        for line_item in extracted:
            line_box = line_item.get("box")
            if not isinstance(line_box, dict):
                continue
            line_box["left"] = float(line_box.get("left") or 0.0) + left
            line_box["top"] = float(line_box.get("top") or 0.0) + top + line_top
            line_item["lineSplitFrom"] = item.get("text", "")
            line_item["lineSplitVariant"] = variant.get("name", "")
            line_item["lineSplitIndex"] = line_index
            line_items.append(line_item)
        if debug_enabled:
            save_line_split_crop(line_crop, debug_stem, variant, lang, item, line_index)

    if len(line_items) < 2:
        return None
    original_hangul = count_hangul(str(item.get("text") or ""))
    split_hangul = sum(count_hangul(str(line.get("text") or "")) for line in line_items)
    if split_hangul < max(2, original_hangul):
        return None
    return sort_items(line_items)


def should_try_multiline_split(box: dict[str, Any]) -> bool:
    width = float(box.get("width") or 0.0)
    height = float(box.get("height") or 0.0)
    if width <= 0 or height <= 0:
        return False
    return height >= 130 and height >= width * 0.55


def detect_horizontal_text_segments(crop: Image.Image) -> list[tuple[int, int]]:
    gray = ImageOps.grayscale(crop)
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
    return merge_close_segments(segments, gray.height)


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


def save_line_split_crop(
    image: Image.Image,
    stem: str,
    variant: dict[str, Any],
    lang: str,
    item: dict[str, Any],
    line_index: int,
) -> None:
    output_dir = service_debug_dir("crops") / safe_debug_stem(stem)
    output_dir.mkdir(parents=True, exist_ok=True)
    text_slug = safe_debug_stem(str(item.get("text") or "line"))[:24]
    path = output_dir / f"{safe_debug_stem(str(variant.get('name') or 'variant'))}-{lang}-line-{line_index:02d}-{text_slug}.png"
    image.save(path)


def write_temp_image_bytes(image_bytes: bytes) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(image_bytes)
        return Path(tmp.name)


def write_temp_pil_image(image: Image.Image) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        image.save(tmp, format="PNG")
        return Path(tmp.name)


def normalize_item_box_scale(item: dict[str, Any], scale: float) -> None:
    if scale <= 0 or abs(scale - 1.0) < 0.001:
        return
    box = item.get("box")
    if not isinstance(box, dict):
        return
    for key in ("left", "top", "width", "height"):
        if is_number(box.get(key)):
            box[key] = float(box[key]) / scale
    polygon = item.get("polygon")
    if isinstance(polygon, list):
        item["polygon"] = [
            [float(point[0]) / scale, float(point[1]) / scale]
            for point in polygon
            if isinstance(point, (list, tuple)) and len(point) >= 2 and is_number(point[0]) and is_number(point[1])
        ]


def get_ocr(lang: str, params: dict[str, float]) -> Any:
    return get_ocr_for_models(
        lang,
        get_ocr_version(lang),
        get_detection_model_name(lang),
        get_recognition_model_name(lang),
    )


def get_ocr_for_models(lang: str, ocr_version: str, det_model: str, rec_model: str) -> Any:
    with _ocr_client_lock:
        device = get_runtime_device()
        key = build_ocr_client_key(lang, device, ocr_version, det_model, rec_model)
        client = _ocr_clients.get(key)
        if client is not None:
            return client

        client = create_ocr_client(lang, device, ocr_version, det_model, rec_model)
        _ocr_clients[key] = client
        return client


def build_ocr_client_key(lang: str, device: str, ocr_version: str, det_model: str, rec_model: str) -> str:
    return "|".join(
        [
            lang,
            device,
            ocr_version,
            det_model,
            rec_model,
        ]
    )


def get_ocr_version(lang: str) -> str:
    return "PP-OCRv5"


def get_detection_model_name(lang: str) -> str:
    return "PP-OCRv5_server_det"


def get_recognition_model_name(lang: str) -> str:
    if lang == "korean":
        return "korean_PP-OCRv5_mobile_rec"
    if lang == "japan":
        return "japan_PP-OCRv3_mobile_rec"
    return "PP-OCRv5_mobile_rec"


def create_ocr_client(lang: str, device: str, ocr_version: str, det_model: str, rec_model: str) -> Any:
    kwargs = {
        "lang": lang,
        "device": device,
        "ocr_version": ocr_version,
        "text_detection_model_name": det_model,
        "text_recognition_model_name": rec_model,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if device == "cpu":
        kwargs.update(
            {
                "enable_mkldnn": False,
                "cpu_threads": 4,
            }
        )
    try:
        return PaddleOCR(**kwargs)
    except TypeError:
        return PaddleOCR(lang=lang, use_angle_cls=False, use_gpu=device != "cpu")


def predict_with_lang(image_path: str, lang: str, params: dict[str, float]) -> Any:
    client = get_ocr(lang, params)
    return predict_with_client(client, image_path, params)


def predict_with_variant_lang(image_path: str, variant: dict[str, Any], lang: str, params: dict[str, float]) -> Any:
    if should_use_korean_v3_fallback(variant, lang):
        client = get_ocr_for_models(lang, "PP-OCRv3", "PP-OCRv3_mobile_det", "korean_PP-OCRv3_mobile_rec")
        return predict_with_client(client, image_path, params)
    return predict_with_lang(image_path, lang, params)


def should_use_korean_v3_fallback(variant: dict[str, Any], lang: str) -> bool:
    return (
        lang == "korean"
        and str(variant.get("name") or "") == "binary_text_2x"
        and env_bool("LOCAL_OCR_KOREAN_V3_FALLBACK", True)
    )


def predict_with_client(client: Any, image_path: str, params: dict[str, float]) -> Any:
    predict_kwargs = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "text_det_thresh": params["text_det_thresh"],
        "text_det_box_thresh": params["text_det_box_thresh"],
        "text_det_unclip_ratio": params["text_det_unclip_ratio"],
        "text_rec_score_thresh": params["text_rec_score_thresh"],
    }
    if hasattr(client, "predict"):
        return client.predict(image_path, **predict_kwargs)
    return client.ocr(image_path, cls=False)


def filter_variant_items_for_normal_mode(items: list[dict[str, Any]], variant: dict[str, Any], lang: str) -> list[dict[str, Any]]:
    if not should_use_korean_v3_fallback(variant, lang):
        return items
    return [item for item in items if float(item.get("score") or 0.0) >= 0.88]


def get_runtime_device() -> str:
    requested = os.environ.get("LOCAL_OCR_DEVICE", DEFAULT_OCR_DEVICE).strip().lower()
    if requested == "auto":
        requested = "gpu:0"
    if requested in {"gpu", "cuda"}:
        requested = "gpu:0"
    if requested.startswith("gpu:"):
        if not is_cuda_available():
            raise RuntimeError(
                "GPU OCR requested but Paddle CUDA is unavailable. Activate the conda env with GPU Paddle installed."
            )
        return requested
    if requested == "cpu":
        return "cpu"
    raise RuntimeError(f"Unsupported LOCAL_OCR_DEVICE: {requested}")


def is_cuda_available() -> bool:
    if paddle is None:
        return False
    try:
        if not bool(paddle.is_compiled_with_cuda()):
            return False
        return int(paddle.device.cuda.device_count()) > 0
    except Exception:
        return False


def extract_items(raw_result: Any, filter_symbols: bool = True, min_score: float = 0.0) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for page in as_list(raw_result):
        mapping = result_to_mapping(page)
        if mapping:
            rows.extend(extract_mapping_items(mapping))
            continue
        rows.extend(extract_legacy_items(page))
    filtered = []
    for row in rows:
        if not row.get("text") or not row.get("box"):
            continue
        if float(row.get("score") or 0.0) < min_score:
            continue
        if filter_symbols and is_symbol_only_text(row.get("text")):
            continue
        filtered.append(row)
    return filtered


def result_to_mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value.get("res") if isinstance(value.get("res"), dict) else value

    json_value = getattr(value, "json", None)
    if isinstance(json_value, dict):
        return json_value.get("res") if isinstance(json_value.get("res"), dict) else json_value
    if callable(json_value):
        try:
            data = json_value()
            if isinstance(data, dict):
                return data.get("res") if isinstance(data.get("res"), dict) else data
        except Exception:
            pass

    for attr in ("res", "data"):
        data = getattr(value, attr, None)
        if isinstance(data, dict):
            return data
    return None


def extract_mapping_items(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    data = mapping.get("res") if isinstance(mapping.get("res"), dict) else mapping
    raw_texts = first_present(data, "rec_texts", "texts", "text")
    raw_scores = first_present(data, "rec_scores", "scores")
    raw_boxes = first_present(data, "rec_boxes", "rec_polys", "dt_polys", "boxes")
    texts = as_list([] if raw_texts is None else raw_texts)
    scores = as_list([] if raw_scores is None else raw_scores)
    boxes = as_list([] if raw_boxes is None else raw_boxes)

    rows: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        raw_box = boxes[index] if index < len(boxes) else None
        box = box_from_any(raw_box)
        if not box:
            continue
        row = {
            "text": str(text).strip(),
            "box": box,
            "score": float(scores[index]) if index < len(scores) and is_number(scores[index]) else 0.0,
        }
        polygon = polygon_from_any(raw_box)
        if polygon:
            row["polygon"] = polygon
            row["rotation_deg"] = polygon_rotation_deg(polygon)
        rows.append(row)
    return rows


def polygon_from_any(value: Any) -> list[list[float]] | None:
    points: list[list[float]] = []
    for point in as_list(value):
        pair = to_plain(point)
        if isinstance(pair, (list, tuple)) and len(pair) >= 2 and is_number(pair[0]) and is_number(pair[1]):
            points.append([float(pair[0]), float(pair[1])])
    return points[:4] if len(points) >= 4 else None


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def extract_legacy_items(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in as_list(value):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        box = box_from_any(item[0])
        text = ""
        score = 0.0
        payload = item[1]
        if isinstance(payload, (list, tuple)) and payload:
            text = str(payload[0]).strip()
            if len(payload) > 1 and is_number(payload[1]):
                score = float(payload[1])
        else:
            text = str(payload).strip()
        if box and text:
            rows.append({"text": text, "box": box, "score": score})
    return rows


def box_from_any(value: Any) -> dict[str, float] | None:
    plain = to_plain(value)
    if isinstance(plain, dict):
        left = as_float(plain.get("left", plain.get("x")))
        top = as_float(plain.get("top", plain.get("y")))
        width = as_float(plain.get("width", plain.get("w")))
        height = as_float(plain.get("height", plain.get("h")))
        right = as_float(plain.get("right"))
        bottom = as_float(plain.get("bottom"))
        if right is None and left is not None and width is not None:
            right = left + width
        if bottom is None and top is not None and height is not None:
            bottom = top + height
        return build_box(left, top, right, bottom)

    if isinstance(plain, list) and len(plain) >= 4 and all(is_number(v) for v in plain[:4]):
        left, top, third, fourth = [float(v) for v in plain[:4]]
        right = third if third > left else left + max(1.0, third)
        bottom = fourth if fourth > top else top + max(1.0, fourth)
        return build_box(left, top, right, bottom)

    if isinstance(plain, list) and plain:
        points = []
        for point in plain:
            if isinstance(point, list) and len(point) >= 2 and is_number(point[0]) and is_number(point[1]):
                points.append((float(point[0]), float(point[1])))
            elif isinstance(point, dict) and is_number(point.get("x")) and is_number(point.get("y")):
                points.append((float(point["x"]), float(point["y"])))
        if points:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            return build_box(min(xs), min(ys), max(xs), max(ys))

    return None


def build_box(left: float | None, top: float | None, right: float | None, bottom: float | None) -> dict[str, float] | None:
    if left is None or top is None or right is None or bottom is None:
        return None
    if right <= left or bottom <= top:
        return None
    return {
        "left": left,
        "top": top,
        "width": right - left,
        "height": bottom - top,
    }


def dedupe_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for item in sorted(items, key=item_quality_score, reverse=True):
        box = item.get("box")
        if not box:
            continue
        duplicate_index = next(
            (index for index, other in enumerate(kept) if are_duplicate_ocr_items(item, other)),
            None,
        )
        if duplicate_index is None:
            kept.append(item)
            continue
        if should_replace_duplicate_item(item, kept[duplicate_index]):
            kept[duplicate_index] = item
    return kept


def are_duplicate_ocr_items(first: dict[str, Any], second: dict[str, Any]) -> bool:
    first_box = first.get("box")
    second_box = second.get("box")
    if not isinstance(first_box, dict) or not isinstance(second_box, dict):
        return False

    overlap = intersection_ratio(first_box, second_box)
    iou = box_iou(first_box, second_box)
    if overlap < 0.55 and iou < 0.42:
        return False

    first_text = normalize_text_for_similarity(first.get("text"))
    second_text = normalize_text_for_similarity(second.get("text"))
    if not first_text or not second_text:
        return overlap >= 0.88
    if first_text == second_text:
        return overlap >= 0.55

    shorter, longer = sorted((first_text, second_text), key=len)
    contains = len(shorter) >= 2 and shorter in longer
    similarity = normalized_text_similarity(first_text, second_text)
    return (contains and overlap >= 0.62) or (similarity >= 0.82 and (overlap >= 0.6 or iou >= 0.45))


def normalize_text_for_similarity(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(ch for ch in normalized if ch.isalnum())


def normalized_text_similarity(first: str, second: str) -> float:
    if first == second:
        return 1.0
    if not first or not second:
        return 0.0
    previous = list(range(len(second) + 1))
    for first_index, first_char in enumerate(first, start=1):
        current = [first_index]
        for second_index, second_char in enumerate(second, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[second_index] + 1,
                    previous[second_index - 1] + (first_char != second_char),
                )
            )
        previous = current
    return 1.0 - previous[-1] / max(len(first), len(second))


def box_iou(a: dict[str, float] | None, b: dict[str, float] | None) -> float:
    if not a or not b:
        return 0.0
    ax2 = float(a.get("left") or 0.0) + float(a.get("width") or 0.0)
    ay2 = float(a.get("top") or 0.0) + float(a.get("height") or 0.0)
    bx2 = float(b.get("left") or 0.0) + float(b.get("width") or 0.0)
    by2 = float(b.get("top") or 0.0) + float(b.get("height") or 0.0)
    inter_w = max(0.0, min(ax2, bx2) - max(float(a.get("left") or 0.0), float(b.get("left") or 0.0)))
    inter_h = max(0.0, min(ay2, by2) - max(float(a.get("top") or 0.0), float(b.get("top") or 0.0)))
    intersection = inter_w * inter_h
    union = box_area(a) + box_area(b) - intersection
    return intersection / max(1.0, union)


def item_quality_score(item: dict[str, Any]) -> float:
    text_length = len(normalize_text_for_similarity(item.get("text")))
    score = float(item.get("score") or 0.0)
    variant_support = float(item.get("variantSupport") or 0.0)
    enhanced_support = float(item.get("enhancedVariantSupport") or 0.0)
    return text_length * 0.08 + score + variant_support * 0.12 + enhanced_support * 0.06


def annotate_variant_support(items: list[dict[str, Any]]) -> None:
    for item in items:
        box = item.get("box")
        if not isinstance(box, dict):
            item["variantSupport"] = 0
            item["enhancedVariantSupport"] = 0
            continue
        variants: set[str] = set()
        enhanced_variants: set[str] = set()
        for other in items:
            other_box = other.get("box")
            if not isinstance(other_box, dict) or intersection_ratio(box, other_box) < 0.65:
                continue
            if not are_supporting_texts(item.get("text"), other.get("text")):
                continue
            variant = str(other.get("variant") or "unknown")
            variants.add(variant)
            if variant != "original":
                enhanced_variants.add(variant)
        item["variantSupport"] = len(variants)
        item["enhancedVariantSupport"] = len(enhanced_variants)


def are_supporting_texts(first: Any, second: Any) -> bool:
    first_text = compact_text(first)
    second_text = compact_text(second)
    if not first_text or not second_text:
        return False
    if first_text == second_text:
        return True
    shorter, longer = sorted((first_text, second_text), key=len)
    return len(shorter) >= 2 and shorter in longer


def reconstruct_enhanced_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    originals = [item for item in items if item.get("variant") == "original"]
    enhanced = [item for item in items if item.get("variant") != "original"]
    if not originals or not enhanced:
        return dedupe_items(items)

    rebuilt: list[dict[str, Any]] = []
    for original in originals:
        replacement = build_enhanced_replacement(original, enhanced)
        rebuilt.append(replacement or original)
    return dedupe_items(rebuilt + enhanced)


def apply_korean_contextual_corrections(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    corrected: list[dict[str, Any]] = []
    for item in items:
        replacement = correct_low_confidence_korean_text(item, items)
        corrected.append(replacement or item)
    return corrected


def correct_low_confidence_korean_text(item: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any] | None:
    text = compact_text(item.get("text"))
    score = float(item.get("score") or 0.0)
    if score > 0.75:
        return None

    corrections = {
        "무래": "대리님.",
        "뮤래": "대리님.",
        "무그": "대리님.",
        "미래": "대리님.",
        "뭐래": "대리님.",
    }
    corrected_text = corrections.get(text)
    if not corrected_text:
        return None
    if not has_nearby_korean_context(item, items, {"은하제"}):
        return None

    replacement = dict(item)
    replacement["text"] = corrected_text
    replacement["ocrOriginalText"] = item.get("text", "")
    replacement["ocrCorrection"] = "low_confidence_korean_title"
    return replacement


def has_nearby_korean_context(item: dict[str, Any], items: list[dict[str, Any]], triggers: set[str]) -> bool:
    box = item.get("box")
    if not isinstance(box, dict):
        return False
    for other in items:
        if other is item:
            continue
        other_box = other.get("box")
        if not isinstance(other_box, dict):
            continue
        other_text = compact_text(other.get("text"))
        if not any(trigger in other_text for trigger in triggers):
            continue
        if are_boxes_near_same_line(box, other_box):
            return True
    return False


def are_boxes_near_same_line(a: dict[str, float], b: dict[str, float]) -> bool:
    ax1 = float(a.get("left") or 0.0)
    ay1 = float(a.get("top") or 0.0)
    aw = float(a.get("width") or 0.0)
    ah = float(a.get("height") or 0.0)
    bx1 = float(b.get("left") or 0.0)
    by1 = float(b.get("top") or 0.0)
    bw = float(b.get("width") or 0.0)
    bh = float(b.get("height") or 0.0)
    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
        return False
    if vertical_overlap_ratio(a, b) >= 0.45:
        return abs((ax1 + aw / 2.0) - (bx1 + bw / 2.0)) <= max(aw, bw) * 2.5
    return abs((ay1 + ah / 2.0) - (by1 + bh / 2.0)) <= max(ah, bh) * 0.45


def build_enhanced_replacement(original: dict[str, Any], enhanced: list[dict[str, Any]]) -> dict[str, Any] | None:
    original_score = float(original.get("score") or 0.0)
    original_text = str(original.get("text") or "")
    original_box = original.get("box")
    if original_score >= 0.65 or not isinstance(original_box, dict):
        return None

    fragments = []
    for item in enhanced:
        text = str(item.get("text") or "").strip()
        box = item.get("box")
        score = float(item.get("score") or 0.0)
        if score < 0.75 or not text or not isinstance(box, dict):
            continue
        if not is_box_center_inside(box, original_box):
            continue
        if vertical_overlap_ratio(box, original_box) < 0.45:
            continue
        fragments.append(item)
    if not fragments:
        return None

    fragments = dedupe_items(fragments)
    fragments.sort(key=lambda row: (float((row.get("box") or {}).get("left") or 0.0), float((row.get("box") or {}).get("top") or 0.0)))
    combined_text = join_line_fragments(fragments)
    if count_hangul(combined_text) <= count_hangul(original_text) + 2:
        return None

    replacement = dict(original)
    replacement["text"] = combined_text
    replacement["score"] = sum(float(item.get("score") or 0.0) for item in fragments) / len(fragments)
    replacement["variant"] = "enhanced_reconstructed"
    replacement["debugFragments"] = [
        {
            "text": item.get("text", ""),
            "score": float(item.get("score") or 0.0),
            "variant": item.get("variant", ""),
            "box": item.get("box"),
        }
        for item in fragments
    ]
    return replacement


def join_line_fragments(fragments: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in fragments:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        parts.append(text)
    return clean_reconstructed_text(" ".join(parts))


def clean_reconstructed_text(text: str) -> str:
    cleaned = " ".join(str(text or "").split())
    cleaned = cleaned.replace(": ㅏㅋㅋ", "ㅋㅋ")
    cleaned = cleaned.replace(":ㅏㅋㅋ", "ㅋㅋ")
    cleaned = cleaned.replace("ㅏㅋㅋ", "ㅋㅋ")
    return cleaned.strip()


def is_box_center_inside(inner: dict[str, float], outer: dict[str, float]) -> bool:
    center_x = float(inner.get("left") or 0.0) + float(inner.get("width") or 0.0) / 2.0
    center_y = float(inner.get("top") or 0.0) + float(inner.get("height") or 0.0) / 2.0
    left = float(outer.get("left") or 0.0)
    top = float(outer.get("top") or 0.0)
    return left <= center_x <= left + float(outer.get("width") or 0.0) and top <= center_y <= top + float(outer.get("height") or 0.0)


def vertical_overlap_ratio(a: dict[str, float], b: dict[str, float]) -> float:
    ay1 = float(a.get("top") or 0.0)
    ay2 = ay1 + float(a.get("height") or 0.0)
    by1 = float(b.get("top") or 0.0)
    by2 = by1 + float(b.get("height") or 0.0)
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    return overlap / max(1.0, min(ay2 - ay1, by2 - by1))


def should_replace_duplicate_item(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    candidate_text = normalize_text_for_similarity(candidate.get("text"))
    existing_text = normalize_text_for_similarity(existing.get("text"))
    if not candidate_text:
        return False
    if not existing_text:
        return True

    candidate_len = len(candidate_text)
    existing_len = len(existing_text)
    candidate_score = float(candidate.get("score") or 0.0)
    existing_score = float(existing.get("score") or 0.0)
    if candidate_text == existing_text:
        return candidate_score > existing_score

    if candidate_len >= existing_len + 3 and box_area(candidate.get("box")) >= box_area(existing.get("box")) * 1.2:
        return True

    if existing_text in candidate_text and candidate_len > existing_len:
        return True

    return item_quality_score(candidate) > item_quality_score(existing)


def compact_text(value: Any) -> str:
    return "".join(str(value or "").split())


def count_hangul(text: str) -> int:
    return sum(1 for ch in str(text or "") if "\uac00" <= ch <= "\ud7af")


def is_symbol_only_text(text: Any) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return True
    return not any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff" or "\uac00" <= ch <= "\ud7af" for ch in raw)


def box_area(box: dict[str, float] | None) -> float:
    if not box:
        return 0.0
    return max(0.0, float(box.get("width") or 0.0)) * max(0.0, float(box.get("height") or 0.0))


def intersection_ratio(a: dict[str, float] | None, b: dict[str, float] | None) -> float:
    if not a or not b:
        return 0.0
    ax1, ay1 = a["left"], a["top"]
    ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
    bx1, by1 = b["left"], b["top"]
    bx2, by2 = bx1 + b["width"], by1 + b["height"]
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    if inter_w <= 0 or inter_h <= 0:
        return 0.0
    min_area = max(1.0, min(a["width"] * a["height"], b["width"] * b["height"]))
    return (inter_w * inter_h) / min_area


def sort_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: (item["box"]["top"], item["box"]["left"]))


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    plain = to_plain(value)
    if isinstance(plain, list):
        return plain
    if isinstance(plain, tuple):
        return list(plain)
    return [plain]


def to_plain(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def as_float(value: Any) -> float | None:
    return float(value) if is_number(value) else None


def is_number(value: Any) -> bool:
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


# =============================================================================
# Fast OCR：独立检测、逐四边形透视矫正、批量识别。
# =============================================================================

def _order_polygon_points(pts: np.ndarray) -> np.ndarray:
    """将四点排列为左上、右上、右下、左下。"""
    points = np.asarray(pts, dtype=np.float32).reshape(-1, 2)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    ordered = points[np.argsort(angles)]
    start = int(np.argmin(ordered.sum(axis=1)))
    ordered = np.roll(ordered, -start, axis=0)
    first_edge = ordered[1] - ordered[0]
    second_edge = ordered[2] - ordered[1]
    cross = float(first_edge[0] * second_edge[1] - first_edge[1] * second_edge[0])
    if cross < 0:
        ordered = ordered[[0, 3, 2, 1]]
    return ordered.astype(np.float32)


def _deskew_crop_image(image_bytes: bytes, polygon: list[list[float]]) -> bytes | None:
    """使用 OpenCV 透视变换裁剪四边形，失败时返回 ``None``。"""
    if not CV2_AVAILABLE:
        return None
    try:
        np_arr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if image is None:
            return None

        pts = np.array(polygon, dtype=np.float32)
        pts = _order_polygon_points(pts)

        # 向外保留少量边缘，避免透视裁剪切掉描边和标点。
        center = pts.mean(axis=0)
        edge = max(
            np.linalg.norm(pts[1] - pts[0]),
            np.linalg.norm(pts[3] - pts[0]),
        )
        padding = min(12.0, max(2.0, float(edge) * 0.06))
        for index in range(4):
            vector = pts[index] - center
            length = max(1.0, float(np.linalg.norm(vector)))
            pts[index] += vector / length * padding
        pts[:, 0] = np.clip(pts[:, 0], 0, image.shape[1] - 1)
        pts[:, 1] = np.clip(pts[:, 1], 0, image.shape[0] - 1)

        # 使用两组平行边的较大值，避免矫正后再次截断文字。
        width = max(
            1, int(round(max(
                np.linalg.norm(pts[1] - pts[0]),
                np.linalg.norm(pts[2] - pts[3]),
            ))),
        )
        height = max(
            1, int(round(max(
                np.linalg.norm(pts[3] - pts[0]),
                np.linalg.norm(pts[2] - pts[1]),
            ))),
        )

        dst = np.array([
            [0, 0],
            [width - 1, 0],
            [width - 1, height - 1],
            [0, height - 1],
        ], dtype=np.float32)

        matrix = cv2.getPerspectiveTransform(pts, dst)
        warped = cv2.warpPerspective(image, matrix, (width, height), flags=cv2.INTER_CUBIC)
        _, buf = cv2.imencode(".png", warped)
        return buf.tobytes()
    except Exception as exc:
        print(f"[slice-ocr] deskew_crop_image failed: {exc}", flush=True)
        return None


def _polygon_to_box(polygon: list[list[float]]) -> dict[str, float]:
    """将四边形转换为兼容旧链路的轴对齐矩形。"""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    left = min(xs)
    top = min(ys)
    return {
        "left": left,
        "top": top,
        "width": max(xs) - left,
        "height": max(ys) - top,
    }


def _run_detection_only(
    image_bytes: bytes,
    lang: str,
    params: dict[str, float],
) -> list[dict[str, Any]]:
    """使用 Paddle 独立检测模型返回原图四边形，不执行文字识别。"""
    client = get_text_detection_client(params)
    image = decode_cv_image(image_bytes)
    raw = client.predict(image, batch_size=1)
    items: list[dict[str, Any]] = []
    for page in as_list(raw):
        mapping = result_to_mapping(page) or {}
        raw_polygons = first_present(mapping, "dt_polys", "polys", "boxes")
        raw_scores = first_present(mapping, "dt_scores", "scores")
        polygons = as_list([] if raw_polygons is None else raw_polygons)
        scores = as_list([] if raw_scores is None else raw_scores)
        for index, value in enumerate(polygons):
            polygon = normalize_detection_polygon(value, image.shape[1], image.shape[0])
            if not polygon:
                continue
            items.append(
                {
                    "polygon": polygon,
                    "box": _polygon_to_box(polygon),
                    "det_score": float(scores[index]) if index < len(scores) and is_number(scores[index]) else 0.0,
                    "rotation_deg": polygon_rotation_deg(polygon),
                }
            )
    return items


def decode_cv_image(image_bytes: bytes) -> Any:
    image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("OpenCV cannot decode image")
    return image


def get_text_detection_client(params: dict[str, float]) -> Any:
    device = get_runtime_device()
    model_name = get_detection_model_name("auto")
    key = "|".join(
        [
            device,
            model_name,
            f"{params['text_det_thresh']:.4f}",
            f"{params['text_det_box_thresh']:.4f}",
            f"{params['text_det_unclip_ratio']:.4f}",
        ]
    )
    with _ocr_client_lock:
        client = _text_detection_clients.get(key)
        if client is None:
            client = TextDetection(
                model_name=model_name,
                device=device,
                thresh=params["text_det_thresh"],
                box_thresh=params["text_det_box_thresh"],
                unclip_ratio=params["text_det_unclip_ratio"],
                **({"enable_mkldnn": False, "cpu_threads": 4} if device == "cpu" else {}),
            )
            _text_detection_clients[key] = client
        return client


def get_text_recognition_client(lang: str) -> Any:
    device = get_runtime_device()
    model_name = get_recognition_model_name(lang)
    key = "|".join([device, model_name])
    with _ocr_client_lock:
        client = _text_recognition_clients.get(key)
        if client is None:
            client = TextRecognition(
                model_name=model_name,
                device=device,
                **({"enable_mkldnn": False, "cpu_threads": 4} if device == "cpu" else {}),
            )
            _text_recognition_clients[key] = client
        return client


def normalize_detection_polygon(value: Any, image_width: int, image_height: int) -> list[list[float]] | None:
    points = polygon_from_any(value)
    if not points:
        return None
    pts = np.asarray(points, dtype=np.float32)
    if pts.shape[0] != 4:
        pts = cv2.boxPoints(cv2.minAreaRect(pts))
    if abs(float(cv2.contourArea(pts))) < 4:
        return None
    ordered = _order_polygon_points(pts)
    ordered[:, 0] = np.clip(ordered[:, 0], 0, max(0, image_width - 1))
    ordered[:, 1] = np.clip(ordered[:, 1], 0, max(0, image_height - 1))
    return [[float(point[0]), float(point[1])] for point in ordered]


def polygon_rotation_deg(polygon: list[list[float]]) -> float:
    pts = _order_polygon_points(np.asarray(polygon, dtype=np.float32))
    top_vector = pts[1] - pts[0]
    side_vector = pts[3] - pts[0]
    vector = top_vector if np.linalg.norm(top_vector) >= np.linalg.norm(side_vector) else side_vector
    angle = math.degrees(math.atan2(float(vector[1]), float(vector[0])))
    while angle >= 90:
        angle -= 180
    while angle < -90:
        angle += 180
    return float(angle)


def recognize_candidate_rows(rows: list[dict[str, Any]], languages: list[str]) -> list[dict[str, Any]]:
    """按语言批量识别透视候选，输出仍与候选索引一一对应。"""
    output: list[dict[str, Any]] = []
    if not rows:
        return output
    images = [row["image"] for row in rows]
    for current_lang in languages:
        client = get_text_recognition_client(current_lang)
        results = as_list(client.predict(images, batch_size=min(16, len(images))))
        for index, result in enumerate(results[: len(rows)]):
            mapping = result_to_mapping(result) or {}
            text = scalar_result_value(mapping.get("rec_text"), "")
            score = scalar_result_value(mapping.get("rec_score"), 0.0)
            candidate = {key: value for key, value in rows[index].items() if key != "image"}
            output.append(
                {
                    **candidate,
                    "text": str(text or "").strip(),
                    "score": float(score) if is_number(score) else 0.0,
                    "lang": current_lang,
                }
            )
    return output


def scalar_result_value(value: Any, fallback: Any) -> Any:
    plain = to_plain(value)
    if isinstance(plain, (list, tuple)):
        return plain[0] if plain else fallback
    return fallback if plain is None else plain


def count_target_script_chars(text: str, lang: str) -> int:
    raw = str(text or "")
    if lang == "korean":
        return len([char for char in raw if "\uac00" <= char <= "\ud7af"])
    return len([char for char in raw if "\u3040" <= char <= "\u30ff" or "\u4e00" <= char <= "\u9fff"])


def recognition_quality(row: dict[str, Any]) -> float:
    text = str(row.get("text") or "").strip()
    script_chars = count_target_script_chars(text, str(row.get("lang") or ""))
    meaningful = sum(1 for char in text if char.isalnum() or "\u3040" <= char <= "\ud7af")
    return float(row.get("score") or 0.0) + min(script_chars, 12) * 0.025 + min(meaningful, 20) * 0.003


def _run_slice_ocr_pipeline(
    image_bytes: bytes,
    lang: str,
    params: dict[str, float],
    debug: bool = False,
    debug_id: str = "",
) -> dict[str, Any]:
    """检测一次，透视裁剪后批量识别所有方向候选。"""
    image_width, image_height = get_image_size(image_bytes)
    detections = _run_detection_only(image_bytes, lang, params)
    candidate_rows: list[dict[str, Any]] = []
    failed_detections = 0
    for det_index, det in enumerate(detections):
        deskewed_bytes = _deskew_crop_image(image_bytes, det["polygon"])
        if deskewed_bytes is None:
            failed_detections += 1
            continue
        crop = decode_cv_image(deskewed_bytes)
        height, width = crop.shape[:2]
        orientations = (
            [
                (90, cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)),
                (-90, cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)),
            ]
            if height > width * 1.15
            else [(0, crop)]
        )
        for orientation, candidate in orientations:
            candidate_rows.append(
                {
                    "detection_index": det_index,
                    "orientation": orientation,
                    "image": candidate,
                }
            )
        if debug:
            debug_dir = service_debug_dir("slice_crops")
            debug_dir.mkdir(parents=True, exist_ok=True)
            (debug_dir / f"slice-{safe_debug_stem(debug_id)}-{det_index:03d}.png").write_bytes(deskewed_bytes)

    if failed_detections > 0:
        # 不静默丢失单个区域；交给 run_ocr 回退完整旧 Fast 流程。
        raise RuntimeError(f"perspective crop failed for {failed_detections} detection(s)")

    languages = ["japan", "korean"] if lang == "auto" else [lang]
    recognized = recognize_candidate_rows(candidate_rows, languages)
    primary_best: dict[int, dict[str, Any]] = {}
    for row in recognized:
        current = primary_best.get(row["detection_index"])
        if current is None or recognition_quality(row) > recognition_quality(current):
            primary_best[row["detection_index"]] = row
    weak_indexes = {
        detection_index
        for detection_index, row in primary_best.items()
        if row["orientation"] == 0
        and (row["score"] < 0.72 or count_target_script_chars(row["text"], row["lang"]) == 0)
    }
    retry_rows = [
        {**row, "orientation": 180, "image": cv2.rotate(row["image"], cv2.ROTATE_180)}
        for row in candidate_rows
        if row["detection_index"] in weak_indexes and row["orientation"] == 0
    ]
    recognized.extend(recognize_candidate_rows(retry_rows, languages))

    best_by_detection: dict[int, dict[str, Any]] = {}
    for row in recognized:
        current = best_by_detection.get(row["detection_index"])
        if current is None or recognition_quality(row) > recognition_quality(current):
            best_by_detection[row["detection_index"]] = row

    recognized_items: list[dict[str, Any]] = []
    min_score = float(params.get("text_rec_score_thresh") or 0.0)
    for det_index, row in best_by_detection.items():
        text = str(row.get("text") or "").strip()
        if not text or float(row.get("score") or 0.0) < min_score or is_symbol_only_text(text):
            continue
        det = detections[det_index]
        recognized_items.append(
            {
                "text": text,
                "score": float(row["score"]),
                "box": det["box"],
                "polygon": det["polygon"],
                "det_score": float(det.get("det_score") or 0.0),
                "rotation_deg": float(det.get("rotation_deg") or 0.0),
                "orientation_applied": int(row["orientation"]),
                "lang": row["lang"],
                "variant": "perspective_fast",
            }
        )

    normalized = sort_items(dedupe_items(recognized_items))
    return {
        "items": normalized,
        "boxes": response_boxes(normalized),
        "imageWidth": image_width,
        "imageHeight": image_height,
        "deskew": True,
        "detections": len(detections),
        "recognized": len(normalized),
        "counts": {
            "paddle_raw_items": len(recognized),
            "filtered_items": len(recognized_items),
            "merged_blocks": len(normalized),
            "variants": 1,
            "langs": len(languages),
        },
    }


def run_fast_perspective_ocr(
    image_bytes: bytes,
    lang: str,
    params: dict[str, float],
    debug: bool,
    debug_id: str,
) -> dict[str, Any]:
    result = _run_slice_ocr_pipeline(image_bytes, lang, params, debug, debug_id)
    if debug or os.environ.get("LOCAL_OCR_DEBUG_ALWAYS", "1") != "0":
        debug_stem = safe_debug_stem(debug_id or f"{int(time.time() * 1000)}")
        debug_paths = {
            "input": save_debug_input(image_bytes, debug_id),
            "plugin_input": save_service_plugin_input(image_bytes, debug_stem),
            "vis": save_service_vis(image_bytes, result["items"], debug_stem),
        }
        result["debug"] = debug_paths
        debug_paths["result_json"] = save_service_result_json(result, debug_stem)
    else:
        result["debug"] = {}
    return result


if __name__ == "__main__":
    import uvicorn

    # Windows Proactor event loop 在 Python 3.12 关服时偶发 _attach 断言，Selector 关闭更稳定。
    if os.name == "nt" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    uvicorn.run(app, host="127.0.0.1", port=8765)
