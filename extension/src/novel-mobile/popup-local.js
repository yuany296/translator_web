/**
 * 手机版快捷弹窗精简：保留「启用 / 语言 / 显示内容 / 完整设置」，
 * 藏掉漫画可视区翻译、章节管理侧栏与网页翻译/OCR 调试参数（手机版都不做）。
 *
 * 与设置页同理，只隐藏不删除节点：quick-popup/controller.js 的同步部分已经按 id
 * 绑定过事件，删掉节点会让绑定与首屏填充直接抛错。
 */
export function hideIrrelevantControls(doc = document) {
  const hide = element => {
    if (element) element.style.display = "none";
  };
  const debugHeading = doc.getElementById("debugHeading");
  hide(debugHeading && debugHeading.closest("section.card"));
  hide(doc.getElementById("translateBtn"));
  hide(doc.getElementById("manageChapterBtn"));
}

export function renamePopupBrand(doc = document) {
  doc.title = "小说翻译器";
  const title = doc.querySelector(".popup-header h1");
  const eyebrow = doc.querySelector(".popup-header .eyebrow");
  if (title) title.textContent = "小说翻译器";
  if (eyebrow) eyebrow.textContent = "KAKAO / RIDI NOVEL";
  const hint = doc.querySelector("#languageHeading + p");
  if (hint) hint.textContent = "小说与翻译服务共用";
}

export function applyNovelMobilePopup(doc = document) {
  hideIrrelevantControls(doc);
  renamePopupBrand(doc);
}
