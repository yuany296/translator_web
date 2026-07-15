export function installPipeline18(runtime) {
  class CanonicalPageOcrError extends Error {
    constructor(message) {
      super(message);
      this.name = "CanonicalPageOcrError";
    }
  }
  runtime.CanonicalPageOcrError = CanonicalPageOcrError;
  class CanonicalTranslationError extends Error {
    constructor(message) {
      super(message);
      this.name = "CanonicalTranslationError";
    }
  }
  runtime.CanonicalTranslationError = CanonicalTranslationError;
}
