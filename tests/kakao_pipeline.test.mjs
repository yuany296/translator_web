import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Load pipeline module (relative import, Node resolves against file location)
await import("../kakao-pipeline.js");

const P = globalThis.MangaTranslatorKakaoPipeline;

test("manifest loads the Kakao module before content.js", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.content_scripts[0].js.slice(0, 2),
    ["kakao-pipeline.js", "content.js"]
  );
  const buildSource = fs.readFileSync(path.join(root, "scripts", "build-extension.mjs"), "utf8");
  assert.match(buildSource, /"kakao-pipeline\.js"/);

  const popupSource = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const popupFilesMatch = popupSource.match(
    /const CONTENT_SCRIPT_FILES = Object\.freeze\((\[[\s\S]*?\])\);/
  );
  assert.ok(popupFilesMatch, "popup should declare its ordered content-script dependencies");
  assert.deepEqual(JSON.parse(popupFilesMatch[1]), manifest.content_scripts[0].js);
  assert.match(
    popupSource,
    /await executeScriptFiles\(tabId, CONTENT_SCRIPT_FILES\)/,
    "popup recovery should inject the complete ordered dependency list"
  );
  assert.match(popupSource, /files:\s*\[\.\.\.files\]/);
});

/* =================================================================
 * FSM
 * ================================================================= */
test("PagePhase states are frozen and have correct values", () => {
  assert.equal(P.PagePhase.WAITING, "waiting");
  assert.equal(P.PagePhase.FETCHING, "fetching");
  assert.equal(P.PagePhase.FETCHED, "fetched");
  assert.equal(P.PagePhase.STITCHING, "stitching");
  assert.equal(P.PagePhase.STITCHED, "stitched");
  assert.equal(P.PagePhase.RECOGNIZING, "recognizing");
  assert.equal(P.PagePhase.RECOGNIZED, "recognized");
  assert.equal(P.PagePhase.DEDUPING, "deduping");
  assert.equal(P.PagePhase.DEDUPED, "deduped");
  assert.equal(P.PagePhase.RENDERING, "rendering");
  assert.equal(P.PagePhase.RENDERED, "rendered");
  assert.equal(P.PagePhase.CANCELLED, "cancelled");
  assert.equal(P.PagePhase.RETRY_WAIT, "retry_wait");
  assert.equal(P.PagePhase.FAILED, "failed");
});

test("canTransition accepts valid transitions", () => {
  assert.equal(P.canTransition("waiting", "fetching"), true);
  assert.equal(P.canTransition("waiting", "deduping"), true);
  assert.equal(P.canTransition("waiting", "cancelled"), true);
  assert.equal(P.canTransition("fetching", "fetched"), true);
  assert.equal(P.canTransition("fetching", "retry_wait"), true);
  assert.equal(P.canTransition("stitched", "recognizing"), true);
  assert.equal(P.canTransition("recognized", "deduping"), true);
  assert.equal(P.canTransition("deduped", "rendering"), true);
  assert.equal(P.canTransition("rendering", "rendered"), true);
  assert.equal(P.canTransition("retry_wait", "waiting"), true);
  assert.equal(P.canTransition("retry_wait", "failed"), true);
  assert.equal(P.canTransition("failed", "cancelled"), true);
});

test("canTransition rejects invalid transitions", () => {
  // Skipping phases not possible
  assert.equal(P.canTransition("waiting", "rendered"), false);
  assert.equal(P.canTransition("fetching", "rendered"), false);
  assert.equal(P.canTransition("stitched", "waiting"), false);
  // Terminal states have no outgoing
  assert.equal(P.canTransition("rendered", "waiting"), false);
  assert.equal(P.canTransition("rendered", "fetching"), false);
  assert.equal(P.canTransition("cancelled", "fetching"), false);
  assert.equal(P.canTransition("cancelled", "waiting"), false);
  assert.equal(P.canTransition("failed", "waiting"), false);
  assert.equal(P.canTransition("failed", "fetching"), false);
});

test("isActivePhase returns true for intermediate phases", () => {
  assert.equal(P.isActivePhase("fetching"), true);
  assert.equal(P.isActivePhase("stitching"), true);
  assert.equal(P.isActivePhase("recognizing"), true);
  assert.equal(P.isActivePhase("deduping"), true);
  assert.equal(P.isActivePhase("rendering"), true);
});

test("isActivePhase returns false for terminal phases", () => {
  assert.equal(P.isActivePhase("waiting"), false);
  assert.equal(P.isActivePhase("retry_wait"), false);
  assert.equal(P.isActivePhase("cancelled"), false);
  assert.equal(P.isActivePhase("failed"), false);
  assert.equal(P.isActivePhase("rendered"), false);
});

test("isRetryablePhase returns true for retry_wait and waiting", () => {
  assert.equal(P.isRetryablePhase("retry_wait"), true);
  assert.equal(P.isRetryablePhase("waiting"), true);
  assert.equal(P.isRetryablePhase("fetching"), false);
  assert.equal(P.isRetryablePhase("failed"), false);
  assert.equal(P.isRetryablePhase("cancelled"), false);
});

