import assert from "node:assert/strict";
import test from "node:test";
import { applyGlossaryLocal } from "../extension/src/novel-mobile/glossary-local.js";
import { blockLocalServiceFetch } from "../extension/src/novel-mobile/no-local-service.js";

// 手机版术语库页测试：本地模式下的四处必须改写的行为 + 样式注入。
// 用最小 DOM 桩，因为设置/术语库页面本来就在浏览器里跑，这里只验证 JS 逻辑。
const fileInput = { accept: ".json,.csv,.db,.sqlite,.sqlite3", value: "" };
const headChildren = [];
const createdLinks = [];
// 「导入文件格式」说明里的两条：SQLite 那条手机版已经禁用导入，不该再显示
const importBullets = [
  { textContent: "CSV：三列就够 —— 原文,译文,备注", style: {} },
  { textContent: "SQLite（.db）：需要本地 OCR 服务在线，导入前会自动备份服务端数据库。", style: {} }
];
globalThis.document = {
  documentElement: { classList: { add() {} } },
  head: { appendChild: node => headChildren.push(node) },
  getElementById: id => (id === "fileInput" ? fileInput : null),
  querySelector: selector => (selector === "link[data-mt-novel-mobile]" ? createdLinks[0] || null : null),
  querySelectorAll: selector => (selector === ".import-format li" ? importBullets : []),
  createElement: tag => {
    const node = { tagName: tag, dataset: {}, style: {}, setAttribute() {} };
    if (tag === "link") createdLinks.push(node);
    return node;
  }
};
globalThis.confirm = () => true;

function makeRuntime(overrides = {}) {
  const calls = { loadSources: [], statuses: [], storage: [], persisted: [], libraryStatuses: [], rendered: 0 };
  const runtime = {
    glossaryCore: { STORAGE_KEY: "mt_glossary_v4" },
    glossary: {
      revision: 3,
      entries: [
        { id: "e1", source: "김성현", libraryId: "default" },
        { id: "e2", source: "한재혁", libraryId: "lib-2" }
      ],
      libraries: [{ id: "default", name: "默认术语库" }, { id: "lib-2", name: "骸骨皇女" }]
    },
    statusText: { textContent: "", dataset: {} },
    extractorStatus: { textContent: "" },
    clearBtn: { disabled: false },
    loadGlossary: async source => {
      calls.loadSources.push(source);
      return { ok: true };
    },
    loadGlossaryFromServer: async () => ({ ok: true, entries: [] }),
    saveEntryToServer: async () => ({ ok: true }),
    deleteEntryFromServer: async () => ({ ok: true }),
    pushLibraryToServer: async () => ({ ok: true }),
    deleteLibraryOnServer: async () => ({ ok: true }),
    persistEntries: async (entries, message) => {
      calls.persisted.push({ entries, message });
      runtime.glossary.entries = entries;
    },
    storageSet: async value => calls.storage.push(value),
    renderGlossary: () => { calls.rendered += 1; },
    renderLibraryPanel: () => {},
    setStatus: (message, isError) => {
      runtime.statusText.textContent = message;
      calls.statuses.push({ message, isError });
    },
    setLibraryStatus: (message, isError) => calls.libraryStatuses.push({ message, isError }),
    activeScope: () => ({ library: null, entries: runtime.glossary.entries }),
    saveLibrary: async () => ({ ok: true, library: { id: "lib-3", name: "新库" }, serverSynced: false }),
    setLibraryEnabled: async () => ({ ok: true, library: { id: "lib-3", name: "新库", enabled: false }, serverSynced: false }),
    importDbFileToServer: async () => ({ ok: true }),
    importGlossaryDbFile: async () => {},
    renderPendingState: () => { runtime.extractorStatus.textContent = "术语提取器：提取器在线"; },
    ...overrides
  };
  applyGlossaryLocal(runtime);
  return { runtime, calls };
}

test("术语页只读本机那份：source 被强制成 storage", async () => {
  const { runtime, calls } = makeRuntime();
  await runtime.loadGlossary("server");
  await runtime.loadGlossary();
  assert.deepEqual(calls.loadSources, ["storage", "storage"]);
  assert.equal(await runtime.loadGlossaryFromServer().then(result => result.ok), false);
});

test("服务端镜像接口一律本地应答（否则删除会误报「刷新后会重新出现」）", async () => {
  const { runtime } = makeRuntime();
  assert.deepEqual(await runtime.saveEntryToServer({}), { ok: true, local: true });
  assert.deepEqual(await runtime.deleteEntryFromServer("e1"), { ok: true, local: true });
  assert.deepEqual(await runtime.pushLibraryToServer({}), { ok: true, local: true });
  assert.deepEqual(await runtime.deleteLibraryOnServer("lib-2"), { ok: true, local: true });
});

