from __future__ import annotations

import argparse
import base64
import json
import socket
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:8765"
DEFAULT_TIMEOUT_SECONDS = 90


def main() -> int:
    parser = argparse.ArgumentParser(description="Check local PaddleOCR service connectivity and OCR response.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Local OCR service base URL.")
    parser.add_argument("--lang", default="auto", choices=["auto", "japan", "korean"], help="OCR language.")
    parser.add_argument("--enhanced", action="store_true", help="Run slower enhanced preprocessing variants.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS, help="Request timeout seconds.")
    parser.add_argument("--image", default="", help="Optional image path. A small test image is generated when omitted.")
    args = parser.parse_args()

    base_url = sanitize_base_url(args.base_url)
    print(f"[1/3] Health check: {base_url}/health")
    health = request_json("GET", f"{base_url}/health", timeout=args.timeout)
    print(json.dumps(health, ensure_ascii=False, indent=2))

    if not health.get("ok"):
        print("[FAIL] OCR engine import failed. Check the error above.", file=sys.stderr)
        return 2

    image_path = Path(args.image).expanduser() if args.image else create_test_image()
    print(f"[2/3] OCR image: {image_path}")

    data_url = image_to_data_url(image_path)
    mode = "enhanced" if args.enhanced else "fast"
    print(f"[3/3] POST {base_url}/ocr lang={args.lang} mode={mode}")
    payload = request_json(
        "POST",
        f"{base_url}/ocr",
        {
            "image": data_url,
            "lang": args.lang,
            "mode": mode,
        },
        timeout=args.timeout,
    )

    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        print("[FAIL] OCR response does not contain an items list.", file=sys.stderr)
        return 3

    print(f"[OK] OCR request succeeded. items={len(items)}")
    for index, item in enumerate(items[:10], start=1):
        text = str(item.get("text", "")).strip()
        score = item.get("score", "")
        lang = item.get("lang", "")
        variant = item.get("variant", "")
        box = item.get("box", {})
        print(f"  {index}. [{lang}/{variant}] score={score} text={text!r} box={box}")

    if not items:
        print("[WARN] Service is reachable, but no text was detected in the test image.")

    return 0


def sanitize_base_url(value: str) -> str:
    text = str(value or DEFAULT_BASE_URL).strip().rstrip("/")
    return text or DEFAULT_BASE_URL


def request_json(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=max(1, int(timeout))) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"[FAIL] HTTP {exc.code}: {raw}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise SystemExit(
            "[FAIL] OCR request timed out. Use fast mode first, or retry enhanced mode with --timeout 180."
        ) from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise SystemExit(
                "[FAIL] OCR request timed out. Use fast mode first, or retry enhanced mode with --timeout 180."
            ) from exc
        raise SystemExit(f"[FAIL] Cannot connect to local OCR service: {exc.reason}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"[FAIL] Invalid JSON response: {raw[:500]}") from exc


def image_to_data_url(path: Path) -> str:
    if not path.exists() or not path.is_file():
        raise SystemExit(f"[FAIL] Image does not exist: {path}")

    suffix = path.suffix.lower()
    mime = "image/png"
    if suffix in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    elif suffix == ".webp":
        mime = "image/webp"

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def create_test_image() -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:
        raise SystemExit(f"[FAIL] Pillow is required to generate a test image: {exc}") from exc

    image = Image.new("RGB", (640, 220), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 64)
    except Exception:
        font = ImageFont.load_default()

    # 使用简单英文和数字，目的是验证 OCR 链路是否能返回结构化结果。
    draw.text((48, 70), "TEST OCR 123", fill="black", font=font)

    output = Path(tempfile.gettempdir()) / "manga-translator-ocr-check.png"
    image.save(output)
    return output


if __name__ == "__main__":
    raise SystemExit(main())
