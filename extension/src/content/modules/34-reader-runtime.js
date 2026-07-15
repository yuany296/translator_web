export function installContent34(runtime) {
  globalThis.__MANGA_TRANSLATOR_V3__ = runtime.api;
  runtime.init().catch(error => {
    console.warn("[MangaTranslator] content init failed:", error);
  });
}
