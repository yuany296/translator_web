import assert from "node:assert/strict";
import test from "node:test";
import { createConfigurationStore } from "../extension/src/config/store.js";
import glossaryCore from "../extension/src/shared/glossary.js";
import { assertRoundTrip } from "../extension/src/geometry/transforms.js";
import {
  applyVisionRepair, createDetectedTextRegion, createRecognizedTextRegion,
  createSemanticTextBlock
} from "../extension/src/recognition/contracts.js";
import { buildPlacementGeometry } from "../extension/src/layout/placement.js";
import { layoutInPlacement } from "../extension/src/layout/crop-local-layout.js";
import { createRenderScene } from "../extension/src/rendering/render-scene.js";
import { applyDomTextLayer } from "../extension/src/rendering/dom-renderer.js";
import { renderEmbeddedScene } from "../extension/src/rendering/embedded-renderer.js";
import { detectReaderProfile } from "../extension/src/readers/profile.js";
import { ProviderRegistry } from "../extension/src/background/providers/registry.js";

function orientedPolygon(center, axisLength, thickness, angleDeg) {
  const angle = angleDeg * Math.PI / 180;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -axis.y, y: axis.x };
  return [
    [-axisLength / 2, -thickness / 2], [axisLength / 2, -thickness / 2],
    [axisLength / 2, thickness / 2], [-axisLength / 2, thickness / 2]
  ].map(([along, across]) => ({
    x: center.x + axis.x * along + normal.x * across,
    y: center.y + axis.y * along + normal.y * across
  }));
}

function detected(overrides = {}) {
  const sourcePolygon = overrides.sourcePolygon || orientedPolygon({ x: 240, y: 180 }, 380, 42, 20);
  return createDetectedTextRegion({
    regionId: overrides.regionId || "region-1",
    sourcePolygon,
    sourceBox: overrides.sourceBox || { x: 45, y: 95, width: 390, height: 170 },
    rotationDeg: overrides.rotationDeg ?? 20,
    cropSize: { width: 380, height: 42 },
    sourceToCrop: overrides.sourceToCrop || [1, 0, 0, 0, 1, 0, 0, 0, 1],
    cropToSource: overrides.cropToSource || [1, 0, 0, 0, 1, 0, 0, 0, 1],
    lineThickness: overrides.lineThickness ?? 42,
    detectionScore: 0.95,
    geometryReliability: overrides.geometryReliability || "detected"
  });
}

test("crop homography maps detected corners back within one pixel", () => {
  const region = detected({
    sourcePolygon: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }],
    sourceBox: { x: 10, y: 20, width: 100, height: 50 },
    sourceToCrop: [2, 0, -20, 0, 2, -40, 0, 0, 1],
    cropToSource: [0.5, 0, 10, 0, 0.5, 20, 0, 0, 1]
  });
  assert.ok(assertRoundTrip(region, 1) < 1e-9);
});

test("Vision repair can replace recognition only and cannot mutate source geometry", () => {
  const region = detected();
  const recognized = createRecognizedTextRegion(region, {
    text: "weak", confidence: 0.2, language: "ko", appliedOrientation: 180
  });
  const repaired = applyVisionRepair(recognized, { text: "correct", confidence: 0.98, language: "ko" });
  assert.deepEqual(repaired, {
    regionId: region.regionId, text: "correct", confidence: 0.98,
    language: "ko", appliedOrientation: 180
  });
  assert.equal("sourcePolygon" in repaired, false);
  assert.throws(() => { region.rotationDeg = 0; }, TypeError);
});

test("semantic grouping keeps only member region identities as geometry references", () => {
  const block = createSemanticTextBlock({
    id: "block-1", memberRegionIds: ["r1", "r2", "r1"],
    originalText: "one paragraph", sourceBox: { x: 0, y: 0, width: 900, height: 900 }
  });
  assert.deepEqual(block.memberRegionIds, ["r1", "r2"]);
  assert.equal("sourceBox" in block, false);
});

test("20 degree text uses 42px true thickness despite a roughly 170px AABB", () => {
  const placement = buildPlacementGeometry([detected()]);
  assert.ok(Math.abs(placement.rotationDeg - 20) < 0.01);
  assert.ok(Math.abs(placement.normalThickness - 42) < 0.01);
  assert.equal(placement.fontHeight, 42);
  assert.ok(placement.axisLength > 379 && placement.axisLength < 381);
});

test("group rotation uses the reliable median and rejects angles above 25 degrees", () => {
  const placement = buildPlacementGeometry([
    detected({ regionId: "r1", rotationDeg: 10, sourcePolygon: orientedPolygon({ x: 100, y: 100 }, 100, 30, 10), lineThickness: 38 }),
    detected({ regionId: "r2", rotationDeg: 20, sourcePolygon: orientedPolygon({ x: 240, y: 130 }, 100, 30, 20), lineThickness: 42 }),
    detected({ regionId: "r3", rotationDeg: 40, sourcePolygon: orientedPolygon({ x: 380, y: 160 }, 100, 30, 40), lineThickness: 100 })
  ]);
  assert.equal(placement.rotationDeg, 15);
  assert.equal(placement.fontHeight, 42);
});

