from __future__ import annotations

import sys
from pathlib import Path
import io

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "local-ocr-service"))

from ocr_debug_common import count_hangul, predict_ocr, prepare_paddleocr_import, summarize_items

FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "korean_comment.png"
VERTICAL_FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "vertical_korean_photo.png"
PARAMS = {
    "text_det_thresh": 0.2,
    "text_det_box_thresh": 0.35,
    "text_det_unclip_ratio": 1.2,
    "text_rec_score_thresh": 0.0,
}


def test_local_ocr_request_defaults_to_fast_mode() -> None:
    import server

    assert server.OcrRequest(image="placeholder").mode == "fast"


def test_polygon_rotation_and_perspective_crop_support_arbitrary_tilt() -> None:
    import server

    image = Image.new("RGB", (180, 140), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    polygon = [[35, 20], [150, 54], [140, 100], [25, 66]]

    angle = server.polygon_rotation_deg(polygon)
    crop = server._deskew_crop_image(buffer.getvalue(), polygon)

    assert 10 < angle < 25
    assert crop is not None
    with Image.open(io.BytesIO(crop)) as warped:
        assert warped.width > warped.height
        assert warped.width >= 110


def test_fast_perspective_pipeline_tries_both_vertical_directions_and_keeps_polygon(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    image = Image.new("RGB", (80, 160), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    polygon = [[20, 10], [50, 10], [50, 145], [20, 145]]
    detection = {
        "polygon": polygon,
        "box": server._polygon_to_box(polygon),
        "det_score": 0.93,
        "rotation_deg": -90.0,
    }
    seen_orientations = []

    monkeypatch.setattr(server, "_run_detection_only", lambda *_args, **_kwargs: [detection])

    def recognize(rows, languages):
        seen_orientations.extend(row["orientation"] for row in rows)
        return [
            {
                **row,
                "text": "잘못" if row["orientation"] == 90 else "덤벼라",
                "score": 0.45 if row["orientation"] == 90 else 0.96,
                "lang": languages[0],
            }
            for row in rows
        ]

    monkeypatch.setattr(server, "recognize_candidate_rows", recognize)
    result = server._run_slice_ocr_pipeline(buffer.getvalue(), "korean", PARAMS)

    assert set(seen_orientations) == {-90, 90}
    assert result["items"][0]["text"] == "덤벼라"
    assert result["items"][0]["polygon"] == polygon
    assert result["items"][0]["orientation_applied"] == -90


def test_recognition_candidates_are_sent_as_one_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np
    import server

    calls = []

    class StubRecognizer:
        def predict(self, images, batch_size):
            calls.append((len(images), batch_size))
            return [
                {"rec_text": f"문장{index}", "rec_score": 0.9}
                for index in range(len(images))
            ]

    monkeypatch.setattr(server, "get_text_recognition_client", lambda _lang: StubRecognizer())
    rows = [
        {"detection_index": index, "orientation": 0, "image": np.zeros((20, 80, 3), dtype=np.uint8)}
        for index in range(3)
    ]
    result = server.recognize_candidate_rows(rows, ["korean"])

    assert calls == [(3, 3)]
    assert [item["text"] for item in result] == ["문장0", "문장1", "문장2"]


def test_detection_only_reads_numpy_polygons_and_scores(monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np
    import server

    class StubDetector:
        def predict(self, _image, batch_size):
            assert batch_size == 1
            return [{
                "dt_polys": np.asarray([[[10, 12], [90, 20], [86, 44], [6, 36]]], dtype=np.float32),
                "dt_scores": np.asarray([0.94], dtype=np.float32)
            }]

    image = Image.new("RGB", (120, 80), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    monkeypatch.setattr(server, "get_text_detection_client", lambda _params: StubDetector())

    items = server._run_detection_only(buffer.getvalue(), "korean", PARAMS)

    assert len(items) == 1
    assert items[0]["det_score"] == pytest.approx(0.94)
    assert len(items[0]["polygon"]) == 4
    assert items[0]["box"]["width"] > 80


def test_fast_perspective_pipeline_retries_weak_horizontal_text_at_180(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    image = Image.new("RGB", (160, 80), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    polygon = [[10, 20], [145, 20], [145, 50], [10, 50]]
    monkeypatch.setattr(server, "_run_detection_only", lambda *_args, **_kwargs: [{
        "polygon": polygon,
        "box": server._polygon_to_box(polygon),
        "det_score": 0.9,
        "rotation_deg": 0.0,
    }])
    orientations = []

    def recognize(rows, languages):
        orientations.extend(row["orientation"] for row in rows)
        return [{
            "detection_index": row["detection_index"],
            "orientation": row["orientation"],
            "text": "정답" if row["orientation"] == 180 else "?",
            "score": 0.97 if row["orientation"] == 180 else 0.2,
            "lang": languages[0],
        } for row in rows]

    monkeypatch.setattr(server, "recognize_candidate_rows", recognize)
    result = server._run_slice_ocr_pipeline(buffer.getvalue(), "korean", PARAMS)

    assert orientations == [0, 180]
    assert result["items"][0]["text"] == "정답"
    assert result["items"][0]["orientation_applied"] == 180


def test_local_ocr_disables_textline_orientation(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    class StubClient:
        def __init__(self) -> None:
            self.predict_kwargs = None

        def predict(self, _image_path: str, **kwargs):
            self.predict_kwargs = kwargs
            return []

    created_kwargs = {}
    client = StubClient()

    def create_stub_client(**kwargs):
        created_kwargs.update(kwargs)
        return client

    monkeypatch.setattr(server, "PaddleOCR", create_stub_client)
    server.create_ocr_client(
        "korean",
        "gpu:0",
        "PP-OCRv5",
        "PP-OCRv5_server_det",
        "korean_PP-OCRv5_mobile_rec",
    )
    server.predict_with_client(client, "example.png", PARAMS)

    assert created_kwargs["use_textline_orientation"] is False
    assert client.predict_kwargs["use_textline_orientation"] is False


def require_gpu_paddleocr() -> None:
    prepare_paddleocr_import()
    try:
        import paddle  # type: ignore
    except Exception as exc:
        pytest.skip(f"Paddle dependency is unavailable: {exc}")

    try:
        cuda_ok = bool(paddle.is_compiled_with_cuda()) and int(paddle.device.cuda.device_count()) > 0
    except Exception as exc:
        pytest.skip(f"Cannot inspect Paddle CUDA device: {exc}")
    if not cuda_ok:
        pytest.skip("GPU Paddle is required for OCR debug tests.")


def test_variant_support_annotations_count_distinct_preprocessing_variants() -> None:
    import server

    items = [
        {"text": "새문장", "score": 0.91, "variant": "original", "box": {"left": 10, "top": 10, "width": 40, "height": 16}},
        {"text": "새문장", "score": 0.88, "variant": "gray_contrast_2x", "box": {"left": 11, "top": 10, "width": 39, "height": 16}},
        {"text": "새문장", "score": 0.86, "variant": "binary_text_2x", "box": {"left": 10, "top": 11, "width": 40, "height": 15}},
        {"text": "다른글", "score": 0.95, "variant": "inverted_contrast_2x", "box": {"left": 80, "top": 10, "width": 35, "height": 16}},
    ]
    server.annotate_variant_support(items)

    assert items[0]["variantSupport"] == 3
    assert items[0]["enhancedVariantSupport"] == 2
    assert items[3]["variantSupport"] == 1
    assert items[3]["enhancedVariantSupport"] == 1


def test_dedupe_items_collapses_complete_and_partial_korean_lines() -> None:
    import server

    items = [
        {"text": "피크닉 세트.", "score": 0.96, "variant": "original", "variantSupport": 3, "box": {"left": 141, "top": 588, "width": 266, "height": 54}},
        {"text": "피크닉세트.", "score": 0.97, "variant": "gray_contrast_2x", "variantSupport": 2, "box": {"left": 149, "top": 593, "width": 251, "height": 44}},
        {"text": "쿠키는 절반으로", "score": 0.98, "variant": "original", "variantSupport": 2, "box": {"left": 268, "top": 938, "width": 348, "height": 52}},
        {"text": "쿠키는절반으로", "score": 1.0, "variant": "binary_text_2x", "variantSupport": 2, "box": {"left": 270, "top": 942, "width": 342, "height": 45}},
    ]

    deduped = server.dedupe_items(items)

    assert len(deduped) == 2
    assert {server.normalize_text_for_similarity(item["text"]) for item in deduped} == {"피크닉세트", "쿠키는절반으로"}


def test_dedupe_items_keeps_separate_repeated_dialogue() -> None:
    import server

    items = [
        {"text": "안녕", "score": 0.95, "box": {"left": 10, "top": 10, "width": 50, "height": 20}},
        {"text": "안녕", "score": 0.94, "box": {"left": 10, "top": 60, "width": 50, "height": 20}},
    ]

    assert len(server.dedupe_items(items)) == 2


def test_direct_paddleocr_korean_fixture_has_multiple_boxes() -> None:
    require_gpu_paddleocr()
    items = predict_ocr(str(FIXTURE), "korean", "gpu:0", PARAMS)
    summary = summarize_items(items)
    assert summary["boxes"] > 3
    assert summary["hangul_chars"] > 5
    assert summary["avg_score"] > 0.4


def test_local_ocr_service_output_shape_and_coordinate_bounds() -> None:
    require_gpu_paddleocr()
    import server

    image_bytes = FIXTURE.read_bytes()
    result = server.run_ocr(image_bytes, "korean", "fast", PARAMS, False, "pytest-korean-comment")

    assert result["imageWidth"] > 0
    assert result["imageHeight"] > 0
    assert isinstance(result["boxes"], list)
    assert len(result["boxes"]) > 3

    texts = "".join(str(item.get("text", "")) for item in result["items"])
    scores = [float(item.get("score") or 0.0) for item in result["items"]]
    assert count_hangul(texts) > 5
    assert sum(scores) / len(scores) > 0.4

    width = result["imageWidth"]
    height = result["imageHeight"]
    for item in result["items"]:
        box = item["box"]
        assert 0 <= box["left"] < width
        assert 0 <= box["top"] < height
        assert box["width"] > 0
        assert box["height"] > 0
        assert box["left"] + box["width"] <= width
        assert box["top"] + box["height"] <= height


def test_local_ocr_service_enhanced_reconstructs_low_confidence_korean_line() -> None:
    require_gpu_paddleocr()
    import server

    image_bytes = FIXTURE.read_bytes()
    params = {
        "text_det_thresh": 0.3,
        "text_det_box_thresh": 0.6,
        "text_det_unclip_ratio": 1.2,
        "text_rec_score_thresh": 0.0,
    }
    result = server.run_ocr(image_bytes, "korean", "enhanced", params, False, "pytest-enhanced-korean-comment")
    texts = ["".join(str(item.get("text", "")).split()) for item in result["items"]]
    assert any("투데이팬들" in text and "견제도" in text and "장난" in text for text in texts)
    assert not any(text == "ㄷㄷ를이" for text in texts)


def test_local_ocr_service_filters_symbol_only_vertical_noise() -> None:
    require_gpu_paddleocr()
    import server

    image_bytes = VERTICAL_FIXTURE.read_bytes()
    params = {
        "text_det_thresh": 0.3,
        "text_det_box_thresh": 0.6,
        "text_det_unclip_ratio": 1.2,
        "text_rec_score_thresh": 0.0,
    }
    result = server.run_ocr(image_bytes, "korean", "enhanced", params, False, "pytest-vertical-korean-photo")
    texts = [str(item.get("text", "")).strip() for item in result["items"]]
    assert "불편한" in texts
    assert "-" not in texts
