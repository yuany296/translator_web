"""生成 Kakao canonical 管线使用的匿名相邻页夹具。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
WIDTH = 720
HEIGHT = 1080
SEAM_BAND_HEIGHT = 160


def load_font(size: int) -> ImageFont.FreeTypeFont:
    configured = os.environ.get("KAKAO_FIXTURE_FONT", "").strip()
    candidates = [
        configured,
        r"C:\Windows\Fonts\malgun.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size=size)
    raise RuntimeError(
        "未找到韩文字体；请通过 KAKAO_FIXTURE_FONT 指向 Malgun Gothic 或 Noto Sans CJK。"
    )


def centered_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int] = (25, 25, 28),
) -> None:
    left, top, right, bottom = box
    text_box = draw.textbbox((0, 0), text, font=font)
    text_width = text_box[2] - text_box[0]
    text_height = text_box[3] - text_box[1]
    x = left + (right - left - text_width) / 2
    y = top + (bottom - top - text_height) / 2 - text_box[1]
    draw.text((x, y), text, font=font, fill=fill)


def draw_page_frame(draw: ImageDraw.ImageDraw, page_label: str) -> None:
    draw.rectangle((0, 0, WIDTH - 1, HEIGHT - 1), fill=(239, 239, 235), outline=(35, 35, 38), width=4)
    draw.rectangle((30, 28, WIDTH - 30, 300), fill=(210, 216, 220), outline=(55, 55, 60), width=4)
    draw.line((40, 290, WIDTH - 40, 45), fill=(145, 150, 155), width=5)
    draw.rectangle((30, 320, WIDTH - 30, 760), fill=(222, 218, 210), outline=(55, 55, 60), width=4)
    draw.rectangle((30, 780, WIDTH - 30, HEIGHT - 1), fill=(205, 211, 214), outline=(55, 55, 60), width=4)
    draw.text((45, 45), page_label, font=load_font(20), fill=(75, 75, 80))


def build_page_a() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (239, 239, 235))
    draw = ImageDraw.Draw(image)
    draw_page_frame(draw, "SYNTHETIC PAGE A")

    draw.rounded_rectangle((120, 420, 600, 585), radius=72, fill=(255, 255, 252), outline=(32, 32, 35), width=5)
    centered_text(draw, (140, 438, 580, 565), "독립 대사입니다.", load_font(38))

    # 气泡跨出页面底边，模拟上页只保留前半句的真实接缝场景。
    draw.ellipse((105, 915, 615, 1195), fill=(255, 255, 252), outline=(32, 32, 35), width=5)
    centered_text(draw, (135, 965, 585, 1060), "오늘은 반드시", load_font(36))

    # 低置信度英文字母用于 filtered observation，不参与 canonical。
    draw.text((668, 1018), "A", font=load_font(14), fill=(145, 145, 148))
    return image


def build_page_b() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (239, 239, 235))
    draw = ImageDraw.Draw(image)
    draw_page_frame(draw, "SYNTHETIC PAGE B")

    # 与 A 页底部使用相同几何和配色；画布裁切后只显示后半个气泡。
    draw.ellipse((105, -120, 615, 165), fill=(255, 255, 252), outline=(32, 32, 35), width=5)
    centered_text(draw, (135, 8, 585, 112), "끝까지 가자!", load_font(36))

    draw.rounded_rectangle((115, 450, 605, 620), radius=74, fill=(255, 255, 252), outline=(32, 32, 35), width=5)
    centered_text(draw, (135, 468, 585, 600), "두 번째 독립 대사.", load_font(34))
    return image


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def observation(
    observation_id: str,
    source_type: str,
    page_ids: list[str],
    revisions: dict[str, str],
    spans: list[dict[str, object]],
    text: str,
    confidence: float,
    region_id: str,
    provider_block_id: str,
) -> dict[str, object]:
    return {
        "id": observation_id,
        "sourceType": source_type,
        "pageIds": page_ids,
        "imageRevisionByPage": revisions,
        "pageSpans": spans,
        "originalText": text,
        "confidence": confidence,
        "visual": {
            "bgType": "solid",
            "bgColor": "#fffffc",
            "bgConfidence": 0.99,
            "regionId": region_id,
            "regionType": "speech_bubble",
            "polygon": None,
            "regionPolygon": None,
            "rotationDeg": 0,
            "sourceLineCount": 1,
        },
        "providerBlockId": provider_block_id,
    }


def build_golden(page_a_revision: str, page_b_revision: str) -> dict[str, object]:
    revisions = {
        "fixture-page-a": page_a_revision,
        "fixture-page-b": page_b_revision,
    }
    page_a_interior = observation(
        "obs-page-a-interior",
        "page",
        ["fixture-page-a"],
        {"fixture-page-a": page_a_revision},
        [{"pageId": "fixture-page-a", "box": {"x": 18.0, "y": 39.5, "w": 64.0, "h": 14.5}, "polygon": None, "overlapRatio": 1.0}],
        "독립 대사입니다.",
        0.99,
        "region-page-a-interior",
        "block-page-a-interior",
    )
    page_a_bottom = observation(
        "obs-page-a-bottom-half",
        "page",
        ["fixture-page-a"],
        {"fixture-page-a": page_a_revision},
        [{"pageId": "fixture-page-a", "box": {"x": 18.5, "y": 89.5, "w": 63.0, "h": 9.0}, "polygon": None, "overlapRatio": 1.0}],
        "오늘은 반드시",
        0.96,
        "region-boundary-dialogue",
        "block-page-a-bottom-half",
    )
    page_b_top = observation(
        "obs-page-b-top-half",
        "page",
        ["fixture-page-b"],
        {"fixture-page-b": page_b_revision},
        [{"pageId": "fixture-page-b", "box": {"x": 18.5, "y": 0.5, "w": 63.0, "h": 10.0}, "polygon": None, "overlapRatio": 1.0}],
        "끝까지 가자!",
        0.97,
        "region-boundary-dialogue",
        "block-page-b-top-half",
    )
    page_b_interior = observation(
        "obs-page-b-interior",
        "page",
        ["fixture-page-b"],
        {"fixture-page-b": page_b_revision},
        [{"pageId": "fixture-page-b", "box": {"x": 17.0, "y": 42.5, "w": 66.0, "h": 15.0}, "polygon": None, "overlapRatio": 1.0}],
        "두 번째 독립 대사.",
        0.99,
        "region-page-b-interior",
        "block-page-b-interior",
    )
    seam_complete = observation(
        "obs-seam-complete",
        "seam",
        ["fixture-page-a", "fixture-page-b"],
        revisions,
        [
            {"pageId": "fixture-page-a", "box": {"x": 18.5, "y": 89.5, "w": 63.0, "h": 10.5}, "polygon": None, "overlapRatio": 0.48},
            {"pageId": "fixture-page-b", "box": {"x": 18.5, "y": 0.0, "w": 63.0, "h": 11.0}, "polygon": None, "overlapRatio": 0.52},
        ],
        "오늘은 반드시 끝까지 가자!",
        0.995,
        "region-boundary-dialogue",
        "block-seam-complete",
    )
    filtered_noise = observation(
        "obs-page-a-filtered-noise",
        "page",
        ["fixture-page-a"],
        {"fixture-page-a": page_a_revision},
        [{"pageId": "fixture-page-a", "box": {"x": 92.7, "y": 94.0, "w": 1.1, "h": 1.4}, "polygon": None, "overlapRatio": 1.0}],
        "A",
        0.18,
        "",
        "block-page-a-filtered-noise",
    )
    filtered_noise["filterReason"] = "meaningless-alphabetic-final"

    return {
        "schemaVersion": "kakao-canonical-fixture-v1",
        "synthetic": True,
        "chapterId": "fixture-chapter-canonical",
        "description": "完全合成的匿名相邻页：两条页内对白、一条跨页对白和一条过滤噪声。",
        "pages": [
            {"pageId": "fixture-page-a", "image": "page-a.png", "width": WIDTH, "height": HEIGHT, "imageRevision": page_a_revision, "shortPage": False},
            {"pageId": "fixture-page-b", "image": "page-b.png", "width": WIDTH, "height": HEIGHT, "imageRevision": page_b_revision, "shortPage": False},
        ],
        "seam": {
            "pairId": "fixture-page-a--fixture-page-b",
            "bandHeight": SEAM_BAND_HEIGHT,
            "pageIds": ["fixture-page-a", "fixture-page-b"],
            "imageRevisionByPage": revisions,
        },
        "ocr": {
            "page": [
                {
                    "pageId": "fixture-page-a",
                    "observations": [page_a_interior, page_a_bottom],
                    "filteredObservations": [filtered_noise],
                    "edgeSignals": {
                        "bandHeight": SEAM_BAND_HEIGHT,
                        "top": {"detected": False, "retainedObservationIds": [], "filteredObservationIds": [], "visualDetected": False},
                        "bottom": {"detected": True, "retainedObservationIds": ["obs-page-a-bottom-half"], "filteredObservationIds": ["obs-page-a-filtered-noise"], "visualDetected": True},
                        "hasAny": True,
                    },
                },
                {
                    "pageId": "fixture-page-b",
                    "observations": [page_b_top, page_b_interior],
                    "filteredObservations": [],
                    "edgeSignals": {
                        "bandHeight": SEAM_BAND_HEIGHT,
                        "top": {"detected": True, "retainedObservationIds": ["obs-page-b-top-half"], "filteredObservationIds": [], "visualDetected": True},
                        "bottom": {"detected": False, "retainedObservationIds": [], "filteredObservationIds": [], "visualDetected": False},
                        "hasAny": True,
                    },
                },
            ],
            "seam": {
                "observations": [seam_complete],
                "filteredObservations": [],
            },
        },
        "expected": {
            "canonicalBubbles": [
                {
                    "id": "canonical-page-a-interior",
                    "revision": 1,
                    "supersedesId": None,
                    "memberObservationIds": ["obs-page-a-interior"],
                    "originalText": "독립 대사입니다.",
                    "status": "ready",
                },
                {
                    "id": "canonical-page-a-bottom-half",
                    "revision": 1,
                    "supersedesId": None,
                    "memberObservationIds": ["obs-page-a-bottom-half", "obs-page-b-top-half", "obs-seam-complete"],
                    "originalText": "오늘은 반드시 끝까지 가자!",
                    "status": "ready",
                },
                {
                    "id": "canonical-page-b-interior",
                    "revision": 1,
                    "supersedesId": None,
                    "memberObservationIds": ["obs-page-b-interior"],
                    "originalText": "두 번째 독립 대사.",
                    "status": "ready",
                },
            ],
            "ledger": {
                "obs-page-a-interior": {"resolution": "standalone", "canonicalId": "canonical-page-a-interior"},
                "obs-page-a-bottom-half": {"resolution": "consumed", "canonicalId": "canonical-page-a-bottom-half"},
                "obs-page-b-top-half": {"resolution": "consumed", "canonicalId": "canonical-page-a-bottom-half"},
                "obs-seam-complete": {"resolution": "consumed", "canonicalId": "canonical-page-a-bottom-half"},
                "obs-page-b-interior": {"resolution": "standalone", "canonicalId": "canonical-page-b-interior"},
                "obs-page-a-filtered-noise": {"resolution": "filtered", "filterReason": "meaningless-alphabetic-final"},
            },
        },
    }


def main() -> None:
    page_a_path = ROOT / "page-a.png"
    page_b_path = ROOT / "page-b.png"
    build_page_a().save(page_a_path, format="PNG", compress_level=9, optimize=False)
    build_page_b().save(page_b_path, format="PNG", compress_level=9, optimize=False)

    golden = build_golden(sha256(page_a_path), sha256(page_b_path))
    (ROOT / "ocr-golden.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
