export function installContent32(runtime) {
  // 初始化 Kakao 管线 Store（如可用）
  if (runtime.KP && typeof runtime.KP.createStore === "function") {
    runtime.state.kakaoStore = runtime.KP.createStore();
  }
}
