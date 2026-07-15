const hints = Object.freeze([
  { id: "kakao", host: /(^|\.)kakao(?:page)?\.(?:com|net)$/iu, profile: "continuous-strip", weight: 3, selector: "img,canvas" },
  { id: "pixiv", host: /(^|\.)comic\.pixiv\.net$/iu, profile: "virtualized-strip", weight: 2, selector: "img,canvas,[id^='page-']" },
  { id: "cmoa", host: /(^|\.)cmoa\.jp$/iu, profile: "canvas-reader", weight: 2, selector: "img,canvas" }
]);

export function resolveSiteHint(locationValue = globalThis.location) {
  const host = String(locationValue?.hostname || "");
  return hints.find((hint) => hint.host.test(host)) || Object.freeze({
    id: "generic", profile: "independent-media", weight: 0, selector: "img,canvas"
  });
}
