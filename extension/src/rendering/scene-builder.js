import { buildPlacementGeometry, groupPlacementRegions } from "../layout/placement.js";
import { layoutInPlacement } from "../layout/crop-local-layout.js";
import { resolveCoverQuad, resolveTiltRotationDeg } from "./cover-geometry.js";
import { createRenderScene } from "./render-scene.js";

const point = (value) => ({
  x: Number(Array.isArray(value) ? value[0] : value?.x),
  y: Number(Array.isArray(value) ? value[1] : value?.y)
});

function percentPolygon(value, width, height) {
  if (!Array.isArray(value) || value.length < 3) return [];
  return value.map(point).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => ({ x: item.x / 100 * width, y: item.y / 100 * height }));
}

function rectanglePolygon(value, width, height) {
  const x = Number(value?.x || 0) / 100 * width;
  const y = Number(value?.y || 0) / 100 * height;
  const w = Number(value?.w ?? value?.width ?? 0) / 100 * width;
  const h = Number(value?.h ?? value?.height ?? 0) / 100 * height;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function sourceSizeFromVisual(visual) {
  const raw = visual?.rawBox;
  const box = visual?.box;
  const width = Number(raw?.width) / (Number(box?.w) / 100);
  const height = Number(raw?.height) / (Number(box?.h) / 100);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null;
}

/**
 * 成员倾角：rotation_deg/rotationDeg（含 visual 内同义字段）优先；为空时用四边形的
 * 长边兜底。OCR/投影把倾角只写进 polygon 而 rotation_deg 缺失时，场景文字层不能
 * 退回轴对齐，否则遮罩已按四边形倾斜、译文却仍水平。
 */
function resolveMemberRotation(bubble, visual, rawPolygon) {
  const explicit = Number(bubble?.rotation_deg ?? bubble?.rotationDeg ?? visual.rotation_deg ?? visual.rotationDeg);
  return resolveTiltRotationDeg(explicit, [rawPolygon]);
}

function detectedMembers(bubble, surface) {
  const visual = bubble?.visual || {};
  const sourceSize = sourceSizeFromVisual(visual);
  const detected = Array.isArray(visual.detectedRegions) ? visual.detectedRegions : [];
  if (sourceSize && detected.length) {
    const scaleX = surface.width / sourceSize.width;
    const scaleY = surface.height / sourceSize.height;
    const members = detected.map((region, index) => {
      const sourcePolygon = (region.sourcePolygon || []).map(point)
        .map((item) => ({ x: item.x * scaleX, y: item.y * scaleY }));
      return {
        regionId: String(region.regionId || `${bubble.block_id || "region"}:${index}`),
        sourcePolygon,
        // 成员 region 缺 rotationDeg 时同样用成员四边形兜底，而不是回落到 0。
        rotationDeg: resolveTiltRotationDeg(Number(region.rotationDeg), [sourcePolygon]),
        lineThickness: Math.max(1, Number(region.lineThickness) * Math.sqrt(scaleX * scaleY)),
        geometryReliability: region.geometryReliability === "fallback" ? "fallback" : "detected"
      };
    }).filter((region) => region.sourcePolygon.length >= 4);
    if (members.length) return members;
  }
  const polygon = percentPolygon(bubble?.polygon || visual.polygon, surface.width, surface.height);
  const sourcePolygon = polygon.length >= 4 ? polygon : rectanglePolygon(bubble, surface.width, surface.height);
  const percentThickness = Number(bubble?.font_height_percent || visual.fontHeightPercent || visual.font_height_percent);
  const lineThickness = percentThickness > 0
    ? percentThickness / 100 * surface.height
    : Math.min(Number(bubble?.w || 0) / 100 * surface.width, Number(bubble?.h || 0) / 100 * surface.height);
  return [{
    regionId: String(bubble?.region_id || bubble?.block_id || "region"),
    sourcePolygon,
    rotationDeg: resolveMemberRotation(bubble, visual, bubble?.polygon || visual.polygon),
    lineThickness: Math.max(1, lineThickness),
    geometryReliability: visual.geometryReliability === "fallback" ? "fallback" : "detected"
  }];
}

function cleanupGeometry(bubble, surface) {
  const visual = bubble?.visual || {};
  const polygon = bubble?.polygon || visual.polygon || null;
  const box = {
    x: Number(bubble?.x ?? visual.x),
    y: Number(bubble?.y ?? visual.y),
    w: Number(bubble?.w ?? visual.w),
    h: Number(bubble?.h ?? visual.h)
  };
  // 斜排文字的遮罩几何：canvas 渲染器必须按四边形裁剪，否则轴对齐矩形会露出原文。
  // rotation_deg 缺失时同样从四边形取倾角（含 region_polygon 只有轮廓倾斜的现场）。
  // polygon 的百分比空间就是渲染面（surface.width×surface.height），传下去让
  // 「歪没歪」在像素空间判定（见 cover-geometry.js#polygonTiltDeg）。
  const cover = resolveCoverQuad({
    polygon,
    rotationDeg: resolveTiltRotationDeg(
      Number(bubble?.rotation_deg ?? bubble?.rotationDeg ?? visual.rotation_deg ?? visual.rotationDeg),
      [polygon, bubble?.region_polygon, visual.regionPolygon, visual.region_polygon]
    ),
    box,
    padding: 0,
    scaleX: surface?.width,
    scaleY: surface?.height
  });
  return Object.freeze({
    fillBox: bubble?.fill_box || visual.fillBox || null,
    regionPolygon: bubble?.region_polygon || visual.regionPolygon || null,
    textPolygon: polygon,
    coverQuad: cover ? cover.quad : null,
    coverBounds: cover ? cover.bounds : null,
    coverTilted: Boolean(cover && cover.tilted),
    bgType: String(bubble?.bg_type || visual.bgType || "none")
  });
}

function bubbleRegion(bubble, surface) {
  const visual = bubble?.visual || {};
  const confidence = Number(
    bubble?.bg_confidence ?? bubble?.region_confidence ?? visual.bgConfidence ?? visual.regionConfidence
  );
  const reliable = Number.isFinite(confidence) ? confidence >= 0.65 : String(
    bubble?.bg_type || visual.bgType || ""
  ) === "solid";
  if (!reliable) return null;
  const region = percentPolygon(bubble?.region_polygon || visual.regionPolygon, surface.width, surface.height);
  if (region.length >= 3) return { reliable: true, polygon: region };
  const fill = bubble?.fill_box || visual.fillBox;
  if (String(bubble?.bg_type || visual.bgType) === "solid" && fill) {
    return { reliable: true, polygon: rectanglePolygon(fill, surface.width, surface.height) };
  }
  return null;
}

function resolveWritingMode(bubble) {
  const visual = bubble?.visual || {};
  const explicit = String(
    bubble?.writing_mode || bubble?.writingMode || visual.writingMode || visual.writing_mode || ""
  ).toLowerCase();
  if (explicit.startsWith("vertical")) return "vertical";
  return String(bubble?.region_type || visual.regionType || "").toLowerCase().includes("vertical")
    ? "vertical"
    : "horizontal";
}

function dominantPlacementGroup(regions) {
  const groups = groupPlacementRegions(regions);
  return [...groups].sort((left, right) => right.length - left.length ||
    right.reduce((sum, item) => sum + item.lineThickness, 0) -
      left.reduce((sum, item) => sum + item.lineThickness, 0))[0] || [];
}

export function buildBubbleTextLayer(bubble, surface, options = {}) {
  const placement = buildPlacementGeometry(dominantPlacementGroup(detectedMembers(bubble, surface)), {
    id: String(bubble?.canonical_id || bubble?.block_id || "placement"),
    bubbleRegion: bubbleRegion(bubble, surface),
    writingMode: resolveWritingMode(bubble)
  });
  const translatedText = String(bubble?.translated_text || "").trim();
  const originalText = String(bubble?.original_text || bubble?.originalText || "").trim();
  const text = options.displayMode === "bilingual" && originalText && originalText !== translatedText
    ? `${originalText}\n${translatedText}` : translatedText;
  const layout = layoutInPlacement(text, placement, {
    measure: options.measure,
    minFontSize: options.minFontSize || 10,
    maxFontSize: placement.fontHeight,
    padding: options.padding ?? Math.max(1, placement.fontHeight * 0.08)
  });
  const family = String(bubble?.canonical_id || bubble?.region_id || bubble?.block_id || placement.id);
  return {
    id: `${family}:text`, type: layout.status === "ready" ? "text" : "debug",
    canonicalId: String(bubble?.canonical_id || ""), regionFamily: family,
    geometry: { placement }, layout: layout.status === "ready" ? layout : null,
    appearance: {
      color: String(bubble?.text_color || "#111827"),
      strokeColor: String(bubble?.stroke_color || "#ffffff"),
      bgType: String(bubble?.bg_type || "none"),
      fontWeight: Number(bubble?.font_weight || 600)
    },
    content: { bubble },
    diagnostic: layout.status === "layout_unfit" ? { reason: "layout_unfit", canonicalId: family } : null
  };
}

export function buildRenderSceneForBubbles({
  id, surface, bubbles = [], measure, minFontSize, displayMode = "translated"
}) {
  const layers = [];
  const activeFamilies = new Set();
  for (const [index, bubble] of bubbles.entries()) {
    const family = String(bubble?.canonical_id || bubble?.region_id || bubble?.block_id || `bubble:${index}`);
    const explicitCover = String(bubble?.projection_role || "") === "cover_only";
    if (explicitCover) {
      layers.push({ id: `${family}:cover:${index}`, type: "cover", canonicalId: bubble?.canonical_id,
        regionFamily: family, geometry: cleanupGeometry(bubble, surface), content: { bubble } });
      continue;
    }
    if (activeFamilies.has(family)) continue;
    activeFamilies.add(family);
    const textLayer = buildBubbleTextLayer(bubble, surface, { measure, minFontSize, displayMode });
    if (textLayer.type !== "text") {
      layers.push(textLayer);
      continue;
    }
    layers.push({ id: `${family}:cover`, type: "cover", canonicalId: bubble?.canonical_id,
      regionFamily: family, geometry: cleanupGeometry(bubble, surface), content: { bubble } });
    layers.push(textLayer);
  }
  return createRenderScene({ id, surface, layers });
}
