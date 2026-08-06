import assert from "node:assert/strict";
import test from "node:test";
import { installNovelImageWorkflow } from "../extension/src/content/modules/novel-image-workflow.js";

function createHarness(overrides = {}) {
  const target = { dataset: {} };
  const state = {
    surface: { root: {} },
    textStatus: "complete",
    imageStatus: "partial",
    imageAutoResumeCount: 0,
    lastImageResumeAt: 0,
    imageJobs: new Map(),
    progress: {},
    imageContexts: new Map()
  };
  const calls = [];
  const runtime = {
    getNovelState: () => state,
    extractKakaoNovelChapter: () => ({ images: [{ target }] }),
    ...overrides
  };
  installNovelImageWorkflow(runtime);
  runtime.translateNovelImages = async (chapter, retry) => {
    calls.push({ retry });
  };
  return { runtime, state, calls, target };
}

test("resume retries a failed image job after the chapter flow ran", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed", error: "target disconnected" });
  harness.runtime.resumeNovelImagesIfIdle();
  assert.deepEqual(harness.calls, [{ retry: true }]);
  assert.equal(harness.state.imageAutoResumeCount, 1);
});

test("resume never runs before the floating ball is clicked", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed" });
  harness.state.textStatus = "idle";
  harness.state.imageStatus = "idle";
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0, "fresh page entry must keep original images");
});

test("resume skips chapters whose image phase never ran", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed" });
  harness.state.textStatus = "complete";
  harness.state.imageStatus = "idle";
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0);
});

test("resume never runs while text or image phases are working", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed" });
  harness.state.textStatus = "working";
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0, "text is still translating");
  const imageBusy = createHarness();
  imageBusy.state.imageJobs.set(imageBusy.target, { status: "failed" });
  imageBusy.state.imageStatus = "working";
  imageBusy.runtime.resumeNovelImagesIfIdle();
  assert.equal(imageBusy.calls.length, 0);
});

test("resume ignores targets with complete or working jobs", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "complete" });
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0);
});

test("resume respects the cooldown window", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed" });
  harness.state.lastImageResumeAt = Date.now() - 1000;
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0, "too soon after the previous resume");
  harness.state.lastImageResumeAt = Date.now() - 9000;
  harness.runtime.resumeNovelImagesIfIdle();
  assert.deepEqual(harness.calls, [{ retry: true }]);
});

test("resume stops after the auto-retry cap to avoid endless loops", () => {
  const harness = createHarness();
  harness.state.imageJobs.set(harness.target, { status: "failed" });
  harness.state.imageAutoResumeCount = 3;
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0);
});

test("resume does nothing when the chapter has no images", () => {
  const harness = createHarness({
    extractKakaoNovelChapter: () => ({ images: [] })
  });
  harness.runtime.resumeNovelImagesIfIdle();
  assert.equal(harness.calls.length, 0);
});
