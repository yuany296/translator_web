import { canonicalPipeline } from "../canonical/pipeline.js";
import { reconciler } from "../canonical/reconciler.js";
import { contentPhases } from "./modules/index.js";
import { completeContentRuntime, prepareContentRuntime } from "./configure.js";

const existing = globalThis.__MANGA_TRANSLATOR_V3__;
if (existing && !existing.invalidated) {
  existing.rescan?.();
} else {
  const runtime = Object.assign(Object.create(null), {
    KP: canonicalPipeline,
    KR: reconciler
  });
  for (const install of contentPhases.functions) install(runtime);
  prepareContentRuntime(runtime);
  for (const install of contentPhases.state) install(runtime);
  completeContentRuntime(runtime);
  for (const install of contentPhases.startup) install(runtime);
}
