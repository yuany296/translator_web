import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import { glossaryInstallers } from "./modules/index.js";

const params = new URLSearchParams(location.search);
const embedded = params.get("embedded") === "1";
if (!embedded) {
  location.replace(chrome.runtime.getURL("settings.html#glossary"));
} else {
  document.documentElement.classList.add("embedded");
  const runtime = Object.assign(Object.create(null), { glossaryCore, termDiscoveryCore });
  runtime.initialView = "list";
  for (const install of glossaryInstallers) install(runtime);
}
