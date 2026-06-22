from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "visual"
sys.path.insert(0, str(ROOT / "local-ocr-service"))

PARAMS = {
    "text_det_thresh": 0.2,
    "text_det_box_thresh": 0.35,
    "text_det_unclip_ratio": 1.2,
    # 与扩展生产默认值一致，避免把调试模式的低置信噪声误算为可渲染文本。
    "text_rec_score_thresh": 0.72,
}


def normalize_text(value: Any) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣一-龥ぁ-んァ-ヶ]", "", str(value or ""))


def intersection_ratio(first: dict[str, Any], second: dict[str, Any]) -> float:
    left = max(float(first.get("left") or 0), float(second.get("left") or 0))
    top = max(float(first.get("top") or 0), float(second.get("top") or 0))
    right = min(
        float(first.get("left") or 0) + float(first.get("width") or 0),
        float(second.get("left") or 0) + float(second.get("width") or 0),
    )
    bottom = min(
        float(first.get("top") or 0) + float(first.get("height") or 0),
        float(second.get("top") or 0) + float(second.get("height") or 0),
    )
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(1.0, float(first.get("width") or 0) * float(first.get("height") or 0))
    second_area = max(1.0, float(second.get("width") or 0) * float(second.get("height") or 0))
    return overlap / min(first_area, second_area)


def calculate_metrics(result: dict[str, Any]) -> dict[str, Any]:
    items = list(result.get("items") or [])
    regions = list(result.get("regions") or [])
    width = max(1.0, float(result.get("imageWidth") or 1))
    height = max(1.0, float(result.get("imageHeight") or 1))
    duplicates = 0
    out_of_bounds = 0
    for index, item in enumerate(items):
        box = item.get("box") or {}
        left = float(box.get("left") or 0)
        top = float(box.get("top") or 0)
        box_width = float(box.get("width") or 0)
        box_height = float(box.get("height") or 0)
        if left < 0 or top < 0 or box_width <= 0 or box_height <= 0 or left + box_width > width or top + box_height > height:
            out_of_bounds += 1
        for previous in items[:index]:
            if normalize_text(item.get("text")) == normalize_text(previous.get("text")) and intersection_ratio(box, previous.get("box") or {}) >= 0.55:
                duplicates += 1
                break
    region_ratios = [
        float((region.get("box") or {}).get("width") or 0)
        * float((region.get("box") or {}).get("height") or 0)
        / (width * height)
        for region in regions
    ]
    counts = result.get("counts") or {}
    return {
        "items": len(items),
        "regions": len(regions),
        "texts": [str(item.get("text") or "") for item in items],
        "duplicate_ratio": duplicates / max(1, len(items)),
        "out_of_bounds_boxes": out_of_bounds,
        "max_region_area_ratio": max(region_ratios, default=0.0),
        "counts": counts,
        "stages": {
            "ocr": {
                "raw_items": int(counts.get("paddle_raw_items") or 0),
                "filtered_items": int(counts.get("filtered_items") or len(items)),
                "recognized_texts": [str(item.get("text") or "") for item in items],
            },
            "grouping": {
                "merged_blocks": int(counts.get("merged_blocks") or len(items)),
                "duplicate_ratio": duplicates / max(1, len(items)),
            },
            "background": {
                "regions": len(regions),
                "max_region_area_ratio": max(region_ratios, default=0.0),
            },
            "rendering_input": {
                "renderable_boxes": len(items) - out_of_bounds,
                "out_of_bounds_boxes": out_of_bounds,
            },
        },
    }


def verify_case(case: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    image_path = FIXTURE_DIR / str(case["file"])
    actual_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
    assert actual_hash == case["sha256"], f"{case['id']}: fixture hash changed"
    metrics = calculate_metrics(result)
    assert int(case["min_items"]) <= metrics["items"] <= int(case["max_items"]), f"{case['id']}: item count {metrics['items']}"
    assert int(case["min_regions"]) <= metrics["regions"] <= int(case["max_regions"]), f"{case['id']}: region count {metrics['regions']}"
    assert metrics["duplicate_ratio"] <= float(case["max_duplicate_ratio"]), f"{case['id']}: duplicate ratio {metrics['duplicate_ratio']}"
    assert metrics["out_of_bounds_boxes"] == 0, f"{case['id']}: boxes outside image"
    assert metrics["max_region_area_ratio"] <= float(case["max_region_area_ratio"]), f"{case['id']}: oversized region"
    combined = normalize_text("".join(metrics["texts"]))
    for fragment in case.get("expected_text_fragments") or []:
        assert normalize_text(fragment) in combined, f"{case['id']}: missing text fragment {fragment}"
    return metrics


def run_cases(selected: set[str] | None = None) -> dict[str, Any]:
    import server

    baseline = json.loads((FIXTURE_DIR / "baseline.json").read_text(encoding="utf-8"))
    report: dict[str, Any] = {"version": baseline["version"], "cases": {}}
    for case in baseline["cases"]:
        if selected and case["id"] not in selected:
            continue
        image_path = FIXTURE_DIR / case["file"]
        result = server.run_ocr(image_path.read_bytes(), "korean", "fast", PARAMS, False, f"visual-{case['id']}")
        report["cases"][case["id"]] = verify_case(case, result)
    return report


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="运行固定真实截图 OCR 视觉回归")
    parser.add_argument("--case", action="append", dest="cases", help="只运行指定 case，可重复传入")
    args = parser.parse_args()
    report = run_cases(set(args.cases) if args.cases else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
