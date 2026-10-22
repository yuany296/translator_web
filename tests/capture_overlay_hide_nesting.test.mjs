import assert from "node:assert/strict";
import test from "node:test";
import { installCapturePayload } from "../extension/src/content/modules/capture-payload.js";

/** 只给 withOverlayLayerHidden 需要的那几样：state 里的层、悬浮球、还原钩子。 */
function createCaptureRuntime(markedNodes) {
  const runtime = {
    state: {
      overlayLayer: { isConnected: true, style: { visibility: "" } },
      floatingBallWrap: null,
      overlayHideDepth: 0
    },
    ensureExtensionUiMounted() {}
  };
  installCapturePayload(runtime);
  globalThis.document = { querySelectorAll: () => markedNodes };
  return runtime;
}

function makeMarkedNode() {
  return { isConnected: true, style: { visibility: "" } };
}

test("并发截图交错结束时，扩展节点必须回到截图前的可见状态（不得停在 hidden）", async () => {
  // 现场（KakaoPage 跨页气泡）：页级 OCR 与接缝 OCR 的截图会并发。旧实现每次截图都
  // 自己快照 + 自己还原，内层快照到的 `visibility` 已经是外层设的 "hidden"，
  // 而内层结束得更晚 —— 它把 "hidden" 写了回去，`.mt-cover-segment` 这种**复用节点**
  // 从此永久隐藏（后续渲染只改 left/top/宽高/背景，不碰 visibility），
  // 症状就是「白底盖板在 DOM 里、位置也对，就是看不见」。
  const segment = makeMarkedNode();
  const runtime = createCaptureRuntime([segment]);
  let releaseOuter;
  let releaseInner;
  const outerGate = new Promise(resolve => { releaseOuter = resolve; });
  const innerGate = new Promise(resolve => { releaseInner = resolve; });

  const outer = runtime.withOverlayLayerHidden(async () => { await outerGate; });
  assert.equal(segment.style.visibility, "hidden", "截图期间扩展节点必须隐藏");
  const inner = runtime.withOverlayLayerHidden(async () => { await innerGate; });
  assert.equal(segment.style.visibility, "hidden");

  releaseOuter();
  await outer;
  releaseInner();
  await inner;
  assert.equal(segment.style.visibility, "", "最外层结束后必须还原为截图前的可见状态");
});

test("内层截图不改写外层快照：隐藏/还原只由最外层负责", async () => {
  const segment = makeMarkedNode();
  const runtime = createCaptureRuntime([segment]);
  await runtime.withOverlayLayerHidden(async () => {
    await runtime.withOverlayLayerHidden(async () => {});
    // 内层结束不得提前解开隐藏（外层还在截图）。
    assert.equal(segment.style.visibility, "hidden");
  });
  assert.equal(segment.style.visibility, "");
  assert.equal(runtime.state.captureHideDepth, 0, "计数必须归零");
});
