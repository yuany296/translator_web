import assert from "node:assert/strict";
import test from "node:test";

import { installTranslationService } from "../extension/src/background/modules/translation-service.js";

test("service sync returns page records without waiting for maintenance", async () => {
  const runtime = {
    setTranslationSyncMetadata: async () => {},
    getErrorMessage: error => String(error?.message || error)
  };
  installTranslationService(runtime);
  let releaseMaintenance;
  const maintenance = new Promise(resolve => {
    releaseMaintenance = resolve;
  });
  runtime.getTranslationServiceStatus = async () => ({ ok: true, status: "online", changeSeq: 3 });
  runtime.queryTranslationService = async () => ({
    records: [{ recordKey: "r1" }], changeSeq: 4
  });
  runtime.saveTranslationServiceSnapshots = async () => [];
  runtime.flushPendingTranslationOperations = () => maintenance;
  runtime.migrateLegacyTranslations = async () => ({ skipped: true });

  const result = await Promise.race([
    runtime.syncTranslationService(["r1"]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("sync blocked on maintenance")), 50))
  ]);
  assert.equal(result.records[0].recordKey, "r1");
  assert.equal(result.changeSeq, 4);
  releaseMaintenance();
  await runtime.scheduleTranslationServiceMaintenance();
});

test("flush deletes permanently rejected (400) operations instead of retrying forever", async () => {
  const deleted = [];
  const fetchCalls = [];
  const previousFetch = globalThis.fetch;
  const runtime = {
    setTranslationSyncMetadata: async () => {},
    getErrorMessage: error => String(error?.message || error),
    loadConfiguration: async () => ({ ocr: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } } }),
    sanitizeLocalOcrBaseUrl: url => String(url || ""),
    storageGet: async () => ({ mt_local_service_auth_v1: { token: "t", origin: "chrome-extension://test" } }),
    getPendingTranslationOperations: async () => [
      { operationId: "op-400", type: "commit_translation", recordKey: "", payload: {} },
      { operationId: "op-400b", type: "commit_translation", recordKey: "", payload: {} }
    ],
    deletePendingTranslationOperations: async ids => { deleted.push(...ids); },
    saveTranslationServiceSnapshots: async () => []
  };
  globalThis.fetch = async url => {
    fetchCalls.push(String(url));
    if (String(url).includes("/translations/health")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 400, json: async () => ({ detail: "recordKey is required" }) };
  };
  try {
    installTranslationService(runtime);
    const result = await runtime.flushPendingTranslationOperations();
    assert.equal(fetchCalls.filter(url => url.includes("/translations/operations")).length, 2,
      "400 后继续处理后续操作而不是中断");
    assert.deepEqual(deleted.sort(), ["op-400", "op-400b"], "400 操作被删除，不再进入下轮重试");
    assert.equal(result.remaining, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
