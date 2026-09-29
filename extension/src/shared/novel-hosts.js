/**
 * 「这个站点有小说阅读器」的唯一判据。
 *
 * 桌面内容脚本在两个时机都要问这个问题，而两处的 runtime 状态并不同步：
 *   1. 装配期（functions 阶段）——`novel-focus-click` 决定要不要挂 document 级监听；
 *   2. state 阶段——`reader-state` 把 `IS_*_READER` 写进 runtime 供其它模块读。
 * 两处若各写一份站点名单，就会在某个时机悄悄少一家。RIDI 小说正是这么漏掉的：
 * 装配期读不到 state 阶段才写的标志，于是「点原文打开修订面板」在真机上从未挂载。
 * 名单只留在这里，两个时机都从这里取。
 */
export const KAKAO_HOST_RE = /(^|\.)(?:page\.kakao\.com|kakaopage\.com|page\.kakaocdn\.net)$/iu;
export const RIDI_HOST_RE = /(^|\.)ridibooks\.com$/iu;

export function isKakaoReaderHost(hostname) {
  return KAKAO_HOST_RE.test(String(hostname || ""));
}

export function isRidiReaderHost(hostname) {
  return RIDI_HOST_RE.test(String(hostname || ""));
}

export function isNovelReaderHost(hostname) {
  return isKakaoReaderHost(hostname) || isRidiReaderHost(hostname);
}

export default Object.freeze({
  KAKAO_HOST_RE,
  RIDI_HOST_RE,
  isKakaoReaderHost,
  isRidiReaderHost,
  isNovelReaderHost
});
