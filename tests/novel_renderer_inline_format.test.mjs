import assert from "node:assert/strict";
import test from "node:test";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";
import {
  FakeNode, withFakeDocument, element, text, makeMixedParagraph, makeRuntime, descendants
} from "./helpers/fake-novel-dom.mjs";

/**
 * 小说版式复刻 + 「显示原文」必须完全还原页面。
 *
 * 用户实测(蓝框 .box01/.box_txt):原文是「黑色正文 + 灰色加粗段」混排,
 *  ① 套上包裹层后整段变成一种颜色 —— 页面给 `*` 加了 `color: … !important`,
 *     包裹层的 `color: inherit`(不带 !important)压不过它,颜色不再从段落继承;
 *  ② 切回原文也不恢复(包裹层还在,只是把译文标成 hidden);
 *  ③ 译文本身也丢了加粗/灰色段 —— 旧实现只在「整段只包一层行内元素」时才镜像。
 */

test("译文按原文片段比例复刻行内加粗段(混排段落不再整段放弃镜像)", () => {
  withFakeDocument(() => {
    const state = { showTranslation: false, translations: new Map(), surface: null };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = makeMixedParagraph();
    const translated = "本报告中，关于‘回溯者’的内容也包含在内。";
    assert.equal(runtime.renderNovelTranslation(paragraph, translated, true), true);
    const translation = paragraph.querySelector(".mt-novel-translation");
    assert.equal(translation.textContent, translated, "镜像不能丢字或多字");
    const strongs = descendants(translation, "STRONG");
    assert.equal(strongs.length, 1, "原文的 <strong> 必须复刻到译文上");
    assert.ok(strongs[0].textContent.length > 0, "复刻的加粗段不能是空壳");
    assert.ok(translated.includes(strongs[0].textContent), "加粗内容必须是译文的连续片段");
    assert.equal(strongs[0].getAttribute("data-p-id"), null,
      "镜像壳不能带 data-p-id,否则会被当成段落");
    assert.ok(translation.childNodes[0].textContent.length > 0,
      "加粗段要落在中间:前后都还有普通文字");
    assert.ok(translation.childNodes.at(-1).textContent.length > 0);
  });
});

test("纯文本段落不生成多余镜像节点", () => {
  withFakeDocument(() => {
    const state = { showTranslation: false, translations: new Map(), surface: null };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = element("P", "txt");
    paragraph.setAttribute("data-p-id", "6");
    paragraph.appendChild(text("결국, 강하진은 대화를 시작할 수 있었다."));
    runtime.renderNovelTranslation(paragraph, "最终，姜河镇得以开始对话。", true);
    const translation = paragraph.querySelector(".mt-novel-translation");
    assert.equal(translation.childNodes.length, 1);
    assert.equal(translation.childNodes[0].nodeType, 3);
  });
});

test("嵌套行内包裹(整段一个 span)沿用同一套标签与 class", () => {
  withFakeDocument(() => {
    const state = { showTranslation: false, translations: new Map(), surface: null };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = element("P", "box_txt");
    paragraph.setAttribute("data-p-id", "21");
    const span = element("SPAN", "txt_b");
    span.appendChild(text("보고서 제목"));
    paragraph.appendChild(span);
    runtime.renderNovelTranslation(paragraph, "报告标题", true);
    const translation = paragraph.querySelector(".mt-novel-translation");
    const mirrored = descendants(translation, "SPAN");
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0].className, "txt_b");
    assert.equal(mirrored[0].textContent, "报告标题");
  });
});

test("遇到 <br> 等无法复刻的行内结构时退回纯文本,不硬切", () => {
  withFakeDocument(() => {
    const state = { showTranslation: false, translations: new Map(), surface: null };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = element("P", "txt");
    paragraph.setAttribute("data-p-id", "22");
    paragraph.appendChild(text("첫 줄"));
    paragraph.appendChild(element("BR"));
    const strong = element("STRONG");
    strong.appendChild(text("둘째 줄"));
    paragraph.appendChild(strong);
    runtime.renderNovelTranslation(paragraph, "第一行第二行", true);
    const translation = paragraph.querySelector(".mt-novel-translation");
    assert.equal(translation.textContent, "第一行第二行");
    assert.equal(descendants(translation, "STRONG").length, 0);
  });
});

test("显示原文 = 撤掉译文与两个包裹节点,页面恢复原状(其他翻译软件要看得到纯韩文)", () => {
  withFakeDocument(() => {
    const root = new FakeNode(11);
    const state = {
      showTranslation: true,
      translations: new Map([["20", "本报告中，关于‘回溯者’的内容也包含在内。"]]),
      surface: { root }
    };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = makeMixedParagraph();
    root.appendChild(paragraph);
    const originalText = paragraph.textContent;

    runtime.reapplyNovelTranslations(state.surface);
    assert.ok(paragraph.querySelector(".mt-novel-translation"), "先要有译文才谈得上还原");

    runtime.setNovelTranslationVisibility(false);
    assert.equal(state.showTranslation, false);
    assert.equal(paragraph.querySelector(".mt-novel-source"), null, "包裹节点必须撤掉");
    assert.equal(paragraph.querySelector(".mt-novel-translation"), null, "译文节点必须撤掉");
    assert.equal(paragraph.dataset.mtNovelTranslated, undefined);
    assert.equal(paragraph.textContent, originalText,
      "隐藏的中文若留在 DOM 里,别的翻译插件会认定这段已经是译文而直接跳过");
    assert.equal(paragraph.childNodes.length, 3, "原来的三个子节点要回到段落下面");
    assert.equal(state.translations.get("20"), "本报告中，关于‘回溯者’的内容也包含在内。",
      "译文只从页面上撤掉,内存里要留着");

    runtime.setNovelTranslationVisibility(true);
    assert.equal(paragraph.querySelector(".mt-novel-translation").textContent,
      "本报告中，关于‘回溯者’的内容也包含在内。", "再显示译文时要从状态里重新贴回来");
  });
});

test("原文模式下 reconcile 不会把译文重新贴回页面", () => {
  withFakeDocument(() => {
    const root = new FakeNode(11);
    const state = {
      showTranslation: false,
      translations: new Map([["20", "译文"]]),
      surface: { root }
    };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = makeMixedParagraph();
    root.appendChild(paragraph);
    runtime.reapplyNovelTranslations(state.surface);
    assert.equal(paragraph.querySelector(".mt-novel-translation"), null,
      "reconcile 每 80ms 调一次 reapply,原文模式下必须保持页面原样");
  });
});
