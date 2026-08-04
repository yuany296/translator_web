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
