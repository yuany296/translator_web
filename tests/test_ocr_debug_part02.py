from __future__ import annotations

import asyncio

import base64

import io

import sys

from pathlib import Path

import pytest

import numpy as np

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "tools"))

sys.path.insert(0, str(ROOT / "local-ocr-service"))

from ocr_debug_common import count_hangul, predict_ocr, prepare_paddleocr_import, summarize_items

FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "korean_comment.png"

RECOVERY_FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "korean_comment_six_lines.png"

VERTICAL_FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "vertical_korean_photo.png"

PROBLEM_FIXTURE_DIR = ROOT / "image" / "promblems"

PARAMS = {
    "text_det_thresh": 0.2,
    "text_det_box_thresh": 0.35,
    "text_det_unclip_ratio": 1.2,
    "text_rec_score_thresh": 0.0,
}

def build_visual_region_fixture(background: str, panel: str, ink: str) -> tuple[bytes, list[dict]]:
    image = Image.new("RGB", (420, 300), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((55, 15, 365, 285), fill=panel)
    boxes = [
        {"left": 130, "top": 80, "width": 160, "height": 30},
        {"left": 155, "top": 130, "width": 110, "height": 30},
        {"left": 120, "top": 180, "width": 180, "height": 30},
    ]
    items = []
    for index, box in enumerate(boxes):
        draw.rectangle(
            (box["left"], box["top"] + 8, box["left"] + box["width"], box["top"] + box["height"] - 8),
            fill=ink,
        )
        items.append({"text": f"line-{index}", "score": 0.98, "box": box})
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), items

def build_detection(server, left: float, top: float, width: float, height: float) -> dict:
    polygon = [
        [left, top],
        [left + width, top],
        [left + width, top + height],
        [left, top + height],
    ]
    return {
        "polygon": polygon,
        "box": server._polygon_to_box(polygon),
        "det_score": 0.9,
        "rotation_deg": 0.0,
    }

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

def test_vertical_orientation_uses_geometry_only_for_close_plausible_recognition() -> None:
    import server

    detection = {"rotation_deg": -90.0}
    close_rows = [
        {"orientation": 90, "text": "잘못된", "score": 0.97, "lang": "korean"},
        {"orientation": -90, "text": "올바른", "score": 0.94, "lang": "korean"},
    ]
    clear_winner_rows = [
        {"orientation": 90, "text": "정답문장", "score": 0.99, "lang": "korean"},
        {"orientation": -90, "text": "오답", "score": 0.72, "lang": "korean"},
    ]

    assert server.select_best_recognition(close_rows, detection)["orientation"] == -90
    assert server.select_best_recognition(clear_winner_rows, detection)["orientation"] == 90

