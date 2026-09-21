from __future__ import annotations

import contextvars

from ..dependencies import runtime

# 单次 /ocr 请求的分阶段计时。计时是纯观测设施：任何记录失败都不得影响 OCR 结果，
# 所以所有公开入口都对异常做静默兜底。
_ACTIVE: contextvars.ContextVar = contextvars.ContextVar("mt_ocr_request_timings", default=None)
_RECENT: list[dict[str, runtime.Any]] = []

# 嵌套阶段：这些打点在 detect*/recognize* 的作用域内部，直接相加会超过总时长，
# 算「未计入的等待」时必须排除，否则 unaccountedMs 永远被夹成 0。
_NESTED_PHASES = frozenset({
    "queueWait", "queueWaitDet", "queueWaitRec",
    "predict", "predictDet", "predictRec",
})


class OcrRequestTimings:
    """收集一次请求的各阶段毫秒数。"""

    def __init__(self) -> None:
        self.phases: dict[str, float] = {}
        self.last = runtime.time.perf_counter()

    def now(self) -> float:
        return runtime.time.perf_counter()

    def add(self, name: str, ms: float) -> None:
        value = max(0.0, float(ms or 0.0))
        key = str(name or "unnamed")
        self.phases[key] = self.phases.get(key, 0.0) + value
        self.last = runtime.time.perf_counter()

    def snapshot(self, total_ms: float | None = None) -> dict[str, runtime.Any]:
        phases = {name: round(value, 1) for name, value in self.phases.items()}
        payload: dict[str, runtime.Any] = {"phases": phases}
        if total_ms is not None:
            total = max(0.0, float(total_ms or 0.0))
            accounted = sum(value for name, value in phases.items() if name not in _NESTED_PHASES)
            payload["totalMs"] = round(total, 1)
            # 各阶段之和通常略小于总时长：线程切换、图像解码等零散工作不单独打点。
            payload["unaccountedMs"] = round(max(0.0, total - accounted), 1)
        return payload


class OcrTimingScope:
    """`with runtime.ocr_request_timings_scope("name"):` 形式的阶段计时。"""

    def __init__(self, timings: OcrRequestTimings | None, name: str) -> None:
        self.timings = timings
        self.name = name
        self.started = 0.0

    def __enter__(self) -> "OcrTimingScope":
        if self.timings is not None:
            self.started = self.timings.now()
        return self

    def __exit__(self, exc_type: runtime.Any, exc: runtime.Any, traceback: runtime.Any) -> bool:
        if self.timings is not None:
            self.timings.add(self.name, (self.timings.now() - self.started) * 1000.0)
        return False


def begin() -> OcrRequestTimings:
    timings = OcrRequestTimings()
    _ACTIVE.set(timings)
    return timings


def current() -> OcrRequestTimings | None:
    return _ACTIVE.get()


def now() -> float:
    return runtime.time.perf_counter()


def add(name: str, ms: float) -> None:
    try:
        timings = _ACTIVE.get()
        if timings is not None:
            timings.add(name, ms)
    except Exception:  # noqa: BLE001 - 计时失败不得影响 OCR
        return


def scope(name: str) -> OcrTimingScope:
    try:
        return OcrTimingScope(_ACTIVE.get(), str(name))
    except Exception:  # noqa: BLE001 - 计时失败不得影响 OCR
        return OcrTimingScope(None, str(name))


def phase(name: str) -> None:
    """记录“自上一个计时点以来”的耗时。"""
    try:
        timings = _ACTIVE.get()
        if timings is not None:
            timings.add(name, (timings.now() - timings.last) * 1000.0)
    except Exception:  # noqa: BLE001 - 计时失败不得影响 OCR
        return


def finish(timings: OcrRequestTimings | None, total_ms: float | None = None) -> dict[str, runtime.Any]:
    payload = timings.snapshot(total_ms) if timings is not None else {"phases": {}}
    try:
        _ACTIVE.set(None)
    except Exception:  # noqa: BLE001 - 计时失败不得影响 OCR
        pass
    try:
        _RECENT.append(dict(payload))
        del _RECENT[:max(0, len(_RECENT) - int(runtime.OCR_TIMINGS_WINDOW))]
    except Exception:  # noqa: BLE001 - 计时失败不得影响 OCR
        pass
    return payload


def recent() -> list[dict[str, runtime.Any]]:
    return [dict(item) for item in _RECENT]


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    index = int(round((len(ordered) - 1) * min(1.0, max(0.0, ratio))))
    return ordered[index]


def summarize() -> dict[str, runtime.Any]:
    """最近 N 次请求的分阶段 p50/p95，用于 /ocr/timings。"""
    samples = recent()
    totals = [float(item.get("totalMs") or 0.0) for item in samples]
    phase_names: list[str] = []
    for item in samples:
        for name in (item.get("phases") or {}):
            if name not in phase_names:
                phase_names.append(name)
    phases: dict[str, runtime.Any] = {}
    for name in phase_names:
        values = [float((item.get("phases") or {}).get(name) or 0.0) for item in samples]
        phases[name] = {
            "p50": round(percentile(values, 0.5), 1),
            "p95": round(percentile(values, 0.95), 1),
            "max": round(max(values), 1) if values else 0.0,
        }
    return {
        "ok": True,
        "count": len(samples),
        "window": int(runtime.OCR_TIMINGS_WINDOW),
        "totalMs": {
            "p50": round(percentile(totals, 0.5), 1),
            "p95": round(percentile(totals, 0.95), 1),
            "max": round(max(totals), 1) if totals else 0.0,
        },
        "phases": phases,
        "last": samples[-1] if samples else None,
    }


def reset() -> None:
    del _RECENT[:]


runtime.OcrRequestTimings = OcrRequestTimings
runtime.OcrTimingScope = OcrTimingScope
runtime.ocr_request_timings_begin = begin
runtime.ocr_request_timings_current = current
runtime.ocr_request_timings_now = now
runtime.ocr_request_timings_add = add
runtime.ocr_request_timings_scope = scope
runtime.ocr_request_timings_phase = phase
runtime.ocr_request_timings_finish = finish
runtime.ocr_request_timings_recent = recent
runtime.ocr_request_timings_summarize = summarize
runtime.ocr_request_timings_reset = reset
runtime.ocr_request_timings_percentile = percentile
