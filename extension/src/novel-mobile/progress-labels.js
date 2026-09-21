/**
 * 手机版进度面板文案。
 *
 * 面板的静态文案来自 novel-progress-panel.js，里面把这条按块翻译的通道叫「精翻」，
 * 还写着「正文按章节顺序精翻；当前页尚未轮到时会暂时保留韩文」——那是桌面版串行流
 * 水线的说法。手机版是并发小批（novel-batch.js），没有「轮到」这回事，也没有任何
 * 二次润色，这句话会把人误导成「还有个精修阶段」。
 *
 * novel-progress-panel.js 的 updateNovelProgressPanel 用的是模块内局部函数
 * buildNovelProgressView，没法靠覆盖 runtime.buildNovelProgressView 改到，所以这里
 * 在「渲染完之后」按原文替换文本节点——只在命中桌面版原句时才替换，上游改文案也不会
 * 被误伤。
 */
const DESKTOP_TO_MOBILE = Object.freeze([
  ["小说精翻进行中", "小说翻译中"],
  ["正在准备正文精翻…", "正在准备正文翻译…"],
  [
    "为保持上下文一致，正文按章节顺序精翻；当前页尚未轮到时会暂时保留韩文。",
    "正文按块并发翻译；还没出译文的段落会暂时保留韩文。"
  ],
  ["译文会按章节顺序逐段显示，图片任务在后台独立处理。", "译文会按块陆续显示。"]
]);

const TEXT_KEYS = Object.freeze(["title", "phase", "note"]);

function toMobileWording(value) {
  let text = String(value || "");
  for (const [from, to] of DESKTOP_TO_MOBILE) {
    text = text.replace(from, to);
  }
  return text;
}

function patchProgressPanel(runtime) {
  const elements = runtime.state && runtime.state.novelProgressElements;
  if (!elements) return;
  for (const key of TEXT_KEYS) {
    const node = elements[key];
    if (!node) continue;
    const next = toMobileWording(node.textContent);
    if (next !== node.textContent) node.textContent = next;
  }
  // 手机版不处理正文插图（没有 OCR 服务），「图片 0/0」那一行只会是噪声。
  if (elements.imageRow && elements.imageRow.row) elements.imageRow.row.hidden = true;
}

export function installMobileProgressLabels(runtime) {
  // setNovelTextStatus / setNovelImageStatus 内部调的是各自的局部 updateNovelProgressPanel，
  // 所以这两个入口必须一起包：只包 updateNovelProgressPanel 会漏掉主力路径。
  for (const name of ["setNovelTextStatus", "setNovelImageStatus"]) {
    const original = runtime[name];
    if (typeof original !== "function") continue;
    runtime[name] = (...args) => {
      const result = original(...args);
      patchProgressPanel(runtime);
      return result;
    };
  }
  const update = runtime.updateNovelProgressPanel;
  if (typeof update === "function") {
    runtime.updateNovelProgressPanel = (...args) => {
      const result = update(...args);
      patchProgressPanel(runtime);
      return result;
    };
  }
}
