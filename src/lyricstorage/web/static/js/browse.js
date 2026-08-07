import { api } from "./api.js";
import { store } from "./store.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
import { showProgress, setProgress, hideProgress } from "./progress.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee, applyColumnPriority, createMarqueeClip } from "./marquee.js";
import { openImageLightbox } from "./imageLightbox.js";
import { groupAlbums, matchesAlbum } from "./albumGroup.js";
import { showArtSpinner } from "./artspinner.js";
import { setupAlbumArtPrompt } from "./albumArtPrompt.js";
import { setupAlbumArtistPrompt } from "./albumArtistPrompt.js";
import { fillArtistArt } from "./artistArt.js";
import { patchPlayingRow, patchRatingBadge } from "./rowPatch.js";
import { splitArtists, buildArtistNameResolver, buildArtistCell } from "./songArtist.js";
import { searchAll } from "./search.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// 앨범 평균 평점: 평가되지 않은(0점) 곡은 제외하고, 평가된 곡끼리만 평균을 낸다.
// 한 곡도 평가되지 않았으면 null(빈칸 처리용).
function albumAverageRating(tracks) {
  const rated = tracks.filter((t) => t.rating > 0);
  if (!rated.length) return null;
  const avg = rated.reduce((sum, t) => sum + t.rating, 0) / rated.length;
  const rounded = Math.round(avg * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// field: "all"(기본) | "title" | "album" | "artist" — 검색창 옆 범위 선택에
// 맞춰 특정 필드만 대상으로 검색할 수 있게 한다.
function matchesSong(track, q, field = "all") {
  if (field === "title") return (track.title || "").toLowerCase().includes(q);
  if (field === "album") return (track.album || "").toLowerCase().includes(q);
  if (field === "artist") return (track.artist || "").toLowerCase().includes(q);
  return `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(q);
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

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
const MARQUEE_RESIZE_DEBOUNCE_MS = 150;

// 모바일에서 곡이 아주 많으면(수천 곡) 렉이 심해진다. 청크 렌더링은 "그리는
// 과정"만 여러 프레임에 나눌 뿐 최종 DOM 노드 수는 그대로라 근본적인 해결이
// 안 되므로, 브라우즈 곡 목록만 실제로 한 페이지분의 행만 DOM에 존재하게
// 페이지 단위로 자른다(앨범 상세/재생목록은 보통 곡이 훨씬 적어 그대로 둔다).
// 페이지 크기는 고정 숫자가 아니라 목록 영역에 스크롤 없이 딱 들어가는
// 행 개수로 실시간 계산한다(SONGS_PAGE_SIZE_FALLBACK은 아직 한 번도 실측하지
// 못했을 때만 쓰는 임시값).
const SONGS_PAGE_SIZE_FALLBACK = 50;

export function setupBrowse(player, playlistApi, onEditTrack, onEditAlbum, onBulkEdit, identityDialogApi, refs) {
  const panelEl = document.getElementById("browse-panel");
  const searchInput = document.getElementById("browse-search-input");
  const searchResultsEl = document.getElementById("browse-search-results");
  const tabsEl = document.getElementById("browse-tabs");
  const artistsPanel = document.getElementById("browse-artists-panel");
  const artistsList = document.getElementById("browse-artists-list");
  const songArtistsPanel = document.getElementById("browse-song-artists-panel");
  const songArtistsList = document.getElementById("browse-song-artists-list");
  const songArtistDetailPanel = document.getElementById("browse-song-artist-detail-panel");
  const songArtistDetailTitleEl = document.getElementById("browse-song-artist-detail-title");
  const songArtistDetailAliasesEl = document.getElementById("browse-song-artist-detail-aliases");
  const songArtistDetailListEl = document.getElementById("browse-song-artist-detail-list");
  const songArtistDetailBackBtn = document.getElementById("btn-browse-song-artist-detail-back");
  const songArtistDetailEditBtn = document.getElementById("btn-browse-song-artist-detail-edit");
  const songsPanel = document.getElementById("browse-songs-panel");
  const albumsPanel = document.getElementById("browse-albums-panel");
  const albumDetailPanel = document.getElementById("browse-album-detail-panel");
  const songsList = document.getElementById("browse-songs-list");
  const songsPagination = document.getElementById("browse-songs-pagination");
  const songsPrevPageBtn = document.getElementById("browse-songs-prev-page");
  const songsNextPageBtn = document.getElementById("browse-songs-next-page");
  const songsPageLabel = document.getElementById("browse-songs-page-label");
  const songsTop3El = document.getElementById("browse-songs-top3");
  const albumsTop3El = document.getElementById("browse-albums-top3");
  const artistsTop3El = document.getElementById("browse-artists-top3");
  const albumsList = document.getElementById("browse-albums-list");
  const albumDetailList = document.getElementById("browse-album-detail-list");
  const albumDetailTitleClip = document.querySelector(".album-detail-title-clip");
  const albumDetailTitle = document.getElementById("album-detail-title");
  const albumDetailArtist = document.getElementById("album-detail-artist");
  const albumDetailArt = document.getElementById("album-detail-art");
  const albumDetailArtPlaceholder = document.getElementById("album-detail-art-placeholder");
  const btnAlbumDetailBack = document.getElementById("btn-album-detail-back");
  const btnAlbumDetailDownload = document.getElementById("btn-album-detail-download");
  const btnAlbumDetailEdit = document.getElementById("btn-album-detail-edit");
  const clearSelectionBtn = document.getElementById("btn-browse-clear-selection");
  const addFileBtn = document.getElementById("btn-browse-add-file");
  const addFolderBtn = document.getElementById("btn-browse-add-folder");
  const reimportArtistsBtn = document.getElementById("btn-browse-reimport-artists");
  const fileInput = document.getElementById("browse-file-input");
  const folderInput = document.getElementById("browse-folder-input");
  const reimportArtistsInput = document.getElementById("browse-reimport-artists-input");

  let tracks = [];
  let albums = [];
  let artistsRegistry = [];
  let circlesRegistry = [];
  let libraryName = null;
  let mode = "artist";
  // 브라우즈 자체의 탭별 검색창(구식 검색바)은 헤더의 통합 검색(아래
  // searchInput)으로 대체되어 사라졌다. 다만 서클 카드를 눌러 앨범 탭을 그
  // 서클로 필터링해서 보여주는 내부 동작(openArtistAlbums)은 여전히 이
  // 상태를 쓴다 — 이제 사용자가 직접 입력할 수 있는 자리는 없고, 코드에서만
  // 채워 넣는다.
  let filterQuery = "";
  let filterField = "all";
  let selectedTrackIds = new Set();
  let lastClickedIndex = null;
  let currentAlbumGroup = null;
  let renderedAlbumGroups = [];
  let albumsSortable = null;
  let songsPage = 0;
  let songsPageSize = SONGS_PAGE_SIZE_FALLBACK;
  let todaySongs = [];
  // 곡 아티스트 상세 화면에 지금 열려 있는 정체성({id, name, aliases}).
  let songArtistDetailIdentity = null;
  // 가사 패널이 열려 있으면 재생 통계 TOP 3 앨범과 마찬가지로 이 위젯도 숨긴다(공간 확보).
  let lyricsActive = false;

  const albumArtPromptApi = setupAlbumArtPrompt();
  const albumArtistPromptApi = setupAlbumArtistPrompt();

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
    songArtistDetailListEl
      .querySelectorAll(".playlist-list")
      .forEach((ul) => ul.classList.toggle("selecting", selecting));
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

  function findGroupForTrack(track) {
    return groupAlbums(tracks, albums).find(
      (g) =>
        g.tracks.some((t) => t.track_id === track.track_id) ||
        (track.album && g.album === track.album && g.artist === track.artist)
    );
  }

  // 곡 목록(곡 탭/앨범 상세/곡 아티스트 상세 공용)의 앨범명/아티스트명을 눌렀을
  // 때 그 앨범/아티스트 상세로 바로 넘어간다.
  function openAlbumFromRow(track) {
    const group = findGroupForTrack(track);
    if (!group) return;
    switchMode("album");
    openAlbumDetail(group);
  }

  // openSongArtistDetail 자체가 목록 화면을 거치지 않고 곧장 상세로 전환하므로,
  // 여기서 switchMode("song-artist")를 먼저 부르지 않는다 — 그러면 이름 해석
  // (비동기 API 호출)이 끝나기 전에 곡 아티스트 목록 탭이 잠깐 보였다 사라지는
  // 어색한 화면 전환이 생긴다.
  function openArtistFromRow(name) {
    if (!name) return;
    openSongArtistDetail(name);
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

  // store.js가 fetch를 한 곳에 모아둔 캐시를 이 모듈의 로컬 변수로 복사한다.
  // 렌더 로직(renderSongs/renderAlbums 등)은 전부 이 로컬 변수를 참조하므로
  // store 도입 전과 동일하게 동작하고, 이 함수만 "어디서 데이터를 가져오는지"를 안다.
  function syncFromStore() {
    tracks = store.getTracks();
    albums = store.getAlbums();
    artistsRegistry = store.getArtists();
    circlesRegistry = store.getCircles();
    libraryName = store.getLibraryName();
  }

  async function loadLibraryAndAlbums() {
    await store.refresh();
    syncFromStore();
  }

  // 다른 화면(트랙 정보 수정, 일괄 편집 등)에서 store.refresh()가 일어나면
  // 브라우즈가 지금 보이는 중일 때만 다시 그린다 — 숨겨진 동안은 로컬 변수만
  // 최신으로 맞춰두고, 다음에 show()가 호출될 때(fetch 없이 이미 최신 상태이므로
  // 즉시) 그린다.
  store.subscribe(() => {
    syncFromStore();
    if (panelEl.classList.contains("active")) renderCurrentView();
  });

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
      await loadLibraryAndAlbums();
      render();
      const openArtPromptIfNeeded = () => {
        if (result.albums_missing_art && result.albums_missing_art.length) {
          albumArtPromptApi.open(result.albums_missing_art, () => loadLibraryAndAlbums().then(render));
        }
      };
      // 새 앨범 아티스트 확인부터 먼저 물어보고(정체성이 우선), 그 다이얼로그를
      // 닫으면 이어서 표지 선택을 묻는다 — 둘 다 해당되면 순서대로 한 번씩만.
      if (result.new_albums && result.new_albums.length) {
        albumArtistPromptApi.open(
          result.new_albums,
          () => loadLibraryAndAlbums().then(render),
          openArtPromptIfNeeded
        );
      } else {
        openArtPromptIfNeeded();
      }
    } catch (err) {
      await alertDialog(err.message);
    } finally {
      hideProgress();
    }
  }

  // 앨범 아티스트 도입 전, 곡 아티스트를 전부 앨범 아티스트로 덮어써 통일했던
  // 라이브러리를 위한 일회성 복구 도구. 원본 태그가 살아있는 원본 파일들이 있는
  // 폴더를 고르면(라이브러리에 새로 추가하지 않고) 제목+앨범이 일치하는 기존
  // 곡을 찾아 그 곡의 아티스트만 원본 태그로 되돌린다.
  async function handleReimportArtists(fileList) {
    if (!fileList || !fileList.length) return;
    showProgress(`곡 아티스트 다시 가져오는 중 (${fileList.length}개 파일)`);
    try {
      const result = await api.reimportArtists(fileList, (fraction) => {
        if (fraction >= 1) {
          showProgress("일치하는 곡을 찾는 중...");
          setProgress(null);
        } else {
          setProgress(fraction);
        }
      });
      await loadLibraryAndAlbums();
      render();
      const lines = [`${result.updated.length}곡의 아티스트를 되돌렸습니다.`];
      if (result.ambiguous.length) lines.push(`같은 제목+앨범의 곡이 여럿이라 건너뛴 파일: ${result.ambiguous.length}개`);
      if (result.unmatched.length) lines.push(`일치하는 곡을 찾지 못한 파일: ${result.unmatched.length}개`);
      await alertDialog(lines.join("\n"));
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

  // 목록이 길 때 한 프레임에 수백~수천 행을 한꺼번에 만들면 브라우저가 잠깐
  // 멎는(렉) 느낌을 준다. ROWS_PER_CHUNK개씩 나눠 매 프레임마다 이어 그리고,
  // 그 사이 같은 컨테이너에 더 최신 렌더 요청(검색어 입력, 트랙 전환 등)이
  // 들어오면 자기 세대(generation)가 낡았음을 확인하고 그리기를 멈춘다 —
  // 그렇지 않으면 오래된 렌더와 새 렌더가 뒤섞여 행이 중복으로 남는다. 세대
  // 카운터는 컨테이너별로 따로 두어(곡 목록/앨범 상세가 서로의 렌더를 취소해
  // 버리지 않도록) 컨테이너 엘리먼트 자체에 붙인다.
  const ROWS_PER_CHUNK = 150;

  // 브라우즈 "곡" 목록과 앨범 상세 화면의 곡 목록이 공유하는 행 렌더러.
  // selectedTrackIds/lastClickedIndex는 모듈 전역이라 다중선택·일괄수정 툴바가
  // 어느 목록에서 선택했든 동일하게 동작한다.
  function renderSongRows(
    container,
    tracksArray,
    onActivate = (track) => playFromList(track, tracksArray, "브라우즈 곡 목록"),
    onRendered
  ) {
    const myGeneration = (container._rowsGeneration = (container._rowsGeneration || 0) + 1);
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

    function buildRow(track, i) {
      const li = document.createElement("li");
      li.className = "playlist-row";
      li.dataset.trackId = track.track_id;
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
      if (track.album) {
        albumSpan.classList.add("playlist-row-album-link");
        albumSpan.title = "앨범 보기";
        albumSpan.addEventListener("click", (e) => {
          e.stopPropagation();
          openAlbumFromRow(track);
        });
      }
      label.appendChild(albumSpan);

      label.appendChild(buildArtistCell("playlist-row-artist", track.artist, openArtistFromRow));

      li.appendChild(label);

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
      // 옵션). 버튼 요소라 아래 롱프레스 선택 로직의 "button, input" 제외
      // 조건에 자동으로 걸러져서, 행 선택(롱프레스/체크박스)과 절대 충돌하지
      // 않는다.
      const dragHandle = document.createElement("button");
      dragHandle.type = "button";
      dragHandle.className = "icon-btn playlist-row-drag-handle";
      dragHandle.title = "드래그해서 순서 변경";
      dragHandle.appendChild(iconSpan("grip-vertical", "icon-sm"));
      li.appendChild(dragHandle);

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
      return li;
    }

    let nextIndex = 0;
    function renderChunk() {
      if (myGeneration !== container._rowsGeneration) return; // 더 최신 렌더가 대신 진행 중
      const end = Math.min(nextIndex + ROWS_PER_CHUNK, tracksArray.length);
      const fragment = document.createDocumentFragment();
      for (; nextIndex < end; nextIndex++) {
        fragment.appendChild(buildRow(tracksArray[nextIndex], nextIndex));
      }
      container.appendChild(fragment);
      if (nextIndex < tracksArray.length) {
        requestAnimationFrame(renderChunk);
        return;
      }
      // 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다.
      // 컬럼 우선순위(앨범/아티스트 숨김 여부)가 제목 폭에 영향을 주므로 마퀴보다 먼저 계산한다.
      requestAnimationFrame(() => {
        if (myGeneration !== container._rowsGeneration) return;
        applyColumnPriority(container);
        applyMarquee(container);
        if (onRendered) onRendered();
      });
    }
    renderChunk();
  }

  // 재생 통계 화면의 "TOP 3 앨범" 위젯(#stats-track-top3)과 동일한 디자인(.media-card)을
  // 그대로 재사용해, 오늘의 곡 추천 상위 3곡을 카드로 보여준다.
  function buildTodaySongCard(item, i) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    card.title = "재생";
    card.addEventListener("click", () => playFromList(item, todaySongs, "오늘의 곡"));

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    const stopSpin = showArtSpinner(artWrap);
    const img = document.createElement("img");
    img.className = "media-card-art";
    img.alt = "";
    img.src = api.artUrl(item.track_id);
    img.onload = () => stopSpin();
    img.onerror = () => {
      stopSpin();
      img.remove();
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    };
    artWrap.appendChild(img);
    const rank = document.createElement("span");
    rank.className = "media-card-rank";
    rank.textContent = `${i + 1}위`;
    artWrap.appendChild(rank);
    card.appendChild(artWrap);

    const title = document.createElement("div");
    title.className = "media-card-title";
    title.textContent = item.title || item.track_id;
    card.appendChild(title);

    if (item.artist) {
      const artist = document.createElement("div");
      artist.className = "media-card-artist";
      artist.textContent = item.artist;
      card.appendChild(artist);
    }

    return card;
  }

  function renderTodaySongsTop3() {
    songsTop3El.innerHTML = "";
    if (lyricsActive || !todaySongs.length) {
      songsTop3El.hidden = true;
      return;
    }
    songsTop3El.hidden = false;
    const heading = document.createElement("div");
    heading.className = "stats-track-top3-heading";
    heading.textContent = "오늘의 곡";
    songsTop3El.appendChild(heading);
    todaySongs.slice(0, 3).forEach((item, i) => songsTop3El.appendChild(buildTodaySongCard(item, i)));
  }

  // "오늘의 곡"(곡 단위 추천)과 같은 재료를 앨범/서클 단위로 집계해 앨범 탭/
  // 아티스트 탭에도 같은 모양의 위젯을 보여준다 — 추천이 "곡" 탭에만 있어서
  // 앨범/서클 단위로 둘러볼 때는 발견 신호가 끊기던 문제를 없앤다. 새 추천
  // 알고리즘이 아니라 이미 받아온 todaySongs를 그룹핑만 다시 한 것이므로
  // 서버 왕복이 추가로 들지 않는다.
  function buildRecommendedAlbumCard(group) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    const stopSpin = showArtSpinner(artWrap);
    const img = document.createElement("img");
    img.className = "media-card-art";
    img.alt = "";
    img.src = api.albumArtUrl(group.id);
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
    card.addEventListener("click", () => openAlbumDetail(group));
    return card;
  }

  function buildRecommendedCircleCard(entry) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    fillArtistArt(artWrap, entry.albums);
    card.appendChild(artWrap);
    const title = document.createElement("div");
    title.className = "media-card-title";
    title.textContent = entry.name || "(서클 없음)";
    card.appendChild(title);
    card.addEventListener("click", () => openArtistAlbums(entry.name));
    return card;
  }

  // todaySongs가 걸쳐 있는 앨범 중 최대 3개를 골라 앨범 탭 옆에 보여준다.
  function renderRecommendedAlbums() {
    albumsTop3El.innerHTML = "";
    const albumIds = new Set(todaySongs.map((t) => t.album_id).filter(Boolean));
    const groups = albumIds.size ? groupAlbums(tracks, albums).filter((g) => albumIds.has(g.id)) : [];
    if (lyricsActive || !groups.length) {
      albumsTop3El.hidden = true;
      return;
    }
    albumsTop3El.hidden = false;
    const heading = document.createElement("div");
    heading.className = "stats-track-top3-heading";
    heading.textContent = "오늘의 추천 앨범";
    albumsTop3El.appendChild(heading);
    groups.slice(0, 3).forEach((g) => albumsTop3El.appendChild(buildRecommendedAlbumCard(g)));
  }

  // todaySongs가 속한 앨범들의 서클(대표 이름 기준)을 최대 3개 골라 아티스트
  // 탭 옆에 보여준다.
  function renderRecommendedCircles() {
    artistsTop3El.innerHTML = "";
    const resolveCircleName = buildArtistNameResolver(circlesRegistry);
    const albumById = new Map(albums.map((a) => [a.id, a]));
    const byName = new Map();
    for (const item of todaySongs) {
      const album = item.album_id ? albumById.get(item.album_id) : null;
      const name = resolveCircleName((album ? album.artist : "") || "");
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      if (album) byName.get(name).push(album);
    }
    const entries = [...byName.entries()].map(([name, albumsForName]) => ({ name, albums: albumsForName }));
    if (lyricsActive || !entries.length) {
      artistsTop3El.hidden = true;
      return;
    }
    artistsTop3El.hidden = false;
    const heading = document.createElement("div");
    heading.className = "stats-track-top3-heading";
    heading.textContent = "오늘의 추천 서클";
    artistsTop3El.appendChild(heading);
    entries.slice(0, 3).forEach((entry) => artistsTop3El.appendChild(buildRecommendedCircleCard(entry)));
  }

  // 실패해도(네트워크 오류 등) 브라우즈 화면 전체를 방해하지 않도록 조용히
  // 위젯만 숨긴다 — 오늘의 곡은 부가 기능이다.
  async function loadTodaySongs() {
    try {
      const data = await api.getTodaySongs();
      todaySongs = data.items;
    } catch (_err) {
      todaySongs = [];
    }
    renderTodaySongsTop3();
    renderRecommendedAlbums();
    renderRecommendedCircles();
  }

  function renderSongs() {
    const validIds = new Set(tracks.map((t) => t.track_id));
    for (const id of selectedTrackIds) {
      if (!validIds.has(id)) selectedTrackIds.delete(id);
    }

    const q = filterQuery.trim().toLowerCase();
    const field = filterField;
    syncSelectionUI();

    const filtered = tracks.filter((t) => matchesSong(t, q, field));

    const totalPages = Math.max(1, Math.ceil(filtered.length / songsPageSize));
    songsPage = Math.min(songsPage, totalPages - 1);
    const pageStart = songsPage * songsPageSize;
    const pageTracks = filtered.slice(pageStart, pageStart + songsPageSize);

    // 다음/이전 곡 재생은 화면에 보이는 한 페이지가 아니라 필터링된 전체
    // 목록 기준으로 이어져야 하므로, onActivate에 페이지가 아닌 filtered를
    // 명시적으로 넘긴다(그냥 두면 renderSongRows 기본값이 실제로 넘긴
    // tracksArray, 즉 pageTracks만 재생목록으로 잡아 페이지 끝에서 멈춘다).
    renderSongRows(
      songsList,
      pageTracks,
      (track) => playFromList(track, filtered, "브라우즈 곡 목록"),
      recalcSongsPageSize
    );
    renderSongsPagination(filtered.length, totalPages);
    renderTodaySongsTop3();
  }

  function renderSongsPagination(totalCount, totalPages) {
    lastSongsPageTotalCount = totalCount;
    lastSongsPageTotalPages = totalPages;
    songsPagination.hidden = totalPages <= 1;
    songsPrevPageBtn.disabled = songsPage <= 0;
    songsNextPageBtn.disabled = songsPage >= totalPages - 1;
    if (songsPageLabelEditing) return; // 입력 중인 <input>을 렌더로 덮어쓰지 않는다.
    songsPageLabel.textContent = `${songsPage + 1} / ${totalPages} (${totalCount}곡)`;
  }

  // 페이지 라벨을 클릭하면 숫자 입력창으로 바뀌어 원하는 페이지로 바로 이동할 수 있다.
  let songsPageLabelEditing = false;
  let lastSongsPageTotalCount = 0;
  let lastSongsPageTotalPages = 1;
  function startEditingSongsPage() {
    if (songsPageLabelEditing || lastSongsPageTotalPages <= 1) return;
    songsPageLabelEditing = true;
    let cancelled = false;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pagination-page-input";
    input.min = "1";
    input.max = String(lastSongsPageTotalPages);
    input.value = String(songsPage + 1);
    songsPageLabel.textContent = "";
    songsPageLabel.appendChild(input);
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelled = true;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      songsPageLabelEditing = false;
      const targetPage = cancelled
        ? songsPage
        : Math.min(lastSongsPageTotalPages, Math.max(1, Math.round(Number(input.value)) || 1)) - 1;
      if (targetPage !== songsPage) goToSongsPage(targetPage);
      else renderSongsPagination(lastSongsPageTotalCount, lastSongsPageTotalPages);
    });
    input.focus();
    input.select();
  }
  songsPageLabel.title = "클릭해서 페이지 번호 입력";
  songsPageLabel.addEventListener("click", startEditingSongsPage);

  // 실제로 렌더링된 행 하나의 높이와 목록 영역의 실측 높이를 비교해서, 스크롤
  // 없이 딱 들어가는 행 개수를 구한다. 값이 이전과 달라졌을 때만(최초 실측,
  // 리사이즈 등) 그 크기로 다시 그린다 — 같으면 그대로 두어 불필요한 재렌더를
  // 피한다.
  function recalcSongsPageSize() {
    const sampleRow = songsList.querySelector(".playlist-row");
    if (!sampleRow) return;
    const rowHeight = sampleRow.getBoundingClientRect().height;
    const containerHeight = songsList.clientHeight;
    if (!rowHeight || !containerHeight) return;
    const fitCount = Math.max(1, Math.floor(containerHeight / rowHeight));
    if (fitCount !== songsPageSize) {
      songsPageSize = fitCount;
      renderSongs();
    }
  }

  function goToSongsPage(nextPage) {
    songsPage = nextPage;
    lastClickedIndex = null; // 페이지가 바뀌면 이전 페이지 기준 shift-선택 인덱스는 의미가 없다.
    renderSongs();
  }

  songsPrevPageBtn.addEventListener("click", () => {
    if (songsPage > 0) goToSongsPage(songsPage - 1);
  });
  songsNextPageBtn.addEventListener("click", () => goToSongsPage(songsPage + 1));

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
    albumDetailArtist.textContent = [group.artist, group.year].filter(Boolean).join(" · ");
    showAlbumDetailArt(`${api.albumArtUrl(group.id)}?t=${Date.now()}`);
    requestAnimationFrame(() => applyMarquee(albumDetailTitleClip));
  }

  function openAlbumDetail(group) {
    currentAlbumGroup = group;
    fillAlbumDetailHeader(group);
    artistsPanel.classList.remove("active");
    albumsPanel.classList.remove("active");
    albumDetailPanel.classList.add("active");
    renderAlbumDetailRows(group);
    if (refs && refs.router && group.id) refs.router.setUrl(`/browse/albums/${encodeURIComponent(group.id)}`);
  }

  function closeAlbumDetail() {
    albumDetailPanel.classList.remove("active");
    albumsPanel.classList.add("active");
    currentAlbumGroup = null;
    if (refs && refs.router) refs.router.setUrl("/browse/albums");
  }

  function buildAlbumCard(group) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    const stopSpin = showArtSpinner(artWrap);
    const img = document.createElement("img");
    img.className = "media-card-art";
    img.alt = "";
    // 앨범이 많아지면 화면 밖 카드까지 한꺼번에 이미지를 요청하게 되므로,
    // 뷰포트(스크롤 컨테이너 포함)에 가까워질 때만 브라우저가 실제로
    // 불러오도록 네이티브 lazy loading을 사용한다.
    img.loading = "lazy";
    img.src = api.albumArtUrl(group.id);
    img.onload = () => stopSpin();
    img.onerror = () => {
      stopSpin();
      img.remove();
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    };
    artWrap.appendChild(img);
    card.appendChild(artWrap);

    const titleRow = document.createElement("div");
    titleRow.className = "media-card-title-row";
    const title = createMarqueeClip("media-card-title", "", group.album || "(앨범 없음)");
    titleRow.appendChild(title);

    // 순서 변경은 이 손잡이를 잡고 드래그할 때만 시작된다(SortableJS의
    // handle 옵션) — 앨범 클릭(상세 열기)과 절대 겹치지 않는다.
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "icon-btn media-card-drag-handle";
    dragHandle.title = "드래그해서 순서 변경";
    dragHandle.appendChild(iconSpan("grip-vertical", "icon-sm"));
    dragHandle.addEventListener("click", (e) => e.stopPropagation());
    titleRow.appendChild(dragHandle);

    card.appendChild(titleRow);

    if (group.year) {
      const year = document.createElement("div");
      year.className = "media-card-year";
      year.textContent = String(group.year);
      card.appendChild(year);
    }

    const artist = createMarqueeClip("media-card-artist", "", group.artist || "");
    card.appendChild(artist);

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    const metaCount = document.createElement("span");
    metaCount.textContent = `${group.tracks.length}곡`;
    meta.appendChild(metaCount);

    const avgRating = albumAverageRating(group.tracks);
    if (avgRating != null) {
      const ratingEl = document.createElement("span");
      ratingEl.className = "media-card-rating";
      ratingEl.appendChild(iconSpan("heart-filled", "icon-sm"));
      ratingEl.appendChild(document.createTextNode(avgRating));
      meta.appendChild(ratingEl);
    }
    card.appendChild(meta);

    card.addEventListener("click", () => openAlbumDetail(group));
    return card;
  }

  // 서클(앨범 아티스트) 정체성 편집은 곡 아티스트와 같은 다이얼로그를 재사용하되,
  // API만 circles.js 쪽으로 갈아 끼운다(identity_registry.py를 공유하므로 로직은 동일).
  const CIRCLE_ENDPOINTS = {
    rename: (id, name) => api.renameCircle(id, name),
    addAlias: (id, alias) => api.addCircleAlias(id, alias),
    removeAlias: (id, alias) => api.removeCircleAlias(id, alias),
  };

  async function openCircleIdentityEditor(name) {
    const identity = await api.resolveCircle(name || "(서클 없음)");
    identityDialogApi.open(identity, {
      title: "서클 정보 수정",
      endpoints: CIRCLE_ENDPOINTS,
      getTracks: () => albums.filter((a) => a.artist).map((a) => ({ artist: a.artist })),
      onChange: () => {
        loadLibraryAndAlbums().then(render);
      },
      onClose: () => {
        loadLibraryAndAlbums().then(render);
      },
    });
  }

  // 아티스트 카드의 커버는 '앨범 아티스트'의 앨범 중 무작위로 최대 4개를 골라
  // 콜라주로 채운다(fillArtistArt, 재생 통계 아티스트 탭과 공유).
  function buildArtistCard(entry) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    fillArtistArt(artWrap, entry.albums);
    card.appendChild(artWrap);

    const titleRow = document.createElement("div");
    titleRow.className = "media-card-title-row";
    const title = createMarqueeClip("media-card-title", "", entry.name || "(서클 없음)");
    titleRow.appendChild(title);

    // 이명 등록 버튼 — 클릭해도 카드 자체의 openArtistAlbums로 넘어가지 않게 막는다.
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn media-card-drag-handle";
    editBtn.title = "서클 이름/이명 수정";
    editBtn.appendChild(iconSpan("edit-3", "icon-sm"));
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCircleIdentityEditor(entry.name);
    });
    titleRow.appendChild(editBtn);

    card.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    const albumCount = document.createElement("span");
    albumCount.textContent = `앨범 ${entry.albums.length}개`;
    meta.appendChild(albumCount);
    card.appendChild(meta);

    card.addEventListener("click", () => openArtistAlbums(entry.name));
    return card;
  }

  // 아티스트 카드를 클릭하면 앨범 탭으로 넘어가 그 아티스트명으로 검색해둔
  // 상태를 보여준다 — 별도의 "아티스트 상세" 화면 없이 앨범 탭의 검색 필터를
  // 그대로 재활용한다.
  function openArtistAlbums(artistName) {
    switchMode("album");
    filterQuery = artistName || "";
    filterField = "artist";
    render();
    if (refs && refs.router) {
      refs.router.setUrl(artistName ? `/browse/albums?circle=${encodeURIComponent(artistName)}` : "/browse/albums");
    }
  }

  // 아티스트 탭은 곡 아티스트가 아니라 '앨범 아티스트'(Album.artist, 서클) 기준으로
  // 묶는다 — 앨범 안의 개별 곡 아티스트가 달라도 여기엔 앨범 아티스트만 나온다.
  // 서클 이명 레지스트리로 표기가 다른 같은 서클을 하나로 합쳐서 묶는다(곡
  // 아티스트 탭이 artistsRegistry로 하는 것과 동일).
  function renderArtists() {
    const q = filterQuery.trim().toLowerCase();
    artistsList.innerHTML = "";

    const resolveCircleName = buildArtistNameResolver(circlesRegistry);
    const byArtist = new Map();
    for (const album of albums) {
      const name = resolveCircleName(album.artist || "");
      if (!byArtist.has(name)) byArtist.set(name, []);
      byArtist.get(name).push(album);
    }
    let entries = [...byArtist.entries()].map(([name, albumsForArtist]) => ({
      name,
      albums: albumsForArtist,
    }));
    entries = entries.filter((e) => !q || (e.name || "(서클 없음)").toLowerCase().includes(q));
    entries.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));

    if (!entries.length) {
      renderEmpty(artistsList);
      return;
    }
    entries.forEach((entry) => artistsList.appendChild(buildArtistCard(entry)));
    requestAnimationFrame(() => applyMarquee(artistsList));
  }

  // 곡 아티스트 카드의 커버는 그 아티스트가(쉼표 분리 기준) 참여한 곡들이
  // 속한 앨범 중 무작위로 콜라주를 채운다 — 재생 통계 '곡 아티스트' 탭과 동일.
  function buildSongArtistCard(entry) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    card.title = "이 아티스트가 참여한 곡 보기";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    fillArtistArt(artWrap, entry.albums);
    card.appendChild(artWrap);

    const titleRow = document.createElement("div");
    titleRow.className = "media-card-title-row";
    titleRow.appendChild(createMarqueeClip("media-card-title", "", entry.name));
    card.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    const countEl = document.createElement("span");
    countEl.textContent = `곡 ${entry.count}개`;
    meta.appendChild(countEl);
    card.appendChild(meta);

    card.addEventListener("click", () => openSongArtistDetail(entry.name));
    return card;
  }

  // '곡 아티스트' 탭은 '아티스트' 탭(앨범 아티스트)과 달리 곡(Track.artist,
  // 쉼표로 여럿 가능)을 기준으로 묶고, 이명 레지스트리로 같은 사람을 통합한다.
  // 재생 순위와 무관한 카탈로그라 이름순으로만 나열한다.
  function renderSongArtists() {
    const q = filterQuery.trim().toLowerCase();
    songArtistsList.innerHTML = "";

    const resolveName = buildArtistNameResolver(artistsRegistry);
    const albumById = new Map(albums.map((a) => [a.id, a]));
    const byName = new Map();
    for (const track of tracks) {
      for (const rawName of splitArtists(track.artist)) {
        const name = resolveName(rawName);
        if (!byName.has(name)) byName.set(name, { name, count: 0, albumIds: new Set() });
        const entry = byName.get(name);
        entry.count += 1;
        if (track.album_id) entry.albumIds.add(track.album_id);
      }
    }
    let entries = [...byName.values()].map((e) => ({
      name: e.name,
      count: e.count,
      albums: [...e.albumIds].map((id) => albumById.get(id)).filter(Boolean),
    }));
    entries = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
    entries.sort((a, b) => a.name.localeCompare(b.name, "ko"));

    if (!entries.length) {
      renderEmpty(songArtistsList);
      return;
    }
    entries.forEach((entry) => songArtistsList.appendChild(buildSongArtistCard(entry)));
    requestAnimationFrame(() => applyMarquee(songArtistsList));
  }

  // identity(대표 이름 + 이명)에 속한 모든 이름과 매칭되는 곡을 앨범별로 묶어
  // 상세 화면을 그린다(재생 통계 곡 아티스트 상세와 동일한 구성). 곡 목록 행은
  // 브라우즈의 renderSongRows를 그대로 써서 체크박스 선택/더보기 메뉴가 그대로 동작한다.
  function renderSongArtistDetail(identity) {
    const matchNames = new Set([identity.name, ...identity.aliases]);
    const matched = tracks.filter((t) => splitArtists(t.artist).some((n) => matchNames.has(n)));

    const byAlbum = new Map();
    for (const track of matched) {
      const key = track.album_id || "";
      if (!byAlbum.has(key)) byAlbum.set(key, { album: track.album || "(앨범 없음)", tracks: [] });
      byAlbum.get(key).tracks.push(track);
    }
    const sections = [...byAlbum.values()].sort((a, b) => (a.album || "").localeCompare(b.album || "", "ko"));
    const allTracks = sections.flatMap((s) => s.tracks);

    songArtistDetailTitleEl.textContent = identity.name || "(아티스트 없음)";
    songArtistDetailAliasesEl.textContent = identity.aliases.length ? `이명: ${identity.aliases.join(", ")}` : "";
    songArtistDetailListEl.innerHTML = "";
    if (!sections.length) {
      renderEmpty(songArtistDetailListEl);
      return;
    }
    // renderSongRows는 앨범/아티스트 칸 폭(applyColumnPriority)을 자기가 받은
    // container(구획별 <ul>) 기준으로만 계산한다. 구획마다 따로 부르면 제목
    // 길이가 구획마다 달라 배정되는 폭도 달라져 앨범명 칸이 구획 경계에서
    // 어긋난다. 모든 구획이 다 그려진 뒤 전체 컨테이너를 대상으로 한 번 더
    // 계산해서, 표처럼 전체 목록에서 칸 폭이 통일되게 맞춘다.
    let pendingSections = sections.length;
    function alignColumnsOnceAllSectionsRendered() {
      pendingSections -= 1;
      if (pendingSections > 0) return;
      applyColumnPriority(songArtistDetailListEl);
      applyMarquee(songArtistDetailListEl);
    }
    sections.forEach((section) => {
      const sectionEl = document.createElement("div");
      sectionEl.className = "album-section";
      const header = document.createElement("div");
      header.className = "album-section-header";
      header.textContent = section.album;
      sectionEl.appendChild(header);
      const list = document.createElement("ul");
      list.className = "playlist-list";
      renderSongRows(
        list,
        section.tracks,
        (track) => playFromList(track, allTracks, identity.name || "아티스트"),
        alignColumnsOnceAllSectionsRendered
      );
      sectionEl.appendChild(list);
      songArtistDetailListEl.appendChild(sectionEl);
    });
  }

  // 다른 목록 화면(곡 아티스트 탭 등)을 거치지 않고 곧장 상세로 전환한다 —
  // 이름 해석은 비동기(API 호출)라, 그 사이엔 어느 목록 패널도 새로 보여주지
  // 않고(이미 보이던 화면 그대로 유지) 해석이 끝나는 순간 한 번에 상세로 바꾼다.
  async function openSongArtistDetail(name) {
    mode = "song-artist";
    [...tabsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    normalizeFilterField();
    songsPanel.classList.remove("active");
    albumsPanel.classList.remove("active");
    artistsPanel.classList.remove("active");
    albumDetailPanel.classList.remove("active");
    currentAlbumGroup = null;
    songArtistsPanel.classList.remove("active");

    const identity = await api.resolveArtist(name);
    songArtistDetailIdentity = identity;
    renderSongArtistDetail(identity);
    songArtistDetailPanel.classList.add("active");
    if (refs && refs.router) refs.router.setUrl(`/browse/artists/${encodeURIComponent(identity.name)}`);
  }

  function closeSongArtistDetail() {
    songArtistDetailPanel.classList.remove("active");
    songArtistsPanel.classList.add("active");
    songArtistDetailIdentity = null;
    if (refs && refs.router) refs.router.setUrl("/browse/artists");
  }

  // 앨범 탭은 아티스트별 구획 없이 전체 앨범을 하나의 그리드로 보여준다(카드
  // 안에 아티스트명을 따로 표시). 드래그 정렬(SortableJS)도 구획 경계 없이 그리드
  // 전체에서 자유롭게 순서를 바꿀 수 있다.
  function renderAlbums() {
    const q = filterQuery.trim().toLowerCase();
    const field = filterField;
    albumsList.innerHTML = "";
    if (albumsSortable) {
      albumsSortable.destroy();
      albumsSortable = null;
    }

    // group.artist를 서클 이명 레지스트리로 대표 이름으로 바꿔서 검색/표시한다 —
    // 그래야 표기가 다른 앨범도 아티스트 탭에서 넘어온 대표 이름으로 필터링된다.
    const resolveCircleName = buildArtistNameResolver(circlesRegistry);
    const groups = groupAlbums(tracks, albums)
      .map((g) => ({ ...g, artist: resolveCircleName(g.artist || "") }))
      .filter((g) => matchesAlbum(g, q, field));
    renderedAlbumGroups = groups;
    if (!groups.length) {
      renderEmpty(albumsList);
      return;
    }

    groups.forEach((group) => albumsList.appendChild(buildAlbumCard(group)));

    albumsSortable = window.Sortable.create(albumsList, {
      animation: 150,
      forceFallback: true,
      handle: ".media-card-drag-handle",
      onEnd: async (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        albumsSortable.option("disabled", true);
        const moved = renderedAlbumGroups.splice(evt.oldIndex, 1)[0];
        renderedAlbumGroups.splice(evt.newIndex, 0, moved);
        const reorderedTrackIds = renderedAlbumGroups.flatMap((g) => g.tracks.map((t) => t.track_id));

        // 아티스트/검색으로 필터링된 상태라면 이 그리드엔 라이브러리 트랙의 일부만
        // 보인다. 그 부분집합의 새 순서를, 원래 그 트랙들이 전역 배열에서 차지하던
        // 슬롯(오름차순)에 그대로 채워 넣어 나머지 트랙 위치는 그대로 둔다(앨범
        // 상세 드래그와 동일한 방식) — 그래야 reorderPlaylistFull에 라이브러리
        // 전체 트랙 집합과 정확히 같은 목록을 보낼 수 있다.
        const idSet = new Set(reorderedTrackIds);
        const slots = [];
        tracks.forEach((t, i) => {
          if (idSet.has(t.track_id)) slots.push(i);
        });
        const byId = new Map(tracks.map((t) => [t.track_id, t]));
        const newTracks = tracks.slice();
        slots.forEach((slotIndex, i) => {
          newTracks[slotIndex] = byId.get(reorderedTrackIds[i]);
        });

        try {
          const result = await api.reorderPlaylistFull(libraryName, newTracks.map((t) => t.track_id));
          tracks = result.tracks;
        } catch (err) {
          await alertDialog(err.message);
          await resyncFromServer();
          render();
        } finally {
          albumsSortable.option("disabled", false);
        }
      },
    });

    // 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다(곡 목록과 동일).
    requestAnimationFrame(() => applyMarquee(albumsList));
  }

  function render() {
    if (mode === "song") renderSongs();
    else if (mode === "album") renderAlbums();
    else if (mode === "song-artist") renderSongArtists();
    else renderArtists();
  }

  // 지금 실제로 열려 있는 화면(탭 목록 또는 앨범/곡아티스트 상세)에 맞춰 다시
  // 그린다. store 갱신/트랙 전환처럼 "무엇이 보이는 중이든 최신 상태로 맞춰라"
  // 신호가 올 때 쓴다 — 상세 화면이 열려 있으면 그 상세를, 아니면 현재 탭을 그린다.
  function renderCurrentView() {
    if (albumDetailPanel.classList.contains("active")) {
      renderAlbumDetailRows(currentAlbumGroup);
    } else if (songArtistDetailPanel.classList.contains("active")) {
      renderSongArtistDetail(songArtistDetailIdentity);
    } else {
      render();
    }
  }

  // 앨범/아티스트 탭은 개별 곡명이 없는 그룹 단위라 "곡명" 범위가 의미가 없고,
  // 아티스트 탭은 앨범명 범위도 의미가 없다 — 그 상태로 넘어왔으면(circle 카드
  // 클릭 등으로 filterField가 남아있는 경우) "전체"로 되돌린다.
  function normalizeFilterField() {
    const isAlbumMode = mode === "album";
    const isArtistMode = mode === "artist" || mode === "song-artist";
    if ((isAlbumMode || isArtistMode) && filterField === "title") filterField = "all";
    if (isArtistMode && filterField === "album") filterField = "all";
  }

  function switchMode(next) {
    const enteringSong = next === "song" && mode !== "song";
    mode = next;
    if (mode !== "song") {
      selectedTrackIds.clear();
      syncSelectionUI();
    }
    if (enteringSong) songsPage = 0; // 곡 탭에 새로 들어올 때마다 1페이지부터 보여준다.
    albumDetailPanel.classList.remove("active");
    currentAlbumGroup = null;
    closeSongArtistDetail();
    songsPanel.classList.toggle("active", mode === "song");
    albumsPanel.classList.toggle("active", mode === "album");
    artistsPanel.classList.toggle("active", mode === "artist");
    songArtistsPanel.classList.toggle("active", mode === "song-artist");
    [...tabsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    normalizeFilterField();
    render();
    if (refs && refs.router) {
      // 내부 mode 값("artist"=서클, "song-artist"=아티스트)은 그대로 두고
      // URL만 새 이름을 쓴다(router.js의 parseRoute와 짝을 맞춤).
      const paths = { artist: "/browse/circles", "song-artist": "/browse/artists", album: "/browse/albums", song: "/browse/songs" };
      refs.router.setUrl(paths[mode] || "/browse/circles");
    }
  }

  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    // 서클 카드 클릭 시 앨범 탭으로 넘어가며 filterQuery에 그 서클명을
    // 채워두는데(openArtistAlbums), 그 상태로 탭 버튼을 눌러 수동으로 다른 탭으로
    // 옮기면 그 필터가 계속 남아있어 다른 항목이 안 보이는 문제가 있었다. 탭
    // 버튼을 직접 눌렀을 때는 항상 필터를 초기화해 전체 목록부터 다시 보여준다.
    filterQuery = "";
    filterField = "all";
    switchMode(btn.dataset.mode);
  });

  clearSelectionBtn.addEventListener("click", () => {
    selectedTrackIds.clear();
    lastClickedIndex = null;
    render();
  });

  albumDetailArt.classList.add("art-clickable");
  albumDetailArt.addEventListener("click", () => openImageLightbox(albumDetailArt.src));

  btnAlbumDetailBack.addEventListener("click", closeAlbumDetail);
  btnAlbumDetailDownload.addEventListener("click", () => {
    if (!currentAlbumGroup) return;
    // <a download>를 잠깐 만들어 클릭한 뒤 치운다 — 실제 zip 파일명은 서버의
    // Content-Disposition 헤더가 정해주므로 download 속성은 비워둔다.
    const a = document.createElement("a");
    a.href = api.albumDownloadUrl(currentAlbumGroup.id);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  btnAlbumDetailEdit.addEventListener("click", () => {
    if (currentAlbumGroup) onEditAlbum(currentAlbumGroup);
  });

  songArtistDetailBackBtn.addEventListener("click", closeSongArtistDetail);
  songArtistDetailEditBtn.addEventListener("click", () => {
    if (!songArtistDetailIdentity || !songArtistDetailIdentity.id) return;
    identityDialogApi.open(songArtistDetailIdentity, {
      getTracks: () => tracks,
      onChange: (updated) => {
        songArtistDetailIdentity = updated;
      },
      onClose: () => {
        if (songArtistDetailIdentity && songArtistDetailPanel.classList.contains("active")) {
          renderSongArtistDetail(songArtistDetailIdentity);
        }
      },
    });
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
  reimportArtistsBtn.addEventListener("click", () => reimportArtistsInput.click());
  reimportArtistsInput.addEventListener("change", async () => {
    await handleReimportArtists(reimportArtistsInput.files);
    reimportArtistsInput.value = "";
  });

  // 재생 곡이 바뀔 때마다 현재 보이는 목록(곡 목록 또는 앨범 상세)을 다시 그려
  // 재생 중 표시(강조 + ▶ 접두사)를 갱신한다.
  // 지금 실제로 보이는 화면의 곡 행 컨테이너. 앨범/아티스트/곡아티스트 탭은
  // 카드 그리드라 재생 중 표시나 평점 배지가 없으므로 null(patch할 대상 없음).
  function currentRowContainer() {
    if (albumDetailPanel.classList.contains("active")) return albumDetailList;
    if (songArtistDetailPanel.classList.contains("active")) return songArtistDetailListEl;
    if (mode === "song") return songsList;
    return null;
  }

  // 재생 곡이 바뀔 때마다 목록 전체를 다시 그리는 대신(모든 행의 마퀴 스크롤이
  // 리셋되는 원인이었다), 이전/새 재생 행 둘만 patch한다.
  player.addEventListener("trackchange", () => {
    const container = currentRowContainer();
    if (container) patchPlayingRow(container, player.currentTrack ? player.currentTrack.track_id : null);
  });

  // 재생바 하트로 레이팅을 바꾸면 그 곡이 보이는 목록(곡 목록/앨범 상세)에도
  // 바로 반영한다. player.currentTrack이 이 목록의 tracks 배열과 같은 객체
  // 참조를 공유하지 않을 수도 있으므로(예: 다른 재생목록 재생 중), track_id로
  // 찾아 직접 patch한다. 이것도 목록 전체가 아니라 그 행 하나만 patch한다.
  player.addEventListener("ratingchange", (e) => {
    const match = tracks.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    const container = currentRowContainer();
    if (container) patchRatingBadge(container, e.detail.trackId, e.detail.rating);
  });

  // 현재 화면에 보이는 목록에 대해서만 리사이즈 시 마퀴를 재계산한다.
  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      if (albumDetailPanel.classList.contains("active")) {
        applyColumnPriority(albumDetailList);
        applyMarquee(albumDetailList);
        applyMarquee(albumDetailTitleClip);
      } else if (songArtistDetailPanel.classList.contains("active")) {
        applyColumnPriority(songArtistDetailListEl);
        applyMarquee(songArtistDetailListEl);
      } else if (songsPanel.classList.contains("active")) {
        applyColumnPriority(songsList);
        applyMarquee(songsList);
        recalcSongsPageSize();
      } else if (albumsPanel.classList.contains("active")) {
        applyMarquee(albumsList);
      } else if (artistsPanel.classList.contains("active")) {
        applyMarquee(artistsList);
      } else if (songArtistsPanel.classList.contains("active")) {
        applyMarquee(songArtistsList);
      }
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  // 브라우즈 통합 검색: 곡/앨범/서클/아티스트를 한 번에 찾아, 고르면 지금 보고
  // 있는 탭 안에서 해당 상세로 바로 이동한다(곡은 검색 결과를 임시 재생목록
  // 삼아 바로 재생). 원래 사이드바에 있었으나, 브라우즈 화면에서만 쓰이므로
  // 브라우즈 헤더로 옮겼다.
  function closeSearchResults() {
    searchResultsEl.innerHTML = "";
    searchResultsEl.hidden = true;
  }

  function buildSearchGroup(title, items, labelFn, onPick) {
    if (!items.length) return null;
    const group = document.createElement("div");
    group.className = "browse-search-group";
    const heading = document.createElement("div");
    heading.className = "browse-search-group-title";
    heading.textContent = title;
    group.appendChild(heading);
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "browse-search-result-row";
      row.textContent = labelFn(item);
      row.addEventListener("mousedown", (e) => e.preventDefault()); // input의 blur보다 클릭이 먼저 처리되게
      row.addEventListener("click", () => {
        onPick(item);
        searchInput.value = "";
        closeSearchResults();
      });
      group.appendChild(row);
    });
    return group;
  }

  function renderSearchResults(query) {
    const result = searchAll(query);
    searchResultsEl.innerHTML = "";
    const groups = [
      buildSearchGroup(
        "곡",
        result.tracks,
        (t) => (t.artist ? `${t.title || t.track_id} — ${t.artist}` : t.title || t.track_id),
        (t) => {
          player.setPlaylist({ name: "검색 결과", tracks: result.tracks });
          player.playIndex(result.tracks.indexOf(t));
        }
      ),
      buildSearchGroup("앨범", result.albums, (a) => a.name || "(앨범 없음)", (a) => {
        const group = groupAlbums(tracks, albums).find((g) => g.id === a.id);
        if (group) openAlbumDetail(group);
      }),
      buildSearchGroup("서클", result.circles, (name) => name, (name) => openArtistAlbums(name)),
      buildSearchGroup("아티스트", result.songArtists, (name) => name, (name) => openSongArtistDetail(name)),
    ].filter(Boolean);

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "browse-search-empty";
      empty.textContent = "검색 결과가 없습니다.";
      searchResultsEl.appendChild(empty);
    } else {
      groups.forEach((g) => searchResultsEl.appendChild(g));
    }
    searchResultsEl.hidden = false;
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    if (!q) {
      closeSearchResults();
      return;
    }
    store.ensureLoaded().then(() => renderSearchResults(q));
  });
  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim()) renderSearchResults(searchInput.value.trim());
  });
  searchInput.addEventListener("blur", closeSearchResults);
  // 한글 입력처럼 조합 중에는 input 이벤트가 아직 완성되지 않은 글자를 검색할
  // 수 있으므로, 엔터로 입력을 마치면 그 시점의 값으로 결과를 다시 확실히 띄운다.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = searchInput.value.trim();
    if (q) store.ensureLoaded().then(() => renderSearchResults(q));
  });

  // -- 드래그로 순서 변경 (재생목록 화면과 동일한 SortableJS 인터페이스) ------
  // 곡 목록은 evt.oldIndex/newIndex를 그대로 전체 라이브러리 인덱스로 써서
  // 서버에 보내므로(reorderPlaylist), 검색어가 있으면 화면에 보이는 목록이
  // 전체의 일부일 뿐이라 인덱스가 어긋난다 — 검색 중엔 곡 목록 드래그를 막는다.
  // 앨범 목록/앨범 상세는 옮겨진 트랙 id들을 원래 전역 배열에서 차지하던
  // 슬롯에 다시 채워 넣는 방식(reorderPlaylistFull)이라 필터링 여부와
  // 무관하게 항상 정확하므로 검색 중에도 막을 필요가 없다.
  //
  // 드래그는 전용 손잡이(그립 아이콘)를 잡을 때만 시작된다(SortableJS의
  // handle 옵션). 그래서 행/카드의 나머지 영역은 클릭·롱프레스 선택·모바일
  // 스크롤 등 원래 제스처와 절대 충돌하지 않는다 — 굳이 홀드 지연을 둘
  // 필요가 없다. 다만 네이티브 HTML5 드래그는 모바일 터치에서 지원이
  // 불안정하므로(특히 iOS Safari), 자체 JS 드래그 구현(forceFallback)을
  // 강제해 터치에서도 일관되게 동작하게 한다.
  function isSongSearchActive() {
    return filterQuery.trim() !== "";
  }

  async function resyncFromServer() {
    await loadLibraryAndAlbums();
  }

  // 성공 시엔 SortableJS가 이미 화면의 행/카드를 드래그한 자리로 옮겨둔
  // 상태라 굳이 목록 전체를 허물고 다시 그릴 필요가 없다(다시 그리면 특히
  // 이미지가 새로 로딩되는 앨범 카드가 잠깐 사라졌다 나타나며 "복사된 것처럼"
  // 보이는 깜빡임이 생긴다). 실패했을 때만 서버와 어긋난 화면을 되돌리기 위해
  // 다시 그린다. 또한 진행 중엔 같은 목록의 드래그를 잠가서, 응답이 오기 전에
  // 연달아 드래그하다 요청 순서가 뒤섞여 순서가 꼬이는 일을 막는다.
  const songsSortable = window.Sortable.create(songsList, {
    animation: 150,
    forceFallback: true,
    handle: ".playlist-row-drag-handle",
    onEnd: async (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      songsSortable.option("disabled", true);
      try {
        const result = await api.reorderPlaylist(libraryName, evt.oldIndex, evt.newIndex);
        tracks = result.tracks;
      } catch (err) {
        await alertDialog(err.message);
        render();
      } finally {
        songsSortable.option("disabled", isSongSearchActive());
      }
    },
  });

  const albumDetailSortable = window.Sortable.create(albumDetailList, {
    animation: 150,
    forceFallback: true,
    handle: ".playlist-row-drag-handle",
    onEnd: async (evt) => {
      if (evt.oldIndex === evt.newIndex || !currentAlbumGroup) return;
      albumDetailSortable.option("disabled", true);
      // 원본 배열은 건드리지 않고 사본으로 새 순서를 계산한다 — API 실패 시
      // currentAlbumGroup을 그대로 다시 그리면 되도록 하기 위함.
      const reordered = currentAlbumGroup.tracks.slice();
      const moved = reordered.splice(evt.oldIndex, 1)[0];
      reordered.splice(evt.newIndex, 0, moved);

      // 이 앨범 트랙들이 전역 라이브러리 배열에서 원래 차지하던 슬롯(오름차순)에,
      // 새로 정렬된 순서를 그대로 채워 넣는다. 다른 앨범 트랙들의 위치는 그대로다.
      const idSet = new Set(reordered.map((t) => t.track_id));
      const slots = [];
      tracks.forEach((t, i) => {
        if (idSet.has(t.track_id)) slots.push(i);
      });
      const newTracks = tracks.slice();
      slots.forEach((slotIndex, i) => {
        newTracks[slotIndex] = reordered[i];
      });

      try {
        const result = await api.reorderPlaylistFull(libraryName, newTracks.map((t) => t.track_id));
        tracks = result.tracks;
        const groups = groupAlbums(tracks, albums);
        const match = groups.find((g) => g.id === currentAlbumGroup.id);
        currentAlbumGroup = match || currentAlbumGroup;
      } catch (err) {
        await alertDialog(err.message);
        renderAlbumDetailRows(currentAlbumGroup);
      } finally {
        albumDetailSortable.option("disabled", false);
      }
    },
  });

  return {
    // focus 없이 들어오면 기본으로 아티스트 탭을 보여준다. focus를 넘기면(재생바
    // 앨범명 클릭, 재생 통계 TOP3 앨범 클릭 등 외부 진입점용) 대신 앨범 탭으로
    // 들어간 뒤 그 앨범의 상세 화면을 곧바로 연다 — 상세 화면을 닫으면
    // closeAlbumDetail이 항상 앨범 탭으로 돌아가므로, 그와 짝이 맞게 앨범 탭에서
    // 시작해야 한다. 라우터의 onBrowse가 이 인자와 함께 호출하므로, show() 안에서
    // 한 번의 흐름으로 처리해야 라이브러리 로딩/모드 전환과 상세 열기 사이에
    // 경쟁 상태가 생기지 않는다. track_id를 우선 매칭하되, 재생 기록처럼 그
    // 트랙이 더 이상 라이브러리에 없을 수 있는 경우를 대비해 album+artist로도
    // 매칭한다.
    // artistFocus(아티스트 이름 문자열)를 넘기면(재생 통계 '아티스트' 탭 카드
    // 클릭 등) 앨범 탭으로 들어가 그 아티스트명으로 검색해둔 상태를 보여준다 —
    // openArtistAlbums과 동일한 진입점을 외부에도 열어주는 것뿐이다.
    // route는 라우터가 해석한 현재 URL(/browse/... 의 mode/albumId/songArtistName/
    // artistFilter)이다 — 직접 접속/새로고침/뒤로가기처럼 URL 자체가 진입점일 때
    // 그 상태를 그대로 복원한다. focus/artistFocus는 기존처럼 다른 화면(재생바
    // 앨범명, 재생 통계 아티스트 카드 등)에서 넘어온 "다음 브라우즈 진입 시
    // 열어야 할 대상"이며, 아직 앨범 id/정확한 이름을 모르는 채로(track_id/
    // album/artist 문자열만 갖고) 넘어오므로 URL만으로는 표현할 수 없어
    // 여전히 refs의 임시 필드로 전달받는다. 화면이 열리면 그 즉시 실제 위치에
    // 맞는 URL로 주소창을 맞춘다(각 함수 안의 setUrl 호출).
    async show(route, focus, artistFocus) {
      panelEl.classList.add("active");
      filterQuery = "";
      filterField = "all";
      syncFromStore();

      // 목표 탭을 먼저 정해서 지금 있는 캐시로(콜드 스타트라 비어있어도) 즉시
      // 그린다 — 예전엔 fetch가 끝난 뒤에야 탭을 정해서, 그동안 직전 탭(주로
      // 기본값인 "아티스트" 탭)이 목적지와 무관하게 잠깐 보이는 버그가 있었다.
      if (artistFocus) {
        openArtistAlbums(artistFocus);
      } else if (route && route.mode === "album" && route.artistFilter) {
        openArtistAlbums(route.artistFilter);
      } else if (route && route.songArtistName) {
        // openSongArtistDetail 스스로 목록 화면을 거치지 않고 곧장 상세로
        // 전환하므로, 여기서 switchMode("song-artist")를 먼저 부르지 않는다.
      } else {
        switchMode(focus ? "album" : (route && route.mode) || "artist");
      }
      loadTodaySongs();

      // store에 이미 캐시가 있으면(재진입 등 흔한 경우) fetch를 기다리지 않고
      // 배경에서만 새로고침한다 — 위에서 이미 캐시로 그렸으므로 화면은 즉시
      // 보인다. 아직 한 번도 못 불러왔으면(세션 첫 진입) 채울 데이터 자체가
      // 없으니 이번만 기다린다(store.ensureLoaded()가 그 판단을 해준다).
      if (!store.isLoaded()) {
        renderLoading(songsList);
        renderLoading(albumsList);
        renderLoading(artistsList);
      }
      await store.ensureLoaded();
      syncFromStore();

      if (focus) {
        const group = groupAlbums(tracks, albums).find(
          (g) =>
            g.tracks.some((t) => t.track_id === focus.track_id) ||
            (focus.album && g.album === focus.album && g.artist === focus.artist)
        );
        if (group) openAlbumDetail(group);
      } else if (route && route.albumId) {
        const group = groupAlbums(tracks, albums).find((g) => g.id === route.albumId);
        if (group) openAlbumDetail(group);
        else if (refs && refs.router) refs.router.setUrl("/browse/albums");
      } else if (route && route.songArtistName) {
        await openSongArtistDetail(route.songArtistName);
      }
    },
    hide() {
      panelEl.classList.remove("active");
    },
    async refreshAfterAlbumUpdate() {
      await loadLibraryAndAlbums();
      if (currentAlbumGroup) {
        const groups = groupAlbums(tracks, albums);
        const match = groups.find((g) => g.id === currentAlbumGroup.id);
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
    setLyricsActive(active) {
      lyricsActive = active;
      renderTodaySongsTop3();
      renderRecommendedAlbums();
      renderRecommendedCircles();
    },
  };
}
