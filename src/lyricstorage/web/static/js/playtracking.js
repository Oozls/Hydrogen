import { api } from "./api.js";

// 곡 길이 정보가 없을 때만 쓰는 폴백 임계값(ms).
const THRESHOLD_MS = 10_000;
// 진행 중인 재생 구간을 주기적으로 정산해 스킵 전에도 기록 조건을 확인한다.
const CHECK_INTERVAL_MS = 1_000;

function requiredMs(track) {
  return track && track.duration_ms > 0 ? track.duration_ms * 0.9 : THRESHOLD_MS;
}

export function setupPlayTracking(player) {
  let sessionTrack = null;
  let accumulatedMs = 0;
  let fired = false;
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

  const maybeFire = () => {
    if (fired || !sessionTrack) return;
    if (accumulatedMs >= requiredMs(sessionTrack)) {
      fired = true;
      api
        .logPlay(sessionTrack.track_id, sessionTrack.title, sessionTrack.artist, sessionTrack.album, Math.round(accumulatedMs))
        .catch(() => {});
    }
  };

  const resetSession = (track) => {
    closeSegment(Date.now());
    sessionTrack = track;
    accumulatedMs = 0;
    fired = false;
    segmentStartWallMs = null;
    openSegmentIfEligible(Date.now());
  };

  player.addEventListener("trackchange", () => resetSession(player.currentTrack));
  player.addEventListener("playstate", (e) => {
    if (e.detail.playing) openSegmentIfEligible(Date.now());
    else {
      closeSegment(Date.now());
      maybeFire();
    }
  });
  player.addEventListener("seeking", (e) => {
    if (e.detail.seeking) {
      closeSegment(Date.now());
      maybeFire();
    } else {
      openSegmentIfEligible(Date.now());
    }
  });
  player.addEventListener("ended", () => {
    closeSegment(Date.now());
    maybeFire();
  });

  setInterval(() => {
    if (segmentStartWallMs == null) return;
    const now = Date.now();
    closeSegment(now);
    maybeFire();
    openSegmentIfEligible(now);
  }, CHECK_INTERVAL_MS);
}
