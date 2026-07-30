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

def test_local_ocr_request_defaults_to_fast_mode() -> None:
    import server

    assert server.OcrRequest(image="placeholder").mode == "fast"
    assert server.OCR_GEOMETRY_CONTRACT_VERSION == "detect-crop-recognize-appearance-layout-v4"

def test_seam_recovery_removes_separator_and_reconnects_vertical_stroke() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV is required for seam recovery.")
    image = Image.new("RGB", (160, 80), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((28, 18, 32, 62), fill="black")
    draw.line((0, 40, 159, 40), fill="black", width=1)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")

    recovered = server.build_seam_recovery_image_bytes(buffer.getvalue(), [40])

    assert recovered is not None
    output = Image.open(io.BytesIO(recovered)).convert("L")
    assert output.getpixel((100, 40)) >= 250
    assert output.getpixel((30, 40)) <= 5
    assert server.build_seam_recovery_image_bytes(buffer.getvalue(), []) is None

def test_local_ocr_request_limits_supplemental_cleaned_masks() -> None:
    import server

    mask = {"coordinateSpace": "percent", "box": {"x": 10, "y": 20, "w": 30, "h": 40}}
    request = server.OcrRequest(image="placeholder", cleaned_masks=[mask])
    assert request.cleaned_masks == [mask]

    with pytest.raises(ValueError):
        server.OcrRequest(image="placeholder", cleaned_masks=[mask] * 201)

def test_local_ocr_rejects_a_mismatched_geometry_contract_before_inference() -> None:
    import server

    with pytest.raises(Exception) as exc_info:
        asyncio.run(server.ocr(server.OcrRequest(
            image="placeholder",
            ocr_geometry_version="outdated-orientation-contract",
        )))

    assert getattr(exc_info.value, "status_code", None) == 409

def test_ocr_request_forwards_cleaned_masks_without_adding_ocr_items(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server

    masks = [{"coordinateSpace": "percent", "box": {"x": 20, "y": 90, "w": 50, "h": 10}}]
    recognized = [{"text": "본문", "box": {"left": 10, "top": 10, "width": 20, "height": 10}}]
    captured: dict[str, object] = {}
    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    monkeypatch.setattr(server, "decode_data_url", lambda _value: b"image")
    monkeypatch.setattr(
        server,
        "run_ocr",
        lambda *_args: {
            "items": recognized,
            "boxes": [],
            "regions": [],
            "imageWidth": 100,
            "imageHeight": 100,
            "rawItems": [],
            "counts": {},
        },
    )

    def fake_cleaned_image(
        image_bytes: bytes,
        items: list[dict],
        supplemental_masks: list[dict],
    ) -> str:
        captured.update(image_bytes=image_bytes, items=items, masks=supplemental_masks)
        return "data:image/png;base64,AA=="

    monkeypatch.setattr(server, "build_cleaned_image_data_url", fake_cleaned_image)
    response = asyncio.run(
        server.ocr(server.OcrRequest(
            image="placeholder",
            return_cleaned_image=True,
            cleaned_masks=masks,
            cleaned_mask_token="mask-token-a",
        ))
    )

    assert response["items"] == recognized
    assert response["ocrGeometryVersion"] == server.OCR_GEOMETRY_CONTRACT_VERSION
    assert response["cleanedMaskToken"] == "mask-token-a"
    assert captured == {"image_bytes": b"image", "items": recognized, "masks": masks}

def test_ocr_request_acknowledges_cleaned_artifact_with_empty_masks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server

    cleaned_calls: list[tuple[bytes, list[dict], list[dict]]] = []
    raw_items = [{"text": "raw", "box": {"left": 1, "top": 2, "width": 3, "height": 4}}]
    monkeypatch.setattr(server, "PADDLE_IMPORT_ERROR", None)
    monkeypatch.setattr(server, "decode_data_url", lambda _value: b"image")
    monkeypatch.setattr(
        server,
        "run_ocr",
        lambda *_args: {
            "items": [],
            "boxes": [],
            "regions": [],
            "imageWidth": 100,
            "imageHeight": 100,
            "rawItems": raw_items,
            "counts": {},
        },
    )

    def fake_cleaned_image(image_bytes: bytes, items: list[dict], masks: list[dict]) -> str:
        cleaned_calls.append((image_bytes, items, masks))
        return ""

    monkeypatch.setattr(server, "build_cleaned_image_data_url", fake_cleaned_image)

    response = asyncio.run(
        server.ocr(server.OcrRequest(
            image="placeholder",
            return_cleaned_image=True,
            cleaned_mask_token="artifact-token-empty-mask",
        ))
    )

    assert response["cleanedMaskToken"] == "artifact-token-empty-mask"
    assert "cleanedImage" not in response
    assert response["imageWidth"] == 100
    assert response["imageHeight"] == 100
    assert response["rawItems"] == raw_items
    assert cleaned_calls == [(b"image", [], [])]

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
    assert server.relative_luminance(items[0]["text_color"]) < 0.02
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

def test_cleaned_image_applies_supplemental_cross_page_mask() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    image = Image.new("RGB", (160, 100), "#c33b22")
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 28, 130, 64), fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    masks = [{
        "coordinateSpace": "percent",
        "box": {"x": 18.75, "y": 28, "w": 62.5, "h": 36},
    }]

    binary_mask = server.build_complex_text_inpaint_mask((100, 160), [], masks)
    assert binary_mask is not None
    assert int(binary_mask[46, 80]) == 255
    assert int(binary_mask[27, 80]) == 0
    assert int(binary_mask[65, 80]) == 0
    assert int(binary_mask[46, 29]) == 0
    assert int(binary_mask[46, 131]) == 0
    assert int(binary_mask[5, 5]) == 0

    boundary_mask = server.build_complex_text_inpaint_mask((100, 160), [], [
        {"coordinateSpace": "percent", "box": {"x": 30, "y": 0, "w": 20, "h": 10}},
        {"coordinateSpace": "percent", "box": {"x": 30, "y": 90, "w": 20, "h": 10}},
    ])
    assert boundary_mask is not None
    assert int(boundary_mask[0, 80]) == 255
    assert int(boundary_mask[99, 80]) == 255

    cleaned = server.build_cleaned_image_data_url(buffer.getvalue(), [], masks)
    assert cleaned and cleaned.startswith("data:image/png;base64,")
    payload = base64.b64decode(cleaned.split(",", 1)[1])
    decoded = server.cv2.imdecode(server.np.frombuffer(payload, dtype=server.np.uint8), server.cv2.IMREAD_COLOR)
    assert decoded is not None
    assert int(decoded[46, 80].sum()) > 100
    assert decoded[5, 5].tolist() == [0x22, 0x3B, 0xC3]

def test_final_supplemental_polygon_replaces_provisional_raw_ocr_mask() -> None:
    import server

    if not server.CV2_AVAILABLE:
        pytest.skip("OpenCV unavailable")
    items = [{
        "text": "left",
        "box": {"left": 10, "top": 20, "width": 30, "height": 20},
        "polygon": [[10, 20], [40, 20], [40, 40], [10, 40]],
        "region_id": "",
    }]
    supplemental_masks = [{
        "coordinateSpace": "percent",
        "polygon": [{"x": 60, "y": 50}, {"x": 90, "y": 50}, {"x": 80, "y": 80}],
    }]

    binary_mask = server.build_complex_text_inpaint_mask((100, 100), items, supplemental_masks)

    assert binary_mask is not None
    assert int(binary_mask[30, 25]) == 0
    assert int(binary_mask[60, 75]) == 255
    assert int(binary_mask[5, 5]) == 0

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
    assert server.relative_luminance(items[0]["text_color"]) < 0.02
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
    assert server.relative_luminance(black_items[0]["text_color"]) > 0.9
    assert black_items[0]["stroke_color"] == "#000000"

    beige_items = [
        {"text": "line-1", "box": {"left": 110, "top": 135, "width": 400, "height": 48}},
        {"text": "line-2", "box": {"left": 205, "top": 185, "width": 210, "height": 52}},
        {"text": "line-3", "box": {"left": 145, "top": 240, "width": 305, "height": 56}},
    ]
    beige_regions = server.annotate_visual_regions(required[1].read_bytes(), beige_items)
    assert beige_regions == []
    assert {item["region_type"] for item in beige_items} == {"effect_text"}
    assert all(server.relative_luminance(item["text_color"]) < 0.02 for item in beige_items)
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

def test_near_square_hangul_geometry_keeps_its_horizontal_text_axis() -> None:
    import server

    # 真实现场中的单个方形韩文字形：上边仅轻微倾斜，侧边更长但不代表阅读方向。
    polygon = [[522, 986], [556, 981], [562, 1025], [529, 1030]]

    assert -15 < server.polygon_rotation_deg(polygon) < 0
    assert server.is_confident_vertical_crop(40, 49) is False
    assert server.is_confident_vertical_crop(40, 80) is True

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
