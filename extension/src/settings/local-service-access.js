const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function localServiceHealthUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/u, "");
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/iu.test(normalized)) {
    throw new Error("本地服务地址必须使用 http://127.0.0.1 或 http://localhost");
  }
  return `${normalized}/health`;
}

export async function probeLocalServiceDocumentAccess(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(localServiceHealthUrl(baseUrl), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      // 127.0.0.1/localhost 属于 loopback；Chrome 145+ 已将其与局域网权限拆分。
      targetAddressSpace: "loopback"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(String(payload?.error || `本地服务返回 HTTP ${response.status}`));
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError" || error instanceof TypeError) {
      throw new Error("Chrome 无法访问本地服务；请确认服务已启动，并在“访问本机设备”权限提示中选择“允许”");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
