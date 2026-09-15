import { polygonClipPathPercent } from "../../rendering/cover-geometry.js";

export function installRendererCover(runtime) {
  /**
   * 遮罩裁剪层：外层盒子是遮罩四边形的外接框，clip-path 承担倾斜形状。
   * 内层填充节点保持不旋转（沿用最终蓝框坐标系），所以背景色/清理图补丁
   * 与页面坐标一一对应，只有可见范围按原文字形倾斜。
   */
  function createBubbleCoverClipNode(bubble, coverNode) {
    const box = runtime.resolveBubbleCoverBox(bubble) || runtime.normalizeFillBox(bubble, bubble?.stitch_overflow === true);
    if (!coverNode || !box) return coverNode;
    const geometry = runtime.resolveBubbleCoverGeometry(bubble);
    const bounds = geometry && geometry.bounds ? geometry.bounds : box;
    const polygon = runtime.normalizeBubblePolygon(bubble.polygon, bubble?.stitch_overflow === true);
    const rotation = Number(coverNode.dataset.rotationDeg) || 0;
    const clipNode = document.createElement("div");
    clipNode.className = "mt-cover-clip";
    Object.assign(clipNode.dataset, {
      mangaTranslatorOverlay: "true", canonicalId: String(bubble.canonical_id || ""),
      rotationDeg: String(rotation), coverTilted: geometry && geometry.tilted ? "true" : "false"
    });
    clipNode.style.left = `${bounds.x + bounds.w / 2}%`;
    clipNode.style.top = `${bounds.y + bounds.h / 2}%`;
    clipNode.style.width = `${bounds.w}%`;
    clipNode.style.height = `${bounds.h}%`;
    clipNode.style.transform = `translate(-50%, -50%)${polygon || geometry && geometry.tilted ? "" : ` rotate(${rotation.toFixed(2)}deg)`}`;
    clipNode.style.transformOrigin = "center center";
    // 斜排文字绝不能退回轴对齐矩形：只要拿到四边形就用它裁剪，
    // 无倾角时裁剪结果等于原蓝框，视觉与旧版一致。
    const clipPath = geometry ? polygonClipPathPercent(geometry.quad, bounds) : "";
    if (clipPath) clipNode.style.clipPath = clipPath;
    else if (polygon) clipNode.style.clipPath = runtime.buildRegionClipPath(polygon, bounds.x, bounds.y, bounds.w, bounds.h);
    const x = Number(coverNode.dataset.xPercent), y = Number(coverNode.dataset.yPercent), w = Number(coverNode.dataset.wPercent), h = Number(coverNode.dataset.hPercent);
    Object.assign(coverNode.style, {
      left: `${(x + w / 2 - bounds.x) / bounds.w * 100}%`, top: `${(y + h / 2 - bounds.y) / bounds.h * 100}%`,
      width: `${w / bounds.w * 100}%`, height: `${h / bounds.h * 100}%`
    });
    coverNode.style.setProperty("--mt-base-transform", "translate(-50%, -50%)");
    clipNode.appendChild(coverNode);
    return clipNode;
  }
  runtime.createBubbleCoverClipNode = createBubbleCoverClipNode;
}
