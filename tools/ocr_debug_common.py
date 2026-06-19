from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

HANGUL_RE = r"[\uac00-\ud7af]"
DEFAULT_PARAMS = {
    "text_det_thresh": 0.3,
    "text_det_box_thresh": 0.6,
    "text_det_unclip_ratio": 1.2,
    "text_rec_score_thresh": 0.0,
}


def configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def prepare_paddleocr_import() -> None:
    configure_stdout()
    os.environ.setdefault("FLAGS_use_onednn", "0")
    os.environ.setdefault("FLAGS_use_mkldnn", "0")
    os.environ.setdefault("ONEDNN_VERBOSE", "0")
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    if os.environ.get("LOCAL_OCR_DISABLE_MODELSCOPE", "1") != "0":
        modelscope_stub = types.ModuleType("modelscope")

        def _disabled_modelscope_download(*args: Any, **kwargs: Any) -> None:
            raise RuntimeError("ModelScope is disabled for OCR debugging.")

        modelscope_stub.snapshot_download = _disabled_modelscope_download
        sys.modules.setdefault("modelscope", modelscope_stub)


def build_ocr_kwargs(lang: str, device: str, params: dict[str, float]) -> dict[str, Any]:
    return {
        "lang": lang,
        "ocr_version": "PP-OCRv5",
        "device": device,
        "text_detection_model_name": "PP-OCRv5_server_det",
        "text_recognition_model_name": get_recognition_model_name(lang),
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": True,
    }


def build_predict_kwargs(params: dict[str, float]) -> dict[str, Any]:
    return {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": True,
        "text_det_thresh": float(params.get("text_det_thresh", DEFAULT_PARAMS["text_det_thresh"])),
        "text_det_box_thresh": float(params.get("text_det_box_thresh", DEFAULT_PARAMS["text_det_box_thresh"])),
        "text_det_unclip_ratio": float(params.get("text_det_unclip_ratio", DEFAULT_PARAMS["text_det_unclip_ratio"])),
        "text_rec_score_thresh": float(params.get("text_rec_score_thresh", DEFAULT_PARAMS["text_rec_score_thresh"])),
    }


def get_recognition_model_name(lang: str) -> str:
    if lang == "korean":
        return "korean_PP-OCRv5_mobile_rec"
    if lang == "japan":
        return "japan_PP-OCRv3_mobile_rec"
    return "PP-OCRv5_mobile_rec"


def predict_ocr(image_path: str, lang: str, device: str, params: dict[str, float]) -> list[dict[str, Any]]:
    prepare_paddleocr_import()
    from paddleocr import PaddleOCR

    client = PaddleOCR(**build_ocr_kwargs(lang, device, params))
    try:
        raw = client.predict(image_path, **build_predict_kwargs(params))
    except TypeError:
        raw = client.predict(input=image_path, **build_predict_kwargs(params))
    return extract_items(raw)


def extract_items(raw_result: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for page in as_list(raw_result):
        mapping = result_to_mapping(page)
        if mapping:
            rows.extend(extract_mapping_items(mapping))
            continue
        rows.extend(extract_legacy_items(page))
    return [row for row in rows if row.get("text") and row.get("box")]


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
        box = box_from_any(boxes[index] if index < len(boxes) else None)
        if not box:
            continue
        rows.append(
            {
                "text": str(text).strip(),
                "box": box,
                "score": float(scores[index]) if index < len(scores) and is_number(scores[index]) else 0.0,
            }
        )
    return rows


def extract_legacy_items(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in as_list(value):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        box = box_from_any(item[0])
        payload = item[1]
        text = ""
        score = 0.0
        if isinstance(payload, (list, tuple)) and payload:
            text = str(payload[0]).strip()
            if len(payload) > 1 and is_number(payload[1]):
                score = float(payload[1])
        else:
            text = str(payload).strip()
        if box and text:
            rows.append({"text": text, "box": box, "score": score})
    return rows


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


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
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            return build_box(min(xs), min(ys), max(xs), max(ys))
    return None


def build_box(left: float | None, top: float | None, right: float | None, bottom: float | None) -> dict[str, float] | None:
    if left is None or top is None or right is None or bottom is None:
        return None
    if right <= left or bottom <= top:
        return None
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def save_debug_outputs(image_path: str, items: list[dict[str, Any]], out_dir: Path, name: str) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    image = Image.open(image_path).convert("RGB")
    original_path = out_dir / f"{name}_input.png"
    json_path = out_dir / f"{name}_ocr.json"
    vis_path = out_dir / f"{name}_vis.png"
    image.save(original_path)
    payload = {
        "imageWidth": image.width,
        "imageHeight": image.height,
        "items": items,
        "boxes": [{"box": item["box"], "text": item["text"], "score": item.get("score", 0.0)} for item in items],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    save_visualization(image, items, vis_path)
    return {"input": str(original_path), "json": str(json_path), "vis": str(vis_path)}


def save_visualization(image: Image.Image, items: list[dict[str, Any]], path: Path) -> None:
    source = image.copy().convert("RGB")
    side_width = 430
    canvas = Image.new("RGB", (source.width + side_width, source.height), (255, 255, 255))
    canvas.paste(source, (0, 0))
    draw = ImageDraw.Draw(canvas)
    font = load_font(18)
    small_font = load_font(15)
    draw.rectangle([source.width, 0, canvas.width - 1, canvas.height - 1], fill=(255, 255, 255), outline=(220, 220, 220))
    draw.text((source.width + 16, 16), "OCR boxes", fill=(40, 40, 40), font=font)
    for index, item in enumerate(items, start=1):
        box = item.get("box") or {}
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
        draw.text((left + 3, max(0, top - 20)), str(index), fill=(255, 0, 0), font=small_font)
        label_top = 48 + (index - 1) * 48
        if label_top + 42 < canvas.height:
            label = f"{index}. {float(item.get('score') or 0):.2f}"
            draw.text((source.width + 16, label_top), label, fill=(255, 0, 0), font=small_font)
            draw.text((source.width + 74, label_top), str(item.get("text", ""))[:34], fill=(20, 20, 20), font=small_font)
    canvas.save(path)


def summarize_items(items: list[dict[str, Any]]) -> dict[str, float | int]:
    scores = [float(item.get("score") or 0.0) for item in items]
    text = "".join(str(item.get("text") or "") for item in items)
    return {
        "boxes": len(items),
        "hangul_chars": count_hangul(text),
        "avg_score": sum(scores) / len(scores) if scores else 0.0,
    }


def count_hangul(text: str) -> int:
    return sum(1 for ch in str(text or "") if "\uac00" <= ch <= "\ud7af")


def print_items(items: list[dict[str, Any]]) -> None:
    for index, item in enumerate(items, start=1):
        box = item.get("box") or {}
        print(
            f"[{index:02d}] box=({box.get('left'):.1f},{box.get('top'):.1f},"
            f"{box.get('width'):.1f},{box.get('height'):.1f}) "
            f"score={float(item.get('score') or 0):.4f} text={item.get('text')}"
        )


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\GOTHIC.TTF",
    ]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


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
