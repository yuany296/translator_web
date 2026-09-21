from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


def test_det_and_rec_use_independent_predict_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    """检测与识别是不同模型：一个在跑识别时另一个必须能同时跑检测。"""
    import server

    monkeypatch.setattr(server, "_ocr_det_semaphore", threading.Semaphore(1))
    monkeypatch.setattr(server, "_ocr_rec_semaphore", threading.Semaphore(1))
    order: list[str] = []

    def hold(kind: str, name: str, seconds: float) -> None:
        with server.predict_guard(kind):
            order.append(f"{name}-start")
            time.sleep(seconds)
            order.append(f"{name}-end")

    detect = threading.Thread(target=hold, args=("det", "det", 0.25))
    recognize = threading.Thread(target=hold, args=("rec", "rec", 0.0))
    detect.start()
    time.sleep(0.06)
    recognize.start()
    detect.join()
    recognize.join()

    assert order == ["det-start", "rec-start", "rec-end", "det-end"], "det 与 rec 必须能重叠执行"


def test_same_kind_is_still_serialized(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "_ocr_rec_semaphore", threading.Semaphore(1))
    order: list[str] = []
    guards: dict[str, object] = {}

    def hold(name: str, seconds: float) -> None:
        guard = server.predict_guard("rec")
        guards[name] = guard
        with guard:
            order.append(f"{name}-start")
            time.sleep(seconds)
            order.append(f"{name}-end")

    first = threading.Thread(target=hold, args=("a", 0.2))
    first.start()
    time.sleep(0.05)
    second = threading.Thread(target=hold, args=("b", 0.0))
    second.start()
    first.join()
    second.join()

    assert order == ["a-start", "a-end", "b-start", "b-end"]
    assert guards["b"].wait_ms >= 50


def test_phase_names_keep_det_and_rec_separate() -> None:
    """带后缀的阶段名不能与聚合的 predict/queueWait 重复计数。"""
    import server

    det = server.predict_guard("det")
    rec = server.predict_guard("rec")
    combined = server.predict_guard()

    assert (det.wait_phase, det.hold_phase) == ("queueWaitDet", "predictDet")
    assert (rec.wait_phase, rec.hold_phase) == ("queueWaitRec", "predictRec")
    assert (combined.wait_phase, combined.hold_phase) == ("queueWait", "predict")


def test_warmup_loads_detection_and_each_language(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    calls: list[str] = []
    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    monkeypatch.setattr(server, "CV2_AVAILABLE", True)
    monkeypatch.setenv("LOCAL_OCR_WARMUP_LANGS", "japan,korean")
    monkeypatch.setattr(server, "_run_detection_only", lambda *_args, **_kwargs: calls.append("det") or [])
    monkeypatch.setattr(
        server,
        "recognize_candidate_rows",
        lambda _rows, languages: calls.append(f"rec:{languages[0]}") or [],
    )

    state = server.warm_up_ocr_models()

    assert state["ok"] is True
    assert calls == ["det", "rec:japan", "rec:korean"]
    assert state["langs"] == ["japan", "korean"]
    assert isinstance(state["ms"], float)
    assert server.ocr_warmup_state == state


def test_warmup_failure_is_reported_and_contained(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    monkeypatch.setattr(server, "CV2_AVAILABLE", True)

    def boom(*_args, **_kwargs):
        raise RuntimeError("model download failed")

    monkeypatch.setattr(server, "_run_detection_only", boom)

    state = server.warm_up_ocr_models()

    assert state["ok"] is False
    assert "model download failed" in state["error"]


def test_warmup_skips_without_paddle(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", RuntimeError("no paddle"))

    state = server.warm_up_ocr_models()

    assert state["ok"] is False
    assert state["reason"] == "paddle or cv2 unavailable"


def test_health_reports_warmup_state(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "ocr_warmup_state", {"ok": True, "ms": 1.0, "langs": ["japan"]})
    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", RuntimeError("paddle missing"))

    health = server.health()

    assert health["warmup"] == {"ok": True, "ms": 1.0, "langs": ["japan"]}
