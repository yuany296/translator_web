import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import Utils from "../shared/utils.js";
import { backgroundPhases } from "./modules/index.js";
import { configureBackgroundRuntime } from "./configure.js";

export function createBackgroundRuntime(overrides = {}) {
  const runtime = Object.assign(Object.create(null), {
    glossaryCore,
    termDiscoveryCore,
    Utils
  }, overrides);
  for (const install of [...backgroundPhases.functions, ...backgroundPhases.state]) install(runtime);
  configureBackgroundRuntime(runtime);
  for (const install of backgroundPhases.startup) install(runtime);
  return runtime;
}

export const backgroundRuntime = createBackgroundRuntime();
