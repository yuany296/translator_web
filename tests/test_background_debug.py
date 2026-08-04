from __future__ import annotations

import io
import base64
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))

import background_debug


def _image_bytes(patterned_outer: bool = False) -> bytes:
    image = Image.new("RGB", (220, 160), "#f4f1e8")
    draw = ImageDraw.Draw(image)
    if patterned_outer:
        for index in range(0, 220, 8):
            draw.rectangle((index, 0, index + 3, 160), fill="#5c7890")
    draw.rectangle((55, 45, 165, 115), fill="#e5d6ae")
    draw.rectangle((80, 72, 140, 88), fill="#252525")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _ocr() -> list[dict]:
    return [{"id": "box_001", "bbox": [72, 65, 76, 32], "text": "sample"}]


def test_background_debug_returns_metrics_and_preview_images() -> None:
    result = background_debug.run_background_debug(
        _image_bytes(),
        _ocr(),
        {"box_001": "solid"},
        [{"id": "medium", "params": {"lab_var_threshold": 30, "delta_e_threshold": 18, "dominant_ratio_threshold": 0.6}}],
    )

    box = result["groups"][0]["boxes"][0]
    assert box["id"] == "box_001"
    assert set(box["metrics"]) >= {"lab_var_near", "lab_var_far", "delta_e_near_far", "dominant_ratio_near"}
    assert set(box["images"]) == {"crop", "sampling_overlay", "mask", "solid_preview", "inpaint_preview", "current_preview"}
    assert all(value.startswith("data:image/png;base64,") for value in box["images"].values())


def test_near_priority_can_accept_a_clean_near_region_when_far_is_patterned() -> None:
    common = {
        "near_expand_ratio": 0.1,
        "far_expand_ratio": 1.0,
        "lab_var_threshold": 30,
        "delta_e_threshold": 28,
        "dominant_ratio_threshold": 0.55,
    }
    result = background_debug.run_background_debug(
        _image_bytes(patterned_outer=True),
        _ocr(),
        {"box_001": "solid"},
        [
            {"id": "strict", "params": common},
            {"id": "near", "params": {**common, "near_priority": True}},
        ],
    )

    strict, near = result["groups"]
    assert strict["boxes"][0]["prediction"] == "complex"
    assert near["boxes"][0]["prediction"] == "solid"
    assert strict["summary"]["falseComplex"] == 1
    assert near["summary"]["falseComplex"] == 0


def test_parameter_validation_rejects_inverted_sampling_scales() -> None:
    try:
        background_debug.normalize_background_debug_params({"near_expand_ratio": 2, "far_expand_ratio": 1})
    except ValueError as exc:
        assert "far_expand_ratio" in str(exc)
    else:
        raise AssertionError("expected invalid near/far ordering to fail")


def test_debug_background_http_endpoint_is_isolated_and_callable(tmp_path) -> None:
    import server
    from fastapi.testclient import TestClient

    client = TestClient(server.app)
    origin = "chrome-extension://hihgkmkbdndlnbpleclokbijancgmiil"
    token = "d" * 64
    server.runtime.TRANSLATION_PAIRING_CODE = "debug-pair-code"
    server.runtime._translation_pairing_used = False
    server.runtime._translation_store = server.runtime.TranslationStore(str(tmp_path / "translations.db"))
    paired = client.post(
        "/translations/pair",
        headers={"Origin": origin},
        json={"pairingCode": "debug-pair-code", "token": token},
    )
    assert paired.status_code == 200
    encoded = base64.b64encode(_image_bytes()).decode("ascii")
    response = client.post(
        "/debug-background",
        headers={"Origin": origin, "Authorization": f"Bearer {token}"},
        json={
            "image": f"data:image/png;base64,{encoded}",
            "ocr": _ocr(),
            "labels": {"box_001": "solid"},
            "parameterGroups": [{"id": "one", "params": {}}],
        },
    )

    assert response.status_code == 200
    assert response.json()["groups"][0]["id"] == "one"
    assert any(route.path == "/ocr" for route in server.app.routes)
