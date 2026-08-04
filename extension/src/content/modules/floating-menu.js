const MENU_GAP_PX = 6;
const LONG_PRESS_MS = 520;

export function installFloatingMenu(runtime) {
  let open = false;
  let longPressTimer = 0;

  function closeFloatingMenu() {
    const menu = runtime.state.floatingMenu;
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
    runtime.state.floatingMenuOpen = false;
    open = false;
  }
  runtime.closeFloatingMenu = closeFloatingMenu;

  function isFloatingMenuOpen() {
    return open;
  }
  runtime.isFloatingMenuOpen = isFloatingMenuOpen;

  function createMenuItem(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mt-floating-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    if (item.disabled) {
      button.disabled = true;
      button.title = item.disabledReason || item.label;
    }
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled || !item.onSelect) return;
      closeFloatingMenu();
      item.onSelect();
    });
    return button;
  }

  function openFloatingMenu(anchorRect, items, options = {}) {
    const state = runtime.state;
    closeFloatingMenu();
    if (!state.floatingBallWrap?.isConnected || !Array.isArray(items) || !items.length) return;
    const menu = document.createElement("div");
    menu.className = "mt-floating-menu";
    menu.dataset.mangaTranslatorOverlay = "true";
    menu.setAttribute("role", "menu");
    for (const item of items) menu.appendChild(createMenuItem(item));
    document.documentElement.appendChild(menu);
    state.floatingMenu = menu;
    state.floatingMenuOpen = true;
    open = true;

    const rect = anchorRect || state.floatingBallWrap.getBoundingClientRect();
    const margin = 8;
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const side = state.floatingSide === "left" ? "left" : "right";
    const left = side === "right" ? Math.max(margin, rect.left - width - MENU_GAP_PX) : Math.min(window.innerWidth - width - margin, rect.right + MENU_GAP_PX);
    const top = Math.min(Math.max(margin, rect.top), Math.max(margin, window.innerHeight - height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";
    const dismiss = event => {
      if (event && (event.type === "pointerdown" || event.type === "mousedown")) {
        if (menu.contains(event.target)) return;
      }
      cleanup();
    };
    const onKeyDown = event => {
      if (event.key === "Escape") cleanup();
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (open && !menu.matches(":focus-within")) cleanup();
      }, 0);
    };
    const cleanup = () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", cleanup);
      menu.removeEventListener("blur", onBlur);
      closeFloatingMenu();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", cleanup, { passive: true });
    menu.addEventListener("blur", onBlur);
  }
  runtime.openFloatingMenu = openFloatingMenu;

  function cancelBallLongPress() {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }
  runtime.cancelFloatingLongPress = cancelBallLongPress;

  function bindBallContextMenu(ball, getContext) {
    if (!ball) return;
    let startPosition = null;
    let longPressFired = false;
    const openContext = event => {
      if (runtime.state.invalidated) return;
      runtime.stopExtensionUiEvent(event);
      const items = getContext();
      if (items && items.length) {
        const anchor = event.clientX > 0 || event.clientY > 0
          ? { left: event.clientX, top: event.clientY, right: event.clientX, width: 0, height: 0 }
          : null;
        openFloatingMenu(anchor, items, { source: "ball" });
      }
    };
    ball.addEventListener("contextmenu", event => {
      cancelBallLongPress();
      openContext(event);
    });
    ball.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      startPosition = { x: event.clientX, y: event.clientY };
      longPressFired = false;
      cancelBallLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        if (!startPosition) return;
        longPressFired = true;
        openContext(event);
      }, LONG_PRESS_MS);
    });
    const cancel = event => {
      if (event && startPosition && Math.hypot(event.clientX - startPosition.x, event.clientY - startPosition.y) > 7) {
        cancelBallLongPress();
      }
      if (event && event.type === "pointerup" && longPressFired) {
        runtime.state.suppressFloatingClickUntil = Date.now() + 450;
      }
    };
    ball.addEventListener("pointermove", cancel, true);
    ball.addEventListener("pointerup", cancel, true);
    ball.addEventListener("pointercancel", cancel, true);
  }
  runtime.bindBallContextMenu = bindBallContextMenu;
}
