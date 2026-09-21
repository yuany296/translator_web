from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


def _data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(b"fake-image-bytes").decode("ascii")


def _fake_run_ocr(image_bytes: bytes, lang: str, mode: str, params: dict, debug: bool, debug_id: str, seam_rows=None):
    """替代真实 Paddle 推理：只验证计时设施接进了 /ocr 关键路径。"""
    import time

    import server

    assert image_bytes == b"fake-image-bytes"
    assert server.ocr_request_timings_current() is not None
    with server.ocr_request_timings_scope("pipelineFake"):
        time.sleep(0.03)
    # 推理槽位：真实实现里每个 client.predict 都会走这里。
    with server.predict_guard():
        pass
    return {
        "items": [], "boxes": [], "regions": [], "detectedRegions": [], "recognizedRegions": [],
        "semanticBlocks": [], "geometryReliability": "detected", "imageWidth": 10, "imageHeight": 20,
        "counts": {"variants": 1, "langs": 2}, "rawItems": [], "debug": {},
    }


def test_timings_accumulate_and_report_percentiles() -> None:
    import server

    server.ocr_request_timings_reset()
    timings = server.ocr_request_timings_begin()
    with server.ocr_request_timings_scope("detect"):
        pass
    server.ocr_request_timings_add("detect", 10)
    payload = server.ocr_request_timings_finish(timings, 50)

    assert payload["totalMs"] == 50
    assert payload["phases"]["detect"] >= 10
    assert payload["unaccountedMs"] == pytest.approx(max(0.0, 50 - payload["phases"]["detect"]), abs=0.1)

    summary = server.ocr_request_timings_summarize()
    assert summary["count"] == 1
    assert summary["phases"]["detect"]["p50"] >= 10
    assert summary["phases"]["detect"]["p95"] >= 10
    assert summary["last"]["totalMs"] == 50


def test_nested_predict_phases_do_not_break_unaccounted_math(monkeypatch: pytest.MonkeyPatch) -> None:
    """predict 类打点在 detect/recognize 作用域内部，不能重复计入总账。"""
    import threading
    import time

    import server

    monkeypatch.setattr(server, "_ocr_det_semaphore", threading.Semaphore(1))
    timings = server.ocr_request_timings_begin()
    with server.ocr_request_timings_scope("detectPrimary"):
        with server.predict_guard("det"):
            time.sleep(0.1)
    payload = server.ocr_request_timings_finish(timings, 150)

    assert payload["phases"]["predictDet"] >= 90
    assert payload["phases"]["detectPrimary"] >= 90
    # detectPrimary 只算一次；若把 predictDet 也计入，总和会超过总时长而被夹成 0。
    assert payload["unaccountedMs"] == pytest.approx(50, abs=15)


def test_timings_are_optional_and_never_raise() -> None:
    import server

    server.ocr_request_timings_finish(None, None)
    assert server.ocr_request_timings_current() is None
    server.ocr_request_timings_add("orphan", 5)
    with server.ocr_request_timings_scope("orphan"):
        pass
    server.ocr_request_timings_phase("orphan")
    assert server.ocr_request_timings_current() is None
    assert server.ocr_request_timings_finish(None, 12) == {"phases": {}}


def test_recent_window_is_trimmed(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "OCR_TIMINGS_WINDOW", 3)
    server.ocr_request_timings_reset()
    for index in range(5):
        timings = server.ocr_request_timings_begin()
        server.ocr_request_timings_add("stub", index)
        server.ocr_request_timings_finish(timings, index)

    summary = server.ocr_request_timings_summarize()
    assert summary["count"] == 3
    assert summary["window"] == 3


def test_ocr_response_carries_decode_queue_and_pipeline_phases(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "run_ocr", _fake_run_ocr)
    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    server.ocr_request_timings_reset()

    response = asyncio.run(server.ocr(server.OcrRequest(image=_data_url(), lang="korean", mode="fast")))

    assert response["ocrGeometryVersion"] == server.OCR_GEOMETRY_CONTRACT_VERSION
    timings = response["timings"]
    # 单位必须是毫秒：stub 里 sleep 了 30ms，totalMs 不能小得像秒。
    assert timings["totalMs"] >= 25, timings
    for phase in ("decode", "pipelineFake", "queueWait", "predict"):
        assert phase in timings["phases"], phase
    assert timings["phases"]["pipelineFake"] > 0
    assert timings["unaccountedMs"] >= 0
    assert timings["unaccountedMs"] <= timings["totalMs"]

    summary = server.ocr_timings()
    assert summary["ok"] is True
    assert summary["count"] == 1
    assert summary["phases"]["pipelineFake"]["p50"] >= 0


