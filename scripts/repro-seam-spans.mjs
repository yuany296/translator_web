import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const root = "C:/homework/translator";
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {}, storage: { local: {} }
  },
  console, fetch, URL, Blob, AbortController, atob,
  crypto: webcrypto, setTimeout, clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, { filename: "background.iife.js" });
const background = context.__backgroundTest;

const seamJson = JSON.parse(fs.readFileSync(path.join(root, ".local-data/debug/result_json/seam-pair_22342d84d059e0fea69bcb42f456544a-page-992f82a21eff83e48370be67628c959b.json"), "utf8"));
const currentJson = JSON.parse(fs.readFileSync(path.join(root, ".local-data/debug/result_json/page-page-919fbf0c408c6cb9bc06e68ebdf4ca6ed3cbabe73208ab5668ef37fc70989eee-48281.json"), "utf8"));

const imageSize = { width: seamJson.imageWidth, height: seamJson.imageHeight };
console.log("seam canvas:", imageSize.width, "x", imageSize.height);

const pageSpans = [{
  pageId: "page-992f82a21eff83e48370be67628c959b8ce3648e2b2c543dd0a5e14d28d53624",
  canvasBox: { x: 0, y: 0, w: 760, h: 96 },
  pageBox: { x: 0, y: 904, w: 760, h: 96 },
  pageWidth: 760, pageHeight: 1000
}, {
  pageId: "page-919fbf0c408c6cb9bc06e68ebdf4ca6ed3cbabe73208ab5668ef37fc70989eee",
  canvasBox: { x: 0, y: 12, w: 760, h: 96 },
  pageBox: { x: 0, y: 0, w: 760, h: 96 },
  pageWidth: 760, pageHeight: 1000
}];

const request = {
  sourceType: "seam",
  pageIds: pageSpans.map(s => s.pageId),
  imageRevisionByPage: {
    [pageSpans[0].pageId]: "65c58",
    [pageSpans[1].pageId]: "48281"
  },
  imageDigest: "repro",
  imageMeta: { sourceType: "seam", pageSpans }
};
const debugSession = { filterReasons: [] };
const clustered = await background.buildLocalPaddleBubbleItems({
  imageWidth: imageSize.width,
  imageHeight: imageSize.height,
  items: seamJson.items
}, imageSize, "", false, null, background.getDefaultOcrTuning(), debugSession, { pageSpans });
console.log("clustered:", JSON.stringify(clustered.map(c => ({ text: c.text, box: c.box, region: c.regionBox })), null, 1));
const normalized = clustered.map((entry, index) => background.normalizeBaiduOcrItem(entry, index, imageSize)).filter(Boolean);
console.log("normalized candidate:", JSON.stringify(normalized.map(n => ({
  x: n.x, y: n.y, w: n.w, h: n.h, fill_box: n.fill_box, bg_type: n.bg_type, region_type: n.region_type, rawBox: n.rawBox
})), null, 1));
const result = background.buildProviderNeutralObservationResult({
  provider: "local_paddle", request, imageSize,
  normalized,
  ocrTuning: background.getDefaultOcrTuning(),
  ocrDebug: debugSession,
  ignoreSimplifiedChinese: false,
  debug: false
});
for (const obs of result.observations) {
  console.log("OBSERVATION", obs.id, obs.originalText, "confidence", obs.confidence);
  console.log("  spans:", JSON.stringify(obs.pageSpans.map(s => ({
    pageId: s.pageId.slice(0, 24), box: s.box, textBox: s.visual && s.visual.textBox, fillBox: s.visual && s.visual.fillBox
  })), null, 1));
}

const pageRequest = {
  sourceType: "page",
  pageIds: [pageSpans[1].pageId],
  imageRevisionByPage: { [pageSpans[1].pageId]: "48281" },
  imageDigest: "repro-page",
  imageMeta: { sourceType: "page", pageSpans: [{ pageId: pageSpans[1].pageId, canvasBox: { x: 0, y: 0, w: 760, h: 1000 }, pageBox: { x: 0, y: 0, w: 760, h: 1000 }, pageWidth: 760, pageHeight: 1000 }] }
};
const pageDebug = { filterReasons: [] };
const pageClustered = await background.buildLocalPaddleBubbleItems({
  imageWidth: 760, imageHeight: 1000,
  items: currentJson.items
}, { width: 760, height: 1000 }, "", false, null, background.getDefaultOcrTuning(), pageDebug, {});
const pageNormalized = pageClustered.map((entry, index) => background.normalizeBaiduOcrItem(entry, index, { width: 760, height: 1000 })).filter(Boolean);
console.log("page normalized:", JSON.stringify(pageNormalized.map(n => ({ text: n.original_text, x: n.x, y: n.y, w: n.w, h: n.h, fill_box: n.fill_box })), null, 1));
const pageResult = background.buildProviderNeutralObservationResult({
  provider: "local_paddle", request: pageRequest, imageSize: { width: 760, height: 1000 },
  normalized: pageNormalized,
  ocrTuning: background.getDefaultOcrTuning(),
  ocrDebug: pageDebug,
  ignoreSimplifiedChinese: false,
  debug: false
});
for (const obs of pageResult.observations) {
  console.log("PAGE OBSERVATION", obs.id, obs.originalText, JSON.stringify(obs.pageSpans.map(s => ({ pageId: s.pageId.slice(0, 24), box: s.box }))));
}

const { canonicalPipeline: P } = await import(pathToFileURL(path.join(root, "extension/src/canonical/pipeline.js")).href);
const segments = pageSpans.map(span => ({
  pageId: span.pageId,
  drawRect: { x: 0, y: span.canvasBox.y, w: 760, h: 96 },
  sourceCrop: { x: 0, y: span.pageBox.y, w: 760, h: 96 },
  naturalWidth: 760,
  naturalHeight: 1000
}));
const observationsById = new Map();
for (const obs of [...result.observations, ...pageResult.observations]) {
  observationsById.set(obs.id, obs);
}
const seamObs = result.observations[0];
const pageObs = pageResult.observations.find(obs => obs.originalText.trim() === "진짜로!");
const canonical = {
  id: "whole",
  revision: 1,
  originalText: "진짜로!",
  memberObservationIds: [pageObs.id, seamObs.id]
};
const pageBoxes = P.canonicalSeamPageBoxes(canonical, observationsById, segments);
console.log("canonical page boxes:", JSON.stringify({
  text: pageBoxes.text,
  cover: pageBoxes.cover
}, null, 1));
const expectedPageIds = pageSpans.map(span => span.pageId);
const coverPageIds = pageBoxes.cover.map(box => box.pageId);
const tightCover = pageBoxes.cover.every(box => box.w < 30 && box.h < 10);
console.log(JSON.stringify(coverPageIds) === JSON.stringify(expectedPageIds) && tightCover
  ? "OK: 同一句话保留上下页紧致覆盖段,由一个跨页 surface 统一渲染"
  : "FAIL: 跨页覆盖段缺失或范围过大");
