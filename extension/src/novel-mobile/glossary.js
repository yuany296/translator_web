/**
 * 手机版术语库页入口。
 *
 * 装配与 glossary/index.js 一致（同一份 glossaryInstallers），区别只在装配完成后加一层
 * 本地化覆盖：编辑器把首屏加载挂在 DOMContentLoaded 上，晚于本脚本执行，所以覆盖一定
 * 赶在第一次读术语库之前生效。
 */
import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import { glossaryInstallers } from "../glossary/modules/index.js";
import { applyGlossaryLocal } from "./glossary-local.js";

const params = new URLSearchParams(location.search);
const embedded = params.get("embedded") === "1";
if (!embedded) {
  location.replace(chrome.runtime.getURL("settings.html#glossary"));
} else {
  document.documentElement.classList.add("embedded");
  const runtime = Object.assign(Object.create(null), { glossaryCore, termDiscoveryCore });
  runtime.initialView = "list";
  for (const install of glossaryInstallers) install(runtime);
  applyGlossaryLocal(runtime);
  globalThis.__MT_NOVEL_MOBILE_GLOSSARY__ = runtime;
}
