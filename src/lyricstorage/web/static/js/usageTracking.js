import { api } from "./api.js";

// 게임 플레이타임처럼, 이 탭이 "보이는 상태"였던 시간을 30초마다 서버에 알린다.
// 탭이 백그라운드로 넘어가거나(visibilitychange) 페이지를 떠날 때(pagehide)도
// 그때까지 쌓인 조각을 곧바로 흘려보내, 하트비트 주기 도중에 닫아도 최대
// 30초 이내로만 유실된다. 여러 탭을 동시에 띄워두면 각 탭이 독립적으로 재는
// 시간이 그대로 더해져 실제보다 부풀 수 있다 — 흔한 사용 패턴은 아니라 감안한다.
const PING_INTERVAL_MS = 30_000;

export function setupUsageTracking() {
  let segmentStart = document.visibilityState === "visible" ? Date.now() : null;
  let timer = null;

  function flush() {
    if (segmentStart == null) return;
    const elapsed = Date.now() - segmentStart;
    segmentStart = Date.now();
    if (elapsed < 1000) return;
    api.pingUsage(elapsed);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") {
      segmentStart = Date.now();
      if (!timer) timer = setInterval(flush, PING_INTERVAL_MS);
    } else {
      flush();
      segmentStart = null;
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", flush);
  if (segmentStart != null) timer = setInterval(flush, PING_INTERVAL_MS);
}
