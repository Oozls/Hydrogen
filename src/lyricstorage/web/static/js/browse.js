import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
import { fetchNonGlobalPlaylistNames } from "./playlistNames.js";
import { showProgress, setProgress, hideProgress } from "./progress.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function matchesSong(track, q) {
  return `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(q);
}

function matchesAlbum(group, q) {
  return `${group.album} ${group.artist}`.toLowerCase().includes(q);
}

function groupAlbums(tracks) {
  const map = new Map();
  for (const track of tracks) {
    const key = `${track.album} ${track.artist}`;
    if (!map.has(key)) {
      map.set(key, { album: track.album, artist: track.artist, track_id: track.track_id, tracks: [] });
    }
    map.get(key).tracks.push(track);
  }
  return [...map.values()];
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

export function setupBrowse(player, playlistApi, onEditTrack, onEditAlbum, onBulkEdit) {
  const panelEl = document.getElementById("browse-panel");
  const searchInput = document.getElementById("browse-search");
  const tabsEl = document.getElementById("browse-tabs");
  const songsPanel = document.getElementById("browse-songs-panel");
  const albumsPanel = document.getElementById("browse-albums-panel");
  const songsList = document.getElementById("browse-songs-list");
  const albumsList = document.getElementById("browse-albums-list");
  const targetSelect = document.getElementById("browse-target-playlist");
  const bulkEditBtn = document.getElementById("btn-browse-bulk-edit");
  const clearSelectionBtn = document.getElementById("btn-browse-clear-selection");
  const addFileBtn = document.getElementById("btn-browse-add-file");
  const addFolderBtn = document.getElementById("btn-browse-add-folder");
  const fileInput = document.getElementById("browse-file-input");
  const folderInput = document.getElementById("browse-folder-input");

  let tracks = [];
  let mode = "song";
  let playlistNames = [];
  let selectedTrackIds = new Set();
  let lastClickedIndex = null;

  // 선택된 곡이 하나라도 있으면 "선택 모드"로 간주 — 이때만 체크박스가 보이고,
  // 수정자 키 없는 일반 클릭도 체크박스처럼 토글로 동작한다.
  function syncSelectionUI() {
    songsList.classList.toggle("selecting", selectedTrackIds.size > 0);
    bulkEditBtn.disabled = selectedTrackIds.size === 0;
    bulkEditBtn.title =
      selectedTrackIds.size > 0 ? `선택한 ${selectedTrackIds.size}곡 정보 일괄 수정` : "선택한 곡 정보 일괄 수정";
    clearSelectionBtn.hidden = selectedTrackIds.size === 0;
  }

  function playEphemeral(track) {
    if (player.playlist !== playlistApi.getCurrentPlaylist()) {
      player.syncTracks(playlistApi.getCurrentPlaylist());
    }
    player.setPlaylist({ name: "검색 결과", tracks: [track] });
    player.playIndex(0);
  }

  function renderTargetSelect() {
    targetSelect.innerHTML = "";
    if (!playlistNames.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "플레이리스트 없음";
      targetSelect.appendChild(opt);
      targetSelect.disabled = true;
      return;
    }
    targetSelect.disabled = false;
    for (const name of playlistNames) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      targetSelect.appendChild(opt);
    }
  }

  async function refreshPlaylistNames() {
    playlistNames = await fetchNonGlobalPlaylistNames();
    renderTargetSelect();
    const current = playlistApi.getCurrentPlaylist().name;
    if (current && playlistNames.includes(current)) targetSelect.value = current;
  }

  async function addTrackToTarget(track) {
    const target = targetSelect.value;
    if (!target) {
      await alertDialog("먼저 플레이리스트를 만들거나 선택하세요.");
      return;
    }
    try {
      const updated = await api.addTracksFromLibrary(target, [track.track_id]);
      playlistApi.applyExternalUpdate(updated);
    } catch (err) {
      await alertDialog(err.message);
    }
  }

  async function handleUpload(fileList) {
    if (!fileList || !fileList.length) return;
    showProgress(`곡 업로드 중 (${fileList.length}개 파일)`);
    try {
      const result = await api.uploadFiles(fileList, undefined, (fraction) => {
        if (fraction >= 1) {
          showProgress("라이브러리에 추가하는 중...");
          setProgress(null);
        } else {
          setProgress(fraction);
        }
      });
      if (result.skipped && result.skipped.length) {
        await alertDialog(
          "다음 파일을 건너뛰었습니다:\n" +
            result.skipped.map((s) => `${s.filename} (${s.reason})`).join("\n")
        );
      }
      const library = await api.getLibrary();
      tracks = library.tracks;
      render();
    } catch (err) {
      await alertDialog(err.message);
    } finally {
      hideProgress();
    }
  }

  function renderEmpty(container) {
    const empty = document.createElement("div");
    empty.className = "playlist-empty-state";
    empty.textContent = "검색 결과가 없습니다.";
    container.appendChild(empty);
  }

  function renderSongs() {
    const validIds = new Set(tracks.map((t) => t.track_id));
    for (const id of selectedTrackIds) {
      if (!validIds.has(id)) selectedTrackIds.delete(id);
    }

    const q = searchInput.value.trim().toLowerCase();
    songsList.innerHTML = "";
    syncSelectionUI();

    const filtered = tracks.filter((t) => matchesSong(t, q));
    if (!filtered.length) {
      renderEmpty(songsList);
      return;
    }

    // 셔프트/컨트롤/롱프레스로 선택된 항목이 바뀔 때마다 목록 전체를 다시 그리지
    // 않고 해당 행만 직접 갱신한다 — 롱프레스 타이머 콜백이 목록을 재생성하면
    // 이어지는 pointerup의 네이티브 click이 이미 사라진(재생성된) 옛 요소에서
    // 발생해 선택이 곧바로 토글되어버리는 문제를 피하기 위함이다.
    const rows = [];
    function applySelection(index, selected) {
      const row = rows[index];
      if (selected) selectedTrackIds.add(row.track.track_id);
      else selectedTrackIds.delete(row.track.track_id);
      row.li.classList.toggle("selected", selected);
      row.checkbox.checked = selected;
      syncSelectionUI();
    }

    filtered.forEach((track, i) => {
      const li = document.createElement("li");
      li.className = "playlist-row";
      const selected = selectedTrackIds.has(track.track_id);
      if (selected) li.classList.add("selected");

      const checkboxWrap = document.createElement("label");
      checkboxWrap.className = "row-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "row-checkbox-input";
      checkbox.checked = selected;
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        applySelection(i, checkbox.checked);
        lastClickedIndex = i;
      });
      checkboxWrap.appendChild(checkbox);
      const checkboxBox = document.createElement("span");
      checkboxBox.className = "row-checkbox-box";
      checkboxWrap.appendChild(checkboxBox);
      li.appendChild(checkboxWrap);

      const label = document.createElement("span");
      label.className = "playlist-row-label";
      const titleSpan = document.createElement("span");
      titleSpan.className = "playlist-row-title";
      titleSpan.textContent = track.title || track.track_id;
      label.appendChild(titleSpan);
      if (track.artist) {
        const artistSpan = document.createElement("span");
        artistSpan.className = "playlist-row-artist";
        artistSpan.textContent = track.artist;
        label.appendChild(artistSpan);
      }
      li.appendChild(label);

      const duration = document.createElement("span");
      duration.className = "playlist-row-duration";
      duration.textContent = fmtDuration(track.duration_ms);
      li.appendChild(duration);

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "icon-btn playlist-row-add";
      addBtn.title = "재생목록에 추가";
      addBtn.appendChild(iconSpan("plus", "icon-sm"));
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        addTrackToTarget(track);
      });
      li.appendChild(addBtn);

      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "icon-btn playlist-row-more";
      moreBtn.title = "곡 정보 수정";
      moreBtn.appendChild(iconSpan("more-vertical", "icon-sm"));
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onEditTrack(track);
      });
      li.appendChild(moreBtn);

      rows.push({ li, checkbox, track });

      // 롱프레스로 선택 모드에 진입한 직후, 같은 클릭(pointerup)에서 발생하는
      // 네이티브 click 이벤트가 선택을 곧바로 되돌리지 않도록 억제 플래그를 둔다.
      let longPressTimer = null;
      let longPressStart = null;
      let longPressFired = false;

      li.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button, input")) return;
        longPressFired = false;
        longPressStart = { x: e.clientX, y: e.clientY };
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          longPressFired = true;
          applySelection(i, true);
          lastClickedIndex = i;
        }, LONG_PRESS_MS);
      });
      const cancelLongPress = () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        longPressStart = null;
      };
      li.addEventListener("pointerup", cancelLongPress);
      li.addEventListener("pointerleave", cancelLongPress);
      li.addEventListener("pointercancel", cancelLongPress);
      li.addEventListener("pointermove", (e) => {
        if (!longPressStart) return;
        const dx = e.clientX - longPressStart.x;
        const dy = e.clientY - longPressStart.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
      });

      li.addEventListener("click", (e) => {
        if (longPressFired) {
          longPressFired = false;
          return;
        }
        if (e.target.closest("button, input")) return;
        if (e.shiftKey && lastClickedIndex !== null) {
          const [start, end] = [lastClickedIndex, i].sort((a, b) => a - b);
          for (let j = start; j <= end; j++) applySelection(j, true);
          lastClickedIndex = i;
        } else if (e.ctrlKey || e.metaKey) {
          applySelection(i, !selectedTrackIds.has(track.track_id));
          lastClickedIndex = i;
        } else if (selectedTrackIds.size > 0) {
          // 선택 모드 중에는 수정자 키 없는 일반 클릭도 체크박스처럼 토글된다.
          applySelection(i, !selectedTrackIds.has(track.track_id));
          lastClickedIndex = i;
        }
      });

      li.addEventListener("dblclick", () => playEphemeral(track));
      songsList.appendChild(li);
    });
  }

  function renderAlbums() {
    const q = searchInput.value.trim().toLowerCase();
    albumsList.innerHTML = "";
    const groups = groupAlbums(tracks).filter((g) => matchesAlbum(g, q));
    if (!groups.length) {
      renderEmpty(albumsList);
      return;
    }
    groups.forEach((group) => {
      const card = document.createElement("div");
      card.className = "media-card media-card-clickable";

      const artWrap = document.createElement("div");
      artWrap.className = "media-card-art-wrap";
      const img = document.createElement("img");
      img.className = "media-card-art";
      img.alt = "";
      img.src = api.artUrl(group.track_id);
      img.onerror = () => {
        img.remove();
        artWrap.appendChild(iconSpan("music", "icon-lg"));
      };
      artWrap.appendChild(img);
      card.appendChild(artWrap);

      const title = document.createElement("div");
      title.className = "media-card-title";
      title.textContent = group.album || "(앨범 없음)";
      card.appendChild(title);

      if (group.artist) {
        const artist = document.createElement("div");
        artist.className = "media-card-artist";
        artist.textContent = group.artist;
        card.appendChild(artist);
      }

      const meta = document.createElement("div");
      meta.className = "media-card-meta";
      meta.textContent = `${group.tracks.length}곡`;
      card.appendChild(meta);

      card.addEventListener("click", () => onEditAlbum(group));
      albumsList.appendChild(card);
    });
  }

  function render() {
    if (mode === "song") renderSongs();
    else renderAlbums();
  }

  function switchMode(next) {
    mode = next;
    if (mode !== "song") {
      selectedTrackIds.clear();
      syncSelectionUI();
    }
    songsPanel.classList.toggle("active", mode === "song");
    albumsPanel.classList.toggle("active", mode === "album");
    [...tabsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    render();
  }

  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    switchMode(btn.dataset.mode);
  });

  searchInput.addEventListener("input", render);

  bulkEditBtn.addEventListener("click", () => {
    if (!selectedTrackIds.size) return;
    onBulkEdit(Array.from(selectedTrackIds));
  });

  clearSelectionBtn.addEventListener("click", () => {
    selectedTrackIds.clear();
    lastClickedIndex = null;
    render();
  });

  addFileBtn.addEventListener("click", () => fileInput.click());
  addFolderBtn.addEventListener("click", () => folderInput.click());
  fileInput.addEventListener("change", async () => {
    await handleUpload(fileInput.files);
    fileInput.value = "";
  });
  folderInput.addEventListener("change", async () => {
    await handleUpload(folderInput.files);
    folderInput.value = "";
  });

  return {
    async show() {
      panelEl.classList.add("active");
      searchInput.value = "";
      const library = await api.getLibrary();
      tracks = library.tracks;
      await refreshPlaylistNames();
      switchMode("song");
    },
    hide() {
      panelEl.classList.remove("active");
    },
    async refreshAfterAlbumUpdate() {
      const library = await api.getLibrary();
      tracks = library.tracks;
      render();
    },
    clearSelection() {
      selectedTrackIds.clear();
      lastClickedIndex = null;
      render();
    },
  };
}
