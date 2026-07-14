import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Mirror manifest ordering so canonical integration uses the real pure reconciler.
await import("../kakao-reconciler.js");
await import("../kakao-pipeline.js");

const P = globalThis.MangaTranslatorKakaoPipeline;

test("manifest loads the Kakao module before content.js", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.content_scripts[0].js.slice(0, 3),
    ["kakao-reconciler.js", "kakao-pipeline.js", "content.js"]
  );
  const buildSource = fs.readFileSync(path.join(root, "scripts", "build-extension.mjs"), "utf8");
  assert.match(buildSource, /"kakao-reconciler\.js"/);
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

  const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const backgroundFilesMatch = backgroundSource.match(
    /const CONTENT_SCRIPT_FILES = Object\.freeze\((\[[\s\S]*?\])\);/
  );
  assert.ok(backgroundFilesMatch, "background should declare its ordered content-script dependencies");
  assert.deepEqual(JSON.parse(backgroundFilesMatch[1]), manifest.content_scripts[0].js);
  assert.match(
    backgroundSource,
    /await safeExecuteScriptFiles\(tabId, CONTENT_SCRIPT_FILES\)/,
    "extension-update recovery should inject the complete ordered dependency list"
  );
  assert.match(backgroundSource, /files:\s*\[\.\.\.files\]/);
});

test("popup translate button runs manual viewport translation in manual mode", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const popupSource = fs.readFileSync(path.join(root, "popup.js"), "utf8");

  assert.match(
    popupSource,
    /translateBtn\.addEventListener\("click", async \(\) => \{[\s\S]*?await handleTranslateButtonClick\(\);[\s\S]*?\}\);/
  );
  assert.match(
    popupSource,
    /async function handleTranslateButtonClick\(\)[\s\S]*?shouldTranslateButtonUsePageAuto\(\)[\s\S]*?togglePageAutoTranslate\(\)[\s\S]*?translateCurrentViewport\(\)/
  );
  assert.match(
    popupSource,
    /async function translateCurrentViewport\(\)[\s\S]*?runManualTranslateAllFrames\(tab\.id\)/
  );
  assert.match(
    popupSource,
    /async function runManualTranslateAllFrames\(tabId\)[\s\S]*?hasUsableManualFrameResult\(merged\)[\s\S]*?sendMessageToTab\(tabId, \{ type: "MANUAL_TRANSLATE_VISIBLE" \}\)/
  );
  assert.match(
    popupSource,
    /async function runTogglePageAutoTranslateAllFrames\(tabId, enabled\)[\s\S]*?hasUsablePageAutoFrameResult\(merged\)[\s\S]*?sendMessageToTab\(tabId, \{ type: "TOGGLE_PAGE_AUTO_TRANSLATE", enabled \}\)/
  );
  assert.match(
    popupSource,
    /function mergeManualFrameResults\(frameResults\)[\s\S]*?let skippedCount = 0;[\s\S]*?payload\.skipped[\s\S]*?skippedCount \+= 1;[\s\S]*?skippedCount,/
  );
  assert.match(
    popupSource,
    /function mergePageAutoFrameResults\(frameResults\)[\s\S]*?let skippedCount = 0;[\s\S]*?payload\.skipped[\s\S]*?skippedCount \+= 1;[\s\S]*?skippedCount,/
  );
  assert.match(
    popupSource,
    /function hasUsableManualFrameResult\(merged\)[\s\S]*?merged\.skippedCount[\s\S]*?=== 0;/
  );
  assert.match(
    popupSource,
    /function shouldTranslateButtonUsePageAuto\(\)[\s\S]*?pageAutoTranslateEnabled \|\| normalizePretranslateMode\(pretranslateModeSelect\.value\) !== "manual"/
  );
  assert.match(popupSource, /translateBtn\.textContent = "翻译当前视口"/);
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
    "clearRetryStates", "registerPageHandle", "getPageHandle",
    "getPageHandleForTarget", "unbindPageTarget", "upsertObservations",
    "getObservations", "markPageTerminal", "getPageTerminal",
    "runSerializedReconcile", "setCanonicalSnapshot", "getCanonicalSnapshot",
    "getRetiredCanonicals", "setReconcileDiagnostics", "getReconcileDiagnostics",
    "setCoverageLedger", "getCoverageLedger", "setProjections",
    "getProjections", "claimTranslations", "settleTranslation",
    "setEdgeWait", "getEdgeWait", "clearEdgeWait", "reset"
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

test("findKakaoVerticalOverlap rejects sparse text mismatches on white panels", () => {
  const width = 96;
  const height = 200;
  const previous = new Uint8Array(width * height).fill(255);
  const current = new Uint8Array(width * height).fill(255);
  const drawTextStroke = (pixels, row, left, right) => {
    for (let y = row; y < row + 2; y += 1) {
      for (let x = left; x < right; x += 1) {
        pixels[y * width + x] = 20;
      }
    }
  };
  [[44, 8, 42], [84, 18, 58], [124, 28, 72], [164, 10, 66]]
    .forEach(([row, left, right]) => drawTextStroke(previous, row, left, right));
  [[30, 35, 82], [70, 5, 30], [110, 42, 90], [150, 20, 48]]
    .forEach(([row, left, right]) => drawTextStroke(current, row, left, right));

  const overlap = P.findKakaoVerticalOverlap(
    { width, height, gray: previous },
    { width, height, gray: current }
  );

  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, false, JSON.stringify(overlap));
});

test("findKakaoVerticalOverlap accepts matching sparse text on white panels", () => {
  const width = 96;
  const height = 200;
  const previous = new Uint8Array(width * height).fill(255);
  const current = new Uint8Array(width * height).fill(255);
  const drawTextStroke = (pixels, row) => {
    for (let y = row; y < row + 2; y += 1) {
      for (let x = 12; x < 52; x += 1) {
        pixels[y * width + x] = 20;
      }
    }
  };
  [90, 130, 170].forEach((row) => drawTextStroke(previous, row));
  [10, 50, 90].forEach((row) => drawTextStroke(current, row));

  const overlap = P.findKakaoVerticalOverlap(
    { width, height, gray: previous },
    { width, height, gray: current }
  );

  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, true);
  assert.ok(overlap.informativeMae <= 1);
});

test("hasUsableKakaoStripCaptureRect validates minimum dimensions", () => {
  assert.equal(P.hasUsableKakaoStripCaptureRect(null), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 100, height: 100 }), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 180, height: 180 }), true);
  assert.equal(P.hasUsableKakaoStripCaptureRect({ width: 760, height: 200 }), true);
});

test("overlap crop cannot complete a full page from a tiny unique suffix", () => {
  assert.equal(P.hasUsefulKakaoOverlapCrop(857, 143, 1000), false);
  assert.equal(P.hasUsefulKakaoOverlapCrop(750, 250, 1000), true);
  assert.equal(P.hasUsefulKakaoOverlapCrop(100, 120, 500), false);
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

test("cross-page overflow dedupe uses strong geometry when OCR texts disagree", () => {
  const ownerEntry = {
    box: { left: 697.98, top: 320.79, width: 449.71, height: 291.9 },
    text: "꼬를존풍하지않는행동시퇴깡조시됩니다",
    translatedText: "不尊重规则者将被驱逐",
    targetKey: "page-owner",
    bubble: { region_type: "caption_panel" }
  };
  const overflowCandidate = {
    box: { left: 719.41, top: 432.48, width: 415.15, height: 176.54 },
    text: "퇴깡않는행동께꼬끼됩니다",
    translatedText: "因为你不肯罢休事情变得棘手了",
    targetKey: "page-overflow",
    bubble: { region_type: "caption_panel", stitch_overflow: true }
  };

  assert.equal(P.isKakaoGlobalDuplicateCandidate(overflowCandidate, ownerEntry), true);
});

test("geometry-only overflow dedupe keeps same-page and different-region bubbles", () => {
  const box = { left: 100, top: 200, width: 300, height: 180 };
  const candidate = {
    box,
    text: "완전히다른문장",
    translatedText: "完全不同的句子",
    targetKey: "page-a",
    bubble: { region_type: "caption_panel", stitch_overflow: true }
  };
  const samePage = {
    box,
    text: "겹치지만별개문장",
    translatedText: "重叠但独立的句子",
    targetKey: "page-a",
    bubble: { region_type: "caption_panel" }
  };
  const differentRegion = {
    ...samePage,
    targetKey: "page-b",
    bubble: { region_type: "effect_text" }
  };

  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, samePage), false);
  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, differentRegion), false);
});

test("visual duplicate selection keeps the owner box over an overflow copy", () => {
  const owner = {
    scopeKey: "page-owner",
    regionType: "caption_panel",
    stitchOverflow: false,
    box: { left: 697.98, top: 543.77, width: 449.71, height: 291.9 }
  };
  const overflow = {
    scopeKey: "page-overflow",
    regionType: "caption_panel",
    stitchOverflow: true,
    box: { left: 719.41, top: 654.47, width: 415.15, height: 176.54 }
  };

  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, overflow), "right");
  assert.equal(P.selectKakaoVisualDuplicateLoser(overflow, owner), "left");
  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, { ...overflow, scopeKey: owner.scopeKey }), null);
  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, { ...overflow, regionType: "effect_text" }), null);
});

test("visual duplicate selection removes the less complete of two related overflow copies", () => {
  const shorter = {
    scopeKey: "page-overflow-a",
    regionType: "effect_text",
    stitchOverflow: true,
    originalText: "이쪽 방향이어야",
    translatedText: "应该是方向",
    box: { left: 730, top: 520, width: 280, height: 150 }
  };
  const complete = {
    scopeKey: "page-overflow-b",
    regionType: "effect_text",
    stitchOverflow: true,
    originalText: "이쪽 방향이어야 한다.",
    translatedText: "应该是这个方向。",
    box: { left: 738, top: 526, width: 275, height: 148 }
  };

  assert.equal(P.selectKakaoVisualDuplicateLoser(shorter, complete), "left");
  assert.equal(P.selectKakaoVisualDuplicateLoser(complete, shorter), "right");
  assert.equal(
    P.selectKakaoVisualDuplicateLoser(shorter, {
      ...complete,
      originalText: "완전히 다른 대사",
      translatedText: "完全不同的对白"
    }),
    null
  );
});

