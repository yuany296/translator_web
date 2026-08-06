import assert from "node:assert/strict";
import test from "node:test";
import { installRendererEmbed } from "../extension/src/content/modules/renderer-embed.js";

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
  assert.ok(options.renderScale > 1);
  assert.equal(options.textScale, undefined, "text must not be scaled twice");
  try {
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[504, 304]]);
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
  assert.equal(options.renderScale, undefined);
  assert.equal(options.textScale, 2);
  delete globalThis.document;
});

test("render scale is capped to avoid huge canvases", async () => {
  const { runtime, canvases } = createHarness();
  const options = { renderScale: 40 };
  try {
    await runtime.composeEmbeddedImageDataUrl("data:image/png;base64,QUJD", [], options);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[308 * 4, 186 * 4]]);
});
