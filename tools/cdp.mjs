// Chrome DevTools Protocol 辅助脚本（需 Chrome 以 --remote-debugging-port 启动）
// 用法：
//   node tools/cdp.mjs list                             列出所有标签页
//   node tools/cdp.mjs eval  <标签id或url片段> "<JS>"    在页面里执行 JS 并打印结果
//   node tools/cdp.mjs shot <标签id或url片段> <out.png>  截取页面截图
//   node tools/cdp.mjs nav  <标签id或url片段> <url>      导航到 url
// 环境变量 CDP_PORT 可改端口（默认 9222）。
import fs from "node:fs";

const PORT = process.env.CDP_PORT || "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

function findTab(list, query) {
  if (!query) return list.find(tab => tab.type === "page") || list[0];
  const q = String(query).toLowerCase();
  return list.find(tab => String(tab.id).toLowerCase() === q.toLowerCase())
    || list.find(tab => `${tab.title} ${tab.url}`.toLowerCase().includes(q));
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise(resolve => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); }
  };
}

async function main() {
  const [command, query, extra] = process.argv.slice(2);
  const list = await getJson("/json/list");
  if (command === "list") {
    for (const tab of list) {
      console.log(`${tab.type}\t${tab.id}\t${tab.title}\t${tab.url}`);
    }
    return;
  }
  const tab = findTab(list, query);
  if (!tab) throw new Error(`tab not found for: ${query}`);
  const cdp = await attach(tab.webSocketDebuggerUrl);
  try {
    if (command === "eval") {
      if (!extra) throw new Error("eval requires a JS expression");
      const reply = await cdp.send("Runtime.evaluate", {
        expression: extra,
        returnByValue: true,
        awaitPromise: true
      });
      const value = reply.result && reply.result.result;
      console.log(JSON.stringify(value && value.value !== undefined ? value.value : reply, null, 2));
    } else if (command === "shot") {
      if (!extra) throw new Error("shot requires an output file");
      await cdp.send("Page.enable");
      const reply = await cdp.send("Page.captureScreenshot", { format: "png" });
      const data = reply.result && reply.result.data;
      if (!data) throw new Error("screenshot failed");
      fs.writeFileSync(extra, Buffer.from(data, "base64"));
      console.log(`saved ${extra}`);
    } else if (command === "nav") {
      if (!extra) throw new Error("nav requires a URL");
      await cdp.send("Page.enable");
      await cdp.send("Page.navigate", { url: extra });
      console.log(`navigated to ${extra}`);
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    cdp.close();
  }
}

main().catch(err => {
  console.error(String(err && err.message || err));
  process.exit(1);
});