test("「清空全部」改成本地实现：清条目、保留术语库定义与绑定网址", async () => {
  const { runtime, calls } = makeRuntime();
  await runtime.clearGlossary();
  assert.deepEqual(runtime.glossary.entries, []);
  assert.equal(runtime.glossary.libraries.length, 2, "库定义必须保留");
  assert.equal(runtime.glossary.revision, 4);
  assert.equal(calls.storage.length, 1);
  assert.ok(calls.storage[0]["mt_glossary_v4"], "要写回 chrome.storage");
  assert.match(runtime.statusText.textContent, /已清空 2 条术语/u);
  assert.match(runtime.statusText.textContent, /2 个术语库保留/u);
  assert.equal(runtime.clearBtn.disabled, false, "按钮状态要还原");
});

test("取消确认时「清空全部」什么都不做", async () => {
  const { runtime, calls } = makeRuntime();
  globalThis.confirm = () => false;
  try {
    await runtime.clearGlossary();
  } finally {
    globalThis.confirm = () => true;
  }
  assert.equal(runtime.glossary.entries.length, 2);
  assert.equal(calls.storage.length, 0);
});

test("选中某个库时「清空」只清该库，走既有的 persistEntries", async () => {
  const { runtime, calls } = makeRuntime();
  runtime.activeScope = () => ({
    library: { id: "lib-2", name: "骸骨皇女" },
    entries: runtime.glossary.entries.filter(entry => entry.libraryId === "lib-2")
  });
  await runtime.clearGlossary();
  assert.equal(calls.persisted.length, 1);
  assert.deepEqual(calls.persisted[0].entries.map(entry => entry.id), ["e1"]);
  assert.match(calls.persisted[0].message, /骸骨皇女/u);
});

test("术语库增删改不再弹「服务端未同步」，改成（本机）", async () => {
  const { runtime, calls } = makeRuntime();
  const saved = await runtime.saveLibrary({ name: "新库" });
  assert.equal(saved.serverSynced, true);
  assert.equal(saved.localOnly, true);
  assert.match(calls.libraryStatuses.at(-1).message, /已保存术语库「新库」（本机）/u);
  const toggled = await runtime.setLibraryEnabled("lib-3", false);
  assert.equal(toggled.serverSynced, true);
  assert.match(calls.libraryStatuses.at(-1).message, /已停用/u);
  assert.equal(calls.libraryStatuses.at(-1).isError, false);
});

test("SQLite 数据库导入被禁用，文件选择器只剩 JSON/CSV", async () => {
  const { runtime, calls } = makeRuntime();
  const server = await runtime.importDbFileToServer({});
  assert.equal(server.ok, false);
  assert.match(server.error, /不支持导入 SQLite/u);
  await runtime.importGlossaryDbFile({ target: { files: [] } });
  assert.match(calls.statuses.at(-1).message, /JSON 或 CSV/u);
  assert.equal(fileInput.accept, ".json,.csv");
  // 「导入文件格式」说明里也不能再推荐 .db 那条
  assert.equal(importBullets[1].style.display, "none");
  assert.equal(importBullets[0].style.display, undefined, "CSV 那条要留着");
});

test("提取器状态文案改成「AI」（手机版是直连 LLM，不是 ollama/heuristic）", () => {
  const { runtime } = makeRuntime();
  runtime.renderPendingState({});
  assert.equal(runtime.extractorStatus.textContent, "术语提取器：AI 在线");});

test("样式表注入是幂等的，并且挂在 head 上", () => {
  const { runtime } = makeRuntime();
  runtime.renderPendingState({});
  // 本文件里前面每个用例都调用过 applyGlossaryLocal：始终只应存在一份样式表。
  assert.equal(createdLinks.length, 1);
  assert.equal(createdLinks[0].href, "novel-mobile.css");
  assert.equal(headChildren.length, 1);
  applyGlossaryLocal(runtime);
  assert.equal(createdLinks.length, 1, "重复应用不该再插一份");
});

test("同步目标地址被固定成「一定被拦截」的回环地址：改库不再等网络超时", async () => {
  const { runtime } = makeRuntime();
  // 手机上 OCR 配置里可能留着桌面的局域网 IP：那不在拦截名单里，会让「一键加入应用」
  // 之后的 UI 更新卡在一次网络超时后面，看起来就是「点了没生效」。
  const nativeFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    blockLocalServiceFetch();
    const baseUrl = await runtime.resolveServerBaseUrl();
    await assert.rejects(globalThis.fetch(`${baseUrl}/glossary/libraries`), /本地服务/u);
    assert.deepEqual(requested, [], "根本不该发出这个请求");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("指向 127.0.0.1 的请求瞬间失败，其它地址照常放行", async () => {
  const nativeFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(String(url));
    return { ok: true, url };
  };
  try {
    blockLocalServiceFetch();
    await assert.rejects(globalThis.fetch("http://127.0.0.1:8765/glossary"), /本地服务/u);
    await assert.rejects(globalThis.fetch("http://localhost:8765/glossary/batch"), /本地服务/u);
    await globalThis.fetch("https://api.deepseek.com/v1/chat/completions");
    assert.deepEqual(seen, ["https://api.deepseek.com/v1/chat/completions"]);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