test("superseded Kakao entry keeps the source-scoped cache identity", async () => {
  const store = P.createStore();
  const target = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 947 })
  };
  let supersededEntry = null;

  await P.dedupeKakaoResultByPageCoordinates({
    result: {
      bubbles: [{
        x: 25, y: 95, w: 55, h: 30,
        original_text: "그럼그렇지박문대가금발이고",
        translated_text: "就是嘛"
      }]
    },
    target,
    targetKey: "page-previous",
    scopedTargetKey: "page-previous|source-previous",
    store
  });

  await P.dedupeKakaoResultByPageCoordinates({
    result: {
      bubbles: [{
        x: 25, y: 95, w: 55, h: 30,
        original_text: "그림그렇지박문대가금발이고",
        translated_text: "我就知道朴文代是金发什么的都无所谓"
      }]
    },
    target,
    targetKey: "page-current",
    scopedTargetKey: "page-current|source-current",
    store,
    adapters: {
      onSupersededEntry: (entry) => { supersededEntry = entry; }
    }
  });

  assert.ok(supersededEntry, "the more complete overlapping result should supersede the old one");
  assert.equal(supersededEntry.targetKey, "page-previous");
  assert.equal(supersededEntry.scopedTargetKey, "page-previous|source-previous");
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

/* =================================================================
 * Authoritative page OCR + canonical pipeline
 * ================================================================= */

function makeCanonicalObservation(pageId, revision, id, y = 40, text = id) {
  return {
    id,
    sourceType: "page",
    pageIds: [pageId],
    imageRevisionByPage: { [pageId]: revision },
    pageSpans: [{ pageId, box: { x: 20, y, w: 20, h: 6 }, overlapRatio: 1 }],
    originalText: text,
    confidence: 0.95,
    visual: { regionType: "speech", bgType: "solid" },
    providerBlockId: id
  };
}

function createCanonicalHarness(options = {}) {
  const calls = [];
  const traces = [];
  const timers = [];
  const ocrMetas = [];
  const renderInputs = [];
  const targets = {
    a: { name: "a", sourceToken: "source-a", generation: 0, isConnected: true },
    b: { name: "b", sourceToken: "source-b", generation: 0, isConnected: true }
  };
  const identities = {
    a: { chapterId: "chapter", pageId: "page-a", imageRevision: "rev-a", width: 800, height: 2000, readingOrder: 1 },
    b: { chapterId: "chapter", pageId: "page-b", imageRevision: "rev-b", width: 800, height: 2000, readingOrder: 2 }
  };
  const pageObservations = options.pageObservations || {
    a: [makeCanonicalObservation("page-a", "rev-a", "obs-a", 40, "inside A")],
    b: [makeCanonicalObservation("page-b", "rev-b", "obs-b", 40, "inside B")]
  };
  const store = P.createStore();
  const loadingClears = [];
  const adapters = {
    store,
    computeTargetKey: (target) => `target-${target.name}`,
    getQuickSourceToken: (target) => target.sourceToken,
    getTargetGeneration: (target) => target.generation,
    buildTargetSourceCacheKey: (targetKey, sourceToken) => `${targetKey}|${sourceToken}`,
    extractTargetPayload: async (target) => {
      calls.push(`fetch:${target.name}`);
      return { dataUrl: `data:image/png;base64,${target.name}`, width: 800, height: 2000 };
    },
    buildPageIdentity: async (target) => ({ ...identities[target.name] }),
    requestOcrForPayload: async (_payload, meta) => {
      ocrMetas.push({ ...meta });
      calls.push(`ocr:${meta.sourceType}:${meta.pageIds.join("+")}`);
      if (meta.sourceType === "seam") {
        if (options.seamFailure) throw new Error("seam unavailable");
        return {
          ok: true,
          result: {
            observations: options.seamObservations || [],
            filteredObservations: [],
            edgeSignals: {},
            ...(options.seamCleanedImage ? { cleanedImage: options.seamCleanedImage } : {}),
            ...(options.seamCleanedImageToken ? { cleanedImageToken: options.seamCleanedImageToken } : {}),
            ...(options.seamDebug ? { debug: options.seamDebug } : {})
          }
        };
      }
      const targetName = meta.pageIds[0] === "page-a" ? "a" : "b";
      if (options.pageFailure === targetName) throw new Error(`page ${targetName} failed`);
      return {
        ok: true,
        result: {
          observations: pageObservations[targetName] || [],
          filteredObservations: options.filteredObservations && options.filteredObservations[targetName] || [],
          edgeSignals: options.edgeSignals && options.edgeSignals[targetName] || {},
          ...(options.pageDebug && options.pageDebug[targetName]
            ? { debug: options.pageDebug[targetName] }
            : {}),
          ...(meta.forceCleanedImageArtifact && options.artifactCleanedImage
            ? { cleanedImage: options.artifactCleanedImage, debug: { artifact: true } }
            : {})
        }
      };
    },
    requestCanonicalTranslations: async (items) => {
      calls.push(`translate:${items.map((item) => `${item.id}@${item.revision}:${item.original_text}`).join(",")}`);
      if (options.translateDeferred) return options.translateDeferred(items);
      return {
        ok: true,
        result: {
          translations: items.map((item) => ({
            id: item.id,
            revision: item.revision,
            translated_text: `ZH:${item.original_text}`,
            translationFingerprint: `fp:${item.original_text}`,
            cached: false
          }))
        }
      };
    },
    renderCanonicalProjections: async (input) => {
      const { pageId, projections } = input;
      renderInputs.push(input);
      calls.push(`render:${pageId}:${projections.filter((item) => item.activeText).length}`);
    },
    findAdjacentKakaoPageTargets: (target) => target.name === "a"
      ? { next: targets.b }
      : { previous: targets.a },
    buildKakaoSeamPayload: async (_pageA, _pageB, plan) => {
      calls.push(`seam-payload:${plan.bandHeight}`);
      return options.seamPayload || { dataUrl: "data:image/png;base64,seam", width: 800, height: plan.bandHeight * 2 };
    },
    detectAdjacentKakaoPixelRisk: async () => options.pixelRisk || null,
    getTargetForKakaoPageId: (pageId) => pageId === "page-a" ? targets.a : pageId === "page-b" ? targets.b : null,
    captureTargetSnapshot: (target) => ({ sourceToken: target.sourceToken }),
    isTargetSnapshotStillValid: (target, snapshot) => target.sourceToken === snapshot.sourceToken,
    renderLoadingOverlay: () => {},
    clearLoadingOverlay: (target) => loadingClears.push(target.name),
    tracePipeline: (event, _target, details) => traces.push({ event, details }),
    scheduleAutoTranslateRetry: () => calls.push("retry"),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    now: () => 1000,
    edgeWaitTimeoutMs: options.edgeWaitTimeoutMs ?? 8000,
    ...options.adapterOverrides
  };
  return {
    pipeline: P.createCanonicalPipeline(adapters),
    adapters,
    store,
    targets,
    calls,
    traces,
    timers,
    ocrMetas,
    renderInputs,
    loadingClears,
    identities
  };
}

test("ready page OCR debug is rendered before translation settles", async () => {
  let releaseTranslation;
  const translationGate = new Promise((resolve) => { releaseTranslation = resolve; });
  const harness = createCanonicalHarness({
    pageDebug: {
      a: { rawItems: [{ text: "inside A", box: { left: 1, top: 2, width: 3, height: 4 } }] }
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      requestCanonicalTranslations: async (items) => {
        harness.calls.push(`translate:${items.map((item) => item.id).join(",")}`);
        return translationGate;
      }
    }
  });

  const pending = harness.pipeline.run(harness.targets.a);
  for (let index = 0; index < 20 && !harness.calls.some((item) => item.startsWith("translate:")); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(harness.calls.some((item) => item.startsWith("translate:")));
  const debugRender = harness.renderInputs.find((input) =>
    input.pageId === "page-a" && input.projections.length === 0 && input.debug
  );
  assert.ok(debugRender);
  assert.deepEqual(debugRender.debug, {
    rawItems: [{ text: "inside A", box: { left: 1, top: 2, width: 3, height: 4 } }]
  });

  releaseTranslation({
    ok: true,
    result: {
      translations: harness.store.getCanonicalSnapshot().map((item) => ({
        id: item.id,
        revision: item.revision,
        translated_text: `ZH:${item.originalText}`
      }))
    }
  });
  const result = await pending;
  assert.equal(result.ok, true);
});

test("debug-only refresh does not redraw an already translated neighbor", async () => {
  const harness = createCanonicalHarness({
    pageDebug: {
      a: { rawItems: [{ text: "A", box: { left: 1, top: 2, width: 3, height: 4 } }] },
      b: { rawItems: [{ text: "B", box: { left: 5, top: 6, width: 7, height: 8 } }] }
    }
  });
  await harness.pipeline.run(harness.targets.a);
  harness.renderInputs.length = 0;

  await harness.pipeline.run(harness.targets.b);

  assert.equal(
    harness.renderInputs.some((input) => input.pageId === "page-a" && input.debugOnly === true),
    false
  );
  assert.equal(
    harness.renderInputs.some((input) =>
      input.pageId === "page-b" && input.debugOnly === true && input.projections.length === 0
    ),
    true
  );
});

test("a configured page resolver is authoritative when an old handle target remains", async () => {
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      getTargetForKakaoPageId: () => null
    }
  });

  const result = await harness.pipeline.run(harness.targets.a);

  assert.equal(result.ok, true);
  assert.equal(harness.renderInputs.length, 0);
});

test("canonical pipeline uses page OCR stages and never calls legacy stitch/dedupe hooks", async () => {
  let legacyCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      shouldUseKakaoStitchedOcr: () => { legacyCalls += 1; return true; },
      buildKakaoStitchedPayload: () => { legacyCalls += 1; },
      dedupeResult: () => { legacyCalls += 1; }
    }
  });

  const result = await harness.pipeline.run(harness.targets.a, { reason: "canonical" });
  assert.equal(result.ok, true);
  assert.equal(legacyCalls, 0);
  assert.equal(harness.calls.filter((call) => call === "ocr:page:page-a").length, 1);
  const stages = harness.traces.map((item) => item.event);
  for (const stage of [
    "canonical:fetch", "canonical:page-ocr", "canonical:observe",
    "canonical:reconcile", "canonical:translate", "canonical:project", "canonical:render"
  ]) {
    assert.ok(stages.includes(stage), `missing stage ${stage}`);
  }
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
  assert.deepEqual(harness.loadingClears, ["a"]);
});

test("canonical pipeline clears loading when a page terminates with an error", async () => {
  const harness = createCanonicalHarness({ pageFailure: "a" });

  const result = await harness.pipeline.run(harness.targets.a, { reason: "canonical-error" });

  assert.equal(result.ok, false);
  assert.deepEqual(harness.loadingClears, ["a"]);
});

test("canonical render skips another page while its authoritative OCR is still running", async () => {
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null })
    }
  });
  harness.store.registerPageHandle({
    ...harness.identities.b,
    target: harness.targets.b,
    targetKey: "target-b",
    scopedTargetKey: "target-b|source-b",
    payload: { dataUrl: "data:image/png;base64,b", width: 800, height: 2000 },
    pageOcrState: "running"
  });

  const result = await harness.pipeline.run(harness.targets.a, { reason: "render-with-running-neighbor" });

  assert.equal(result.ok, true);
  assert.equal(
    harness.renderInputs.some((input) => input.pageId === "page-b"),
    false,
    "a running page must remain pending instead of being rendered as empty"
  );
});

