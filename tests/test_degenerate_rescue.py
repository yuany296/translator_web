"""识别退化救援（pipeline/degenerate_rescue.py）的行为钉子。

现场（Lezhin 韩漫）：气泡「응?」被 korean_PP-OCRv5_mobile_rec 读成 `"$?"`（0.785），
按符号噪声丢弃 → 气泡原文裸露；备用模型 korean_PP-OCRv3_mobile_rec 读出 `"응?"`（0.718）。
这里钉住：什么时候判定"退化"、什么时候允许替换、以及替换只发生在同一 crop 上。
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVICE = ROOT / "local-ocr-service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

from ocr_service import api as _api  # noqa: E402,F401  # 装配期注册 runtime.* 函数
from ocr_service.runtime import runtime  # noqa: E402


def test_alternate_model_only_for_korean():
    assert runtime.alternate_recognition_model_name("korean") == "korean_PP-OCRv3_mobile_rec"
    assert runtime.alternate_recognition_model_name("japan") == ""
    assert runtime.alternate_recognition_model_name("auto") == ""


def test_needs_rescue_matches_final_filter():
    # 空 / 纯符号 / 低于识别下限 —— 与 `_run_slice_ocr_pipeline` 的最终筛同一口径。
    assert runtime.needs_degenerate_rescue({"text": "$?", "score": 0.785}, 0.4) is True
    assert runtime.needs_degenerate_rescue({"text": "\\", "score": 0.944}, 0.4) is True
    assert runtime.needs_degenerate_rescue({"text": "", "score": 0.9}, 0.4) is True
    assert runtime.needs_degenerate_rescue({"text": "응?", "score": 0.3}, 0.4) is True
    # 有实打实文字的（即便分数不高）不算退化：救援只服务"坏文本"，不重翻低分正文。
    assert runtime.needs_degenerate_rescue({"text": "응?", "score": 0.718}, 0.4) is False
    assert runtime.needs_degenerate_rescue({"text": "안 추워요?", "score": 0.9}, 0.4) is False


def test_select_rescue_requires_target_script_and_floor():
    # 实打实韩文 + 过下限 → 允许替换（分数可以低于原结果的 0.785）。
    korean = {"text": "응?", "score": 0.718, "lang": "korean", "variant": "degenerate_rescue"}
    assert runtime.select_degenerate_rescue([korean], 0.4) == korean
    # 仍然没有目标文字（又读成符号）→ 不替换。
    assert runtime.select_degenerate_rescue([{"text": "$?", "score": 0.9, "lang": "korean"}], 0.4) is None
    # 低于识别下限 → 不替换（连识别本身都不可信）。
    assert runtime.select_degenerate_rescue([{"text": "응?", "score": 0.2, "lang": "korean"}], 0.4) is None
    # 英文/数字混进来但没有韩文 → japan 之外的脚本不算数（韩文条目只认 Hangul）。
    assert runtime.select_degenerate_rescue([{"text": "abc", "score": 0.99, "lang": "korean"}], 0.4) is None


def test_rescue_replaces_best_row_and_counts():
    best = {0: {"text": "$?", "score": 0.785, "lang": "korean", "orientation": 0, "detection_index": 0}}
    candidates = [{"detection_index": 0, "orientation": 0, "variant": "perspective_fast_raw", "image": object()},
                  {"detection_index": 1, "orientation": 0, "variant": "perspective_fast_raw", "image": object()}]
    recognized = [dict(best[0])]
    calls = []

    def fake_recognize(rows, lang):
        calls.append(([row["detection_index"] for row in rows], lang))
        return [{"detection_index": row["detection_index"], "orientation": 0, "text": "응?", "score": 0.718,
                 "lang": lang, "variant": "degenerate_rescue"} for row in rows]

    original = runtime.recognize_rows_with_alternate_model
    runtime.recognize_rows_with_alternate_model = fake_recognize
    try:
        added = runtime.rescue_degenerate_recognitions(best, candidates, recognized, 0.4)
    finally:
        runtime.recognize_rows_with_alternate_model = original

    assert added == 1
    assert calls == [([0], "korean")], "只对退化的那个检测、用韩文备用模型重试一次"
    assert best[0]["text"] == "응?" and best[0]["variant"] == "degenerate_rescue"
    assert best[0]["detection_index"] == 0


def test_rescue_skips_when_first_result_is_fine():
    best = {0: {"text": "탐정님", "score": 0.906, "lang": "korean", "orientation": 0, "detection_index": 0}}
    calls = []
    original = runtime.recognize_rows_with_alternate_model
    runtime.recognize_rows_with_alternate_model = lambda rows, lang: calls.append(lang) or []
    try:
        added = runtime.rescue_degenerate_recognitions(best, [{"detection_index": 0, "orientation": 0, "image": object()}], [], 0.4)
    finally:
        runtime.recognize_rows_with_alternate_model = original
    assert added == 0 and calls == [] and best[0]["text"] == "탐정님"


def test_contract_version_is_v12_and_synced():
    server = json.loads(json.dumps({"version": runtime.OCR_GEOMETRY_CONTRACT_VERSION}))["version"]
    assert server == "detect-crop-recognize-appearance-layout-v12"
    extension_versions = (ROOT / "extension" / "src" / "config" / "versions.js").read_text(encoding="utf-8")
    assert f'"{server}"' in extension_versions, "两侧代次必须逐字相同（否则每个请求都会被拒）"
