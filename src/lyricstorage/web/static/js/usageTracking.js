import { api } from "./api.js";

// 게임 플레이타임처럼, 이 탭이 "사용 중"이었던 시간을 30초마다 서버에 알린다.
// 탭이 보이는 동안은 물론, 탭이 백그라운드로 넘어가도 음악이 계속 재생 중이면
// (모바일에서 화면을 끄거나 다른 앱으로 전환해도 오디오는 계속 흐름) 그동안도
// "사용 중"으로 친다 — 반대로 탭이 보이지도 않고 재생 중도 아니면 그때만 끊는다.
// 페이지를 떠날 때(pagehide)도 그때까지 쌓인 조각을 곧바로 흘려보내, 하트비트
// 주기 도중에 닫아도 최대 30초 이내로만 유실된다. 여러 탭을 동시에 띄워두면
// 각 탭이 독립적으로 재는 시간이 그대로 더해져 실제보다 부풀 수 있다 — 흔한
// 사용 패턴은 아니라 감안한다.
const PING_INTERVAL_MS = 30_000;

export function setupUsageTracking(player) {
  function isActive() {
    return document.visibilityState === "visible" || player.isPlaying();
  }

  let segmentStart = isActive() ? Date.now() : null;
  let timer = null;

  function flush() {
    if (segmentStart == null) return;
    const elapsed = Date.now() - segmentStart;
    segmentStart = Date.now();
    if (elapsed < 1000) return;
    api.pingUsage(elapsed);
  }

  // 탭 표시 여부/재생 상태 중 뭐가 바뀌든 이 하나로 다시 판단한다 — 예를 들어
  // 탭이 보이는 채로 재생을 멈춰도, 재생 중인 채로 탭을 숨겨도 계속 "사용
  // 중"이어야 하므로 두 이벤트를 각각 다르게 다룰 필요가 없다. 이미 사용 중이던
  // 구간은(예: 탭을 숨겼지만 재생 중이라 계속 사용 중) 끊지 않고 그대로 이어간다.
  function sync() {
    if (isActive()) {
      if (segmentStart == null) segmentStart = Date.now();
      if (!timer) timer = setInterval(flush, PING_INTERVAL_MS);
    } else {
      flush();
      segmentStart = null;
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener("visibilitychange", sync);
  player.addEventListener("playstate", sync);
  window.addEventListener("pagehide", flush);
  if (segmentStart != null) timer = setInterval(flush, PING_INTERVAL_MS);
}
