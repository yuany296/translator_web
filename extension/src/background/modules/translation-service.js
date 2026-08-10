import cacheCore from "../../shared/translation-cache.js";
import { createTranslationMaintenanceScheduler } from "./translation-maintenance.js";
const LOCAL_SERVICE_HEALTH_TIMEOUT_MS = 5000;
const LOCAL_SERVICE_UNREACHABLE = "无法访问本地服务；请确认服务已启动，并在扩展设置中允许 Chrome 访问本机设备";
export function installTranslationService(runtime) {
  let writeQueue = Promise.resolve();
  async function serviceConfiguration() {
    const configuration = await runtime.loadConfiguration();
    return { baseUrl: runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl) };
  }

  async function localServiceFetch(url, options = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = payload?.detail;
        const error = new Error(String(detail?.error || detail || payload?.error || `HTTP ${response.status}`));
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError" || error instanceof TypeError) throw new Error(LOCAL_SERVICE_UNREACHABLE);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  runtime.localServiceFetch = localServiceFetch;

  async function requestTranslationService(path, options = {}, timeoutMs = 10_000) {
    const { baseUrl } = await serviceConfiguration();
    return localServiceFetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers }
    }, timeoutMs);
  }
  runtime.requestTranslationService = requestTranslationService;

  async function getTranslationServiceStatus() {
    try {
      const payload = await requestTranslationService("/translations/health", { method: "GET" }, LOCAL_SERVICE_HEALTH_TIMEOUT_MS);
      return { ok: payload?.ok === true, status: "online", ...payload };
    } catch (error) {
      return { ok: false, status: "offline", error: runtime.getErrorMessage(error) };
    }
  }
  runtime.getTranslationServiceStatus = getTranslationServiceStatus;

  runtime.queryTranslationService = recordKeys => requestTranslationService("/translations/query", {
    method: "POST", body: JSON.stringify({ recordKeys })
  });

  runtime.submitTranslationOperations = operations => {
    const execute = () => requestTranslationService("/translations/operations", {
      method: "POST", body: JSON.stringify({ operations })
    }, 30_000);
    const result = writeQueue.then(execute, execute);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  runtime.importLegacyTranslations = records => requestTranslationService("/translations/batch-import", {
    method: "POST", body: JSON.stringify({ records })
  }, 60_000);

  runtime.getTranslationVersions = recordId => requestTranslationService(
    `/translations/${encodeURIComponent(recordId)}/versions`, { method: "GET" }
  );
  runtime.exportTranslationLibrary = () => requestTranslationService(
    "/translations/export", { method: "GET" }, 60_000
  );
  runtime.importTranslationLibrary = records => requestTranslationService(
    "/translations/import", {
      method: "POST", body: JSON.stringify({ records, confirmation: "IMPORT_TRANSLATIONS" })
    }, 60_000
  );

  function snapshotToCacheRecord(snapshot) {
    const recent = Array.isArray(snapshot?.recentVersions) ? snapshot.recentVersions : [];
    const versions = recent.map(version => ({
      id: String(version.versionId || version.id || ""),
      translatedText: String(version.translatedText || ""),
      source: version.source === "manual" ? "manual" : "api",
      createdAt: Number(version.createdAt) || 0,
      pinned: version.pinned === true,
      manual: version.source === "manual",
      translationConfigFingerprint: String(version.configFingerprint || "")
    }));
    const active = snapshot?.activeVersion;
    if (active && !versions.some(version => version.id === active.versionId)) {
      versions.unshift({
        id: String(active.versionId), translatedText: String(active.translatedText || ""),
        source: active.source === "manual" ? "manual" : "api",
        createdAt: Number(active.createdAt) || 0, pinned: active.pinned === true,
        manual: active.source === "manual",
        translationConfigFingerprint: String(active.configFingerprint || "")
      });
    }
    return {
      id: String(snapshot.recordKey || ""), recordId: String(snapshot.recordId || ""),
      recordKey: String(snapshot.recordKey || ""), mode: snapshot.mode,
      sourceText: String(snapshot.rawSourceText || ""),
      normalizedSourceText: String(snapshot.normalizedSourceText || ""),
      sourceHash: String(snapshot.normalizedSourceHash || ""),
      rawSourceHash: String(snapshot.rawSourceHash || ""),
      normalizedSourceHash: String(snapshot.normalizedSourceHash || ""),
      configuredSourceLanguage: String(snapshot.configuredSourceLanguage || "auto"),
      resolvedSourceLanguage: String(snapshot.resolvedSourceLanguage || "auto"),
      targetLanguage: String(snapshot.targetLanguage || "zh-CN"),
      translatedText: String(active?.translatedText || ""),
      translationSource: active?.source === "manual" ? "manual" : "api",
      translationConfigFingerprint: String(active?.configFingerprint || ""),
      activeVersionId: String(snapshot.activeVersionId || ""),
      recordRevision: Number(snapshot.recordRevision) || 0,
      changeSeq: Number(snapshot.changeSeq) || 0,
      status: active?.source === "manual" ? "manual" : active?.pinned ? "pinned" : "current",
      versions, createdAt: Number(snapshot.createdAt) || Date.now(),
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
      workId: snapshot.workId, chapterId: snapshot.chapterId,
      paragraphKey: snapshot.segmentKey, segmentKey: snapshot.segmentKey,
      pageKey: snapshot.pageKey, normalizedUrl: snapshot.pageKey,
      recovery: snapshot.recovery || {},
      imageHash: snapshot.recovery?.imageHash,
      pageIndex: snapshot.recovery?.pageIndex,
      blockId: snapshot.recovery?.blockId,
      polygon: snapshot.recovery?.polygon,
      ocrText: snapshot.rawSourceText
    };
  }
  runtime.translationSnapshotToCacheRecord = snapshotToCacheRecord;

  async function saveSnapshots(snapshots) {
    const source = Array.isArray(snapshots) ? snapshots : [];
    const deletedKeys = source.filter(snapshot => snapshot?.deletedAt)
      .map(snapshot => String(snapshot.recordKey || "")).filter(Boolean);
    for (const recordKey of deletedKeys) await runtime.deleteTranslationCacheRecord(recordKey);
    const records = source.filter(snapshot => !snapshot?.deletedAt)
      .map(snapshotToCacheRecord).filter(record => record.id && record.versions.length);
    if (records.length) await runtime.saveTranslationCacheRecords(records);
    const changeSeq = Math.max(0, ...source.map(snapshot => Number(snapshot?.changeSeq) || 0));
    if (changeSeq) await runtime.setTranslationSyncMetadata("lastChangeSeq", changeSeq);
    return records;
  }
  runtime.saveTranslationServiceSnapshots = saveSnapshots;

  async function flushPendingOperations() {
    const pending = await runtime.getPendingTranslationOperations();
    let submitted = 0;
    const conflicts = [];
    for (const operation of pending) {
      try {
        const response = await runtime.submitTranslationOperations([operation]);
        const result = response?.results?.[0];
        if (!result?.record) break;
        await saveSnapshots([result.record]);
        await runtime.deletePendingTranslationOperations([operation.operationId]);
        submitted += 1;
      } catch (error) {
        if (error.status === 409 && operation.type === "edit") {
          try {
            const retry = { ...operation };
            delete retry.expectedRecordRevision;
            delete retry.baseActiveVersionId;
            const response = await runtime.submitTranslationOperations([retry]);
            const result = response?.results?.[0];
            if (!result?.record) break;
            await saveSnapshots([result.record]);
            await runtime.deletePendingTranslationOperations([operation.operationId]);
            submitted += 1;
            continue;
          } catch {
            break;
          }
        }
        if (error.status === 409) {
          conflicts.push({
            operationId: operation.operationId, type: operation.type,
            error: error.payload?.detail?.error || runtime.getErrorMessage(error),
            currentRecord: error.payload?.detail?.currentRecord || null
          });
          await runtime.deletePendingTranslationOperations([operation.operationId]);
          continue;
        }
        if (error.status === 400) { await runtime.deletePendingTranslationOperations([operation.operationId]); continue; }
        break;
      }
    }
    if (conflicts.length) await runtime.setTranslationSyncMetadata("pendingConflicts", conflicts);
    return { submitted, remaining: pending.length - submitted - conflicts.length, conflicts };
  }
  runtime.flushPendingTranslationOperations = flushPendingOperations;

  function legacyImportRecord(record) {
    const scopeKey = record.mode === "novel" ? `${record.workId || "legacy"}:${record.chapterId || ""}`
      : record.mode === "comic" ? `${record.workId || "legacy"}:${record.chapterId || ""}`
        : record.pageKey || record.normalizedUrl || "legacy";
    const resolvedSourceLanguage = runtime.languages.resolveSourceLanguage(
      record.configuredSourceLanguage || "auto", record.sourceText
    );
    const targetLanguage = record.targetLanguage || "zh-CN";
    if (resolvedSourceLanguage !== "auto" && resolvedSourceLanguage === targetLanguage) return null;
    const sourceHash = record.normalizedSourceHash || record.sourceHash;
    const recordKey = record.mode === "novel"
      ? cacheCore.buildNovelRecordId(
        record.workId, record.chapterId, sourceHash, record.paragraphKey,
        resolvedSourceLanguage, targetLanguage
      )
      : record.mode === "webpage"
        ? cacheCore.buildWebpageRecordId(
          record.pageKey || record.normalizedUrl, record.segmentKey || record.id,
          sourceHash, resolvedSourceLanguage, targetLanguage
        )
        : record.recordKey || record.id;
    return {
      ...record, recordKey, scopeKey,
      segmentKey: record.segmentKey || record.paragraphKey || record.blockId || record.id,
      rawSourceText: record.sourceText, rawSourceHash: record.rawSourceHash || record.sourceHash,
      normalizedSourceHash: record.normalizedSourceHash || record.sourceHash,
      configuredSourceLanguage: record.configuredSourceLanguage || "auto",
      resolvedSourceLanguage,
      targetLanguage
    };
  }

  async function migrateLegacyTranslations() {
    const completed = await runtime.getTranslationSyncMetadata("legacyMigrationComplete");
    if (completed === true) return { migrated: 0, skipped: true };
    const records = (await runtime.getAllTranslationCacheRecords())
      .filter(record => !record.recordId && record.id && record.translatedText)
      .map(legacyImportRecord).filter(Boolean);
    let migrated = 0;
    for (let index = 0; index < records.length; index += 500) {
      const response = await runtime.importLegacyTranslations(records.slice(index, index + 500));
      const snapshots = (response?.results || []).map(result => result.record).filter(Boolean);
      await saveSnapshots(snapshots);
      migrated += snapshots.length;
    }
    await runtime.setTranslationSyncMetadata("legacyMigrationComplete", true);
    return { migrated };
  }
  runtime.migrateLegacyTranslations = migrateLegacyTranslations;
  runtime.scheduleTranslationServiceMaintenance = createTranslationMaintenanceScheduler(runtime);

  async function syncTranslationService(recordKeys = []) {
    const status = await runtime.getTranslationServiceStatus();
    await Promise.all([
      runtime.setTranslationSyncMetadata("serviceStatus", status.status),
      runtime.setTranslationSyncMetadata("lastHealthCheck", Date.now())
    ]);
    if (!status.ok) return status;
    const response = recordKeys.length ? await runtime.queryTranslationService(recordKeys) : null;
    if (response) await saveSnapshots(response.records || []);
    // 冲刷积压写入与旧库迁移属于维护任务，不能挡住首屏缓存查询和翻译。
    void runtime.scheduleTranslationServiceMaintenance();
    return { ...status, records: response?.records || [],
      changeSeq: response?.changeSeq || status.changeSeq, pendingConflicts: [] };
  }
  runtime.syncTranslationService = syncTranslationService;

  async function commitOrQueueTranslationOperation(operation) {
    try {
      const response = await runtime.submitTranslationOperations([operation]);
      const result = response?.results?.[0];
      if (result?.record) await saveSnapshots([result.record]);
      return { ok: true, pending: false, ...result };
    } catch (error) {
      if (error.status === 409) {
        const record = error.payload?.detail?.currentRecord || null;
        if (record) await saveSnapshots([record]);
        return {
          ok: false, pending: false, conflict: true, record,
          error: error.payload?.detail?.error || runtime.getErrorMessage(error)
        };
      }
      await runtime.queuePendingTranslationOperation(operation);
      return { ok: false, pending: true, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.commitOrQueueTranslationOperation = commitOrQueueTranslationOperation;
}
