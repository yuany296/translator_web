import * as coverGeometry from "../../rendering/cover-geometry.js";

export function installLifecycleCover(runtime) {
  function resolveBubbleCoverBox(bubble) {
    const allowVerticalOverflow = bubble && bubble.stitch_overflow === true;
    const polygonBox = runtime.resolveBubblePolygonBox(bubble && bubble.polygon, allowVerticalOverflow);
    const blueBox = polygonBox || runtime.normalizeFillBox(bubble, allowVerticalOverflow);
    const fillBox = runtime.normalizeFillBox(bubble && bubble.fill_box, allowVerticalOverflow);
    if (!blueBox) return fillBox;
    if (polygonBox) return polygonBox;
    if (!fillBox) return blueBox;
    // 蓝框是最终渲染几何。OCR 的背景估计可以比它更大，但覆盖层不能因此
    // 侵入相邻文字框；只保留 fill_box 与最终蓝框的交集。
    const left = Math.max(blueBox.x, fillBox.x);
    const top = Math.max(blueBox.y, fillBox.y);
    const right = Math.min(blueBox.x + blueBox.w, fillBox.x + fillBox.w);
    const bottom = Math.min(blueBox.y + blueBox.h, fillBox.y + fillBox.h);
    return right > left && bottom > top ? {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    } : blueBox;
  }
  runtime.resolveBubbleCoverBox = resolveBubbleCoverBox;
  /** 遮罩最终几何：斜排文字用倾斜四边形，轴对齐文字与旧行为完全一致。 */
  function resolveBubbleCoverGeometry(bubble, options = {}) {
    const allowVerticalOverflow = bubble && bubble.stitch_overflow === true;
    const box = Object.prototype.hasOwnProperty.call(options, "box")
      ? options.box : resolveBubbleCoverBox(bubble);
    return coverGeometry.resolveCoverQuad({
      polygon: runtime.normalizeBubblePolygon(bubble && bubble.polygon, allowVerticalOverflow),
      rotationDeg: runtime.resolveBubbleRotation(bubble),
      box: box || runtime.normalizeFillBox(bubble, allowVerticalOverflow),
      padding: runtime.state.coverPadding
    });
  }
  runtime.resolveBubbleCoverGeometry = resolveBubbleCoverGeometry;
  function buildBubbleCoverProjection(bubble) {
    // 覆盖节点的盒子始终是最终蓝框：清理图补丁按页面坐标映射，蓝框保证补丁与
    // 页面一一对应；倾斜/外扩的可见范围由 createBubbleCoverClipNode 的裁剪层
    // 单独承担（它用 resolveBubbleCoverGeometry 得到外接框与四边形）。
    // 这里必须原样保留 rotation_deg 与 polygon，裁剪层才能跟着原文倾角走。
    //
    // region_polygon 同样必须保留：实底（bg_type=solid）遮罩唯一的可信轮廓就是它
    // （见 rendering/cover-geometry.js 的 resolveSolidFillOutline）。以前在这里把它
    // 清空，lifecycle-bubble 就写不出 --mt-region-clip，纯色填充退回 inset(0) 铺满
    // x/y/w/h 包围盒 —— 用户看到的就是弧形气泡边缘长出的矩形白色长条。
    // fill_box 仍然清空：覆盖层盒子已经等于最终蓝框，再与 OCR 的背景估计求并集
    // 只会把覆盖范围撑大。
    const coverBox = resolveBubbleCoverBox(bubble) || {};
    return {
      ...bubble,
      x: coverBox.x != null ? coverBox.x : bubble.x,
      y: coverBox.y != null ? coverBox.y : bubble.y,
      w: coverBox.w != null ? coverBox.w : bubble.w,
      h: coverBox.h != null ? coverBox.h : bubble.h,
      projection_role: "cover_only",
      original_text: "",
      translated_text: "",
      fill_box: null
    };
  }
  runtime.buildBubbleCoverProjection = buildBubbleCoverProjection;
  function createBubbleRenderNodes(bubble, index, options = {}) {
    const role = String(bubble && bubble.projection_role || "text_primary");
    const coverBubble = buildBubbleCoverProjection(bubble);
    const coverNode = runtime.createBubbleNode(coverBubble, index, options);
    const textNode = role === "cover_only" ? null : runtime.createBubbleNode(bubble, index, {
      ...options,
      textOnly: true
    });
    return { coverNode, textNode };
  }
  runtime.createBubbleRenderNodes = createBubbleRenderNodes;
}
