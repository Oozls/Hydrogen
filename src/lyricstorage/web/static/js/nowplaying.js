import { api } from "./api.js";
import { setIcon } from "./icons.js";

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

export function setupNowPlaying(player) {
  const artEl = document.getElementById("now-playing-art");
  const artPlaceholder = document.getElementById("now-playing-art-placeholder");
  const titleEl = document.getElementById("now-playing-title");
  const artistEl = document.getElementById("now-playing-artist");

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

  function setTrack(track, { bustArtCache = false } = {}) {
    if (!track) {
      titleEl.textContent = "재생 중인 곡 없음";
      artistEl.textContent = "플레이리스트에서 곡을 선택하세요";
      artEl.style.display = "none";
      artPlaceholder.style.display = "";
      return;
    }
    titleEl.textContent = track.title || "제목 없음";
    artistEl.textContent = track.artist || "아티스트 미상";
    artEl.onerror = () => {
      artEl.style.display = "none";
      artPlaceholder.style.display = "";
    };
    artEl.onload = () => {
      artEl.style.display = "";
      artPlaceholder.style.display = "none";
    };
    artEl.src = api.artUrl(track.track_id) + (bustArtCache ? `?t=${Date.now()}` : "");
  }

  player.addEventListener("trackchange", (e) => setTrack(e.detail.track));

  player.addEventListener("tick", (e) => {
    if (seeking) return;
    seekSlider.value = String(e.detail.positionMs);
    elapsedLabel.textContent = fmtTime(e.detail.positionMs);
    updateRangeFill(seekSlider);
  });

  player.addEventListener("durationchange", (e) => {
    seekSlider.max = String(Math.max(0, e.detail.durationMs));
    durationLabel.textContent = fmtTime(e.detail.durationMs);
    updateRangeFill(seekSlider);
  });

  player.addEventListener("playstate", (e) => {
    setIcon(playPauseBtn.querySelector(".icon"), e.detail.playing ? "pause" : "play");
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