/* =================================================================
 * Store — basic operations
 * ================================================================= */
test("createStore returns a store object with required methods", () => {
  const store = P.createStore();
  const methods = [
    "getGlobalEntries", "getEntriesForKey", "setEntriesForKey",
    "deleteEntriesForKey", "removeEntryFromKey", "runSerializedDedupe",
    "getPagePhase", "transitionPagePhase", "transitionIfCurrentPhase",
    "resetPagePhase", "deletePagePhase", "isPageActive",
    "getOrCreateInflightJob", "beginPageJob", "isCurrentPageJob",
    "finishPageJob", "cancelPageJob", "getShortPageAttachment",
    "attachShortPage", "releaseShortPage", "clearShortPage",
    "getRetryState", "setRetryState", "clearRetryState",
    "clearRetryStates", "reset"
  ];
  for (const m of methods) {
    assert.equal(typeof store[m], "function", `Store missing method: ${m}`);
  }
});

test("Store starts empty", () => {
  const store = P.createStore();
  assert.deepEqual(store.getGlobalEntries(), []);
  assert.deepEqual(store.getEntriesForKey("nonexistent"), []);
  assert.equal(store.isPageActive("nonexistent"), false);
});

test("Store setEntriesForKey and getEntriesForKey round-trip", () => {
  const store = P.createStore();
  const entry = { box: { left: 0, top: 0, width: 100, height: 100 }, text: "hello", completeness: 5 };
  store.setEntriesForKey("page-1", [entry]);
  const retrieved = store.getEntriesForKey("page-1");
  assert.equal(retrieved.length, 1);
  assert.equal(retrieved[0].text, "hello");
  // Should return a copy
  assert.notEqual(retrieved[0], entry);
});

test("Store deleteEntriesForKey removes entries", () => {
  const store = P.createStore();
  store.setEntriesForKey("page-1", [{ text: "hello", completeness: 1 }]);
  store.deleteEntriesForKey("page-1");
  assert.deepEqual(store.getEntriesForKey("page-1"), []);
});

test("Store removeEntryFromKey removes specific entry reference", () => {
  const store = P.createStore();
  const entryA = { text: "A", completeness: 1 };
  const entryB = { text: "B", completeness: 2 };
  store.setEntriesForKey("page-1", [entryA, entryB]);
  store.removeEntryFromKey("page-1", entryA);
  const entries = store.getEntriesForKey("page-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "B");
});

test("Store getGlobalEntries returns flattened snapshot of all entries", () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{ text: "a", completeness: 1, targetKey: "p1" }]);
  store.setEntriesForKey("p2", [{ text: "b", completeness: 2, targetKey: "p2" }]);
  const all = store.getGlobalEntries();
  assert.equal(all.length, 2);
  const texts = all.map(e => e.text).sort();
  assert.deepEqual(texts, ["a", "b"]);
});

/* =================================================================
 * Store — page phase FSM
 * ================================================================= */
test("Store transitionPagePhase follows valid transitions", () => {
  const store = P.createStore();
  assert.equal(store.transitionPagePhase("page-1", "fetching"), true);
  assert.equal(store.getPagePhase("page-1"), "fetching");
  assert.equal(store.transitionPagePhase("page-1", "fetched"), true);
  assert.equal(store.getPagePhase("page-1"), "fetched");
});

test("Store transitionPagePhase rejects illegal transitions", () => {
  const store = P.createStore();
  // Can't go directly to rendered from waiting
  assert.equal(store.transitionPagePhase("page-1", "rendered"), false);
  assert.equal(store.getPagePhase("page-1"), "waiting");
});

test("Store transitionIfCurrentPhase only transitions when at expected phase", () => {
  const store = P.createStore();
  // Start at waiting
  assert.equal(store.transitionIfCurrentPhase("page-1", "waiting", "fetching"), true);
  assert.equal(store.getPagePhase("page-1"), "fetching");
  // Attempt to transition from waiting (wrong current phase) should fail
  assert.equal(store.transitionIfCurrentPhase("page-1", "waiting", "fetched"), false);
  assert.equal(store.getPagePhase("page-1"), "fetching");
});

test("Store resetPagePhase resets to waiting", () => {
  const store = P.createStore();
  store.transitionPagePhase("page-1", "fetching");
  store.resetPagePhase("page-1");
  assert.equal(store.getPagePhase("page-1"), "waiting");
});

test("Store deletePagePhase removes phase entry", () => {
  const store = P.createStore();
  store.transitionPagePhase("page-1", "fetching");
  store.deletePagePhase("page-1");
  assert.equal(store.getPagePhase("page-1"), "waiting"); // default
});

