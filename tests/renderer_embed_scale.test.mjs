import assert from "node:assert/strict";
import test from "node:test";
import { installRendererEmbed } from "../extension/src/content/modules/renderer-embed.js";
import { installRendererCanvas } from "../extension/src/content/modules/renderer-canvas.js";

class FakeContext {
  constructor() {
    this.imageSmoothingEnabled = false;
  }
  drawImage() {}
  toDataURL() {
    return "data:image/jpeg;base64,QUJD";
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeContext();
  }
  getContext() {
    return this.ctx;
  }
  toDataURL() {
    return "data:image/jpeg;base64,QUJD";
  }
}

function createHarness() {
  const canvases = [];
  const runtime = {
    EMBEDDED_MAX_RENDER_SCALE: 4,
    EMBEDDED_JPEG_QUALITY: 0.9,
    state: { displayMode: "translated" },
    cleanRenderableText: value => String(value || ""),
    loadImageFromDataUrl: async () => ({
      naturalWidth: 308,
      naturalHeight: 186,
      width: 308,
      height: 186
    }),
    normalizeBgType: value => String(value || "none"),
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    getBubbleRenderColors: () => ({ textColor: "#000000", strokeColor: "#ffffff" }),
    formatTranslationForOriginalLines: value => String(value || ""),
    getEmbeddedPolygonGeometry: () => null,
    normalizeBubbleRotation: () => 0,
    drawFittedText: () => {}
  };
  globalThis.document = {
    createElement: tag => {
      const canvas = new FakeCanvas();
      canvases.push(canvas);
      return canvas;
    }
  };
  installRendererEmbed(runtime);
  return { runtime, canvases };
}

test("upscaled display renders the embedded image at display resolution", async () => {
  const { runtime, canvases } = createHarness();
  const target = {
    clientWidth: 504,
    clientHeight: 304,
    naturalWidth: 308,
    naturalHeight: 186,
    width: 308,
    height: 186
  };
  const options = runtime.embeddedDisplayOptions(target);
  assert.equal(options.renderWidth, 504);
  assert.equal(options.textScale, undefined, "text must not be scaled twice");
  try {
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[504, 304]]);
});

test("a base already at rendered resolution is never upscaled again", async () => {
  const { runtime, canvases } = createHarness();
  const options = { renderWidth: 504 };
  try {
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
    runtime.loadImageFromDataUrl = async () => ({ naturalWidth: 756, naturalHeight: 457, width: 756, height: 457 });
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[504, 304], [756, 457]]);
});

test("downscaled display keeps the legacy text-scale behavior", () => {
  const { runtime } = createHarness();
  const target = {
    clientWidth: 500,
    clientHeight: 600,
    naturalWidth: 1000,
    naturalHeight: 1200,
    width: 1000,
    height: 1200
  };
  const options = runtime.embeddedDisplayOptions(target);
  assert.equal(options.renderWidth, undefined);
  assert.equal(options.textScale, 2);
  delete globalThis.document;
});

test("embedded text prefers the original OCR font height", () => {
  const fonts = [];
  const ctx = {
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clip() {},
    fillRect() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {},
    set font(value) { fonts.push(value); },
    get font() { return fonts[fonts.length - 1] || ""; },
    measureText: text => ({ width: Array.from(String(text)).length * 20 }),
    textAlign: "", textBaseline: "", lineJoin: "", lineWidth: 0,
    strokeStyle: "", fillStyle: ""
  };
  const runtime = {
    wrapCanvasText: (c, text) => String(text).split("\n"),
    cleanRenderableText: value => String(value || ""),
    getDynamicStrokeWidth: () => 2
  };
  installRendererCanvas(runtime);
  // 原文 93px,框高 100:老逻辑最多 100*0.68/1.22≈55px;新逻辑应接近 93px。
  runtime.drawFittedText(ctx, "消耗品", { x: 0, y: 0, w: 300, h: 100 }, "none", {
    preferredFont: 93, widthUsage: 0.82, strokeColor: "#fff", textColor: "#000"
  });
  const last = fonts[fonts.length - 1];
  const size = Number(/500\s+([\d.]+)px/u.exec(last)?.[1] || 0);
  assert.ok(size >= 85, `expected size near original 93, got ${size}`);
  assert.ok(size <= 98, `expected size capped by preferredFont, got ${size}`);
});

test("legacy height cap still applies without OCR font metrics", () => {
  const fonts = [];
  const ctx = {
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clip() {},
    fillRect() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {},
    set font(value) { fonts.push(value); },
    get font() { return fonts[fonts.length - 1] || ""; },
    measureText: text => ({ width: Array.from(String(text)).length * 20 }),
    textAlign: "", textBaseline: "", lineJoin: "", lineWidth: 0,
    strokeStyle: "", fillStyle: ""
  };
  const runtime = {
    wrapCanvasText: (c, text) => String(text).split("\n"),
    getDynamicStrokeWidth: () => 2
  };
  installRendererCanvas(runtime);
  runtime.drawFittedText(ctx, "消耗品", { x: 0, y: 0, w: 300, h: 100 }, "none", {
    widthUsage: 0.82, strokeColor: "#fff", textColor: "#000"
  });
  const size = Number(/500\s+([\d.]+)px/u.exec(fonts[fonts.length - 1])?.[1] || 0);
  assert.ok(size <= 56, `legacy cap 100*0.68/1.22≈55, got ${size}`);
});

test("render scale is capped to avoid huge canvases", async () => {
  const { runtime, canvases } = createHarness();
  const options = { renderWidth: 308 * 40 };
  try {
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[308 * 4, 186 * 4]]);
});
