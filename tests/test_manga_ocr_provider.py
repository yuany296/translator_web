from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


@pytest.fixture(autouse=True)
def _clean_engine_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LOCAL_OCR_REC_ENGINE", raising=False)
    monkeypatch.delenv("LOCAL_OCR_MANGA_OCR_MODEL", raising=False)
    yield


def test_engine_only_applies_to_japan() -> None:
    import server

    assert server.manga_ocr_engine_enabled({"rec_engine": "manga_ocr"}, "japan") is True
    assert server.manga_ocr_engine_enabled({"rec_engine": "manga_ocr"}, "korean") is False
    assert server.manga_ocr_engine_enabled({"rec_engine": "manga_ocr"}, "auto") is False
    assert server.manga_ocr_engine_enabled({"rec_engine": "paddle"}, "japan") is False
    assert server.manga_ocr_engine_enabled({}, "japan") is False


def test_env_default_and_param_override(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_REC_ENGINE", "manga_ocr")
    assert server.manga_ocr_engine_enabled({}, "japan") is True
    assert server.manga_ocr_engine_enabled({"rec_engine": "paddle"}, "japan") is False


def test_recognize_rows_strips_image_and_keeps_candidate_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    calls: list[list[np.ndarray]] = []

    def fake_predict_batch(images: list[np.ndarray]) -> list[tuple[str, float]]:
        calls.append(images)
        assert all(image.ndim == 3 for image in images)
        return [("スキャンダルで", 0.97)] * len(images)

    monkeypatch.setattr(server.runtime, "_manga_ocr_predict_batch", fake_predict_batch)
    rows = [
        {"detection_index": 0, "region_id": "region-0000", "orientation": 0, "variant": "original", "image": np.zeros((60, 24, 3), dtype=np.uint8)},
        {"detection_index": 1, "region_id": "region-0001", "orientation": 0, "variant": "original", "image": None},
        {"detection_index": 2, "region_id": "region-0002", "orientation": 0, "variant": "original", "image": np.zeros((40, 18, 3), dtype=np.uint8)},
    ]
    output = server.recognize_rows_with_manga_ocr(rows)
    assert len(output) == 3
    assert all("image" not in item for item in output)
    assert output[0]["text"] == "スキャンダルで"
    assert output[0]["score"] == pytest.approx(0.97)
    assert output[0]["lang"] == "japan"
    assert output[1]["text"] == "" and output[1]["score"] == 0.0
    assert len(calls) == 1 and len(calls[0]) == 2


def test_worker_env_strips_paddle_and_nvidia_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("PATH", os.pathsep.join([
        "C:\\tools", "C:\\paddle\\libs", "C:\\site-packages\\paddle\\base", "C:\\site-packages\\cv2\\..\\..\\x64\\vc14\\bin", "D:\\nvidia\\bin",
    ]))
    env = server._worker_env()
    entries = env["PATH"].split(os.pathsep)
    assert all("paddle" not in entry.lower() and "\\nvidia\\" not in entry.lower() for entry in entries)
    assert env["HF_HUB_OFFLINE"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8"


def test_recognize_rows_empty_input() -> None:
    import server

    assert server.recognize_rows_with_manga_ocr([]) == []


def test_real_client_loads_and_reads_a_vertical_column() -> None:
    """模型已落盘（HF 缓存），在**子进程**里做一次真识别冒烟。

    torch 与 paddle 的 CUDA DLL 在 Windows 上互相冲突，绝不能在 pytest 主进程里
    import torch（会波及后续 paddle 测试）；子进程按生产顺序（paddle 先加载、
    torch 懒加载）走完整 _manga_ocr_predict。
    """
    import json
    import subprocess
    import sys
    import tempfile

    # 千万不要在这里 importorskip("transformers")：transformers 5.x 顶层就 import torch，
    # 会把 torch 拉进 pytest 主进程——文件运行时前面用例已加载 paddle，DLL 冲突当场爆炸。
    # torch/transformers 只在子进程与 worker 里出现。
    script = (
        "import json, sys;"
        "sys.path.insert(0, r'{root}');"
        "import numpy as np;"
        "import server;"  # paddle 先加载（生产同序）
        "image = np.full((160, 32, 3), 255, dtype=np.uint8);"
        "image[:, 6:14] = 0;"
        "text, confidence = server._manga_ocr_predict(image);"
        "print(json.dumps({{'text': text, 'confidence': confidence}}))"
    ).format(root=str(ROOT / "local-ocr-service"))
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(ROOT / "local-ocr-service"),
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        dump = Path(tempfile.gettempdir()) / "manga_ocr_smoke_stderr.log"
        dump.write_text(result.stderr, encoding="utf-8", errors="replace")
        assert False, f"child failed, full stderr -> {dump}: {result.stderr[-400:]}"
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert isinstance(payload["text"], str)
    assert 0.0 <= payload["confidence"] <= 1.0
