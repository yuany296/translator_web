import assert from "node:assert/strict";
import test from "node:test";
import { installCrossPageCover } from "../extension/src/content/modules/crosspage-cover.js";

function makeNode() {
  const removed = [];
  return {
    dataset: {},
    style: {
      removed,
      removeProperty: name => removed.push(name)
    }
  };
}

function makeRuntime(overrides = {}) {
  const runtime = { normalizeBgType: value => String(value || "none"), ...overrides };
  installCrossPageCover(runtime);
  return runtime;
}

const TILTED_GEOMETRY = {
  coverTilted: true,
  coverQuad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
};

const CONTEXT = { targetRects: new Map(), rootRect: { left: 0, top: 0, width: 100, height: 100 } };
const RECT = { left: 0, top: 0, width: 100, height: 100, pageId: "page-a" };

test("缺少 mapCompositePointToRoot 时退回不倾斜，而不是抛错", () => {
  const runtime = makeRuntime();
  const node = makeNode();

  assert.doesNotThrow(() => runtime.applyCoverSegmentTilt(
    { surface: { canvasWidth: 100, canvasHeight: 100 } }, { bubble: {} }, TILTED_GEOMETRY, node, CONTEXT, RECT
  ));

  assert.equal(node.dataset.coverTilted, "unsupported");
  assert.deepEqual(node.style.removed, ["clip-path"]);
  assert.equal(node.style.clipPath, undefined);
});

test("坐标映射可用时按四边形设置 clip-path", () => {
  const runtime = makeRuntime({
    mapCompositePointToRoot: (_surface, point) => ({ x: point.x, y: point.y })
  });
  const node = makeNode();

  runtime.applyCoverSegmentTilt(
    { surface: { canvasWidth: 100, canvasHeight: 100 } }, { bubble: {} }, TILTED_GEOMETRY, node, CONTEXT, RECT
  );

  assert.equal(node.dataset.coverTilted, "true");
  assert.match(String(node.style.clipPath), /^polygon\(/u);
});

test("映射结果不足三点时不设置 clip-path", () => {
  const runtime = makeRuntime({ mapCompositePointToRoot: () => null });
  const node = makeNode();

  runtime.applyCoverSegmentTilt(
    { surface: { canvasWidth: 100, canvasHeight: 100 } }, { bubble: {} }, TILTED_GEOMETRY, node, CONTEXT, RECT
  );

  assert.equal(node.dataset.coverTilted, "false");
  assert.deepEqual(node.style.removed, ["clip-path"]);
});
