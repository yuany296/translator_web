const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "页面必须包含内联脚本");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.innerHTML = "";
    this.textContent = "";
    this.scrollLeft = 0;
    this.scrollWidth = 1000;
    this.validity = { valid: true };
    this.classList = {
      add: (...names) => names.forEach((name) => this.setClass(name, true)),
      remove: (...names) => names.forEach((name) => this.setClass(name, false)),
      toggle: (name, force) => this.setClass(name, force)
    };
  }

  setClass(name, enabled) {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    if (enabled) names.add(name);
    else names.delete(name);
    this.className = Array.from(names).join(" ");
  }

  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener() {}
  setAttribute(name, value) { this[name] = value; }
  querySelector() { return null; }
  getContext() {
    return {
      drawImage() {}, save() {}, restore() {}, strokeRect() {}, fillRect() {}, fillText() {},
      beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}
    };
  }
}

function createHarness(stored = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement();
        if (id === "serviceUrl") element.value = "http://127.0.0.1:8765";
        if (id === "lang") element.value = "korean";
        if (id === "ocrMode") element.value = "fast";
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    body: new FakeElement("body")
  };
  const data = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value))
  };
  const factory = new Function(
    "document", "localStorage", "window", "URL", "crypto", "requestAnimationFrame",
    `${script}; return { state, DEFAULT_FILTER_SETS, FILTER_STORAGE_KEY, normalizeFilterParams,
      addFilterGroup, removeFilterGroup, invalidateFilterGroupResults, invalidateFilterSource,
      invalidateGroupResults, processOcrPayload, selectedFilterGroups, selectedParameterGroups,
      readOcrContext, ocrContextKey, handleOcrContextChange, buildRunTasks, selectOcrResult,
      selectEnhancedSupplements, dedupeOverlappingTextItems, isFileDrag, loadSelectedFiles,
      renderComparison, applyFilterComparison };`
  );
  const api = factory(
    document,
    localStorage,
    { addEventListener() {} },
    { revokeObjectURL() {}, createObjectURL() { return "blob:test"; } },
    { randomUUID: (() => { let value = 0; return () => `test-${++value}`; })() },
    (callback) => callback()
  );
  return { ...api, data, elements };
}

const harness = createHarness();
assert.equal(harness.state.filterGroups.length, 4);
assert.deepEqual(harness.state.filterGroups.map((group) => group.params), harness.DEFAULT_FILTER_SETS);
assert.equal(harness.normalizeFilterParams({ ...harness.DEFAULT_FILTER_SETS[0], confidenceThreshold: 2 }), null);

const previousLast = { ...harness.state.filterGroups.at(-1).params };
harness.addFilterGroup();
assert.equal(harness.state.filterGroups.length, 5);
assert.deepEqual(harness.state.filterGroups.at(-1).params, previousLast);
harness.addFilterGroup();
assert.equal(harness.state.filterGroups.length, 6);
assert.equal(JSON.parse(harness.data.get(harness.FILTER_STORAGE_KEY)).groups.length, 6);

while (harness.state.filterGroups.length > 1) harness.removeFilterGroup(harness.state.filterGroups.at(-1).id);
const finalId = harness.state.filterGroups[0].id;
harness.removeFilterGroup(finalId);
assert.equal(harness.state.filterGroups.length, 1);

const invalidStorage = createHarness({ "manga-ocr-filter-groups-v1": "{broken" });
assert.equal(invalidStorage.state.filterGroups.length, 4);

const loose = { ...harness.DEFAULT_FILTER_SETS[0], coverPadding: 2 };
const strict = { ...harness.DEFAULT_FILTER_SETS[2], coverPadding: 2 };
const payload = { rawItems: [{ text: "가나", score: 0.5, box: { left: 10, top: 10, width: 10, height: 10 } }] };
const image = { width: 100, height: 100 };
assert.equal(harness.processOcrPayload(payload, image, loose).counts.filtered, 1);
assert.equal(harness.processOcrPayload(payload, image, strict).counts.filtered, 0);

