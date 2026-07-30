import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee, applyColumnPriority, createMarqueeClip } from "./marquee.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
}

const DEFAULT_LIMIT = 8;

export function setupTodaySongs(player, playlistApi, onEditTrack, onBulkEdit) {
  const panelEl = document.getElementById("today-panel");
  const listEl = document.getElementById("today-songs-list");
  const rerollBtn = document.getElementById("btn-today-reroll");

  let items = [];

  const rowMenu = setupRowContextMenu({
    onEditTrack: (track) => onEditTrack(track),
    onAddToPlaylist: (track, playlistName) => addTrackToPlaylist(track, playlistName),
    onBulkEdit: (ids) => onBulkEdit(ids),
    getSelectedIds: () => new Set(),
  });

  async function addTrackToPlaylist(track, playlistName) {
    if (!playlistName) return;
    try {
      const updated = await api.addTracksFromLibrary(playlistName, [track.track_id]);
      playlistApi.applyExternalUpdate(updated);
    } catch (err) {
      await alertDialog(err.message);
    }
  }

  function playTrack(track) {
    player.setPlaylist({ name: "오늘의 곡", tracks: items });
    player.playIndex(items.indexOf(track));
  }

  function renderEmpty() {
    listEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "playlist-empty-state";
    empty.textContent = "추천할 곡이 없습니다. 라이브러리에 곡을 먼저 등록해 주세요.";
    listEl.appendChild(empty);
  }

  function renderLoading() {
    listEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    listEl.appendChild(loading);
  }

  function buildRow(track) {
    const li = document.createElement("li");
    li.className = "playlist-row";
    const isPlaying = !!player.currentTrack && player.currentTrack.track_id === track.track_id;
    if (isPlaying) li.classList.add("playing");

    const label = document.createElement("span");
    label.className = "playlist-row-label";

    const titleClip = createMarqueeClip(
      "playlist-row-title-clip",
      "playlist-row-title",
      (isPlaying ? "▶ " : "") + (track.title || track.track_id)
    );
    label.appendChild(titleClip);

    const albumSpan = createMarqueeClip("playlist-row-album", "", track.album || "");
    label.appendChild(albumSpan);

    const artistSpan = createMarqueeClip("playlist-row-artist", "", track.artist || "");
    label.appendChild(artistSpan);

    li.appendChild(label);

    const duration = document.createElement("span");
    duration.className = "playlist-row-duration";
    duration.textContent = fmtDuration(track.duration_ms);
    li.appendChild(duration);

    const playCount = document.createElement("span");
    playCount.className = "playlist-row-playcount";
    playCount.textContent = track.play_count > 0 ? `${track.play_count}회` : "안 들어봄";
    li.appendChild(playCount);

    li.appendChild(createRatingBadge(track.rating));

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "icon-btn playlist-row-more";
    moreBtn.title = "더보기";
    moreBtn.appendChild(iconSpan("more-vertical", "icon-sm"));
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      rowMenu.open(track, e.clientX, e.clientY);
    });
    li.appendChild(moreBtn);

    li.addEventListener("dblclick", () => playTrack(track));
    return li;
  }

  function render() {
    listEl.innerHTML = "";
    if (!items.length) {
      renderEmpty();
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((track) => fragment.appendChild(buildRow(track)));
    listEl.appendChild(fragment);
    requestAnimationFrame(() => {
      applyColumnPriority(listEl);
      applyMarquee(listEl);
    });
  }

  async function load(reroll) {
    renderLoading();
    try {
      const result = await api.getTodaySongs(DEFAULT_LIMIT, reroll);
      items = result.items;
    } catch (err) {
      items = [];
      await alertDialog(err.message);
    }
    render();
  }

  rerollBtn.addEventListener("click", () => load(String(Date.now())));

  player.addEventListener("trackchange", () => {
    if (panelEl.classList.contains("active")) render();
  });

  player.addEventListener("ratingchange", (e) => {
    const match = items.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    if (panelEl.classList.contains("active")) render();
  });

  return {
    show() {
      panelEl.classList.add("active");
      load();
    },
    hide() {
      panelEl.classList.remove("active");
    },
  };
}
