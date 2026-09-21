from __future__ import annotations

from ..dependencies import runtime

# 阶段名：默认（整条 PaddleOCR 客户端）沿用 predict/queueWait；
# 只做检测或只做识别的调用点用带后缀的名字，避免与聚合值重复计数。
_PHASE_NAMES = {
    'det': ('queueWaitDet', 'predictDet'),
    'rec': ('queueWaitRec', 'predictRec'),
}


class PredictGuard:
    """把 Paddle 推理限制在有限并发内，并记录「排队」与「占用」两段耗时。

    推理之外的工作（base64 解码、透视裁剪、外观分析、清理图、debug 写盘）不再被串行化：
    这些工作此前全部排在同一把全局锁里，导致第 2、3 页只能干等第 1 页写完 debug 产物。
    det 与 rec 使用各自独立的槽位：检测与识别是不同模型，可以重叠执行。
    """

    def __init__(self, semaphore: runtime.Any, kind: str = '') -> None:
        self.semaphore = semaphore
        self.kind = kind
        self.wait_ms = 0.0
        self.hold_ms = 0.0
        self.hold_started = 0.0

    def __enter__(self) -> "PredictGuard":
        started = runtime.time.perf_counter()
        self.semaphore.acquire()
        self.wait_ms = (runtime.time.perf_counter() - started) * 1000.0
        runtime.ocr_request_timings_add(self.wait_phase, self.wait_ms)
        self.hold_started = runtime.time.perf_counter()
        return self

    def __exit__(self, exc_type: runtime.Any, exc: runtime.Any, traceback: runtime.Any) -> bool:
        self.hold_ms = (runtime.time.perf_counter() - self.hold_started) * 1000.0
        runtime.ocr_request_timings_add(self.hold_phase, self.hold_ms)
        self.semaphore.release()
        return False

    @property
    def wait_phase(self) -> str:
        return _PHASE_NAMES.get(self.kind, ('queueWait', 'predict'))[0]

    @property
    def hold_phase(self) -> str:
        return _PHASE_NAMES.get(self.kind, ('queueWait', 'predict'))[1]


def semaphore_for_kind(kind: str) -> runtime.Any:
    if kind == 'det':
        return runtime._ocr_det_semaphore
    if kind == 'rec':
        return runtime._ocr_rec_semaphore
    return runtime._ocr_predict_semaphore


def predict_guard(kind: str = '') -> PredictGuard:
    """kind: '' 整条 PaddleOCR 客户端；'det' 仅检测；'rec' 仅识别。"""
    normalized = str(kind or '')
    return PredictGuard(semaphore_for_kind(normalized), normalized)


def predict_concurrency() -> int:
    return max(1, int(getattr(runtime, 'OCR_PREDICT_CONCURRENCY', 1) or 1))


runtime.PredictGuard = PredictGuard
runtime.predict_guard = predict_guard
runtime.predict_concurrency = predict_concurrency
runtime.semaphore_for_kind = semaphore_for_kind
