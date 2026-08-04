from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))

import server


@pytest.mark.parametrize(
    ("language", "model"),
    [
        ("japan", "japan_PP-OCRv3_mobile_rec"),
        ("korean", "korean_PP-OCRv5_mobile_rec"),
        ("en", "en_PP-OCRv5_mobile_rec"),
        ("ch", "PP-OCRv5_server_rec"),
        ("chinese_cht", "PP-OCRv5_server_rec"),
    ],
)
def test_explicit_ocr_languages_use_supported_recognition_models(
    language: str, model: str
) -> None:
    assert server.runtime.normalize_lang(language) == language
    assert server.runtime.get_recognition_model_name(language) == model


def test_unknown_ocr_language_falls_back_to_auto() -> None:
    assert server.runtime.normalize_lang("unsupported") == "auto"


def test_language_quality_counts_the_expected_script() -> None:
    assert server.runtime.count_target_script_chars("Hello 世界", "en") == 5
    assert server.runtime.count_target_script_chars("Hello 世界", "ch") == 2
    assert server.runtime.count_target_script_chars("かな漢字", "japan") == 4
    assert server.runtime.count_target_script_chars("한글ABC", "korean") == 2