const filterId = harness.state.filterGroups[0].id;
harness.state.filterResultsByFile.set("file", new Map([["ocr", new Map([[filterId, { status: "done" }]])]]));
harness.state.activeFilterGroupBySource.set("file::ocr", filterId);
harness.state.bestCombinationByFile.set("file", { ocrGroupId: "ocr", filterGroupId: filterId });
harness.invalidateFilterGroupResults(filterId);
assert.equal(harness.state.filterResultsByFile.get("file").get("ocr").has(filterId), false);
assert.equal(harness.state.activeFilterGroupBySource.has("file::ocr"), false);
assert.equal(harness.state.bestCombinationByFile.has("file"), false);

harness.state.filterResultsByFile.set("file", new Map([["ocr", new Map([["filter", { status: "done" }]])]]));
harness.state.bestCombinationByFile.set("file", { ocrGroupId: "ocr", filterGroupId: "filter" });
harness.invalidateFilterSource("file", "ocr");
assert.equal(harness.state.filterResultsByFile.get("file").has("ocr"), false);
assert.equal(harness.state.bestCombinationByFile.has("file"), false);
assert.equal(/requestLocalOcr/.test(harness.applyFilterComparison.toString()), false);

const scheduler = createHarness();
const files = [
  { name: "one.png", size: 1, lastModified: 1 },
  { name: "two.png", size: 2, lastModified: 2 }
];
const ocrGroups = scheduler.selectedParameterGroups();
assert.equal(scheduler.buildRunTasks(files, ocrGroups).length, 8);
const firstKey = "one.png:1:1";
const secondKey = "two.png:2:2";
const runContextKey = scheduler.ocrContextKey(scheduler.readOcrContext());
const doneEntry = { status: "done", result: { ocrContextKey: runContextKey } };
scheduler.state.resultsByFile.set(firstKey, new Map(ocrGroups.map((group) => [group.id, doneEntry])));
scheduler.state.resultsByFile.set(secondKey, new Map([
  [ocrGroups[0].id, doneEntry],
  [ocrGroups[1].id, { status: "error" }],
  [ocrGroups[2].id, doneEntry],
  [ocrGroups[3].id, doneEntry]
]));
let pending = scheduler.buildRunTasks(files, ocrGroups);
assert.equal(pending.length, 1);
assert.equal(pending[0].group.id, ocrGroups[1].id);

scheduler.state.resultsByFile.get(secondKey).set(ocrGroups[1].id, doneEntry);
assert.equal(scheduler.buildRunTasks(files, ocrGroups).length, 0);
scheduler.invalidateGroupResults(ocrGroups[2].id);
pending = scheduler.buildRunTasks(files, ocrGroups);
assert.equal(pending.length, 2);
assert.equal(pending.every((task) => task.group.id === ocrGroups[2].id), true);
const forced = scheduler.buildRunTasks([files[0]], ocrGroups, [ocrGroups[0].id]);
assert.equal(forced.length, 1);
assert.equal(forced[0].group.id, ocrGroups[0].id);
const frozenDet = forced[0].group.params.textDetThresh;
ocrGroups[0].params.textDetThresh = 0.91;
assert.equal(forced[0].group.params.textDetThresh, frozenDet);
ocrGroups[3].enabled = false;
assert.equal(scheduler.selectedParameterGroups().some((group) => group.id === ocrGroups[3].id), false);

const normalizedPayload = {
  items: [{ text: "가나다", score: 0.9, box: { left: 0, top: 0, width: 20, height: 10 } }],
  rawItems: [
    { text: "가나다", score: 0.9, box: { left: 0, top: 0, width: 40, height: 20 } },
    { text: "가나다", score: 0.8, box: { left: 0, top: 0, width: 40, height: 20 } }
  ]
};
assert.equal(scheduler.processOcrPayload(normalizedPayload, image, loose).counts.raw, 1);

const fastPayload = { items: [{ text: "기존글", score: 0.9, box: { left: 0, top: 0, width: 20, height: 10 } }] };
const enhancedPayload = { items: [
  { text: "기존글", score: 0.99, enhancedVariantSupport: 3, box: { left: 1, top: 0, width: 20, height: 10 } },
  { text: "새문장", score: 0.85, enhancedVariantSupport: 2, box: { left: 30, top: 0, width: 20, height: 10 } },
  { text: "낮은값", score: 0.81, enhancedVariantSupport: 3, box: { left: 60, top: 0, width: 20, height: 10 } },
  { text: "고신뢰", score: 0.93, enhancedVariantSupport: 1, box: { left: 90, top: 0, width: 20, height: 10 } },
  { text: "새문장", score: 0.84, enhancedVariantSupport: 2, box: { left: 31, top: 0, width: 20, height: 10 } }
] };
const supplements = scheduler.selectEnhancedSupplements(fastPayload, enhancedPayload);
assert.deepEqual(supplements.map((item) => item.text), ["새문장", "고신뢰"]);
assert.equal(supplements.every((item) => item.supplemented), true);