def test_fast_perspective_pipeline_keeps_raw_detection_boxes_when_final_items_are_filtered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server

    image = Image.new("RGB", (160, 80), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    polygon = [[10, 20], [145, 20], [145, 50], [10, 50]]
    detection = {
        "polygon": polygon,
        "box": server._polygon_to_box(polygon),
        "det_score": 0.91,
        "rotation_deg": 0.0,
    }
    monkeypatch.setattr(server, "_run_detection_only", lambda *_args, **_kwargs: [detection])
    monkeypatch.setattr(
        server,
        "recognize_candidate_rows",
        lambda rows, languages: [
            {
                **row,
                "text": "희미한글",
                "score": 0.2,
                "lang": languages[0],
            }
            for row in rows
        ],
    )
    params = {**PARAMS, "text_rec_score_thresh": 0.9}

    result = server._run_slice_ocr_pipeline(buffer.getvalue(), "korean", params)

    assert result["items"] == []
    assert len(result["rawItems"]) == 1
    assert result["rawItems"][0]["text"] == "희미한글"
    assert result["rawItems"][0]["polygon"] == polygon

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

def test_korean_recognition_restores_two_raised_carets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import cv2
    import numpy as np
    import server

    image = np.full((111, 172, 3), (40, 220, 250), dtype=np.uint8)
    cv2.rectangle(image, (26, 33), (55, 77), (20, 20, 20), -1)
    cv2.rectangle(image, (45, 27), (67, 91), (20, 20, 20), -1)
    cv2.rectangle(image, (76, 25), (82, 95), (20, 20, 20), -1)
    cv2.line(image, (89, 58), (103, 34), (20, 20, 20), 5)
    cv2.line(image, (103, 34), (116, 58), (20, 20, 20), 5)
    cv2.line(image, (124, 58), (137, 34), (20, 20, 20), 5)
    cv2.line(image, (137, 34), (151, 58), (20, 20, 20), 5)

    class StubRecognizer:
        def predict(self, _images, batch_size):
            assert batch_size == 1
            return [{"rec_text": "네쓰", "rec_score": 0.88}]

    monkeypatch.setattr(server, "get_text_recognition_client", lambda _lang: StubRecognizer())
    result = server.recognize_candidate_rows([{
        "detection_index": 0,
        "orientation": 0,
        "image": image,
    }], ["korean"])

    assert result[0]["text"] == "네^^"

def test_korean_recognition_keeps_syllable_when_lower_ink_is_present() -> None:
    import cv2
    import numpy as np
    import server

    image = np.full((111, 172, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (26, 25), (75, 95), 0, 4)
    cv2.line(image, (89, 58), (104, 34), 0, 5)
    cv2.line(image, (104, 34), (119, 58), 0, 5)
    cv2.line(image, (121, 58), (136, 34), 0, 5)
    cv2.line(image, (136, 34), (151, 58), 0, 5)
    cv2.line(image, (89, 82), (151, 82), 0, 5)

    assert server.normalize_symbol_emoticon_text("네쓰", "korean", image) == "네쓰"

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

def test_merge_detection_passes_keeps_primary_and_only_adds_distinct_recovery_boxes() -> None:
    import server

    primary = [build_detection(server, 20, 20, 180, 50)]
    recovery = [
        build_detection(server, 24, 22, 174, 46),
        build_detection(server, 55, 32, 35, 18),
        build_detection(server, 20, 120, 180, 50),
    ]

    merged, recovery_added = server.merge_detection_passes(primary, recovery)

    assert merged[0] is primary[0]
    assert merged == [primary[0], recovery[2]]
    assert recovery_added == 1

def test_fast_pipeline_recovers_missing_middle_comment_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    image_bytes = RECOVERY_FIXTURE.read_bytes()
    all_detections = [
        build_detection(server, 115, 82 + index * 92, 820, 55)
        for index in range(6)
    ]
    primary = [all_detections[index] for index in (0, 1, 4, 5)]
    detection_params = []
    recognized_batches = []

    def detect(_image_bytes, _lang, params):
        detection_params.append(dict(params))
        return primary if len(detection_params) == 1 else all_detections

    def recognize(rows, languages):
        recognized_batches.append(list(rows))
        return [
            {
                "detection_index": row["detection_index"],
                "orientation": row["orientation"],
                "text": f"복구문장{row['detection_index'] + 1}",
                "score": 0.99,
                "lang": languages[0],
            }
            for row in rows
        ]

    params = {
        "text_det_thresh": 0.3,
        "text_det_box_thresh": 0.6,
        "text_det_unclip_ratio": 1.2,
        "text_rec_score_thresh": 0.72,
    }
    monkeypatch.setattr(server, "_run_detection_only", detect)
    monkeypatch.setattr(server, "recognize_candidate_rows", recognize)

    result = server._run_slice_ocr_pipeline(image_bytes, "korean", params)

    assert detection_params[0]["text_det_thresh"] == 0.3
    assert detection_params[0]["text_det_box_thresh"] == 0.6
    assert detection_params[1]["text_det_thresh"] == 0.2
    assert detection_params[1]["text_det_box_thresh"] == 0.42
    assert len(recognized_batches[0]) == 6
    assert sum(len(batch) for batch in recognized_batches) == 6
    assert len(result["items"]) == 6
    assert result["counts"]["primary_detections"] == 4
    assert result["counts"]["recovery_detections"] == 6
    assert result["counts"]["recovery_added"] == 2

def test_fast_pipeline_uses_primary_results_when_relaxed_detection_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    image_bytes = RECOVERY_FIXTURE.read_bytes()
    primary = [build_detection(server, 115, 82, 820, 55)]
    detection_calls = 0

    def detect(_image_bytes, _lang, _params):
        nonlocal detection_calls
        detection_calls += 1
        if detection_calls == 2:
            raise RuntimeError("relaxed detector unavailable")
        return primary

    def recognize(rows, languages):
        return [
            {
                "detection_index": row["detection_index"],
                "orientation": row["orientation"],
                "text": "기본검출결과",
                "score": 0.99,
                "lang": languages[0],
            }
            for row in rows
        ]

    monkeypatch.setattr(server, "_run_detection_only", detect)
    monkeypatch.setattr(server, "recognize_candidate_rows", recognize)

    result = server._run_slice_ocr_pipeline(image_bytes, "korean", PARAMS)

    assert [item["text"] for item in result["items"]] == ["기본검출결과"]
    assert result["counts"]["primary_detections"] == 1
    assert result["counts"]["recovery_detections"] == 0
    assert result["counts"]["recovery_added"] == 0

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

def test_visual_style_samples_light_ink_without_a_detected_region() -> None:
    import server

    image = np.full((80, 180, 3), (52, 52, 52), dtype=np.uint8)
    image[28:52, 48:132] = (244, 244, 244)
    item = {
        "box": {"left": 30, "top": 18, "width": 120, "height": 44},
        "polygon": [[30, 18], [150, 18], [150, 62], [30, 62]],
    }

    server.apply_visual_style_to_item(item, image, None)

    assert server.relative_luminance(item["text_color"]) > 0.7
    assert item["bg_color"] == ""

def test_visual_style_preserves_brown_ink_on_a_light_background() -> None:
    import server

    image = np.full((80, 180, 3), (248, 248, 248), dtype=np.uint8)
    image[28:52, 48:132] = (36, 84, 132)
    item = {
        "box": {"left": 30, "top": 18, "width": 120, "height": 44},
        "polygon": [[30, 18], [150, 18], [150, 62], [30, 62]],
    }

    server.apply_visual_style_to_item(item, image, None)

    red, green, blue = server.hex_to_bgr(item["text_color"])[::-1]
    assert red > green > blue
    assert item["text_color"] != "#000000"

def test_dedupe_items_drops_a_lower_confidence_conflicting_read_of_the_same_row() -> None:
    import server

    items = [
        {"text": "맛있는", "score": 0.999, "region_id": "region-a", "rotation_deg": 0,
         "box": {"left": 388, "top": 343, "width": 94, "height": 32}},
        {"text": "벗었는", "score": 0.820, "region_id": "region-a", "rotation_deg": 0,
         "box": {"left": 392, "top": 363, "width": 86, "height": 22}},
    ]

    assert [item["text"] for item in server.dedupe_items(items)] == ["맛있는"]

def test_dedupe_items_keeps_adjacent_rows_with_similar_confidence() -> None:
    import server

    items = [
        {"text": "첫째줄", "score": 0.97, "region_id": "region-a", "rotation_deg": -8,
         "box": {"left": 100, "top": 100, "width": 110, "height": 30}},
        {"text": "둘째줄", "score": 0.94, "region_id": "region-a", "rotation_deg": -8,
         "box": {"left": 102, "top": 124, "width": 108, "height": 30}},
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
