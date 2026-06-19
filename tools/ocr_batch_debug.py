from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


@dataclass
class Params:
    confidence_threshold: float = 0.72
    min_box_area: float = 36.0
    max_box_area: float = 0.35
    max_aspect_ratio: float = 18.0
    merge_line_gap: float = 1.65
    font_scale: float = 1.0
    cover_padding: float = 2.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch OCR and overwrite debug renderer for manga screenshots.")
    parser.add_argument("--input", default="tests/fixtures/ocr", help="Image file or folder.")
    parser.add_argument("--out", default="debug_ocr_report", help="Output folder.")
    parser.add_argument("--service-url", default="http://127.0.0.1:8765", help="Local OCR service URL.")
    parser.add_argument("--lang", default="auto", choices=["auto", "korean", "japan"])
    parser.add_argument("--mode", default="enhanced", choices=["fast", "enhanced"])
    parser.add_argument("--text-det-thresh", type=float, default=0.3)
    parser.add_argument("--text-det-box-thresh", type=float, default=0.6)
    parser.add_argument("--text-det-unclip-ratio", type=float, default=1.2)
    parser.add_argument("--text-rec-score-thresh", type=float, default=0.0)
    parser.add_argument("--confidence-threshold", type=float, default=0.72)
    parser.add_argument("--min-box-area", type=float, default=36.0)
    parser.add_argument("--max-box-area", type=float, default=0.35)
    parser.add_argument("--max-aspect-ratio", type=float, default=18.0)
    parser.add_argument("--merge-line-gap", type=float, default=1.65)
    parser.add_argument("--font-scale", type=float, default=1.0)
    parser.add_argument("--cover-padding", type=float, default=2.0)
    parser.add_argument("--offline-json", default="", help="Optional OCR JSON folder to avoid service calls.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    params = Params(
        confidence_threshold=args.confidence_threshold,
        min_box_area=args.min_box_area,
        max_box_area=args.max_box_area,
        max_aspect_ratio=args.max_aspect_ratio,
        merge_line_gap=args.merge_line_gap,
        font_scale=args.font_scale,
        cover_padding=args.cover_padding,
    )
    images = collect_images(Path(args.input))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    reports: list[dict[str, Any]] = []

    for image_path in images:
        print(f"[RUN] {image_path}")
        try:
            image = Image.open(image_path).convert("RGB")
            payload = load_or_request_ocr(image_path, args)
            result = process_payload(payload, image, params)
            result["file"] = str(image_path)
            result["params"] = asdict(params)
            write_artifacts(image_path, image, result, out_dir)
            reports.append(result)
            print(
                "[OK] raw={raw} filtered={filtered} merged={merged} final={final} overflow={overflow}".format(
                    **result["counts"]
                )
            )
        except Exception as exc:  # noqa: BLE001 - batch report should continue
            reports.append({"file": str(image_path), "error": str(exc)})
            print(f"[FAIL] {image_path}: {exc}", file=sys.stderr)

    write_report(reports, out_dir)
    print(f"[OUTPUT] {out_dir.resolve()}")
    return 0


