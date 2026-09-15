import assert from "node:assert/strict";
import test from "node:test";
import { installFloatingFeedback } from "../extension/src/content/modules/floating-feedback.js";

/** 极简 DOM 元素替身：只实现 floating-feedback.js 用到的能力。 */
function makeElement(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const element = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    hidden: false,
    textContent: "",
    dataset: {},
    isConnected: true,
    children: [],
    focused: false,
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/u).filter(Boolean).forEach(name => classes.add(name));
    },
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name)
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach(handler => handler(event));
    },
    appendChild(child) {
      element.children.push(child);
      child.parentElement = element;
      return child;
    },
    append(...kids) {
      kids.forEach(kid => element.appendChild(kid));
    },
    querySelector() {
      return null;
    },
    getAttribute() {
      return null;
    },
    setAttribute() {},
    focus() {
      element.focused = true;
    },
    scrollIntoView() {
      element.scrollCalls = (element.scrollCalls || 0) + 1;
    },
    contains() {
      return false;
    },
    remove() {}
  };
  return element;
}

function setup() {
  const feedback = makeElement("div");
  const documentElement = makeElement("html");
  const created = [];
  const runtime = { state: { floatingBallFeedback: feedback } };
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: id => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.document = {
    createElement: tag => {
      const element = makeElement(tag);
      created.push(element);
      return element;
    },
    documentElement,
    activeElement: null
  };
  installFloatingFeedback(runtime);
  // 生产环境由 controls-ui.createFloatingBall 调用 bindFloatingFeedbackBehavior，
  // 测试必须走同一装配，否则悬停/点击行为不会生效。
  runtime.bindFloatingFeedbackBehavior(feedback);
  return {
    runtime,
    feedback,
    documentElement,
    created,
    show: (message, level) => runtime.showFloatingBallFeedback(message, level)
  };
}

test("success 提示在 2.5s 后进入淡出并在 3.2s 内消失", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { feedback, show } = setup();
  try {
    show("翻译完成：8/10 张", "success");
    assert.equal(feedback.hidden, false);
    assert.equal(feedback.className.includes("mt-success"), true);
    t.mock.timers.tick(2500);
    assert.equal(feedback.classList.contains("mt-fading"), true, "2.5s 应开始淡出而不是瞬间消失");
    assert.equal(feedback.hidden, false);
    t.mock.timers.tick(700);
    assert.equal(feedback.hidden, true, "淡出结束后才置 hidden");
  } finally {
    t.mock.timers.reset();
  }
});

test("错误提示改走弹窗且不会自动消失", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { feedback, documentElement, created, show } = setup();
  try {
    show("本地服务未启动，已缓存内容仍显示", "error");
    assert.equal(feedback.hidden, true, "错误不再走淡出浮层");
    // 弹窗由 1 个遮罩根节点 + 卡片 + 头部(标题/关闭钮) + 正文 + 底部(关闭钮) 共 8 个元素组成。
    assert.equal(created.length, 8, "应懒创建错误弹窗");
    const root = documentElement.children.at(-1);
    assert.equal(root.className, "mt-error-dialog-root");
    assert.equal(root.hidden, false);
    assert.equal(root.children[0].children[1].textContent, "本地服务未启动，已缓存内容仍显示");
    t.mock.timers.tick(7000);
    assert.equal(root.hidden, false, "错误弹窗不自动消失，必须由用户确认");
  } finally {
    t.mock.timers.reset();
  }
});

test("同一文案重复写入会重置倒计时", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { feedback, show } = setup();
  try {
    show("翻译完成", "success");
    t.mock.timers.tick(2000);
    show("翻译完成", "success");
    t.mock.timers.tick(2000);
    assert.equal(feedback.hidden, false, "第二次写入应重新计时");
    t.mock.timers.tick(600);
    assert.equal(feedback.classList.contains("mt-fading"), true, "到点后先进入淡出");
    t.mock.timers.tick(400);
    assert.equal(feedback.hidden, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("悬停暂停倒计时，移开后从剩余时间继续", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { feedback, show } = setup();
  try {
    show("翻译完成", "success");
    t.mock.timers.tick(1000);
    feedback.dispatch("mouseenter");
    t.mock.timers.tick(10000);
    assert.equal(feedback.hidden, false, "悬停期间绝不淡出");
    feedback.dispatch("mouseleave");
    t.mock.timers.tick(1400);
    assert.equal(feedback.hidden, false, "剩余 1.5s 未到不应消失");
    t.mock.timers.tick(500);
    // Node 22 MockTimers 不在同一 tick 内执行级联定时器，且淡出兜底以 tick 末时刻为基准，
    // 因此补一个独立 tick(500) 让 resume+1800ms 内的隐藏落地，各 Node 版本下行为一致。
    t.mock.timers.tick(500);
    assert.equal(feedback.hidden, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("点击浮层立即进入淡出并在 0.5s 内消失", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { feedback, show } = setup();
  try {
    show("翻译完成", "success");
    feedback.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    assert.equal(feedback.classList.contains("mt-fading"), true);
    t.mock.timers.tick(500);
    assert.equal(feedback.hidden, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("clearFloatingBallFeedback 之后不再有悬挂计时器", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { runtime, feedback, show } = setup();
  try {
    show("翻译完成", "success");
    runtime.clearFloatingBallFeedback();
    assert.equal(feedback.hidden, true);
    t.mock.timers.tick(10000);
    assert.equal(feedback.hidden, true, "10s 内状态不得再变化");
  } finally {
    t.mock.timers.reset();
  }
});

test("hideFloatingBallFeedback 同时收起错误弹窗", () => {
  const { runtime, feedback, documentElement, show } = setup();
  show("翻译失败：超时", "error");
  const root = documentElement.children.at(-1);
  assert.equal(root.hidden, false);
  runtime.hideFloatingBallFeedback();
  assert.equal(root.hidden, true);
  assert.equal(feedback.hidden, true);
});

test("空文案同时清除浮层与错误弹窗", () => {
  const { feedback, documentElement, show } = setup();
  show("翻译失败：超时", "error");
  const root = documentElement.children.at(-1);
  assert.equal(root.hidden, false);
  show("", "info");
  assert.equal(feedback.hidden, true);
  assert.equal(root.hidden, true);
});
