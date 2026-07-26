import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
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

function matchesSong(track, q) {
  return `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(q);
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
const MARQUEE_RESIZE_DEBOUNCE_MS = 150;

export function setupBrowse(player, playlistApi, onEditTrack, onEditAlbum, onBulkEdit) {
  const panelEl = document.getElementById("browse-panel");
  const searchInput = document.getElementById("browse-search");
  const tabsEl = document.getElementById("browse-tabs");
  const songsPanel = document.getElementById("browse-songs-panel");
  const albumsPanel = document.getElementById("browse-albums-panel");
  const albumDetailPanel = document.getElementById("browse-album-detail-panel");
  const songsList = document.getElementById("browse-songs-list");
  const albumsList = document.getElementById("browse-albums-list");
  const albumDetailList = document.getElementById("browse-album-detail-list");
  const albumDetailTitle = document.getElementById("album-detail-title");
  const albumDetailArtist = document.getElementById("album-detail-artist");
  const albumDetailArt = document.getElementById("album-detail-art");
  const albumDetailArtPlaceholder = document.getElementById("album-detail-art-placeholder");
  const btnAlbumDetailBack = document.getElementById("btn-album-detail-back");
  const btnAlbumDetailEdit = document.getElementById("btn-album-detail-edit");
  const clearSelectionBtn = document.getElementById("btn-browse-clear-selection");
  const addFileBtn = document.getElementById("btn-browse-add-file");
  const addFolderBtn = document.getElementById("btn-browse-add-folder");
  const fileInput = document.getElementById("browse-file-input");
  const folderInput = document.getElementById("browse-folder-input");

  let tracks = [];
  let mode = "song";
  let selectedTrackIds = new Set();
  let lastClickedIndex = null;
  let currentAlbumGroup = null;

  const rowMenu = setupRowContextMenu({
    onEditTrack: (track) => onEditTrack(track),
    onAddToPlaylist: (track, playlistName) => addTrackToPlaylist(track, playlistName),
    onBulkEdit: (ids) => onBulkEdit(ids),
    getSelectedIds: () => selectedTrackIds,
  });

  // 선택된 곡이 하나라도 있으면 "선택 모드"로 간주 — 이때만 체크박스가 보이고,
  // 수정자 키 없는 일반 클릭도 체크박스처럼 토글로 동작한다.
  function syncSelectionUI() {
    const selecting = selectedTrackIds.size > 0;
    songsList.classList.toggle("selecting", selecting);
    albumDetailList.classList.toggle("selecting", selecting);
    clearSelectionBtn.hidden = !selecting;
  }

  // 더블클릭한 곡이 속한 목록(검색된 곡 목록이든 특정 앨범이든) 전체를 재생목록으로
  // 설정해서, 다음/이전 곡 자동재생이 그 목록 범위 안에서 이루어지게 한다. 예전엔
  // 곡 하나짜리 임시 재생목록만 만들어서 "다음 곡" 버튼을 누르면 재생이 그냥
  // 멈춰버리는 문제가 있었다.
  function playFromList(track, tracksArray, name) {
    player.setPlaylist({ name, tracks: tracksArray });
    player.playIndex(tracksArray.indexOf(track));
  }

  async function addTrackToPlaylist(track, playlistName) {
    if (!playlistName) return;
    try {
      const updated = await api.addTracksFromLibrary(playlistName, [track.track_id]);
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

  function renderLoading(container) {
    container.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    container.appendChild(loading);
  }

  // 브라우즈 "곡" 목록과 앨범 상세 화면의 곡 목록이 공유하는 행 렌더러.
  // selectedTrackIds/lastClickedIndex는 모듈 전역이라 다중선택·일괄수정 툴바가
  // 어느 목록에서 선택했든 동일하게 동작한다.
  function renderSongRows(
    container,
    tracksArray,
    onActivate = (track) => playFromList(track, tracksArray, "브라우즈 곡 목록")
  ) {
    container.innerHTML = "";
    if (!tracksArray.length) {
      renderEmpty(container);
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

    tracksArray.forEach((track, i) => {
      const li = document.createElement("li");
      li.className = "playlist-row";
      const selected = selectedTrackIds.has(track.track_id);
      if (selected) li.classList.add("selected");
      const isPlaying = !!player.currentTrack && player.currentTrack.track_id === track.track_id;
      if (isPlaying) li.classList.add("playing");

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

      li.addEventListener("dblclick", () => onActivate(track));
      container.appendChild(li);
    });

    // 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다.
    // 컬럼 우선순위(앨범/아티스트 숨김 여부)가 제목 폭에 영향을 주므로 마퀴보다 먼저 계산한다.
    requestAnimationFrame(() => {
      applyColumnPriority(container);
      applyMarquee(container);
    });
  }

  function renderSongs() {
    const validIds = new Set(tracks.map((t) => t.track_id));
    for (const id of selectedTrackIds) {
      if (!validIds.has(id)) selectedTrackIds.delete(id);
    }

    const q = searchInput.value.trim().toLowerCase();
    syncSelectionUI();

    const filtered = tracks.filter((t) => matchesSong(t, q));
    renderSongRows(songsList, filtered);
  }

  function renderAlbumDetailRows(group) {
    renderSongRows(albumDetailList, group.tracks, (track) => playFromList(track, group.tracks, group.album || "앨범"));
  }

  function showAlbumDetailArt(url) {
    const stopSpin = showArtSpinner(albumDetailArt.parentElement);
    albumDetailArt.onerror = () => {
      stopSpin();
      albumDetailArt.style.display = "none";
      albumDetailArtPlaceholder.style.display = "";
    };
    albumDetailArt.onload = () => {
      stopSpin();
      albumDetailArt.style.display = "";
      albumDetailArtPlaceholder.style.display = "none";
    };
    albumDetailArt.src = url;
  }

  function fillAlbumDetailHeader(group) {
    albumDetailTitle.textContent = group.album || "(앨범 없음)";
    albumDetailArtist.textContent = group.artist || "";
    showAlbumDetailArt(`${api.artUrl(group.track_id)}?t=${Date.now()}`);
  }

  function openAlbumDetail(group) {
    currentAlbumGroup = group;
    fillAlbumDetailHeader(group);
    albumsPanel.classList.remove("active");
    albumDetailPanel.classList.add("active");
    renderAlbumDetailRows(group);
  }

  function closeAlbumDetail() {
    albumDetailPanel.classList.remove("active");
    albumsPanel.classList.add("active");
    currentAlbumGroup = null;
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

      card.addEventListener("click", () => openAlbumDetail(group));
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
    albumDetailPanel.classList.remove("active");
    currentAlbumGroup = null;
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

  clearSelectionBtn.addEventListener("click", () => {
    selectedTrackIds.clear();
    lastClickedIndex = null;
    render();
  });

  btnAlbumDetailBack.addEventListener("click", closeAlbumDetail);
  btnAlbumDetailEdit.addEventListener("click", () => {
    if (currentAlbumGroup) onEditAlbum(currentAlbumGroup);
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

  // 재생 곡이 바뀔 때마다 현재 보이는 목록(곡 목록 또는 앨범 상세)을 다시 그려
  // 재생 중 표시(강조 + ▶ 접두사)를 갱신한다.
  player.addEventListener("trackchange", () => {
    if (albumDetailPanel.classList.contains("active")) {
      renderAlbumDetailRows(currentAlbumGroup);
    } else {
      render();
    }
  });

  // 현재 화면에 보이는 목록에 대해서만 리사이즈 시 마퀴를 재계산한다.
  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      const activeList = albumDetailPanel.classList.contains("active")
        ? albumDetailList
        : songsPanel.classList.contains("active")
          ? songsList
          : null;
      if (!activeList) return;
      applyColumnPriority(activeList);
      applyMarquee(activeList);
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  return {
    async show() {
      panelEl.classList.add("active");
      searchInput.value = "";
      renderLoading(songsList);
      renderLoading(albumsList);
      const library = await api.getLibrary();
      tracks = library.tracks;
      switchMode("album");
    },
    hide() {
      panelEl.classList.remove("active");
    },
    async refreshAfterAlbumUpdate() {
      const library = await api.getLibrary();
      tracks = library.tracks;
      if (currentAlbumGroup) {
        const groups = groupAlbums(tracks);
        const match = groups.find(
          (g) => g.album === currentAlbumGroup.album && g.artist === currentAlbumGroup.artist
        );
        if (match) {
          currentAlbumGroup = match;
          fillAlbumDetailHeader(match);
          renderAlbumDetailRows(match);
        } else {
          closeAlbumDetail();
        }
      }
      render();
    },
    clearSelection() {
      selectedTrackIds.clear();
      lastClickedIndex = null;
      render();
    },
  };
}
