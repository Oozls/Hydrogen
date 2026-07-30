import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
import { showProgress, setProgress, hideProgress } from "./progress.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee, applyColumnPriority, createMarqueeClip } from "./marquee.js";
import { openImageLightbox } from "./imageLightbox.js";
import { groupAlbums, matchesAlbum } from "./albumGroup.js";
import { showArtSpinner } from "./artspinner.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
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

export function setupBrowse(player, playlistApi, onEditTrack, onEditAlbum, onBulkEdit) {
  const panelEl = document.getElementById("browse-panel");
  const searchInput = document.getElementById("browse-search");
  const searchFieldSelect = document.getElementById("browse-search-field");
  const searchFieldTitleOption = searchFieldSelect.querySelector('option[value="title"]');
  const tabsEl = document.getElementById("browse-tabs");
  const songsPanel = document.getElementById("browse-songs-panel");
  const albumsPanel = document.getElementById("browse-albums-panel");
  const albumDetailPanel = document.getElementById("browse-album-detail-panel");
  const songsList = document.getElementById("browse-songs-list");
  const songsPagination = document.getElementById("browse-songs-pagination");
  const songsPrevPageBtn = document.getElementById("browse-songs-prev-page");
  const songsNextPageBtn = document.getElementById("browse-songs-next-page");
  const songsPageLabel = document.getElementById("browse-songs-page-label");
  const songsTop3El = document.getElementById("browse-songs-top3");
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
  const fileInput = document.getElementById("browse-file-input");
  const folderInput = document.getElementById("browse-folder-input");

  let tracks = [];
  let libraryName = null;
  let mode = "song";
  let selectedTrackIds = new Set();
  let lastClickedIndex = null;
  let currentAlbumGroup = null;
  let renderedAlbumGroups = [];
  let albumSectionSortables = [];
  let songsPage = 0;
  let songsPageSize = SONGS_PAGE_SIZE_FALLBACK;
  let todaySongs = [];
  // 가사 패널이 열려 있으면 재생 통계 TOP 3 앨범과 마찬가지로 이 위젯도 숨긴다(공간 확보).
  let lyricsActive = false;

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
      libraryName = library.name;
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
  }

  function renderSongs() {
    const validIds = new Set(tracks.map((t) => t.track_id));
    for (const id of selectedTrackIds) {
      if (!validIds.has(id)) selectedTrackIds.delete(id);
    }

    const q = searchInput.value.trim().toLowerCase();
    const field = searchFieldSelect.value;
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
    albumDetailArtist.textContent = group.artist || "";
    showAlbumDetailArt(`${api.artUrl(group.track_id)}?t=${Date.now()}`);
    requestAnimationFrame(() => applyMarquee(albumDetailTitleClip));
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
    img.src = api.artUrl(group.track_id);
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

    // 아티스트명은 이미 구획 헤더(.album-section-header)에 보여주므로 카드
    // 안에서는 중복 표시하지 않는다.
    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    meta.textContent = `${group.tracks.length}곡`;
    card.appendChild(meta);

    card.addEventListener("click", () => openAlbumDetail(group));
    return card;
  }

  // 앨범 탭은 아티스트별로 구획을 나눠 보여준다. 아티스트명(+같은 아티스트
  // 안에서는 앨범명)순으로 정렬해야 같은 아티스트의 앨범들이 인접해서 하나의
  // 구획으로 묶인다. 드래그 정렬(SortableJS)도 구획마다 별도 인스턴스라 같은
  // 아티스트 구획 안에서만 순서를 바꿀 수 있고, 다른 아티스트 구획으로는 넘어가지
  // 않는다 — 구획 경계가 항상 아티스트명 정렬과 일치하도록 지키기 위함이다.
  function renderAlbums() {
    const q = searchInput.value.trim().toLowerCase();
    const field = searchFieldSelect.value;
    albumsList.innerHTML = "";
    albumSectionSortables.forEach((s) => s.destroy());
    albumSectionSortables = [];

    const groups = groupAlbums(tracks).filter((g) => matchesAlbum(g, q, field));
    // 아티스트명으로만 정렬한다(구획 경계/순서 결정용). Array.sort는 안정 정렬이라
    // 같은 아티스트 안에서는 원래 순서(= 라이브러리의 트랙 순서, 즉 드래그로 정한
    // 순서)가 그대로 유지된다 — 여기서 앨범명까지 같이 정렬해버리면 드래그로 바꾼
    // 구획 내 순서가 다음 렌더링마다 알파벳순으로 되돌아가 버린다.
    groups.sort((a, b) => (a.artist || "").localeCompare(b.artist || "", "ko"));
    renderedAlbumGroups = groups;
    if (!groups.length) {
      renderEmpty(albumsList);
      return;
    }

    const sections = [];
    for (const group of groups) {
      const artist = group.artist || "";
      const last = sections[sections.length - 1];
      if (last && last.artist === artist) last.groups.push(group);
      else sections.push({ artist, groups: [group] });
    }

    sections.forEach((section) => {
      const sectionEl = document.createElement("div");
      sectionEl.className = "album-section";

      const header = document.createElement("div");
      header.className = "album-section-header";
      header.textContent = section.artist || "(아티스트 없음)";
      sectionEl.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "album-section-grid";
      section.groups.forEach((group) => grid.appendChild(buildAlbumCard(group)));
      sectionEl.appendChild(grid);

      albumsList.appendChild(sectionEl);

      const sectionSortable = window.Sortable.create(grid, {
        animation: 150,
        forceFallback: true,
        direction: "horizontal",
        handle: ".media-card-drag-handle",
        onEnd: async (evt) => {
          if (evt.oldIndex === evt.newIndex) return;
          albumSectionSortables.forEach((s) => s.option("disabled", true));
          const moved = section.groups.splice(evt.oldIndex, 1)[0];
          section.groups.splice(evt.newIndex, 0, moved);
          renderedAlbumGroups = sections.flatMap((s) => s.groups);
          const newOrder = renderedAlbumGroups.flatMap((g) => g.tracks.map((t) => t.track_id));
          try {
            const result = await api.reorderPlaylistFull(libraryName, newOrder);
            tracks = result.tracks;
          } catch (err) {
            await alertDialog(err.message);
            await resyncFromServer();
            render();
          } finally {
            albumSectionSortables.forEach((s) => s.option("disabled", isSongSearchActive()));
          }
        },
      });
      albumSectionSortables.push(sectionSortable);
    });

    // 레이아웃이 확정된 다음 프레임에 폭을 측정해야 하므로 rAF로 미룬다(곡 목록과 동일).
    requestAnimationFrame(() => applyMarquee(albumsList));
  }

  function render() {
    if (mode === "song") renderSongs();
    else renderAlbums();
  }

  // 앨범 탭은 개별 곡명이 없는 그룹 단위라 "곡명" 범위가 의미가 없다 —
  // 선택지에서 아예 비활성화하고, 곡 탭에서 곡명을 고른 채로 넘어왔으면
  // "전체"로 되돌린다.
  function syncSearchFieldOptions() {
    const isAlbumMode = mode === "album";
    searchFieldTitleOption.disabled = isAlbumMode;
    if (isAlbumMode && searchFieldSelect.value === "title") searchFieldSelect.value = "all";
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
    songsPanel.classList.toggle("active", mode === "song");
    albumsPanel.classList.toggle("active", mode === "album");
    [...tabsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    syncSearchFieldOptions();
    render();
  }

  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    switchMode(btn.dataset.mode);
  });

  searchInput.addEventListener("input", () => {
    songsPage = 0;
    render();
  });
  searchFieldSelect.addEventListener("change", () => {
    songsPage = 0;
    render();
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
    a.href = api.albumDownloadUrl(currentAlbumGroup.album, currentAlbumGroup.artist);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
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

  // 재생바 하트로 레이팅을 바꾸면 그 곡이 보이는 목록(곡 목록/앨범 상세)에도
  // 바로 반영한다. player.currentTrack이 이 목록의 tracks 배열과 같은 객체
  // 참조를 공유하지 않을 수도 있으므로(예: 다른 재생목록 재생 중), track_id로
  // 찾아 직접 patch한다.
  player.addEventListener("ratingchange", (e) => {
    const match = tracks.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    if (albumDetailPanel.classList.contains("active")) {
      renderAlbumDetailRows(currentAlbumGroup);
    } else if (mode === "song") {
      renderSongs();
    }
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
      } else if (songsPanel.classList.contains("active")) {
        applyColumnPriority(songsList);
        applyMarquee(songsList);
        recalcSongsPageSize();
      } else if (albumsPanel.classList.contains("active")) {
        applyMarquee(albumsList);
      }
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  // -- 드래그로 순서 변경 (재생목록 화면과 동일한 SortableJS 인터페이스) ------
  // 검색어가 있으면 화면에 보이는 목록이 전체 라이브러리의 일부일 뿐이라 드래그
  // 인덱스가 실제 순서와 어긋나므로, 검색 중에는 곡/앨범 목록 드래그를 막는다.
  // (앨범 상세는 검색으로 걸러지지 않는 목록이라 항상 켜둔다.)
  //
  // 드래그는 전용 손잡이(그립 아이콘)를 잡을 때만 시작된다(SortableJS의
  // handle 옵션). 그래서 행/카드의 나머지 영역은 클릭·롱프레스 선택·모바일
  // 스크롤 등 원래 제스처와 절대 충돌하지 않는다 — 굳이 홀드 지연을 둘
  // 필요가 없다. 다만 네이티브 HTML5 드래그는 모바일 터치에서 지원이
  // 불안정하므로(특히 iOS Safari), 자체 JS 드래그 구현(forceFallback)을
  // 강제해 터치에서도 일관되게 동작하게 한다.
  function isSongSearchActive() {
    return searchInput.value.trim() !== "";
  }

  async function resyncFromServer() {
    const library = await api.getLibrary();
    tracks = library.tracks;
    libraryName = library.name;
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
        const groups = groupAlbums(tracks);
        const match = groups.find(
          (g) => g.album === currentAlbumGroup.album && g.artist === currentAlbumGroup.artist
        );
        currentAlbumGroup = match || currentAlbumGroup;
      } catch (err) {
        await alertDialog(err.message);
        renderAlbumDetailRows(currentAlbumGroup);
      } finally {
        albumDetailSortable.option("disabled", false);
      }
    },
  });

  searchInput.addEventListener("input", () => {
    const disabled = isSongSearchActive();
    songsSortable.option("disabled", disabled);
    albumSectionSortables.forEach((s) => s.option("disabled", disabled));
  });

  return {
    // focus를 넘기면 앨범 탭으로 들어간 뒤 그 앨범의 상세 화면을 곧바로 연다
    // (재생바 앨범명 클릭, 재생 통계 TOP3 앨범 클릭 등 외부 진입점용). 라우터의
    // onBrowse가 이 인자와 함께 호출하므로, show() 안에서 한 번의 흐름으로
    // 처리해야 라이브러리 로딩/모드 전환과 상세 열기 사이에 경쟁 상태가 생기지
    // 않는다. track_id를 우선 매칭하되, 재생 기록처럼 그 트랙이 더 이상
    // 라이브러리에 없을 수 있는 경우를 대비해 album+artist로도 매칭한다.
    async show(focus) {
      panelEl.classList.add("active");
      searchInput.value = "";
      searchFieldSelect.value = "all";
      renderLoading(songsList);
      renderLoading(albumsList);
      const library = await api.getLibrary();
      tracks = library.tracks;
      libraryName = library.name;
      switchMode("album");
      loadTodaySongs();
      if (focus) {
        const group = groupAlbums(tracks).find(
          (g) =>
            g.tracks.some((t) => t.track_id === focus.track_id) ||
            (focus.album && g.album === focus.album && g.artist === focus.artist)
        );
        if (group) openAlbumDetail(group);
      }
    },
    hide() {
      panelEl.classList.remove("active");
    },
    async refreshAfterAlbumUpdate() {
      const library = await api.getLibrary();
      tracks = library.tracks;
      libraryName = library.name;
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
    setLyricsActive(active) {
      lyricsActive = active;
      renderTodaySongsTop3();
    },
  };
}
