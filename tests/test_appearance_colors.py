"""服务端配色必须与扩展侧 extension/src/rendering/bubble-colors.js 同口径。

现场缺陷（RIDI 旁白）：原图是蓝字白边，扩展渲染成黑字白边。原因是服务端
`choose_readable_text_colors` 只看对比度 ≥ 4.5，复杂插画背景上蓝字到不了 4.5，
于是被判成"不可读"，改写成黑字。扩展侧同函数保留了彩色墨色，两边口径不一致。

后续缺陷（同一现场的第 8 话）：墨色主色按"像素数最多的量化桶"挑选，而白描边
像素数恒大于彩色笔画像素数，于是"墨色=白描边"，choose_readable_text_colors
只能退回黑白。两端同口径修复：按像素数降序取第一个与背景对比度 >= 2 的桶。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "local-ocr-service"))


def test_coloured_ink_survives_a_low_contrast_complex_background() -> None:
    import server

    # 旁白蓝字 + 复杂背景：对比度不足 4.5，但色度足够高，必须保留原墨色。
    assert 2.2 <= server.contrast_ratio("#1e3cd2", "#aaa096") < 4.5
    text, stroke = server.choose_readable_text_colors("#1e3cd2", "#aaa096")

    assert text == "#1e3cd2"
    assert stroke == "#ffffff"


def test_grey_ink_still_falls_back_to_a_readable_black_or_white() -> None:
    import server

    text, stroke = server.choose_readable_text_colors("#7a7a7a", "#a0a0a0")

    assert server.color_chroma("#7a7a7a") == 0
    assert text in {"#000000", "#ffffff"}
    assert stroke in {"#000000", "#ffffff"}


def test_high_contrast_ink_is_kept_regardless_of_chroma() -> None:
    import server

    text, _ = server.choose_readable_text_colors("#333333", "#ffffff")

    assert text == "#333333"


def test_color_chroma_is_the_rgb_spread() -> None:
    import server

    assert server.color_chroma("#1e3cd2") == 0xD2 - 0x1E
    assert server.color_chroma("#808080") == 0


def _flat_image(width: int, height: int, bgr: tuple[int, int, int]):
    import numpy as np

    image = np.empty((height, width, 3), dtype=np.uint8)
    image[:] = bgr
    return image


def _fill(image, left: int, top: int, right: int, bottom: int, bgr: tuple[int, int, int]) -> None:
    image[top:bottom, left:right] = bgr


def test_white_outline_cannot_hijack_the_ink_dominant_color() -> None:
    """RIDI 现场形态：白描边像素数远大于饱和蓝笔画，旧逻辑按像素数选中白。"""
    import server

    background = (211, 207, 208)  # #d0cfd3 的 BGR
    white = (255, 255, 255)
    blue = (205, 89, 55)  # #3759cd 的 BGR
    image = _flat_image(200, 150, background)
    # 与扩展侧测试同几何：box {left:20,top:20,w:160,h:110}，每个 8x8 cell
    # 外圈 2px 白描边、中心 2x2 蓝笔画（白 ~9600 像素 vs 蓝 ~640 像素）。
    for cell_y in range(33, 113, 8):
        for cell_x in range(33, 161, 8):
            for dy in range(8):
                for dx in range(8):
                    inside_blue = 3 <= dx < 5 and 3 <= dy < 5
                    image[cell_y + dy, cell_x + dx] = blue if inside_blue else white

    # 门槛前提：白描边桶与背景对比度不足 2，蓝笔画桶 >= 2。
    assert server.contrast_ratio('#fcfcfc', '#d0cfd3') < 2
    assert server.contrast_ratio('#3c54cc', '#d0cfd3') >= 2

    ink = server.sample_text_ink_color(
        image, None, {'left': 20, 'top': 20, 'width': 160, 'height': 110}, '#d0cfd3')
    # 旧逻辑按像素数取桶会返回白描边的桶中心 #fcfcfc。
    assert ink != '#fcfcfc'
    assert server.color_chroma(ink) >= 40, "必须选中彩色笔画而不是白描边"
    # 蓝笔画桶中心：55//24=2→60、89//24=3→84、205//24=8→204（BGR）→ #3c54cc。
    assert ink == '#3c54cc'
    text, stroke = server.choose_readable_text_colors(ink, '#d0cfd3')
    assert text == ink, "彩色墨色必须被保留，不能再压成黑字"
    assert stroke == '#ffffff'


def test_all_buckets_below_contrast_threshold_fall_back_to_pixel_majority() -> None:
    """两个墨色桶与背景对比度都不足 2 时，回退旧行为：像素数最多者的桶中心。"""
    import server

    image = _flat_image(200, 150, (244, 240, 240))  # #f0f0f4 的 BGR
    _fill(image, 30, 30, 100, 80, (212, 208, 208))  # #d0d0d4 大块
    _fill(image, 120, 100, 150, 120, (188, 184, 184))  # #b8b8bc 小块
    # 桶中心口径：208//24=8→204(#cc)、184//24=7→180(#b4)。
    assert server.contrast_ratio('#cccccc', '#f0f0f4') < 2
    assert server.contrast_ratio('#b4b4b8', '#f0f0f4') < 2
    ink = server.sample_text_ink_color(
        image, None, {'left': 0, 'top': 0, 'width': 200, 'height': 150}, '#f0f0f4')
    assert ink == '#cccccc', "全部桶过不了门槛时回退像素数最多者（可读性交给 choose_readable_text_colors）"


def test_black_ink_on_white_behaves_as_before() -> None:
    """黑字白底：唯一高对比桶就是主色，行为与修复前完全一致。"""
    import server

    image = _flat_image(40, 20, (250, 250, 250))
    _fill(image, 8, 5, 32, 15, (0, 0, 0))
    ink = server.sample_text_ink_color(
        image, None, {'left': 0, 'top': 0, 'width': 40, 'height': 20}, '#fafafa')
    # 黑桶对比度 ~19，降序第一名即目标；桶中心 0//24=0 → +12 → #0c0c0c（现行口径不变）。
    assert ink == '#0c0c0c'
    text, stroke = server.choose_readable_text_colors(ink, '#fafafa')
    assert text == ink
    assert stroke == '#ffffff'


def test_pink_strokes_win_over_white_outline_on_dark_background() -> None:
    """RIDI 第 8 话「这幅肖像画」现场形态：深紫背景上白描边 contrast 15.6 轻松
    过 v2 门槛且像素最多（v2 对比度过滤反而放大它），v3 白描边守卫必须让位给
    色度最高的艳粉笔画。与扩展侧 bubble_colors.test.mjs 同几何布局。"""
    import server

    image = _flat_image(200, 150, (47, 15, 61))  # #3d0f2f 的 BGR
    _fill(image, 18, 18, 118, 68, (254, 251, 254))  # 白描边 #fefbfe（5000px，TOP）
    _fill(image, 18, 68, 118, 88, (107, 57, 132))  # #84396b（2000px）
    _fill(image, 18, 88, 93, 108, (152, 3, 245))  # 艳粉笔画 #f50398（1500px）
    _fill(image, 93, 88, 153, 108, (148, 7, 233))  # #e90794（1200px）
    _fill(image, 153, 88, 180, 108, (255, 230, 254))  # #ffe6fe（540px，桶中心 chroma 24 < 40）
    _fill(image, 18, 108, 68, 128, (132, 79, 159))  # #9f4f84（1000px）
    _fill(image, 68, 108, 108, 128, (133, 43, 193))  # #c12b85（800px）
    _fill(image, 108, 108, 168, 128, (84, 40, 106))  # #6a2854（1200px，contrast 1.54 < 2）

    # 门槛前提：白描边桶中心 #fcfcfc contrast ~15.6（v2 挡不住），艳粉桶中心
    # #fc0c9c contrast ~4.3 且 chroma 240。
    assert server.contrast_ratio('#fcfcfc', '#3d0f2f') >= 2
    assert server.contrast_ratio('#fc0c9c', '#3d0f2f') >= 2
    assert server.color_chroma('#fc0c9c') >= 40

    ink = server.sample_text_ink_color(
        image, None, {'left': 0, 'top': 0, 'width': 200, 'height': 150}, '#3d0f2f')
    # 白描边守卫：彩色候选像素合计 6500 >= 白描边 5000 → 让位给色度最高者。
    assert ink == '#fc0c9c', "艳粉笔画桶中心必须胜出（旧逻辑返回白描边的 #fcfcfc）"
    text, stroke = server.choose_readable_text_colors(ink, '#3d0f2f')
    assert text == ink, "粉字必须保留，不能再渲染成白字"
    assert stroke == '#ffffff', "深底粉字配白描边，而不是黑描边"


def test_warm_white_outline_does_not_trigger_the_guard() -> None:
    """暖白 #ffe0c0：桶中心 #fce4cc chroma 48 >= 20（扩展端均值色 min 通道
    192 < 200）—— 两端挂的条件不同但结果一致：都不是无彩近白，守卫不触发，
    维持 TOP，彩色小桶不能抢走它。"""
    import server

    image = _flat_image(200, 150, (47, 15, 61))  # #3d0f2f 的 BGR
    _fill(image, 18, 18, 118, 68, (192, 224, 255))  # 暖白 #ffe0c0（5000px，TOP，contrast 13.1）
    _fill(image, 18, 88, 93, 108, (152, 3, 245))  # 艳粉 #f50398（1500px）

    ink = server.sample_text_ink_color(
        image, None, {'left': 0, 'top': 0, 'width': 200, 'height': 150}, '#3d0f2f')
    assert ink == '#fce4cc', "暖白不是无彩近白，守卫不触发（桶中心口径）"


def test_gradient_red_strokes_win_on_medium_grey_blue_background() -> None:
    """RIDI 第 8 话「30年前袭击地球的'地下城'正是」现场形态：背景 #60778f 中灰
    蓝，红笔画与背景亮度几乎相同（ct 1.0~1.8）被 v2 的 ct>=2 全跳过；白描边
    ct 4.5 当选。v4 判别尺 = 色度 + 与背景 RGB 距离 + 像素数。与扩展侧
    bubble_colors.test.mjs 同几何布局。"""
    import server

    image = _flat_image(200, 150, (143, 119, 96))  # #60778f 的 BGR
    _fill(image, 18, 18, 118, 68, (254, 251, 253))  # 白描边 #fdfbfe（5000px，TOP，ct 4.5）
    _fill(image, 118, 18, 153, 38, (250, 231, 253))  # #fde7fa（700px，桶中心 chroma 24 < 40）
    _fill(image, 18, 68, 78, 88, (90, 5, 204))  # 红 #cc055a（1200px，桶中心 chroma 192，dist 163）
    _fill(image, 78, 68, 128, 88, (81, 8, 178))  # 红 #b20851（1000px，桶中心 chroma 168，dist 115）
    _fill(image, 128, 68, 168, 88, (101, 5, 229))  # 红 #e50565（800px，桶中心 chroma 216，dist 137）
    _fill(image, 18, 88, 68, 108, (68, 4, 155))  # 暗红 #9b0444（1000px，桶中心 chroma 144，dist 156）
    _fill(image, 68, 88, 108, 108, (14, 11, 5))  # #050b0e（800px，桶中心 chroma 0 < 40）
    _fill(image, 108, 88, 148, 108, (55, 39, 15))  # 暗蓝 AA #0f2737（800px，桶中心 chroma 48）
    _fill(image, 148, 88, 178, 108, (81, 62, 35))  # 暗蓝 AA #233e51（600px，桶中心 chroma 48）
    _fill(image, 18, 108, 28, 118, (105, 2, 243))  # #f30269（100px，chroma 240 但 < 4% × TOP 被挡）

    # 门槛前提：红笔画与背景亮度几乎相同（亮度判别尺失效），色度才是判别器；
    # 白描边桶中心 #fcfcfc 触发守卫。
    assert server.contrast_ratio('#e40c6c', '#60778f') < 2.2
    assert server.color_chroma('#e40c6c') >= 40
    assert server.contrast_ratio('#fcfcfc', '#60778f') >= 2

    ink = server.sample_text_ink_color(
        image, None, {'left': 0, 'top': 0, 'width': 200, 'height': 150}, '#60778f')
    # 守卫让位给色度最高的红桶（不比总量：厚描边下彩色合计远小于白桶）。
    assert ink == '#e40c6c', "红笔画桶中心必须胜出（旧逻辑返回白描边的 #fcfcfc）"
    text, stroke = server.choose_readable_text_colors(ink, '#60778f')
    assert text == ink, "红字必须保留（ct 1.0 < 2.2，靠色度线保留）"
    assert stroke == '#ffffff', "红字配白描边，与原图一致"