test("canonical render marks no-text only after authoritative OCR completes empty", async () => {
  const harness = createCanonicalHarness({
    pageObservations: { a: [], b: [] },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null })
    }
  });

  const result = await harness.pipeline.run(harness.targets.a, { reason: "authoritative-empty" });
  const render = harness.renderInputs.find((input) => input.pageId === "page-a");

  assert.equal(result.ok, true);
  assert.ok(render);
  assert.equal(render.authoritativeEmpty, true);
});

test("same-URL generation change starts fresh OCR and cancels the late prior revision", async () => {
  let releaseFirstOcr;
  let releaseSecondOcr;
  let markFirstStarted;
  let markSecondStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirstOcr = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecondOcr = resolve; });
  let pageOcrCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      buildPageIdentity: async (target) => ({
        chapterId: "chapter",
        pageId: `page-${target.name}`,
        imageRevision: `rev-${target.generation}`,
        width: 800,
        height: 2000,
        readingOrder: target.name === "a" ? 1 : 2
      }),
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType !== "page") {
          return { ok: true, result: { observations: [], filteredObservations: [], edgeSignals: {} } };
        }
        pageOcrCalls += 1;
        if (pageOcrCalls === 1) {
          markFirstStarted();
          await firstGate;
        } else if (pageOcrCalls === 2) {
          markSecondStarted();
          await secondGate;
        }
        const pageId = meta.pageIds[0];
        const revision = meta.imageRevisionByPage[pageId];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation(pageId, revision, `obs-${revision}`, 40, `text-${revision}`)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const firstRun = harness.pipeline.run(harness.targets.a);
  await firstStarted;
  harness.targets.a.generation = 1;
  const secondRun = harness.pipeline.run(harness.targets.a);
  await secondStarted;
  releaseFirstOcr();
  const firstResult = await firstRun;
  releaseSecondOcr();
  const secondResult = await secondRun;

  assert.equal(secondResult.ok, true);
  assert.equal(firstResult.skipped, true);
  assert.match(firstResult.reason, /cancelled/);
  assert.equal(pageOcrCalls, 2);
  assert.deepEqual(harness.store.getObservationsForPage("page-a").map((item) => item.id), ["obs-rev-1"]);
});

test("a stale identity hash cannot commit after a newer generation", async () => {
  let releaseOldIdentity;
  let markOldIdentityStarted;
  const oldIdentityStarted = new Promise((resolve) => { markOldIdentityStarted = resolve; });
  const oldIdentityGate = new Promise((resolve) => { releaseOldIdentity = resolve; });
  let identityCalls = 0;
  const committedRevisions = [];
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      buildPageIdentity: async (target) => {
        const generation = target.generation;
        identityCalls += 1;
        if (identityCalls === 1) {
          markOldIdentityStarted();
          await oldIdentityGate;
        }
        return {
          chapterId: "chapter",
          pageId: "page-a",
          imageRevision: `rev-${generation}`,
          width: 800,
          height: 2000,
          readingOrder: 1
        };
      },
      commitPageIdentity: (_target, identity) => committedRevisions.push(identity.imageRevision),
      requestOcrForPayload: async (_payload, meta) => {
        const revision = meta.imageRevisionByPage["page-a"];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, `text-${revision}`)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const oldRun = harness.pipeline.run(harness.targets.a);
  await oldIdentityStarted;
  harness.targets.a.generation = 1;
  const newResult = await harness.pipeline.run(harness.targets.a);
  releaseOldIdentity();
  const oldResult = await oldRun;

  assert.equal(newResult.ok, true);
  assert.equal(oldResult.skipped, true);
  assert.deepEqual(committedRevisions, ["rev-1"]);
  assert.equal(harness.store.getPageHandle("page-a").imageRevision, "rev-1");
});

test("a late older-revision clone cannot overwrite a newer page commit", async () => {
  let releaseOldIdentity;
  let markOldIdentity;
  const oldIdentityStarted = new Promise((resolve) => { markOldIdentity = resolve; });
  const oldIdentityGate = new Promise((resolve) => { releaseOldIdentity = resolve; });
  const oldClone = { name: "a", sourceToken: "clone-old", generation: 0, revision: "rev-old", isConnected: true };
  const newClone = { name: "a", sourceToken: "clone-new", generation: 0, revision: "rev-new", isConnected: true };
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      getTargetForKakaoPageId: () => newClone,
      buildPageIdentity: async (target) => {
        if (target === oldClone) {
          markOldIdentity();
          await oldIdentityGate;
        }
        return {
          chapterId: "chapter",
          pageId: "page-a",
          imageRevision: target.revision,
          width: 800,
          height: 2000,
          readingOrder: 1
        };
      },
      requestOcrForPayload: async (_payload, meta) => {
        const revision = meta.imageRevisionByPage["page-a"];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const oldRun = harness.pipeline.run(oldClone);
  await oldIdentityStarted;
  const newResult = await harness.pipeline.run(newClone);
  releaseOldIdentity();
  const oldResult = await oldRun;

  assert.equal(newResult.ok, true);
  assert.equal(oldResult.skipped, true);
  assert.match(oldResult.reason, /superseded/);
  assert.equal(harness.store.getPageHandle("page-a").imageRevision, "rev-new");
  assert.deepEqual(harness.store.getObservationsForPage("page-a").map((item) => item.id), ["obs-rev-new"]);
});

test("a previously bound stale clone is rejected even when retried later", async () => {
  const oldClone = { name: "a", sourceToken: "clone-old", generation: 0, revision: "rev-old", isConnected: true };
  const newClone = { name: "a", sourceToken: "clone-new", generation: 0, revision: "rev-new", isConnected: true };
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      getTargetForKakaoPageId: () => newClone,
      buildPageIdentity: async (target) => ({
        chapterId: "chapter",
        pageId: "page-a",
        imageRevision: target.revision,
        width: 800,
        height: 2000,
        readingOrder: 1
      }),
      requestOcrForPayload: async (_payload, meta) => {
        const revision = meta.imageRevisionByPage["page-a"];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  assert.equal((await harness.pipeline.run(oldClone)).ok, true);
  assert.equal((await harness.pipeline.run(newClone)).ok, true);
  const retry = await harness.pipeline.run(oldClone);

  assert.equal(retry.skipped, true);
  assert.match(retry.reason, /superseded/);
  assert.equal(harness.store.getPageHandle("page-a").imageRevision, "rev-new");
});

test("same-digest reload reuses one late translation and lets the current generation render it", async () => {
  let releaseTranslation;
  let markTranslationStarted;
  let markSecondOcr;
  const translationStarted = new Promise((resolve) => { markTranslationStarted = resolve; });
  const secondOcrStarted = new Promise((resolve) => { markSecondOcr = resolve; });
  const translationGate = new Promise((resolve) => { releaseTranslation = resolve; });
  let translationCalls = 0;
  let pageOcrCalls = 0;
  const harness = createCanonicalHarness({
    translateDeferred: async (items) => {
      translationCalls += 1;
      markTranslationStarted();
      await translationGate;
      return {
        ok: true,
        result: {
          translations: items.map((item) => ({
            id: item.id,
            revision: item.revision,
            translated_text: `ZH:${item.original_text}`,
            translationFingerprint: `fp:${item.original_text}`
          }))
        }
      };
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType === "page") {
          pageOcrCalls += 1;
          if (pageOcrCalls === 2) markSecondOcr();
        }
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", "rev-a", "obs-a", 40, "same bytes")],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const oldRun = harness.pipeline.run(harness.targets.a);
  await translationStarted;
  harness.targets.a.generation = 1;
  const currentRun = harness.pipeline.run(harness.targets.a);
  await secondOcrStarted;
  releaseTranslation();
  const [oldResult, currentResult] = await Promise.all([oldRun, currentRun]);

  assert.equal(oldResult.skipped, true);
  assert.equal(currentResult.ok, true);
  assert.equal(translationCalls, 1);
  const [canonical] = harness.store.getCanonicalSnapshot();
  assert.ok(harness.store.getTranslation(canonical.id, canonical.revision));
  assert.ok(harness.store.getProjections("page-a").some((item) => item.activeText && item.translated_text));
});

test("a slow disconnected clone cannot regress a rendered same-revision page", async () => {
  let releaseOldNeighborScan;
  let markOldNeighborScan;
  const oldNeighborScanStarted = new Promise((resolve) => { markOldNeighborScan = resolve; });
  const oldNeighborGate = new Promise((resolve) => { releaseOldNeighborScan = resolve; });
  const oldClone = { name: "a", sourceToken: "source-a", generation: 0, isConnected: true };
  const newClone = { name: "a", sourceToken: "source-a", generation: 0, isConnected: true };
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: async (target) => {
        if (target === oldClone) {
          markOldNeighborScan();
          await oldNeighborGate;
        }
        return { previous: null, next: null };
      },
      getTargetForKakaoPageId: () => newClone
    }
  });

  const oldRun = harness.pipeline.run(oldClone);
  await oldNeighborScanStarted;
  const newResult = await harness.pipeline.run(newClone);
  assert.equal(newResult.ok, true);
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);

  oldClone.isConnected = false;
  releaseOldNeighborScan();
  const oldResult = await oldRun;
  assert.equal(oldResult.skipped, true);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
});

test("a stale OCR rejection cannot fail or retry the current generation", async () => {
  let rejectOldOcr;
  let releaseNewOcr;
  let markOldOcr;
  let markNewOcr;
  const oldOcrStarted = new Promise((resolve) => { markOldOcr = resolve; });
  const newOcrStarted = new Promise((resolve) => { markNewOcr = resolve; });
  const oldOcrGate = new Promise((_resolve, reject) => { rejectOldOcr = reject; });
  const newOcrGate = new Promise((resolve) => { releaseNewOcr = resolve; });
  let ocrCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      buildPageIdentity: async (target) => ({
        chapterId: "chapter",
        pageId: "page-a",
        imageRevision: `rev-${target.generation}`,
        width: 800,
        height: 2000,
        readingOrder: 1
      }),
      requestOcrForPayload: async (_payload, meta) => {
        ocrCalls += 1;
        if (ocrCalls === 1) {
          markOldOcr();
          await oldOcrGate;
        } else {
          markNewOcr();
          await newOcrGate;
        }
        const revision = meta.imageRevisionByPage["page-a"];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const oldRun = harness.pipeline.run(harness.targets.a);
  await oldOcrStarted;
  harness.targets.a.generation = 1;
  const newRun = harness.pipeline.run(harness.targets.a);
  await newOcrStarted;
  rejectOldOcr(new Error("late old failure"));
  const oldResult = await oldRun;
  assert.equal(oldResult.skipped, true);
  assert.equal(harness.calls.includes("retry"), false);

  releaseNewOcr();
  const newResult = await newRun;
  assert.equal(newResult.ok, true);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.calls.includes("retry"), false);
});

