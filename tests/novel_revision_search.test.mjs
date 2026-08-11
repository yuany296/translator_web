import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sidepanelRoot = path.join(projectRoot, "extension", "src", "sidepanel");
const revisionUiSource = fs.readFileSync(path.join(sidepanelRoot, "modules", "revision-ui.js"), "utf8");
const sidepanelHtml = fs.readFileSync(path.join(projectRoot, "extension", "public", "sidepanel.html"), "utf8");
const contentRoot = path.join(projectRoot, "extension", "src", "content");
const contentSource = [fs.readFileSync(path.join(contentRoot, "configure.js"), "utf8"), ...fs.readdirSync(path.join(contentRoot, "modules"), {
  withFileTypes: true
}).filter(entry => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => fs.readFileSync(path.join(contentRoot, "modules", entry.name), "utf8"))].join("\n");

test("侧栏页面提供原文/译文搜索框并实时过滤卡片", () => {
  assert.match(sidepanelHtml, /<input id="search" type="search" placeholder="搜索原文或译文…"/);
  assert.match(revisionUiSource, /searchInput\.addEventListener\("input", \(\) => applyFilter\(\)\)/);
  assert.match(revisionUiSource, /function applyFilter\(\)/);
  assert.match(revisionUiSource, /card\.hidden = !match/);
});

test("侧栏面板渲染完成后应用当前搜索过滤", () => {
  assert.match(revisionUiSource, /applyFilter\(\);/);
});

test("侧栏搜索框与隐藏卡片有对应样式", () => {
  assert.match(sidepanelHtml, /\.toolbar input\[type="search"\]\s*\{[\s\S]*?box-sizing:\s*border-box/);
  assert.match(sidepanelHtml, /\.card\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(sidepanelHtml, /\.empty\s*\{[\s\S]*?text-align:\s*center/);
});

test("侧栏卡片绑定 itemId 支持编辑后刷新", () => {
  assert.match(revisionUiSource, /dataset:\s*\{\s*itemId:\s*item\.id\s*\}/);
  assert.match(revisionUiSource, /sendAction\s*=\s*\(action,\s*payload\s*=\s*\{\}\)\s*=>\s*sendTab\(/);
  assert.match(revisionUiSource, /refresh\(\)/);
  assert.match(contentSource, /performNovelRevisionAction/);
  assert.match(contentSource, /getNovelRevisionSnapshot/);
});

test("content script 在 reader-init 上挂接侧栏消息 handler", () => {
  assert.match(contentSource, /GET_NOVEL_CHAPTER_SNAPSHOT/);
  assert.match(contentSource, /NOVEL_REVISION_ACTION/);
  assert.match(contentSource, /runtime\.getNovelRevisionSnapshot\s*=\s*buildChapterSnapshot/);
  assert.match(contentSource, /runtime\.performNovelRevisionAction\s*=\s*performAction/);
});