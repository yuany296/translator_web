/**
 * 手机版设置页精简。
 *
 * 只保留手机版真正会用到的东西：常规、翻译服务（配置库 + 两个提取开关）、阅读与显示、
 * 术语库，以及「维护与诊断」里的临时缓存 / 重复译文（操作的都是扩展自己的 IndexedDB）。
 * 漫画 OCR、本地 SQLite 正式译文库、本地服务探针一律藏起来。
 *
 * 注意：一律用 inline display:none 隐藏，不删除节点。设置页的 fill()/事件绑定在模块
 * 初始化时就按 id 取了元素，删掉会让整页加载失败；而且 activateRoute 只切换 class，
 * inline 样式能保证被藏起来的面板即使被切到也不会露出来。
 */
import { injectNovelMobileStyles } from "./styles.js";
import { blockLocalServiceFetch } from "./no-local-service.js";
import { installTuningPanel } from "./tuning-panel.js";

const HIDDEN_ROUTES = ["ocr", "translations"];

// 只对漫画/OCR 有意义的字段：
//   - 「翻译策略」整张卡（预翻译模式 / 取图方式 / 漫画渲染）都是漫画取图与预翻
//   - 「调试显示」整张卡（OCR 覆盖阶段 / 覆盖预览）是 OCR 可视化调试
//   - 剩下这几个单独藏：忽略简体中文（扫网页用）、译文缩放与覆盖范围（漫画覆盖层排版）、
//     小说流式分段（桌面版流式接口的每批段数，手机版没有流式那一段）
const COMIC_ONLY_ARTICLE_FIELDS = Object.freeze(["pretranslateMode", "debugOverlayMode"]);
const COMIC_ONLY_FIELDS = Object.freeze([
  "ignoreSimplifiedChinese", "overwriteFontScale", "overwriteCoverPadding", "novelStreamBatchSize"
]);

// 桌面版小说流水线的速度旋钮（流式并发 / 渐进每块字数 / 补翻并发）：手机版走的是
// novel-batch.js 的并发小批，参数与存储键都是另一套（见 tuning-panel.js 注入的卡片），
// 这几个值对手机版完全不生效，整张卡一起藏掉。
// 三个 id 都要列：页面上它们同属一张卡，但按 id 逐个隐藏才不依赖卡片的 DOM 结构。
const DESKTOP_NOVEL_ARTICLE_FIELDS = Object.freeze([
  "novelStreamConcurrency", "novelChunkChars", "novelRepairConcurrency"
]);

// 桌面版网页正文翻译的速度旋钮（并发批数 / 每批段数 / 每批字符数）：手机版只翻
// KakaoPage / RIDI 小说，走的是 novel-batch.js 那条链路，这三个值（以及设置页那张
// 「网页翻译速度」卡）对它完全不生效。
const DESKTOP_WEBPAGE_ARTICLE_FIELDS = Object.freeze([
  "webpageConcurrency", "webpageBatchItems", "webpageBatchChars"
]);

// 手机版说人话：原文案都是按「漫画 + 网页 + OCR」写的。
const TEXT_REWRITES = Object.freeze([
  ["关闭后将停止自动识别并清理当前覆盖层。", "关闭后将停止翻译。"],
  ["同一组语言同时用于漫画 OCR、小说、网页和翻译服务。", "原文语言与目标语言，供小说翻译使用。"],
  ["统一应用到漫画、小说和网页。", "控制译文与原文的显示方式。"],
  ["不会删除 SQLite 正式译文库或术语库。", "不会删除术语库。"],
  ["调整预翻译、渲染和页面辅助行为。", "调整悬浮入口与显示方式。"]
]);

function hide(element) {
  if (element) element.style.display = "none";
}

export function hideRoutes(doc = globalThis.document, loc = globalThis.location) {
  HIDDEN_ROUTES.forEach(route => {
    doc.querySelectorAll(`[data-route="${route}"]`).forEach(hide);
    doc.querySelectorAll(`[data-panel="${route}"]`).forEach(hide);
  });
  // 旧书签/上一版残留的 hash 可能正指向被藏起来的栏目，先落回常规页。
  if (loc && HIDDEN_ROUTES.some(route => loc.hash === `#${route}`)) loc.hash = "#general";
}

/** 依赖本地服务的卡片：维护页的「本地服务」与翻译服务页的「本地正式译文库」。 */
export function hideLocalServiceCards(doc = globalThis.document) {
  const byClosest = id => {
    const node = doc.getElementById(id);
    hide(node && node.closest("article.setting-card"));
  };
  byClosest("probeOcrBtn");
  byClosest("probeTranslationStoreBtn");
  byClosest("checkServiceBtn");
}

/** 漫画/OCR 专属、以及桌面版小说流水线专属的设置项：手机版用不上，留着只会让人以为能用。 */
export function hideComicOnlySettings(doc = globalThis.document) {
  const articleOf = id => {
    const node = doc.getElementById(id);
    return node && node.closest("article.setting-card");
  };
  COMIC_ONLY_ARTICLE_FIELDS.forEach(id => hide(articleOf(id)));
  DESKTOP_NOVEL_ARTICLE_FIELDS.forEach(id => hide(articleOf(id)));
  DESKTOP_WEBPAGE_ARTICLE_FIELDS.forEach(id => hide(articleOf(id)));
  COMIC_ONLY_FIELDS.forEach(id => {
    const node = doc.getElementById(id);
    hide(node && node.closest("label"));
  });
}

/** 把提示语里「漫画 / 网页 / OCR / SQLite / 本地服务」的说法改成手机版的事实。 */
export function rewriteMobileTexts(doc = globalThis.document) {
  const nodes = doc.querySelectorAll("[data-panel] p, [data-panel] small, #routeSubtitle");
  for (const node of nodes) {
    let text = String(node.textContent || "");
    const original = text;
    for (const [from, to] of TEXT_REWRITES) text = text.replace(from, to);
    if (text !== original) node.textContent = text;
  }
}

export function renameBrand(doc = globalThis.document) {
  doc.title = "小说翻译器 · 管理中心";
  const brand = doc.querySelector(".sidebar .brand");
  if (!brand) return;
  const name = brand.querySelector("b");
  const subtitle = brand.querySelector("small");
  if (name) name.textContent = "小说翻译器";
  if (subtitle) subtitle.textContent = "KakaoPage / RIDI 手机版";
}

export function applyNovelMobileSettings(doc = globalThis.document, loc = globalThis.location) {
  injectNovelMobileStyles(doc);
  blockLocalServiceFetch();
  hideRoutes(doc, loc);
  hideLocalServiceCards(doc);
  hideComicOnlySettings(doc);
  // 语言提示写的是「OCR 自动识别（日语 / 韩语）」，手机版没有 OCR 那一层。
  hide(doc.getElementById("ocrLanguageHint"));
  renameBrand(doc);
  rewriteMobileTexts(doc);
  // 并发 / 每块字数：手机版唯一真正能拧的两个速度旋钮（见 novel-tuning.js）
  installTuningPanel(doc);
}
