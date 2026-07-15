import { pipelineInstallers } from "./modules/index.js";
import { reconciler } from "./reconciler.js";

export function createCanonicalRuntime(overrides = {}) {
  const runtime = Object.assign(Object.create(null), overrides);
  for (const install of pipelineInstallers) install(runtime);
  return runtime;
}

export const canonicalRuntime = createCanonicalRuntime({ reconciler });
export const canonicalPipeline = canonicalRuntime.api;