test("Store isPageActive reflects phase correctly", () => {
  const store = P.createStore();
  assert.equal(store.isPageActive("page-1"), false);
  // Walk valid path: waiting → deduping → deduped → rendering → rendered
  store.transitionPagePhase("page-1", "deduping");
  store.transitionPagePhase("page-1", "deduped");
  store.transitionPagePhase("page-1", "rendering");
  store.transitionPagePhase("page-1", "rendered");
  assert.equal(store.isPageActive("page-1"), false);
  store.resetPagePhase("page-1");
  assert.equal(store.isPageActive("page-1"), false);
});

/* =================================================================
 * Store — serialized dedupe
 * ================================================================= */
test("Store runSerializedDedupe executes the provided function", async () => {
  const store = P.createStore();
  const result = await store.runSerializedDedupe(async ({ seq, store: s }) => {
    return { seq, key: s === store };
  });
  assert.equal(result.key, true);
  assert.ok(result.seq >= 1);
});

test("Store runSerializedDedupe serializes concurrent operations", async () => {
  const store = P.createStore();
  const order = [];

  const p1 = store.runSerializedDedupe(async () => {
    await new Promise(r => setTimeout(r, 20));
    order.push("a");
    return "a";
  });

  const p2 = store.runSerializedDedupe(async () => {
    order.push("b");
    return "b";
  });

  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, "a");
  assert.equal(r2, "b");
  // 'a' must finish before 'b' starts (serial)
  assert.deepEqual(order, ["a", "b"]);
});

test("Store runSerializedDedupe provides globalOcrEntries reference", async () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{ text: "existing", completeness: 5, targetKey: "p1" }]);

  const result = await store.runSerializedDedupe(async ({ globalOcrEntries }) => {
    const entries = globalOcrEntries.get("p1");
    return entries && entries.length;
  });
  assert.equal(result, 1);
});

test("Store dedupe queue continues after a rejected transaction", async () => {
  const store = P.createStore();
  await assert.rejects(
    store.runSerializedDedupe(async () => { throw new Error("expected"); }),
    /expected/
  );
  assert.equal(await store.runSerializedDedupe(async () => "recovered"), "recovered");
});

/* =================================================================
 * Store — inflight job merging
 * ================================================================= */
test("Store getOrCreateInflightJob merges duplicate requests", async () => {
  const store = P.createStore();
  let callCount = 0;

  const factory = async () => {
    callCount += 1;
    await new Promise(r => setTimeout(r, 10));
    return "result";
  };

  const p1 = store.getOrCreateInflightJob("job-1", factory);
  const p2 = store.getOrCreateInflightJob("job-1", factory);

  assert.equal(p1, p2); // Same promise reference
  assert.equal(await p1, "result");
  assert.equal(await p2, "result");
  assert.equal(callCount, 1); // Factory called only once
});

test("Store getOrCreateInflightJob creates separate promises for different keys", async () => {
  const store = P.createStore();
  const p1 = store.getOrCreateInflightJob("a", async () => "a");
  const p2 = store.getOrCreateInflightJob("b", async () => "b");
  assert.notEqual(p1, p2);
  assert.equal(await p1, "a");
  assert.equal(await p2, "b");
});

test("Store getOrCreateInflightJob auto-cleans after completion", async () => {
  const store = P.createStore();
  await store.getOrCreateInflightJob("auto-clean", async () => "done");
  // After completion, a new factory should be called
  let callCount = 0;
  const p2 = store.getOrCreateInflightJob("auto-clean", async () => {
    callCount += 1;
    return "new";
  });
  assert.equal(await p2, "new");
  assert.equal(callCount, 1);
});

/* =================================================================
 * Store — reset
 * ================================================================= */
test("Store reset clears all state", () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{ text: "a", completeness: 1 }]);
  store.transitionPagePhase("p1", "fetching");
  store.getOrCreateInflightJob("j1", async () => "x");
  store.reset();
  assert.deepEqual(store.getGlobalEntries(), []);
  assert.equal(store.getPagePhase("p1"), "waiting");
});

test("Store owns short-page attachment state and expires it through the gate", () => {
  const store = P.createStore();
  const target = {};
  store.attachShortPage(target, "owner", 1000);
  assert.deepEqual(P.getShortPageAttachmentGate(store, target, 2000), {
    blocked: true,
    timedOut: false,
    ownerKey: "owner"
  });
  assert.deepEqual(P.getShortPageAttachmentGate(store, target, 10000), {
    blocked: false,
    timedOut: true,
    ownerKey: "owner"
  });
  assert.equal(store.getShortPageAttachment(target).ownerKey, "");
});

test("retry scheduler stores timers and coalesces duplicate schedules", () => {
  const store = P.createStore();
  const target = { isConnected: true, ready: true };
  let callback = null;
  let readyCount = 0;
  const scheduler = P.createRetryScheduler({
    store,
    setTimer: (fn) => { callback = fn; return 42; },
    clearTimer: () => undefined,
    isPlaceholder: () => false,
    isTargetUsable: (value) => value.isConnected,
    isTargetReady: (value) => value.ready,
    onReady: () => { readyCount += 1; }
  });

  assert.equal(scheduler.schedule(target), true);
  assert.equal(scheduler.schedule(target), false);
  assert.equal(store.getRetryState(target).timer, 42);
  callback();
  assert.equal(readyCount, 1);
  assert.equal(store.getRetryState(target), null);
});

