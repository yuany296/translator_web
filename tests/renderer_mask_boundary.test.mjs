// renderer-mask.js maskCssValue 的边界补测。主套件（ridi_rendering_parity.test.mjs）
// 聚焦正常路径、写入点口径与死循环消灭；本文件集中收纳边界与降级路径：
//   1) 异常输入（undefined/null/超长非 base64 dataURL）必须安全降级为空串，不抛错；
//   2) 转换失败（atob 失败 / URL.createObjectURL 缺失）走「宁可原样」兜底，且兜底
//      结果不得写入缓存（否则失败会被永久缓存，恢复后也回不到真转换）；
//   3) 同一覆盖层连续换两张不同的长图：sync 校准必须把 DOM 变量换到新句柄，
//      换回旧图时命中缓存复用原句柄，不同 dataURL 不得互串缓存；
//   4) LRU「命中触碰最新端」语义：插入顺序淘汰之外，访问顺序也必须正确；
//   5) blob:URL 被 LRU 淘汰 revoke 后，rAF 校准循环必须能用新句柄自愈——这是
//      「缓存有上限」与「遮罩不能永久丢」两件事同时成立的唯一机制；
//   6) 安全阈值常量不得越过 Chromium ~2MB 实测静默上限。
// 注：本文件与主套件共同构成遮罩修复的回归防线；单文件行数受
// scripts/check-file-lengths.mjs 门槛约束，边界用例放在独立文件里正是为了
// 不把主套件顶破 tests ≤ 800 的上限。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installLifecyclePosition } from "../extension/src/content/modules/lifecycle-position.js";
import { installRendererMask } from "../extension/src/content/modules/renderer-mask.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

/** 构造超阈值的长 dataURL（base64 全 "A"、长度 %4==0 可被 atob 解码；index 用来区分条目）。 */
function makeLongDataUrl(index) {
  return `data:image/png;base64,${"A".repeat(1500000 + index * 4)}`;
}

/** 注入 URL.createObjectURL / revokeObjectURL stub，返回调用计数与还原函数。 */
function installBlobUrlStubs() {
  const created = [];
  const revoked = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    created.push(true);
    return `blob:mt-stub-${created.length}`;
  };
  URL.revokeObjectURL = url => {
    revoked.push(url);
  };
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  };
}

/** 只带生产同款 isDataUrl 判定的最小 runtime；每个用例独立缓存，互不污染。 */
function makeMaskRuntime() {
  const runtime = { isDataUrl: value => /^data:[^;]+;base64,/iu.test(String(value || "")) };
  installRendererMask(runtime);
  return runtime;
}

/** 带可观测 CSS 变量表的假 root；querySelector 需要存在，installLifecyclePosition 装上的
 * syncLoadingOverlayCardPosition 真身会用它找 loading 卡片（找不到即早退）。 */
function makeStyleTarget() {
  const element = {
    tagName: "DIV",
    isConnected: true,
    dataset: {},
    parentElement: null,
    props: new Map(),
    querySelector: () => null
  };
  element.style = {
    setProperty: (name, value) => element.props.set(name, value),
    getPropertyValue: name => element.props.get(name) || "",
    removeProperty: name => element.props.delete(name)
  };
  return element;
}

test("maskCssValue：undefined/null 与超长非 base64 dataURL 一律安全降级为空串", () => {
  const { maskCssValue } = makeMaskRuntime();
  // 非字符串输入：String(dataUrl || "") 归一为空串，绝不抛错、不写任何变量。
  assert.equal(maskCssValue(undefined), "");
  assert.equal(maskCssValue(null), "");
  // 超长但缺 ;base64, 标记的 dataURL：isDataUrl 判定不通过 → 空串。
  // 不得尝试转换（避免 decodeURIComponent 对巨串做无谓功），更不能原样拼进行内样式。
  const longSvg = `data:image/svg+xml,${"x".repeat(1600000)}`;
  assert.equal(maskCssValue(longSvg), "");
});