test("an older clone OCR failure cannot overwrite a newer revision terminal", async () => {
  let rejectOldOcr;
  let markOldOcr;
  const oldOcrStarted = new Promise((resolve) => { markOldOcr = resolve; });
  const oldOcrGate = new Promise((_resolve, reject) => { rejectOldOcr = reject; });
  const oldClone = { name: "a", sourceToken: "clone-old", generation: 0, revision: "rev-old", isConnected: true };
  const newClone = { name: "a", sourceToken: "clone-new", generation: 0, revision: "rev-new", isConnected: true };
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      getTargetForKakaoPageId: () => newClone,
      buildPageIdentity: async (target) => ({
        chapterId: "chapter",
        pageId: "page-a",
        imageRevision: target.revision,
        width: 800,
        height: 2000,
        readingOrder: 1
      }),
      requestOcrForPayload: async (_payload, meta) => {
        const revision = meta.imageRevisionByPage["page-a"];
        if (revision === "rev-old") {
          markOldOcr();
          await oldOcrGate;
        }
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const oldRun = harness.pipeline.run(oldClone);
  await oldOcrStarted;
  const newResult = await harness.pipeline.run(newClone);
  rejectOldOcr(new Error("old clone failed late"));
  const oldResult = await oldRun;

  assert.equal(newResult.ok, true);
  assert.equal(oldResult.skipped, true);
  assert.equal(harness.store.getPageHandle("page-a").imageRevision, "rev-new");
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getPageTerminal("page-a").details.imageRevision, "rev-new");
  assert.equal(harness.calls.includes("retry"), false);
});

test("an old ready terminal cannot make a new running revision seam-ready", async () => {
  let releaseNewRevisionOcr;
  let markNewRevisionOcr;
  const newRevisionOcrStarted = new Promise((resolve) => { markNewRevisionOcr = resolve; });
  const newRevisionGate = new Promise((resolve) => { releaseNewRevisionOcr = resolve; });
  let pageAOcrCalls = 0;
  let seamCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      buildPageIdentity: async (target) => ({
        chapterId: "chapter",
        pageId: `page-${target.name}`,
        imageRevision: `rev-${target.name}-${target.generation}`,
        width: 800,
        height: 2000,
        readingOrder: target.name === "a" ? 1 : 2
      }),
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType === "seam") {
          seamCalls += 1;
          return { ok: true, result: { observations: [], filteredObservations: [], edgeSignals: {} } };
        }
        const pageId = meta.pageIds[0];
        const revision = meta.imageRevisionByPage[pageId];
        if (pageId === "page-a") {
          pageAOcrCalls += 1;
          if (pageAOcrCalls === 2) {
            markNewRevisionOcr();
            await newRevisionGate;
          }
        }
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation(
              pageId,
              revision,
              `obs-${revision}`,
              pageId === "page-a" ? 94 : 0,
              pageId === "page-a" ? "upper" : "lower"
            )],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  harness.targets.a.generation = 1;
  const newRevisionRun = harness.pipeline.run(harness.targets.a);
  await newRevisionOcrStarted;

  const neighborResult = await harness.pipeline.run(harness.targets.b);
  assert.equal(neighborResult.ok, true);
  assert.equal(seamCalls, 0, "the neighbor must wait for the current page revision OCR");

  releaseNewRevisionOcr();
  const newRevisionResult = await newRevisionRun;
  assert.equal(newRevisionResult.ok, true);
  assert.equal(seamCalls, 1);
});

test("same-page same-revision OCR recapture atomically replaces the prior capture", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "capture-old", 40, "old OCR text")],
    b: []
  };
  const harness = createCanonicalHarness({ pageObservations });
  await harness.pipeline.run(harness.targets.a, { reason: "first-capture" });

  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a", "capture-new", 40, "corrected OCR text")];
  await harness.pipeline.run(harness.targets.a, { reason: "recapture" });

  const observations = harness.store.getObservationsForPage("page-a", { includeFiltered: true });
  const canonicals = harness.store.getCanonicalSnapshot();
  assert.deepEqual(observations.map((item) => item.id), ["capture-new"]);
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0].originalText, "corrected OCR text");
  assert.deepEqual(canonicals[0].memberObservationIds, ["capture-new"]);
  assert.equal(harness.store.getCoverageLedger().has("capture-old"), false);
});

test("a failed same-revision recapture preserves the prior ready page facts", async () => {
  let pageOcrCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType !== "page") {
          return { ok: true, result: { observations: [], filteredObservations: [], edgeSignals: {} } };
        }
        pageOcrCalls += 1;
        if (pageOcrCalls > 1) throw new Error("recapture unavailable");
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", "rev-a", "stable-observation", 40, "stable text")],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const observationsBefore = harness.store.getObservationsForPage("page-a");
  const projectionsBefore = harness.store.getProjections("page-a");
  const second = await harness.pipeline.run(harness.targets.a, { reason: "failed-recapture" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
  assert.deepEqual(harness.store.getObservationsForPage("page-a"), observationsBefore);
  assert.deepEqual(harness.store.getProjections("page-a"), projectionsBefore);
});

test("neighbor discovery failure is isolated after authoritative page OCR", async () => {
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: async () => {
        throw new Error("DOM scan unavailable");
      }
    }
  });

  const result = await harness.pipeline.run(harness.targets.a);
  assert.equal(result.ok, true);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.ok(harness.store.getProjections("page-a").some((item) => item.activeText));
  assert.ok(harness.traces.some((entry) => entry.event === "canonical:neighbor-discovery-error"));
  assert.equal(harness.calls.includes("retry"), false);
});

test("canonical pipeline delegates a visible-tab screenshot payload without running OCR", async () => {
  const harness = createCanonicalHarness({
    adapterOverrides: {
      extractTargetPayload: async (target) => {
        harness.calls.push(`fetch:${target.name}`);
        return { source: "visible-tab-crop", dataUrl: "data:image/png;base64,crop", width: 800, height: 600 };
      }
    }
  });
  const result = await harness.pipeline.run(harness.targets.a);

  assert.equal(result.fallbackLegacy, true);
  assert.equal(result.reason, "non-authoritative-page-payload");
  assert.equal(harness.calls.some((call) => call.startsWith("ocr:")), false);
  assert.equal(harness.calls.includes("retry"), false);
  assert.equal(harness.store.getPageHandles().length, 0);
});

test("solid projections keep PAGE_OCR artifact refresh at zero", async () => {
  const harness = createCanonicalHarness();
  await harness.pipeline.run(harness.targets.a);

  const pageRequests = harness.ocrMetas.filter((meta) => meta.sourceType === "page");
  assert.equal(pageRequests.length, 1);
  assert.equal(pageRequests[0].requireCleanedImage, false);
  assert.equal(pageRequests[0].forceCleanedImageArtifact, false);
});

test("an active bgType none projection refreshes only the cleaned page artifact", async () => {
  const observation = makeCanonicalObservation("page-a", "rev-a", "complex-page", 40, "complex");
  observation.visual = { ...observation.visual, bgType: "none" };
  const harness = createCanonicalHarness({
    pageObservations: { a: [observation], b: [] },
    artifactCleanedImage: "data:image/png;base64,Y2xlYW4="
  });
  await harness.pipeline.run(harness.targets.a);

  const pageRequests = harness.ocrMetas.filter((meta) => meta.sourceType === "page");
  assert.equal(pageRequests.length, 2);
  assert.equal(pageRequests[0].requireCleanedImage, false);
  assert.equal(pageRequests[1].requireCleanedImage, true);
  assert.equal(pageRequests[1].forceCleanedImageArtifact, true);
  assert.equal(harness.store.getPageHandle("page-a").cleanedImage, "data:image/png;base64,Y2xlYW4=");
  assert.equal(harness.calls.filter((call) => call.startsWith("translate:")).length, 1);
});

test("a missing cleaned image releases the artifact attempt for a same-revision retry", async () => {
  const observation = makeCanonicalObservation("page-a", "rev-a", "complex-page", 40, "complex");
  observation.visual = { ...observation.visual, bgType: "none" };
  const harness = createCanonicalHarness({
    pageObservations: { a: [observation], b: [] }
  });

  await harness.pipeline.run(harness.targets.a);
  assert.equal(
    harness.ocrMetas.filter((meta) => meta.forceCleanedImageArtifact === true).length,
    1
  );
  assert.equal(harness.store.getPageHandle("page-a").artifactRefreshAttemptedKey, "");
  assert.equal(harness.store.getPageHandle("page-a").artifactRefreshRetryAfter, 6000);
  const retryTimer = harness.timers.find((timer) => timer.delay === 5000);
  assert.ok(retryTimer);

  retryTimer.callback();
  for (let index = 0; index < 20 && harness.ocrMetas.filter(
    (meta) => meta.forceCleanedImageArtifact === true
  ).length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    harness.ocrMetas.filter((meta) => meta.forceCleanedImageArtifact === true).length,
    2
  );
  assert.equal(harness.timers.filter((timer) => timer.delay === 5000).length, 1);
});

test("a cleaned artifact retry timer cannot refresh a newer page revision", async () => {
  const observation = makeCanonicalObservation("page-a", "rev-a", "complex-page", 40, "complex");
  observation.visual = { ...observation.visual, bgType: "none" };
  const harness = createCanonicalHarness({
    pageObservations: { a: [observation], b: [] }
  });

  await harness.pipeline.run(harness.targets.a);
  const retryTimer = harness.timers.find((timer) => timer.delay === 5000);
  assert.ok(retryTimer);
  const previous = harness.store.getPageHandle("page-a");
  harness.store.registerPageHandle({
    ...previous,
    imageRevision: "rev-new",
    artifactRefreshRetryKey: "new-revision-artifact"
  });

  retryTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.ocrMetas.filter((meta) => meta.forceCleanedImageArtifact === true).length,
    1
  );
});

