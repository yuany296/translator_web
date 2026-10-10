#!/usr/bin/env node
/**
 * 本地调试服务器 —— 「阶段检视台」与既有调试页面的**同源入口**。
 *
 * 为什么必须有一个服务器：本地 OCR 服务的 CORS 只允许扩展来源
 * （`local-ocr-service/ocr_service/dependencies.py` → `EXTENSION_ORIGIN_PATTERN = ^chrome-extension://[a-p]{32}$`）。
 * 浏览器实测：从 `file://`（`Origin: null`）或从 `http://127.0.0.1:8099` 直接调
 * `http://127.0.0.1:8765/health` 都是 `TypeError: Failed to fetch` —— 所以
 * `tools/ocr-debug-tool/index.html` 那条「直接 fetch 服务」的路从来没通过。这里用**同源反代**
 * 修掉它，而不是放宽服务端白名单（`Origin: null` 必须继续挡着：任何网页里的 sandbox iframe
 * 都是 null 来源，放开等于把本地术语库/译文库暴露给任意站点）。
 *
 * 提供的接口：
 *   GET  /                      工具索引（列出本目录下所有调试页面）
 *   GET  /api/meta              服务/bundle 版本状态（含 dist/test bundle 的 mtime）
 *   POST /api/ocr               同源调用本地 OCR（自动带 debug:true + debug_id，便于回看裁剪图）
 *   POST /api/stages            只重跑阶段回放（不重跑 OCR，用于「改参数看效果」）
 *   GET  /api/snapshots         列出 .local-data/debug 里的**线上快照**（页图 + result_json）
 *   GET  /api/snapshot?stem=    读一份历史快照（不重跑 OCR、不花钱）
 *   GET  /api/artifacts?stem=   某个 stem 下服务端写的裁剪图/可视化图清单
 *   GET  /api/artifact?rel=     读 .local-data/debug 下的产物（白名单根，防目录穿越）
 *   ALL  /ocr /health /ocr/timings /debug-background   纯反代（给既有调试页面直接用）
 *
 * 用法：node tools/stage-inspector/serve.mjs [--port 8099] [--service http://127.0.0.1:8765]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildStages, bundleMeta, RECOGNITION_FLOOR, summarizeStages } from "./stage-core.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const staticRoot = path.join(root, "tools");
const debugRoot = path.join(root, ".local-data", "debug");
const PROXY_PATHS = new Set(["/ocr", "/ocr/timings", "/health", "/debug-background"]);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8"
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || "").replace(/^--/u, "");
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port) || 8099;
const serviceUrl = String(args.service || "http://127.0.0.1:8765").replace(/\/+$/u, "");

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB`), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const text = await readBody(request);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 });
  }
}

/** 静态文件：只在 `tools/` 之内，越界一律 404。 */
function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "" : decodeURIComponent(pathname).replace(/^\/+/u, "");
  let target = path.resolve(staticRoot, relative);
  if (target !== staticRoot && !target.startsWith(staticRoot + path.sep)) {
    sendJson(response, 404, { error: "路径越界" });
    return;
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(response, 404, { error: `没有这个文件：${pathname}` });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(target).pipe(response);
}

/** 产物读取：只在 `.local-data/debug/` 之内。 */
function artifactPath(rel) {
  const target = path.resolve(debugRoot, String(rel || "").replace(/^\/+/u, ""));
  if (target !== debugRoot && !target.startsWith(debugRoot + path.sep)) {
    throw Object.assign(new Error("产物路径越界"), { status: 400 });
  }
  return target;
}

