#!/usr/bin/env node
/**
 * 阶段回放核心：把一次整页 OCR 的**每个阶段**算出来，供人工逐阶段判断。
 *
 * 为什么需要它：线上只有一个「OCR 调试」叠层（raw/filtered/merged/final 四个视角切换），
 * 看不到「哪一条被哪一道门丢的、ルビ 认成了谁的注音、最后合并成了哪几句」。这里把
 * `检测 → 识别下限 → 结果筛选 → ルビ过滤 → 聚类合并 → 区域/实底` 全部摊开，并把丢弃原因、
 * 合并结果、区域属性列成表。
 *
 * 关键约束：**阶段回放跑的是真代码** —— `dist/test/background.iife.js`（`npm run build` 的
 * 产物）载进 `node:vm`，用的是线上同一份 `keepOrTraceOcrWord` / `filterRubyAnnotationWords` /
 * `buildLocalPaddleBubbleItems`。既有的 `tools/ocr-debug-tool/index.html` 是在页面里另写了一份
 * 过滤/合并实现（index.html:1219 起），两份会漂移，所以这里不再重复那条路。
 *
 * 两种用法：
 *   1. 检视台（推荐）：`node tools/stage-inspector/serve.mjs` → 浏览器里选图/调参/看裁剪图
 *   2. 一次性静态报告（可离线分享）：
 *      node tools/stage-inspector/stage-core.mjs --ocr tmp-cmoa/page139.ocr.json \
 *           --image tmp-cmoa/page139.png --out tmp-cmoa/stage-report.html
 *
 * 已知近似（报告里也会写出来）：Node 里没有 `createImageBitmap`/`OffscreenCanvas`，
 * `analyzeLocalOcrImage` 返回 null，所以「扩展侧兜底取色」与吃像素的聚类判据不生效；
 * 块的**边界**可能与线上略有差别，块的**文本**、丢弃原因与ルビ判定不受影响。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const RECOGNITION_FLOOR = 0.4;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || "").replace(/^--/u, "");
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

/** 真代码来自构建产物：`npm run build` 产出的 IIFE（全局名 MtBackgroundModule）。 */
const BUNDLE_RELATIVE = path.join("dist", "test", "background.iife.js");

function bundlePath(root) {
  return path.join(root, BUNDLE_RELATIVE);
}

/** bundle 的 mtime/大小 + 它带的几何版本：用来判断「回放的是哪一次构建」。 */
function bundleMeta(root) {
  const file = bundlePath(root);
  if (!fs.existsSync(file)) {
    return { present: false, path: BUNDLE_RELATIVE, hint: "先执行 npm run build" };
  }
  const stat = fs.statSync(file);
  return {
    present: true,
    path: BUNDLE_RELATIVE,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    geometryVersion: loadRuntime(root).LOCAL_OCR_GEOMETRY_VERSION || ""
  };
}

