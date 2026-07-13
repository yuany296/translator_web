from __future__ import annotations

import sys
from pathlib import Path
import io

import pytest
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


def test_local_ocr_request_defaults_to_fast_mode() -> None:
    import server

    assert server.OcrRequest(image="placeholder").mode == "fast"


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


def test_visual_region_analysis_groups_three_lines_in_one_colored_panel() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image_bytes, items = build_visual_region_fixture("white", "#d8c49a", "black")
    regions = server.annotate_visual_regions(image_bytes, items)

    assert len(regions) == 1
    assert {item["region_id"] for item in items} == {"region-1"}
    assert all(item["region_type"] == "caption_panel" for item in items)
    assert all(item["bg_color"] for item in items)


def test_visual_region_analysis_backfills_an_earlier_line(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image_bytes, items = build_visual_region_fixture("white", "#d8c49a", "black")
    detected_region = {
        "id": "",
        "region_type": "caption_panel",
        "polygon": [[80, 45], [340, 45], [340, 250], [80, 250]],
        "box": {"left": 80, "top": 45, "width": 260, "height": 205},
        "bg_color": "#d8c49a",
        "confidence": 0.92,
        "rectangularity": 1.0,
        "brightness": 200.0,
    }
    calls = 0

    def detect_merged_block(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return dict(detected_region)

    monkeypatch.setattr(server, "detect_solid_region_for_box", detect_merged_block)
    regions = server.annotate_visual_regions(image_bytes, items)

    assert len(regions) == 1
    assert {item["region_id"] for item in items} == {"region-1"}
    assert all(item["region_polygon"] == detected_region["polygon"] for item in items)


def test_visual_text_blocks_split_shifted_multirow_paragraphs() -> None:
    import server

    items = [
        {"text": "네?!그게 무슨..", "box": {"left": 181, "top": 882, "width": 223, "height": 46}},
        {"text": "여긴 서울..아니에요?", "box": {"left": 161, "top": 935, "width": 287, "height": 46}},
        {"text": "전 그냥", "box": {"left": 395, "top": 1022, "width": 104, "height": 46}},
        {"text": "지하철을 타려고", "box": {"left": 338, "top": 1073, "width": 217, "height": 43}},
        {"text": "했을 뿐인데....", "box": {"left": 347, "top": 1121, "width": 168, "height": 50}},
    ]

    blocks = server.merge_visual_text_blocks(items)

    assert len(blocks) == 2
    assert [len(block["items"]) for block in blocks] == [2, 3]
    assert "지하철" not in " ".join(item["text"] for item in blocks[0]["items"])
    assert "지하철" in " ".join(item["text"] for item in blocks[1]["items"])


def test_solid_region_near_sampling_uses_line_height(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = server.np.full((220, 360, 3), 48, dtype=server.np.uint8)
    lab = server.cv2.cvtColor(image, server.cv2.COLOR_BGR2LAB)
    vertical_references: list[int] = []

    def measure(*args, **kwargs):
        vertical_references.append(int(args[6]))
        return {
            "roi": (120, 60, 120, 100),
            "median_bgr": server.np.asarray([48, 48, 48], dtype=server.np.uint8),
            "lab_variance": 4.0,
            "delta_e_p90": 5.0,
            "dominant_coverage": 0.96,
            "passes_thresholds": True,
        }

    monkeypatch.setattr(server, "measure_solid_background_scale", measure)
    region = server.detect_solid_region_for_box(
        image,
        lab,
        {"left": 100, "top": 40, "width": 160, "height": 147, "line_height": 46},
        1.0,
    )

    assert region is not None
    assert vertical_references == [46, 46]


def test_visual_region_assignment_prefers_the_smallest_containing_panel() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    box = {"left": 120, "top": 100, "width": 80, "height": 30}
    regions = [
        {
            "id": "outer",
            "polygon": [[20, 20], [380, 20], [380, 280], [20, 280]],
            "box": {"left": 20, "top": 20, "width": 360, "height": 260},
            "confidence": 0.95,
        },
        {
            "id": "inner",
            "polygon": [[80, 60], [260, 60], [260, 190], [80, 190]],
            "box": {"left": 80, "top": 60, "width": 180, "height": 130},
            "confidence": 0.90,
        },
    ]

    assert server.find_best_visual_region(box, regions)["id"] == "inner"


def test_visual_region_analysis_uses_light_text_on_black_panel() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image_bytes, items = build_visual_region_fixture("white", "black", "white")
    server.annotate_visual_regions(image_bytes, items)

    assert {item["region_id"] for item in items} == {"region-1"}
    assert all(server.contrast_ratio(item["text_color"], item["bg_color"]) >= 4.5 for item in items)
    assert all(item["stroke_color"].lower() == "#000000" for item in items)


def test_visual_region_analysis_rejects_patterned_effect_background() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (240, 180), "white")
    draw = ImageDraw.Draw(image)
    for y in range(0, 180, 12):
        for x in range(0, 240, 12):
            draw.rectangle((x, y, x + 11, y + 11), fill="#335577" if (x // 12 + y // 12) % 2 else "#d9b4d0")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [{"text": "effect", "score": 0.95, "box": {"left": 50, "top": 55, "width": 140, "height": 60}}]

    regions = server.annotate_visual_regions(buffer.getvalue(), items)

    assert regions == []
    assert items[0]["region_id"] == ""
    assert items[0]["region_type"] == "effect_text"
    assert items[0]["text_color"] == "#000000"
    assert items[0]["stroke_color"] == "#ffffff"


def test_visual_region_analysis_prefers_near_scale_when_far_metrics_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = server.np.full((120, 160, 3), 220, dtype=server.np.uint8)
    lab = server.cv2.cvtColor(image, server.cv2.COLOR_BGR2LAB)
    near = {
        "roi": (50, 45, 60, 30),
        "median_bgr": server.np.asarray([210, 215, 220], dtype=server.np.uint8),
        "lab_variance": 8.0,
        "delta_e_p90": 5.0,
        "dominant_coverage": 0.94,
        "passes_thresholds": True,
    }
    far = {
        "roi": (35, 25, 90, 70),
        "median_bgr": server.np.asarray([120, 130, 140], dtype=server.np.uint8),
        "lab_variance": 130.0,
        "delta_e_p90": 28.0,
        "dominant_coverage": 0.61,
        "passes_thresholds": False,
    }
    measurements = iter((near, far))
    monkeypatch.setattr(server, "measure_solid_background_scale", lambda *_args, **_kwargs: next(measurements))

    region = server.detect_solid_region_for_box(
        image,
        lab,
        {"left": 60, "top": 50, "width": 40, "height": 20},
        1.0,
    )

    assert region is not None
    assert region["box"] == {"left": 50.0, "top": 45.0, "width": 60.0, "height": 30.0}
    assert region["sampling_strategy"] == "near_priority"
    assert region["far_scale_passed"] is False
    assert region["background_variance"] == near["lab_variance"]


def test_visual_region_analysis_keeps_solid_panel_when_far_scale_sees_paired_edges() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (360, 220), "white")
    draw = ImageDraw.Draw(image)
    outer_panel = [(95, 65), (180, 42), (265, 65), (265, 125), (180, 146), (95, 125)]
    inner_panel = [(100, 68), (180, 47), (260, 68), (260, 122), (180, 141), (100, 122)]
    draw.polygon(outer_panel, fill="#c77b82")
    draw.polygon(inner_panel, fill="#515151")
    box = {"left": 135, "top": 82, "width": 90, "height": 36}
    draw.rectangle((150, 94, 210, 106), fill="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [{
        "text": "outlined panel",
        "score": 0.98,
        "box": box,
        "polygon": [[135, 82], [225, 82], [225, 118], [135, 118]],
    }]

    regions = server.annotate_visual_regions(buffer.getvalue(), items)

    assert len(regions) == 1
    assert regions[0]["far_scale_passed"] is False
    assert regions[0]["bg_color"] == "#515151"
    assert items[0]["region_id"] == "region-1"
    assert items[0]["region_type"] == "caption_panel"


def test_cleaned_image_inpaints_only_complex_background_text() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (160, 100), "#f0f0f0")
    draw = ImageDraw.Draw(image)
    draw.rectangle((34, 32, 126, 58), fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [
        {
            "text": "effect",
            "box": {"left": 30, "top": 28, "width": 100, "height": 36},
            "polygon": [[30, 28], [130, 28], [130, 64], [30, 64]],
            "region_id": "",
        },
        {
            "text": "panel",
            "box": {"left": 10, "top": 10, "width": 20, "height": 12},
            "polygon": [[10, 10], [30, 10], [30, 22], [10, 22]],
            "region_id": "region-1",
        },
    ]

    cleaned = server.build_cleaned_image_data_url(buffer.getvalue(), items)

    assert cleaned and cleaned.startswith("data:image/png;base64,")


def test_visual_region_analysis_prefers_white_bubble_over_white_page() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (540, 420), "white")
    draw = ImageDraw.Draw(image)
    bubble = [(85, 75), (410, 65), (470, 135), (455, 295), (330, 330), (275, 395), (250, 325), (95, 305), (55, 190)]
    bubble_inner = [(90, 85), (400, 78), (455, 140), (440, 285), (325, 315), (275, 370), (255, 315), (105, 290), (70, 190)]
    draw.polygon(bubble, fill="black")
    draw.polygon(bubble_inner, fill="white")
    boxes = [
        {"left": 220, "top": 145, "width": 100, "height": 52},
        {"left": 200, "top": 215, "width": 140, "height": 55},
    ]
    for box in boxes:
        draw.rectangle(
            (box["left"] + 20, box["top"] + 14, box["left"] + box["width"] - 20, box["top"] + box["height"] - 14),
            fill="black",
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [{"text": f"line-{index}", "score": 0.98, "box": box} for index, box in enumerate(boxes)]

    regions = server.annotate_visual_regions(buffer.getvalue(), items)

    assert len(regions) == 1
    assert regions[0]["region_type"] == "speech_bubble"
    assert regions[0]["background_variance"] <= server.SOLID_BACKGROUND_MAX_LAB_VARIANCE
    assert regions[0]["dominant_coverage"] >= server.SOLID_BACKGROUND_MIN_DOMINANT_COVERAGE
    assert regions[0]["box"]["width"] < image.width * 0.88
    assert {item["region_id"] for item in items} == {"region-1"}



def test_visual_region_analysis_keeps_thin_bubble_border_when_downscaled() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (864, 1403), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse((120, 500, 650, 1000), fill="black")
    draw.ellipse((132, 512, 638, 988), fill="white")
    boxes = [
        {"left": 350, "top": 635, "width": 105, "height": 70},
        {"left": 335, "top": 705, "width": 135, "height": 70},
    ]
    for box in boxes:
        draw.rectangle(
            (box["left"] + 20, box["top"] + 25, box["left"] + box["width"] - 20, box["top"] + box["height"] - 25),
            fill="black",
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [{"text": f"line-{index}", "score": 0.98, "box": box} for index, box in enumerate(boxes)]

    regions = server.annotate_visual_regions(buffer.getvalue(), items)

    assert len(regions) == 1
    assert {item["region_id"] for item in items} == {"region-1"}
    assert regions[0]["box"]["height"] <= 350



def test_visual_region_analysis_rejects_page_spanning_background() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (360, 300), "white")
    draw = ImageDraw.Draw(image)
    draw.line((0, 158, 360, 158), fill="black", width=12)
    box = {"left": 100, "top": 80, "width": 160, "height": 48}
    draw.rectangle((125, 94, 235, 114), fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    items = [{"text": "effect", "score": 0.95, "box": box}]

    regions = server.annotate_visual_regions(buffer.getvalue(), items)

    assert regions == []
    assert items[0]["region_type"] == "effect_text"
    assert items[0]["text_color"] == "#000000"
    assert items[0]["stroke_color"] == "#ffffff"

def test_problem_screenshots_distinguish_panels_from_effect_text() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    required = [
        PROBLEM_FIXTURE_DIR / "1781878788148.png",
        PROBLEM_FIXTURE_DIR / "1781879291545.png",
        PROBLEM_FIXTURE_DIR / "1781878948031.png",
    ]
    if not all(path.exists() for path in required):
        pytest.skip("local problem screenshots unavailable")

    black_items = [{"text": "caption", "box": {"left": 70, "top": 70, "width": 320, "height": 105}}]
    black_regions = server.annotate_visual_regions(required[0].read_bytes(), black_items)
    assert black_regions == []
    assert black_items[0]["region_type"] == "effect_text"
    assert black_items[0]["text_color"] == "#000000"
    assert black_items[0]["stroke_color"] == "#ffffff"

    beige_items = [
        {"text": "line-1", "box": {"left": 110, "top": 135, "width": 400, "height": 48}},
        {"text": "line-2", "box": {"left": 205, "top": 185, "width": 210, "height": 52}},
        {"text": "line-3", "box": {"left": 145, "top": 240, "width": 305, "height": 56}},
    ]
    beige_regions = server.annotate_visual_regions(required[1].read_bytes(), beige_items)
    assert beige_regions == []
    assert {item["region_type"] for item in beige_items} == {"effect_text"}
    assert {item["text_color"] for item in beige_items} == {"#000000"}
    assert {item["stroke_color"] for item in beige_items} == {"#ffffff"}

    effect_items = [{"text": "effect", "box": {"left": 35, "top": 25, "width": 675, "height": 175}}]
    effect_regions = server.annotate_visual_regions(required[2].read_bytes(), effect_items)
    assert effect_regions == []
    assert effect_items[0]["region_type"] == "effect_text"


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
