/**
 * 手机版术语库覆盖层。
 *
 * 术语库本身的增删改查早就是「先写 chrome.storage、服务端同步只是尽力而为」，
 * 所以本地管理不需要重写业务逻辑；这里只修掉四处「本来指望本地服务」的地方：
 *   1. 术语页加载先打服务端（手机上要白等超时，还会误报「本地服务离线」）；
 *   2. 「清空全部」是纯服务端实现，没有本地回落 —— 必须重新实现；
 *   3. best-effort 同步失败会弹「删除失败 / 服务端未同步」这类假警报；
 *   4. SQLite 数据库导入是服务端专有功能；
 *   5. 同步目标地址若留着桌面的局域网 IP，每次改库/改网址都要等网络超时（看起来就是
 *      「点了一键加入应用没生效」）—— 统一指向被拦截的回环地址，瞬间失败；
 *   6. 「一键加入应用」会把章节级绑定地址复制成应用范围，等于把术语库锁死在那一章
 *      （见 apply-url-widen.js）—— 点下去之前先把章节地址放宽成作品地址。
 */
import { injectNovelMobileStyles } from "./styles.js";
import { blockLocalServiceFetch } from "./no-local-service.js";
import { installApplyUrlWidening } from "./apply-url-widen.js";

const LOCAL_MODE_HINT = "本地模式：术语只保存在本机";
const DB_IMPORT_UNSUPPORTED = "手机版不支持导入 SQLite 数据库文件，请用 JSON 或 CSV";
// 手机上没有本地服务，但 OCR 配置里可能还留着桌面的地址（局域网 IP）。
// 术语页里所有「尽力同步服务端」的调用都先问 resolveServerBaseUrl，再去 fetch 那个地址；
// 局域网 IP 不在 blockLocalServiceFetch 的拦截名单里（那里只拦回环），于是每次改名/改绑定网址/
// 点「一键加入应用」都要等一次网络超时 —— 这段时间页面不更新，表现就是「点了没生效」。
// 统一指向被拦截的回环地址：同步调用瞬间失败，本地保存（写在 push 之前）立刻收尾。
const NO_LOCAL_SERVICE_URL = "http://127.0.0.1:1";

/** 只保留 JSON / CSV 导入（.db 走服务端，手机版没有）。 */
function trimImportAccept(doc = globalThis.document) {
  const input = doc.getElementById("fileInput");
  if (input) input.accept = ".json,.csv";
}

/** 「导入文件格式」里那条 SQLite（.db）说明也要去掉，否则等于在推荐一个已被禁用的入口。 */
function hideDbImportHelp(doc = globalThis.document) {
  for (const node of doc.querySelectorAll(".import-format li")) {
    if (String(node.textContent || "").includes("SQLite")) node.style.display = "none";
  }
}