function loadRuntime(root) {
  const file = bundlePath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ${BUNDLE_RELATIVE}：阶段回放必须跑真代码，先执行 npm run build`);
  }
  const bundle = fs.readFileSync(file, "utf8");
  const listeners = { addListener() {} };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
      tabs: {},
      storage: { local: {} }
    },
    console, fetch, URL, Blob, AbortController, atob, crypto: webcrypto, setTimeout, clearTimeout
  });
  vm.runInContext(`${bundle}\nglobalThis.__bg = MtBackgroundModule.backgroundRuntime;`, context, {
    filename: "background.iife.js"
  });
  return context.__bg;
}

function boxOf(item) {
  const box = (item && (item.rawBox || item.box || item.location)) || {};
  const left = Number(box.left) || 0;
  const top = Number(box.top) || 0;
  const width = Number(box.width) || 0;
  const height = Number(box.height) || 0;
  return { left, top, width, height };
}

function polygonOf(item, box) {
  const polygon = item && item.polygon;
  if (Array.isArray(polygon) && polygon.length >= 3) {
    const points = polygon.map(point => ({
      x: Number(Array.isArray(point) ? point[0] : point && point.x),
      y: Number(Array.isArray(point) ? point[1] : point && point.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length >= 3) return points;
  }
  return [
    { x: box.left, y: box.top },
    { x: box.left + box.width, y: box.top },
    { x: box.left + box.width, y: box.top + box.height },
    { x: box.left, y: box.top + box.height }
  ];
}

/** 多边形的屏幕轴包围盒（画面坐标）。用于「在图上画在哪 / 该裁哪一块」。 */
function boundsOf(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const xs = points.map(point => Number(point.x)).filter(Number.isFinite);
  const ys = points.map(point => Number(point.y)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 调试载荷（`toDebugOcrItem`）里的 `polygon` 是**百分比**坐标，而 `rawBox` 是像素 ——
 * 直接当像素画会把整层框挤到左上角（症状：「④⑤ 的结果没有框」）。
 * 这里把百分比换回像素；没有 polygon 时退回像素框。
 */
function debugPolygonToPixels(item, imageSize, fallbackBox) {
  const width = Number(imageSize && imageSize.width) || 0;
  const height = Number(imageSize && imageSize.height) || 0;
  const polygon = item && item.polygon;
  if (Array.isArray(polygon) && polygon.length >= 3 && width > 0 && height > 0) {
    const points = polygon.map(point => ({
      x: (Number(Array.isArray(point) ? point[0] : point && point.x) || 0) / 100 * width,
      y: (Number(Array.isArray(point) ? point[1] : point && point.y) || 0) / 100 * height
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length >= 3) return points;
  }
  return polygonOf(item, fallbackBox);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

/** 只接受 `getDefaultOcrTuning()` 里已知的键，且必须是有限数字 —— 不把任意字段塞进 tuning。 */
function normalizeTuning(rt, overrides) {
  const tuning = { ...rt.getDefaultOcrTuning(), confidenceThreshold: 0.72 };
  Object.keys(tuning).forEach(key => {
    if (!(key in (overrides || {}))) return;
    if (typeof tuning[key] === "boolean") {
      tuning[key] = overrides[key] === true;
      return;
    }
    const value = Number(overrides[key]);
    if (Number.isFinite(value)) tuning[key] = value;
  });
  return tuning;
}

async function buildStages(root, payload, tuningOverrides = {}) {
  const rt = loadRuntime(root);
  const imageSize = { width: Number(payload.imageWidth) || 0, height: Number(payload.imageHeight) || 0 };
  const tuning = normalizeTuning(rt, tuningOverrides);
  const session = rt.createOcrDebugSession("local_paddle", imageSize, tuning, {});
  const blocks = await rt.buildLocalPaddleBubbleItems(payload, imageSize, "", false, null, tuning, session);

  const arrivals = (payload.items || []).map((item) => ({
    text: String(item.text || ""),
    score: Number(item.score) || 0,
    box: boxOf(item),
    polygon: polygonOf(item, boxOf(item)),
    regionType: String(item.region_type || ""),
    bgColor: String(item.bg_color || ""),
    regionConfidence: Number(item.region_confidence) || 0
  }));
  const drops = session.filterReasons.map((entry) => {
    const box = boxOf(entry.item);
    return {
      text: String(entry.text || entry.item && entry.item.text || ""),
      reason: String(entry.dropReason || entry.reason || ""),
      score: Number(entry.item && entry.item.confidence) || 0,
      box,
      // 调试载荷的 polygon 是百分比，必须换回像素，否则整层框会挤在左上角
      polygon: debugPolygonToPixels(entry.item, imageSize, box),
      rubyHostText: String(entry.rubyHostText || ""),
      rubyGlyphRatio: Number(entry.rubyGlyphRatio) || 0
    };
  });
  const merged = blocks.map((block, index) => {
    const box = boxOf(block);
    const polygon = polygonOf(block, box);
    // 合并块的 `location/rawBox` 是**文字轴**几何（竖排时宽高与屏幕正好互换：实测一个两列气泡
    // rawBox 137×61、而屏幕上的四边形是 58×132），拿它当「画面上的位置」画框/裁图会错位。
    // 画框与最近邻裁图一律用多边形的屏幕轴包围盒，原值留在 textAxisBox 里备查。
    return {
      index,
      text: String(block.words || ""),
      box: boundsOf(polygon) || box,
      textAxisBox: box,
      polygon,
      rotation: Number(block.rotation_deg) || 0,
      lines: Number(block.sourceLineCount) || 0,
      fontHeight: Number(block.fontHeight) || 0,
      clusterKind: String(block.localOcrClusterKind || ""),
      regionType: String(block.localOcrRegionType || ""),
      background: block.adaptiveBackground && block.adaptiveBackground.type
        ? `${block.adaptiveBackground.type} ${block.adaptiveBackground.color || ""}`.trim()
        : "",
      confidence: Number(block.confidence) || 0,
      regionIds: Array.isArray(block.memberRegionIds) ? block.memberRegionIds.map(String) : []
    };
  });
  const regions = (payload.regions || []).map((region) => {
    const box = boxOf(region);
    return {
      id: String(region.id || ""),
      type: String(region.region_type || ""),
      bgColor: String(region.bg_color || ""),
      confidence: Number(region.confidence) || 0,
      box,
      polygon: polygonOf(region, box),
      texts: arrivals.filter(item => overlaps(item.box, box)).map(item => item.text)
    };
  });
  // 每条检测的「结局」：这是回答「为什么有那么多小字 / 它去哪了」的主表。
  const detections = (payload.rawItems || []).map((item, index) => {
    const box = boxOf(item);
    const score = Number(item.score) || 0;
    const text = String(item.text || "");
    let outcome = "保留（未并入任何块）";
    let kind = "kept";
    if (score < RECOGNITION_FLOOR) {
      outcome = `② 识别下限丢弃（${score.toFixed(3)} < ${RECOGNITION_FLOOR}）`;
      kind = "floor";
    } else {
      const drop = drops.find(entry => sameBox(entry.box, box) || (entry.text === text && contains(entry.box, box)));
      const block = merged.find(entry => contains(entry.box, box) || sameBox(entry.box, box));
      if (drop) {
        kind = drop.reason === "ruby-annotation" ? "ruby" : "filter";
        outcome = kind === "ruby"
          ? `⑤ ルビ丢弃 →「${drop.rubyHostText}」`
          : `④ 结果筛选丢弃（${REASON_LABELS[drop.reason] || drop.reason}）`;
      } else if (block) {
        kind = "merged";
        outcome = `⑥ 并入块 #${block.index}`;
      }
    }
    return {
      index,
      text,
      score,
      box,
      polygon: polygonOf(item, box),
      belowFloor: score < RECOGNITION_FLOOR,
      thickness: Math.round(Math.min(box.width, box.height)),
      kind,
      outcome
    };
  });
  // ⑧ 送进翻译模型的原文：聚类出来的文本带 `\n`（竖排每列一行），而 observation 层会用
  // `normalizeTranslationSourceText`（NFKC + `\s+ → " "`）把它折成**一个空格**，
  // canonical（canonical-translate.js）与翻译提示词（translation-provider.js#buildOpenAICompatibleTranslationPrompt）
  // 拿到的都是折过的那一份 —— 所以「回车」不会进模型，但会留下一个空格。
  // 这里把两者并排给出来，方便判断这个空格要不要改（日文/韩文其实不该用空格分词）。
  const translationInput = merged.map(block => {
    const clusterText = String(block.text || "");
    const sentText = rt.normalizeTranslationSourceText(clusterText);
    return {
      id: `t${block.index}`,
      clusterText,
      sentText,
      lines: block.lines,
      changedByNormalization: clusterText !== sentText
    };
  });
  return { imageSize, detections, arrivals, drops, merged, regions, translationInput, tuning };
}

