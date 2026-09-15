/**
 * Terminal-feedback wrapper for novel actions.
 *
 * "In progress" is never written into the text overlay (that would make the
 * user believe the task finished when the 2.5s timer expires). Instead the
 * action only drives the floating ball during its runtime, and this helper
 * guarantees that a terminal overlay (success / error) is emitted on *every*
 * exit path: success, returned-failure and thrown exception. `working` is
 * cleared in `finally` so it can never leak.
 */
export function installNovelActionFeedback(runtime) {
  function buildTerminalFeedback(action, result) {
    if (action !== "text" && action !== "image") return null;
    const failed = result?.ok === false;
    const error = String(result?.error || "").trim();
    if (action === "text") {
      return failed
        ? { level: "error", message: `强制重新翻译正文失败：${error || "未知错误"}` }
        : { level: "success", message: "正文已重新翻译完成" };
    }
    return failed
      ? { level: "error", message: `强制重新处理图片失败：${error || "未知错误"}` }
      : { level: "success", message: "正文图片已重新处理完成" };
  }

  function errorText(error) {
    if (runtime.getErrorMessage) return runtime.getErrorMessage(error);
    return (error && error.message) || String(error || "") || "未知错误";
  }

  /**
   * Run a novel action under the floating ball's working state and always emit
   * a terminal overlay. `action` is "text" | "image" | "detect".
   */
  async function runNovelActionWithFeedback(action, run, onDone) {
    runtime.state.novelActionWorking = action;
    runtime.updateFloatingBallState?.();
    try {
      const result = await run();
      if (!result?.reused) {
        const feedback = buildTerminalFeedback(action, result);
        if (feedback) runtime.showFloatingBallFeedback?.(feedback.message, feedback.level);
      }
      return result;
    } catch (error) {
      const feedback = buildTerminalFeedback(action, { ok: false, error: errorText(error) });
      if (feedback) runtime.showFloatingBallFeedback?.(feedback.message, feedback.level);
      throw error;
    } finally {
      runtime.state.novelActionWorking = null;
      runtime.updateFloatingBallState?.();
      onDone?.();
    }
  }
  runtime.runNovelActionWithFeedback = runNovelActionWithFeedback;
}
