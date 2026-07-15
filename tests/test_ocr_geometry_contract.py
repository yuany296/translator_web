from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


def _image_bytes(width: int = 240, height: int = 140) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def _map(matrix: list[float], point: dict[str, float]) -> np.ndarray:
    vector = np.array([point["x"], point["y"], 1.0], dtype=float)
    mapped = np.array(matrix, dtype=float).reshape(3, 3) @ vector
    return mapped[:2] / mapped[2]


def test_detected_crop_transform_round_trips_source_polygon_within_one_pixel() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV is not installed")
    polygon = [[30.0, 40.0], [205.0, 62.0], [200.0, 96.0], [25.0, 74.0]]
    result = server._deskew_crop_region(_image_bytes(), polygon, "region-contract")
    assert result is not None
    region = result["detectedRegion"]
    errors = []
    for source in region["sourcePolygon"]:
        crop = _map(region["sourceToCrop"], source)
        restored = _map(region["cropToSource"], {"x": crop[0], "y": crop[1]})
        errors.append(float(np.linalg.norm(restored - np.array([source["x"], source["y"]]))))
    assert max(errors) <= 1.0
    assert region["regionId"] == "region-contract"
    assert region["geometryReliability"] == "detected"
    assert 33 <= region["lineThickness"] <= 36


@pytest.mark.parametrize("mode,expected_detection_passes", [("fast", 2), ("enhanced", 3)])
def test_fast_and_enhanced_modes_detect_then_crop_original_source(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    expected_detection_passes: int,
) -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV is not installed")
    source = _image_bytes()
    detection_calls: list[bytes] = []
    crop_calls: list[tuple[bytes, str]] = []
    detection = {
        "polygon": [[30.0, 40.0], [190.0, 40.0], [190.0, 72.0], [30.0, 72.0]],
        "box": {"left": 30.0, "top": 40.0, "width": 160.0, "height": 32.0},
        "det_score": 0.95,
        "rotation_deg": 0.0,
    }

    def fake_detection(image_bytes: bytes, _lang: str, _params: dict[str, float]) -> list[dict]:
        detection_calls.append(image_bytes)
        return [detection]

    original_crop = server._deskew_crop_region

    def tracked_crop(image_bytes: bytes, polygon: list[list[float]], region_id: str) -> dict | None:
        crop_calls.append((image_bytes, region_id))
        return original_crop(image_bytes, polygon, region_id)

    def fake_recognition(rows: list[dict], _languages: list[str]) -> list[dict]:
        return [{**{key: value for key, value in row.items() if key != "image"},
                 "text": "테스트", "score": 0.99, "lang": "korean"} for row in rows]

    monkeypatch.setattr(server, "_run_detection_only", fake_detection)
    monkeypatch.setattr(server, "_deskew_crop_region", tracked_crop)
    monkeypatch.setattr(server, "recognize_candidate_rows", fake_recognition)
    monkeypatch.setattr(server, "annotate_visual_regions", lambda _image, _items: [])

    result = server._run_slice_ocr_pipeline(source, "korean", {
        "text_det_thresh": 0.3,
        "text_det_box_thresh": 0.6,
        "text_det_unclip_ratio": 1.2,
        "text_rec_score_thresh": 0.0,
    }, mode=mode)

    assert len(detection_calls) == expected_detection_passes
    assert len(crop_calls) == 1
    assert crop_calls[0][0] == source
    assert result["geometryReliability"] == "detected"
    assert result["detectedRegions"][0]["regionId"] == result["recognizedRegions"][0]["regionId"]
    assert result["semanticBlocks"][0]["memberRegionIds"] == [result["detectedRegions"][0]["regionId"]]