test("maskCssValue：转换失败走兜底原样返回，且兜底结果不得写入缓存", () => {
  // atob 解不出合法 base64 → dataUrlToObjectUrl 返回空串 → 兜底 url("原始dataURL")。
  const brokenRuntime = makeMaskRuntime();
  const broken = `data:image/png;base64,${"!".repeat(16)}`;
  assert.equal(brokenRuntime.maskCssValue(broken), `url("${broken}")`,
    "atob 失败必须兜底原样返回，绝不抛错");

  // URL.createObjectURL 缺失（极旧内核/非浏览器宿主）→ 同样兜底，不抛错；
  // 且兜底路径不得写缓存：换回计数 stub 后，同一 dataURL 必须走真正的转换。
  const realCreateObjectUrl = URL.createObjectURL;
  try {
    const runtime = makeMaskRuntime();
    const LONG = makeLongDataUrl(9000);
    URL.createObjectURL = undefined;
    assert.equal(runtime.maskCssValue(LONG), `url("${LONG}")`,
      "createObjectURL 缺失时兜底原样返回");
    // 换上计数 stub（先不还原真身：真身在 Node 里也能生成 blob:nodedata: 句柄，
    // 只有计数 stub 才能断言「这次确实重新转换了」）。
    let createdCount = 0;
    URL.createObjectURL = () => {
      createdCount += 1;
      return `blob:mt-stub-${createdCount}`;
    };
    assert.match(runtime.maskCssValue(LONG), /^url\("blob:mt-stub-1"\)$/u,
      "兜底结果不得写入缓存：恢复转换能力后同一 dataURL 必须能走真正的转换");
    assert.equal(createdCount, 1, "必须恰好重新转换一次");
  } finally {
    URL.createObjectURL = realCreateObjectUrl;
  }
});

test("同一覆盖层连续换两张不同的长图：sync 校准换到新句柄，换回时命中缓存", () => {
  // 注意：installLifecyclePosition 会把 syncLoadingOverlayCardPosition 的真身装进
  // runtime（覆盖任何预置 stub），所以假 root 必须带 querySelector。
  const runtime = {
    isDataUrl: value => /^data:[^;]+;base64,/iu.test(String(value || "")),
    getQuickSourceToken: () => "src",
    getOverlayDisplayRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    getVisibleViewportRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    isRectVisible: () => true,
    ensureOverlayLayer: () => null,
    getOverlayPositionRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    compareOverlayViewportRects: previous => previous
      ? { positionChanged: false, sizeChanged: false }
      : { positionChanged: true, sizeChanged: true }
  };
  runtime.state = { overlaysById: new Map() };
  installLifecyclePosition(runtime);
  installRendererMask(runtime);

  const root = makeStyleTarget();
  const overlayState = {
    targetId: 9,
    target: { isConnected: true },
    root,
    sourceToken: "src",
    bubbleNodes: [],
    cleanedImage: "",
    lastViewportRect: null
  };
  runtime.state.overlaysById.set(9, overlayState);

  // 换上计数 stub 再驱动 sync：句柄编号与创建次数才可精确断言。
  const realCreateObjectUrl = URL.createObjectURL;
  const created = [];
  const revoked = [];
  try {
    URL.createObjectURL = () => {
      created.push(true);
      return `blob:mt-stub-${created.length}`;
    };
    URL.revokeObjectURL = url => {
      revoked.push(url);
    };

    const LONG_A = makeLongDataUrl(2001);
    const LONG_B = makeLongDataUrl(2002);
    overlayState.cleanedImage = LONG_A;
    runtime.syncOverlayPosition(overlayState);
    assert.equal(root.props.get("--mt-cleaned-image"), 'url("blob:mt-stub-1")',
      "第一张长图转成 blob:URL 写入行内样式");

    // 分片换版（新 imageRevision）→ 同一根上的清理图换成第二张长图：
    // sync 必须把 DOM 变量换到新句柄，不能停留在旧图。
    overlayState.cleanedImage = LONG_B;
    runtime.syncOverlayPosition(overlayState);
    assert.equal(root.props.get("--mt-cleaned-image"), 'url("blob:mt-stub-2")',
      "换成第二张长图后 sync 必须把 DOM 变量换到新句柄");
    assert.equal(created.length, 2, "两张图各转换一次：不同 dataURL 不得命中同一缓存");
    assert.equal(revoked.length, 0, "未超 LRU 上限不得回收任何句柄");

    // 换回第一张（用户往回滚）：缓存仍持有它的句柄，必须复用而不是新建。
    overlayState.cleanedImage = LONG_A;
    runtime.syncOverlayPosition(overlayState);
    assert.equal(root.props.get("--mt-cleaned-image"), 'url("blob:mt-stub-1")',
      "换回第一张时复用缓存里的同一句柄");
    assert.equal(created.length, 2, "换回不得新建句柄");
    assert.equal(revoked.length, 0);
  } finally {
    URL.createObjectURL = realCreateObjectUrl;
  }
});

