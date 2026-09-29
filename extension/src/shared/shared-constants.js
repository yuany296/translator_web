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
