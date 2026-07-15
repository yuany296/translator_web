export function installContent25(runtime) {
  async function runWithConcurrency(taskFactories, parallel) {
    const limit = Math.max(1, Math.min(parallel, taskFactories.length || 1));
    const results = new Array(taskFactories.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < taskFactories.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await taskFactories[index]();
        } catch (error) {
          results[index] = {
            ok: false,
            error: runtime.getErrorMessage(error)
          };
        }
      }
    };
    await Promise.all(Array.from({
      length: limit
    }, () => worker()));
    return results;
  }
  runtime.runWithConcurrency = runWithConcurrency;
  function isTargetVisible(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") return false;
    const rect = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return rect.left < vw && rect.right > 0 && rect.top < vh && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
  }
  runtime.isTargetVisible = isTargetVisible;
}
