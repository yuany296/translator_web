"""本地 NER 术语提取的**主服务侧客户端**（keyword-gacha-ner，默认 CPU，零 API 花费）。

真正的推理在 ner_worker.py —— 必须是独立进程：主服务一启动就 import paddle，同一进程里
再 import torch 会因 CUDA DLL 冲突直接 WinError 127（manga-ocr 已踩过同一个坑）。

分派顺序由 term_extractor.py 决定：LLM 配了走 LLM，没配且模型在位走 NER；模型缺失或
worker 挂了就**一条都不产出**（旧的「句子模式」启发式已封存，它会灌垃圾进术语库）。
所有失败都只降级、不抛异常。

模型：neavo/keyword_gacha_multilingual_ner（ModernBERT，中英日韩，小说/游戏脚本语料微调）
标签只有四类 PER / LOC / ORG / PRD —— 出不了技能名与称号，这是模型结构决定的，不是调参问题。

为什么默认 CPU：本机 GPU 与安卓模拟器、Ollama 共用，只剩约 0.6GB 显存（见 start_local_ocr_gpu.bat
2026-10-15 记录），而本模型要 0.89GB。CPU 实测 4.0s/万字，够用且不和 PaddleOCR 抢显存。
用 LOCAL_OCR_NER_DEVICE=auto|cpu|cuda 覆盖。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

MODEL_DIR = Path(__file__).resolve().parent / "models" / "keyword_gacha_multilingual_ner"
MODEL_REQUIRED_FILES = ("config.json", "model.safetensors", "tokenizer.json")
# 首次请求含模型加载（实测 15.6s），单话推理只要几秒；留足余量但别让请求挂死。
WORKER_TIMEOUT_S = float(os.environ.get("LOCAL_OCR_NER_TIMEOUT", "180"))

_WORKER_LOCK = threading.RLock()
_WORKER: Any = None
_WORKER_ERROR = ""


def model_dir() -> Path:
    """模型目录；测试用 LOCAL_OCR_NER_MODEL_DIR 覆盖。"""
    override = str(os.environ.get("LOCAL_OCR_NER_MODEL_DIR") or "").strip()
    return Path(override) if override else MODEL_DIR


def _worker_alive() -> bool:
    proc = (_WORKER or {}).get("proc")
    return proc is not None and proc.poll() is None


def get_ner_status() -> dict[str, Any]:
    """不触发加载也不拉进程：只看文件是否齐备 + 上一次 worker 的报错。"""
    directory = model_dir()
    missing = [name for name in MODEL_REQUIRED_FILES if not (directory / name).is_file()]
    if missing:
        return {"available": False, "error": _WORKER_ERROR or f"NER 模型缺失：{directory} 下找不到 {', '.join(missing)}"}
    if _WORKER_ERROR and not _worker_alive():
        return {"available": False, "error": _WORKER_ERROR}
    return {"available": True, "error": ""}


def ner_engine_status() -> dict[str, Any]:
    """没配 LLM 时的引擎状态：模型在位报 ner，否则报 none 并说清原因。

    none = 这次提取不会产出任何候选（没有兜底算法可退），界面要据此说明「没提取到」。
    """
    status = get_ner_status()
    if status["available"]:
        return {"available": True, "engine": "ner", "error": "", "nerAvailable": True, "nerError": ""}
    return {"available": True, "engine": "none", "error": "", "nerAvailable": False, "nerError": status["error"]}


def _worker_env() -> dict[str, str]:
    """worker 的环境变量：剔除 paddle 留下的两样东西。

    - **PATH 里的 paddle/nvidia 目录**：paddle 导入时把自己的 DLL 目录塞进 PATH，worker 继承后
      torch 会先解析到 paddle 的不兼容 cudnn（WinError 127）。清掉才会用自己 lib/ 下的版本。
    - **OMP_NUM_THREADS**：paddle 导入时把它摁成 `1`（实测），worker 继承后 torch 只能单线程跑 ——
      同一段 1500 字韩文从 0.7s 变 26s（37 倍），而且完全看不出来是环境变量的锅。
    """
    pathsep = os.pathsep
    entries = [
        entry for entry in os.environ.get("PATH", "").split(pathsep)
        if entry and "paddle" not in entry.lower() and "\\nvidia\\" not in entry.lower()
    ]
    env = {**os.environ, "PATH": pathsep.join(entries), "PYTHONIOENCODING": "utf-8", "HF_HUB_OFFLINE": "1"}
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env.pop(name, None)
    return env


def get_worker() -> dict[str, Any]:
    """懒启动 worker（进程内单例）；worker 死掉时由调用方重建。"""
    global _WORKER, _WORKER_ERROR
    with _WORKER_LOCK:
        if _worker_alive():
            return _WORKER
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve().parent / "ner_worker.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_worker_env(),
        )
        ready = proc.stdout.readline() if proc.stdout else ""
        if '"ready"' not in ready:
            proc.kill()
            _WORKER = None
            _WORKER_ERROR = f"NER worker 启动失败：{ready[:200]}"
            raise RuntimeError(_WORKER_ERROR)
        _WORKER = {"proc": proc}
        print("[ner] 术语提取 worker 就绪（独立进程，规避 torch/paddle DLL 冲突）", flush=True)
        return _WORKER


def _roundtrip(payload: dict[str, Any]) -> dict[str, Any]:
    """一问一答。超时就杀掉 worker 让 readline 返回 EOF，避免整条请求线程挂死。"""
    global _WORKER, _WORKER_ERROR
    with _WORKER_LOCK:
        try:
            proc = get_worker()["proc"]
        except (RuntimeError, OSError) as exc:
            _WORKER_ERROR = str(exc)
            return {}
        timer = threading.Timer(WORKER_TIMEOUT_S, proc.kill)
        timer.start()
        try:
            proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            reply = proc.stdout.readline()
        except (BrokenPipeError, OSError) as exc:
            _WORKER = None
            _WORKER_ERROR = f"NER worker 通信失败：{exc}"
            return {}
        finally:
            timer.cancel()
        try:
            message = json.loads(reply) if reply else {}
        except json.JSONDecodeError:
            message = {}
        if not message:
            _WORKER = None
            _WORKER_ERROR = f"NER worker 无响应（{WORKER_TIMEOUT_S:.0f}s 内没回话）"
        elif message.get("error"):
            _WORKER_ERROR = f"NER 推理失败：{message['error']}"
        return message


def is_warm() -> bool:
    """worker 活着就等于模型已加载（进程是第一次推理时才拉起的）。"""
    return _worker_alive() and not _WORKER_ERROR


def warm_up() -> dict[str, Any]:
    """把 worker 拉起来并跑一句最小推理，提前吃掉模型加载（冷启动实测 10~45 秒）。

    首次提取如果含着这段加载，就会顶着扩展那边的超时预算跑；预热把这笔开销挪到
    「用户还在读第一页」的时候。永不抛异常，失败只回报原因。
    """
    status = get_ner_status()
    if not status["available"]:
        return {"warmed": False, "elapsedMs": 0, "error": status["error"]}
    started = time.monotonic()
    reply = _roundtrip({"blocks": [{"id": "warmup", "text": "김민수는 서울에 갔다."}]})
    elapsed = int((time.monotonic() - started) * 1000)
    if not reply:
        return {"warmed": False, "elapsedMs": elapsed, "error": _WORKER_ERROR or "NER worker 未回话"}
    if reply.get("error"):
        return {"warmed": False, "elapsedMs": elapsed, "error": f"NER 推理失败：{reply['error']}"}
    return {"warmed": True, "elapsedMs": elapsed, "error": ""}


def try_extract_ner_candidates(
    blocks: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]] | None:
    """模型可用且真出结果就返回 (候选, 统计)；否则 None，由调用方落回启发式。"""
    if not get_ner_status()["available"]:
        return None
    prepared = [
        {"id": str(block.get("id") or "").strip(), "text": str(block.get("text") or "")}
        for block in blocks if str(block.get("id") or "").strip()
    ]
    if not prepared:
        return None
    reply = _roundtrip({"blocks": prepared})
    candidates = reply.get("candidates") or []
    if not candidates:
        return None
    return candidates, dict(reply.get("stats") or {})
