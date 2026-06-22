from __future__ import annotations

import base64
import math
from typing import Any

import cv2  # type: ignore[import-untyped]
import numpy as np  # type: ignore[import-untyped]


DEFAULT_BACKGROUND_DEBUG_PARAMS: dict[str, Any] = {
    "near_expand_ratio": 0.35,
    "far_expand_ratio": 1.2,
    "lab_var_threshold": 18.0,
    "delta_e_threshold": 9.0,
    "dominant_ratio_threshold": 0.78,
    "min_sample_pixels": 80,
    "max_fill_area_ratio": 2.0,
    "text_mask_dilate": 2,
    "ignore_text_mask": False,
    "near_priority": False,
}


def run_background_debug(
    image_bytes: bytes,
    ocr: list[dict[str, Any]],
    labels: dict[str, str],
    parameter_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    """对同一批 OCR 框运行多组独立背景判定，不修改生产 OCR 状态。"""
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("image decode failed")
    normalized_ocr = [_normalize_ocr_item(item, index, image.shape[:2]) for index, item in enumerate(ocr)]
    normalized_ocr = [item for item in normalized_ocr if item is not None]
    groups = []
    for index, raw_group in enumerate(parameter_groups):
        group_id = str(raw_group.get("id") or f"group-{index + 1}")
        params = normalize_background_debug_params(raw_group.get("params"))
        boxes = [classify_background_debug(image, item, params, labels.get(item["id"])) for item in normalized_ocr]
        groups.append({"id": group_id, "params": params, "summary": _summarize(boxes), "boxes": boxes})
    return {"imageWidth": int(image.shape[1]), "imageHeight": int(image.shape[0]), "groups": groups}


def normalize_background_debug_params(raw: Any) -> dict[str, Any]:
    """校验调试参数并返回可 JSON 序列化的稳定结构。"""
    source = raw if isinstance(raw, dict) else {}
    params = dict(DEFAULT_BACKGROUND_DEBUG_PARAMS)
    numeric_rules = {
        "near_expand_ratio": (0.0, 4.0),
        "far_expand_ratio": (0.0, 6.0),
        "lab_var_threshold": (0.0, 5000.0),
        "delta_e_threshold": (0.1, 255.0),
        "dominant_ratio_threshold": (0.0, 1.0),
        "min_sample_pixels": (1.0, 1000000.0),
        "max_fill_area_ratio": (1.0, 100.0),
        "text_mask_dilate": (0.0, 64.0),
    }
    for name, (minimum, maximum) in numeric_rules.items():
        try:
            value = float(source.get(name, params[name]))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid parameter: {name}") from exc
        if not math.isfinite(value) or value < minimum or value > maximum:
            raise ValueError(f"parameter out of range: {name}")
        params[name] = int(round(value)) if name in {"min_sample_pixels", "text_mask_dilate"} else value
    params["ignore_text_mask"] = bool(source.get("ignore_text_mask", params["ignore_text_mask"]))
    params["near_priority"] = bool(source.get("near_priority", params["near_priority"]))
    if params["far_expand_ratio"] < params["near_expand_ratio"]:
        raise ValueError("far_expand_ratio must be greater than or equal to near_expand_ratio")
    return params


def classify_background_debug(
    image: Any,
    item: dict[str, Any],
    params: dict[str, Any],
    label: str | None = None,
) -> dict[str, Any]:
    """返回单个 OCR 框的判定、指标、失败原因和肉眼对比图。"""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    box = item["box"]
    polygon = item.get("polygon") or _box_polygon(box)
    text_mask = _build_text_mask(image.shape[:2], polygon, int(params["text_mask_dilate"]))
    near = _measure_scale(lab, box, float(params["near_expand_ratio"]), text_mask, params)
    far = _measure_scale(lab, box, float(params["far_expand_ratio"]), text_mask, params)
    near_far_delta = float(np.linalg.norm(near["median_lab"] - far["median_lab"]))
    fill_box = _expanded_pixel_box(box, int(params["text_mask_dilate"]), image.shape[:2])
    box_area = max(1, int(box["width"]) * int(box["height"]))
    fill_area_ratio = (fill_box[2] * fill_box[3]) / box_area

    metrics = {
        "lab_var_near": _metric(near["lab_variance"], params["lab_var_threshold"], "max"),
        "lab_var_far": _metric(far["lab_variance"], params["lab_var_threshold"], "max"),
        "delta_e_near_far": _metric(near_far_delta, params["delta_e_threshold"], "max"),
        "delta_e_p90_near": _metric(near["delta_e_p90"], params["delta_e_threshold"], "max"),
        "delta_e_p90_far": _metric(far["delta_e_p90"], params["delta_e_threshold"], "max"),
        "dominant_ratio_near": _metric(near["dominant_ratio"], params["dominant_ratio_threshold"], "min"),
        "dominant_ratio_far": _metric(far["dominant_ratio"], params["dominant_ratio_threshold"], "min"),
        "sample_pixels_near": _metric(near["sample_pixels"], params["min_sample_pixels"], "min"),
        "sample_pixels_far": _metric(far["sample_pixels"], params["min_sample_pixels"], "min"),
        "fill_area_ratio": _metric(fill_area_ratio, params["max_fill_area_ratio"], "max"),
    }
    required = [
        "lab_var_near", "delta_e_p90_near", "dominant_ratio_near", "sample_pixels_near",
        "delta_e_near_far", "fill_area_ratio",
    ]
    if not params["near_priority"]:
        required.extend(["lab_var_far", "delta_e_p90_far", "dominant_ratio_far", "sample_pixels_far"])
    fail_reasons = [_fail_reason(name, metrics[name]) for name in required if not metrics[name]["pass"]]
    prediction = "solid" if not fail_reasons else "complex"
    normalized_label = label if label in {"solid", "complex"} else None
    is_mismatch = normalized_label is not None and normalized_label != prediction
    margin = min(abs(_metric_margin(name, metrics[name])) for name in required)
    is_boundary = margin <= 0.12
    dominant_lab = near["median_lab"] if params["near_priority"] else far["median_lab"]
    dominant_bgr = cv2.cvtColor(np.uint8([[np.clip(dominant_lab, 0, 255)]]), cv2.COLOR_LAB2BGR)[0, 0]
    debug_images = _build_debug_images(image, box, near["roi"], far["roi"], text_mask, fill_box, dominant_bgr, prediction)
    return {
        "id": item["id"], "bbox": [box["left"], box["top"], box["width"], box["height"]],
        "text": item.get("text", ""), "prediction": prediction, "label": normalized_label,
        "isMismatch": is_mismatch, "isBoundary": is_boundary, "failReasons": fail_reasons,
        "metrics": metrics,
        "colors": {
            "near_rgb": _bgr_to_rgb(near["median_bgr"]), "far_rgb": _bgr_to_rgb(far["median_bgr"]),
            "main_rgb": _bgr_to_rgb(dominant_bgr),
        },
        "regions": {"near": list(near["roi"]), "far": list(far["roi"]), "fill": list(fill_box)},
        "images": debug_images,
    }


def _normalize_ocr_item(item: Any, index: int, shape: tuple[int, int]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    raw_box = item.get("bbox", item.get("box"))
    if isinstance(raw_box, (list, tuple)) and len(raw_box) >= 4:
        left, top, width, height = raw_box[:4]
    elif isinstance(raw_box, dict):
        left, top = raw_box.get("left", raw_box.get("x", 0)), raw_box.get("top", raw_box.get("y", 0))
        width, height = raw_box.get("width", raw_box.get("w", 0)), raw_box.get("height", raw_box.get("h", 0))
    else:
        return None
    try:
        image_height, image_width = shape
        left = max(0, min(image_width - 1, int(round(float(left)))))
        top = max(0, min(image_height - 1, int(round(float(top)))))
        width = max(1, min(image_width - left, int(round(float(width)))))
        height = max(1, min(image_height - top, int(round(float(height)))))
    except (TypeError, ValueError):
        return None
    box = {"left": left, "top": top, "width": width, "height": height}
    polygon = item.get("polygon")
    return {"id": str(item.get("id") or f"box_{index + 1:03d}"), "text": str(item.get("text") or ""), "box": box, "polygon": polygon}


def _measure_scale(lab: Any, box: dict[str, int], ratio: float, text_mask: Any, params: dict[str, Any]) -> dict[str, Any]:
    roi = _expanded_ratio_box(box, ratio, lab.shape[:2])
    x, y, width, height = roi
    roi_lab = lab[y:y + height, x:x + width]
    roi_mask = text_mask[y:y + height, x:x + width]
    eligible = np.ones(roi_mask.shape, dtype=bool) if params["ignore_text_mask"] else roi_mask == 0
    pixels = roi_lab[eligible].astype(np.float32)
    if len(pixels) == 0:
        pixels = roi_lab.reshape(-1, 3).astype(np.float32)
    median_lab = np.median(pixels, axis=0)
    distances = np.linalg.norm(pixels - median_lab, axis=1)
    threshold = float(params["delta_e_threshold"])
    dominant = pixels[distances <= threshold]
    variance_pixels = dominant if len(dominant) else pixels
    median_bgr = cv2.cvtColor(np.uint8([[np.clip(median_lab, 0, 255)]]), cv2.COLOR_LAB2BGR)[0, 0]
    return {
        "roi": roi, "median_lab": median_lab, "median_bgr": median_bgr,
        "lab_variance": float(np.mean(np.var(variance_pixels, axis=0))),
        "delta_e_p90": float(np.percentile(distances, 90)),
        "dominant_ratio": float(np.mean(distances <= threshold)), "sample_pixels": int(len(pixels)),
    }


def _build_debug_images(image: Any, box: dict[str, int], near: tuple[int, int, int, int], far: tuple[int, int, int, int], text_mask: Any, fill_box: tuple[int, int, int, int], color: Any, prediction: str) -> dict[str, str]:
    crop_roi = far
    crop = _crop(image, crop_roi)
    overlay = image.copy()
    _draw_roi(overlay, far, (255, 120, 0), 2)
    _draw_roi(overlay, near, (0, 210, 255), 2)
    cv2.rectangle(overlay, (box["left"], box["top"]), (box["left"] + box["width"], box["top"] + box["height"]), (180, 0, 180), 2)
    mask_bgr = cv2.cvtColor(text_mask, cv2.COLOR_GRAY2BGR)
    solid = image.copy()
    x, y, width, height = fill_box
    cv2.rectangle(solid, (x, y), (x + width, y + height), tuple(int(v) for v in color), -1)
    inpaint = cv2.inpaint(image, text_mask, 3, cv2.INPAINT_TELEA) if int(np.count_nonzero(text_mask)) else image.copy()
    current = solid if prediction == "solid" else inpaint
    return {
        "crop": _data_url(crop), "sampling_overlay": _data_url(_crop(overlay, crop_roi)),
        "mask": _data_url(_crop(mask_bgr, crop_roi)), "solid_preview": _data_url(_crop(solid, crop_roi)),
        "inpaint_preview": _data_url(_crop(inpaint, crop_roi)), "current_preview": _data_url(_crop(current, crop_roi)),
    }


def _summarize(boxes: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(boxes), "solid": sum(box["prediction"] == "solid" for box in boxes),
        "complex": sum(box["prediction"] == "complex" for box in boxes),
        "falseSolid": sum(box["label"] == "complex" and box["prediction"] == "solid" for box in boxes),
        "falseComplex": sum(box["label"] == "solid" and box["prediction"] == "complex" for box in boxes),
        "boundary": sum(bool(box["isBoundary"]) for box in boxes),
    }


def _metric(value: float, threshold: float, mode: str) -> dict[str, Any]:
    passed = value <= threshold if mode == "max" else value >= threshold
    return {"value": round(float(value), 4), "threshold": threshold, "pass": bool(passed), "mode": mode}


def _metric_margin(name: str, metric: dict[str, Any]) -> float:
    threshold = max(1e-6, abs(float(metric["threshold"])))
    return (float(metric["threshold"]) - float(metric["value"])) / threshold if metric["mode"] == "max" else (float(metric["value"]) - float(metric["threshold"])) / threshold


def _fail_reason(name: str, metric: dict[str, Any]) -> str:
    relation = "too high" if metric["mode"] == "max" else "too low"
    return f"{name} {relation} ({metric['value']} vs {metric['threshold']})"


def _expanded_ratio_box(box: dict[str, int], ratio: float, shape: tuple[int, int]) -> tuple[int, int, int, int]:
    image_height, image_width = shape
    pad_x, pad_y = int(math.ceil(box["width"] * ratio)), int(math.ceil(box["height"] * ratio))
    left, top = max(0, box["left"] - pad_x), max(0, box["top"] - pad_y)
    right = min(image_width, box["left"] + box["width"] + pad_x)
    bottom = min(image_height, box["top"] + box["height"] + pad_y)
    return left, top, max(1, right - left), max(1, bottom - top)


def _expanded_pixel_box(box: dict[str, int], pixels: int, shape: tuple[int, int]) -> tuple[int, int, int, int]:
    image_height, image_width = shape
    left, top = max(0, box["left"] - pixels), max(0, box["top"] - pixels)
    right = min(image_width, box["left"] + box["width"] + pixels)
    bottom = min(image_height, box["top"] + box["height"] + pixels)
    return left, top, max(1, right - left), max(1, bottom - top)


def _build_text_mask(shape: tuple[int, int], polygon: Any, dilate: int) -> Any:
    mask = np.zeros(shape, dtype=np.uint8)
    points = []
    if isinstance(polygon, list):
        for point in polygon:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                points.append([int(round(float(point[0]))), int(round(float(point[1])))])
    if len(points) >= 3:
        cv2.fillPoly(mask, [np.asarray(points, dtype=np.int32)], 255)
    if dilate > 0:
        size = dilate * 2 + 1
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    return mask


def _box_polygon(box: dict[str, int]) -> list[list[int]]:
    left, top = box["left"], box["top"]
    right, bottom = left + box["width"], top + box["height"]
    return [[left, top], [right, top], [right, bottom], [left, bottom]]


def _draw_roi(image: Any, roi: tuple[int, int, int, int], color: tuple[int, int, int], width: int) -> None:
    x, y, w, h = roi
    cv2.rectangle(image, (x, y), (x + w, y + h), color, width)


def _crop(image: Any, roi: tuple[int, int, int, int]) -> Any:
    x, y, width, height = roi
    return image[y:y + height, x:x + width]


def _data_url(image: Any) -> str:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        return ""
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def _bgr_to_rgb(value: Any) -> list[int]:
    return [int(value[2]), int(value[1]), int(value[0])]
