import { installStoreState } from "../page-store-factory/store-state.js";
import { installStoreMethods } from "../page-store-factory/store-methods.js";
import { installStoreCanonical } from "../page-store-factory/store-canonical.js";

export function installPageStoreBridge(runtime) {
  const installers = [installStoreState, installStoreMethods, installStoreCanonical];
  runtime.createStore = function createStore(...args) {
    const scope = Object.assign(Object.create(null), {  });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