/* ---------------------------------------------------------------------------
 * 以下三组用例迁自 ridi_rendering_parity.test.mjs（原 22:40 追加块，断言原样
 * 保留）：那次追加把主套件顶到 848 行、打爆 tests ≤ 800 的长度门槛，由 QA
 * 迁移到本文件以恢复门槛。makeElement → makeStyleTarget、cssProps → props 为
 * 唯一的 helper 适配，断言逻辑零改动。
 * ------------------------------------------------------------------------- */

test("maskCssValue 边界：undefined/null/非 base64 超长/坏 base64 全部安全降级不抛错", () => {
  const stubs = installBlobUrlStubs();
  try {
    const { maskCssValue } = makeMaskRuntime();
    assert.equal(maskCssValue(undefined), "");
    assert.equal(maskCssValue(null), "");
    assert.equal(maskCssValue(0), "");
    // 超长但非 base64 的 dataURL：isDataUrl 判否 → 空串，绝不把超长值原样写进样式。
    assert.equal(maskCssValue(`data:image/png,${"x".repeat(1600000)}`), "");
    // 合法前缀但 base64 体损坏：atob 抛错 → 兜底原样 url(...)，且不创建任何 Object URL。
    const broken = `data:image/png;base64,${"!".repeat(1500004)}`;
    assert.equal(maskCssValue(broken), `url("${broken}")`,
      "解码失败必须兜底回原样（宁可写不进样式，也不能抛错中断渲染）");
    assert.equal(stubs.created.length, 0, "解码失败不得创建 Object URL");
    // 失败结果不进缓存：再次调用重试转换，不留下指向空串的永久坏条目。
    assert.equal(maskCssValue(broken), `url("${broken}")`);
    assert.equal(stubs.created.length, 0);
    // 安全阈值不得越过 Chromium ~2MB 的实测静默上限：常量一旦调大，
    // 短路径会把必然静默失败的超长 dataURL 原样写进行内样式（原始 Bug 复活）。
    const maskSource = fs.readFileSync(
      path.join(projectRoot, "extension", "src", "content", "modules", "renderer-mask.js"), "utf8");
    const limit = Number(maskSource.match(/MASK_INLINE_STYLE_SAFE_LIMIT = (\d+)/u)?.[1] || 0);
    assert.ok(limit > 0 && limit <= 2000000,
      `MASK_INLINE_STYLE_SAFE_LIMIT=${limit} 必须留在 0 < limit ≤ 2,000,000 的安全区间`);
  } finally {
    stubs.restore();
  }
});

