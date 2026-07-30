import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import novelCore from "../shared/novel.js";
import novelMemoryCore from "../shared/novel-memory.js";
import Utils from "../shared/utils.js";
import { backgroundPhases } from "./modules/index.js";
import { configureBackgroundRuntime } from "./configure.js";

export function createBackgroundRuntime(overrides = {}) {
  const runtime = Object.assign(Object.create(null), {
    glossaryCore,
    termDiscoveryCore,
    novelCore,
    novelMemoryCore,
    Utils
  }, overrides);
  for (const install of [...backgroundPhases.functions, ...backgroundPhases.state]) install(runtime);
  configureBackgroundRuntime(runtime);
  for (const install of backgroundPhases.startup) install(runtime);
  return runtime;
}

export const backgroundRuntime = createBackgroundRuntime();
