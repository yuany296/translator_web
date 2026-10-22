from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


def _image(height: int, width: int) -> np.ndarray:
    return np.full((height, width, 3), 200, dtype=np.uint8)


@pytest.fixture(autouse=True)
def _default_preprocess(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LOCAL_OCR_REC_PREPROCESS", raising=False)
    monkeypatch.delenv("LOCAL_OCR_REC_BORDER_PX", raising=False)
    monkeypatch.delenv("LOCAL_OCR_REC_UPSCALE_SKIP_MAX_SHORT_SIDE", raising=False)
    yield


def test_tiny_fragment_short_side_is_not_upscaled(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    # 几何门：短边 ≤11px 的碎条放大后实测 5/5 变差，保持原样。
    source = _image(60, 9)
    assert server.prepare_recognition_image(source) is source


def test_skip_gate_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_REC_UPSCALE_SKIP_MAX_SHORT_SIDE", "0")
    prepared = server.prepare_recognition_image(_image(60, 9))
    # 上限 2x：9px → 18px。
    assert prepared.shape == (120, 18, 3)


def test_small_short_side_is_upscaled(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    prepared = server.prepare_recognition_image(_image(164, 26))
    # 26px 列厚精确放大到模型原生输入高 48（LANCZOS），默认无边框。
    assert prepared.shape[1] == 48
    assert prepared.shape[0] == round(164 * 48 / 26)
    assert prepared.dtype == np.uint8


def test_split_column_is_capped_at_two_x() -> None:
    import server

    # 用户定版：放大上限 2x——列拆分产出的 18px 窄列到 36px 为止，不过度插值。
    prepared = server.prepare_recognition_image(_image(300, 18))
    assert prepared.shape == (600, 36, 3)


def test_large_short_side_is_unchanged() -> None:
    import server

    source = _image(120, 80)
    assert server.prepare_recognition_image(source) is source


def test_border_knob_replicates_edge_color(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_REC_BORDER_PX", "8")
    source = np.zeros((60, 90, 3), dtype=np.uint8)
    source[:, :, 0] = 77
    prepared = server.prepare_recognition_image(source)
    # 复制边沿用原边缘颜色（B 通道 77），不是假设的白底。
    assert int(prepared[8 + 5, 0, 0]) == 77
    assert prepared.shape[0] == 60 + 2 * 8
    assert prepared.shape[1] == 90 + 2 * 8


def test_disabled_by_env_returns_image_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_REC_PREPROCESS", "off")
    source = _image(164, 26)
    assert server.prepare_recognition_image(source) is source


def test_env_can_retune_upscale_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_REC_UPSCALE_MIN_SHORT_SIDE", "0")
    source = _image(120, 80)
    assert server.prepare_recognition_image(source) is source


def test_none_image_passes_through() -> None:
    import server

    assert server.prepare_recognition_image(None) is None
