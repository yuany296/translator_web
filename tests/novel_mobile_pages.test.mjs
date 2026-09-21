import assert from "node:assert/strict";
import test from "node:test";
import { applyNovelMobilePopup } from "../extension/src/novel-mobile/popup-local.js";
import { applyNovelMobileSettings } from "../extension/src/novel-mobile/settings-local.js";

// 两个扩展页面（设置页、快捷弹窗）的手机版精简：纯 DOM 覆盖，用最小桩验证
// 「藏什么、改什么文案、什么没被动」——尤其是绝不能删除节点（页面初始化时按 id 取过元素）。
function makeElement(extra = {}) {
  return Object.assign({
    style: {},
    textContent: "",
    dataset: {},
    children: [],
    closestMap: {},
    closest(selector) {
      return this.closestMap[selector] || null;
    },
    querySelector: () => null,
    querySelectorAll: () => []
  }, extra);
}

function makeSettingsDoc() {
  const byId = {};
  const labelOf = {};
  const articleOf = {};
  const register = (id, { label = true, article = true } = {}) => {
    const node = makeElement({ id });
    if (label) {
      const wrapper = makeElement();
      node.closestMap.label = wrapper;
      labelOf[id] = wrapper;
    }
    if (article) {
      const wrapper = makeElement();
      node.closestMap["article.setting-card"] = wrapper;
      articleOf[id] = wrapper;
    }
    byId[id] = node;
    return node;
  };
  // 依赖本地服务的按钮 / 提示
  ["probeOcrBtn", "probeTranslationStoreBtn", "checkServiceBtn"].forEach(id => register(id, { label: false }));
  register("ocrLanguageHint", { label: false, article: false });
  // 漫画 / OCR 专属，应该藏
  ["pretranslateMode", "debugOverlayMode"].forEach(id => register(id));
  ["ignoreSimplifiedChinese", "overwriteFontScale", "overwriteCoverPadding", "novelStreamBatchSize"]
    .forEach(id => register(id));
  // 桌面版小说流水线的速度旋钮：同一个卡片里的三个字段整张卡藏掉
  ["novelStreamConcurrency", "novelChunkChars", "novelRepairConcurrency"].forEach(id => register(id));
  // 桌面版网页正文翻译的速度旋钮：手机版不做网页翻译，整张「网页翻译速度」卡也要藏
  ["webpageConcurrency", "webpageBatchItems", "webpageBatchChars"].forEach(id => register(id));
  // 手机版要保留的
  ["showBall", "floatingSide", "runtimeEnabled", "sourceLanguage", "targetLanguage"].forEach(id => register(id));

  const routes = { ocr: [makeElement()], translations: [makeElement()] };
  const panels = { ocr: [makeElement()], translations: [makeElement()] };
  const brand = makeElement();
  const brandName = makeElement();
  const brandSubtitle = makeElement();
  const routeSubtitle = makeElement({ textContent: "调整预翻译、渲染和页面辅助行为。" });
  const hintNodes = [
    makeElement({ textContent: "关闭后将停止自动识别并清理当前覆盖层。" }),
    makeElement({ textContent: "同一组语言同时用于漫画 OCR、小说、网页和翻译服务。" }),
    makeElement({ textContent: "统一应用到漫画、小说和网页。" }),
    makeElement({ textContent: "不会删除 SQLite 正式译文库或术语库。" })
  ];
  const link = makeElement();
  const doc = {
    title: "漫画翻译器 · Next · 管理中心",
    head: { appendChild() {} },
    links: [],
    getElementById: id => byId[id] || null,
    querySelectorAll: selector => {
      const route = /^\[data-route="(\w+)"\]$/u.exec(selector);
      if (route) return routes[route[1]] || [];
      const panel = /^\[data-panel="(\w+)"\]$/u.exec(selector);
      if (panel) return panels[panel[1]] || [];
      if (selector.includes("[data-panel]")) return [...hintNodes, routeSubtitle];
      return [];
    },
    querySelector: selector => (selector === ".sidebar .brand" ? brand : null),
    createElement: () => {
      doc.links.push(link);
      return link;
    }
  };
  brand.querySelector = selector => (selector === "b" ? brandName : selector === "small" ? brandSubtitle : null);
  return { doc, byId, labelOf, articleOf, routes, panels, brandName, brandSubtitle, routeSubtitle, hintNodes };
}

test("设置页：藏掉 OCR 与译文库栏目，且只藏不删（元素仍在 DOM 里）", () => {
  const { doc, routes, panels } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "" });
  ["ocr", "translations"].forEach(route => {
    assert.equal(routes[route][0].style.display, "none");
    assert.equal(panels[route][0].style.display, "none");
  });
  assert.equal(routes.ocr.length, 1, "不能从 DOM 里摘掉：页面初始化按 id/选择器取过元素");
});

test("设置页：旧书签指向被藏起来的栏目时落回常规页", () => {
  const { doc } = makeSettingsDoc();
  const location = { hash: "#ocr" };
  applyNovelMobileSettings(doc, location);
  assert.equal(location.hash, "#general");
});