def collect_images(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() in IMAGE_EXTS else []
    return sorted(item for item in path.rglob("*") if item.suffix.lower() in IMAGE_EXTS)


def load_or_request_ocr(image_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    if args.offline_json:
        candidate = Path(args.offline_json) / f"{image_path.stem}.json"
        if candidate.exists():
            return json.loads(candidate.read_text(encoding="utf-8"))

    data_url = image_to_data_url(image_path)
    body = json.dumps(
        {
            "image": data_url,
            "lang": args.lang,
            "mode": args.mode,
            "text_det_thresh": args.text_det_thresh,
            "text_det_box_thresh": args.text_det_box_thresh,
            "text_det_unclip_ratio": args.text_det_unclip_ratio,
            "text_rec_score_thresh": args.text_rec_score_thresh,
            "debug": True,
            "debug_id": image_path.stem,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{args.service_url.rstrip('/')}/ocr",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"local OCR service request failed: {exc}") from exc


def image_to_data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def process_payload(payload: dict[str, Any], image: Image.Image, params: Params) -> dict[str, Any]:
    source = payload.get("rawItems") if payload.get("rawItems") else payload.get("items", [])
    raw_items = [item for item in (normalize_item(row, index) for index, row in enumerate(source)) if item]
    filter_reasons = []
    filtered_items = []
    for item in raw_items:
        reason = drop_reason(item, image, params)
        if reason:
            filter_reasons.append({"id": item["id"], "text": item["text"], "reason": reason, "box": item["box"]})
        else:
            filtered_items.append(item)
    merged_items = merge_items(filtered_items, params)
    final_items = [build_final_item(item, index, image, params) for index, item in enumerate(merged_items)]
    return {
        "counts": {
            "raw": len(raw_items),
            "filtered": len(filtered_items),
            "filteredOut": len(raw_items) - len(filtered_items),
            "merged": len(merged_items),
            "final": len(final_items),
            "overflow": sum(1 for item in final_items if item["overflow"]),
            "emptyTranslation": sum(1 for item in final_items if not item["translatedText"]),
            "invalidCoordinates": sum(1 for item in final_items if item["invalidCoordinates"]),
        },
        "rawItems": raw_items,
        "filteredItems": filtered_items,
        "mergedItems": merged_items,
        "finalBubbles": final_items,
        "filterReasons": filter_reasons,
    }


def normalize_item(item: dict[str, Any], index: int) -> dict[str, Any] | None:
    box = normalize_box(item.get("box") or item.get("location") or item.get("rawBox") or item.get("boundingBox"))
    text = str(item.get("text") or item.get("words") or "").strip()
    if not box or not text:
        return None
    return {
        "id": f"ocr-{index}",
        "text": text,
        "confidence": float(item.get("score") or item.get("confidence") or 0.0),
        "box": box,
        "source": item.get("variant") or item.get("lang") or "ocr",
    }


def normalize_box(box: Any) -> dict[str, float] | None:
    if not isinstance(box, dict):
        return None
    left = as_float(box.get("left", box.get("x")))
    top = as_float(box.get("top", box.get("y")))
    width = as_float(box.get("width", box.get("w")))
    height = as_float(box.get("height", box.get("h")))
    if left is None or top is None or width is None or height is None or width <= 0 or height <= 0:
        return None
    return {"left": left, "top": top, "width": width, "height": height, "right": left + width, "bottom": top + height}


def drop_reason(item: dict[str, Any], image: Image.Image, params: Params) -> str:
    text = "".join(str(item["text"]).split())
    box = item["box"]
    area = box["width"] * box["height"]
    area_ratio = area / max(1.0, image.width * image.height)
    aspect = max(box["width"] / max(1.0, box["height"]), box["height"] / max(1.0, box["width"]))
    if is_symbol_only(text):
        return "symbol-only"
    if item["confidence"] > 0 and item["confidence"] < params.confidence_threshold and count_script(text) <= 2:
        return "low-confidence"
    if area < params.min_box_area:
        return "too-small-area"
    if area_ratio > params.max_box_area:
        return "too-large-area"
    if aspect > params.max_aspect_ratio:
        return "bad-aspect-ratio"
    if count_script(text) <= 1 and area_ratio < 0.003 and item["confidence"] < 0.98:
        return "tiny-single-character"
    return ""


def merge_items(items: list[dict[str, Any]], params: Params) -> list[dict[str, Any]]:
    groups: list[list[dict[str, Any]]] = []
    for item in sorted(items, key=lambda row: (row["box"]["top"], row["box"]["left"])):
        group = next((candidate for candidate in groups if should_merge(candidate, item, params)), None)
        if group:
            group.append(item)
        else:
            groups.append([item])
    merged = []
    for index, group in enumerate(groups):
        box = union_box([item["box"] for item in group])
        merged.append(
            {
                "id": f"merged-{index}",
                "text": "\n".join(item["text"] for item in group),
                "confidence": max(float(item["confidence"]) for item in group),
                "box": box,
                "items": group,
            }
        )
    return merged


def should_merge(group: list[dict[str, Any]], item: dict[str, Any], params: Params) -> bool:
    box = union_box([entry["box"] for entry in group])
    item_box = item["box"]
    avg_height = (sum(entry["box"]["height"] for entry in group) + item_box["height"]) / (len(group) + 1)
    vertical_overlap = min(box["bottom"], item_box["bottom"]) - max(box["top"], item_box["top"])
    same_line = vertical_overlap >= min(box["height"], item_box["height"]) * 0.45
    horizontal_gap = max(0.0, item_box["left"] - box["right"], box["left"] - item_box["right"])
    if same_line:
        return horizontal_gap <= avg_height * 2.2
    vertical_gap = item_box["top"] - box["bottom"]
    overlap_x = min(box["right"], item_box["right"]) - max(box["left"], item_box["left"])
    overlap_ratio = overlap_x / max(1.0, min(box["width"], item_box["width"])) if overlap_x > 0 else 0.0
    return -avg_height * 0.5 <= vertical_gap <= avg_height * params.merge_line_gap and overlap_ratio >= 0.18


def union_box(boxes: list[dict[str, float]]) -> dict[str, float]:
    left = min(box["left"] for box in boxes)
    top = min(box["top"] for box in boxes)
    right = max(box["right"] for box in boxes)
    bottom = max(box["bottom"] for box in boxes)
    return {"left": left, "top": top, "right": right, "bottom": bottom, "width": right - left, "height": bottom - top}


def build_final_item(item: dict[str, Any], index: int, image: Image.Image, params: Params) -> dict[str, Any]:
    pad = max(0.0, params.cover_padding)
    box = {
        "left": max(0.0, item["box"]["left"] - pad),
        "top": max(0.0, item["box"]["top"] - pad),
        "right": min(float(image.width), item["box"]["right"] + pad),
        "bottom": min(float(image.height), item["box"]["bottom"] + pad),
    }
    box["width"] = box["right"] - box["left"]
    box["height"] = box["bottom"] - box["top"]
    translated = "给你看！"
    font_size, lines, overflow = fit_text(translated, box["width"] * 0.9, box["height"] * 0.75, params.font_scale)
    return {
        "id": f"final-{index}",
        "sourceText": item["text"],
        "translatedText": translated,
        "confidence": item["confidence"],
        "box": box,
        "fontSize": font_size,
        "lines": lines,
        "overflow": overflow,
        "invalidCoordinates": box["width"] <= 0 or box["height"] <= 0,
    }


def fit_text(text: str, width: float, height: float, font_scale: float) -> tuple[int, list[str], bool]:
    chars = list(text)
    best = (8, [text], True)
    start = int(max(8, min(42, height * 0.55 * font_scale)))
    for size in range(start, 7, -1):
        max_chars = max(1, int(width / max(1.0, size * 0.62)))
        lines = ["".join(chars[index : index + max_chars]) for index in range(0, len(chars), max_chars)]
        overflow = len(lines) * size * 1.22 > height
        best = (size, lines, overflow)
        if not overflow:
            return best
    return best


def write_artifacts(image_path: Path, image: Image.Image, result: dict[str, Any], out_dir: Path) -> None:
    stem = safe_stem(image_path.stem)
    (out_dir / "json").mkdir(exist_ok=True)
    (out_dir / "vis").mkdir(exist_ok=True)
    (out_dir / "after").mkdir(exist_ok=True)
    (out_dir / "json" / f"{stem}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    draw_boxes(image, result["rawItems"], "raw").save(out_dir / "vis" / f"{stem}-raw.png")
    draw_boxes(image, result["filteredItems"], "filtered").save(out_dir / "vis" / f"{stem}-filtered.png")
    draw_boxes(image, result["mergedItems"], "merged").save(out_dir / "vis" / f"{stem}-merged.png")
    draw_overwrite(image, result["finalBubbles"]).save(out_dir / "after" / f"{stem}-after.png")


def draw_boxes(image: Image.Image, items: list[dict[str, Any]], label: str) -> Image.Image:
    colors = {"raw": (239, 68, 68), "filtered": (37, 99, 235), "merged": (245, 158, 11)}
    color = colors.get(label, (5, 150, 105))
    canvas = image.copy().convert("RGB")
    draw = ImageDraw.Draw(canvas)
    font = load_font(15)
    for index, item in enumerate(items, start=1):
        box = item["box"]
        draw.rectangle([box["left"], box["top"], box["right"], box["bottom"]], outline=color, width=3)
        text = f"{index} {float(item.get('confidence') or 0):.2f} {str(item.get('text') or item.get('sourceText') or '')[:30]}"
        draw.rectangle([box["left"], max(0, box["top"] - 20), box["left"] + min(420, len(text) * 8), box["top"]], fill=(255, 255, 255))
        draw.text((box["left"] + 3, max(0, box["top"] - 18)), text, fill=color, font=font)
    return canvas


def draw_overwrite(image: Image.Image, items: list[dict[str, Any]]) -> Image.Image:
    canvas = image.copy().convert("RGB")
    draw = ImageDraw.Draw(canvas)
    for item in items:
        box = item["box"]
        draw.rounded_rectangle(
            [box["left"], box["top"], box["right"], box["bottom"]],
            radius=min(8, int(box["height"] * 0.12)),
            fill=(255, 255, 255),
        )
        font = load_font(max(8, int(item["fontSize"])))
        line_height = item["fontSize"] * 1.22
        y = box["top"] + box["height"] / 2 - ((len(item["lines"]) - 1) * line_height) / 2
        for line in item["lines"]:
            bbox = draw.textbbox((0, 0), line, font=font)
            x = box["left"] + box["width"] / 2 - (bbox[2] - bbox[0]) / 2
            draw.text((x, y - (bbox[3] - bbox[1]) / 2), line, fill=(17, 24, 39), font=font)
            y += line_height
    return canvas


def write_report(reports: list[dict[str, Any]], out_dir: Path) -> None:
    (out_dir / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# OCR Debug Report", "", "| file | raw | filtered | merged | final | overflow | notes |", "|---|---:|---:|---:|---:|---:|---|"]
    for report in reports:
        if report.get("error"):
            lines.append(f"| {report['file']} | 0 | 0 | 0 | 0 | 0 | ERROR: {report['error']} |")
            continue
        counts = report["counts"]
        lines.append(
            f"| {report['file']} | {counts['raw']} | {counts['filtered']} | {counts['merged']} | "
            f"{counts['final']} | {counts['overflow']} | filteredOut={counts['filteredOut']} |"
        )
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def is_symbol_only(text: str) -> bool:
    return not any(ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af" for ch in text)


def count_script(text: str) -> int:
    return sum(1 for ch in text if "\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af")


def as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def safe_stem(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:80] or "image"


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\malgun.ttf", r"C:\Windows\Fonts\arial.ttf"]:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


if __name__ == "__main__":
    raise SystemExit(main())
