/**
 * 本地 OCR 服务**永久性故障**的判据与提示文案（唯一真源）。
 *
 * 错误文本来自后台 OCR provider（契约不匹配 / 服务未启动 / 上下文失效），
 * 判定与提示在内容脚本侧落地（`content/modules/ocr-service-fault.js`）。
 * 与"临时失败"分开：单页识别失败、队列超时值得自动重试；永久故障（契约版本不匹配、
 * 服务没启动、扩展上下文失效）重试一万次也不会好。以前两者走同一条重试路径，
 * 症状是「loading 卡 0.5~1.5 秒一轮无限闪烁、且没有任何提示」（自动模式不弹错误）。
 * 现场：扩展升到 v12、服务还是 v11 → 每个请求 409 contract mismatch → 无限闪烁。
 */
const FAULT_MESSAGES = Object.freeze({
  mismatch: "本地 OCR 服务版本与扩展不一致，请重启 local-ocr-service 后重试",
  offline: "本地 OCR 服务不可用，请启动 local-ocr-service 后重试",
  invalidated: "扩展已重新加载，请刷新漫画页后重试"
});

const FAULT_PATTERNS = Object.freeze([
  { kind: "mismatch", pattern: /本地 OCR 服务版本过旧|contract mismatch|Local OCR request failed:\s*409/u },
  { kind: "offline", pattern: /本地 OCR 服务不可用|Failed to fetch|ECONNREFUSED|Could not establish connection/iu },
  { kind: "invalidated", pattern: /extension context invalidated/iu }
]);

/** 永久性故障 → 返回种类（mismatch/offline/invalidated），否则返回空串。 */
export function classifyPermanentServiceFault(message) {
  const raw = String(message || "");
  if (!raw) return "";
  const hit = FAULT_PATTERNS.find(item => item.pattern.test(raw));
  return hit ? hit.kind : "";
}

export function isPermanentServiceFault(message) {
  return classifyPermanentServiceFault(message) !== "";
}

/** 给用户的**可操作**提示（不是把原始错误原样吐出来）。 */
export function describeServiceFault(message) {
  const kind = classifyPermanentServiceFault(message);
  return FAULT_MESSAGES[kind] || "";
}

export default Object.freeze({ classifyPermanentServiceFault, isPermanentServiceFault, describeServiceFault, FAULT_MESSAGES });