test("buildKakaoStitchedPayload composes verified owner and neighbor slices", async () => {
  const owner = { sourceKey: "owner", left: 0, top: 0, bottom: 1000, width: 760, height: 1000 };
  const next = { sourceKey: "next", left: 0, top: 1000, bottom: 2000, width: 760, height: 1000 };
  const draws = [];
  const result = await P.buildKakaoStitchedPayload(
    owner,
    { dataUrl: "owner-data", width: 760, height: 1000 },
    {
      collectCandidates: () => [owner, next],
      isReadyImageTarget: () => true,
      describeTarget: (target) => target,
      extractAdjacentPayload: async () => ({ dataUrl: "next-data", width: 760, height: 1000 }),
      loadImage: async () => ({ naturalWidth: 760, naturalHeight: 1000 }),
      createCanvas: (width, height) => ({
        width,
        height,
        getContext: () => ({ drawImage: (...args) => draws.push(args) }),
        toDataURL: () => "data:image/jpeg;base64,stitched"
      }),
      imageMaxSide: 1536,
      imageJpegQuality: 0.82,
      computeTargetKey: (target) => target.sourceKey,
      getQuickSourceToken: (target) => target.sourceKey,
      buildTargetSourceCacheKey: (key, source) => `${key}|${source}`
    }
  );

  assert.equal(result.stitchAdmission, "accepted");
  assert.equal(result.stitch.owner.source, "owner");
  assert.equal(result.stitch.next.source, "next");
  assert.equal(result.stitch.segments.length, 2);
  assert.equal(draws.length, 2);
});

/* =================================================================
 * Pure functions — text utilities
 * ================================================================= */
test("normalizeOcrSimilarityText normalizes and strips non-letter chars", () => {
  assert.equal(P.normalizeOcrSimilarityText("Hello World"), "helloworld");
  assert.equal(P.normalizeOcrSimilarityText("日本語！"), "日本語");
  assert.equal(P.normalizeOcrSimilarityText(""), "");
  assert.equal(P.normalizeOcrSimilarityText(null), "");
  assert.equal(P.normalizeOcrSimilarityText(undefined), "");
});

test("textSimilarity returns 1 for identical strings", () => {
  assert.equal(P.textSimilarity("hello", "hello"), 1);
});

test("textSimilarity returns 0 for null/empty comparisons", () => {
  assert.equal(P.textSimilarity("", "hello"), 0);
  assert.equal(P.textSimilarity(null, "hello"), 0);
});

test("areOcrTextsDuplicateOrContained detects high similarity", () => {
  assert.equal(P.areOcrTextsDuplicateOrContained("hello", "hello"), true);
  assert.equal(P.areOcrTextsDuplicateOrContained("hello world", "hello"), true);
  assert.equal(P.areOcrTextsDuplicateOrContained("abc", "def"), false);
});

test("getSubstantialOcrBoundaryOverlap finds prefix/suffix matches", () => {
  const result = P.getSubstantialOcrBoundaryOverlap("prefix_hello", "hello_world");
  // "hello" should be either suffix of first or prefix of second
  assert.ok(result === null || result.length >= 5);
});

test("sliceTextByNormalizedBoundary correctly slices text", () => {
  const result = P.sliceTextByNormalizedBoundary("hello world", 5, false);
  assert.equal(result, "hello");
});

/* =================================================================
 * Pure functions — geometry
 * ================================================================= */
test("normalizeRectLike returns null for invalid input", () => {
  assert.equal(P.normalizeRectLike(null), null);
  assert.equal(P.normalizeRectLike({}), null);
  assert.equal(P.normalizeRectLike({ x: 0, y: 0, w: 0, h: 0 }), null);
});

test("normalizeRectLike accepts valid rect", () => {
  const result = P.normalizeRectLike({ x: 10, y: 20, w: 100, h: 200 });
  assert.deepEqual(result, { x: 10, y: 20, w: 100, h: 200 });
});

test("normalizeRectLike accepts width/height alias", () => {
  const result = P.normalizeRectLike({ x: 10, y: 20, width: 100, height: 200 });
  assert.deepEqual(result, { x: 10, y: 20, w: 100, h: 200 });
});

test("pageBoxIntersectionRatio calculates correctly", () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  const b = { left: 50, top: 0, width: 100, height: 100 };
  const ratio = P.pageBoxIntersectionRatio(a, b);
  // Overlap is 50x100 = 5000, min area is 10000
  assert.equal(ratio, 0.5);
});

test("areKakaoGlobalBoxesRelated returns true for overlapping boxes", () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  const b = { left: 50, top: 0, width: 100, height: 100 };
  assert.equal(P.areKakaoGlobalBoxesRelated(a, b), true);
});

test("areKakaoGlobalBoxesRelated returns false for distant boxes", () => {
  const a = { left: 0, top: 0, width: 10, height: 10 };
  const b = { left: 500, top: 500, width: 10, height: 10 };
  assert.equal(P.areKakaoGlobalBoxesRelated(a, b), false);
});

