/**
 * 手机版设置页入口：先加载原设置页模块（绑定与首屏加载都在里面），再做手机版精简。
 *
 * controller.js 的同步部分只做事件绑定和读取元素，真正的 GET_CONFIGURATION 异步加载
 * 排在后面，所以这里同步执行的隐藏/改名能赶在首屏渲染之前生效。
 */
import "../settings/index.js";
import { applyNovelMobileSettings } from "./settings-local.js";

applyNovelMobileSettings();
