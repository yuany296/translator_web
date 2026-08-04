import assert from "node:assert/strict";
import test from "node:test";

import { probeLocalServiceDocumentAccess } from
  "../extension/src/settings/local-service-access.js";

test("visible extension page probes loopback and declares the local address space", async () => {
  let request = null;
  const payload = await probeLocalServiceDocumentAccess("http://127.0.0.1:8765/", {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, engine: "paddleocr" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(payload.ok, true);
  assert.equal(request.url, "http://127.0.0.1:8765/health");
  assert.equal(request.options.targetAddressSpace, "loopback");
  assert.equal(request.options.cache, "no-store");
});

test("blocked loopback access explains both service and Chrome permission recovery", async () => {
  await assert.rejects(
    probeLocalServiceDocumentAccess("http://localhost:8765", {
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); }
    }),
    /确认服务已启动.*访问本机设备.*允许/u
  );
});

test("document probe rejects non-loopback service addresses", async () => {
  await assert.rejects(
    probeLocalServiceDocumentAccess("https://example.com"),
    /必须使用 http:\/\/127\.0\.0\.1 或 http:\/\/localhost/u
  );
});