def test_geometry_mismatch_is_rejected_before_timings_start(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    server.ocr_request_timings_reset()

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.ocr(server.OcrRequest(
            image=_data_url(), lang="korean", mode="fast", ocr_geometry_version="stale-contract",
        )))

    assert error.value.status_code == 409
    assert server.ocr_request_timings_summarize()["count"] == 0


def test_predict_guard_serializes_inference_and_records_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    """只有一个推理槽位时第二个请求必须等第一个跑完（不再有全局大锁，只锁 predict）。"""
    import threading
    import time

    import server

    monkeypatch.setattr(server, "_ocr_predict_semaphore", threading.Semaphore(1))
    guards: dict[str, object] = {}
    order: list[str] = []

    def worker(name: str, hold: float) -> None:
        guard = server.predict_guard()
        guards[name] = guard
        with guard:
            order.append(f"{name}-start")
            time.sleep(hold)
            order.append(f"{name}-end")

    first = threading.Thread(target=worker, args=("a", 0.2))
    first.start()
    time.sleep(0.05)
    second = threading.Thread(target=worker, args=("b", 0.0))
    second.start()
    first.join()
    second.join()

    assert order == ["a-start", "a-end", "b-start", "b-end"]
    assert guards["a"].hold_ms >= 180
    assert guards["b"].wait_ms >= 50
    assert server.predict_concurrency() == 1


def _debug_writer_recorder(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """把四类 debug 产物写入替换成记录器，避免测试真的落盘。"""
    import server

    calls: list[str] = []

    def record(name: str):
        def writer(*_args, **_kwargs):
            calls.append(name)
            return f"/tmp/{name}.png"
        return writer

    monkeypatch.setattr(server, "_run_slice_ocr_pipeline", lambda *_args, **_kwargs: {"items": []})
    monkeypatch.setattr(server, "save_debug_input", record("input"))
    monkeypatch.setattr(server, "save_service_plugin_input", record("plugin_input"))
    monkeypatch.setattr(server, "save_service_vis", record("vis"))
    monkeypatch.setattr(server, "save_service_result_json", record("result_json"))
    return calls


def test_debug_artifacts_are_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认不再写盘：每页 3 张整页 PNG 的编码开销曾经是固定成本。"""
    import server

    calls = _debug_writer_recorder(monkeypatch)
    monkeypatch.delenv("LOCAL_OCR_DEBUG_ALWAYS", raising=False)

    result = server.run_fast_perspective_ocr(b"image", "korean", {}, False, "pytest-default")

    assert calls == []
    assert result["debug"] == {}


def test_debug_artifacts_still_written_when_explicitly_requested(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    calls = _debug_writer_recorder(monkeypatch)
    monkeypatch.delenv("LOCAL_OCR_DEBUG_ALWAYS", raising=False)

    by_request = server.run_fast_perspective_ocr(b"image", "korean", {}, True, "pytest-request-debug")
    # 同一张原图只写一份：input / plugin_input 不再是两张整页 PNG。
    assert calls == ["plugin_input", "vis", "result_json"]
    assert by_request["debug"]["input"] == by_request["debug"]["plugin_input"]
    assert by_request["debug"]["vis"].endswith((".jpg", ".png"))

    calls.clear()
    monkeypatch.setenv("LOCAL_OCR_DEBUG_ALWAYS", "1")
    by_env = server.run_fast_perspective_ocr(b"image", "korean", {}, False, "pytest-env-debug")
    assert calls == ["plugin_input", "vis", "result_json"]
    assert by_env["debug"]

    calls.clear()
    monkeypatch.setenv("LOCAL_OCR_DEBUG_ALWAYS", "0")
    server.run_fast_perspective_ocr(b"image", "korean", {}, False, "pytest-env-off")
    assert calls == []

