from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    out_dir = Path("tests/fixtures/ocr")
    out_dir.mkdir(parents=True, exist_ok=True)
    font_regular = ImageFont.truetype(r"C:\Windows\Fonts\malgun.ttf", 34)
    font_bold = ImageFont.truetype(r"C:\Windows\Fonts\malgunbd.ttf", 38)
    small_font = ImageFont.truetype(r"C:\Windows\Fonts\malgun.ttf", 24)

    make_comment_fixture(out_dir / "korean_comment.png", font_regular, font_bold, small_font)
    make_comment_recovery_fixture(out_dir / "korean_comment_six_lines.png", font_regular)
    make_dialogue_fixture(out_dir / "korean_dialogue.png", font_regular, font_bold)
    make_overlay_fixture(out_dir / "korean_overlay_contaminated.png", font_regular, font_bold, small_font)


def make_comment_fixture(path: Path, font_regular: ImageFont.ImageFont, font_bold: ImageFont.ImageFont, small_font: ImageFont.ImageFont) -> None:
    image = Image.new("RGB", (1080, 760), (245, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([60, 60, 1020, 300], radius=8, fill=(255, 255, 255), outline=(20, 20, 20), width=3)
    draw.ellipse([100, 105, 170, 175], fill=(153, 165, 165))
    draw.text((205, 105), "@odssfdt · 3분 전", fill=(110, 110, 110), font=small_font)
    draw.text((205, 165), "이때가 김성현 욕 제일로 처먹을 때였지", fill=(0, 0, 0), font=font_bold)
    draw.text((205, 235), "좋아요 3935   댓글 100", fill=(135, 135, 135), font=small_font)

    draw.rounded_rectangle([60, 365, 1020, 700], radius=8, fill=(255, 255, 255), outline=(20, 20, 20), width=3)
    draw.ellipse([100, 425, 170, 495], fill=(78, 190, 245))
    draw.text((205, 420), "@히-mew · 1시간 전", fill=(110, 110, 110), font=small_font)
    draw.text((205, 485), "학폭 논란 플러스 대환장 마이너스 투표탓에", fill=(0, 0, 0), font=font_bold)
    draw.text((205, 540), "투데이 팬들 견제도 장난 아니었다ㅋㅋ", fill=(0, 0, 0), font=font_bold)
    draw.text((205, 620), "답글 7개", fill=(78, 130, 150), font=small_font)
    image.save(path)


def make_comment_recovery_fixture(path: Path, font_regular: ImageFont.ImageFont) -> None:
    """生成同一面板内连续六行评论，覆盖中间行漏检后的恢复场景。"""
    image = Image.new("RGB", (1080, 720), (245, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([70, 45, 1010, 675], radius=12, fill=(255, 255, 255), outline=(35, 35, 35), width=3)
    lines = [
        "첫 번째 댓글은 화면 구성을 설명합니다",
        "두 번째 댓글도 같은 패널 안에 있습니다",
        "세 번째 문장은 중간에서 누락될 수 있습니다",
        "네 번째 문장까지 빠짐없이 찾아야 합니다",
        "다섯 번째 댓글은 복구 결과를 확인합니다",
        "마지막 댓글도 한 번만 번역되어야 합니다",
    ]
    for index, line in enumerate(lines):
        draw.text((125, 90 + index * 92), line, fill=(0, 0, 0), font=font_regular)
    image.save(path)


def make_dialogue_fixture(path: Path, font_regular: ImageFont.ImageFont, font_bold: ImageFont.ImageFont) -> None:
    image = Image.new("RGB", (760, 620), (238, 242, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([90, 80, 670, 250], radius=26, fill=(255, 255, 255), outline=(40, 40, 40), width=4)
    draw.text((150, 125), "오늘은 진짜 아무 말도 하지 마", fill=(0, 0, 0), font=font_bold)
    draw.text((150, 180), "괜히 또 오해받기 싫어", fill=(0, 0, 0), font=font_regular)
    draw.rounded_rectangle([90, 350, 670, 530], radius=26, fill=(255, 255, 255), outline=(40, 40, 40), width=4)
    draw.text((150, 400), "그래도 설명은 해야지", fill=(0, 0, 0), font=font_bold)
    draw.text((150, 455), "다들 기다리고 있잖아", fill=(0, 0, 0), font=font_regular)
    image.save(path)


def make_overlay_fixture(path: Path, font_regular: ImageFont.ImageFont, font_bold: ImageFont.ImageFont, small_font: ImageFont.ImageFont) -> None:
    image = Image.new("RGB", (900, 760), (245, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([60, 60, 840, 700], radius=8, fill=(255, 255, 255), outline=(20, 20, 20), width=3)
    draw.text((155, 130), "한국어 본문은 여기 크게 보여야 합니다", fill=(0, 0, 0), font=font_bold)
    draw.text((155, 190), "번역 오버레이가 있으면 OCR 결과가 오염됩니다", fill=(0, 0, 0), font=font_bold)
    draw.text((155, 250), "그래서 스크린샷 전에 반드시 숨겨야 합니다", fill=(0, 0, 0), font=font_regular)
    draw.rounded_rectangle([405, 116, 520, 165], radius=10, fill=(255, 255, 255), outline=(160, 160, 160), width=2)
    draw.text((425, 123), "第42集", fill=(10, 20, 40), font=small_font)
    draw.rounded_rectangle([470, 442, 540, 520], radius=10, fill=(255, 255, 255), outline=(160, 160, 160), width=2)
    draw.text((490, 455), "喵", fill=(10, 20, 40), font=small_font)
    image.save(path)


if __name__ == "__main__":
    main()
