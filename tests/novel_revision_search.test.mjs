import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const contentRoot = path.join(projectRoot, "extension", "src", "content");
const contentSource = [fs.readFileSync(path.join(contentRoot, "configure.js"), "utf8"), ...fs.readdirSync(path.join(contentRoot, "modules"), {
  withFileTypes: true
}).filter(entry => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => fs.readFileSync(path.join(contentRoot, "modules", entry.name), "utf8"))].join("\n");
const css = fs.readFileSync(path.join(projectRoot, "extension", "public", "styles.css"), "utf8");

test("修订面板提供原文/译文搜索框并实时过滤卡片", () => {
  assert.match(contentSource, /search\.type = "search"/);
  assert.match(contentSource, /search\.placeholder = "搜索原文或译文…"/);
  assert.match(contentSource, /search\.addEventListener\("input", \(\) => filterRevisionCards\(\)\)/);
  assert.match(contentSource, /function filterRevisionCards\(\)/);
  assert.match(contentSource, /const haystack = `\$\{source\?\.textContent \|\| ""\} \$\{editor\?\.value \|\| ""\}`\.toLowerCase\(\)/);
  assert.match(contentSource, /card\.hidden = !match/);
});

test("修订面板渲染完成后应用当前搜索过滤", () => {
  assert.match(contentSource, /filterRevisionCards\(\);/);
});

test("修订面板搜索框与隐藏卡片有对应样式", () => {
  assert.match(css, /\.mt-novel-revision-search\s*\{[\s\S]*?box-sizing:\s*border-box/);
  assert.match(css, /\.mt-novel-revision-card\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.mt-novel-revision-empty\s*\{[\s\S]*?text-align:\s*center/);
  assert.match(css, /\.mt-novel-revision-body\s*\{[\s\S]*?flex:\s*1/);
});
