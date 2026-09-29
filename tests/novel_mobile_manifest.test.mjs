import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 手机版 manifest 是「桌面版的那一份不许动、手机版单独一份」这两条纪律的看门人。
const root = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(root, "extension", "novel-mobile-assets");
const publicDir = path.join(root, "extension", "public");

function readJson(absolute) {
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

const mobile = readJson(path.join(assetsDir, "manifest.json"));
const desktop = readJson(path.join(publicDir, "manifest.json"));

test("桌面 manifest 没被动过（仍带侧栏与全站内容脚本）", () => {
  assert.equal(desktop.side_panel.default_path, "sidepanel.html");
  assert.equal(desktop.action.default_popup, "quick-popup.html");
  assert.equal(desktop.options_ui.page, "settings.html");
  assert.ok(desktop.permissions.includes("scripting"));
  const matches = desktop.content_scripts.flatMap(script => script.matches);
  assert.ok(matches.includes("<all_urls>"));
  assert.equal(desktop.background.service_worker, "background.js");
});

test("手机版 manifest 不带桌面专属能力", () => {
  assert.equal(mobile.side_panel, undefined, "手机版没有章节管理侧栏");
  assert.equal(mobile.permissions.includes("scripting"), false);
  assert.equal(mobile.permissions.includes("sidePanel"), false);
  assert.deepEqual(mobile.permissions, ["storage", "tabs", "unlimitedStorage"]);
});

test("手机版只在自己的域名上注入内容脚本（两家小说站，且不全站注入）", () => {
  const matches = mobile.content_scripts.flatMap(script => script.matches);
  assert.ok(matches.includes("https://*.kakao.com/*"));
  assert.ok(matches.includes("https://*.kakaopage.com/*"));
  assert.ok(matches.includes("https://*.kakaocdn.net/*"));
  assert.ok(matches.includes("https://ridibooks.com/*"), "RIDI 小说也要能注入");
  assert.ok(matches.includes("https://*.ridibooks.com/*"));
  assert.equal(matches.includes("<all_urls>"), false, "手机版不该在全网站点注入");
  const script = mobile.content_scripts[0];
  assert.deepEqual(script.js, ["content.js"]);
  assert.equal(script.all_frames, true);
  assert.equal(script.match_about_blank, true);
});

test("手机版入口与桌面版同名（HTML 里的 <script src> 不用改）", () => {
  assert.equal(mobile.background.service_worker, "background.js");
  assert.equal(mobile.background.type, "module");
  assert.equal(mobile.options_ui.page, "settings.html");
  assert.equal(mobile.action.default_popup, "quick-popup.html");
  assert.equal(mobile.minimum_chrome_version, "114");
});

test("手机版 manifest 引用的静态资源确实存在（图标与悬浮球图片都复用桌面资源）", () => {
  const referenced = [
    ...Object.values(mobile.icons || {}),
    ...mobile.content_scripts.flatMap(script => script.css || []),
    ...(mobile.web_accessible_resources || []).flatMap(entry => entry.resources || [])
  ];
  referenced.filter(item => !item.includes("*")).forEach(item => {
    const exists = fs.existsSync(path.join(publicDir, item)) || fs.existsSync(path.join(assetsDir, item));
    assert.ok(exists, `manifest 引用的 ${item} 不存在`);
  });
  assert.ok(fs.existsSync(path.join(publicDir, "icons", "icon-128.png")));
});

test("手机版样式表存在且覆盖了三个关键布局问题", () => {
  const css = fs.readFileSync(path.join(assetsDir, "novel-mobile.css"), "utf8");
  // 1) 桌面版写死的 min-width 必须被压掉，否则手机上整页横向滚动
  assert.match(css, /body\s*\{[^}]*min-width:\s*0/u);
  // 2) 6 列术语表格靠横向滚动而不是压扁
  assert.match(css, /#tableContainer\s*\{[^}]*overflow-x:\s*auto/u);
  // 3) 设置页/术语库各自的窄屏断点
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /@media \(max-width: 560px\)/u);
});