test("canonical cleaned masks cover the full outer projection box for active cross-page outline projections", () => {
  const projections = [{
    canonicalId: "canonical-cross-page",
    pageId: "page-a",
    role: "primary",
    active: true,
    activeText: true,
    visual: { bgType: "none" },
    geometry: {
      left: 20,
      top: 85,
      width: 58,
      height: 15,
      polygon: [[36, 89], [62, 89], [62, 97], [36, 97]]
    },
    geometries: [
      { sourceType: "page", box: { x: 36, y: 89, w: 26, h: 8 } },
      {
        sourceType: "seam",
        box: { x: 22, y: 86.8, w: 55, h: 13.2 },
        polygon: [[36, 89], [62, 89], [62, 97], [36, 97]]
      }
    ]
  }];

  assert.deepEqual(P.buildCanonicalCleanMasks(projections, new Set(["canonical-cross-page"])), [{
    coordinateSpace: "percent",
    box: { x: 20, y: 85, w: 58, h: 15 }
  }]);
  assert.deepEqual(P.buildCanonicalCleanMasks(projections, new Set()), []);
  assert.notEqual(
    P.buildCleanedArtifactKey("revision-a", []),
    P.buildCleanedArtifactKey("revision-a", P.buildCanonicalCleanMasks(projections, new Set(["canonical-cross-page"])))
  );
});

test("seam-only complex evidence can request page artifacts after warm page OCR", async () => {
  const seamObservation = {
    id: "seam-only-complex",
    sourceType: "seam",
    pageIds: ["page-a", "page-b"],
    imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" },
    pageSpans: [
      { pageId: "page-a", box: { x: 20, y: 94, w: 20, h: 6 }, overlapRatio: 1 },
      { pageId: "page-b", box: { x: 20, y: 0, w: 20, h: 6 }, overlapRatio: 1 }
    ],
    originalText: "seam complex",
    confidence: 0.99,
    visual: { regionType: "plain_text", bgType: "none" },
    providerBlockId: "seam-only-complex"
  };
  const harness = createCanonicalHarness({
    pageObservations: { a: [], b: [] },
    seamObservations: [seamObservation],
    pixelRisk: { accepted: true, overlapRatio: 0.3 },
    artifactCleanedImage: "data:image/png;base64,Y2xlYW4="
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);

  const artifactRequests = harness.ocrMetas.filter((meta) =>
    meta.sourceType === "page" && meta.forceCleanedImageArtifact === true
  );
  assert.deepEqual(artifactRequests.map((meta) => meta.pageIds[0]).sort(), ["page-a", "page-b"]);
  assert.deepEqual(
    artifactRequests.map((meta) => ({ pageId: meta.pageIds[0], masks: meta.cleanedMasks })),
    [
      {
        pageId: "page-a",
        masks: [{ coordinateSpace: "percent", box: { x: 20, y: 94, w: 20, h: 6 } }]
      },
      {
        pageId: "page-b",
        masks: [{ coordinateSpace: "percent", box: { x: 20, y: 0, w: 20, h: 6 } }]
      }
    ]
  );
  assert.equal(harness.calls.filter((call) => call.startsWith("translate:")).length, 1);
  assert.equal(harness.store.getPageHandle("page-a").cleanedImage, "data:image/png;base64,Y2xlYW4=");
  assert.equal(harness.store.getPageHandle("page-b").cleanedImage, "data:image/png;base64,Y2xlYW4=");
});

test("late seam masks refresh a cleaned artifact again on the same image revision", async () => {
  const options = boundaryMergeHarnessOptions();
  options.artifactCleanedImage = "data:image/png;base64,Y2xlYW4=";
  options.pageObservations.a[0].visual = { ...options.pageObservations.a[0].visual, bgType: "none" };
  options.pageObservations.b[0].visual = { ...options.pageObservations.b[0].visual, bgType: "none" };
  options.seamObservations[0].visual = { ...options.seamObservations[0].visual, bgType: "none" };
  const harness = createCanonicalHarness(options);

  await harness.pipeline.run(harness.targets.a);
  harness.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await harness.pipeline.run(harness.targets.b);

  const pageAArtifacts = harness.ocrMetas.filter((meta) =>
    meta.sourceType === "page" &&
    meta.pageIds[0] === "page-a" &&
    meta.forceCleanedImageArtifact === true
  );
  assert.equal(pageAArtifacts.length, 2);
  assert.deepEqual(pageAArtifacts[0].cleanedMasks, []);
  assert.deepEqual(pageAArtifacts[1].cleanedMasks, [
    { coordinateSpace: "percent", box: { x: 20, y: 94, w: 20, h: 6 } }
  ]);
  assert.equal(
    harness.store.getPageHandle("page-a").cleanedImageArtifactKey,
    P.buildCleanedArtifactKey("rev-a", pageAArtifacts[1].cleanedMasks)
  );
});

test("seam composite is cleaned once and atomically replaces both page projections", async () => {
  const options = boundaryMergeHarnessOptions();
  options.seamObservations[0].visual = {
    ...options.seamObservations[0].visual,
    bgType: "solid",
    fillBox: { x: 24, y: 42, w: 52, h: 20 },
    box: { x: 24, y: 42, w: 52, h: 20 },
    regionPolygon: [
      { x: 18, y: 38 },
      { x: 82, y: 38 },
      { x: 82, y: 66 },
      { x: 18, y: 66 }
    ],
    sourceLineCount: 3
  };
  options.seamCleanedImage = "data:image/png;base64,c2VhbS1jbGVhbg==";
  options.seamCleanedImageToken = "seam-artifact-token";
  options.seamDebug = {
    imageWidth: 800,
    imageHeight: 600,
    rawItems: [{ id: "raw-seam", box: { left: 160, top: 228, width: 480, height: 168 } }]
  };
  options.seamPayload = {
    dataUrl: "data:image/png;base64,c2VhbQ==",
    width: 800,
    height: 600,
    coordinateSpace: "kakao-seam-v1",
    seam: {
      canvasWidth: 800,
      canvasHeight: 600,
      alignedOverlap: 0,
      segments: [
        {
          pageId: "page-a",
          drawRect: { x: 0, y: 0, w: 800, h: 300 },
          sourceCrop: { x: 0, y: 1700, w: 800, h: 300 },
          naturalWidth: 800,
          naturalHeight: 2000
        },
        {
          pageId: "page-b",
          drawRect: { x: 0, y: 300, w: 800, h: 300 },
          sourceCrop: { x: 0, y: 0, w: 800, h: 300 },
          naturalWidth: 800,
          naturalHeight: 2000
        }
      ]
    }
  };
  const harness = createCanonicalHarness(options);

  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);

  const seamRequests = harness.ocrMetas.filter((meta) => meta.sourceType === "seam");
  assert.equal(seamRequests.length, 1);
  assert.equal(seamRequests[0].requireCleanedImage, true);
  assert.equal(seamRequests[0].forceCleanedImageArtifact, true);
  assert.equal(
    harness.ocrMetas.filter((meta) => meta.sourceType === "page" && meta.forceCleanedImageArtifact).length,
    0,
    "a usable composite artifact must suppress per-page cleaned artifacts"
  );

  const seamState = harness.store.getSeamStates().find((state) => state.status === "completed");
  assert.ok(seamState);
  assert.equal(seamState.cleanedImage, options.seamCleanedImage);
  assert.equal(seamState.cleanedImageToken, options.seamCleanedImageToken);
  assert.equal(seamState.canvasWidth, 800);
  assert.equal(seamState.canvasHeight, 600);
  assert.deepEqual(seamState.segments, options.seamPayload.seam.segments);
  assert.ok(Object.isFrozen(seamState));
  assert.ok(Object.isFrozen(seamState.segments));

  const debugOnlyBatch = harness.renderInputs.find((input) =>
    input.debugOnly === true &&
    input.projectionsByPage instanceof Map &&
    input.seamSurfaces?.some((surface) => surface.bubbles.length === 0 && surface.debug)
  );
  assert.ok(debugOnlyBatch, "seam debug must render atomically before translation is available");
  assert.deepEqual([...debugOnlyBatch.projectionsByPage.keys()].sort(), ["page-a", "page-b"]);

  const atomic = harness.renderInputs.findLast((input) =>
    input.projectionsByPage instanceof Map &&
    input.seamSurfaces?.some((surface) => surface.bubbles.length === 1)
  );
  assert.ok(atomic, "both seam windows should be submitted in one renderer call");
  assert.deepEqual([...atomic.projectionsByPage.keys()].sort(), ["page-a", "page-b"]);
  assert.deepEqual([...atomic.payloadByPage.keys()].sort(), ["page-a", "page-b"]);
  assert.deepEqual([...atomic.debugByPage.keys()].sort(), ["page-a", "page-b"]);

  const [surface] = atomic.seamSurfaces;
  assert.equal(surface.cleanedImage, options.seamCleanedImage);
  assert.equal(surface.cleanedImageToken, options.seamCleanedImageToken);
  assert.equal(surface.artifactFingerprint, options.seamCleanedImageToken);
  assert.equal(surface.bubbles.length, 1);
  assert.deepEqual(
    {
      x: surface.bubbles[0].x,
      y: surface.bubbles[0].y,
      w: surface.bubbles[0].w,
      h: surface.bubbles[0].h
    },
    { x: 18, y: 38, w: 64, h: 28 },
    "solid captions must use the full region polygon instead of the inner OCR text union"
  );
  assert.ok(surface.bubbles[0].y < 50 && surface.bubbles[0].y + surface.bubbles[0].h > 50);
  assert.deepEqual(surface.handledCanonicalIds, Object.keys(surface.canonicalRevisionById));
  for (const projections of atomic.projectionsByPage.values()) {
    assert.equal(
      projections.some((projection) => surface.handledCanonicalIds.includes(projection.canonicalId)),
      false,
      "normal page cover/text projections must not coexist with the seam surface"
    );
  }

  const beforeRefresh = {
    renderKey: surface.renderKey,
    layoutKey: surface.layoutKey,
    seamRequests: seamRequests.length
  };
  await harness.pipeline.runCached(harness.targets.a, null, { reason: "stable-seam-refresh" });
  const refreshed = harness.renderInputs.findLast((input) =>
    input.seamSurfaces?.some((item) => item.bubbles.length === 1)
  ).seamSurfaces[0];
  assert.equal(refreshed.renderKey, beforeRefresh.renderKey);
  assert.equal(refreshed.layoutKey, beforeRefresh.layoutKey);
  assert.equal(harness.ocrMetas.filter((meta) => meta.sourceType === "seam").length, beforeRefresh.seamRequests);
});

