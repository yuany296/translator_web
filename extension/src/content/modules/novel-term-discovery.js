import novelTermDiscovery from "../../shared/novel-term-discovery.js";

export function installNovelTermDiscovery(runtime) {
  function scheduleNovelTermDiscovery(chapter) {
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
    runtime.sendRuntimeMessage(message).catch(() => {
      // 术语发现是旁路能力，离线或扩展重载都不能影响译文渲染。
    });
  }
  runtime.scheduleNovelTermDiscovery = scheduleNovelTermDiscovery;
  runtime.buildNovelDiscoveryMessage = novelTermDiscovery.buildNovelDiscoveryMessage;
  runtime.sampleTranslatedParagraphs = novelTermDiscovery.sampleTranslatedParagraphs;
}
