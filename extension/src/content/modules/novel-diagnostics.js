export function installNovelDiagnostics(runtime) {
  function collectTextDiagnostics(state, response) {
    if (!Array.isArray(response && response.diagnostics)) return;
    state.textDiagnostics.push(...response.diagnostics);
    state.textDiagnostics = state.textDiagnostics.slice(-160);
  }
  runtime.collectTextDiagnostics = collectTextDiagnostics;

  function publishTextDiagnostics(state, finalErrors, finalWarnings) {
    const observedErrors = state.textDiagnostics.flatMap(item =>
      Array.isArray(item && item.validationErrors) ? item.validationErrors : []
    );
    const requestFailures = state.textDiagnostics
      .filter(item => ["request_failed", "parse_failed"].includes(item && item.status))
      .map(item => ({
        id: Array.isArray(item.itemIds) ? item.itemIds.join(",") : "",
        code: item.status,
        error: item.error || ""
      }));
    const summary = runtime.novelCore.summarizeTranslationErrors([
      ...observedErrors,
      ...requestFailures
    ]);
    const warningSummary = runtime.novelCore.summarizeTranslationWarnings(finalWarnings);
    state.lastTextErrors = runtime.novelCore.summarizeTranslationErrors(finalErrors).errors;
    state.progress.textDiagnostic = summary.text;
    state.progress.textWarning = warningSummary.text;
    state.progress.textDiagnosticDetails = {
      finalErrors: state.lastTextErrors,
      finalWarnings: warningSummary.warnings,
      observedErrors: summary.errors,
      attempts: state.textDiagnostics
    };
    console.info("[MangaTranslator] Novel text diagnostics", state.progress.textDiagnosticDetails);
  }
  runtime.publishTextDiagnostics = publishTextDiagnostics;
}