test("translated seam geometry suppresses a smaller conflicting page-edge projection", () => {
  const surface = {
    renderKey: "live-seam",
    canvasWidth: 720,
    canvasHeight: 192,
    pageIds: ["page-a", "page-b"],
    segments: [
      {
        pageId: "page-a",
        drawRect: { x: 0, y: 0, w: 720, h: 96 },
        sourceCrop: { x: 0, y: 1004, w: 720, h: 96 },
        naturalWidth: 720,
        naturalHeight: 1100
      },
      {
        pageId: "page-b",
        drawRect: { x: 0, y: 96, w: 720, h: 96 },
        sourceCrop: { x: 0, y: 0, w: 720, h: 96 },
        naturalWidth: 720,
        naturalHeight: 1100
      }
    ],
    bubbles: [{
      x: 7.52,
      y: 37.13,
      w: 57.05,
      h: 28.88,
      region_type: "speech_bubble",
      original_text: "다준이ㅋㅋㅋㅋ작곡 잘하네",
      translated_text: "多俊哈哈哈哈，作曲得真好"
    }],
    handledCanonicalIds: ["canonical-seam"]
  };
  const projections = new Map([["page-a", [{
    canonicalId: "canonical-small-wrong",
    role: "primary",
    activeText: true,
    geometry: { left: 36.91, top: 98.45, width: 26.88, height: 1.55 },
    bubble: { region_type: "caption_panel" },
    original_text: "그자고자하니는",
    translated_text: "那个想睡觉的人"
  }]]]);

  assert.deepEqual(
    [...P.collectSeamSuppressedCanonicalIds(surface, projections)],
    ["canonical-small-wrong"]
  );
});

test("canonical pipeline translates interior observations while edge candidates wait", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [
        makeCanonicalObservation("page-a", "rev-a", "inside", 40, "interior"),
        makeCanonicalObservation("page-a", "rev-a", "edge", 96, "edge")
      ],
      b: []
    }
  });
  const result = await harness.pipeline.run(harness.targets.a);

  assert.equal(result.ok, true);
  assert.equal(result.pendingEdge, true);
  const translateCalls = harness.calls.filter((call) => call.startsWith("translate:"));
  assert.equal(translateCalls.length, 1);
  assert.match(translateCalls[0], /:interior/);
  assert.doesNotMatch(translateCalls[0], /:edge(?:,|$)/);
  assert.equal(harness.timers[0].delay, 8000);
});

test("edge timeout releases authoritative page observation without seam evidence", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-timeout", 96, "late edge")],
      b: []
    }
  });
  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.calls.some((call) => call.startsWith("translate:")), false);

  harness.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(harness.calls.some((call) => call.includes(":late edge")));
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, true);
});

test("seam OCR failure is isolated and both page observations still translate", async () => {
  const harness = createCanonicalHarness({
    seamFailure: true,
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-a", 96, "A tail")],
      b: [makeCanonicalObservation("page-b", "rev-b", "edge-b", 0, "B head")]
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const second = await harness.pipeline.run(harness.targets.b);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:page:")).length, 2);
  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);
  assert.equal(harness.store.getObservations().filter((item) => item.sourceType === "page").length, 2);
  assert.ok(harness.store.getCanonicalSnapshot().length >= 2);
  assert.ok(harness.calls.some((call) => call.includes(":A tail")));
  assert.ok(harness.calls.some((call) => call.includes(":B head")));
  const seamState = harness.store.getSeamStates()[0];
  assert.equal(seamState.status, "failed");
});

test("seam evidence decision failure cannot fail either authoritative page", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-a", 94, "upper")],
      b: [makeCanonicalObservation("page-b", "rev-b", "edge-b", 0, "lower")]
    }
  });

  const first = await harness.pipeline.run(harness.targets.a);
  const originalGetObservationsForPage = harness.store.getObservationsForPage.bind(harness.store);
  let throwOnce = true;
  harness.store.getObservationsForPage = (...args) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("seam decision unavailable");
    }
    return originalGetObservationsForPage(...args);
  };
  const second = await harness.pipeline.run(harness.targets.b);
  const seamState = harness.store.getSeamStates().find((item) => item.pageIds.includes("page-a"));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(seamState.status, "failed");
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getPageTerminal("page-b").state, "ready");
  assert.equal(harness.calls.includes("retry"), false);
});

test("a concurrent seam caller joins the running revisioned pair", async () => {
  let releaseSeamPayload;
  let markSeamPayload;
  const seamPayloadStarted = new Promise((resolve) => { markSeamPayload = resolve; });
  const seamPayloadGate = new Promise((resolve) => { releaseSeamPayload = resolve; });
  let payloadCalls = 0;
  const harness = createCanonicalHarness({
    pixelRisk: { accepted: true, overlapRatio: 0.3 },
    adapterOverrides: {
      buildKakaoSeamPayload: async () => {
        payloadCalls += 1;
        markSeamPayload();
        await seamPayloadGate;
        return { dataUrl: "data:image/png;base64,seam", width: 800, height: 320 };
      }
    }
  });
  const pageA = harness.store.registerPageHandle({
    ...harness.identities.a,
    target: harness.targets.a,
    payload: { dataUrl: "data:image/png;base64,a" },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  const pageB = harness.store.registerPageHandle({
    ...harness.identities.b,
    target: harness.targets.b,
    payload: { dataUrl: "data:image/png;base64,b" },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });

  const first = harness.pipeline.processSeamPair(pageA, pageB);
  await seamPayloadStarted;
  let secondResolved = false;
  const second = harness.pipeline.processSeamPair(pageA, pageB).then((value) => {
    secondResolved = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false, "running seam state must join the inflight promise");

  releaseSeamPayload();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "completed");
  assert.equal(secondResult.status, "completed");
  assert.equal(payloadCalls, 1);
  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);
});

test("completed seam evidence publishes a canonical refresh without its initiating page job", async () => {
  const pageAObservation = {
    ...makeCanonicalObservation("page-a", "rev-a", "orphan-a", 94, "A tail"),
    visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
  };
  const pageBObservation = {
    ...makeCanonicalObservation("page-b", "rev-b", "orphan-b", 0, "B head"),
    visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
  };
  const seamObservation = {
    id: "orphan-seam",
    sourceType: "seam",
    pageIds: ["page-a", "page-b"],
    imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" },
    pageSpans: [
      { pageId: "page-a", box: { x: 20, y: 94, w: 20, h: 6 }, overlapRatio: 0.5 },
      { pageId: "page-b", box: { x: 20, y: 0, w: 20, h: 6 }, overlapRatio: 0.5 }
    ],
    originalText: "A tail B head",
    confidence: 0.99,
    visual: { regionType: "speech", regionHash: "same", bgType: "solid" },
    providerBlockId: "orphan-seam"
  };
  const harness = createCanonicalHarness({
    pixelRisk: { accepted: true, overlapRatio: 0.3 },
    seamObservations: [seamObservation]
  });
  const pageA = harness.store.registerPageHandle({
    ...harness.identities.a,
    target: harness.targets.a,
    payload: { dataUrl: "data:image/png;base64,a" },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  const pageB = harness.store.registerPageHandle({
    ...harness.identities.b,
    target: harness.targets.b,
    payload: { dataUrl: "data:image/png;base64,b" },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  harness.store.markPageTerminal("page-a", "ready", { imageRevision: "rev-a" });
  harness.store.markPageTerminal("page-b", "ready", { imageRevision: "rev-b" });
  harness.store.upsertObservations([pageAObservation, pageBObservation]);

  const terminal = await harness.pipeline.processSeamPair(pageA, pageB);
  assert.equal(terminal.status, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const merged = harness.store.getCanonicalSnapshot().find((canonical) =>
    canonical.memberObservationIds.includes("orphan-a") &&
    canonical.memberObservationIds.includes("orphan-b") &&
    canonical.memberObservationIds.includes("orphan-seam")
  );
  assert.ok(merged, "seam terminal must independently publish its new semantic evidence");
  assert.ok(harness.store.getTranslation(merged.id, merged.revision));
});

test("seam OCR is evidence-triggered and skipped for ordinary interior pages", async () => {
  const harness = createCanonicalHarness();
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);

  assert.equal(harness.calls.some((call) => call.startsWith("seam-payload:")), false);
  assert.equal(harness.calls.some((call) => call.startsWith("ocr:seam:")), false);
  assert.equal(harness.store.getSeamStates()[0].status, "skipped");
});

test("accepted pixel-overlap risk triggers seam OCR even without edge text", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: { accepted: true, overlapRatio: 0.3, rows: 40, currentRows: 200 }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);

  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);
  assert.equal(harness.store.getSeamStates()[0].status, "completed");
});

test("fragmented page structure triggers seam OCR without edge text or pixel overlap", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: { risk: true, fragmentRisk: true }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);

  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);
  assert.deepEqual(harness.store.getSeamStates()[0].reasons, ["fragment_structure"]);
});

test("structured negative edge signals do not create a false edge wait", () => {
  const record = { pageId: "page-a", imageRevision: "rev-a", width: 800, height: 2000 };
  const interior = makeCanonicalObservation("page-a", "rev-a", "interior-negative", 40, "inside");
  const sides = P.collectPageEdgeSides(record, [interior], [], {
    top: { detected: false, retainedObservationIds: [], filteredObservationIds: [], visualDetected: false },
    bottom: { detected: false, retainedObservationIds: [], filteredObservationIds: [], visualDetected: false },
    hasAny: false
  });
  assert.deepEqual(sides, []);
});

test("an old revision edge timer cannot release a newer page revision", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "edge-rev-a", 96, "old edge")],
    b: []
  };
  const harness = createCanonicalHarness({ pageObservations });
  await harness.pipeline.run(harness.targets.a);
  const oldTimer = harness.timers[0];

  harness.identities.a.imageRevision = "rev-a-2";
  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a-2", "edge-rev-a-2", 96, "new edge")];
  await harness.pipeline.run(harness.targets.a);
  assert.equal(oldTimer.cleared, true);
  assert.equal(harness.store.getEdgeWait("page-a").imageRevision, "rev-a-2");

  oldTimer.callback();
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, false);
});

test("a stale edge observation cannot trigger seam OCR for an interior-only new revision", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "stale-edge", 96, "old edge")],
    b: [makeCanonicalObservation("page-b", "rev-b", "stable-interior", 40, "inside B")]
  };
  const harness = createCanonicalHarness({ pageObservations });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);

  harness.identities.a.imageRevision = "rev-a-2";
  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a-2", "fresh-interior", 40, "inside A")];
  await harness.pipeline.run(harness.targets.a);

  assert.equal(harness.calls.filter((call) => call.startsWith("ocr:seam:")).length, 1);
  const states = harness.store.getSeamStates();
  assert.equal(states.some((state) => state.status === "skipped" && state.imageRevisionByPage["page-a"] === "rev-a-2"), true);
});

test("an edge waits for a late DOM neighbor discovered within the 8 second window", async () => {
  let neighborVisible = false;
  const harness = createCanonicalHarness({
    seamFailure: true,
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "late-neighbor-a", 96, "A waits")],
      b: [makeCanonicalObservation("page-b", "rev-b", "late-neighbor-b", 0, "B arrives")]
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: (target) => {
        if (!neighborVisible) return { previous: null, next: null };
        return target.name === "a" ? { next: harness.targets.b } : { previous: harness.targets.a };
      }
    }
  });

  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, false);
  assert.equal(harness.calls.some((call) => call.includes(":A waits")), false);

  neighborVisible = true;
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.store.getEdgeWait("page-a"), null);
  assert.ok(harness.calls.some((call) => call.includes(":A waits")));
  assert.ok(harness.calls.some((call) => call.includes(":B arrives")));
});

