import novelTermDiscovery from "../../shared/novel-term-discovery.js";

const RETRY_DELAY_MS = 30000;
const MAX_RETRY_ATTEMPTS = 40;
// "partial" = 提取跑了一部分（分段超时/失败）：缺的那些段落没被标记已处理，
// 重发时只会带上它们（见 shared/term-discovery.js#getUnprocessedBlocks）。
const RETRY_REASONS = new Set(["offline", "cooldown", "throttled", "partial"]);

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
}
