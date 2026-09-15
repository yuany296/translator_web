import { buildRenderSceneForBubbles } from "./scene-builder.js";
import { renderEmbeddedScene } from "./embedded-renderer.js";

function percentBox(value, width, height) {
  const x = Number(value?.x) / 100 * width;
  const y = Number(value?.y) / 100 * height;
  const w = Number(value?.w ?? value?.width) / 100 * width;
  const h = Number(value?.h ?? value?.height) / 100 * height;
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
}

function solidCoverGeometry(geometry, bubble, width, height) {
  // 斜排原文：遮罩按 OCR 四边形裁剪（气泡区域框是轴对齐的，会露出倾斜的字）。
  const quad = Array.isArray(geometry.coverQuad) && geometry.coverTilted ? geometry.coverQuad : null;
  const bounds = quad ? percentBox(geometry.coverBounds, width, height) : null;
  if (quad && bounds) return { clipPoints: quad, bounds };
  return {
    clipPoints: Array.isArray(geometry.regionPolygon) ? geometry.regionPolygon : [],
    bounds: percentBox(geometry.fillBox, width, height) || percentBox(bubble, width, height)
  };
}

function fillSolidCover(context, layer, width, height) {
  const bubble = layer.content?.bubble || {};
  const geometry = layer.geometry || {};
  if (String(geometry.bgType) !== "solid") return;
  const cover = solidCoverGeometry(geometry, bubble, width, height);
  if (!cover.bounds) return;
  const polygon = cover.clipPoints;
  context.save();
  if (polygon.length >= 3) {
    context.beginPath();
    polygon.forEach((value, index) => {
      const x = Number(value?.x) / 100 * width;
      const y = Number(value?.y) / 100 * height;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
    context.clip();
  }
  context.fillStyle = String(bubble.bg_color || "#ffffff");
  context.fillRect(cover.bounds.x, cover.bounds.y, cover.bounds.w, cover.bounds.h);
  context.restore();
}

export function drawEmbeddedBubbleScene(runtime, context, width, height, bubbles) {
  const family = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
  const measure = (text, size) => {
    context.save();
    context.font = `600 ${size}px ${family}`;
    const result = context.measureText(String(text)).width;
    context.restore();
    return result;
  };
  const scene = buildRenderSceneForBubbles({
    id: `embedded:${width}x${height}`,
    surface: { id: "embedded", type: "page", width, height },
    bubbles,
    measure,
    displayMode: runtime.state.displayMode
  });
  const drawText = (ctx, text, x, y, layer) => {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    if (layer.appearance?.bgType === "none") {
      ctx.strokeStyle = layer.appearance?.strokeColor || "#ffffff";
      ctx.lineWidth = runtime.getDynamicStrokeWidth(layer.layout.fontSize);
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = layer.appearance?.color || "#111827";
    ctx.fillText(text, x, y);
  };
  renderEmbeddedScene(scene, context, {
    drawCover(ctx, layer) { fillSolidCover(ctx, layer, width, height); },
    font(layer, size) { return `${layer.appearance?.fontWeight || 600} ${size}px ${family}`; },
    drawText,
    drawVerticalText(ctx, lines, layer) {
      const characters = [...lines.join("")];
      const step = layer.layout.lineHeight;
      const firstY = -((characters.length - 1) * step) / 2;
      characters.forEach((character, index) => drawText(ctx, character, 0, firstY + index * step, layer));
    }
  });
  return scene;
}
