/**
 * 整章提取的「跑到哪了」：分段落盘 + 断点续跑 + 分段覆盖了哪些块。
 *
 * 手机版把整章提取搬进了 MV3 Service Worker，随时可能被系统回收：以前整趟结果只在
 * 内存里，跑到一半被回收就全丢（而且不留痕迹）。现在每跑完一段就落一次盘，
 * 下次进入同一趟提取时跳过已完成的段，只补跑剩下的。
 *
 * 「这一段覆盖了哪些块」用于决定哪些段落算「已处理」：只有真的跑出结果的分段覆盖的块
 * 才允许标记，否则失败分段里的术语会被永久跳过（用户看到的「漏术语」）。
 */

/**
 * 这一段覆盖了哪些块：块原文出现在这一段里就算。
 *
 * 只有被**成功分段**覆盖的块才允许记成「已处理」（见 background-local.js）：
 * 分段超时/失败时若把整屏标记已处理，落在失败分段里的术语就永远不会再被提取 ——
 * 真机表现就是「待确认里有术语，但比电脑少、老是漏」。
 * 跨段被切开的超长块退一步只比开头 80 字；两边都不匹配就不算覆盖（宁可下次重跑）。
 */
function blockIdsInChunk(chunk, prepared) {
  return prepared.filter(block => {
    const text = String(block.text || "");
    if (!text) return false;
    if (chunk.includes(text)) return true;
    return text.length > 80 && chunk.includes(text.slice(0, 80));
  }).map(block => block.id);
}

/** 进程内兜底存储：模块级共享，否则每次取 store 都是一个新 Map，续跑永远读不到上次的进度。 */
const memoryProgress = new Map();

/** 可注入的存储桩（测试用）：与 chrome.storage.session 同形状的 get/set/remove。 */
export function createMemoryProgressStore() {
  const memory = new Map();
  return {
    get: keys => Promise.resolve(Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).filter(key => memory.has(key)).map(key => [key, memory.get(key)])
    )),
    set: value => {
      Object.entries(value).forEach(([key, entry]) => memory.set(key, entry));
      return Promise.resolve();
    },
    remove: key => {
      (Array.isArray(key) ? key : [key]).forEach(item => memory.delete(item));
      return Promise.resolve();
    }
  };
}

/**
 * 分段进度（断点续跑用）：service worker 随时可能被回收，跑到一半的结果不能只留在内存里。
 *
 * 优先用注入的 store（测试），其次 chrome.storage.session，最后才是进程内 Map
 * （部分内核没有 storage.session：正确性不变，只是不抗回收）。
 */
function sessionStore(runtime = null) {
  if (runtime && runtime.termExtractProgressStore) return runtime.termExtractProgressStore;
  try {
    const session = globalThis.chrome?.storage?.session;
    if (session && typeof session.get === "function" && typeof session.set === "function") {
      return session;
    }
  } catch {
    // 见上
  }
  return {
    get: keys => Promise.resolve(Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).filter(key => memoryProgress.has(key))
        .map(key => [key, memoryProgress.get(key)])
    )),
    set: value => {
      Object.entries(value).forEach(([key, entry]) => memoryProgress.set(key, entry));
      return Promise.resolve();
    },
    remove: key => {
      (Array.isArray(key) ? key : [key]).forEach(item => memoryProgress.delete(item));
      return Promise.resolve();
    }
  };
}

function runKeyOf(runtime, fullText) {
  return `mt_term_extract_run_v1:${runtime.hashSourceIdentity?.(fullText) || hashString(fullText)}`;
}

/** 与 term-discovery-keys / runtime.hashSourceIdentity 无关的兜底哈希（FNV-1a）。 */
function hashString(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** 读回本次运行已完成的段：`{ [chunkIndex]: candidates }`。 */
async function readChunkProgress(runtime, runKey) {
  try {
    const stored = await sessionStore(runtime).get(runKey);
    const value = stored && stored[runKey];
    if (!value || typeof value !== "object" || !value.chunks || typeof value.chunks !== "object") {
      return new Map();
    }
    return new Map(Object.entries(value.chunks).map(([index, candidates]) => [
      Number(index), Array.isArray(candidates) ? candidates : []
    ]));
  } catch {
    return new Map();
  }
}

async function writeChunkProgress(runtime, runKey, chunks) {
  try {
    await sessionStore(runtime).set({
      [runKey]: { chunks: Object.fromEntries(chunks), updatedAt: Date.now() }
    });
  } catch {
    // 落盘失败只是抗不了回收，不影响这次结果
  }
}

async function clearChunkProgress(runtime, runKey) {
  try {
    await sessionStore(runtime).remove(runKey);
  } catch {
    // 同上
  }
}

export { blockIdsInChunk, runKeyOf, readChunkProgress, writeChunkProgress, clearChunkProgress };