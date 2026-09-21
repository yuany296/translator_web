/**
 * 手机版没有本地服务：把页面里指向 127.0.0.1 / localhost 的请求直接判失败。
 *
 * 这里不伪造成功响应——需要真正改变行为的三处（术语页加载、清空全部、SQLite 导入）
 * 都由 glossary-local.js 显式覆盖；本模块只负责让「漏网」的 best-effort 同步立刻失败，
 * 而不是让页面等网络超时（手机上若把服务地址填成局域网 IP，那会是几十秒）。
 */
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BLOCKED_MESSAGE = "手机版不使用本地服务";

function isLocalServiceUrl(url) {
  try {
    const parsed = new URL(String(url || ""), typeof location !== "undefined" ? location.href : undefined);
    return LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function blockLocalServiceFetch() {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function" || nativeFetch.__mtNovelMobile === true) return;
  const wrapped = (input, init) => {
    const url = typeof input === "string" ? input : String(input && input.url || "");
    if (isLocalServiceUrl(url)) {
      return Promise.reject(new Error(BLOCKED_MESSAGE));
    }
    return nativeFetch(input, init);
  };
  wrapped.__mtNovelMobile = true;
  globalThis.fetch = wrapped;
}
