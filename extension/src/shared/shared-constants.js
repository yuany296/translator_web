/**
 * 跨模块共用的零散常量：**同一含义只在这里定义一次**。
 *
 * 这里只放"两个模块必须对同一个数/同一个字符串达成一致、否则功能静默失效"的东西 ——
 * 各写一份、改一处漏一处时不会报错，只会坏（截断尺寸对不上、面板打不开但无任何提示）。
 */

/**
 * 送给 OCR 的位图最长边（超过就等比缩小）。
 * 背景采集与内容侧缩放必须取同一个数：两边不一致会出现"内容按 A 尺寸算坐标、
 * 后台按 B 尺寸裁图"的错位。
 */
export const IMAGE_MAX_SIDE = 1536;

/**
 * 小说「章节译文管理」面板的 port 名与握手消息类型。
 * 侧栏发起 `chrome.runtime.connect({ name })`，后台据此认领并回握手；
 * 两边字符串不一致时面板打不开，而且没有任何报错。
 */
export const MT_NOVEL_PANEL_PORT = "mt-manage-panel";
export const MT_NOVEL_PANEL_HELLO = "mt-manage-panel-hello";

/**
 * OCR 识别的**硬下限**：低于这个分数的识别结果一律丢弃，不看文本是否有意义、不看面积。
 *
 * 它是「两处必须一致」的那类常量：
 *  - 后台结果筛选 `getOcrWordDropReason`（`ocr-candidates.js`）用它做低分例外的门槛
 *    —— 分数低于它 → 丢；分数在它与用户阈值之间 → 只有「实打实的目标语言文字 + 够长 +
 *    面积正常」才放行（带ルビ的竖排台词整行平均分被ルビ拖低，正文本体却很清楚）。
 *  - 送给本地服务的 `text_rec_score_thresh`（`getLocalOcrParams`，`ocr-item-filter.js`）
 *    用的是它，**不是**用户阈值：服务端 `crop_recognition._run_slice_ocr_pipeline` 会拿
 *    这个字段硬切识别结果，分数低于它的一律不进 `items`。以前这里传的是用户阈值
 *    （默认 0.72），而 PP-OCR 对竖排长句给的是**整行平均分**（一个字差就掉到 0.70），
 *    于是「明明很清晰的台词」在服务侧就被删了，结果筛选里那条例外根本没机会生效。
 */
export const OCR_RECOGNITION_SCORE_FLOOR = 0.4;

