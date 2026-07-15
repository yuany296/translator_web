export function installGlossary05(runtime) {
  document.addEventListener("DOMContentLoaded", async () => {
    runtime.bindEvents();
    await Promise.all([runtime.loadGlossary(), runtime.loadTermDiscoveryState(true)]);
  });
}
