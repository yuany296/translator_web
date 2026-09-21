import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const backgroundDir = path.join(root, "extension", "src", "background");
const modulesDir = path.join(backgroundDir, "modules");
const readModule = name => fs.readFileSync(path.join(modulesDir, name), "utf8");

function listSources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSources(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

/**
 * 回归：messages.js 里路由出去的处理器必须真的有人安装。
 * 曾经 ocr-timings.js 写好了 installOcrTimings，但没进 backgroundPhases，
 * 页面里的正文图片请求直接报「runtime.handleOcrDataUrlWithTimings is not a function」。
 */
test("background wiring: every handler routed by messages.js is installed by some module", () => {
  const messagesSource = readModule("messages.js");
  const referenced = new Set(
    [...messagesSource.matchAll(/runtime\.([A-Za-z_$][\w$]*)/gu)].map(match => match[1])
  );
  referenced.delete("handleMessage"); // messages.js 自己安装的入口
  assert.ok(referenced.size > 20, `消息路由处理器数量异常：${referenced.size}`);

  const installed = new Set();
  for (const file of listSources(backgroundDir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/runtime\.([A-Za-z_$][\w$]*)\s*=/gu)) installed.add(match[1]);
  }

  const missing = [...referenced].filter(name => !installed.has(name));
  assert.deepEqual(missing, [], `这些处理器被路由但没人安装：${missing.join(", ")}`);
});

test("background wiring: installment lists carry every installer and cannot drift apart", () => {
  const indexSource = readModule("index.js");
  const imported = [...indexSource.matchAll(/^import \{ (install[A-Za-z0-9_$]*) \} from "\.\/[\w-]+\.js";$/gmu)]
    .map(match => match[1]);
  assert.ok(imported.length > 35, `安装器数量异常：${imported.length}`);

  // 去掉 import 行后，每个安装器都必须出现在阶段数组里；内联写法（state: [installX]）也算。
  const body = indexSource.replace(/^import .*$/gmu, "");
  for (const name of imported) {
    assert.ok(body.includes(name), `${name} 已导入但没进任何阶段数组`);
  }

  const functions = indexSource.match(/functions: Object\.freeze\(\[([\s\S]*?)\]\)/u)[1];
  assert.match(functions, /installOcrTimings/u, "OCR 计时包装器必须装在 functions 阶段（messages.js 的 OCR_DATA_URL 依赖它）");
  assert.match(functions, /installOcrPipeline/u);
  assert.match(indexSource, /export const backgroundInstallers = Object\.freeze\(\[\s*\.\.\.backgroundPhases\.functions,/u,
    "backgroundInstallers 应由 backgroundPhases 派生，避免两份手写列表漂移");
});

test("background wiring: OCR timings wrapper delegates to the real OCR pipeline", () => {
  const timingsSource = readModule("ocr-timings.js");
  assert.match(timingsSource, /runtime\.handleOcrDataUrlWithTimings = handleOcrDataUrlWithTimings/u);
  assert.match(timingsSource, /await runtime\.handleOcrDataUrl\(message\)/u, "包装器必须调用真正的 OCR 处理器");
  assert.match(readModule("messages.js"), /case "OCR_DATA_URL":\s*\n\s*return runtime\.handleOcrDataUrlWithTimings\(message\);/u);
});
