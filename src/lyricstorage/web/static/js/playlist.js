import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { confirmDialog, promptDialog, alertDialog } from "./dialog.js";
import { showProgress, setProgress, hideProgress } from "./progress.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee } from "./marquee.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const EMPTY_PLAYLIST = { name: null, is_global: false, tracks: [] };
const MARQUEE_RESIZE_DEBOUNCE_MS = 150;

export function setupPlaylist(
  player,
  bootstrap,
  onTrackActivated,
  onEditTrack,
  { sidebarApi, refs, onBulkEdit }
) {
  const panelEl = document.getElementById("playlist-panel");
  const pageTitleEl = document.getElementById("playlist-page-title");
  const sortSelect = document.getElementById("playlist-sort");
  const newBtn = document.getElementById("btn-new-playlist");
  const renameBtn = document.getElementById("btn-rename-playlist");
  const deleteBtn = document.getElementById("btn-delete-playlist");
  const addFileBtn = document.getElementById("btn-add-file");
  const addFolderBtn = document.getElementById("btn-add-folder");
  const addFromLibraryBtn = document.getElementById("btn-add-from-library");
  const bulkEditBtn = document.getElementById("btn-bulk-edit");
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
  let selectedIndices = new Set();
  let lastClickedIndex = null;
  let sortable = null;
  let sortMode = "default";

  async function addTrackToPlaylist(track, playlistName) {
    if (!playlistName) return;
    try {
      const updated = await api.addTracksFromLibrary(playlistName, [track.track_id]);
      if (currentPlaylist.name === playlistName) {
        currentPlaylist = updated;
        renderList();
        player.syncTracks(currentPlaylist);
      }
    } catch (err) {
      await alertDialog(err.message);
    }
  }

  const rowMenu = setupRowContextMenu({
    onEditTrack: (track) => onEditTrack(track),
    onAddToPlaylist: (track, playlistName) => addTrackToPlaylist(track, playlistName),
  });

  function updateToolbarMode() {
    deleteBtn.style.display = currentPlaylist.name ? "" : "none";
    renameBtn.style.display = currentPlaylist.name ? "" : "none";
    pageTitleEl.textContent = currentPlaylist.name || "";
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

    sortedTracks().forEach((track) => {
      const index = currentPlaylist.tracks.indexOf(track);
      const li = document.createElement("li");
      li.className = "playlist-row";
      li.dataset.trackId = track.track_id;
      const isPlaying = index === player.currentIndex;
      if (isPlaying) li.classList.add("playing");
      if (selectedIndices.has(index)) li.classList.add("selected");

      const label = document.createElement("span");
      label.className = "playlist-row-label";

      const titleClip = document.createElement("span");
      titleClip.className = "playlist-row-title-clip";
      const titleInner = document.createElement("span");
      titleInner.className = "playlist-row-title playlist-row-title-inner";
      titleInner.textContent = (isPlaying ? "▶ " : "") + (track.title || track.track_id);
      titleClip.appendChild(titleInner);
      label.appendChild(titleClip);

      const artistSpan = document.createElement("span");
      artistSpan.className = "playlist-row-artist";
      artistSpan.textContent = track.artist || "";
      label.appendChild(artistSpan);

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
      moreBtn.title = "더보기";
      moreBtn.appendChild(iconSpan("more-vertical", "icon-sm"));
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        rowMenu.open(track, e.clientX, e.clientY);
      });
      li.appendChild(moreBtn);

      li.addEventListener("click", (e) => onRowClick(e, index, track));
      li.addEventListener("dblclick", () => onTrackActivated(index));

      listEl.appendChild(li);
    });

    // 마퀴는 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다.
    requestAnimationFrame(() => applyMarquee(listEl));
  }

  function onRowClick(e, index, track) {
    if (e.shiftKey && lastClickedIndex !== null) {
      const [start, end] = [lastClickedIndex, index].sort((a, b) => a - b);
      selectedIndices.clear();
      for (let i = start; i <= end; i++) selectedIndices.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      if (selectedIndices.has(index)) selectedIndices.delete(index);
      else selectedIndices.add(index);
      lastClickedIndex = index;
    } else {
      selectedIndices = new Set([index]);
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
        selectedIndices.clear();
        renderList();
      },
    });
  }

  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    if (sortable) sortable.option("disabled", sortMode !== "default");
    renderList();
  });

  async function loadPlaylist(name) {
    try {
      currentPlaylist = await api.getPlaylist(name);
    } catch (err) {
      refs.router.goBrowse();
      return;
    }
    selectedIndices.clear();
    updateToolbarMode();
    renderList();
    player.setPlaylist(currentPlaylist);
    await api.updateSettings({ last_playlist: name });
  }

  newBtn.addEventListener("click", async () => {
    const name = await promptDialog("새 플레이리스트 이름:");
    if (!name || !name.trim()) return;
    try {
      currentPlaylist = await api.createPlaylist(name.trim());
      await sidebarApi.refreshNames();
      selectedIndices.clear();
      updateToolbarMode();
      renderList();
      player.setPlaylist(currentPlaylist);
      refs.router.goPlaylist(currentPlaylist.name);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  renameBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name) return;
    const name = await promptDialog("새 이름:", currentPlaylist.name);
    if (!name || !name.trim() || name.trim() === currentPlaylist.name) return;
    try {
      currentPlaylist = await api.renamePlaylist(currentPlaylist.name, name.trim());
      await sidebarApi.refreshNames();
      renderList();
      await api.updateSettings({ last_playlist: currentPlaylist.name });
      refs.router.goPlaylist(currentPlaylist.name);
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
      const names = await sidebarApi.refreshNames();
      const fallback = names[0];
      if (fallback) refs.router.goPlaylist(fallback);
      else refs.router.goBrowse();
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  addFileBtn.addEventListener("click", () => fileInput.click());
  addFolderBtn.addEventListener("click", () => folderInput.click());

  async function handleUpload(fileList) {
    if (!fileList || !fileList.length) return;
    showProgress(`곡 업로드 중 (${fileList.length}개 파일)`);
    try {
      const result = await api.uploadFiles(fileList, currentPlaylist.name, (fraction) => {
        if (fraction >= 1) {
          showProgress("재생목록에 추가하는 중...");
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
      if (currentPlaylist.name) {
        currentPlaylist = await api.getPlaylist(currentPlaylist.name);
        renderList();
        player.syncTracks(currentPlaylist);
      }
    } catch (err) {
      await alertDialog(err.message);
    } finally {
      hideProgress();
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

  bulkEditBtn.addEventListener("click", () => {
    if (!currentPlaylist.name || !selectedIndices.size) return;
    const ids = Array.from(selectedIndices).map((i) => currentPlaylist.tracks[i].track_id);
    onBulkEdit(ids);
  });

  removeBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name || !selectedIndices.size) return;
    if (!(await confirmDialog(`${selectedIndices.size}곡을 삭제할까요?`))) return;
    try {
      currentPlaylist = await api.removeTracks(currentPlaylist.name, Array.from(selectedIndices));
      selectedIndices.clear();
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
    pickerCandidates = library.tracks;
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
    selectedIndices.clear();
    renderList();
  });

  // 재생목록 화면이 활성일 때만 리사이즈 시 마퀴를 재계산한다.
  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      applyMarquee(listEl);
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  updateToolbarMode();
  renderList();
  enableSortable();
  player.setPlaylist(currentPlaylist);

  return {
    loadPlaylist,
    async refreshCurrent() {
      if (currentPlaylist.name) await loadPlaylist(currentPlaylist.name);
    },
    show() {
      panelEl.classList.add("active");
    },
    hide() {
      panelEl.classList.remove("active");
    },
    clearSelection() {
      selectedIndices.clear();
      renderList();
    },
    refreshHasLyrics(trackId) {
      const matches = currentPlaylist.tracks.filter((t) => t.track_id === trackId);
      if (matches.length) {
        matches.forEach((track) => {
          track.has_lyrics = true;
        });
        renderList();
      }
    },
    refreshTrackInfo(trackId, updated) {
      const matches = currentPlaylist.tracks.filter((t) => t.track_id === trackId);
      if (matches.length) {
        matches.forEach((track) => {
          track.title = updated.title;
          track.artist = updated.artist;
          track.album = updated.album;
        });
        renderList();
      }
    },
    refreshTracksInfo(updatedTracks) {
      let changed = false;
      for (const updated of updatedTracks) {
        const matches = currentPlaylist.tracks.filter((t) => t.track_id === updated.track_id);
        matches.forEach((track) => {
          track.title = updated.title;
          track.artist = updated.artist;
          track.album = updated.album;
          changed = true;
        });
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