function sameBox(a, b, tolerance = 0.6) {
  return Math.abs(a.left - b.left) <= tolerance && Math.abs(a.top - b.top) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

function contains(outer, inner) {
  const cx = inner.left + inner.width / 2;
  const cy = inner.top + inner.height / 2;
  return cx >= outer.left - 1 && cx <= outer.left + outer.width + 1
    && cy >= outer.top - 1 && cy <= outer.top + outer.height + 1;
}

function overlaps(a, b) {
  const width = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return width * height > 0.5 * Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

const REASON_LABELS = {
  "low-confidence": "分数不足（低分例外也没放行）",
  "too-small-area": "面积太小",
  "too-large-area": "面积太大",
  "too-small-dimension": "宽或高太小",
  "bad-aspect-ratio": "宽高比异常",
  "symbol-only": "只有符号",
  "mojibake-short-fragment": "短乱码碎片",
  "weak-script-confidence": "脚本字符置信度太弱",
  "ruby-annotation": "ルビ（振り仮名）注音",
  "empty-text-or-box": "空文本/空框",
  "ignored-simplified-chinese": "简体中文（按设置忽略）"
};

function renderReport({ image, payload, stages, imageName }) {
  const { imageSize, detections, arrivals, drops, merged, regions } = stages;
  const belowFloor = detections.filter(item => item.belowFloor).length;
  const rubyDrops = drops.filter(item => item.reason === "ruby-annotation");
  const filterDrops = drops.filter(item => item.reason !== "ruby-annotation");
  const data = {
    width: imageSize.width,
    height: imageSize.height,
    groups: {
      detections: detections.map(toBox),
      belowFloor: detections.filter(item => item.belowFloor).map(toBox),
      arrivals: arrivals.map(item => ({ ...toBox(item), label: `${item.text} · ${item.score.toFixed(3)}` })),
      filterDrops: filterDrops.map(item => ({ ...toBox(item), label: `${item.text} · ${item.score.toFixed(3)} · ${REASON_LABELS[item.reason] || item.reason}` })),
      rubyDrops: rubyDrops.map(item => ({ ...toBox(item), label: `ルビ「${item.text}」→ 注在「${item.rubyHostText}」· 粗细比 ${item.rubyGlyphRatio.toFixed(2)}` })),
      merged: merged.map(item => ({ ...toBox(item), label: `${item.text.replace(/\n/gu, "⏎")}` })),
      regions: regions.map(item => ({ ...toBox(item), label: `${item.id} ${item.type} ${item.bgColor} ${item.confidence.toFixed(2)}` }))
    }
  };
  const summary = [
    ["① 检测（detect）", `${detections.length} 条`, "服务端检测到的一切文字框，含噪声"],
    ["② 识别下限（recognize）", `丢掉 ${belowFloor} 条`, `分数 < ${RECOGNITION_FLOOR} 的一律不进结果（低于它就是识别本身不可信）`],
    ["③ 到达结果筛选", `${arrivals.length} 条`, "扩展侧真正拿到的一批"],
    ["④ 结果筛选（filter）", `丢掉 ${filterDrops.length} 条`, "低分例外：目标语言文字 + 面积正常才放行"],
    ["⑤ ルビ过滤（ruby）", `丢掉 ${rubyDrops.length} 条`, "全假名 + 比整页中位字号细 + 紧贴含汉字邻居"],
    ["⑥ 聚类合并（cluster）", `${merged.length} 块`, "同一气泡里的多列按「自右向左、列内自上而下」拼成一句"],
    ["⑦ 区域/实底（region）", `${regions.length} 个容器`, "speech_bubble + bg_color = 实底（用纯色遮，不走清理图）"],
    ["⑧ 翻译 / 布局 / 渲染", "未包含", "要跑翻译模型（花钱）与浏览器渲染；可在页面上用「OCR 调试」逐视角看"]
  ];
  const blocksTable = merged.map(item => `<tr>
      <td>#${item.index}</td>
      <td class="txt">${escapeHtml(item.text).replace(/\n/gu, "<br>")}</td>
      <td>${escapeHtml(item.regionType)}${item.background ? ` / ${escapeHtml(item.background)}` : ""}</td>
      <td>${item.lines}</td>
      <td>${item.confidence.toFixed(3)}</td>
      <td class="num">${Math.round(item.box.left)},${Math.round(item.box.top)} ${Math.round(item.box.width)}×${Math.round(item.box.height)}</td>
    </tr>`).join("");
  const dropsTable = drops.map(item => `<tr>
      <td class="reason">${escapeHtml(REASON_LABELS[item.reason] || item.reason)}</td>
      <td class="txt">${escapeHtml(item.text)}${item.rubyHostText ? ` <span class="host">→ ${escapeHtml(item.rubyHostText)}</span>` : ""}</td>
      <td>${item.score.toFixed(3)}</td>
    </tr>`).join("");
  const regionsTable = regions.map(item => `<tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${escapeHtml(item.bgColor || "—")}</td>
      <td>${item.confidence.toFixed(2)}</td>
      <td class="txt">${escapeHtml(item.texts.join(" / "))}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>阶段报告 · ${escapeHtml(imageName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f5f5; color: #222; }
  header { padding: 10px 16px; background: #1f2937; color: #fff; }
  header h1 { margin: 0 0 4px; font-size: 15px; }
  header p { margin: 0; font-size: 12px; color: #cbd5e1; }
  .layout { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(380px, 460px); gap: 0; align-items: start; }
  .viewer { position: sticky; top: 0; padding: 10px; background: #fff; border-right: 1px solid #d4d4d8; max-height: 100vh; overflow: auto; }
  .stage { position: relative; }
  .stage img { display: block; width: 100%; height: auto; }
  .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 8px; font-size: 12px; }
  .legend label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  .legend i { width: 12px; height: 12px; border-radius: 2px; display: inline-block; border: 2px solid currentColor; }
  .sw-raw { color: #ff4d4f; } .sw-floor { color: #8c8c8c; } .sw-arrival { color: #13c2c2; }
  .sw-filter { color: #fa8c16; } .sw-ruby { color: #a855f7; } .sw-merged { color: #1677ff; } .sw-region { color: #52c41a; }
  aside { padding: 12px 14px; }
  h2 { font-size: 13px; margin: 16px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d4d4d8; }
  h2:first-child { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  td.num { font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  td.reason { color: #b45309; white-space: nowrap; }
  td.txt { word-break: break-word; }
  .host { color: #a855f7; }
  .note { font-size: 12px; color: #52525b; background: #fffbeb; border-left: 3px solid #f59e0b; padding: 6px 8px; }
</style></head>
<body>
<header>
  <h1>阶段报告 · ${escapeHtml(imageName)} · ${imageSize.width}×${imageSize.height}</h1>
  <p>检测 ${detections.length} → 识别下限丢 ${belowFloor} → 结果筛选丢 ${filterDrops.length} → ルビ丢 ${rubyDrops.length} → 合并成 ${merged.length} 块 · 区域 ${regions.length} 个</p>
</header>
<div class="layout">
  <div class="viewer">
    <div class="legend">
      <label><input type="checkbox" data-group="detections"> <i class="sw-raw"></i>① 全部检测</label>
      <label><input type="checkbox" data-group="belowFloor"> <i class="sw-floor"></i>② 识别下限丢弃(&lt;${RECOGNITION_FLOOR})</label>
      <label><input type="checkbox" data-group="arrivals" checked> <i class="sw-arrival"></i>③ 到达结果筛选</label>
      <label><input type="checkbox" data-group="filterDrops" checked> <i class="sw-filter"></i>④ 结果筛选丢弃</label>
      <label><input type="checkbox" data-group="rubyDrops" checked> <i class="sw-ruby"></i>⑤ ルビ丢弃</label>
      <label><input type="checkbox" data-group="merged" checked> <i class="sw-merged"></i>⑥ 合并后的文本块</label>
      <label><input type="checkbox" data-group="regions"> <i class="sw-region"></i>⑦ 服务端区域</label>
    </div>
    <div class="stage">
      <img src="${image}" alt="page">
      <svg id="overlay" viewBox="0 0 ${imageSize.width} ${imageSize.height}" preserveAspectRatio="none"></svg>
    </div>
  </div>
  <aside>
    <h2>各阶段结果</h2>
    <table><thead><tr><th>阶段</th><th>结果</th><th>在做什么</th></tr></thead><tbody>
      ${summary.map(([name, count, note]) => `<tr><td>${escapeHtml(name)}</td><td class="num">${escapeHtml(count)}</td><td>${escapeHtml(note)}</td></tr>`).join("")}
    </tbody></table>
    <h2>⑥ 合并后的文本块（会送去翻译的原文）</h2>
    <table><thead><tr><th>#</th><th>原文</th><th>区域/实底</th><th>列数</th><th>置信</th><th>位置</th></tr></thead><tbody>${blocksTable}</tbody></table>
    <h2>④⑤ 被丢掉的东西与原因</h2>
    <table><thead><tr><th>原因</th><th>文本</th><th>分数</th></tr></thead><tbody>${dropsTable}</tbody></table>
    <h2>⑦ 服务端区域（实底判定）</h2>
    <table><thead><tr><th>id</th><th>类型</th><th>底色</th><th>置信</th><th>落在里面的文本</th></tr></thead><tbody>${regionsTable}</tbody></table>
    <h2>怎么读这份报告</h2>
    <p class="note">颜色即阶段：红=检测到的一切，灰虚线=被识别下限丢掉（分数 &lt; ${RECOGNITION_FLOOR}），青=到达结果筛选，橙=结果筛选丢掉，紫=判成ルビ（注音，故意忽略），蓝=最终合并成的一句话，绿=服务端判定的文字容器（有底色 = 实底，用纯色遮，不走清理图）。勾选框可以逐层叠加/剥离。</p>
    <p class="note">离线回放的近似：报告里没有浏览器画布，聚类拿不到整页像素（底色采样与行距判据），块的<strong>边界</strong>可能与线上略有差别；块的<strong>文本</strong>、丢弃原因、ルビ判定与线上同一份代码。</p>
  </aside>
</div>
<script>
const DATA = ${JSON.stringify(data).replace(/</gu, "\\u003c")};
const NS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("overlay");
const STYLE = {
  detections: { color: "#ff4d4f", width: 1, dash: "" },
  belowFloor: { color: "#8c8c8c", width: 1, dash: "4 3" },
  arrivals: { color: "#13c2c2", width: 1, dash: "" },
  filterDrops: { color: "#fa8c16", width: 1.5, dash: "5 3" },
  rubyDrops: { color: "#a855f7", width: 1.5, dash: "2 2" },
  merged: { color: "#1677ff", width: 2, dash: "" },
  regions: { color: "#52c41a", width: 1.5, dash: "" }
};
const LABEL_OFFSET = { detections: -2, belowFloor: 10, arrivals: -2, filterDrops: -2, rubyDrops: -2, merged: -4, regions: 10 };
function render() {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const group of Object.keys(DATA.groups)) {
    const enabled = document.querySelector('input[data-group="' + group + '"]').checked;
    if (!enabled) continue;
    const style = STYLE[group];
    for (const item of DATA.groups[group]) {
      const polygon = document.createElementNS(NS, "polygon");
      polygon.setAttribute("points", item.points);
      polygon.setAttribute("fill", group === "regions" ? "rgba(82,196,26,0.10)" : "none");
      polygon.setAttribute("stroke", style.color);
      polygon.setAttribute("stroke-width", style.width);
      if (style.dash) polygon.setAttribute("stroke-dasharray", style.dash);
      const title = document.createElementNS(NS, "title");
      title.textContent = item.label || "";
      polygon.appendChild(title);
      svg.appendChild(polygon);
      if (!item.label || group === "detections" || group === "arrivals") continue;
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", item.x);
      text.setAttribute("y", Math.max(8, item.y + LABEL_OFFSET[group]));
      text.setAttribute("fill", style.color);
      text.setAttribute("font-size", group === "merged" ? "13" : "11");
      text.setAttribute("font-family", "monospace");
      text.setAttribute("paint-order", "stroke");
      text.setAttribute("stroke", "#fff");
      text.setAttribute("stroke-width", "2.5");
      text.textContent = item.label;
      svg.appendChild(text);
    }
  }
}
for (const input of document.querySelectorAll("input[data-group]")) input.addEventListener("change", render);
render();
</script>
</body></html>`;
}

function toBox(item) {
  return {
    x: item.box.left,
    y: item.box.top,
    points: item.polygon.map(point => `${point.x},${point.y}`).join(" "),
    label: item.label || ""
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..", "..");
  const ocrPath = path.resolve(root, args.ocr || "tmp-cmoa/page139.ocr.json");
  const imagePath = path.resolve(root, args.image || ocrPath.replace(/\.ocr\.json$/u, ".png"));
  const outPath = path.resolve(root, args.out || path.join("tmp-cmoa", "stage-report.html"));
  const payload = JSON.parse(fs.readFileSync(ocrPath, "utf8"));
  const stages = await buildStages(root, payload);
  const image = `data:image/png;base64,${fs.readFileSync(imagePath).toString("base64")}`;
  fs.writeFileSync(outPath, renderReport({
    image,
    payload,
    stages,
    imageName: path.basename(imagePath)
  }), "utf8");
  console.log(`[stage-report] ${path.relative(root, outPath)}`);
  console.log(`  检测 ${stages.detections.length} / 到达 ${stages.arrivals.length} / 丢弃 ${stages.drops.length} / 合并 ${stages.merged.length} / 区域 ${stages.regions.length}`);
}

export { RECOGNITION_FLOOR, REASON_LABELS, buildStages, bundleMeta, loadRuntime, renderReport, summarizeStages };
/** 一行摘要，`serve.mjs` / CLI / 测试共用同一口径。 */
function summarizeStages(stages) {
  return {
    detections: stages.detections.length,
    belowFloor: stages.detections.filter(item => item.belowFloor).length,
    arrivals: stages.arrivals.length,
    filterDrops: stages.drops.filter(item => item.reason !== "ruby-annotation").length,
    rubyDrops: stages.drops.filter(item => item.reason === "ruby-annotation").length,
    merged: stages.merged.length,
    regions: stages.regions.length
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