test("translation length never mutates placement and unfit text is not rendered", () => {
  const placement = Object.freeze({ ...buildPlacementGeometry([detected()]), axisLength: 40, normalThickness: 24 });
  const before = JSON.stringify(placement);
  const layout = layoutInPlacement("这是一个无论如何都放不下的超长翻译文本", placement, {
    minFontSize: 10, measure: (value, size) => [...value].length * size
  });
  assert.equal(layout.status, "layout_unfit");
  assert.equal(JSON.stringify(placement), before);
});

test("RenderScene permits one active text layer per visual region family and keeps covers", () => {
  const placement = buildPlacementGeometry([detected()]);
  const layout = layoutInPlacement("译文", placement, { measure: (value, size) => value.length * size * 0.5 });
  const scene = createRenderScene({
    id: "scene-1", surface: { id: "page-1", type: "page" },
    layers: [
      { id: "cover-1", type: "cover", canonicalId: "c1", regionFamily: "family", geometry: { fullRegion: true } },
      { id: "text-1", type: "text", canonicalId: "c1", regionFamily: "family", layout },
      { id: "text-2", type: "text", canonicalId: "c2", regionFamily: "family", layout }
    ]
  });
  assert.equal(scene.layers.filter((layer) => layer.type === "cover").length, 1);
  assert.equal(scene.layers.filter((layer) => layer.type === "text").length, 1);
});

test("DOM and embedded renderers consume the same placement angle and font size", () => {
  const placement = buildPlacementGeometry([detected()]);
  const layout = layoutInPlacement("译文", placement, { measure: (value, size) => value.length * size * 0.4 });
  const layer = { type: "text", active: true, layout, appearance: { color: "#123456" } };
  const node = { style: {}, textContent: "" };
  assert.equal(applyDomTextLayer(node, layer), true);
  const operations = [];
  const context = {
    save() {}, restore() {}, translate(x, y) { operations.push(["translate", x, y]); },
    rotate(angle) { operations.push(["rotate", angle]); }, set font(value) { operations.push(["font", value]); },
    set fillStyle(value) { operations.push(["color", value]); }
  };
  renderEmbeddedScene({ layers: [layer] }, context, {
    font: (_value, size) => `${size}px sans-serif`, drawText() {}
  });
  assert.equal(node.style.fontSize, `${layout.fontSize}px`);
  assert.ok(node.style.transform.includes(`rotate(${placement.rotationDeg}deg)`));
  assert.ok(Math.abs(operations.find(([name]) => name === "rotate")[1] - placement.rotationDeg * Math.PI / 180) < 1e-9);
});

test("generic domains with the same vertical media structure select the same reader profile", () => {
  const nodes = [0, 1, 2].map((index) => ({
    tagName: "IMG",
    getBoundingClientRect: () => ({ left: 100, top: index * 900, width: 700, height: 900 })
  }));
  const documentValue = {
    querySelectorAll: () => nodes,
    querySelector: () => null
  };
  const first = detectReaderProfile(documentValue, { hostname: "reader.example" });
  const second = detectReaderProfile(documentValue, { hostname: "not-kakao.example" });
  assert.equal(first.type, "continuous-strip");
  assert.equal(second.type, first.type);
  assert.equal(first.siteHint, "generic");
});

test("translation configuration saves independently without changing OCR configuration", async () => {
  const stored = {
    mt_ocr_config_v1: { provider: "baidu", baidu: { apiKey: "ak", secretKey: "sk" } },
    mt_translation_config_v1: { provider: "openai_compatible", apiKey: "old", model: "m1" },
    mt_runtime_config_v1: {},
    [glossaryCore.STORAGE_KEY]: { entries: [] }
  };
  const writes = [];
  const store = createConfigurationStore({
    glossaryCore,
    storageGet: async (keys) => Object.fromEntries(keys.map((key) => [key, stored[key]])),
    storageSet: async (value) => { writes.push(value); Object.assign(stored, value); }
  });
  await store.save("translation", { provider: "openai_compatible", apiKey: "new", model: "m2" });
  assert.deepEqual(Object.keys(writes[0]), ["mt_translation_config_v1"]);
  assert.equal((await store.load()).ocr.provider, "baidu");
  assert.equal((await store.load()).translation.apiKey, "new");
});

test("provider registry rejects combined or incomplete provider contracts", () => {
  const registry = new ProviderRegistry("ocr");
  assert.throws(() => registry.register({ id: "combined" }), /Invalid ocr provider contract/);
  registry.register({
    id: "local_paddle", normalizeConfig() {}, validate() {}, checkHealth() {}, recognize() {}
  });
  assert.deepEqual(registry.ids(), ["local_paddle"]);
  assert.throws(() => registry.get("local_paddle_deepseek"), /Unsupported ocr provider/);
});
