import { api } from "./api.js";

// 곡 길이 정보가 없을 때만 쓰는 폴백 임계값(ms).
const THRESHOLD_MS = 10_000;
// 진행 중인 재생 구간을 주기적으로 정산해 스킵 전에도 기록 조건을 확인한다.
const CHECK_INTERVAL_MS = 1_000;

function requiredMs(track) {
  return track && track.duration_ms > 0 ? track.duration_ms * 0.3 : THRESHOLD_MS;
}

export function setupPlayTracking(player) {
  let sessionTrack = null;
  let accumulatedMs = 0;
  let segmentStartWallMs = null;

  const closeSegment = (nowMs) => {
    if (segmentStartWallMs != null) {
      accumulatedMs += nowMs - segmentStartWallMs;
      segmentStartWallMs = null;
    }
  };

  const openSegmentIfEligible = (nowMs) => {
    if (sessionTrack && player.isPlaying()) segmentStartWallMs = nowMs;
  };

  // 세션이 끝날 때(트랙 전환/종료) 딱 한 번, 그때까지 누적된 실제 청취 시간
  // 전체를 기록한다. 예전엔 임계값(30%)을 처음 넘는 순간 그 시점의 누적치만
  // 스냅샷으로 기록하고 이후 계속 들어도 다시 기록하지 않아, 곡을 끝까지
  // 들어도 재생 시간이 임계값 근처(예: 3분곡이면 약 54초)로 잘려 나갔다.
  const flushSession = () => {
    if (sessionTrack && accumulatedMs >= requiredMs(sessionTrack)) {
      api
        .logPlay(sessionTrack.track_id, sessionTrack.title, sessionTrack.artist, sessionTrack.album, Math.round(accumulatedMs))
        .catch(() => {});
    }
    accumulatedMs = 0;
  };

  const resetSession = (track) => {
    closeSegment(Date.now());
    flushSession();
    sessionTrack = track;
    segmentStartWallMs = null;
    openSegmentIfEligible(Date.now());
  };

  player.addEventListener("trackchange", () => resetSession(player.currentTrack));
  player.addEventListener("playstate", (e) => {
    if (e.detail.playing) openSegmentIfEligible(Date.now());
    else closeSegment(Date.now()); // 일시정지는 세션을 끝내지 않음 — 다시 재생하면 이어서 누적
  });
  player.addEventListener("seeking", (e) => {
    if (e.detail.seeking) closeSegment(Date.now());
    else openSegmentIfEligible(Date.now());
  });
  player.addEventListener("ended", () => {
    // 반복 없음으로 마지막 곡이 끝나 다음 트랙 전환이 없는 경우를 위한 마지막
    // 보루. 뒤이어 trackchange(반복재생/다음 곡 자동재생)가 나면 그때는 이미
    // accumulatedMs가 0이라 flushSession이 다시 불려도 아무 일도 안 일어난다.
    closeSegment(Date.now());
    flushSession();
  });

  setInterval(() => {
    if (segmentStartWallMs == null) return;
    const now = Date.now();
    closeSegment(now);
    openSegmentIfEligible(now);
  }, CHECK_INTERVAL_MS);
}