test("onAdjacent records confirmed revisioned adjacency even when seam OCR returns zero observations", async () => {
  const harness = createCanonicalHarness({
    pageObservations: { a: [], b: [] },
    seamObservations: [],
    pixelRisk: { accepted: true, overlapRatio: 0.25 },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null })
    }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  const result = await harness.pipeline.onAdjacentTargetAvailable(harness.targets.a, harness.targets.b);

  assert.equal(result.ok, true);
  assert.equal(harness.store.getPageHandle("page-a").nextPageId, "page-b");
  assert.equal(harness.store.getPageHandle("page-b").previousPageId, "page-a");
  const pairs = P.buildConfirmedAdjacentPagePairs(harness.store.getPageHandles());
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].imageRevisionByPage, { "page-a": "rev-a", "page-b": "rev-b" });
  assert.equal(harness.store.getSeamStates()[0].status, "completed");
  assert.deepEqual(harness.store.getCanonicalSnapshot(), []);
});

test("onAdjacent rejects retained SPA pages from another chapter before recording adjacency", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: { accepted: true, overlapRatio: 0.25 },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null })
    }
  });
  harness.identities.b.chapterId = "another-chapter";
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  const result = await harness.pipeline.onAdjacentTargetAvailable(harness.targets.a, harness.targets.b);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "chapter-mismatch");
  assert.equal(harness.store.getPageHandle("page-a").nextPageId || "", "");
  assert.equal(harness.store.getPageHandle("page-b").previousPageId || "", "");
  assert.equal(harness.store.getSeamStates().length, 0);
});

test("canonical store serializes reconciliation and keeps semantic facts after DOM unbind", async () => {
  const store = P.createStore();
  const target = { isConnected: true };
  store.registerPageHandle({ pageId: "p", imageRevision: "r", target, width: 800, height: 1000 });
  store.upsertObservations([makeCanonicalObservation("p", "r", "o")]);
  const order = [];
  const first = store.runSerializedReconcile(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("a-end");
  });
  const second = store.runSerializedReconcile(async () => order.push("b"));
  await Promise.all([first, second]);
  store.unbindPageTarget(target);

  assert.deepEqual(order, ["a-start", "a-end", "b"]);
  assert.equal(store.getPageHandle("p").target, null);
  assert.equal(store.getObservationsForPage("p").length, 1);
});

test("render projections select one active text page and allow standby takeover", () => {
  const pages = [
    { pageId: "a", readingOrder: 1 },
    { pageId: "b", readingOrder: 2 }
  ];
  const canonical = {
    id: "c",
    revision: 1,
    originalText: "hello",
    geometryByPage: {
      a: [{ x: 0, y: 90, w: 20, h: 8 }],
      b: [{ x: 0, y: 0, w: 20, h: 4 }]
    },
    translation: { translated_text: "你好" }
  };
  const primaryPresent = P.fallbackBuildRenderProjections({ pages, canonicals: [canonical], availablePageIds: ["a", "b"] });
  const primaryAbsent = P.fallbackBuildRenderProjections({ pages, canonicals: [canonical], availablePageIds: ["b"] });

  assert.equal(primaryPresent.filter((item) => item.activeText).length, 1);
  assert.equal(primaryPresent.find((item) => item.activeText).pageId, "a");
  assert.equal(primaryAbsent.filter((item) => item.activeText).length, 1);
  assert.equal(primaryAbsent.find((item) => item.activeText).pageId, "b");
});

test("a non-primary cross-page projection keeps standby metadata and adds a cover", () => {
  const standby = {
    id: "projection-b",
    canonicalId: "canonical",
    pageId: "b",
    role: "standby",
    activeText: false,
    translated_text: "不应显示",
    visual: { regionHash: "preserved" },
    bubble: { x: 1, y: 2, w: 3, h: 4, translated_text: "不应显示" }
  };
  const [cover] = P.buildStandbyCoverProjections(standby);

  assert.equal(standby.role, "standby");
  assert.equal(cover.role, "cover");
  assert.equal(cover.activeText, false);
  assert.equal(cover.coverOnly, true);
  assert.deepEqual(cover.visual, standby.visual);
  assert.equal(cover.bubble.translated_text, "");
  assert.equal(cover.bubble.projection_role, "cover_only");
});

test("A/B page OCR completion order does not change canonical or projection sets", async () => {
  const forward = createCanonicalHarness();
  await forward.pipeline.run(forward.targets.a);
  await forward.pipeline.run(forward.targets.b);
  const reverse = createCanonicalHarness();
  await reverse.pipeline.run(reverse.targets.b);
  await reverse.pipeline.run(reverse.targets.a);

  const canonicalShape = (store) => store.getCanonicalSnapshot().map((item) => ({
    id: item.id,
    revision: item.revision,
    members: item.memberObservationIds,
    text: item.originalText
  }));
  const projectionShape = (store) => [...store.getAllProjections().entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pageId, items]) => [pageId, items.map((item) => ({
      canonicalId: item.canonicalId,
      revision: item.canonicalRevision || item.revision,
      role: item.role,
      activeText: item.activeText
    }))]);
  assert.deepEqual(canonicalShape(forward.store), canonicalShape(reverse.store));
  assert.deepEqual(projectionShape(forward.store), projectionShape(reverse.store));
});

function boundaryMergeHarnessOptions() {
  return {
    pageObservations: {
      a: [{
        ...makeCanonicalObservation("page-a", "rev-a", "merge-a", 94, "A tail"),
        visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
      }],
      b: [{
        ...makeCanonicalObservation("page-b", "rev-b", "merge-b", 0, "B head"),
        visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
      }]
    },
    seamObservations: [{
      id: "merge-seam",
      sourceType: "seam",
      pageIds: ["page-a", "page-b"],
      imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" },
      pageSpans: [
        { pageId: "page-a", box: { x: 20, y: 94, w: 20, h: 6 }, overlapRatio: 1 },
        { pageId: "page-b", box: { x: 20, y: 0, w: 20, h: 6 }, overlapRatio: 1 }
      ],
      originalText: "A tail B head",
      confidence: 0.99,
      visual: { regionType: "speech", regionHash: "same", bgType: "solid" },
      providerBlockId: "merge-seam"
    }]
  };
}

test("merged boundary canonical identity and projections are invariant to A/B OCR order", async () => {
  const forward = createCanonicalHarness(boundaryMergeHarnessOptions());
  await forward.pipeline.run(forward.targets.a);
  await forward.pipeline.run(forward.targets.b);
  const reverse = createCanonicalHarness(boundaryMergeHarnessOptions());
  await reverse.pipeline.run(reverse.targets.b);
  await reverse.pipeline.run(reverse.targets.a);

  const mergedShape = (store) => {
    const canonical = store.getCanonicalSnapshot().find((item) =>
      item.memberObservationIds.includes("merge-a") && item.memberObservationIds.includes("merge-b")
    );
    assert.ok(canonical, "boundary evidence should reconcile into one canonical");
    return {
      id: canonical.id,
      revision: canonical.revision,
      supersedesId: canonical.supersedesId || null,
      members: canonical.memberObservationIds,
      text: canonical.originalText,
      projections: [...store.getAllProjections().entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pageId, items]) => [pageId, items.map((item) => ({
          id: item.projectionId || item.id,
          canonicalId: item.canonicalId,
          revision: item.canonicalRevision || item.revision,
          role: item.role,
          activeText: item.activeText
        }))])
    };
  };
  assert.deepEqual(mergedShape(forward.store), mergedShape(reverse.store));
});

test("one page OCR failure does not clear another page canonical projection", async () => {
  const harness = createCanonicalHarness({ pageFailure: "b" });
  const first = await harness.pipeline.run(harness.targets.a);
  const before = harness.store.getProjections("page-a");
  const second = await harness.pipeline.run(harness.targets.b);
  const after = harness.store.getProjections("page-a");

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.ok(before.some((item) => item.activeText));
  assert.deepEqual(after, before);
  assert.equal(harness.store.getPageTerminal("page-b").state, "failed");
});

test("a whole canonical translation failure can recover on the same revision", async () => {
  let translationCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null }),
      requestCanonicalTranslations: async (items) => {
        translationCalls += 1;
        if (translationCalls === 1) {
          return { ok: false, error: "temporary translation timeout" };
        }
        return {
          ok: true,
          result: {
            translations: items.map((item) => ({
              id: item.id,
              revision: item.revision,
              translated_text: `ZH:${item.original_text}`
            }))
          }
        };
      }
    }
  });

  const first = await harness.pipeline.run(harness.targets.a);
  const second = await harness.pipeline.run(harness.targets.a, { reason: "same-revision-retry" });

  assert.equal(first.ok, false);
  assert.match(first.error, /temporary translation timeout/);
  assert.equal(second.ok, true);
  assert.equal(translationCalls, 2);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
  assert.equal(harness.store.getProjections("page-a").some((item) => item.activeText), true);
  assert.ok(harness.calls.includes("retry"));
});

test("late translation is rejected when canonical revision has advanced", () => {
  const store = P.createStore();
  const geometryByPage = { p: [{ box: { left: 1, top: 1, width: 2, height: 2 } }] };
  store.setCanonicalSnapshot([{
    id: "canonical",
    revision: 1,
    memberObservationIds: ["o1"],
    originalText: "first",
    geometryByPage,
    status: "ready"
  }]);
  const [claimed] = store.claimTranslations([{ id: "canonical", revision: 1, original_text: "first" }]);
  store.setCanonicalSnapshot([{
    id: "canonical",
    revision: 2,
    memberObservationIds: ["o1", "o2"],
    originalText: "first second",
    geometryByPage,
    status: "ready"
  }]);

  assert.equal(store.settleTranslation(claimed, { translated_text: "stale" }), false);
  assert.equal(store.getTranslation("canonical", 1), null);
});

test("a canonical revision prevents concurrent claims but permits released retries", () => {
  const store = P.createStore();
  const item = { id: "canonical", revision: 1, original_text: "source" };
  assert.equal(store.claimTranslations([item]).length, 1);
  assert.equal(store.claimTranslations([item]).length, 0);
  store.releaseTranslationClaims([item]);
  assert.equal(store.claimTranslations([item]).length, 1);
  store.releaseTranslationClaims([item]);
  assert.equal(store.claimTranslations([{ ...item, revision: 2 }]).length, 1);
});