test("设置页：本地服务、本地正式译文库、OCR 语言提示都藏起来", () => {
  const { doc, byId, articleOf } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "#glossary" });
  assert.equal(articleOf.probeOcrBtn.style.display, "none");
  assert.equal(articleOf.probeTranslationStoreBtn.style.display, "none");
  assert.equal(articleOf.checkServiceBtn.style.display, "none", "手机版没有 SQLite 正式译文库");
  assert.equal(byId.ocrLanguageHint.style.display, "none");
});

test("设置页：漫画/OCR 专属设置整张卡与逐字段都藏掉", () => {
  const { doc, labelOf, articleOf } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "#reading" });
  assert.equal(articleOf.pretranslateMode.style.display, "none", "「翻译策略」整张卡是漫画取图/预翻");
  assert.equal(articleOf.debugOverlayMode.style.display, "none", "「调试显示」整张卡是 OCR 可视化调试");
  ["novelStreamConcurrency", "novelChunkChars", "novelRepairConcurrency"].forEach(id => {
    assert.equal(articleOf[id].style.display, "none",
      `「小说翻译速度」的 ${id} 只对桌面版流水线生效（手机版用自己的并发小批设置卡）`);
  });
  ["webpageConcurrency", "webpageBatchItems", "webpageBatchChars"].forEach(id => {
    assert.equal(articleOf[id].style.display, "none",
      `「网页翻译速度」的 ${id} 只对桌面版网页正文翻译生效（手机版不做网页翻译）`);
  });
  ["ignoreSimplifiedChinese", "overwriteFontScale", "overwriteCoverPadding", "novelStreamBatchSize"]
    .forEach(id => assert.equal(labelOf[id].style.display, "none", `${id} 只对漫画/流式有意义`));
});

test("设置页：该留的必须留着（悬浮按钮与悬浮侧边）", () => {
  const { doc, labelOf, byId } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "#reading" });
  assert.equal(labelOf.showBall.style.display, undefined, "显示悬浮按钮必须保留");
  assert.equal(labelOf.floatingSide.style.display, undefined, "悬浮侧边必须保留");
  assert.equal(byId.showBall.style.display, undefined);
});

test("设置页：提示语改成手机版的事实（不再提漫画/OCR/SQLite/预翻译）", () => {
  const { doc, hintNodes, routeSubtitle } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "#general" });
  assert.equal(hintNodes[0].textContent, "关闭后将停止翻译。");
  assert.equal(hintNodes[1].textContent, "原文语言与目标语言，供小说翻译使用。");
  assert.equal(hintNodes[2].textContent, "控制译文与原文的显示方式。");
  assert.equal(hintNodes[3].textContent, "不会删除术语库。");
  assert.equal(routeSubtitle.textContent, "调整悬浮入口与显示方式。");
  [...hintNodes, routeSubtitle].forEach(node => {
    assert.equal(/漫画|OCR|SQLite|预翻译/u.test(node.textContent), false, `残留旧说法：${node.textContent}`);
  });
});

test("设置页：改写标题与品牌，注入手机版样式表", () => {
  const { doc, brandName, brandSubtitle } = makeSettingsDoc();
  applyNovelMobileSettings(doc, { hash: "" });
  assert.equal(doc.title, "小说翻译器 · 管理中心");
  assert.equal(brandName.textContent, "小说翻译器");
  assert.equal(brandSubtitle.textContent, "KakaoPage 手机版");
  assert.equal(doc.links.length, 1);
  assert.equal(doc.links[0].href, "novel-mobile.css");
});

test("快捷弹窗：藏掉漫画可视区翻译、章节管理与网页/OCR 参数，保留启用/语言/显示/设置", () => {
  const debugCard = makeElement();
  const debugHeading = makeElement({ id: "debugHeading" });
  debugHeading.closest = selector => (selector === "section.card" ? debugCard : null);
  const translateBtn = makeElement({ id: "translateBtn" });
  const manageChapterBtn = makeElement({ id: "manageChapterBtn" });
  const title = makeElement();
  const eyebrow = makeElement();
  const hint = makeElement();
  const byId = { debugHeading, translateBtn, manageChapterBtn };
  const doc = {
    title: "漫画翻译器",
    getElementById: id => byId[id] || null,
    querySelector: selector => {
      if (selector === ".popup-header h1") return title;
      if (selector === ".popup-header .eyebrow") return eyebrow;
      if (selector === "#languageHeading + p") return hint;
      return null;
    }
  };
  applyNovelMobilePopup(doc);
  assert.equal(debugCard.style.display, "none");
  assert.equal(translateBtn.style.display, "none");
  assert.equal(manageChapterBtn.style.display, "none");
  assert.equal(doc.title, "小说翻译器");
  assert.equal(title.textContent, "小说翻译器");
  assert.equal(eyebrow.textContent, "KAKAOPAGE NOVEL");
  assert.equal(hint.textContent, "小说与翻译服务共用");
});