async function proxy(pathname, request, response, body) {
  const upstream = await fetch(`${serviceUrl}${pathname}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(text);
}

/** 快照清单：目录里可能积累了上千份历史产物，只回最新 200 条并给出总数。
 *  注意顺序：先只 stat 排序、切出最新 200 条，**再**去读这些 result_json —— 早期版本对全部
 *  2980 份都读了一遍 JSON（每份 100KB 级），列表要等好几秒。 */
const SNAPSHOT_LIMIT = 200;

function listSnapshots() {
  const imagesDir = path.join(debugRoot, "plugin_input");
  if (!fs.existsSync(imagesDir)) return { total: 0, snapshots: [] };
  const entries = fs.readdirSync(imagesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map(entry => {
      const stat = fs.statSync(path.join(imagesDir, entry.name));
      return { stem: entry.name.slice(0, -4), imageRel: `plugin_input/${entry.name}`, mtime: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime));
  const snapshots = entries.slice(0, SNAPSHOT_LIMIT).map(entry => {
    const resultFile = path.join(debugRoot, "result_json", `${entry.stem}.json`);
    const hasResult = fs.existsSync(resultFile);
    let counts = null;
    if (hasResult) {
      try {
        counts = JSON.parse(fs.readFileSync(resultFile, "utf8")).counts || null;
      } catch {
        counts = null;
      }
    }
    return { ...entry, resultRel: hasResult ? `result_json/${entry.stem}.json` : "", hasResult, counts };
  });
  return { total: entries.length, snapshots };
}

function artifactIndex(stem) {
  const safe = path.basename(String(stem || ""));
  const cropsDir = path.join(debugRoot, "slice_crops");
  const crops = fs.existsSync(cropsDir)
    ? fs.readdirSync(cropsDir)
      .filter(name => name.startsWith(`slice-${safe}-`) && name.toLowerCase().endsWith(".png"))
      .sort()
      .map(name => `slice_crops/${name}`)
    : [];
  const vis = ["jpg", "jpeg", "png"].map(ext => `vis/${safe}.${ext}`).find(rel => fs.existsSync(path.join(debugRoot, rel))) || "";
  return {
    stem: safe,
    pluginInput: fs.existsSync(path.join(debugRoot, "plugin_input", `${safe}.png`)) ? `plugin_input/${safe}.png` : "",
    resultJson: fs.existsSync(path.join(debugRoot, "result_json", `${safe}.json`)) ? `result_json/${safe}.json` : "",
    vis,
    crops
  };
}

function toolIndexHtml() {
  const pages = [];
  if (fs.existsSync(path.join(staticRoot, "stage-inspector", "index.html"))) {
    pages.push(["阶段检视台（Stage Inspector）", "stage-inspector/", "逐阶段看一页漫画：检测 → 识别下限 → 结果筛选 → ルビ → 合并 → 区域；可改参数看效果、可看服务端裁剪图"]);
  }
  if (fs.existsSync(path.join(staticRoot, "ocr-debug-tool", "index.html"))) {
    pages.push(["Manga OCR Compare Workbench", "ocr-debug-tool/index.html", "多组 OCR / 过滤参数横向对比（注意：它的 serviceUrl 要填本服务器地址，见 README）"]);
  }
  if (fs.existsSync(path.join(staticRoot, "ocr-debug-tool", "debug_background_workbench.html"))) {
    pages.push(["背景判定工作台", "ocr-debug-tool/debug_background_workbench.html", "实底 vs TELEA 清理判定的调参页"]);
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>调试工具索引</title>
<style>body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;max-width:900px;margin:40px auto;padding:0 16px}
h1{font-size:18px}li{margin:10px 0}a{font-weight:600;text-decoration:none}code{background:#f4f4f5;padding:1px 4px;border-radius:3px}
p.note{color:#52525b;font-size:13px}</style></head><body>
<h1>调试工具索引</h1>
<p class="note">本地 OCR 服务：<code>${serviceUrl}</code>（本页通过同源反代访问它，浏览器不会再报 CORS）</p>
<ul>${pages.map(([title, href, note]) => `<li><a href="/${href}">${title}</a><br><span class="note">${note}</span></li>`).join("")}</ul>
<p class="note">阶段回放跑的是 <code>dist/test/background.iife.js</code>（<code>npm run build</code> 的产物）。改了扩展源码后要重新 build，否则看到的是旧代码的行为。</p>
</body></html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const pathname = url.pathname;
  try {
    if (request.method === "GET" && pathname === "/") {
      const html = toolIndexHtml();
      response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (PROXY_PATHS.has(pathname)) {
      await proxy(pathname, request, response, request.method === "GET" ? undefined : await readBody(request));
      return;
    }
    if (pathname === "/api/meta") {
      let service = { ok: false, error: "未启动" };
      try {
        const health = await fetch(`${serviceUrl}/health`);
        service = await health.json();
      } catch (error) {
        service = { ok: false, error: String(error && error.message || error) };
      }
      sendJson(response, 200, { root, serviceUrl, staticRoot, debugRoot, bundle: bundleMeta(root), service });
      return;
    }
    if (pathname === "/api/ocr" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.image) throw Object.assign(new Error("缺少 image（data URL）"), { status: 400 });
      const debugId = String(body.debugId || `stage-inspector-${Date.now()}`);
      const payload = {
        image: body.image,
        lang: String(body.lang || "japan"),
        mode: String(body.mode || "fast"),
        debug: true,
        debug_id: debugId,
        text_rec_score_thresh: Number(body.textRecScoreThresh ?? RECOGNITION_FLOOR)
      };
      const upstream = await fetch(`${serviceUrl}/ocr`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await upstream.text();
      response.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-debug-stem": debugId
      });
      response.end(text);
      return;
    }
    if (pathname === "/api/stages" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.payload || typeof body.payload !== "object") {
        throw Object.assign(new Error("缺少 payload（服务端 /ocr 的返回）"), { status: 400 });
      }
      const stages = await buildStages(root, body.payload, body.tuning || {});
      sendJson(response, 200, { stages, summary: summarizeStages(stages), bundle: bundleMeta(root) });
      return;
    }
    if (pathname === "/api/snapshots") {
      const listed = listSnapshots();
      sendJson(response, 200, { ...listed, limit: SNAPSHOT_LIMIT, debugRoot });
      return;
    }
    if (pathname === "/api/snapshot") {
      const stem = path.basename(url.searchParams.get("stem") || "");
      const resultRel = path.join(debugRoot, "result_json", `${stem}.json`);
      if (!stem || !fs.existsSync(resultRel)) {
        throw Object.assign(new Error(`没有这份快照的 result_json：${stem}`), { status: 404 });
      }
      sendJson(response, 200, {
        stem,
        payload: JSON.parse(fs.readFileSync(resultRel, "utf8")),
        artifacts: artifactIndex(stem)
      });
      return;
    }
    if (pathname === "/api/artifacts") {
      sendJson(response, 200, artifactIndex(url.searchParams.get("stem")));
      return;
    }
    if (pathname === "/api/artifact") {
      const target = artifactPath(url.searchParams.get("rel"));
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw Object.assign(new Error(`没有这个产物：${url.searchParams.get("rel")}`), { status: 404 });
      }
      response.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store"
      });
      fs.createReadStream(target).pipe(response);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response, pathname);
      return;
    }
    sendJson(response, 405, { error: `不支持的方法：${request.method} ${pathname}` });
  } catch (error) {
    sendJson(response, Number(error && error.status) || 500, { error: String(error && error.message || error) });
  }
});

server.on("error", error => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`[stage-inspector] 端口 ${port} 已被占用，换一个：--port 8100`);
  } else {
    console.error("[stage-inspector] 服务器错误：", error);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const bundle = bundleMeta(root);
  console.log(`[stage-inspector] http://127.0.0.1:${port}/  （OCR 服务：${serviceUrl}）`);
  console.log(bundle.present
    ? `[stage-inspector] 阶段回放用 ${bundle.path}（${bundle.mtime}，几何版本 ${bundle.geometryVersion}）`
    : `[stage-inspector] 找不到 ${bundle.path} —— 先执行 npm run build，否则阶段回放会报错`);
});
