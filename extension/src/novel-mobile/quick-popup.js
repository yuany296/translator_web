/**
 * 手机版快捷弹窗入口：先加载原弹窗模块（事件绑定与首屏加载都在里面），再做手机版精简。
 *
 * controller.js 的同步部分只绑定事件，真正的 GET_CONFIGURATION 异步加载排在后面，
 * 所以这里同步执行的隐藏/改名能赶在首屏渲染之前生效。
 */
import "../quick-popup/index.js";
import { injectNovelMobileStyles } from "./styles.js";
import { applyNovelMobilePopup } from "./popup-local.js";

injectNovelMobileStyles();
applyNovelMobilePopup();
