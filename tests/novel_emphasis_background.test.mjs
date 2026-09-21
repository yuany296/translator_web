import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * 「让模型排版」的后台出口:只放行「标记成对、且去掉标记后与原文译文逐字一致」的结果。
 *
 * 排版这一步绝不允许模型改译文 —— 它改了，就整条丢掉，内容侧会退回按字符占比的近似映射。
 * 另外源文里没有 ⟦⟧ 的条目（= 这一段根本没有行内格式）不该发出去。
 */
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  TextDecoder,
  TextEncoder,
  ReadableStream,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
const background = context.__backgroundTest;

// 后台跑在 vm 上下文里：跨 realm 的数组/对象要先摊平到本 realm 再比。
const plain = value => JSON.parse(JSON.stringify(value));

const ITEM = {
  id: "p1",
  source: "본 보고에는 ⟦‘돌아가는 자’에 대한⟧ 내용이 포함되어 있습니다.",
  translation: "本报告中，关于‘回溯者’的内容也包含在内。"
};

async function align(items, stubResponse) {
  background.setBackgroundTestHooks({
    alignNovelEmphasis: async () => stubResponse
  });
  return background.handleAlignNovelEmphasis({ items });
}

test("标记成对且译文没被动过：放行", async () => {
  const response = await align([ITEM], {
    alignments: [{ id: "p1", marked_translation: "本报告中，关于⟦‘回溯者’⟧的内容也包含在内。" }]
  });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.alignments), [
    { id: "p1", marked_translation: "本报告中，关于⟦‘回溯者’⟧的内容也包含在内。" }
  ]);
});

test("模型借排版改了译文：整条丢掉", async () => {
  const response = await align([ITEM], {
    alignments: [{ id: "p1", marked_translation: "本报告中，关于⟦‘回溯者’⟧的内容也在其中。" }]
  });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.alignments), [], "译文必须逐字保留，改过就不要");
});

test("标记不成对 / 一个记号都没有：整条丢掉", async () => {
  const unbalanced = await align([ITEM], {
    alignments: [{ id: "p1", marked_translation: "本报告中，关于⟦‘回溯者’的内容也包含在内。" }]
  });
  assert.deepEqual(plain(unbalanced.alignments), []);
  const unmarked = await align([ITEM], {
    alignments: [{ id: "p1", marked_translation: ITEM.translation }]
  });
  assert.deepEqual(plain(unmarked.alignments), [], "一个标记都没有等于没对齐");
});

test("未知 id 直接忽略（模型编出来的段落不能落到页面上）", async () => {
  const response = await align([ITEM], {
    alignments: [
      { id: "p1", marked_translation: "本报告中，关于⟦‘回溯者’⟧的内容也包含在内。" },
      { id: "nope", marked_translation: "⟦凭空⟧多出来的一段" }
    ]
  });
  assert.deepEqual(plain(response.alignments).map(row => row.id), ["p1"]);
});

test("源文没有 ⟦⟧ 标记（这一段没有行内格式）时不发请求", async () => {
  const response = await background.handleAlignNovelEmphasis({
    items: [{ id: "p1", source: "그냥 평범한 문장입니다.", translation: "只是一句普通的话。" }]
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /marked source/u);
});
