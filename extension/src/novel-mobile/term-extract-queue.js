/**
 * 手机版整章提取的串行队列 —— 对齐桌面版的 `enqueueExtraction`
 * （见 background/modules/term-discovery-extract.js）。
 *
 * 桌面版有这条队列：整章提取一次只跑一趟，后续请求排队，不会几屏同时压向同一个模型。
 * 手机版此前没有，翻屏快的时候会同时发出多趟提取（每趟自己还在串行分段），
 * 结果就是模型/网络被自己挤爆、分段超时变多 —— 而超时的分段正是「漏术语」的来源
 * （失败分段覆盖的块不算已处理，但重试要等到节流窗口之后）。
 *
 * 队列满（默认 2 趟在途）时不再堆积，直接把这一屏交回内容脚本的 30 秒重试，
 * 与桌面版被 `TERM_EXTRACTOR_THROTTLE_MS` 挡下时的语义一致。
 */
export const MAX_QUEUED_EXTRACTIONS = 2;

export function createTermExtractQueue(maxQueued = MAX_QUEUED_EXTRACTIONS) {
  const limit = Math.max(1, Number(maxQueued) || MAX_QUEUED_EXTRACTIONS);
  let chain = Promise.resolve();
  let inFlight = 0;
  return {
    get active() {
      return inFlight;
    },
    full() {
      return inFlight >= limit;
    },
    /** 排队执行；调用方负责在 `full()` 时改走「稍后重试」。 */
    enqueue(task) {
      inFlight += 1;
      const running = chain.then(task, task).finally(() => {
        inFlight -= 1;
      });
      chain = running.catch(() => undefined);
      return running;
    }
  };
}

export function installTermExtractQueue(runtime, options = {}) {
  const queue = createTermExtractQueue(options.maxQueued);
  runtime.termExtractQueue = queue;
  runtime.isTermExtractQueueFull = () => queue.full();
  runtime.enqueueTermExtraction = task => queue.enqueue(task);
  return queue;
}
