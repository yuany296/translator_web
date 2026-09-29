/**
 * 译文请求取证：原始响应快照 + 「流式 vs 整批」对照。
 *
 * 起因：漫画翻译走供应商流式分支时返回过被截尾的译文（`好,马上` → `好,`；整句 → `游乐设施`），
 * 但当时只能靠推测判断是哪一段出了问题。这里把每次请求的原始 SSE、累积文本、逐行提取结果、
 * 最终解析、`finish_reason` 都留档（最近 20 次），并提供一个用**当前已配置服务商**跑的
 * A/B 入口，用来回答「流式到底能不能用」。
 */
const MAX_SNAPSHOTS = 20;
const DEFAULT_AB_ITEMS = Object.freeze([
  "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.",
  "좋아, 바로",
  "이 판타지 트레인은 다크라이드입니다."
]);
/** 与 shared/translation-shrink.js 的判据同源：整批更短到 60% 以下算可疑。 */
const A_B_SHRINK_RATIO = 0.6;
const A_B_MIN_ROUNDS = 20;

export function installTranslationDiagnostics(runtime) {
  const snapshots = [];

  function recordTranslationSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    snapshots.push({ ...snapshot });
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }
  runtime.recordTranslationSnapshot = recordTranslationSnapshot;

  function listTranslationSnapshots() {
    return snapshots.map(snapshot => ({ ...snapshot }));
  }
  runtime.listTranslationSnapshots = listTranslationSnapshots;

  function resetTranslationSnapshots() {
    snapshots.length = 0;
  }
  runtime.resetTranslationSnapshots = resetTranslationSnapshots;

  function summarizeSnapshots() {
    return snapshots.map(snapshot => ({
      at: new Date(snapshot.at).toISOString(),
      kind: snapshot.kind,
      model: snapshot.model,
      streamed: snapshot.streamed,
      outcome: snapshot.outcome,
      finishReason: snapshot.finishReason,
      partialRows: snapshot.partialRows,
      returnedRows: snapshot.returnedRows,
      durationMs: snapshot.durationMs,
      error: snapshot.error
    }));
  }
  runtime.summarizeTranslationSnapshots = summarizeSnapshots;

  /**
   * 同一批原文，先整批（非流式）再流式，逐行比对是否一致。
   * 只有 repeat ≥ 20、零截尾、零缺项、逐行一致，才允许把漫画流式交给用户开关。
   */
  async function compareStreamAgainstBatch(options = {}) {
    const requested = Math.max(1, Math.min(50, Number(options.repeat) || 1));
    const texts = (Array.isArray(options.items) && options.items.length ? options.items : DEFAULT_AB_ITEMS)
      .map(text => String(text || "")).filter(Boolean);
    const items = texts.map((text, index) => ({ id: `ab-${index}`, original_text: text }));
    const settings = await runtime.loadSettings();
    const baseUrl = settings.baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL;
    const model = settings.model || runtime.DEFAULT_TRANSLATION_MODEL;
    const sourceLanguage = String(options.sourceLanguage || "ko");
    const targetLanguage = String(options.targetLanguage || "zh-CN");
    const rounds = [];

    async function runOnce(streamed) {
      const startedAt = Date.now();
      let firstRowMs = 0;
      const result = { rows: [], firstRowMs: 0, totalMs: 0, error: "" };
      try {
        result.rows = await runtime.requestOpenAICompatibleCanonicalTranslationBatch({
          items,
          apiKey: settings.apiKey,
          baseUrl,
          model,
          sourceLanguage,
          targetLanguage,
          mode: "comic",
          pageUrl: "",
          signal: null,
          onRow: streamed ? () => {
            if (!firstRowMs) firstRowMs = Date.now() - startedAt;
          } : null
        });
      } catch (error) {
        result.error = String(error && error.message || error).slice(0, 200);
      }
      result.firstRowMs = firstRowMs;
      result.totalMs = Date.now() - startedAt;
      return result;
    }

    for (let round = 0; round < requested; round += 1) {
      const batch = await runOnce(false);
      const streamed = await runOnce(true);
      const batchById = new Map(batch.rows.map(row => [String(row.id), String(row.translated_text || "")]));
      const streamById = new Map(streamed.rows.map(row => [String(row.id), String(row.translated_text || "")]));
      let missing = 0;
      let shrank = 0;
      const differences = [];
      for (const item of items) {
        const left = batchById.get(item.id);
        const right = streamById.get(item.id);
        if (left === undefined || right === undefined) {
          missing += 1;
          continue;
        }
        if (left === right) continue;
        differences.push({ id: item.id, batch: left.slice(0, 60), streamed: right.slice(0, 60) });
        if (right.length < left.length * A_B_SHRINK_RATIO) shrank += 1;
      }
      rounds.push({
        round: round + 1,
        batchMs: batch.totalMs,
        streamedMs: streamed.totalMs,
        streamedFirstRowMs: streamed.firstRowMs,
        batchError: batch.error,
        streamedError: streamed.error,
        missing,
        shrank,
        identical: missing === 0 && differences.length === 0,
        differences: differences.slice(0, 5)
      });
    }

    const identicalRounds = rounds.filter(round => round.identical).length;
    const shrankRows = rounds.reduce((sum, round) => sum + round.shrank, 0);
    const missingRows = rounds.reduce((sum, round) => sum + round.missing, 0);
    const errors = rounds.filter(round => round.batchError || round.streamedError).length;
    const average = key => Math.round(rounds.reduce((sum, round) => sum + Number(round[key] || 0), 0) / rounds.length);
    let verdict = "streaming-not-safe";
    if (requested < A_B_MIN_ROUNDS) verdict = "insufficient-evidence";
    else if (identicalRounds === requested && shrankRows === 0 && missingRows === 0 && errors === 0) verdict = "streaming-usable";
    return {
      ok: true,
      rounds: requested,
      requiredRounds: A_B_MIN_ROUNDS,
      verdict,
      identicalRounds,
      shrankRows,
      missingRows,
      errorRounds: errors,
      avgBatchMs: average("batchMs"),
      avgStreamedMs: average("streamedMs"),
      avgStreamedFirstRowMs: average("streamedFirstRowMs"),
      items: texts,
      samples: rounds.slice(0, 5)
    };
  }
  runtime.compareStreamAgainstBatch = compareStreamAgainstBatch;

  /** service worker 控制台入口：__mtTranslationSnapshots() / __mtStreamAb({ repeat }) */
  function exposeConsoleHelper() {
    try {
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      if (!scope || scope.__mtTranslationSnapshots) return;
      scope.__mtTranslationSnapshots = () => summarizeSnapshots();
      scope.__mtTranslationSnapshotsReset = () => resetTranslationSnapshots();
      scope.__mtStreamAb = options => compareStreamAgainstBatch(options);
    } catch {
      // 控制台助手只是便利设施，注册失败不影响翻译
    }
  }
  runtime.exposeTranslationDiagnosticsConsoleHelper = exposeConsoleHelper;
  exposeConsoleHelper();
}
