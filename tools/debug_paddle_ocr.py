from __future__ import annotations

import argparse
from pathlib import Path

from ocr_debug_common import DEFAULT_PARAMS, predict_ocr, print_items, save_debug_outputs, summarize_items


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run PaddleOCR directly and save OCR debug artifacts.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--lang", default="korean")
    parser.add_argument("--device", default="gpu:0")
    parser.add_argument("--out", default="debug_out")
    parser.add_argument("--text-det-thresh", type=float, default=DEFAULT_PARAMS["text_det_thresh"])
    parser.add_argument("--text-det-box-thresh", type=float, default=DEFAULT_PARAMS["text_det_box_thresh"])
    parser.add_argument("--text-det-unclip-ratio", type=float, default=DEFAULT_PARAMS["text_det_unclip_ratio"])
    parser.add_argument("--text-rec-score-thresh", type=float, default=DEFAULT_PARAMS["text_rec_score_thresh"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    params = {
        "text_det_thresh": args.text_det_thresh,
        "text_det_box_thresh": args.text_det_box_thresh,
        "text_det_unclip_ratio": args.text_det_unclip_ratio,
        "text_rec_score_thresh": args.text_rec_score_thresh,
    }
    image = Path(args.image)
    out = Path(args.out)
    items = predict_ocr(str(image), args.lang, args.device, params)
    paths = save_debug_outputs(str(image), items, out, image.stem)
    summary = summarize_items(items)
    print_items(items)
    print(
        f"[SUMMARY] boxes={summary['boxes']} hangul_chars={summary['hangul_chars']} "
        f"avg_score={summary['avg_score']:.4f}"
    )
    print(f"[OUTPUT] input={paths['input']}")
    print(f"[OUTPUT] json={paths['json']}")
    print(f"[OUTPUT] vis={paths['vis']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
