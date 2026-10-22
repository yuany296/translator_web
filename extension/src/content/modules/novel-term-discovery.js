import novelTermDiscovery from "../../shared/novel-term-discovery.js";

const RETRY_DELAY_MS = 30000;
const MAX_RETRY_ATTEMPTS = 40;
// "partial" = 提取跑了一部分（分段超时/失败）：缺的那些段落没被标记已处理，
// 重发时只会带上它们（见 shared/term-discovery.js#getUnprocessedBlocks）。
const RETRY_REASONS = new Set(["offline", "cooldown", "throttled", "partial"]);
/** 手动点击时的回话：被挡住的每一种原因都要说清，否则用户看到的就是「点了没反应」。 */
const SKIP_FEEDBACK = Object.freeze({
  disabled: "整章术语提取已关闭（设置 → 翻译服务）",
  already_processed: "本章段落都已经提取过",
  cooldown: "提取器刚刚失败过，稍后会自动重试",
  throttled: "同一章 30 秒内只提取一次，稍等再点",
  engine_unconfigured: "设置里选了「AI 配置」但没有可用配置",
  offline: "本地服务没响应，确认它已经启动"
});

export function installNovelTermDiscovery(runtime) {
  function scheduleNovelTermDiscovery(chapter, attempt = 0) {
    if (!chapter || runtime.state.invalidated) {
      return;
    }
    const state = runtime.getNovelState();
    const blocks = novelTermDiscovery.sampleTranslatedParagraphs(chapter, state.translations);
    if (blocks.length === 0) {
      return;
    }
    const message = novelTermDiscovery.buildNovelDiscoveryMessage(chapter, blocks, location.href, document.title);
    const sendKey = `${message.pageUrl}|${message.targetKey}|${runtime.hashSourceIdentity(JSON.stringify(message.blocks))}`;
    if (runtime.state.termDiscoverySentKeys.has(sendKey)) {
      return;
    }
    runtime.state.termDiscoverySentKeys.add(sendKey);
    if (runtime.state.termDiscoverySentKeys.size > 500) {
      runtime.state.termDiscoverySentKeys.delete(runtime.state.termDiscoverySentKeys.values().next().value);
    }
    const retry = () => {
      if (attempt < MAX_RETRY_ATTEMPTS) {
        // 术语发现是旁路能力，离线时自动等待重试，恢复在线后自动完成提取。
        runtime.state.termDiscoverySentKeys.delete(sendKey);
        setTimeout(() => scheduleNovelTermDiscovery(chapter, attempt + 1), RETRY_DELAY_MS);
      }
    };
    runtime.sendRuntimeMessage(message).then(response => {
      if (RETRY_REASONS.has(String(response && response.reason || ""))) {
        retry();
      }
    }).catch(retry);
  }
  runtime.scheduleNovelTermDiscovery = scheduleNovelTermDiscovery;
  runtime.buildNovelDiscoveryMessage = novelTermDiscovery.buildNovelDiscoveryMessage;
  runtime.sampleTranslatedParagraphs = novelTermDiscovery.sampleTranslatedParagraphs;

  /** 手动提取之后用一句人话交代结果（加了几条 / 被什么挡住了）。 */
  function reportManualExtraction(response) {
    if (!response || response.ok === false) {
      runtime.showFloatingBallFeedback?.(String(response && response.error || "术语提取失败"), "error");
      return response;
    }
    if (response.skipped) {
      runtime.showFloatingBallFeedback?.(SKIP_FEEDBACK[response.reason] || "这次没有提取（原因不明）", "info");
      return response;
    }
    const added = Number(response.added) || 0;
    const returned = Number(response.returned) || 0;
    const text = added > 0
      ? `已加入 ${added} 条候选术语`
      : returned > 0 ? "提取到了，但都已在术语库或待确认里" : "这次没提取到专有名词";
    runtime.showFloatingBallFeedback?.(text, "info");
    return response;
  }

  /**
   * 手动「提取本章术语」。
   *
   * 与自动那条路有两点不同：① 带 force —— 后台跳过 30 秒节流、冷却与「已处理」过滤，
   * 内容脚本这边也不吃「同一批块只发一次」的去重（用户点它，多半就是上次什么都没收到）；
   * ② 重新抽一次当前屏再采样，不复用某次自动提取的旧快照。
   */
  async function extractNovelChapterTerms() {
    const chapter = runtime.extractNovelChapter?.();
    const blocks = chapter
      ? novelTermDiscovery.sampleTranslatedParagraphs(chapter, runtime.getNovelState().translations)
      : [];
    if (blocks.length === 0) {
      runtime.showFloatingBallFeedback?.("本章还没有已翻译的段落", "info");
      return { ok: false, reason: "no_translated_paragraphs" };
    }
    const message = {
      ...novelTermDiscovery.buildNovelDiscoveryMessage(chapter, blocks, location.href, document.title),
      force: true
    };
    runtime.showFloatingBallFeedback?.("正在提取本章术语…", "info");
    try {
      return reportManualExtraction(await runtime.sendRuntimeMessage(message));
    } catch (error) {
      runtime.showFloatingBallFeedback?.("术语提取请求失败", "error");
      return { ok: false, reason: "request_failed", error: String(error && error.message || error) };
    }
  }
  runtime.extractNovelChapterTerms = extractNovelChapterTerms;
}
