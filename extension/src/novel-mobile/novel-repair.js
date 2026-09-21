/**
 * 定点修正：已经翻过一遍的段落再有毛病时，只把那几段拿回来重问一次。
 *
 * 目前有两类毛病，本地都没法确定性地修（不知道该把哪几个字换成什么）：
 *   - 术语被模型自己发挥：术语注入了提示词，它却给这个名字换了另一种写法（人名最常见）；
 *   - 字形漂移：目标是简体中文，译文里却出现了繁体专用字（见 script-guard.js）。
 * 两者都在请求里**点名要求改什么**（走 revisionInstruction，桌面版 prompt 早就支持这条通道，
 * 见 novel-translation.js#buildPrompt），而不是笼统地重翻一遍。
 *
 * 三条边界：按 maxParagraphs 分批发（每批一条请求，批内按段落 id 逐条点名要求），
 * 有毛病的段落一批不落；术语那条明确允许「句子里确实不是指该对象时保留原译」，
 * 所以不会把「按语境跳过」又硬掰回来。
 *
 * 「怎么切块 / 怎么落库」那几件工具由 novel-batch.js 注入（它们和那边绑在一起），
 * 这里只管「哪些段要修、修的时候说什么」。
 */
import { describeScriptFix } from "./script-guard.js";

export function createNovelRepair({
  buildContext, buildRequest, requestChunk, applyChunk, concurrency, maxParagraphs
}) {
  /** 这一块里需要定点修正的段落：id → 修正要求（可能同时有术语和字形两条）。 */
  function collectReasons(response, targetLanguage) {
    const reasons = new Map();
    const add = (id, reason) => {
      const key = String(id || "");
      if (!key || !reason) return;
      if (!reasons.has(key)) reasons.set(key, []);
      if (!reasons.get(key).includes(reason)) reasons.get(key).push(reason);
    };
    for (const entry of (response && response.termUsage && response.termUsage.unused) || []) {
      add(entry.id, `术语译名必须逐字使用「${entry.source}→${entry.target}」`
        + "；若该词在句子里确实不是指这个对象，可以保留原译");
    }
    if (String(targetLanguage) === "zh-CN") {
      for (const row of (response && response.translations) || []) {
        add(row && row.id, describeScriptFix(row && row.translated_text));
      }
    }
    return reasons;
  }

  /**
   * 定点修正：把**所有**有毛病的段落都修一遍。
   *
   * 以前只修前 maxParagraphs 段（默认 8），超出的段落永远不会被修 —— 用户看到的就是
   * 「同一个名字，这一章里两种写法，有时候对有时候不对」。现在 maxParagraphs 变成
   * **每批段数**：按批发请求，修正要求按段落 id 逐条写进同一条 revisionInstruction，
   * 于是一屏 50 段违规也只需要 7 条请求（并发跑），而不是只修前 8 段。
   */
  async function repairParagraphs(options, reasonsById, progressText) {
    const { runtime, chapter, state, allItems, force, fingerprint, warnings, onUsage } = options;
    const ids = [...reasonsById.keys()].filter(id => allItems.some(item => item.id === id));
    if (!ids.length) return;
    const batchSize = Math.max(1, Number(maxParagraphs) || 1);
    const batches = [];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      batches.push(ids.slice(offset, offset + batchSize));
    }
    state.progress.textPhase = `正在修正译文（${ids.length} 段）…`;
    runtime.setNovelTextStatus?.("working", state.progress);
    const jobs = batches.map(batch => async () => {
      const items = batch.map(id => allItems.find(item => item.id === id)).filter(Boolean);
      if (!items.length) return null;
      const instruction = [
        "译文修正：只修正下面点名的段落，其它段落原样返回。",
        ...items.map(item => `- ${item.id}：${(reasonsById.get(item.id) || []).join("；")}`)
      ].join("\n");
      const nearby = buildContext(allItems, items);
      const response = await requestChunk(
        runtime, buildRequest(chapter, state, items, nearby, force, instruction)
      );
      if (!response || response.ok !== true) return null;
      (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
      await applyChunk(runtime, chapter, state, response, fingerprint);
      return response.termUsage || null;
    });
    for (const usage of await runtime.runWithConcurrency(jobs, concurrency)) {
      if (usage) onUsage(usage);
    }
    state.progress.textPhase = progressText();
  }

  return { collectReasons, repairParagraphs };
}
