import assert from "node:assert/strict";
import test from "node:test";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";
import {
  withFakeDocument, element, text, makeRuntime, descendants
} from "./helpers/fake-novel-dom.mjs";

/**
 * 「让模型排版」：模型的强调对齐结果要被采用，但绝不允许它借排版改动译文。
 *
 * 真机(蓝框 .box01/.box_txt)原文是「黑色正文 + 灰色加粗段」混排，按字符占比猜边界只能
 * 猜个大概(本章那一屏 137 段里有 4 段是混排)。现在多跑一次排版对齐小请求，由模型把
 * 原文的强调片段对到译文上；对不上就退回比例映射。
 */

function markedParagraph() {
  const paragraph = element("P", "box_txt");
  paragraph.setAttribute("data-p-id", "20");
  const strong = element("STRONG");
  strong.appendChild(text("‘돌아가는 자’에 대한"));
  paragraph.appendChild(text("본 보고에는 "));
  paragraph.appendChild(strong);
  paragraph.appendChild(text(" 포함되어 있습니다."));
  return paragraph;
}

test("describeNovelEmphasis：把原文的强调片段用 ⟦⟧ 标出来，供模型对齐", () => {
  withFakeDocument(() => {
    const state = { showTranslation: false, translations: new Map(), surface: null };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = markedParagraph();
    const described = runtime.describeNovelEmphasis(paragraph);
    assert.equal(described.count, 1);
    assert.equal(described.marked, "본 보고에는 ⟦‘돌아가는 자’에 대한⟧ 포함되어 있습니다.");
    // 纯文本段落不产生请求
    const plain = element("P", "txt");
    plain.appendChild(text("결국, 그는 고개를 끄덕였다."));
    assert.equal(runtime.describeNovelEmphasis(plain), null);
    // 无法复刻的结构(<br>)同样不发
    const withBreak = element("P", "txt");
    withBreak.appendChild(text("첫 줄"));
    withBreak.appendChild(element("BR"));
    assert.equal(runtime.describeNovelEmphasis(withBreak), null);
  });
});

test("模型对齐成功：强调段落在译文里的边界按标记走，不按比例猜", () => {
  withFakeDocument(() => {
    const translated = "本报告中，关于‘回溯者’的内容也包含在内。";
    const state = {
      showTranslation: true,
      translations: new Map([["20", translated]]),
      emphasisMarks: new Map([["20", "本报告中，关于⟦‘回溯者’⟧的内容也包含在内。"]]),
      surface: null
    };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = markedParagraph();
    runtime.renderNovelTranslation(paragraph, translated, true, "20");
    const translation = paragraph.querySelector(".mt-novel-translation");
    assert.equal(translation.textContent, translated, "标记本身绝不能漏到页面上");
    const strongs = descendants(translation, "STRONG");
    assert.equal(strongs.length, 1);
    assert.equal(strongs[0].textContent, "‘回溯者’", "加粗的正是模型指出的那一段");
    assert.equal(translation.childNodes[0].textContent, "本报告中，关于");
  });
});

test("模型多写了空格：按空白差异把边界投影回译文", () => {
  withFakeDocument(() => {
    const translated = "本报告中，关于‘回溯者’的内容也包含在内。";
    const state = {
      showTranslation: true,
      translations: new Map([["20", translated]]),
      emphasisMarks: new Map([["20", "本报告中，关于 ⟦‘回溯者’⟧的内容也包含在内。"]]),
      surface: null
    };
    const runtime = makeRuntime(state);
    installNovelRenderer(runtime);
    const paragraph = markedParagraph();
    runtime.renderNovelTranslation(paragraph, translated, true, "20");
    const translation = paragraph.querySelector(".mt-novel-translation");
    assert.equal(translation.textContent, translated);
    assert.equal(descendants(translation, "STRONG")[0].textContent, "‘回溯者’");
  });
});

test("模型改了译文 / 段数不对 / 标记不成对：一律退回比例映射，绝不放行", () => {
  withFakeDocument(() => {
    const translated = "本报告中，关于‘回溯者’的内容也包含在内。";
    const cases = [
      ["改了字", "本报告中，关于⟦‘回溯者’⟧的内容也在此内。"],
      ["段数不对", "本报告中，关于⟦‘回溯者’⟧的⟦内容⟧也包含在内。"],
      ["标记不成对", "本报告中，关于⟦‘回溯者’的内容也包含在内。"]
    ];
    for (const [name, marked] of cases) {
      const state = {
        showTranslation: true,
        translations: new Map([["20", translated]]),
        emphasisMarks: new Map([["20", marked]]),
        surface: null
      };
      const runtime = makeRuntime(state);
      installNovelRenderer(runtime);
      const paragraph = markedParagraph();
      runtime.renderNovelTranslation(paragraph, translated, true, "20");
      const translation = paragraph.querySelector(".mt-novel-translation");
      assert.equal(translation.textContent, translated, `${name}：译文必须原样保留`);
      const strongs = descendants(translation, "STRONG");
      assert.equal(strongs.length, 1, `${name}：仍然按比例映射复刻强调段`);
      assert.ok(strongs[0].textContent.length > 0);
      assert.ok(!translation.textContent.includes("⟦") && !translation.textContent.includes("⟧"),
        `${name}：标记绝不能漏到页面上`);
    }
  });
});
