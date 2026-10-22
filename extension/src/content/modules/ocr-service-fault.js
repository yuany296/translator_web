import { classifyPermanentServiceFault, describeServiceFault } from "../../shared/ocr-service-fault.js";

/** 永久性故障的冷却时长：这段时间内不再自动重试（避免 loading 无限闪烁）。 */
const SERVICE_FAULT_COOLDOWN_MS = 60000;

/**
 * 永久性服务故障的**客户端状态机**（唯一写入处）。
 *
 * 为什么需要它：契约不匹配 / 服务未启动这类错误是**永久**的，但恢复扫描（650ms 节流）
 * 与自动重试调度器把每一次失败都当成"再试一次就好"，于是「入队 → 失败 → 清 loading →
 * 再入队」0.5~1.5 秒一轮无限循环，用户只看到闪烁、看不到原因（自动模式不弹错误）。
 * 现在的行为：识别到永久故障时 —— 弹一次可操作提示、停掉本页自动翻译、冷却期内不再
 * 自动入队/重试；OCR 一旦成功（或冷却期满）自动解除，无需刷新页面。
 */
export function installOcrServiceFault(runtime) {
  function isOcrServiceFaultActive(now = Date.now()) {
    return Number(runtime.state.ocrServiceFaultUntil || 0) > Number(now || 0);
  }
  runtime.isOcrServiceFaultActive = isOcrServiceFaultActive;

  function clearOcrServiceFault() {
    runtime.state.ocrServiceFaultUntil = 0;
    runtime.state.ocrServiceFaultKind = "";
    runtime.state.ocrServiceFaultMessage = "";
  }
  runtime.clearOcrServiceFault = clearOcrServiceFault;

  /**
   * 记一次永久故障。返回 true 表示"已按永久故障处理"（调用方不要再走通用错误上报）。
   * 已经在冷却期内时不再重复提示。
   */
  function noteOcrServiceFault(reason) {
    const kind = classifyPermanentServiceFault(reason);
    if (!kind || runtime.state.ocrServiceFaultKind === kind && isOcrServiceFaultActive()) {
      return false;
    }
    runtime.state.ocrServiceFaultKind = kind;
    runtime.state.ocrServiceFaultMessage = String(reason || "").slice(0, 300);
    runtime.state.ocrServiceFaultUntil = Date.now() + SERVICE_FAULT_COOLDOWN_MS;
    const hint = describeServiceFault(reason);
    runtime.showFloatingBallFeedback?.(hint, "error");
    if (runtime.state.autoTranslatePageEnabled) {
      void runtime.togglePageAutoTranslate?.(false);
    }
    void runtime.reportStatus?.("error", hint, { code: "service-fault", faultKind: kind }).catch?.(() => {});
    return true;
  }
  runtime.noteOcrServiceFault = noteOcrServiceFault;
}