/* =================================================================
 * Pure functions — stitch geometry
 * ================================================================= */
test("isKakaoPageEdgeSource detects page-edge URLs", () => {
  assert.equal(P.isKakaoPageEdgeSource("https://page-edge.kakao.com/download"), true);
  assert.equal(P.isKakaoPageEdgeSource("https://dw-img-page.kakao.com/image"), false);
  assert.equal(P.isKakaoPageEdgeSource(""), false);
});

test("shouldRejectKakaoPageEdgeStitch accepts tall images", () => {
  const rejection = P.shouldRejectKakaoPageEdgeStitch({
    owner: { sourceKey: "https://page-edge.kakao.com/resource", width: 760, height: 1200 },
    ownerHeight: 1200,
    canonicalWidth: 760
  });
  assert.equal(rejection, "");
});

test("shouldRejectKakaoPageEdgeStitch rejects short fragmented images without stable neighbors", () => {
  const rejection = P.shouldRejectKakaoPageEdgeStitch({
    owner: { sourceKey: "https://page-edge.kakao.com/resource", width: 760, height: 600 },
    ownerHeight: 600,
    canonicalWidth: 760,
    next: { sourceKey: "next", width: 760, height: 500 },
    nextHeight: 500
  });
  // 600/500 = 1.2, 500/600 = 0.83 >= 0.78 → has stable neighbor → accepted
  assert.equal(rejection, "");
});

test("isVerifiedKakaoStitchNeighbor verifies alignment and proximity", () => {
  const owner = { left: 0, top: 1000, bottom: 2000, width: 760, height: 1000, sourceKey: "owner", src: "img1.jpg" };
  const candidate = { left: 0, top: 0, bottom: 1000, width: 760, height: 1000, sourceKey: "prev", src: "img2.jpg" };
  assert.equal(P.isVerifiedKakaoStitchNeighbor(owner, candidate, "previous"), true);
});

test("isVerifiedKakaoStitchNeighbor rejects same source nodes", () => {
  const owner = { left: 0, top: 1000, width: 760, height: 1000, sourceKey: "same", src: "img.jpg" };
  const candidate = { left: 0, top: 0, width: 760, height: 1000, sourceKey: "same", src: "img.jpg" };
  assert.equal(P.isVerifiedKakaoStitchNeighbor(owner, candidate, "previous"), false);
});

test("isAttachableKakaoShortPage detects short pages", () => {
  const owner = { width: 760, height: 1000 };
  const short = { width: 760, height: 200 };
  assert.equal(P.isAttachableKakaoShortPage(short, owner, 200, 1000), true);
});

test("isAttachableKakaoShortPage rejects similar-sized pages", () => {
  const owner = { width: 760, height: 1000 };
  const same = { width: 760, height: 900 };
  assert.equal(P.isAttachableKakaoShortPage(same, owner, 900, 1000), false);
});

/* =================================================================
 * Pure functions — overlap detection
 * ================================================================= */
test("findKakaoVerticalOverlap detects identical pixel rows", () => {
  const width = 96;
  const height = 200;
  const gray1 = new Uint8Array(width * height);
  const gray2 = new Uint8Array(width * height);
  // Fill both with same pattern
  for (let i = 0; i < gray1.length; i++) {
    gray1[i] = i % 256;
    gray2[i] = i % 256;
  }
  const overlap = P.findKakaoVerticalOverlap(
    { width, height, gray: gray1 },
    { width, height, gray: gray2 }
  );
  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, true);
});

test("findKakaoVerticalOverlap returns null for different widths", () => {
  const w1 = { width: 96, height: 100, gray: new Uint8Array(9600) };
  const w2 = { width: 80, height: 100, gray: new Uint8Array(8000) };
  assert.equal(P.findKakaoVerticalOverlap(w1, w2), null);
});

test("hasUsableKakaoStripCaptureRect validates minimum dimensions", () => {
  assert.equal(P.hasUsableKakaoStripCaptureRect(null), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 100, height: 100 }), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 180, height: 180 }), true);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 760, height: 200 }), true);
});

/* =================================================================
 * Pure functions — bubble mapping
 * ================================================================= */
test("mapKakaoStitchedFillBox handles valid input", () => {
  const result = P.mapKakaoStitchedFillBox({ x: 10, y: 20, w: 50, h: 30 }, 100, 200, 500);
  assert.notEqual(result, null);
  assert.ok(result.y >= 0);
  assert.ok(result.h > 0);
});

test("mapKakaoStitchedFillBox rejects null", () => {
  assert.equal(P.mapKakaoStitchedFillBox(null, 0, 100, 500), null);
});

test("mapKakaoStitchedFillBox rejects unreasonable height", () => {
  // Height > 300% of owner should be rejected
  const result = P.mapKakaoStitchedFillBox({ x: 10, y: 20, w: 50, h: 600 }, 100, 200, 500);
  assert.equal(result, null);
});

