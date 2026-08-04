import { api } from "./api.js";
import { setIcon } from "./icons.js";
import { applyMarquee } from "./marquee.js";
import { showArtSpinner } from "./artspinner.js";
import { openImageLightbox } from "./imageLightbox.js";

const MARQUEE_RESIZE_DEBOUNCE_MS = 150;

function fmtTime(ms) {
  ms = Math.max(0, ms || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// 네이티브 range 트랙의 채워진 부분(값까지)을 --range-progress 퍼센트로 표현해
// theme.css의 그라디언트 트랙 배경이 이를 참조하도록 한다.
function updateRangeFill(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 0;
  const value = Number(el.value) || 0;
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  el.style.setProperty("--range-progress", `${pct}%`);
}

export function setupNowPlaying(player, onOpenAlbum) {
  const artEl = document.getElementById("now-playing-art");
  const artPlaceholder = document.getElementById("now-playing-art-placeholder");
  const titleEl = document.getElementById("now-playing-title");
  const sublineEl = document.querySelector(".now-playing-subline");
  const sublineTextEl = document.getElementById("now-playing-subline-text");
  const nowPlayingTextEl = document.querySelector(".now-playing-text");

  const seekSlider = document.getElementById("seek-slider");
  const elapsedLabel = document.getElementById("elapsed-label");
  const durationLabel = document.getElementById("duration-label");

  const shuffleBtn = document.getElementById("btn-shuffle");
  const prevBtn = document.getElementById("btn-prev");
  const playPauseBtn = document.getElementById("btn-play-pause");
  const nextBtn = document.getElementById("btn-next");
  const repeatBtn = document.getElementById("btn-repeat");
  const repeatBadge = document.getElementById("repeat-badge");

  const muteBtn = document.getElementById("btn-mute");
  const volumeSlider = document.getElementById("volume-slider");

  let seeking = false;
  let lastVolume = Number(volumeSlider.value) || 80;
  let bufferingStopSpin = null;

  // OS/브라우저의 미디어 알림(잠금화면, 알림창, 하드웨어 미디어 키 등)에
  // 현재 재생 중인 곡의 제목/아티스트/앨범아트를 노출하고, 그쪽에서 들어오는
  // 재생/일시정지/이전/다음/탐색 조작을 플레이어에 반영한다.
  const hasMediaSession = "mediaSession" in navigator;
  if (hasMediaSession) {
    navigator.mediaSession.setActionHandler("play", () => player.togglePlayPause());
    navigator.mediaSession.setActionHandler("pause", () => player.togglePlayPause());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.previousTrack());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.nextTrack());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) player.seek(details.seekTime * 1000);
    });
  }

  function updateMediaSessionMetadata(track) {
    if (!hasMediaSession) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "제목 없음",
      artist: track.artist || "아티스트 미상",
      album: track.album || "",
      artwork: [{ src: api.albumArtUrl(track.album_id) }],
    });
  }

  // 아티스트명/앨범명을 한 줄("아티스트 · 앨범")로 합쳐 보여준다. 앨범이 있으면
  // 클릭해서 브라우즈의 해당 앨범 상세로 이동할 수 있다(클릭 대상을 아티스트/
  // 앨범 부분으로 나누지 않고 줄 전체로 단순화).
  function updateSubline(track) {
    const parts = [track && track.artist, track && track.album].filter(Boolean);
    sublineTextEl.textContent = parts.join(" · ");
    sublineEl.classList.toggle("clickable", Boolean(track && track.album && onOpenAlbum));
  }

  function setTrack(track, { bustArtCache = false } = {}) {
    if (!track) {
      titleEl.textContent = "";
      artEl.style.display = "none";
      artPlaceholder.style.display = "";
      updateSubline(null);
      requestAnimationFrame(() => applyMarquee(nowPlayingTextEl));
      updateMediaSessionMetadata(null);
      return;
    }
    titleEl.textContent = track.title || "제목 없음";
    updateSubline(track);
    const stopSpin = showArtSpinner(artEl.parentElement);
    artEl.onerror = () => {
      stopSpin();
      artEl.style.display = "none";
      artPlaceholder.style.display = "";
    };
    artEl.onload = () => {
      stopSpin();
      artEl.style.display = "";
      artPlaceholder.style.display = "none";
    };
    const nextSrc = api.albumArtUrl(track.album_id) + (bustArtCache ? `?t=${Date.now()}` : "");
    // 반복 재생 등으로 같은 트랙이 다시 설정되면 artEl.src가 이미 같은 값이라
    // 브라우저가 새 요청을 보내지 않고, 그러면 load/error 이벤트도 다시 발생하지
    // 않아 방금 띄운 스피너가 영영 사라지지 않는다(특히 이전에 로딩이 실패했던
    // 트랙에서 두드러짐). 이 경우 이벤트를 기다리지 않고 이미 알고 있는 현재
    // 상태로 즉시 처리한다.
    if (artEl.src === new URL(nextSrc, window.location.href).href) {
      if (artEl.complete && artEl.naturalWidth > 0) artEl.onload();
      else artEl.onerror();
    } else {
      artEl.src = nextSrc;
    }
    requestAnimationFrame(() => applyMarquee(nowPlayingTextEl));
    updateMediaSessionMetadata(track);
  }

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => applyMarquee(nowPlayingTextEl), MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  // 추천 큐(홈 화면에서 시작한 라디오 형태의 재생 대기 목록)는 계속 늘어나는
  // 목록이라 셔플/반복 개념이 맞지 않으므로, 그 동안은 버튼을 비활성화한다.
  function updateModeButtonsDisabled() {
    const disabled = player.queueMode === "recommend";
    shuffleBtn.disabled = disabled;
    repeatBtn.disabled = disabled;
  }

  player.addEventListener("trackchange", (e) => {
    setTrack(e.detail.track);
    updateModeButtonsDisabled();
  });

  // durationMs가 아직 0/NaN인 상태(트랙 전환 직후)에는 setPositionState가
  // 예외를 던지므로 유효할 때만 호출한다.
  function updateMediaSessionPosition(positionMs, durationMs) {
    if (!hasMediaSession || !("setPositionState" in navigator.mediaSession)) return;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: durationMs / 1000,
        position: Math.min(positionMs, durationMs) / 1000,
        playbackRate: 1,
      });
    } catch (_err) {
      // 탐색 직후 등 위치가 duration을 잠깐 벗어나는 경우 조용히 무시.
    }
  }

  player.addEventListener("tick", (e) => {
    if (seeking) return;
    seekSlider.value = String(e.detail.positionMs);
    elapsedLabel.textContent = fmtTime(e.detail.positionMs);
    updateRangeFill(seekSlider);
    updateMediaSessionPosition(e.detail.positionMs, player.duration());
  });

  player.addEventListener("durationchange", (e) => {
    seekSlider.max = String(Math.max(0, e.detail.durationMs));
    durationLabel.textContent = fmtTime(e.detail.durationMs);
    updateRangeFill(seekSlider);
    updateMediaSessionPosition(player.position(), e.detail.durationMs);
  });

  player.addEventListener("playstate", (e) => {
    setIcon(playPauseBtn.querySelector(".icon"), e.detail.playing ? "pause" : "play");
    if (hasMediaSession) navigator.mediaSession.playbackState = e.detail.playing ? "playing" : "paused";
  });

  // 트랙 전환/버퍼링으로 재생이 잠시 멎는 동안 커버 위에 로딩 스피너를 겹쳐 보여준다.
  player.addEventListener("buffering", (e) => {
    if (e.detail.buffering) {
      if (!bufferingStopSpin) bufferingStopSpin = showArtSpinner(artEl.parentElement);
    } else if (bufferingStopSpin) {
      bufferingStopSpin();
      bufferingStopSpin = null;
    }
  });

  player.addEventListener("shufflechange", (e) => {
    shuffleBtn.classList.toggle("active", e.detail.shuffle);
  });

  player.addEventListener("repeatchange", (e) => {
    const active = e.detail.repeatMode !== "off";
    repeatBtn.classList.toggle("active", active);
    repeatBadge.textContent = e.detail.repeatMode === "one" ? "1" : "";
  });

  artEl.classList.add("art-clickable");
  artEl.addEventListener("click", () => {
    if (artEl.style.display !== "none") openImageLightbox(artEl.src);
  });

  playPauseBtn.addEventListener("click", () => player.togglePlayPause());
  prevBtn.addEventListener("click", () => player.previousTrack());
  nextBtn.addEventListener("click", () => player.nextTrack());
  shuffleBtn.addEventListener("click", () => player.setShuffle(!player.shuffle));
  repeatBtn.addEventListener("click", () => player.cycleRepeat());
  if (onOpenAlbum) {
    sublineEl.addEventListener("click", () => {
      if (player.currentTrack && player.currentTrack.album) onOpenAlbum(player.currentTrack);
    });
  }

  // 드래그 중에는 재생 위치 갱신이 슬라이더와 다투지 않도록 무시하고,
  // 놓는 순간에만 실제 seek를 커밋한다.
  seekSlider.addEventListener("pointerdown", () => {
    seeking = true;
    player.setSeeking(true);
  });
  seekSlider.addEventListener("pointerup", () => {
    seeking = false;
    player.setSeeking(false);
    player.seek(Number(seekSlider.value));
  });
  seekSlider.addEventListener("input", () => {
    elapsedLabel.textContent = fmtTime(Number(seekSlider.value));
    updateRangeFill(seekSlider);
  });

  volumeSlider.addEventListener("input", () => {
    const value = Number(volumeSlider.value);
    player.setVolume(value);
    setIcon(muteBtn.querySelector(".icon"), value === 0 ? "volume-x" : "volume-2");
    if (value > 0) lastVolume = value;
    updateRangeFill(volumeSlider);
    api.updateSettings({ volume: value }).catch(() => {});
  });

  muteBtn.addEventListener("click", () => {
    if (Number(volumeSlider.value) === 0) {
      volumeSlider.value = String(lastVolume || 80);
    } else {
      lastVolume = Number(volumeSlider.value) || lastVolume;
      volumeSlider.value = "0";
    }
    volumeSlider.dispatchEvent(new Event("input"));
  });

  const SEEK_STEP_MS = 10000;

  // 검색창/가사 편집/페이지 번호 입력 등 텍스트를 입력 중일 때는 스페이스바/
  // 화살표 키가 그 입력에 쓰여야 하므로 단축키를 발동하지 않는다.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(document.activeElement)) return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      player.togglePlayPause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      player.seek(Math.max(0, player.position() - SEEK_STEP_MS));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const target = player.position() + SEEK_STEP_MS;
      const dur = player.duration();
      player.seek(dur > 0 ? Math.min(target, dur) : target);
    }
  });

  return { setTrack, updateVolumeFill: () => updateRangeFill(volumeSlider) };
}
