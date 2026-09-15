/**
 * 点原文 → 打开/联动 Chrome 侧边栏「章节译文修订面板」，并定位到该段落。
 *
 * 监听挂在 document 捕获阶段且只读（不 preventDefault / 不 stopPropagation），
 * 因此不会影响 Kakao 阅读器自身的 tap 行为与文字选择。小说正文位于 shadow root
 * 内，document 级事件里 `event.target` 会被重定向到宿主元素，必须用
 * `event.composedPath()` 穿透才能拿到真正被点到的段落节点。
 *
 * 触发护栏（B-P0-1）必须全部满足，任一不满足就什么都不做——不打开、不滚动、
 * 不高亮、也不弹任何提示：
 *   1. 当前处于「显示译文」状态（用户已确认：显示原文时不触发）
 *   2. 被点段落已有译文
 *   3. 主键单击，且不带 Ctrl / Cmd / Shift / Alt
 *   4. 没有文本选区
 *   5. pointerdown → click 位移 ≤ 6px（不是拖动 / 划选）
 *   6. 命中 [data-p-id] 段落节点
 */
const MT_FOCUS_TAP_MOVE_PX = 6;

export function installNovelFocusClick(runtime) {
  if (!runtime.IS_KAKAOPAGE_READER) return;

  let pointerDown = null;

  /** 从 composedPath 里找最内层的 [data-p-id] 段落节点（穿透 shadow DOM）。 */
  function paragraphNodeFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node.getAttribute && node.getAttribute("data-p-id") != null) return node;
    }
    return null;
  }

  /**
   * 护栏纯函数：返回 { ok, reason }，便于逐条构造反例做单测。
   * `paragraphNode` 为 null 表示没点在段落上（护栏 6 不满足）。
   */
  function passesGuards(event, { paragraphNode } = {}) {
    const novelState = runtime.getNovelState?.();
    if (!novelState) return { ok: false, reason: "no-state" };
    if (!novelState.showTranslation) return { ok: false, reason: "showing-original" };
    if (!paragraphNode) return { ok: false, reason: "no-paragraph" };
    if (Number(event?.button) !== 0) return { ok: false, reason: "not-primary" };
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return { ok: false, reason: "modifier-key" };
    }
    const selection = typeof globalThis.window?.getSelection === "function" ? globalThis.window.getSelection() : null;
    if (selection && selection.isCollapsed === false) return { ok: false, reason: "text-selected" };
    if (pointerDown) {
      const moved = Math.hypot(
        (Number(event.clientX) || 0) - (Number(pointerDown.x) || 0),
        (Number(event.clientY) || 0) - (Number(pointerDown.y) || 0)
      );
      if (moved > MT_FOCUS_TAP_MOVE_PX) return { ok: false, reason: "drag" };
    }
    return { ok: true, reason: "" };
  }

  function onPointerDown(event) {
    if (Number(event?.button) !== 0) {
      pointerDown = null;
      return;
    }
    pointerDown = {
      x: Number(event?.clientX) || 0,
      y: Number(event?.clientY) || 0,
      button: Number(event?.button) || 0
    };
  }

  function onClick(event) {
    const paragraphNode = paragraphNodeFromEvent(event);
    if (!passesGuards(event, { paragraphNode }).ok) return;
    const novelState = runtime.getNovelState?.();
    const surface = novelState?.surface || runtime.findKakaoNovelSurface?.();
    if (!surface) return;
    // 正向映射复用章节提取结果,绝不按 DOM 顺序自行推算序号。
    const itemId = runtime.findParagraphIdForNode?.(surface, paragraphNode);
    if (!itemId) return;
    if (!novelState.translations?.has?.(itemId)) return;
    runtime.sendRuntimeMessage?.({ type: "OPEN_NOVEL_SIDEPANEL", itemId })?.catch?.(() => {});
  }

  // 捕获阶段 + 只读监听。安装期就挂载，因此必须容忍缺失的全局
  // （测试桩可能没有 document/window 的完整 API），用可选调用而不是裸引用。
  globalThis.document?.addEventListener?.("pointerdown", onPointerDown, true);
  globalThis.document?.addEventListener?.("click", onClick, true);

  // 测试与诊断入口（只读暴露，不参与业务流程）。
  runtime.findNovelFocusParagraphNode = paragraphNodeFromEvent;
  runtime.passesNovelFocusGuards = passesGuards;
}
