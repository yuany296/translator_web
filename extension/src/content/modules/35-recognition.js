export function installContent35(runtime) {
  const isKakaoPageEdgeSource = runtime.KP.isKakaoPageEdgeSource;

  // Kakao page-edge CDN URLs must include authentication parameters
  // (signature, credential, expires) to be fetchable. If the URL lacks
  // these, wait briefly for the page's JS to inject them.
  runtime.isKakaoPageEdgeSource = isKakaoPageEdgeSource;
  const KAKAO_EDGE_AUTH_PARAM_RE = /[?&](?:signature|credential|expires)=/i;
  runtime.KAKAO_EDGE_AUTH_PARAM_RE = KAKAO_EDGE_AUTH_PARAM_RE;
  const KAKAO_EDGE_URL_WAIT_MS = 600;
  runtime.KAKAO_EDGE_URL_WAIT_MS = KAKAO_EDGE_URL_WAIT_MS;
  const KAKAO_EDGE_URL_POLL_MS = 50;
  runtime.KAKAO_EDGE_URL_POLL_MS = KAKAO_EDGE_URL_POLL_MS;
}
