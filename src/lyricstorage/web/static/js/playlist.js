import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { confirmDialog, promptDialog, alertDialog } from "./dialog.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const EMPTY_PLAYLIST = { name: null, is_global: false, tracks: [] };

export function setupPlaylist(player, bootstrap, onTrackActivated, onEditTrack) {
  const selectEl = document.getElementById("playlist-select");
  const sortSelect = document.getElementById("playlist-sort");
  const newBtn = document.getElementById("btn-new-playlist");
  const deleteBtn = document.getElementById("btn-delete-playlist");
  const addFileBtn = document.getElementById("btn-add-file");
  const addFolderBtn = document.getElementById("btn-add-folder");
  const addFromLibraryBtn = document.getElementById("btn-add-from-library");
  const removeBtn = document.getElementById("btn-remove-selected");
  const fileInput = document.getElementById("file-input");
  const folderInput = document.getElementById("folder-input");
  const listEl = document.getElementById("playlist-list");

  const pickerDialog = document.getElementById("library-picker-dialog");
  const pickerSearch = document.getElementById("library-picker-search");
  const pickerList = document.getElementById("library-picker-list");
  const pickerOk = document.getElementById("library-picker-ok");
  const pickerCancel = document.getElementById("library-picker-cancel");

  let currentPlaylist = bootstrap.current_playlist || EMPTY_PLAYLIST;
  let playlistNames = bootstrap.playlist_names.slice();
  let selectedIds = new Set();
  let lastClickedIndex = null;
  let sortable = null;
  let sortMode = "default";

  function updateToolbarMode() {
    deleteBtn.style.display = currentPlaylist.name ? "" : "none";
  }

  function renderSelect() {
    selectEl.innerHTML = "";
    for (const name of playlistNames) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === currentPlaylist.name) opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  function sortedTracks() {
    const tracks = currentPlaylist.tracks.slice();
    if (sortMode === "title") {
      tracks.sort((a, b) => (a.title || "").localeCompare(b.title || "", "ko"));
    } else if (sortMode === "artist") {
      tracks.sort((a, b) => (a.artist || "").localeCompare(b.artist || "", "ko"));
    } else if (sortMode === "duration") {
      tracks.sort((a, b) => (a.duration_ms || 0) - (b.duration_ms || 0));
    }
    return tracks;
  }

  function renderList() {
    listEl.innerHTML = "";

    if (!currentPlaylist.name) {
      const empty = document.createElement("div");
      empty.className = "playlist-empty-state";
      empty.textContent = "플레이리스트를 선택하거나 새로 만들어보세요.";
      listEl.appendChild(empty);
      return;
    }

    const playingTrackId = player.currentTrack ? player.currentTrack.track_id : null;
    sortedTracks().forEach((track) => {
      const index = currentPlaylist.tracks.indexOf(track);
      const li = document.createElement("li");
      li.className = "playlist-row";
      li.dataset.trackId = track.track_id;
      const isPlaying = track.track_id === playingTrackId;
      if (isPlaying) li.classList.add("playing");
      if (selectedIds.has(track.track_id)) li.classList.add("selected");

      const label = document.createElement("span");
      label.className = "playlist-row-label";

      const titleSpan = document.createElement("span");
      titleSpan.className = "playlist-row-title";
      titleSpan.textContent = (isPlaying ? "▶ " : "") + (track.title || track.track_id);
      label.appendChild(titleSpan);

      if (track.artist) {
        const artistSpan = document.createElement("span");
        artistSpan.className = "playlist-row-artist";
        artistSpan.textContent = track.artist;
        label.appendChild(artistSpan);
      }
      li.appendChild(label);

      if (track.has_lyrics) {
        li.appendChild(iconSpan("mic", "icon-sm accent"));
      }

      const duration = document.createElement("span");
      duration.className = "playlist-row-duration";
      duration.textContent = fmtDuration(track.duration_ms);
      li.appendChild(duration);

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

      li.addEventListener("click", (e) => onRowClick(e, index, track));
      li.addEventListener("dblclick", () => onTrackActivated(index));

      listEl.appendChild(li);
    });
  }

  function onRowClick(e, index, track) {
    if (e.shiftKey && lastClickedIndex !== null) {
      const [start, end] = [lastClickedIndex, index].sort((a, b) => a - b);
      selectedIds.clear();
      for (let i = start; i <= end; i++) selectedIds.add(currentPlaylist.tracks[i].track_id);
    } else if (e.ctrlKey || e.metaKey) {
      if (selectedIds.has(track.track_id)) selectedIds.delete(track.track_id);
      else selectedIds.add(track.track_id);
      lastClickedIndex = index;
    } else {
      selectedIds = new Set([track.track_id]);
      lastClickedIndex = index;
    }
    renderList();
  }

  function enableSortable() {
    if (sortable) sortable.destroy();
    sortable = window.Sortable.create(listEl, {
      animation: 150,
      disabled: sortMode !== "default",
      onEnd: async (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        try {
          currentPlaylist = await api.reorderPlaylist(currentPlaylist.name, evt.oldIndex, evt.newIndex);
          player.syncTracks(currentPlaylist);
        } catch (err) {
          await alertDialog(err.message);
        }
        renderList();
      },
    });
  }

  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    if (sortable) sortable.option("disabled", sortMode !== "default");
    renderList();
  });

  async function refreshPlaylistNames() {
    const items = await api.listPlaylists();
    playlistNames = items.filter((p) => !p.is_global).map((p) => p.name);
    renderSelect();
  }

  async function loadPlaylist(name) {
    currentPlaylist = await api.getPlaylist(name);
    selectedIds.clear();
    updateToolbarMode();
    renderList();
    player.setPlaylist(currentPlaylist);
    await api.updateSettings({ last_playlist: name });
  }

  selectEl.addEventListener("change", () => loadPlaylist(selectEl.value));

  newBtn.addEventListener("click", async () => {
    const name = await promptDialog("새 플레이리스트 이름:");
    if (!name || !name.trim()) return;
    try {
      currentPlaylist = await api.createPlaylist(name.trim());
      await refreshPlaylistNames();
      selectEl.value = currentPlaylist.name;
      selectedIds.clear();
      updateToolbarMode();
      renderList();
      player.setPlaylist(currentPlaylist);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name) return;
    if (
      !(await confirmDialog(
        `'${currentPlaylist.name}' 플레이리스트를 삭제할까요? (라이브러리의 곡 파일은 유지됩니다)`
      ))
    )
      return;
    try {
      await api.deletePlaylist(currentPlaylist.name);
      await refreshPlaylistNames();
      const fallback = playlistNames[0];
      if (fallback) await loadPlaylist(fallback);
      else {
        currentPlaylist = EMPTY_PLAYLIST;
        selectedIds.clear();
        updateToolbarMode();
        renderSelect();
        renderList();
        player.setPlaylist(currentPlaylist);
      }
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  addFileBtn.addEventListener("click", () => fileInput.click());
  addFolderBtn.addEventListener("click", () => folderInput.click());

  async function handleUpload(fileList) {
    if (!fileList || !fileList.length) return;
    try {
      const result = await api.uploadFiles(fileList, currentPlaylist.name);
      if (result.skipped && result.skipped.length) {
        await alertDialog(
          "다음 파일을 건너뛰었습니다:\n" +
            result.skipped.map((s) => `${s.filename} (${s.reason})`).join("\n")
        );
      }
      if (currentPlaylist.name) {
        currentPlaylist = await api.getPlaylist(currentPlaylist.name);
        renderList();
        player.syncTracks(currentPlaylist);
      }
    } catch (err) {
      await alertDialog(err.message);
    }
  }

  fileInput.addEventListener("change", async () => {
    await handleUpload(fileInput.files);
    fileInput.value = "";
  });
  folderInput.addEventListener("change", async () => {
    await handleUpload(folderInput.files);
    folderInput.value = "";
  });

  removeBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name || !selectedIds.size) return;
    if (!(await confirmDialog(`${selectedIds.size}곡을 삭제할까요?`))) return;
    try {
      currentPlaylist = await api.removeTracks(currentPlaylist.name, Array.from(selectedIds));
      selectedIds.clear();
      renderList();
      player.syncTracks(currentPlaylist);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  // -- 라이브러리에서 추가 모달 -----------------------------------------
  let pickerCandidates = [];
  let pickerChecked = new Set();

  addFromLibraryBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name) {
      await alertDialog("먼저 플레이리스트를 만들거나 선택하세요.");
      return;
    }
    const library = await api.getLibrary();
    const existingIds = new Set(currentPlaylist.tracks.map((t) => t.track_id));
    pickerCandidates = library.tracks.filter((t) => !existingIds.has(t.track_id));
    pickerChecked = new Set();
    if (!pickerCandidates.length) {
      await alertDialog("라이브러리에 추가할 수 있는 곡이 없습니다.");
      return;
    }
    pickerSearch.value = "";
    renderPickerList();
    pickerDialog.showModal();
  });

  function renderPickerList() {
    const filter = pickerSearch.value.trim().toLowerCase();
    pickerList.innerHTML = "";
    for (const track of pickerCandidates) {
      const label = (track.title || track.track_id) + (track.artist ? `  ·  ${track.artist}` : "");
      if (filter && !label.toLowerCase().includes(filter)) continue;
      const row = document.createElement("label");
      row.className = "picker-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = pickerChecked.has(track.track_id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) pickerChecked.add(track.track_id);
        else pickerChecked.delete(track.track_id);
      });
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(label));
      pickerList.appendChild(row);
    }
  }

  pickerSearch.addEventListener("input", renderPickerList);
  pickerCancel.addEventListener("click", () => pickerDialog.close());
  pickerOk.addEventListener("click", async () => {
    pickerDialog.close();
    if (!pickerChecked.size) return;
    try {
      currentPlaylist = await api.addTracksFromLibrary(currentPlaylist.name, Array.from(pickerChecked));
      renderList();
      player.syncTracks(currentPlaylist);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  player.addEventListener("trackchange", () => {
    selectedIds.clear();
    renderList();
  });

  updateToolbarMode();
  renderSelect();
  renderList();
  enableSortable();
  player.setPlaylist(currentPlaylist);

  return {
    refreshHasLyrics(trackId) {
      const track = currentPlaylist.tracks.find((t) => t.track_id === trackId);
      if (track) {
        track.has_lyrics = true;
        renderList();
      }
    },
    refreshTrackInfo(trackId, updated) {
      const track = currentPlaylist.tracks.find((t) => t.track_id === trackId);
      if (track) {
        track.title = updated.title;
        track.artist = updated.artist;
        track.album = updated.album;
        renderList();
      }
    },
    refreshTracksInfo(updatedTracks) {
      let changed = false;
      for (const updated of updatedTracks) {
        const track = currentPlaylist.tracks.find((t) => t.track_id === updated.track_id);
        if (track) {
          track.title = updated.title;
          track.artist = updated.artist;
          track.album = updated.album;
          changed = true;
        }
      }
      if (changed) renderList();
    },
    applyExternalUpdate(updatedPlaylist) {
      if (currentPlaylist.name && updatedPlaylist.name === currentPlaylist.name) {
        currentPlaylist = updatedPlaylist;
        renderList();
        player.syncTracks(currentPlaylist);
      }
    },
    getCurrentPlaylist: () => currentPlaylist,
  };
}
