from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


def _detection(polygon_index: int) -> dict:
    return {
        "polygon": [[10.0, 10.0 + polygon_index], [90.0, 10.0 + polygon_index], [90.0, 40.0 + polygon_index], [10.0, 40.0 + polygon_index]],
        "box": {"left": 10.0, "top": 10.0 + polygon_index, "width": 80.0, "height": 30.0},
        "det_score": 0.95,
        "rotation_deg": 0.0,
    }


def _candidate_rows(count: int) -> list[dict]:
    return [
        {"detection_index": index, "region_id": f"region-{index:04d}", "orientation": 0, "variant": "original", "image": None}
        for index in range(count)
    ]


def _recognized(index: int, text: str, score: float, lang: str = "japan") -> dict:
    return {"detection_index": index, "text": text, "score": score, "lang": lang, "orientation": 0}


def test_recovery_detection_defaults_to_always(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_RECOVERY_DETECT", raising=False)
    assert server.should_run_recovery_detection([]) is True
    assert server.should_run_recovery_detection([_detection(index) for index in range(40)]) is True


def test_recovery_detection_on_demand_skips_text_rich_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setenv("LOCAL_OCR_RECOVERY_DETECT", "on-demand")
    monkeypatch.delenv("LOCAL_OCR_RECOVERY_MIN_PRIMARY", raising=False)
    assert server.should_run_recovery_detection([_detection(index) for index in range(7)]) is True
    assert server.should_run_recovery_detection([_detection(index) for index in range(8)]) is False

    monkeypatch.setenv("LOCAL_OCR_RECOVERY_MIN_PRIMARY", "2")
    assert server.should_run_recovery_detection([_detection(index) for index in range(3)]) is False


def test_second_language_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_AUTO_LANG_SECOND_PASS", raising=False)
    assert server.second_language_on_demand() is False
    monkeypatch.setenv("LOCAL_OCR_AUTO_LANG_SECOND_PASS", "1")
    assert server.second_language_on_demand() is False
    monkeypatch.setenv("LOCAL_OCR_AUTO_LANG_SECOND_PASS", "0")
    assert server.second_language_on_demand() is True


def test_second_language_only_fills_weak_crops(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_AUTO_LANG_FULL_PAGE_RATIO", raising=False)
    rows = _candidate_rows(5)
    strong = [_recognized(index, "こんにちは", 0.95) for index in range(4)]
    strong.append(_recognized(4, "hello", 0.4))

    selected = server.select_rows_needing_second_language(strong, rows, "japan")

    assert [row["detection_index"] for row in selected] == [4], "只有弱框需要第二语言"


def test_second_language_falls_back_to_whole_page_when_primary_language_is_wrong(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_AUTO_LANG_FULL_PAGE_RATIO", raising=False)
    rows = _candidate_rows(5)
    # 主语言整页都识别不出目标文字：说明语言选错了，必须整页补跑。
    weak = [_recognized(index, "hello", 0.2) for index in range(5)]

    selected = server.select_rows_needing_second_language(weak, rows, "japan")

    assert len(selected) == len(rows)


def test_second_language_skips_clean_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_AUTO_LANG_FULL_PAGE_RATIO", raising=False)
    rows = _candidate_rows(3)
    clean = [_recognized(index, "こんにちは", 0.98) for index in range(3)]

    assert server.select_rows_needing_second_language(clean, rows, "japan") == []


def test_cleaned_image_keeps_png_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """清理图格式默认不变（PNG），jpeg 需要显式打开。"""
    import server

    monkeypatch.delenv("LOCAL_OCR_CLEANED_IMAGE_FORMAT", raising=False)
    assert server.cleaned_image_format() == "png"
    monkeypatch.setenv("LOCAL_OCR_CLEANED_IMAGE_FORMAT", "jpeg")
    assert server.cleaned_image_format() == "jpeg"


def test_debug_vis_defaults_to_jpeg_and_can_be_forced_to_png(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.delenv("LOCAL_OCR_DEBUG_VIS_FORMAT", raising=False)
    assert server.debug_vis_format() == "jpeg"
    monkeypatch.setenv("LOCAL_OCR_DEBUG_VIS_FORMAT", "png")
    assert server.debug_vis_format() == "png"
