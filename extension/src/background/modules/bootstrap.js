export function installBootstrap(runtime) {
  // 控制台助手：`__mtOcrTimings()`、`__mtCacheAudit()`、`__mtTranslationSnapshots()` / `__mtStreamAb()`。
  // 它们都只是只读取证入口，必须在装配完成后显式挂上——installer 里定义函数不会自动暴露到控制台。
  runtime.exposeOcrTimingsConsoleHelper?.();
  runtime.exposeTranslationCacheConsoleHelper?.();
  runtime.exposeTranslationDiagnosticsConsoleHelper?.();
  // 阅读器页面建立 keep-alive 端口,保持 SW 存活,避免 MV3 空闲回收后
  // content script 首条消息失败与弹窗配置加载都要等待冷启动。
  const keepAlivePorts = new Set();
  chrome.runtime.onConnect?.addListener(port => {
    if (port && port.name === "mt-keepalive") {
      keepAlivePorts.add(port);
      port.onDisconnect.addListener(() => keepAlivePorts.delete(port));
      return;
    }
    runtime.handleTranslationStreamPort?.(port);
  });
  try {
    chrome.sidePanel?.setOptions?.({ enabled: true, path: "sidepanel.html" });
  } catch (error) {
    console.warn("[MangaTranslator] sidePanel.setOptions failed:", error);
  }
  chrome.runtime.onInstalled.addListener(async details => {
    try {
      await runtime.ensureDefaultSettings();
      await runtime.pruneExpiredTabStatuses();
      if (details && details.reason === "update") {
        await runtime.reinjectContentScriptsToOpenTabs();
      }
    } catch (error) {
      console.warn("[MangaTranslator] onInstalled init failed:", error);
    }
  });
  /**
   * 侧栏长连接端口注册表。
   *
   * 背景：`chrome.sidePanel.open` 必须在消息处理的同步阶段调用（user activation
   * 约束），而「侧栏是否已开」又不能靠 await 查询。侧栏页面用一条长连接端口向
   * 这里注册，于是「本窗口侧栏是否已开」就变成一次同步内存读取：
   *   已开 → 完全跳过 sidePanel.open（重开会重载页面、丢掉未保存的编辑），只广播定位；
   *   未开 → 正常调用 sidePanel.open。
   *
   * 降级：service worker 被回收导致注册表丢失时，会退化为「再调用一次
   * sidePanel.open」。Chrome 对已打开的面板不会重载，影响可接受。
   * 侧栏页面无法从 port.sender 拿到 windowId（扩展页面没有 sender.tab），
   * 因此由侧栏连上后先发一条 hello 报上自己的 windowId。
   */
  const MT_NOVEL_PANEL_PORT = "mt-manage-panel";
  const novelPanelPorts = new Map();

  chrome.runtime.onConnect?.addListener(port => {
    if (!port || port.name !== MT_NOVEL_PANEL_PORT) return;
    port.onMessage.addListener(message => {
      if (!message || message.type !== "mt-manage-panel-hello") return;
      const key = Number.isInteger(message.windowId) ? message.windowId : 0;
      let bucket = novelPanelPorts.get(key);
      if (!bucket) {
        bucket = new Set();
        novelPanelPorts.set(key, bucket);
      }
      bucket.add(port);
      port.__mtWindowId = key;
    });
    port.onDisconnect.addListener(() => {
      const bucket = novelPanelPorts.get(port.__mtWindowId);
      if (!bucket) return;
      bucket.delete(port);
      if (bucket.size === 0) novelPanelPorts.delete(port.__mtWindowId);
    });
  });

  /** 同步判定：本窗口的章节译文侧栏是否已经打开（读内存注册表，无需 await）。 */
  function isNovelPanelOpen(windowId) {
    const bucket = novelPanelPorts.get(Number.isInteger(windowId) ? windowId : 0);
    return Boolean(bucket && bucket.size > 0);
  }
  runtime.isNovelPanelOpen = isNovelPanelOpen;

  /** 广播定位请求给所有扩展上下文；侧栏按 tabId 过滤后定位。fire-and-forget。 */
  function broadcastNovelFocus(tabId, itemId) {
    try {
      chrome.runtime.sendMessage(
        { type: "FOCUS_NOVEL_REVISION_ITEM", tabId, itemId },
        () => void chrome.runtime.lastError
      );
    } catch {
      // 广播失败不影响打开侧栏；侧栏还有 storage.session 的焦点记录兜底。
    }
  }
  runtime.broadcastNovelFocus = broadcastNovelFocus;

  /**
   * 打开小说章节译文管理界面。
   *
   * 优先尝试 Chrome 侧栏(chrome.sidePanel.open)。content script 点击产生的
   * 用户手势会随消息传播到 service worker,但只在消息处理的同步阶段有效:
   * 一旦先 await 其他操作(如 storage.session.set),手势过期后 sidePanel.open
   * 会被 Chrome 拒绝。因此这里必须在任何 await 之前同步调用 sidePanel.open。
   *
   * 失败时回退为在同一窗口的新标签页打开 sidepanel.html,并把来源标签页
   * 通过 ?tabId= 传给页面,使其仍然指向当前小说章节(侧栏页默认查询活动标签页,
   * 但新标签页打开后自己会成为活动标签页,必须显式指定目标)。
   */
  async function openNovelManageUi(sender, itemId) {
    const windowId = sender && sender.tab && sender.tab.windowId;
    const tabId = sender && sender.tab && sender.tab.id;
    const focusItemId = String(itemId || "").trim();
    // 「侧栏是否已开」必须是同步判定(内存端口注册表),否则 await 之后内容脚本
    // 点击产生的 user activation 会过期,Chrome 会拒绝打开侧栏。
    // 已开 → 完全不调用 sidePanel.open(重开会重载页面、丢掉未保存的编辑),只广播定位。
    const panelAlreadyOpen = runtime.isNovelPanelOpen?.(windowId) === true;
    const openPromise = !panelAlreadyOpen && chrome.sidePanel && chrome.sidePanel.open && Number.isInteger(windowId)
      ? chrome.sidePanel.open({ windowId })
      : null;
    // 把来源标签页记入 session 存储,侧栏打开后据此定位章节,
    // 避免侧栏误用"当前活动标签页"(可能是扩展页面/设置页等)。
    if (Number.isInteger(tabId)) {
      try {
        const updates = { mt_manage_tab: { tabId, windowId, at: Date.now() } };
        // itemId 双路径之一:storage.session(带 TTL,侧栏消费后清除)。
        // 另一路径是下面的运行时广播,覆盖「新加载页面错过广播」的时序。
        if (focusItemId) {
          updates.mt_manage_focus = { tabId, itemId: focusItemId, at: Date.now() };
        }
        await chrome.storage.session.set(updates);
      } catch (error) {
        console.warn("[MangaTranslator] 记录管理标签页失败:", runtime.getErrorMessage(error));
      }
    }
    if (focusItemId && Number.isInteger(tabId)) {
      runtime.broadcastNovelFocus?.(tabId, focusItemId);
    }
    if (openPromise) {
      try {
        await openPromise;
        return { ok: true, mode: "panel" };
      } catch (error) {
        // 非扩展 UI 手势下打开侧栏会被 Chrome 拒绝,转入新标签页回退。
        console.warn("[MangaTranslator] sidePanel.open 失败,回退为新标签页打开:", runtime.getErrorMessage(error));
      }
    }
    if (Number.isInteger(tabId)) {
      try {
        const url = chrome.runtime.getURL("sidepanel.html") + `?tabId=${tabId}`;
        await chrome.tabs.create({ windowId, url, active: true });
        return { ok: true, mode: "tab" };
      } catch (error) {
        return { ok: false, error: runtime.getErrorMessage(error) || "无法打开章节译文管理界面" };
      }
    }
    return { ok: false, error: "找不到来源标签页，无法打开章节译文管理界面" };
  }
  runtime.openNovelManageUi = openNovelManageUi;
  chrome.runtime.onStartup.addListener(async () => {
    try {
      await runtime.pruneExpiredTabStatuses();
    } catch (error) {
      console.warn("[MangaTranslator] onStartup init failed:", error);
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }
    runtime.handleMessage(message, sender).then(payload => sendResponse(payload)).catch(error => {
      const safeMessage = error && error.message ? error.message : "Unknown background error";
      sendResponse({
        ok: false,
        error: safeMessage
      });
    });
    return true;
  });
}