test("mapKakaoStitchedPolygon maps points into owner space", () => {
  const points = [{ x: 10, y: 20 }, { x: 20, y: 30 }];
  const result = P.mapKakaoStitchedPolygon(points, 100, 200, 500);
  assert.notEqual(result, null);
  assert.equal(result.length, 2);
});

test("mapKakaoStitchedPolygon handles empty array", () => {
  assert.equal(P.mapKakaoStitchedPolygon([], 0, 100, 500), null);
});

test("computeKakaoGlobalBox computes page-level coordinates", () => {
  const bubble = { x: 25, y: 50, w: 20, h: 10 };
  const rect = { left: 100, top: 200, width: 400, height: 800 };
  const box = P.computeKakaoGlobalBox(bubble, 0, 0, rect);
  assert.notEqual(box, null);
  assert.equal(box.left, 100 + (25 / 100) * 400);
  assert.equal(box.top, 200 + (50 / 100) * 800);
  assert.equal(box.width, (20 / 100) * 400);
  assert.equal(box.height, (10 / 100) * 800);
});

test("computeKakaoGlobalBox handles scroll offset", () => {
  const bubble = { x: 0, y: 0, w: 100, h: 100 };
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  const box = P.computeKakaoGlobalBox(bubble, 500, 300, rect);
  assert.equal(box.left, 500);
  assert.equal(box.top, 300);
});

test("normalizeKakaoStitchSegments derives from provided segments", () => {
  const stitch = {
    segments: [
      { source: "owner", drawRect: { x: 0, y: 50, w: 760, h: 200 } }
    ]
  };
  const segments = P.normalizeKakaoStitchSegments(stitch, 760, 300, null);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source, "owner");
});

test("normalizeKakaoStitchSegments falls back to derived segments", () => {
  const stitch = {
    canvasWidth: 760,
    canvasHeight: 400,
    previousSlice: 60,
    nextSlice: 40
  };
  const segments = P.normalizeKakaoStitchSegments(stitch, 760, 400, null);
  assert.ok(segments.length >= 1);
});

test("shouldFallbackFromKakaoStitch requires stitch payload", () => {
  assert.equal(P.shouldFallbackFromKakaoStitch({}, null, null), "");
});

test("shouldFallbackFromKakaoStitch returns reason when no owner text", () => {
  const payload = { stitch: true, singleImagePayload: { dataUrl: "data:," } };
  assert.match(P.shouldFallbackFromKakaoStitch(payload, { bubbles: [] }, { bubbles: [] }), /no owner text/);
});

test("shouldFallbackFromKakaoStitch checks drop ratio > 70%", () => {
  const payload = { stitch: true, singleImagePayload: { dataUrl: "data:," } };
  const raw = { bubbles: [{ x: 0, y: 0, w: 10, h: 10 }] };
  assert.match(P.shouldFallbackFromKakaoStitch(payload, raw, { bubbles: [] }), /dropped all/);
});

/* =================================================================
 * Debug coordinate mapping
 * ================================================================= */
test("normalizeDebugCoordinateItems returns items as-is without stitch context", () => {
  const items = [{ percent: { x: 10, y: 10, w: 20, h: 20 } }];
  const result = P.normalizeDebugCoordinateItems(items, {}, null);
  assert.deepEqual(result, items);
});

test("normalizeDebugCoordinateItems handles empty array", () => {
  assert.deepEqual(P.normalizeDebugCoordinateItems([], {}, null), []);
});

test("getDebugItemPercent extracts percent from item", () => {
  const item = { percent: { x: 10, y: 20, w: 30, h: 40 } };
  const result = P.getDebugItemPercent(item, 100, 200);
  assert.deepEqual(result, { x: 10, y: 20, w: 30, h: 40 });
});

test("getDebugItemPercent computes from rawBox", () => {
  const item = { rawBox: { left: 10, top: 20, width: 30, height: 40 } };
  const result = P.getDebugItemPercent(item, 100, 200);
  assert.deepEqual(result, { x: 10, y: 10, w: 30, h: 20 });
});

/* =================================================================
 * Debug bubble filtering
 * ================================================================= */
test("filterOcrDebugFinalBubbles returns debug as-is when not an object", () => {
  assert.equal(P.filterOcrDebugFinalBubbles(null, []), null);
  assert.equal(P.filterOcrDebugFinalBubbles(undefined, []), undefined);
});

test("filterOcrDebugFinalBubbles keeps only bubbles whose IDs exist", () => {
  const debug = {
    finalBubbles: [
      { blockId: "1", text: "keep" },
      { blockId: "2", text: "drop" }
    ],
    items: []
  };
  const bubbles = [{ block_id: "1" }];
  const result = P.filterOcrDebugFinalBubbles(debug, bubbles);
  assert.equal(result.finalBubbles.length, 1);
  assert.equal(result.finalBubbles[0].text, "keep");
});

