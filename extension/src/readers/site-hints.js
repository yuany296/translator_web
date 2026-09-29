import { RIDI_HOST_RE } from "../shared/novel-hosts.js";

/**
 * 分片长条阅读器（tiledStrip）：站点把整章当作一张长条图按固定尺寸切片
 * （KakaoPage 760x1000、RIDI 1280x1280），分片边界与 Publisher 的页边界无关，
 * 跨边界台词必须靠接缝 OCR 才能完整识别与遮盖。
 *
 * RIDI 与 KakaoPage 共用同一个 hint 工厂：能力集（profile/selector/tiledStrip）
 * 只有一个定义，两边不可能再分叉。RIDI 复用 KakaoPage 的处理在这里是结构事实，
 * 而不是靠手工同步两份字段。
 *
 * RIDI 的域名正则来自 shared/novel-hosts.js：同一家站点在「分片长条」与「小说
 * 阅读器」两套判据里必须是同一个正则，否则只改得到其中一处。
 */
const stripTileHint = (id, host) => Object.freeze({
  id, host, profile: "continuous-strip", weight: 3, selector: "img,canvas", tiledStrip: true
});

const hints = Object.freeze([
  stripTileHint("kakao", /(^|\.)kakao(?:page)?\.(?:com|net)$/iu),
  stripTileHint("ridi", RIDI_HOST_RE),
  { id: "pixiv", host: /(^|\.)comic\.pixiv\.net$/iu, profile: "virtualized-strip", weight: 2, selector: "img,canvas,[id^='page-']", tiledStrip: false },
  { id: "cmoa", host: /(^|\.)cmoa\.jp$/iu, profile: "canvas-reader", weight: 2, selector: "img,canvas", tiledStrip: false }
]);

export function resolveSiteHint(locationValue = globalThis.location) {
  const host = String(locationValue?.hostname || "");
  return hints.find((hint) => hint.host.test(host)) || Object.freeze({
    id: "generic", profile: "independent-media", weight: 0, selector: "img,canvas", tiledStrip: false
  });
}
