from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from run_visual_regression import run_cases


def test_fixed_real_screenshot_visual_baseline() -> None:
    report = run_cases()

    assert set(report["cases"]) == {
        "kakao_solid_bubble",
        "kakao_blank_boundary",
        "kakao_effect_title",
    }