test("syncOcrDebugFinalBubbles enriches finalBubbles with bubble data", () => {
  const debug = {
    finalBubbles: [{ blockId: "1" }],
    items: []
  };
  const bubbles = [{ block_id: "1", original_text: "hello", translated_text: "world", x: 10, y: 20, w: 30, h: 40 }];
  const result = P.syncOcrDebugFinalBubbles(debug, bubbles);
  assert.equal(result.finalBubbles[0].text, "hello");
  assert.equal(result.finalBubbles[0].translatedText, "world");
});

/* =================================================================
 * Dedupe helpers
 * ================================================================= */
test("isKakaoBoundaryNeighborBubble checks stitch_boundary_neighbor flag", () => {
  assert.equal(P.isKakaoBoundaryNeighborBubble({ stitch_boundary_neighbor: true }), true);
  assert.equal(P.isKakaoBoundaryNeighborBubble({}), false);
  assert.equal(P.isKakaoBoundaryNeighborBubble(null), false);
});

test("isKakaoGlobalDuplicateCandidate detects duplicate from overlapping box + similar text", () => {
  const candidate = {
    box: { left: 0, top: 0, width: 100, height: 100 },
    text: "hello world",
    translatedText: "你好世界",
    bubble: {}
  };
  const entry = {
    box: { left: 10, top: 10, width: 80, height: 80 },
    text: "hello world",
    translatedText: "你好世界",
    completeness: 10
  };
  // Boxes overlap, texts identical
  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, entry), true);
});

test("trimKakaoBubbleBoundary creates trimmed version", () => {
  const bubble = {
    original_text: "prefix_suffix",
    y: 0, h: 100, x: 0, w: 50,
    source_line_count: 2,
    global_box: { left: 0, top: 0, width: 100, height: 100 }
  };
  // Simulate suffix overlap (last chars of first match first chars of second)
  const overlap = { length: 6, trim: "suffix" };
  const trimmed = P.trimKakaoBubbleBoundary(bubble, overlap);
  assert.notEqual(trimmed, null);
  assert.ok(trimmed.original_text.length < "prefix_suffix".length);
  assert.equal(trimmed.boundary_trimmed, true);
});

test("trimKakaoBubbleBoundary returns null for insufficient overlap", () => {
  const bubble = {
    original_text: "ab",
    y: 0, h: 100
  };
  assert.equal(P.trimKakaoBubbleBoundary(bubble, { length: 5, trim: "suffix" }), null);
});

test("hasAttachedShortPageBubble checks for stitch_attached_short_page", () => {
  assert.equal(P.hasAttachedShortPageBubble(null), false);
  assert.equal(P.hasAttachedShortPageBubble({ bubbles: [{ original_text: "hello" }] }), false);
  assert.equal(P.hasAttachedShortPageBubble({ bubbles: [{ stitch_attached_short_page: true }] }), true);
});

/* =================================================================
 * hasLongestCommonSubstringLength
 * ================================================================= */
test("getLongestCommonSubstringLength finds common substring", () => {
  const result = P.getLongestCommonSubstringLength(
    Array.from("abcdef"), Array.from("bcdefg"), 3
  );
  assert.ok(result >= 3); // "bcdef" is length 5
});

test("getLongestCommonSubstringLength stops at stopAt threshold", () => {
  const result = P.getLongestCommonSubstringLength(
    Array.from("abcdefgh"), Array.from("abcdefgh"), 10
  );
  assert.equal(result, 8); // No early stop, full match
});

/* =================================================================
 * buildSingleFallbackPayload
 * ================================================================= */
test("buildSingleFallbackPayload creates fallback payload", () => {
  const single = { dataUrl: "data:image/png;base64,a", width: 100, height: 200 };
  const stitched = { sourceToken: "token123" };
  const result = P.buildSingleFallbackPayload(single, stitched, "test fallback");
  assert.equal(result.ocrMode, "single-fallback");
  assert.equal(result.fallbackReason, "test fallback");
  assert.equal(result.stitchAdmission, "fallback");
  assert.equal(result.sourceToken, "token123");
});

/* =================================================================
 * buildOcrRequestKey
 * ================================================================= */
test("buildOcrRequestKey includes target key and mode", () => {
  const key = P.buildOcrRequestKey("page-1", { ocrMode: "stitch", sourceToken: "tok1" });
  assert.ok(key.includes("mode:stitch"));
  assert.ok(key.includes("src:"));
});

test("buildOcrRequestKey includes differentiators for different modes", () => {
  const single = P.buildOcrRequestKey("page-1", { ocrMode: "single", sourceToken: "a" });
  const stitch = P.buildOcrRequestKey("page-1", { ocrMode: "stitch", sourceToken: "b" });
  assert.notEqual(single, stitch);
});

/* =================================================================
 * clamp
 * ================================================================= */
test("clamp constrains values within range", () => {
  assert.equal(P.clamp(5, 0, 10), 5);
  assert.equal(P.clamp(-5, 0, 10), 0);
  assert.equal(P.clamp(15, 0, 10), 10);
});

/* =================================================================
 * computeGraySample
 * ================================================================= */
