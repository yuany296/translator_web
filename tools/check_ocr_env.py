from __future__ import annotations

import os
import sys
import types
from typing import Any


def prepare_paddleocr_import() -> None:
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


def main() -> int:
    prepare_paddleocr_import()
    print(f"python: {sys.executable}")
    try:
        import paddle
    except Exception as exc:
        print(f"[FAIL] import paddle failed: {exc}", file=sys.stderr)
        return 1
    try:
        import paddleocr
    except Exception as exc:
        print(f"[FAIL] import paddleocr failed: {exc}", file=sys.stderr)
        return 1

    print(f"paddle: {paddle.__version__}")
    print(f"paddleocr: {getattr(paddleocr, '__version__', 'unknown')}")
    cuda = bool(paddle.is_compiled_with_cuda())
    print(f"cuda_compiled: {cuda}")
    if not cuda:
        print("[FAIL] Paddle is not compiled with CUDA. GPU OCR is unavailable.", file=sys.stderr)
        return 1

    try:
        count = paddle.device.cuda.device_count()
    except Exception as exc:
        print(f"[FAIL] paddle.device.cuda.device_count() failed: {exc}", file=sys.stderr)
        return 1
    print(f"cuda_device_count: {count}")
    if count <= 0:
        print("[FAIL] No CUDA device is visible to Paddle.", file=sys.stderr)
        return 1

    try:
        paddle.set_device("gpu:0")
        print("set_device_gpu0: ok")
    except Exception as exc:
        print(f"[FAIL] paddle.set_device('gpu:0') failed: {exc}", file=sys.stderr)
        return 1

    print(f"current_device: {paddle.device.get_device()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
