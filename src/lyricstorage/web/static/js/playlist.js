import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { confirmDialog, promptDialog, alertDialog } from "./dialog.js";
import { showProgress, setProgress, hideProgress } from "./progress.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee, applyColumnPriority, createMarqueeClip } from "./marquee.js";
import { groupAlbums, matchesAlbum } from "./albumGroup.js";
import { showArtSpinner } from "./artspinner.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// 가사 유무 아이콘과 같은 이유로 레이팅이 없는 곡도 배지 자리를 항상 차지하게
// 만들고 visibility로만 숨긴다(폭 고정은 CSS .playlist-row-rating이 담당) —
// 그래야 레이팅 있는 행과 없는 행에서 라벨(제목/앨범/아티스트) 폭이 똑같이
// 남아 컬럼이 어긋나지 않는다.
function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
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
  const removeBtn = document.getElementById("btn-remove-selected");
  const fileInput = document.getElementById("file-input");
  const folderInput = document.getElementById("folder-input");
  const listEl = document.getElementById("playlist-list");

  const pickerDialog = document.getElementById("library-picker-dialog");
  const pickerBackBtn = document.getElementById("library-picker-back");
  const pickerTitleEl = document.getElementById("library-picker-title");
  const pickerSelectedCountEl = document.getElementById("library-picker-selected-count");
  const pickerSearch = document.getElementById("library-picker-search");
  const pickerSearchField = document.getElementById("library-picker-search-field");
  const pickerSearchFieldTitleOption = pickerSearchField.querySelector('option[value="title"]');
  const pickerAlbumsEl = document.getElementById("library-picker-albums");
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
    onBulkEdit: (ids) => onBulkEdit(ids),
    getSelectedIds: () => new Set(Array.from(selectedIndices).map((i) => currentPlaylist.tracks[i].track_id)),
  });

  function updateToolbarMode() {
    deleteBtn.style.display = currentPlaylist.name ? "" : "none";
    renameBtn.style.display = currentPlaylist.name ? "" : "none";
    pageTitleEl.textContent = currentPlaylist.name || "";
  }

  // 재생목록 자체가 재생 중이면(중복곡도 정확히 구분되도록) 인덱스로 비교하고,
  // 브라우즈에서 임시 재생 중인 곡처럼 다른 재생목록이 로드돼 있으면 곡 ID로 비교한다.
  function isTrackPlaying(track, index) {
    if (!player.currentTrack) return false;
    if (player.playlist === currentPlaylist) return index === player.currentIndex;
    return player.currentTrack.track_id === track.track_id;
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
    listEl.classList.toggle("selecting", selectedIndices.size > 0);

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
      const isPlaying = isTrackPlaying(track, index);
      if (isPlaying) li.classList.add("playing");
      const selected = selectedIndices.has(index);
      if (selected) li.classList.add("selected");

      // 브라우즈 곡 목록과 동일한 커스텀 체크박스(선택 모드에서만 표시).
      const checkboxWrap = document.createElement("label");
      checkboxWrap.className = "row-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "row-checkbox-input";
      checkbox.checked = selected;
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIndices.add(index);
        else selectedIndices.delete(index);
        lastClickedIndex = index;
        renderList();
      });
      checkboxWrap.appendChild(checkbox);
      const checkboxBox = document.createElement("span");
      checkboxBox.className = "row-checkbox-box";
      checkboxWrap.appendChild(checkboxBox);
      li.appendChild(checkboxWrap);

      const label = document.createElement("span");
      label.className = "playlist-row-label";

      const titleClip = createMarqueeClip(
        "playlist-row-title-clip",
        "playlist-row-title",
        (isPlaying ? "▶ " : "") + (track.title || track.track_id)
      );
      label.appendChild(titleClip);

      // 브라우즈 곡 목록과 동일한 컬럼 구성(제목/앨범/아티스트)을 재사용한다.
      const albumSpan = createMarqueeClip("playlist-row-album", "", track.album || "");
      label.appendChild(albumSpan);

      const artistSpan = createMarqueeClip("playlist-row-artist", "", track.artist || "");
      label.appendChild(artistSpan);

      li.appendChild(label);

      // 가사 유무 아이콘은 자리만 항상 차지하고 없을 때는 visibility로만 숨긴다.
      // 조건부로 아예 붙였다 뗐다 하면 행마다 label에 남는 폭이 달라져서
      // 아티스트/앨범 컬럼이 행마다 다른 위치에서 시작하는 정렬 어긋남이 생긴다.
      const lyricsFlag = iconSpan("mic", "icon-sm accent");
      if (!track.has_lyrics) lyricsFlag.style.visibility = "hidden";
      li.appendChild(lyricsFlag);

      const duration = document.createElement("span");
      duration.className = "playlist-row-duration";
      duration.textContent = fmtDuration(track.duration_ms);
      li.appendChild(duration);

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

      // 순서 변경은 이 핸들을 잡고 드래그할 때만 시작된다(SortableJS의 handle
      // 옵션). 클릭만으로는 행 선택이 되지 않도록 stopPropagation한다.
      const dragHandle = document.createElement("button");
      dragHandle.type = "button";
      dragHandle.className = "icon-btn playlist-row-drag-handle";
      dragHandle.title = "드래그해서 순서 변경";
      dragHandle.appendChild(iconSpan("grip-vertical", "icon-sm"));
      dragHandle.addEventListener("click", (e) => e.stopPropagation());
      li.appendChild(dragHandle);

      li.addEventListener("click", (e) => onRowClick(e, index, track));
      li.addEventListener("dblclick", () => onTrackActivated(index));

      listEl.appendChild(li);
    });

    // 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다.
    requestAnimationFrame(() => {
      applyColumnPriority(listEl);
      applyMarquee(listEl);
    });
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

  // 드래그는 전용 손잡이(그립 아이콘)를 잡을 때만 시작된다(SortableJS의
  // handle 옵션). 행의 나머지 영역은 클릭(선택)과 절대 충돌하지 않으므로
  // 홀드 지연이 필요 없다. 네이티브 HTML5 드래그는 모바일 터치에서 지원이
  // 불안정해서(특히 iOS Safari) 자체 JS 드래그 구현(forceFallback)을
  // 강제한다.
  function enableSortable() {
    if (sortable) sortable.destroy();
    sortable = window.Sortable.create(listEl, {
      animation: 150,
      forceFallback: true,
      handle: ".playlist-row-drag-handle",
      disabled: sortMode !== "default",
      onEnd: async (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        sortable.option("disabled", true);
        try {
          currentPlaylist = await api.reorderPlaylist(currentPlaylist.name, evt.oldIndex, evt.newIndex);
          player.syncTracks(currentPlaylist);
        } catch (err) {
          await alertDialog(err.message);
        } finally {
          sortable.option("disabled", sortMode !== "default");
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
    listEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    listEl.appendChild(loading);
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
  // 앨범 목록 → (선택) → 앨범 상세 곡 목록의 2단 구조. 여러 앨범을 오가며 곡을
  // 골라도 되도록 선택 상태(pickerChecked)는 다이얼로그를 여는 동안 전체 앨범에
  // 걸쳐 유지되고, 앨범 상세를 나갔다 들어와도 사라지지 않는다.
  let pickerAlbumGroups = [];
  let pickerChecked = new Set();
  let pickerCurrentAlbum = null; // null이면 앨범 목록 화면

  function updatePickerSelectedCount() {
    pickerSelectedCountEl.textContent = pickerChecked.size ? `${pickerChecked.size}곡 선택됨` : "";
  }

  // 앨범 목록 화면은 개별 곡명이 없는 그룹 단위라 "곡명" 범위가 의미가 없다 —
  // 선택지에서 비활성화하고, 곡 목록 화면에서 곡명을 고른 채로 넘어왔으면
  // "전체"로 되돌린다.
  function showPickerView(view) {
    pickerAlbumsEl.classList.toggle("active", view === "albums");
    pickerList.classList.toggle("active", view === "tracks");
    pickerBackBtn.hidden = view === "albums";
    pickerTitleEl.textContent =
      view === "tracks" ? pickerCurrentAlbum.album || "(앨범 없음)" : "라이브러리에서 추가";
    pickerSearchFieldTitleOption.disabled = view === "albums";
    if (view === "albums" && pickerSearchField.value === "title") pickerSearchField.value = "all";
  }

  addFromLibraryBtn.addEventListener("click", async () => {
    if (!currentPlaylist.name) {
      await alertDialog("먼저 플레이리스트를 만들거나 선택하세요.");
      return;
    }
    const library = await api.getLibrary();
    pickerAlbumGroups = groupAlbums(library.tracks);
    pickerChecked = new Set();
    pickerCurrentAlbum = null;
    if (!pickerAlbumGroups.length) {
      await alertDialog("라이브러리에 추가할 수 있는 곡이 없습니다.");
      return;
    }
    pickerSearch.value = "";
    pickerSearchField.value = "all";
    updatePickerSelectedCount();
    showPickerView("albums");
    renderPickerAlbums();
    pickerDialog.showModal();
  });

  function renderPickerAlbums() {
    const filter = pickerSearch.value.trim().toLowerCase();
    const field = pickerSearchField.value;
    pickerAlbumsEl.innerHTML = "";
    const filtered = pickerAlbumGroups.filter((g) => !filter || matchesAlbum(g, filter, field));

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "playlist-empty-state";
      empty.textContent = "일치하는 앨범이 없습니다.";
      pickerAlbumsEl.appendChild(empty);
      return;
    }

    filtered.forEach((group) => {
      const card = document.createElement("div");
      card.className = "media-card media-card-clickable";

      const artWrap = document.createElement("div");
      artWrap.className = "media-card-art-wrap";
      const stopSpin = showArtSpinner(artWrap);
      const img = document.createElement("img");
      img.className = "media-card-art";
      img.alt = "";
      img.src = api.artUrl(group.track_id);
      img.onload = () => stopSpin();
      img.onerror = () => {
        stopSpin();
        img.remove();
        artWrap.appendChild(iconSpan("music", "icon-lg"));
      };
      artWrap.appendChild(img);
      card.appendChild(artWrap);

      const title = createMarqueeClip("media-card-title", "", group.album || "(앨범 없음)");
      card.appendChild(title);

      if (group.artist) {
        const artist = document.createElement("div");
        artist.className = "media-card-artist";
        artist.textContent = group.artist;
        card.appendChild(artist);
      }

      const selectedCount = group.tracks.filter((t) => pickerChecked.has(t.track_id)).length;
      const meta = document.createElement("div");
      meta.className = "media-card-meta";
      meta.textContent = selectedCount ? `${group.tracks.length}곡 · ${selectedCount}개 선택됨` : `${group.tracks.length}곡`;
      card.appendChild(meta);

      card.addEventListener("click", () => {
        pickerCurrentAlbum = group;
        pickerSearch.value = "";
        showPickerView("tracks");
        renderPickerTracks();
      });
      pickerAlbumsEl.appendChild(card);
    });

    requestAnimationFrame(() => applyMarquee(pickerAlbumsEl));
  }

  function renderPickerTracks() {
    const filter = pickerSearch.value.trim().toLowerCase();
    const field = pickerSearchField.value;
    pickerList.innerHTML = "";
    const filtered = pickerCurrentAlbum.tracks.filter((track) => {
      if (!filter) return true;
      if (field === "title") return (track.title || track.track_id).toLowerCase().includes(filter);
      if (field === "album") return (track.album || "").toLowerCase().includes(filter);
      if (field === "artist") return (track.artist || "").toLowerCase().includes(filter);
      const haystack = `${track.title || track.track_id} ${track.artist || ""} ${track.album || ""}`;
      return haystack.toLowerCase().includes(filter);
    });

    if (!filtered.length) {
      const empty = document.createElement("li");
      empty.className = "playlist-empty-state";
      empty.textContent = "일치하는 곡이 없습니다.";
      pickerList.appendChild(empty);
      return;
    }

    filtered.forEach((track) => {
      // 브라우즈 곡 목록과 동일한 행 디자인(커스텀 체크박스 포함)을 재사용한다.
      const li = document.createElement("li");
      li.className = "playlist-row";

      const checkboxWrap = document.createElement("label");
      checkboxWrap.className = "row-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "row-checkbox-input";
      checkbox.checked = pickerChecked.has(track.track_id);
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) pickerChecked.add(track.track_id);
        else pickerChecked.delete(track.track_id);
        li.classList.toggle("selected", checkbox.checked);
        updatePickerSelectedCount();
      });
      checkboxWrap.appendChild(checkbox);
      const checkboxBox = document.createElement("span");
      checkboxBox.className = "row-checkbox-box";
      checkboxWrap.appendChild(checkboxBox);
      li.appendChild(checkboxWrap);
      if (checkbox.checked) li.classList.add("selected");
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

      li.appendChild(createRatingBadge(track.rating));

      li.addEventListener("click", (e) => {
        if (e.target.closest("input")) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      });

      pickerList.appendChild(li);
    });

    requestAnimationFrame(() => {
      applyColumnPriority(pickerList);
      applyMarquee(pickerList);
    });
  }

  pickerBackBtn.addEventListener("click", () => {
    pickerCurrentAlbum = null;
    pickerSearch.value = "";
    showPickerView("albums");
    renderPickerAlbums(); // 선택 개수 배지를 최신 상태로 갱신
  });

  pickerSearch.addEventListener("input", () => {
    if (pickerCurrentAlbum) renderPickerTracks();
    else renderPickerAlbums();
  });
  pickerSearchField.addEventListener("change", () => {
    if (pickerCurrentAlbum) renderPickerTracks();
    else renderPickerAlbums();
  });

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

  // 재생바 하트로 레이팅을 바꾸면 지금 보고 있는 재생목록에도 바로 반영한다.
  player.addEventListener("ratingchange", (e) => {
    const matches = currentPlaylist.tracks.filter((t) => t.track_id === e.detail.trackId);
    if (matches.length) {
      matches.forEach((track) => {
        track.rating = e.detail.rating;
      });
      renderList();
    }
  });

  // 재생목록 화면(또는 열려있는 라이브러리 추가 다이얼로그)이 활성일 때만
  // 리사이즈 시 컬럼 우선순위/마퀴를 재계산한다.
  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (panelEl.classList.contains("active")) {
        applyColumnPriority(listEl);
        applyMarquee(listEl);
      }
      if (pickerDialog.open && pickerCurrentAlbum) {
        applyColumnPriority(pickerList);
        applyMarquee(pickerList);
      } else if (pickerDialog.open) {
        applyMarquee(pickerAlbumsEl);
      }
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
