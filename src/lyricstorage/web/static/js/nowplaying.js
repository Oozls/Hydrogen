import { api } from "./api.js";
import { setIcon } from "./icons.js";
import { applyMarquee } from "./marquee.js";
import { showArtSpinner } from "./artspinner.js";

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
  const artistEl = document.getElementById("now-playing-artist");
  const albumSepEl = document.getElementById("now-playing-album-sep");
  const albumBtn = document.getElementById("now-playing-album");
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
      artwork: [{ src: api.artUrl(track.track_id) }],
    });
  }

  function updateAlbumLink(track) {
    const album = track && track.album;
    albumBtn.hidden = !album;
    albumSepEl.hidden = !album;
    albumBtn.textContent = album || "";
  }

  function setTrack(track, { bustArtCache = false } = {}) {
    if (!track) {
      titleEl.textContent = "재생 중인 곡 없음";
      artistEl.textContent = "플레이리스트에서 곡을 선택하세요";
      artEl.style.display = "none";
      artPlaceholder.style.display = "";
      updateAlbumLink(null);
      requestAnimationFrame(() => applyMarquee(nowPlayingTextEl));
      updateMediaSessionMetadata(null);
      return;
    }
    titleEl.textContent = track.title || "제목 없음";
    artistEl.textContent = track.artist || "아티스트 미상";
    updateAlbumLink(track);
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
    artEl.src = api.artUrl(track.track_id) + (bustArtCache ? `?t=${Date.now()}` : "");
    requestAnimationFrame(() => applyMarquee(nowPlayingTextEl));
    updateMediaSessionMetadata(track);
  }

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => applyMarquee(nowPlayingTextEl), MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  player.addEventListener("trackchange", (e) => setTrack(e.detail.track));

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

  playPauseBtn.addEventListener("click", () => player.togglePlayPause());
  prevBtn.addEventListener("click", () => player.previousTrack());
  nextBtn.addEventListener("click", () => player.nextTrack());
  shuffleBtn.addEventListener("click", () => player.setShuffle(!player.shuffle));
  repeatBtn.addEventListener("click", () => player.cycleRepeat());
  if (onOpenAlbum) {
    albumBtn.addEventListener("click", () => onOpenAlbum(player.currentTrack));
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

  return { setTrack, updateVolumeFill: () => updateRangeFill(volumeSlider) };
}
