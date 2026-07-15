import { installPipelineLegacySetup } from "../pipeline-factory/pipeline-legacy-setup.js";
import { installPipelineLegacyExec } from "../pipeline-factory/pipeline-legacy-exec.js";

export function installPipelineBridge(runtime) {
  const installers = [installPipelineLegacySetup, installPipelineLegacyExec];
  runtime.createPipeline = function createPipeline(...args) {
    const scope = Object.assign(Object.create(null), { adapters: args[0] });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
