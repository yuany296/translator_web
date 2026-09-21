/**
 * 手机版：把「模型没翻、照抄了原文」的术语就地换成术语库里的译名。
 *
 * 实现在 shared/term-repair.js —— 桌面版与小批链路现在也吃同一份规则
 * （见 shared/novel.js#validateTranslations 与 background/modules/translation-stream.js），
 * 这里只保留一个转出口，手机版的调用点与既有测试都不用改。
 */
export { repairTermLeftovers, TERM_REPAIR_TAILS } from "../shared/term-repair.js";
