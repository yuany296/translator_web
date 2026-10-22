from __future__ import annotations

import base64
import json
import subprocess
import sys

from ..dependencies import runtime

# manga-ocr（kha-white/manga-ocr-base）：在日漫上训练的识别模型，竖排/ルビ/手写体是它的
# 训练分布——PP-OCR 的三类残留（小假名吞字、多列混读、无通道块）恰好是它的强项。它是纯
# 识别模型（无检测），吃的正是列拆分产出的逐列 crop。实现不依赖 manga-ocr pip 包：模型
# 经 transformers 直连，跑在**独立 worker 进程**里——torch 与 paddle 的 CUDA DLL 在
# Windows 上同进程互相加载失败（两种顺序都试过），进程隔离是唯一稳妥解。批量协议：
# 一行 {"images": [...]} 进、一行 {"results": [...]} 出（压扁后批内无尺寸差）。
MANGA_OCR_MODEL_DEFAULT = "kha-white/manga-ocr-base"

runtime.MANGA_OCR_MODEL_DEFAULT = MANGA_OCR_MODEL_DEFAULT

def manga_ocr_engine_enabled(params: dict[str, runtime.Any] | None, lang: str) -> bool:
    """识别引擎开关：lang=japan 且请求 rec_engine=manga_ocr（或环境变量默认）时启用。

    korean/en 等语言与 lang=auto 不受影响；默认 paddle，结果与既有链路逐字一致。
    """
    if str(lang or "") != "japan":
        return False
    requested = str((params or {}).get("rec_engine") or "").strip().lower()
    if not requested:
        requested = str(runtime.os.environ.get("LOCAL_OCR_REC_ENGINE", "")).strip().lower()
    return requested == "manga_ocr"

runtime.manga_ocr_engine_enabled = manga_ocr_engine_enabled

def _worker_script_path() -> str:
    return str(runtime.Path(__file__).resolve().parent / "manga_ocr_worker.py")

def _worker_batch_size() -> int:
    try:
        return max(1, int(str(runtime.os.environ.get("LOCAL_OCR_MANGA_OCR_BATCH", "")).strip() or 8))
    except ValueError:
        return 8

def _worker_env() -> dict[str, str]:
    """worker 的环境变量：从继承的 PATH 里剔除 paddle/nvidia 的 CUDA 目录。

    paddle 导入时会把自己的 DLL 目录塞进 PATH；worker 继承后 torch 会先解析到
    paddle 的不兼容 cudnn（WinError 127）。清掉它们，torch 才会用自己 lib/ 下的版本。
    HF_HUB_OFFLINE：模型已落盘，跳过联网 etag 检查（网络不通时重试能拖死首次请求）。
    """
    pathsep = runtime.os.pathsep
    entries = [
        entry for entry in runtime.os.environ.get("PATH", "").split(pathsep)
        if entry and "paddle" not in entry.lower() and "\\nvidia\\" not in entry.lower()
    ]
    return {**runtime.os.environ, "PATH": pathsep.join(entries), "PYTHONIOENCODING": "utf-8", "HF_HUB_OFFLINE": "1"}

runtime._worker_env = _worker_env

def get_manga_ocr_client() -> dict[str, runtime.Any]:
    """懒启动 worker 进程（进程内单例）；worker 死掉时由调用方重建。"""
    handle = runtime.__dict__.get("_manga_ocr_client")
    if handle is not None and handle["proc"].poll() is None:
        return handle
    with runtime._ocr_client_lock:
        handle = runtime.__dict__.get("_manga_ocr_client")
        if handle is not None and handle["proc"].poll() is None:
            return handle
        proc = subprocess.Popen(
            [sys.executable, _worker_script_path()],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_worker_env(),
        )
        ready = proc.stdout.readline()
        if '"ready"' not in ready:
            proc.kill()
            raise RuntimeError(f"manga-ocr worker failed to start: {ready[:200]}")
        handle = {"proc": proc}
        runtime._manga_ocr_client = handle
        print("[manga-ocr] 识别 worker 就绪（独立进程，规避 torch/paddle DLL 冲突）", flush=True)
        return handle

runtime.get_manga_ocr_client = get_manga_ocr_client

def _manga_ocr_roundtrip(handle: dict[str, runtime.Any], payload: str) -> str:
    handle["proc"].stdin.write(payload + "\n")
    handle["proc"].stdin.flush()
    return handle["proc"].stdout.readline()

def _manga_ocr_predict_batch(images: list[runtime.Any]) -> list[tuple[str, float]]:
    """识别一批列 crop（BGR ndarray），按输入顺序返回 (text, 平均 token 概率)。"""
    import cv2

    encoded: list[str] = []
    for image in images:
        ok, buffer = cv2.imencode(".png", image)
        encoded.append(base64.b64encode(buffer.tobytes()).decode("ascii") if ok else "")
    batch_size = _worker_batch_size()
    results: list[tuple[str, float]] = []
    for start in range(0, len(encoded), batch_size):
        chunk = encoded[start:start + batch_size]
        handle = runtime.get_manga_ocr_client()
        try:
            reply = _manga_ocr_roundtrip(handle, json.dumps({"images": chunk}))
        except (BrokenPipeError, OSError):
            handle["proc"].kill()
            runtime._manga_ocr_client = None
            handle = runtime.get_manga_ocr_client()
            reply = _manga_ocr_roundtrip(handle, json.dumps({"images": chunk}))
        message = runtime.json.loads(reply)
        if "error" in message:
            raise RuntimeError(f"manga-ocr worker error: {message['error']}")
        rows = message.get("results") or []
        for index, item in enumerate(rows):
            results.append((str(item.get("text") or ""), float(item.get("confidence") or 0.0)))
        for _ in range(len(chunk) - len(rows)):
            results.append(("", 0.0))
    return results

runtime._manga_ocr_predict_batch = _manga_ocr_predict_batch

def _manga_ocr_predict(image: runtime.Any) -> tuple[str, float]:
    """单张便捷入口（测试/诊断用）；生产路径走 _manga_ocr_predict_batch。"""
    return _manga_ocr_predict_batch([image])[0]

runtime._manga_ocr_predict = _manga_ocr_predict

def recognize_rows_with_manga_ocr(rows: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    """与 recognize_candidate_rows 同形：批量送 manga-ocr worker，输出保留候选字段。

    输入行的 image 是**未旋转**的列 crop——manga-ocr 在竖排上训练，不需要 ±90 转正；
    korean 等其他语言不走这条路径（见 manga_ocr_engine_enabled）。
    """
    output: list[dict[str, runtime.Any]] = []
    if not rows:
        return output
    predictions: list[tuple[str, float]] = [("", 0.0)] * len(rows)
    pending = [index for index, row in enumerate(rows) if row.get("image") is not None]
    for start in range(0, len(pending), _worker_batch_size()):
        chunk = pending[start:start + _worker_batch_size()]
        for index, (text, confidence) in zip(chunk, runtime._manga_ocr_predict_batch([rows[index]["image"] for index in chunk])):
            predictions[index] = (text, confidence)
    for row, (text, confidence) in zip(rows, predictions):
        candidate = {key: value for key, value in row.items() if key != "image"}
        output.append({**candidate, "text": str(text or ""), "score": float(confidence), "lang": "japan"})
    return output

runtime.recognize_rows_with_manga_ocr = recognize_rows_with_manga_ocr
