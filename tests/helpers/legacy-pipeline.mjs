import { createCanonicalRuntime } from "../../extension/src/canonical/pipeline.js";
import { installPipelineLegacyExec } from "./pipeline-legacy-exec.mjs";
import { installPipelineLegacySetup } from "./pipeline-legacy-setup.mjs";

export function createLegacyPipelineForTest(adapters) {
  const runtime = createCanonicalRuntime();
  const scope = Object.assign(Object.create(null), { adapters });
  installPipelineLegacySetup(runtime, scope);
  installPipelineLegacyExec(runtime, scope);
  return scope.result;
}