test("maskCssValue：同一 target 在两张长图间来回切换，LRU 触碰决定谁先被淘汰", () => {
  const stubs = installBlobUrlStubs();
  try {
    const { maskCssValue } = makeMaskRuntime();
    const A = makeLongDataUrl(2000);
    const B = makeLongDataUrl(3000);
    const a1 = maskCssValue(A);
    const b1 = maskCssValue(B);
    assert.notEqual(a1, b1);
    assert.equal(stubs.created.length, 2);
    // A 命中 → 被触碰挪到最新端（B 成为最旧端）。
    assert.equal(maskCssValue(A), a1, "未淘汰前重复取值必须命中缓存（幂等）");
    // 只塞 15 张新图把缓存顶到 17：被挤出去的是最久未用的 B，而不是命中过的 A。
    for (let i = 4000; i < 4015; i += 1) maskCssValue(makeLongDataUrl(i));
    assert.ok(stubs.revoked.includes("blob:mt-stub-2"), "最久未用的 B 必须先被淘汰并 revoke");
    assert.ok(!stubs.revoked.includes("blob:mt-stub-1"), "刚被命中触碰过的 A 不得被误汰");
    assert.equal(maskCssValue(A), a1, "A 仍在缓存中，必须继续返回同一句柄");
    // B 已被淘汰：回来时重新生成新句柄，绝不复用已 revoke 的死 URL。
    const b2 = maskCssValue(B);
    assert.notEqual(b2, b1, "被淘汰的 B 不得复用已回收的 Object URL");
    assert.match(b2, /^url\("blob:mt-stub-\d+"\)$/u);
  } finally {
    stubs.restore();
  }
});

test("blob:URL 被 LRU 淘汰 revoke 后，下一次 syncOverlayPosition 必须用新句柄自愈", () => {
  // 设计前提：DOM 里残留已 revoke 的死 URL 时，rAF 校准循环每帧取到的
  // maskCssValue 值与 DOM 读回值不等 → 重写新句柄 → 遮罩下一帧自愈。
  // 若这条断言失效（比如把失败/淘汰结果也缓存住），被淘汰的分片会永久丢遮罩。
  const stubs = installBlobUrlStubs();
  try {
    const A = makeLongDataUrl(7000);
    const runtime = {
      isDataUrl: value => /^data:[^;]+;base64,/iu.test(String(value || "")),
      getQuickSourceToken: () => "tok",
      getOverlayDisplayRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      getVisibleViewportRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      isRectVisible: () => true,
      state: { overlaysById: new Map() }
    };
    installRendererMask(runtime);
    installLifecyclePosition(runtime);
    const root = makeStyleTarget();
    const overlayState = {
      targetId: 9,
      target: { isConnected: true },
      root,
      bubbleNodes: [],
      sourceToken: "tok",
      cleanedImage: A,
      lastViewportRect: null
    };
    runtime.state.overlaysById.set(9, overlayState);
    runtime.syncOverlayPosition(overlayState);
    const initial = root.props.get("--mt-cleaned-image");
    assert.equal(initial, 'url("blob:mt-stub-1")');
    // 塞 16 张新图：A（最旧）被挤出并 revoke。
    for (let i = 7100; i < 7116; i += 1) runtime.maskCssValue(makeLongDataUrl(i));
    assert.ok(stubs.revoked.includes("blob:mt-stub-1"), "A 的句柄必须已被淘汰并 revoke");
    // 下一帧校准：生成新句柄 → 与 DOM 读回的死 URL 不等 → 重写自愈。
    runtime.syncOverlayPosition(overlayState);
    const healed = root.props.get("--mt-cleaned-image");
    assert.notEqual(healed, initial, "死 URL 必须被新句柄替换，否则该分片永久丢遮罩");
    assert.match(healed, /^url\("blob:mt-stub-\d+"\)$/u);
    // 再来一帧：新句柄幂等命中，回到零写入（不得陷入新一轮重写循环）。
    const writes = [];
    const originalSetProperty = root.style.setProperty;
    root.style.setProperty = (name, value) => {
      writes.push(name);
      return originalSetProperty(name, value);
    };
    runtime.syncOverlayPosition(overlayState);
    assert.deepEqual(writes, [], "自愈后的下一帧必须回到幂等零写入");
  } finally {
    stubs.restore();
  }
});