test("computeGraySample converts RGBA to grayscale", () => {
  const result = P.computeGraySample({
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    width: 2,
    height: 1
  });
  assert.notEqual(result, null);
  assert.equal(result.width, 2);
  assert.equal(result.height, 1);
  assert.equal(result.gray.length, 2);
});

test("computeGraySample returns null for empty data", () => {
  assert.equal(P.computeGraySample({}), null);
});

function createPipelineHarness(overrides = {}) {
  const calls = [];
  const store = P.createStore();
  const target = {
    isConnected: true,
    dataset: {},
    sourceToken: "source-a",
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 760, height: 1000 };
    }
  };
  const adapters = {
    store,
    computeTargetKey: () => "page-1",
    getQuickSourceToken: (value) => value.sourceToken,
    buildTargetSourceCacheKey: (key, source) => `${key}|${source}`,
    captureTargetSnapshot: (value) => ({ sourceToken: value.sourceToken }),
    isTargetSnapshotStillValid: (value, snapshot) => value.sourceToken === snapshot.sourceToken,
    extractTargetPayload: async () => {
      calls.push("fetch");
      return { dataUrl: "data:image/png;base64,A", sourceToken: "source-a" };
    },
    shouldUseKakaoStitchedOcr: () => true,
    buildKakaoStitchedPayload: async (_target, payload) => {
      calls.push("stitch");
      return {
        ...payload,
        stitch: {
          canvasWidth: 760,
          canvasHeight: 1000,
          owner: { drawRect: { x: 0, y: 0, w: 760, h: 1000 } },
          segments: [{ source: "owner", drawRect: { x: 0, y: 0, w: 760, h: 1000 } }]
        },
        singleImagePayload: payload
      };
    },
    requestTranslationForPayload: async () => {
      calls.push("recognize");
      return { ok: true, result: { bubbles: [{ original_text: "hello", x: 10, y: 10, w: 20, h: 10 }] } };
    },
    mapStitchedResult: (result) => result,
    dedupeResult: async (result) => {
      calls.push("dedupe");
      return result;
    },
    renderPipelineResult: async () => {
      calls.push("render");
    },
    renderTranslationResult: async () => undefined,
    clearRenderedTarget: () => undefined,
    renderOverlay: () => undefined,
    renderLoadingOverlay: () => undefined,
    tracePipeline: () => undefined,
    scheduleAutoTranslateRetry: () => calls.push("retry"),
    reportPipelineError: async () => undefined,
    ...overrides
  };
  return { pipeline: P.createPipeline(adapters), store, target, calls, adapters };
}

test("pipeline runs fetch, stitch, recognize, dedupe, and render in order", async () => {
  const { pipeline, store, target, calls } = createPipelineHarness();
  const result = await pipeline.run(target, { reason: "test" });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["fetch", "stitch", "recognize", "dedupe", "render"]);
  assert.equal(store.getPagePhase("page-1|source-a"), P.PagePhase.RENDERED);
});

test("pipeline merges duplicate requests for the same page identity", async () => {
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const harness = createPipelineHarness({
    requestTranslationForPayload: () => request
  });

  const first = harness.pipeline.run(harness.target, { reason: "first" });
  const second = harness.pipeline.run(harness.target, { reason: "second" });
  assert.equal(first, second);

  resolveRequest({ ok: true, result: { bubbles: [] } });
  assert.equal((await first).ok, true);
});

test("cached pipeline follows dedupe and render without fetch or recognize", async () => {
  const harness = createPipelineHarness({
    renderCachedPipelineResult: async () => {
      harness.calls.push("cached-render");
    }
  });
  const result = await harness.pipeline.runCached(
    harness.target,
    { bubbles: [{ original_text: "cached", x: 1, y: 1, w: 10, h: 10 }] },
    { reason: "cache" }
  );

  assert.equal(result.reused, true);
  assert.deepEqual(harness.calls, ["dedupe", "cached-render"]);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.RENDERED);
});

test("pipeline cancels a late result after the source token changes", async () => {
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const harness = createPipelineHarness({
    requestTranslationForPayload: () => request
  });

  const pending = harness.pipeline.run(harness.target, { reason: "stale" });
  await Promise.resolve();
  harness.target.sourceToken = "source-b";
  resolveRequest({ ok: true, result: { bubbles: [] } });

  const result = await pending;
  assert.equal(result.skipped, true);
  assert.match(result.reason, /cancelled:sourceChanged/);
  assert.equal(harness.calls.includes("render"), false);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.CANCELLED);
});

test("pipeline failure moves the page to failed without leaking an inflight job", async () => {
  const harness = createPipelineHarness({
    requestTranslationForPayload: async () => {
      throw new Error("network failed");
    }
  });

  const result = await harness.pipeline.run(harness.target, { reason: "error" });
  assert.equal(result.ok, false);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.FAILED);

  harness.adapters.requestTranslationForPayload = async () => ({ ok: true, result: { bubbles: [] } });
  const retried = await harness.pipeline.run(harness.target, { reason: "retry" });
  assert.equal(retried.ok, true);
});
