import assert from "node:assert/strict";
import test from "node:test";
import { installMobileProgressLabels } from "../extension/src/novel-mobile/progress-labels.js";

// 进度面板文案测试：桌面版把这条通道叫「精翻」并声称「按章节顺序」，手机版是并发小批，
// 没有任何二次润色。这里确保渲染出来的文案不会再把人误导成「还有个精修阶段」。
function makeHarness() {
  const elements = {
    title: { textContent: "" },
    phase: { textContent: "" },
    note: { textContent: "" },
    imageRow: { row: { hidden: false } }
  };
  const runtime = {
    state: { novelProgressElements: elements },
    // 模拟 novel-progress-panel.js：这两个入口内部各自写死桌面版文案
    setNovelTextStatus: () => {
      elements.title.textContent = "小说精翻进行中";
      elements.phase.textContent = "正在准备正文精翻…";
      elements.note.textContent = "为保持上下文一致，正文按章节顺序精翻；当前页尚未轮到时会暂时保留韩文。";
    },
    setNovelImageStatus: () => {},
    updateNovelProgressPanel: () => {
      elements.note.textContent = "译文会按章节顺序逐段显示，图片任务在后台独立处理。";
    }
  };
  installMobileProgressLabels(runtime);
  return { runtime, elements };
}

test("面板文案不再出现「精翻」与「按章节顺序」（并发小批没有「轮到」这回事）", () => {
  const { runtime, elements } = makeHarness();
  runtime.setNovelTextStatus("working", {});
  assert.equal(elements.title.textContent, "小说翻译中");
  assert.equal(elements.phase.textContent, "正在准备正文翻译…");
  assert.equal(elements.note.textContent, "正文按块并发翻译；还没出译文的段落会暂时保留韩文。");
  assert.equal(/精翻|精修|按章节顺序/u.test(elements.note.textContent), false);
});

test("另一处「按章节顺序」的说明也被改写（走 updateNovelProgressPanel 那条路径）", () => {
  const { runtime, elements } = makeHarness();
  runtime.updateNovelProgressPanel();
  assert.equal(elements.note.textContent, "译文会按块陆续显示。");
});

test("手机版不处理正文插图，面板里的「图片 x/y」行藏起来", () => {
  const { runtime, elements } = makeHarness();
  assert.equal(elements.imageRow.row.hidden, false);
  runtime.setNovelTextStatus("working", {});
  assert.equal(elements.imageRow.row.hidden, true);
});

test("只替换桌面版原句：其它文案（含失败诊断）原样保留", () => {
  const { runtime, elements } = makeHarness();
  runtime.setNovelTextStatus("partial", {});
  elements.phase.textContent = "诊断：API 请求失败";
  elements.note.textContent = "失败段落会保留韩文，再点小说球只补翻缺失内容。";
  runtime.updateNovelProgressPanel();
  // updateNovelProgressPanel 的桩只改 note，这里验的是「没命中映射就不动」
  assert.equal(elements.phase.textContent, "诊断：API 请求失败");
});

test("面板元素还没建好时不会抛错", () => {
  const runtime = { state: {}, setNovelTextStatus: () => {}, updateNovelProgressPanel: () => {} };
  installMobileProgressLabels(runtime);
  runtime.setNovelTextStatus("working", {});
  runtime.updateNovelProgressPanel();
});
