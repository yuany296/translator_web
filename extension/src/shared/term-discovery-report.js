/**
 * 「最近一次术语提取的结果」—— 桌面与手机共用的一份记账。
 *
 * 以前只有桌面版写这条记录（手机版自己实现了 runTermDiscovery，把这段漏掉了），
 * 于是手机上收集不到术语时用户看不到任何原因：是节流跳过了？模型返回 0 条？
 * 分段失败只跑出一部分？还是提取服务离线？这几种修法完全不同。
 *
 * 记录落在 `mt_term_discovery_last_v1`（storage key 由 runtime.STORAGE_KEYS 提供），
 * 术语库页待确认标签的「最近一次提取」直接读它。
 */
export const TERM_DISCOVERY_LAST_KEY = "mt_term_discovery_last_v1";

/**
 * @param runtime  需要 `storageSet` 与 `STORAGE_KEYS.termDiscoveryLast`（测试里可只给 storageSet）
 * @param outcome  { outcome, reason?, error?, startedAt?, budgetMs?, returned?, added?,
 *                   failedChunks?, totalChunks?, droppedKinds?, droppedNotInSource? }
 */
export async function recordTermDiscoveryOutcome(runtime, outcome = {}) {
  const key = runtime?.STORAGE_KEYS?.termDiscoveryLast || TERM_DISCOVERY_LAST_KEY;
  try {
    await runtime.storageSet({
      [key]: { at: Date.now(), ...outcome }
    });
  } catch {
    // 记账失败不能影响提取本身
  }
}

export default Object.freeze({ TERM_DISCOVERY_LAST_KEY, recordTermDiscoveryOutcome });
