from __future__ import annotations

import argparse
from pathlib import Path

from ocr_debug_common import predict_ocr, print_items, save_debug_outputs, summarize_items

PARAM_SETS = {
    "A": {"text_det_thresh": 0.3, "text_det_box_thresh": 0.6, "text_det_unclip_ratio": 1.2, "text_rec_score_thresh": 0.0},
    "B": {"text_det_thresh": 0.2, "text_det_box_thresh": 0.35, "text_det_unclip_ratio": 1.5, "text_rec_score_thresh": 0.0},
    "C": {"text_det_thresh": 0.15, "text_det_box_thresh": 0.3, "text_det_unclip_ratio": 2.0, "text_rec_score_thresh": 0.0},
    "D": {"text_det_thresh": 0.1, "text_det_box_thresh": 0.25, "text_det_unclip_ratio": 3.0, "text_rec_score_thresh": 0.0},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sweep PaddleOCR detection parameters on one image.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--lang", default="korean")
    parser.add_argument("--device", default="gpu:0")
    parser.add_argument("--out", default="debug_sweep")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    image = Path(args.image)
    out = Path(args.out)
    summaries = []
    for name, params in PARAM_SETS.items():
        print(f"[RUN] {name} params={params}")
        items = predict_ocr(str(image), args.lang, args.device, params)
        save_debug_outputs(str(image), items, out, f"{image.stem}_{name}")
        summary = summarize_items(items)
        summaries.append((name, summary))
        print_items(items)
        print(
            f"[SUMMARY:{name}] boxes={summary['boxes']} hangul_chars={summary['hangul_chars']} "
            f"avg_score={summary['avg_score']:.4f}"
        )
    best = max(summaries, key=lambda row: (row[1]["hangul_chars"], row[1]["boxes"], row[1]["avg_score"]))
    print("[SWEEP SUMMARY]")
    for name, summary in summaries:
        print(
            f"{name}: boxes={summary['boxes']} hangul_chars={summary['hangul_chars']} "
            f"avg_score={summary['avg_score']:.4f}"
        )
    print(f"[BEST] {best[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