test("late seam evidence supersedes an edge-timeout translation with a new revision", async () => {
  const seamObservation = {
    id: "seam-ab",
    sourceType: "seam",
    pageIds: ["page-a", "page-b"],
    imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" },
    pageSpans: [
      { pageId: "page-a", box: { x: 20, y: 94, w: 20, h: 6 }, overlapRatio: 1 },
      { pageId: "page-b", box: { x: 20, y: 0, w: 20, h: 6 }, overlapRatio: 1 }
    ],
    originalText: "A tail B head",
    confidence: 0.99,
    visual: { regionType: "speech", regionHash: "same", bgType: "solid" },
    providerBlockId: "seam-ab"
  };
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [{
        ...makeCanonicalObservation("page-a", "rev-a", "late-a", 94, "A tail"),
        visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
      }],
      b: [{
        ...makeCanonicalObservation("page-b", "rev-b", "late-b", 0, "B head"),
        visual: { regionType: "speech", regionHash: "same", bgType: "solid" }
      }]
    },
    seamObservations: [seamObservation]
  });

  await harness.pipeline.run(harness.targets.a);
  harness.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const timeoutCanonical = harness.store.getCanonicalSnapshot().find((item) => item.memberObservationIds.includes("late-a"));
  assert.equal(timeoutCanonical.revision, 1);
  assert.ok(harness.store.getTranslation(timeoutCanonical.id, 1));

  await harness.pipeline.run(harness.targets.b);
  const merged = harness.store.getCanonicalSnapshot().find((item) =>
    item.memberObservationIds.includes("late-a") && item.memberObservationIds.includes("late-b")
  );
  assert.ok(merged, "late seam should merge the two edge observations");
  assert.equal(merged.id, timeoutCanonical.id);
  assert.ok(merged.revision > timeoutCanonical.revision);
  assert.ok(harness.store.getTranslation(merged.id, merged.revision));
  assert.equal(harness.store.getProjections("page-a").filter((item) => item.activeText).length, 1);
  assert.equal(harness.store.getProjections("page-b").filter((item) => item.activeText).length, 0);
  assert.equal(harness.store.getProjections("page-b").filter((item) => item.role === "cover").length, 1);
});

async function runFailedRevisionFallbackScenario({ reverse = false, throwError = false }) {
  let translationRequestCount = 0;
  const harness = createCanonicalHarness({
    ...boundaryMergeHarnessOptions(),
    translateDeferred: async (items) => {
      translationRequestCount += 1;
      if (translationRequestCount === 1) {
        return {
          ok: true,
          result: {
            translations: items.map((item) => ({
              id: item.id,
              revision: item.revision,
              translated_text: `OLD:${item.original_text}`
            }))
          }
        };
      }
      if (throwError) throw new Error("translation unavailable");
      return {
        ok: true,
        result: {
          translations: [],
          errors: items.map((item) => ({ id: item.id, revision: item.revision, error: "missing" })),
          partial: true
        }
      };
    }
  });
  const firstTarget = reverse ? harness.targets.b : harness.targets.a;
  const secondTarget = reverse ? harness.targets.a : harness.targets.b;
  await harness.pipeline.run(firstTarget);
  harness.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const oldCanonical = harness.store.getCanonicalSnapshot()[0];
  assert.ok(harness.store.getTranslation(oldCanonical.id, oldCanonical.revision));

  await harness.pipeline.run(secondTarget);
  const current = harness.store.getCanonicalSnapshot().find((item) =>
    item.memberObservationIds.includes("merge-a") && item.memberObservationIds.includes("merge-b")
  );
  assert.ok(current);
  assert.equal(harness.store.getTranslation(current.id, current.revision), null);
  const visible = [...harness.store.getAllProjections().values()].flat()
    .filter((projection) => projection.activeText && projection.translated_text);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].canonicalId, oldCanonical.id);
  assert.equal(visible[0].provisional, true);
  assert.equal(visible[0].pendingCanonicalId, current.id);

  const requestsBeforeRefresh = translationRequestCount;
  const refresh = () => harness.pipeline.refresh({ reason: "retry-render", focusPageIds: ["page-a", "page-b"] });
  if (throwError) {
    await assert.rejects(refresh, /translation unavailable/);
  } else {
    await assert.rejects(refresh, /Translation response omitted 1 canonical item/);
  }
  assert.equal(
    translationRequestCount,
    requestsBeforeRefresh + (throwError ? 1 : 2),
    "a failed revision must be retryable while retaining the prior visible projection"
  );
  const visibleAfter = [...harness.store.getAllProjections().values()].flat()
    .filter((projection) => projection.activeText && projection.translated_text);
  assert.equal(visibleAfter.length, 1);
  assert.equal(visibleAfter[0].canonicalId, oldCanonical.id);
  const fallbackRender = harness.renderInputs.findLast((input) =>
    String(input.reason || "").includes("translation-fallback") &&
    input.projections.some((projection) => projection.provisional === true)
  );
  assert.ok(fallbackRender, "the previous visible projection should be rendered as a fallback");
  assert.equal(fallbackRender.translationComplete, false);
}

test("partial translation for a new revision keeps exactly one prior visible projection", async () => {
  await runFailedRevisionFallbackScenario({ reverse: false, throwError: false });
});

test("a mixed partial response settles successful items and immediately retries only missing canonicals", async () => {
  const requestedIds = [];
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [
        makeCanonicalObservation("page-a", "rev-a", "mixed-a-1", 30, "first line"),
        makeCanonicalObservation("page-a", "rev-a", "mixed-a-2", 60, "second line")
      ],
      b: []
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({ previous: null, next: null })
    },
    translateDeferred: async (items) => {
      requestedIds.push(items.map((item) => item.id));
      const translatedItems = requestedIds.length === 1 ? items.slice(0, 1) : items;
      return {
        ok: true,
        result: {
          translations: translatedItems.map((item) => ({
            id: item.id,
            revision: item.revision,
            translated_text: `ZH:${item.original_text}`
          })),
          partial: translatedItems.length !== items.length
        }
      };
    }
  });

  const first = await harness.pipeline.run(harness.targets.a);
  assert.equal(first.ok, true);
  assert.equal(requestedIds[0].length, 2);
  assert.equal(requestedIds[1].length, 1, "only the missing canonical should be retried");
  assert.equal(
    harness.store.getCanonicalSnapshot().filter((canonical) =>
      harness.store.getTranslation(canonical.id, canonical.revision)
    ).length,
    2
  );
  assert.equal(
    harness.calls.filter((call) => call === "ocr:page:page-a").length,
    1,
    "the retry must not repeat authoritative OCR"
  );
  assert.equal(harness.renderInputs.findLast((input) => input.pageId === "page-a").translationComplete, true);
});

test("thrown translation after an anchor supersession keeps exactly one prior visible projection", async () => {
  await runFailedRevisionFallbackScenario({ reverse: true, throwError: true });
});

async function settleWithin(promise, timeoutMs = 250) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a permanently pending page extraction times out, releases inflight, and retries", async () => {
  const never = new Promise(() => {});
  let extractionAttempts = 0;
  let clearedLoading = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      extractTimeoutMs: 5,
      extractTargetPayload: async (target) => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) return never;
        return { dataUrl: `data:image/png;base64,${target.name}`, width: 800, height: 2000 };
      },
      clearLoadingOverlay: () => { clearedLoading += 1; }
    }
  });

  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page fetch timed out/i);
  assert.equal(clearedLoading, 1);
  assert.equal(harness.calls.filter((call) => call === "retry").length, 1);

  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(extractionAttempts, 2);
});

test("a permanently pending page identity digest times out without committing late facts", async () => {
  const never = new Promise(() => {});
  let identityAttempts = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      identityTimeoutMs: 5,
      buildPageIdentity: async (target) => {
        identityAttempts += 1;
        if (identityAttempts === 1) return never;
        return { ...harness.identities[target.name] };
      }
    }
  });

  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page identity timed out/i);
  assert.equal(harness.store.getPageHandles().length, 0);

  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(identityAttempts, 2);
});

test("a permanently pending page OCR times out and the same revision can retry", async () => {
  const never = new Promise(() => {});
  let pageOcrAttempts = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      pageOcrTimeoutMs: 5,
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType !== "page") {
          return { ok: true, result: { observations: [], filteredObservations: [], edgeSignals: {} } };
        }
        pageOcrAttempts += 1;
        if (pageOcrAttempts === 1) return never;
        const pageId = meta.pageIds[0];
        const revision = meta.imageRevisionByPage[pageId];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation(pageId, revision, "retry-ocr", 40, "retry OCR")],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });

  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page OCR timed out/i);
  assert.equal(harness.store.getPageTerminal("page-a").state, "failed");

  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(pageOcrAttempts, 2);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
});

test("a permanently pending seam payload fails only the pair and preserves both pages", async () => {
  const never = new Promise(() => {});
  let seamAttempts = 0;
  const harness = createCanonicalHarness({
    ...boundaryMergeHarnessOptions(),
    adapterOverrides: {
      seamTimeoutMs: 5,
      buildKakaoSeamPayload: async () => {
        seamAttempts += 1;
        return never;
      }
    }
  });

  assert.equal((await settleWithin(harness.pipeline.run(harness.targets.a))).ok, true);
  assert.equal((await settleWithin(harness.pipeline.run(harness.targets.b))).ok, true);
  assert.equal(seamAttempts, 1);
  assert.equal(harness.store.getSeamStates().some((state) => state.status === "failed" && /seam payload timed out/i.test(state.error)), true);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getPageTerminal("page-b").state, "ready");
  const observationIds = harness.store.getObservations().map((item) => item.id);
  assert.equal(observationIds.includes("merge-a"), true);
  assert.equal(observationIds.includes("merge-b"), true);
});

test("an old generation timeout cannot clear the current generation loading state", async () => {
  const never = new Promise(() => {});
  let markOldStarted;
  const oldStarted = new Promise((resolve) => { markOldStarted = resolve; });
  let extractionAttempts = 0;
  let clearedLoading = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      extractTimeoutMs: 20,
      extractTargetPayload: async (target) => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) {
          markOldStarted();
          return never;
        }
        return { dataUrl: `data:image/png;base64,${target.name}`, width: 800, height: 2000 };
      },
      clearLoadingOverlay: () => { clearedLoading += 1; }
    }
  });

  const oldRun = harness.pipeline.run(harness.targets.a);
  await oldStarted;
  harness.targets.a.generation += 1;
  const currentRun = harness.pipeline.run(harness.targets.a);
  assert.equal((await settleWithin(currentRun)).ok, true);
  const stale = await settleWithin(oldRun);
  assert.equal(stale.skipped, true);
  assert.match(stale.reason, /cancelled:/);
  assert.equal(clearedLoading, 0);
});