scheduler.state.historyByFile.set(firstKey, [{}]);
scheduler.state.activeOcrGroupByFile.set(firstKey, ocrGroups[0].id);
scheduler.elements.get("ocrMode").value = "enhanced";
scheduler.handleOcrContextChange();
assert.equal(scheduler.state.resultsByFile.size, 0);
assert.equal(scheduler.state.historyByFile.size, 0);
assert.equal(scheduler.state.activeOcrGroupByFile.size, 0);

const importer = createHarness();
assert.equal(importer.isFileDrag({ dataTransfer: { types: ["Files"] } }), true);
assert.equal(importer.isFileDrag({ dataTransfer: { types: ["text/plain"] } }), false);
const droppedImage = { name: "drop.png", size: 42, lastModified: 9, type: "image/png" };
importer.loadSelectedFiles([droppedImage, droppedImage, { name: "notes.txt", size: 4, lastModified: 1, type: "text/plain" }]);
assert.equal(importer.state.files.length, 1);
assert.equal(importer.state.currentIndex, 0);
importer.loadSelectedFiles([{ name: "second.jpg", size: 43, lastModified: 10, type: "image/jpeg" }]);
assert.equal(importer.state.files.length, 2);

async function testFilterFlow() {
  const flow = createHarness();
  flow.state.filterGroups[1].enabled = false;
  flow.state.filterGroups[3].enabled = false;
  const file = { name: "sample.png", size: 123, lastModified: 456, type: "image/png" };
  const key = "sample.png:123:456";
  const ocrGroupId = flow.state.parameterGroups[0].id;
  const ocrParams = { ...flow.state.parameterGroups[0].params };
  const source = {
    ...flow.processOcrPayload(payload, image, { ...ocrParams, ...loose }),
    runId: "run-source",
    groupId: ocrGroupId,
    ocrParams,
    ocrContext: { serviceUrl: "http://127.0.0.1:8765", lang: "korean", mode: "fast" },
    ocrContextKey: flow.ocrContextKey(flow.readOcrContext()),
    params: { ...ocrParams, ...loose },
    fileName: file.name,
    dataUrl: "data:image/png;base64,test"
  };
  flow.state.files.push(file);
  flow.state.currentIndex = 0;
  flow.state.resultsByFile.set(key, new Map([[ocrGroupId, { status: "done", result: source, error: "" }]]));
  flow.renderComparison();
  const cards = flow.elements.get("comparisonGrid").children.filter((child) => child.tagName === "ARTICLE");
  const sourceCard = cards.find((card) => card.dataset.groupId === ocrGroupId);
  assert.ok(sourceCard.className.includes("selectable"));
  assert.equal(sourceCard.role, "button");
  assert.equal(sourceCard.tabIndex, 0);
  sourceCard.onclick();
  assert.equal(flow.state.activeOcrGroupByFile.get(key), ocrGroupId);
  const selectedCard = flow.elements.get("comparisonGrid").children.find((card) => card.dataset.groupId === ocrGroupId);
  assert.ok(selectedCard.className.includes("active"));
  assert.equal(selectedCard["aria-pressed"], "true");
  flow.state.activeOcrGroupByFile.set(key, ocrGroupId);
  await flow.applyFilterComparison();
  const entries = flow.state.filterResultsByFile.get(key).get(ocrGroupId);
  assert.equal(entries.size, 2);
  assert.deepEqual(Array.from(entries.values()).map((entry) => entry.status), ["done", "done"]);
  assert.equal(Array.from(entries.values()).every((entry) => entry.result.rawPayload === payload), true);
}

testFilterFlow()
  .then(() => console.log("OCR debug workbench state tests passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
