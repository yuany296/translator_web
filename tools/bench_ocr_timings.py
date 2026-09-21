"""本地 OCR 服务分阶段耗时基线工具。

用法（先按 start_local_ocr_gpu.bat 启动服务）：

    python tools/bench_ocr_timings.py --input tests/fixtures/ocr --repeat 3
    python tools/bench_ocr_timings.py --concurrency 3 --debug

输出每个阶段（decode / queueWait / detectPrimary / recognize / appearance / debugArtifacts …）
的 p50/p95，以及并发下整批的墙钟时间：并发下整批时间接近单张 ×N，说明服务端仍在串行处理。
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local OCR service phase timings.")
    parser.add_argument("--input", default="tests/fixtures/ocr", help="Image file or folder.")
    parser.add_argument("--service-url", default="http://127.0.0.1:8765")
    parser.add_argument("--lang", default="auto", choices=["auto", "korean", "japan", "en"])
    parser.add_argument("--mode", default="fast", choices=["fast", "enhanced"])
    parser.add_argument("--repeat", type=int, default=3, help="Repetitions per image (serial run).")
    parser.add_argument("--warmup", type=int, default=1, help="Warmup requests before measuring.")
    parser.add_argument("--concurrency", type=int, default=0, help="Also run one batch with N parallel requests.")
    parser.add_argument("--debug", action="store_true", help="Ask the service for debug artifacts (per-request debug=true).")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--json-out", default="", help="Optional path to dump the raw measurements.")
    return parser.parse_args()


def collect_images(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() in IMAGE_EXTS else []
    return sorted(item for item in path.rglob("*") if item.suffix.lower() in IMAGE_EXTS)


def image_to_data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def request_ocr(image_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    body = json.dumps({
        "image": image_to_data_url(image_path),
        "lang": args.lang,
        "mode": args.mode,
        "text_det_thresh": 0.3,
        "text_det_box_thresh": 0.6,
        "text_det_unclip_ratio": 1.2,
        "text_rec_score_thresh": 0.0,
        "debug": bool(args.debug),
        "debug_id": f"bench-{image_path.stem}",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{args.service_url.rstrip('/')}/ocr",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    payload["_wallMs"] = round((time.perf_counter() - started) * 1000.0, 1)
    return payload


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * min(1.0, max(0.0, ratio))))
    return ordered[index]


def summarize(measurements: list[dict[str, Any]]) -> dict[str, Any]:
    phase_names: list[str] = []
    for item in measurements:
        for name in (item.get("phases") or {}):
            if name not in phase_names:
                phase_names.append(name)
    rows = {"wallMs": [float(item.get("wallMs") or 0.0) for item in measurements]}
    for name in phase_names:
        rows[name] = [float((item.get("phases") or {}).get(name) or 0.0) for item in measurements]
    return {
        name: {
            "p50": round(percentile(values, 0.5), 1),
            "p95": round(percentile(values, 0.95), 1),
            "max": round(max(values), 1) if values else 0.0,
        }
        for name, values in rows.items()
    }


def fetch_server_summary(service_url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{service_url.rstrip('/')}/ocr/timings", timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}


def measure_serial(images: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:
    measurements: list[dict[str, Any]] = []
    for _ in range(max(0, args.warmup)):
        for image in images:
            request_ocr(image, args)
    for _ in range(max(1, args.repeat)):
        for image in images:
            payload = request_ocr(image, args)
            timings = payload.get("timings") or {}
            measurements.append({
                "file": image.name,
                "wallMs": payload.get("_wallMs"),
                "totalMs": timings.get("totalMs"),
                "unaccountedMs": timings.get("unaccountedMs"),
                "phases": timings.get("phases") or {},
                "items": len(payload.get("items") or []),
            })
    return measurements


def measure_batch(images: list[Path], concurrency: int, args: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        payloads = list(pool.map(lambda image: request_ocr(image, args), images))
    batch_ms = round((time.perf_counter() - started) * 1000.0, 1)
    walls = [float(payload.get("_wallMs") or 0.0) for payload in payloads]
    return {
        "concurrency": concurrency,
        "requests": len(images),
        "batchWallMs": batch_ms,
        "perRequestP50Ms": round(percentile(walls, 0.5), 1),
        "perRequestP95Ms": round(percentile(walls, 0.95), 1),
    }


def print_serial_report(summary: dict[str, Any], count: int) -> None:
    print(f"\n## serial measurements (n={count})")
    print("| phase | p50 | p95 | max |")
    print("|---|---:|---:|---:|")
    for name, stats in summary.items():
        print(f"| {name} | {stats['p50']} | {stats['p95']} | {stats['max']} |")


def print_parallel_report(batch: dict[str, Any], serial_wall_p50: float) -> None:
    expected = round(serial_wall_p50 * batch["requests"], 1)
    speedup = round(expected / batch["batchWallMs"], 2) if batch["batchWallMs"] > 0 else 0.0
    print(f"\n## concurrency={batch['concurrency']} batch")
    print(f"- requests: {batch['requests']}")
    print(f"- batch wall: {batch['batchWallMs']} ms (serial estimate {expected} ms, speedup {speedup})")
    print(f"- per request p50/p95: {batch['perRequestP50Ms']} / {batch['perRequestP95Ms']} ms")
    if speedup < 1.5 and batch["concurrency"] > 1:
        print("- 说明：并发加速比偏低，服务端很可能仍是串行处理。")


def main() -> int:
    args = parse_args()
    images = collect_images(Path(args.input))
    if not images:
        print(f"no images found under {args.input}", file=sys.stderr)
        return 1

    print(f"# OCR bench: {len(images)} image(s), lang={args.lang}, mode={args.mode}, debug={args.debug}")
    serial = measure_serial(images, args)
    serial_summary = summarize(serial)
    print_serial_report(serial_summary, len(serial))

    batches = []
    if args.concurrency and args.concurrency > 1:
        batch_images = images * max(1, args.concurrency)
        batch = measure_batch(batch_images, args.concurrency, args)
        batches.append(batch)
        print_parallel_report(batch, serial_summary.get("wallMs", {}).get("p50", 0.0))

    server = fetch_server_summary(args.service_url)
    if server.get("ok"):
        print(f"\n## service /ocr/timings (count={server.get('count')}, window={server.get('window')})")
        print(f"- totalMs p50/p95: {server['totalMs']['p50']} / {server['totalMs']['p95']}")
        for name, stats in sorted((server.get("phases") or {}).items(), key=lambda item: -item[1]["p50"]):
            print(f"- {name}: p50={stats['p50']} p95={stats['p95']} max={stats['max']}")

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps({"args": vars(args), "serial": serial, "summary": serial_summary, "batches": batches, "server": server},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[json] {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
