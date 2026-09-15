import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import novelMemoryCore from "../shared/novel-memory.js";
import { glossaryInstallers } from "./modules/index.js";

const params = new URLSearchParams(location.search);
const embedded = params.get("embedded") === "1";
if (!embedded) {
  location.replace(chrome.runtime.getURL("settings.html#glossary"));
} else {
  document.documentElement.classList.add("embedded");
  const runtime = Object.assign(Object.create(null), { glossaryCore, termDiscoveryCore, novelMemoryCore });
  // 设置页的「小说记忆」分区就是嵌这一页（?view=memory）：直接落在记忆视图，并藏掉页面标题与返回。
  runtime.initialView = params.get("view") === "memory" ? "memory" : "list";
  document.documentElement.classList.toggle("embed-memory", runtime.initialView === "memory");
  for (const install of glossaryInstallers) install(runtime);
}
