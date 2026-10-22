import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import { installGlossaryLibraryStore } from "../extension/src/glossary/modules/glossary-library-store.js";
import { installGlossaryLibraryLifecycle } from "../extension/src/glossary/modules/glossary-library-lifecycle.js";

// 删库语义：**库里的术语一并删除**，不再退回默认库。
// 起因：旧行为把条目迁进默认库，而默认库只有 500 条名额 —— 删几个库就把默认库塞满，
// 之后全站都加不进新术语，用户看到的是「术语装不下了」。
function makeState() {
  return {
    version: 4,
    revision: 1,
    updatedAt: 1,
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [], applyUrls: [] },
      { id: "lib-book", name: "骸骨皇女", enabled: true, urls: [], applyUrls: [] }
    ],
    entries: [
      { id: "e1", source: "김성현", target: "金成贤", sourceLanguage: "ko", targetLanguage: "zh-CN", scope: "global", scopeKey: "", libraryId: "default" },
      { id: "e2", source: "한재혁", target: "韩在赫", sourceLanguage: "ko", targetLanguage: "zh-CN", scope: "global", scopeKey: "", libraryId: "lib-book" },
      { id: "e3", source: "레이나", target: "蕾娜", sourceLanguage: "ko", targetLanguage: "zh-CN", scope: "global", scopeKey: "", libraryId: "lib-book" }
    ]
  };
}

function makeStore(state = makeState(), overrides = {}) {
  const calls = { persisted: [], serverDeletes: [] };
  const runtime = {
    glossaryCore,
    glossary: glossaryCore.normalizeGlossary(state),
    activeLibraryId: "",
    searchQueries: new Map(),
    // install 会重写 runtime.setLibraryStatus，所以状态只能从这块 DOM 桩上读。
    libraryStatusText: { textContent: "", dataset: {} },
    storageGet: async () => ({ [glossaryCore.STORAGE_KEY]: runtime.glossary }),
    storageSet: async () => undefined,
    persistEntries: async (entries, message) => {
      calls.persisted.push({ entries, message });
      runtime.glossary = glossaryCore.normalizeGlossary({ ...runtime.glossary, entries });
      return { ok: true };
    },
    deleteEntryFromServer: async id => {
      calls.serverDeletes.push(id);
      return { ok: true };
    },
    renderGlossary() {},
    renderLibraryPanel() {},
    refreshPendingLibraryControls() {},
    setStatus() {},
    createTermId: () => "term-new",
    resolveServerBaseUrl: async () => "http://127.0.0.1:9",
    ...overrides
  };
  installGlossaryLibraryStore(runtime);
  return { runtime, calls };
}

test("删库：库里的术语一起删除，不会迁移到默认术语库", async () => {
  const { runtime, calls } = makeStore();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const result = await runtime.removeLibrary("lib-book");
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.deepEqual(runtime.glossary.entries.map(entry => entry.id), ["e1"], "只剩默认库那条");
  assert.equal(
    runtime.glossary.entries.some(entry => entry.libraryId === "lib-book"), false,
    "不允许有残留条目挂到已删除的库上"
  );
  assert.equal(
    runtime.glossary.entries.filter(entry => entry.libraryId === "default").length, 1,
    "默认库不能被塞进被删库的条目"
  );
  assert.equal(runtime.glossary.libraries.some(library => library.id === "lib-book"), false);
  assert.match(calls.persisted[0].message, /连同 2 条术语一起删除/u);
});

test("删库：服务端也要逐条删除被删条目（否则刷新会复活）", async () => {
  const { runtime, calls } = makeStore();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await runtime.removeLibrary("lib-book");
  assert.deepEqual(calls.serverDeletes.sort(), ["e2", "e3"]);
  assert.equal(calls.serverDeletes.includes("e1"), false, "默认库的条目不能被误删");
});

test("删库：服务端删除失败必须报错，不能停在「已删除」上骗人", async () => {
  const { runtime } = makeStore(makeState(), {
    deleteEntryFromServer: async () => ({ ok: false, error: "HTTP 500" })
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const result = await runtime.removeLibrary("lib-book");
  assert.equal(result.ok, true);
  assert.equal(result.failedDeletes, 2);
  assert.match(runtime.libraryStatusText.textContent, /刷新后可能重新出现/u);
  assert.equal(runtime.libraryStatusText.dataset.error, "true", "必须是红色状态");
});

test("删空库：不写「连同 N 条」这类多余的话", async () => {
  const state = makeState();
  state.entries = state.entries.filter(entry => entry.libraryId !== "lib-book");
  const { runtime, calls } = makeStore(state);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const result = await runtime.removeLibrary("lib-book");
  assert.equal(result.removed, 0);
  assert.doesNotMatch(calls.persisted[0].message, /连同/u);
});

test("默认术语库仍然不可删除", async () => {
  const { runtime, calls } = makeStore();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const result = await runtime.removeLibrary("default");
  assert.equal(result.ok, false);
  assert.match(result.error, /默认术语库不能删除/u);
  assert.equal(calls.persisted.length, 0, "拒绝时不能落盘");
});

// ── 页面层：确认文案必须说清「一起删除、无法恢复、想保留先搬走」 ──
function makeLifecycleRuntime(state = makeState()) {
  const elements = new Map();
  const element = () => ({ value: "", disabled: false, title: "", classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
  const ids = [
    "libraryIdInput", "libraryDeleteBtn", "addLibraryBtn", "newLibraryDialog",
    "newLibraryBlankBtn", "newLibraryImportBtn", "newLibraryCancelBtn", "libraryTestInput"
  ];
  for (const id of ids) {
    elements.set(id, element());
  }
  elements.get("libraryIdInput").value = "lib-book";
  globalThis.document = { getElementById: id => elements.get(id) || null };
  globalThis.window = globalThis;
  const runtime = {
    glossaryCore,
    glossary: glossaryCore.normalizeGlossary(state),
    setStatus() {},
    setLibraryStatus() {},
    setView() {},
    removeLibrary: async () => ({ ok: true, removed: 2 }),
    updateLibraryDeleteButton() {}
  };
  installGlossaryLibraryLifecycle(runtime);
  return runtime;
}

test("确认框：说清术语会一起删除、不可恢复，并指出保留办法", async () => {
  const runtime = makeLifecycleRuntime();
  let confirmText = "";
  globalThis.confirm = message => {
    confirmText = message;
    return true;
  };
  await runtime.deleteCurrentLibrary();
  assert.match(confirmText, /删除术语库「骸骨皇女」/u);
  assert.match(confirmText, /2 条术语会一起删除/u);
  assert.match(confirmText, /无法恢复/u);
  assert.match(confirmText, /移动到/u, "要告诉用户想保留该怎么做");
  assert.doesNotMatch(confirmText, /移到默认术语库/u, "旧的迁移承诺必须消失");
});

test("删除按钮的说明也不再承诺「退回默认术语库」", () => {
  const runtime = makeLifecycleRuntime();
  const button = globalThis.document.getElementById("libraryDeleteBtn");
  runtime.updateLibraryDeleteButton({ id: "lib-book", name: "骸骨皇女" });
  assert.match(button.title, /一起删除/u);
  assert.doesNotMatch(button.title, /退回默认/u);
});
