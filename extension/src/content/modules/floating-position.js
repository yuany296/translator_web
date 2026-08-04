const DRAG_THRESHOLD_PX = 7;
const EDGE_GAP_PX = 14;
const COMPACT_BALL_SIZE_PX = 36;
const COMPACT_GROUP_HEIGHT_PX = 116;

/**
 * Drag / edge-snap / position persistence for the floating action group.
 * Click vs drag is separated by a movement threshold; pointer capture starts
 * only after the threshold so button clicks still fire; a drag always
 * suppresses the trailing click on release.
 */
export function installFloatingPosition(runtime) {
  function persistSnappedPosition(wrap) {
    const rect = wrap.getBoundingClientRect();
    const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
    const available = Math.max(1, window.innerHeight - rect.height);
    const yRatio = Math.min(1, Math.max(0, rect.top / available));
    runtime.state.floatingSide = side;
    runtime.state.floatingYRatio = yRatio;
    runtime.applyFloatingPosition();
    void runtime.updateRuntimeConfiguration({ floatingSide: side, floatingYRatio: yRatio });
  }
  runtime.persistSnappedPosition = persistSnappedPosition;

  function applyFloatingPosition() {
    const wrap = runtime.state.floatingBallWrap;
    if (!wrap) return;
    const side = runtime.state.floatingSide === "left" ? "left" : "right";
    const fallbackHeight = wrap.classList.contains("mt-floating-ball-group")
      ? COMPACT_GROUP_HEIGHT_PX
      : COMPACT_BALL_SIZE_PX;
    const available = Math.max(0, window.innerHeight - (wrap.offsetHeight || fallbackHeight));
    const top = Math.round(Math.min(1, Math.max(0, Number(runtime.state.floatingYRatio) || 0)) * available);
    wrap.style.top = `${top}px`;
    wrap.style.bottom = "auto";
    wrap.style.left = side === "left" ? `${EDGE_GAP_PX}px` : "auto";
    wrap.style.right = side === "right" ? `${EDGE_GAP_PX}px` : "auto";
    wrap.dataset.side = side;
    wrap.dataset.progressPlacement = Number.parseFloat(wrap.style.top || "0") < 190 ? "below" : "above";
    runtime.syncNovelImagePanelSide?.();
  }
  runtime.applyFloatingPosition = applyFloatingPosition;

  function bindFloatingGroupDrag(wrap) {
    let drag = null;
    const move = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      // 只有确认是拖动后才捕获指针；按下时捕获会把按钮 click 重定向到父容器。
      wrap.setPointerCapture?.(event.pointerId);
      wrap.classList.add("mt-dragging");
      runtime.cancelFloatingLongPress?.();
      const maxLeft = Math.max(0, window.innerWidth - wrap.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - wrap.offsetHeight);
      wrap.style.left = `${Math.min(maxLeft, Math.max(0, drag.left + dx))}px`;
      wrap.style.right = "auto";
      wrap.style.top = `${Math.min(maxTop, Math.max(0, drag.top + dy))}px`;
      event.preventDefault();
    };
    const end = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      wrap.classList.remove("mt-dragging");
      if (drag.moved) {
        runtime.state.suppressFloatingClickUntil = Date.now() + 450;
        persistSnappedPosition(wrap);
        event.preventDefault();
        event.stopPropagation();
      }
      drag = null;
    };
    wrap.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      event.stopPropagation();
    });
  }
  runtime.bindFloatingGroupDrag = bindFloatingGroupDrag;
}