/** 「清空全部」的本地实现：清条目、保留术语库定义与绑定网址。 */
function installLocalClear(runtime) {
  runtime.clearGlossary = async () => {
    const scope = runtime.activeScope();
    if (!scope.entries.length) return;
    const clearBtn = runtime.clearBtn;
    if (scope.library) {
      const message = `确定清空术语库「${scope.library.name}」里的 ${scope.entries.length} 条术语吗？术语库本身会保留。`;
      if (!confirm(message)) return;
      if (clearBtn) clearBtn.disabled = true;
      try {
        await runtime.persistEntries(
          runtime.glossary.entries.filter(entry => entry.libraryId !== scope.library.id),
          `已清空「${scope.library.name}」的 ${scope.entries.length} 条术语`
        );
      } finally {
        if (clearBtn) clearBtn.disabled = false;
      }
      return;
    }
    const total = scope.entries.length;
    const message = `确定清空全部 ${total} 条术语吗？术语库定义（名称与绑定网址）会保留。`;
    if (!confirm(message)) return;
    if (clearBtn) clearBtn.disabled = true;
    try {
      runtime.glossary.entries = [];
      runtime.glossary.revision = (Number(runtime.glossary.revision) || 0) + 1;
      runtime.glossary.updatedAt = Date.now();
      await runtime.storageSet({ [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary });
      runtime.renderGlossary();
      runtime.renderLibraryPanel();
      runtime.setStatus(`已清空 ${total} 条术语（${runtime.glossary.libraries.length} 个术语库保留）`, false);
    } finally {
      if (clearBtn) clearBtn.disabled = false;
    }
  };
}

/** 手机版：任何指向本地服务的同步调用都瞬间失败，别让页面卡在网络超时上。 */
function installServerBaseUrlGuard(runtime) {
  runtime.resolveServerBaseUrl = async () => NO_LOCAL_SERVICE_URL;
}

/** 术语库的增删改会尽力同步服务端；失败时的提示在本地模式下没有意义，这里改写掉。 */
function installLibrarySyncMessageFix(runtime) {
  const saveLibrary = runtime.saveLibrary;
  if (typeof saveLibrary === "function") {
    runtime.saveLibrary = async input => {
      const result = await saveLibrary(input);
      if (result && result.ok === true && result.serverSynced === false) {
        const name = String(result.library && result.library.name || "");
        runtime.setLibraryStatus?.(name ? `已保存术语库「${name}」（本机）` : "已保存（本机）", false);
        return { ...result, serverSynced: true, localOnly: true };
      }
      return result;
    };
  }
  const setLibraryEnabled = runtime.setLibraryEnabled;
  if (typeof setLibraryEnabled === "function") {
    runtime.setLibraryEnabled = async (libraryId, enabled) => {
      const result = await setLibraryEnabled(libraryId, enabled);
      if (result && result.ok === true && result.serverSynced === false) {
        const library = result.library || {};
        const on = library.enabled !== false;
        runtime.setLibraryStatus?.(
          `「${String(library.name || "")}」已${on ? "启用" : "停用"}${on ? "" : "（该库术语不再参与翻译）"}`, false
        );
        return { ...result, serverSynced: true, localOnly: true };
      }
      return result;
    };
  }
}

/** 提取器状态文案：桌面版引擎名是 ollama/heuristic，手机版是直连 LLM，叫「AI」更准确。 */
function installExtractorStatusLabel(runtime) {
  const renderPendingState = runtime.renderPendingState;
  if (typeof renderPendingState !== "function") return;
  runtime.renderPendingState = response => {
    renderPendingState(response);
    const node = runtime.extractorStatus;
    const text = String(node && node.textContent || "");
    if (text.includes("术语提取器：提取器")) {
      node.textContent = text.replace("术语提取器：提取器", "术语提取器：AI ");
    }
  };
}

export function applyGlossaryLocal(runtime) {
  injectNovelMobileStyles();
  blockLocalServiceFetch();
  trimImportAccept();
  hideDbImportHelp();

  // 术语页只读 browser 里那一份；原函数在 source="storage" 时本来就不碰服务端。
  const loadGlossary = runtime.loadGlossary;
  runtime.loadGlossary = async () => {
    const result = await loadGlossary("storage");
    const statusText = runtime.statusText;
    if (statusText && !String(statusText.textContent || "").trim()) {
      runtime.setStatus?.(LOCAL_MODE_HINT, false);
    }
    return result;
  };
  runtime.loadGlossaryFromServer = async () => ({ ok: false, error: "local-only" });

  // 服务端镜像：本地模式下已经是权威数据，直接报成功，避免 persistEntries 里的
  // failedDeletes 统计出「术语删除失败…刷新后会重新出现」这种不存在的失败。
  const localAck = async () => ({ ok: true, local: true });
  runtime.saveEntryToServer = localAck;
  runtime.deleteEntryFromServer = localAck;
  runtime.pushLibraryToServer = localAck;
  runtime.deleteLibraryOnServer = localAck;

  installLocalClear(runtime);
  installServerBaseUrlGuard(runtime);
  installApplyUrlWidening(runtime);
  installLibrarySyncMessageFix(runtime);
  installExtractorStatusLabel(runtime);

  runtime.importDbFileToServer = async () => ({ ok: false, error: DB_IMPORT_UNSUPPORTED });
  runtime.importGlossaryDbFile = async () => {
    runtime.setStatus?.(DB_IMPORT_UNSUPPORTED, true);
  };
}
