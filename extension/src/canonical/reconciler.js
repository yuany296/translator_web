import { reconcilerInstallers } from "./reconciler-modules/index.js";

export function createReconcilerRuntime() {
  const runtime = Object.create(null);
  for (const install of reconcilerInstallers) install(runtime);
  return runtime;
}

export const reconcilerRuntime = createReconcilerRuntime();
export const reconciler = reconcilerRuntime.api;
