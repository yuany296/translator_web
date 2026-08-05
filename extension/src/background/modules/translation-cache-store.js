import cacheCore from "../../shared/translation-cache.js";

export function installTranslationCacheStore(runtime) {
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(cacheCore.DB_NAME, cacheCore.DB_VERSION);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(cacheCore.STORE_NAME)) {
          const store = db.createObjectStore(cacheCore.STORE_NAME, { keyPath: "id" });
          store.createIndex("mode", "mode", { unique: false });
          store.createIndex("mode_sourceHash", ["mode", "sourceHash"], { unique: false });
          store.createIndex("mode_translationKey", ["mode", "translationKey"], { unique: false });
          if (db.objectStoreNames.contains(cacheCore.LEGACY_STORE_NAME)) {
            const legacy = event.target.transaction.objectStore(cacheCore.LEGACY_STORE_NAME);
            legacy.openCursor().onsuccess = cursorEvent => {
              const cursor = cursorEvent.target.result;
              if (!cursor) return;
              store.put(cursor.value);
              cursor.continue();
            };
          }
        } else if (event.oldVersion < 3) {
          // v3：为 translationKey 增加索引（跨页面复用回退）；旧记录不删除
          const store = event.target.transaction.objectStore(cacheCore.STORE_NAME);
          if (store.indexNames && !store.indexNames.contains("mode_translationKey")) {
            store.createIndex("mode_translationKey", ["mode", "translationKey"], { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(cacheCore.PENDING_STORE_NAME)) {
          const pending = db.createObjectStore(cacheCore.PENDING_STORE_NAME, { keyPath: "operationId" });
          pending.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(cacheCore.SYNC_STORE_NAME)) {
          db.createObjectStore(cacheCore.SYNC_STORE_NAME, { keyPath: "key" });
        }
      };
    });
    return dbPromise;
  }

  function withNamedStore(name, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const result = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    }));
  }

  function withStore(mode, fn) {
    return openDb().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(cacheCore.STORE_NAME, mode);
        const store = tx.objectStore(cacheCore.STORE_NAME);
        const result = fn(store);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      });
    });
  }

  async function getRecord(id) {
    try {
      const record = await withStore("readonly", store => new Promise((resolve, reject) => {
        const request = store.get(String(id));
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }));
      return cacheCore.normalizeRecord(record);
    } catch (error) {
      console.warn("[MangaTranslator] cache read failed", error);
      return null;
    }
  }
  runtime.getTranslationCacheRecord = getRecord;

  async function getRecords(ids) {
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!list.length) return new Map();
    try {
      const records = await withStore("readonly", store => Promise.all(list.map(id => new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }))));
      return new Map(records.map((record, index) => [list[index], cacheCore.normalizeRecord(record)]).filter(([, record]) => record));
    } catch (error) {
      console.warn("[MangaTranslator] batch cache read failed", error);
      return new Map();
    }
  }
  runtime.getTranslationCacheRecords = getRecords;

  async function saveRecord(record) {
    const normalized = cacheCore.normalizeRecord(record);
    if (!normalized) {
      return { ok: false, error: "invalid record" };
    }
    try {
      await withStore("readwrite", store => {
        store.put(normalized);
      });
      return { ok: true, id: normalized.id };
    } catch (error) {
      console.warn("[MangaTranslator] cache write failed", error);
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.saveTranslationCacheRecord = saveRecord;

  async function saveRecords(records) {
    const list = (Array.isArray(records) ? records : []).map(cacheCore.normalizeRecord).filter(Boolean);
    if (!list.length) return { ok: true, saved: 0 };
    try {
      await withStore("readwrite", store => {
        for (const record of list) store.put(record);
      });
      return { ok: true, saved: list.length };
    } catch (error) {
      console.warn("[MangaTranslator] batch cache write failed", error);
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.saveTranslationCacheRecords = saveRecords;

  async function deleteRecord(id) {
    try {
      await withStore("readwrite", store => {
        store.delete(String(id));
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.deleteTranslationCacheRecord = deleteRecord;

  async function clearRecordsByMode(mode) {
    if (!cacheCore.MODES.includes(mode)) return { ok: false, error: "invalid mode" };
    try {
      const ids = await withStore("readonly", store => new Promise((resolve, reject) => {
        const request = store.index("mode").getAllKeys(mode);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
      if (ids.length) {
        await withStore("readwrite", store => {
          for (const id of ids) store.delete(id);
        });
      }
      return { ok: true, removed: ids.length };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.clearTranslationCacheByMode = clearRecordsByMode;

  async function getAllRecords() {
    return withStore("readonly", store => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }
  runtime.getAllTranslationCacheRecords = getAllRecords;

  async function dedupeRecords() {
    const records = await getAllRecords();
    const kept = new Map();
    const removed = [];
    const score = record => (record.updatedAt || 0)
      + (Array.isArray(record.versions) ? record.versions.length : 0) * 1000;
    for (const record of records) {
      const key = `${record.normalizedSourceHash || record.sourceHash || ""}|${record.translatedText || ""}`;
      const existing = kept.get(key);
      if (!existing) {
        kept.set(key, record);
        continue;
      }
      if (score(record) > score(existing)) {
        kept.set(key, record);
        removed.push(existing.id);
      } else {
        removed.push(record.id);
      }
    }
    for (const id of removed) await deleteRecord(id);
    return { ok: true, removed: removed.length, total: records.length };
  }
  runtime.dedupeTranslationCacheRecords = dedupeRecords;

  function readIndexValues(store, indexName, mode, values) {
    const unique = [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
    return Promise.all(unique.map(value => new Promise((resolve, reject) => {
      const request = store.index(indexName).getAll([mode, value]);
      request.onsuccess = () => resolve([value, (request.result || [])
        .map(cacheCore.normalizeRecord).filter(Boolean)]);
      request.onerror = () => reject(request.error);
    }))).then(Object.fromEntries);
  }

  async function queryWebpageFallbacks(sourceHashes, translationKeys) {
    try {
      return await withStore("readonly", store => Promise.all([
        readIndexValues(store, "mode_sourceHash", "webpage", sourceHashes),
        readIndexValues(store, "mode_translationKey", "webpage", translationKeys)
      ]).then(([bySourceHash, byTranslationKey]) => ({ bySourceHash, byTranslationKey })));
    } catch (error) {
      console.warn("[MangaTranslator] webpage fallback cache query failed", error);
      return { bySourceHash: {}, byTranslationKey: {} };
    }
  }
  runtime.queryWebpageTranslationCacheFallbacks = queryWebpageFallbacks;

  /** 旧 v1/v2 记录双读：按原文哈希索引查询（配合页面字段在客户端过滤）。 */
  async function queryRecordsBySourceHash(mode, sourceHash) {
    if (!cacheCore.MODES.includes(mode)) return [];
    try {
      const records = await withStore("readonly", store => new Promise((resolve, reject) => {
        const request = store.index("mode_sourceHash").getAll([mode, String(sourceHash)]);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
      return records.map(cacheCore.normalizeRecord).filter(Boolean);
    } catch (error) {
      console.warn("[MangaTranslator] hash cache query failed", error);
      return [];
    }
  }
  runtime.queryTranslationCacheRecordsByHash = queryRecordsBySourceHash;

  /** translationKey 跨页面复用回退查询。 */
  async function queryRecordsByTranslationKey(mode, translationKey) {
    if (!cacheCore.MODES.includes(mode) || !translationKey) return [];
    try {
      const records = await withStore("readonly", store => new Promise((resolve, reject) => {
        const request = store.index("mode_translationKey").getAll([mode, String(translationKey)]);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
      return records.map(cacheCore.normalizeRecord).filter(Boolean);
    } catch (error) {
      console.warn("[MangaTranslator] translation-key cache query failed", error);
      return [];
    }
  }
  runtime.queryTranslationCacheRecordsByKey = queryRecordsByTranslationKey;

  async function queuePendingOperation(operation) {
    await withNamedStore(cacheCore.PENDING_STORE_NAME, "readwrite", store => store.put(operation));
    return { ok: true, operationId: operation.operationId };
  }
  runtime.queuePendingTranslationOperation = queuePendingOperation;

  async function getPendingOperations() {
    const operations = await withNamedStore(cacheCore.PENDING_STORE_NAME, "readonly", store =>
      new Promise((resolve, reject) => {
        const request = store.index("createdAt").getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
    return operations.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
  }
  runtime.getPendingTranslationOperations = getPendingOperations;

  async function deletePendingOperations(operationIds) {
    const ids = Array.isArray(operationIds) ? operationIds : [];
    await withNamedStore(cacheCore.PENDING_STORE_NAME, "readwrite", store =>
      ids.forEach(operationId => store.delete(String(operationId))));
    return { ok: true, deleted: ids.length };
  }
  runtime.deletePendingTranslationOperations = deletePendingOperations;

  async function setSyncMetadata(key, value) {
    await withNamedStore(cacheCore.SYNC_STORE_NAME, "readwrite", store =>
      store.put({ key: String(key), value, updatedAt: Date.now() }));
    return { ok: true };
  }
  runtime.setTranslationSyncMetadata = setSyncMetadata;

  async function getSyncMetadata(key) {
    return withNamedStore(cacheCore.SYNC_STORE_NAME, "readonly", store =>
      new Promise((resolve, reject) => {
        const request = store.get(String(key));
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
      }));
  }
  runtime.getTranslationSyncMetadata = getSyncMetadata;

  function handleTranslationCacheMessage(message) {
    switch (message.type) {
      case "GET_TRANSLATION_CACHE":
        return getRecord(message.id).then(record => ({ ok: true, record }));
      case "GET_TRANSLATION_CACHE_BATCH":
        return getRecords(message.ids).then(map => ({ ok: true, records: Object.fromEntries(map) }));
      case "GET_TRANSLATION_CACHE_BY_HASH":
        return queryRecordsBySourceHash(message.mode, message.sourceHash).then(records => ({ ok: true, records }));
      case "GET_TRANSLATION_CACHE_BY_TRANSLATION_KEY":
        return queryRecordsByTranslationKey(message.mode, message.translationKey)
          .then(records => ({ ok: true, records }));
      case "GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS":
        return queryWebpageFallbacks(message.sourceHashes, message.translationKeys)
          .then(result => ({ ok: true, ...result }));
      case "SAVE_TRANSLATION_CACHE":
        return saveRecord(message.record);
      case "SAVE_TRANSLATION_CACHE_BATCH":
        return saveRecords(message.records);
      case "DELETE_TRANSLATION_CACHE":
        return deleteRecord(message.id);
      case "CLEAR_TRANSLATION_CACHE_MODE":
        return clearRecordsByMode(message.mode);
      case "QUEUE_PENDING_TRANSLATION_OPERATION":
        return queuePendingOperation(message.operation);
      case "GET_PENDING_TRANSLATION_OPERATIONS":
        return getPendingOperations().then(operations => ({ ok: true, operations }));
      case "DELETE_PENDING_TRANSLATION_OPERATIONS":
        return deletePendingOperations(message.operationIds);
      case "SET_TRANSLATION_SYNC_METADATA":
        return setSyncMetadata(message.key, message.value);
      case "GET_TRANSLATION_SYNC_METADATA":
        return getSyncMetadata(message.key).then(value => ({ ok: true, value }));
      default:
        return Promise.resolve({ ok: false, error: `Unknown cache message: ${message.type}` });
    }
  }
  runtime.handleTranslationCacheMessage = handleTranslationCacheMessage;
}
