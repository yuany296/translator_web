import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installNovelParagraphs } from "../extension/src/content/modules/novel-paragraph.js";

/**
 * 段落锚点契约：Kakao 页面自带 `data-p-id`、RIDI 是我们盖章的 `data-mt-novel-pid`，
 * 消费方必须通过 surface/anchorAttribute 取，不许硬编码。
 *
 * 老 bug：图像结果键与面板摘要硬编码 `data-p-id`，在 RIDI 上恒为空串 ——
 * 图像结果键因此丢掉段落身份（同屏多图的 key 只靠序号与 src 区分）。
 */

function nodeWith(attributes) {
  return { getAttribute: name => (name in attributes ? attributes[name] : null) };
}

function installed() {
  const runtime = {};
  installNovelParagraphs(runtime);
  return runtime;
}

test("拿不到 surface 时两个锚点属性都要试（RIDI 靠这条）", () => {
  const runtime = installed();
  assert.equal(runtime.novelAnchorValueOf(nodeWith({ "data-mt-novel-pid": "c1a2#3@ff" })), "c1a2#3@ff");
  assert.equal(runtime.novelAnchorValueOf(nodeWith({ "data-p-id": "52" })), "52");
  assert.equal(runtime.novelAnchorValueOf(nodeWith({})), "");
  assert.equal(runtime.novelAnchorValueOf(null), "");
});

test("surface 指定了锚点属性时优先用它", () => {
  const runtime = installed();
  const both = nodeWith({ "data-p-id": "52", "data-mt-novel-pid": "c1#0@aa" });
  assert.equal(runtime.novelAnchorValueOf(both, { anchorAttribute: "data-mt-novel-pid" }), "c1#0@aa");
  assert.equal(runtime.novelAnchorValueOf(both, { anchorAttribute: "data-p-id" }), "52");
});

test("图像面板与渲染器不再硬编码 data-p-id", () => {
  const panel = readFileSync(
    new URL("../extension/src/content/modules/novel-image-panel.js", import.meta.url), "utf8"
  );
  assert.doesNotMatch(panel, /getAttribute\?\.\("data-p-id"\)/u, "图像面板仍在硬编码锚点属性");
  assert.match(panel, /novelAnchorValueOf/u);
  // 结果键要能接受 surface（调用点知道 surface 时优先用它的属性）
  assert.match(panel, /getNovelImageResultKey\(target, index = 0, surface = null\)/u);

  const renderer = readFileSync(
    new URL("../extension/src/content/modules/novel-renderer.js", import.meta.url), "utf8"
  );
  assert.doesNotMatch(renderer, /\|\| "data-p-id"/u, "渲染器仍留着硬编码的属性名兜底");
  assert.match(renderer, /import \{ NOVEL_PAGE_ANCHOR_ATTRIBUTE \}/u,
    "渲染器应当静态导入默认锚点属性名，而不是自己写死");

  const reader = readFileSync(
    new URL("../extension/src/content/modules/novel-reader.js", import.meta.url), "utf8"
  );
  assert.match(reader, /getNovelImageResultKey\(target, index, surface\)/u,
    "收集正文图片时应当把 surface 一起传下去");
});
