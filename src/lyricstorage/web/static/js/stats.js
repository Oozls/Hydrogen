import { api } from "./api.js";
import { store } from "./store.js";
import { iconSpan } from "./icons.js";
import { showArtSpinner } from "./artspinner.js";
import { createMarqueeClip, applyMarquee, applyColumnPriority } from "./marquee.js";
import { fillArtistArt } from "./artistArt.js";
import { splitArtists, buildArtistNameResolver, buildArtistCell } from "./songArtist.js";
import { patchPlayingRow, patchRatingBadge } from "./rowPatch.js";

const MARQUEE_RESIZE_DEBOUNCE_MS = 150;
const TRACK_PAGE_SIZE_FALLBACK = 50;

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function formatRange(startIso, endIso, period) {
  const start = new Date(startIso);
  if (period === "month") return `${start.getFullYear()}년 ${start.getMonth() + 1}월`;
  if (period === "day") return ymd(start);
  const end = new Date(new Date(endIso).getTime() - 1);
  return `${ymd(start)} ~ ${ymd(end)}`;
}

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// 게임 플레이타임처럼 "N시간 M분" 형태로 사용 시간을 보여준다(1시간 미만이면
// 분만, 1분 미만이면 초만 — 곡 재생 시간(fmtDuration)과 달리 mm:ss로 뭉개면
// 며칠치 총합 같은 큰 값이 안 읽힌다).
function fmtHM(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분`;
  return `${seconds}초`;
}

// "마지막 재생" 표시용 — 최근이면 상대 시간, 오래됐으면(1주 이상) 절대 날짜로 보여준다.
function fmtRelativeTime(iso) {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  return ymd(new Date(then));
}

// 가사 유무 아이콘과 같은 이유로 레이팅이 없는 곡도 배지 자리를 항상 차지하게
// 만들고 visibility로만 숨긴다(브라우즈/재생목록과 동일한 패턴).
function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
}

const VALID_PERIODS = ["day", "week", "month"];
const VALID_GROUPS = ["track", "circle", "artist", "album"];

export function setupStats(player, onOpenAlbum, identityDialogApi, onOpenArtist, refs) {
  const panelEl = document.getElementById("stats-panel");
  const periodTabs = document.getElementById("stats-period-tabs");
  const groupTabs = document.getElementById("stats-group-tabs");
  const prevBtn = document.getElementById("btn-stats-prev");
  const nextBtn = document.getElementById("btn-stats-next");
  const periodLabel = document.getElementById("stats-period-label");
  const periodUsageEl = document.getElementById("stats-period-usage");
  const totalUsageEl = document.getElementById("stats-total-usage");
  const listEl = document.getElementById("stats-list");
  const trackBodyEl = document.getElementById("stats-track-body");
  const trackListEl = document.getElementById("stats-track-list");
  const top3El = document.getElementById("stats-track-top3");
  const trackPagination = document.getElementById("stats-track-pagination");
  const trackPrevPageBtn = document.getElementById("stats-track-prev-page");
  const trackNextPageBtn = document.getElementById("stats-track-next-page");
  const trackPageLabel = document.getElementById("stats-track-page-label");
  const artistDetailPanel = document.getElementById("stats-artist-detail-panel");
  const artistDetailTitleEl = document.getElementById("stats-artist-detail-title");
  const artistDetailAliasesEl = document.getElementById("stats-artist-detail-aliases");
  const artistDetailListEl = document.getElementById("stats-artist-detail-list");
  const artistDetailBackBtn = document.getElementById("btn-stats-artist-detail-back");
  const artistDetailEditBtn = document.getElementById("btn-stats-artist-detail-edit");
  const circleDetailPanel = document.getElementById("stats-circle-detail-panel");
  const circleDetailTitleEl = document.getElementById("stats-circle-detail-title");
  const circleDetailAliasesEl = document.getElementById("stats-circle-detail-aliases");
  const circleDetailListEl = document.getElementById("stats-circle-detail-list");
  const circleDetailBackBtn = document.getElementById("btn-stats-circle-detail-back");
  const circleDetailEditBtn = document.getElementById("btn-stats-circle-detail-edit");

  let period = "day";
  let group = "track";
  let offset = 0;
  // "곡" 그룹은 앨범 커버 카드 대신 일반 곡 목록처럼(재생 횟수 순, 동률이면 최근 재생 순) 보여준다.
  let trackItems = [];
  let trackPage = 0;
  let trackPageSize = TRACK_PAGE_SIZE_FALLBACK;
  let lastTrackPageTotalPages = 1;
  let trackPageLabelEditing = false;
  let lastAlbumItems = [];
  // "앨범" 탭에서 앨범 카드에 곡 아티스트 대신 앨범 아티스트명을 보여주기 위한 조회용.
  let albumMetaById = new Map();
  // 아티스트 그룹 카드의 콜라주 표지를 위해, 곡 아티스트별로 그 아티스트가
  // 참여한(쉼표 분리 기준) 곡들이 속한 앨범 목록을 미리 계산해둔다.
  let artistAlbumsMap = new Map();
  let artistDetailArtist = null;
  let artistDetailTracks = [];
  // 곡 아티스트 상세 화면에 지금 열려 있는 정체성({id, name, aliases}).
  // 이명 추가/삭제·대표 이름 변경 후 목록을 다시 매칭하는 데 쓴다.
  let artistDetailIdentity = null;
  // 이명/대표 이름을 바꾼 채로 상세 화면에서 뒤로 가면, 아티스트 순위 목록도
  // 옛 이름 기준으로 남아있지 않도록 한 번 더 새로고침한다.
  let artistIdentityDirty = false;
  // 서클 상세 화면에 지금 열려 있는 정체성 — 아티스트 상세와 동일한 패턴.
  let circleDetailIdentity = null;
  let circleIdentityDirty = false;

  // 곡 아티스트별 소속 앨범 맵을 새로 계산한다(아티스트 카드 콜라주/상세 화면
  // 공용). 라이브러리 스냅샷 전체가 필요하므로 아티스트 그룹을 볼 때만 부른다.
  async function loadArtistAlbumsMap() {
    await store.ensureLoaded();
    const albumById = new Map(store.getAlbums().map((a) => [a.id, a]));
    const resolveName = buildArtistNameResolver(store.getArtists());
    const map = new Map();
    for (const track of store.getTracks()) {
      for (const rawName of splitArtists(track.artist)) {
        const name = resolveName(rawName);
        if (!map.has(name)) map.set(name, new Map());
        if (track.album_id && albumById.has(track.album_id)) {
          map.get(name).set(track.album_id, albumById.get(track.album_id));
        }
      }
    }
    artistAlbumsMap = new Map([...map.entries()].map(([name, albums]) => [name, [...albums.values()]]));
  }

  function renderLoading(container) {
    container.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    container.appendChild(loading);
  }

  // 곡/서클/아티스트/앨범 어느 그룹을 보고 있든 항상 같이 갱신되어야 하므로,
  // group에 따라 갈라지는 refresh() 본문과 분리해 독립적으로 부른다(실패해도
  // 나머지 통계 화면에 영향 없게 await하지 않는다).
  async function refreshUsage() {
    try {
      const usage = await api.getUsageStats(period, offset);
      periodUsageEl.textContent = `이 기간 사용 ${fmtHM(usage.period_seconds)}`;
      totalUsageEl.textContent = `총 사용 ${fmtHM(usage.total_seconds)}`;
    } catch (_err) {
      /* 사용 시간 집계 실패는 조용히 무시 */
    }
  }

  async function refresh() {
    closeArtistDetail();
    closeCircleDetail();
    refreshUsage();
    const isCatalog = group === "circle";
    const isTrack = group === "track";
    // 기간/분류 탭을 바꾸는 동안 이전 화면이 잠깐 그대로 멈춰 있는 것처럼 보이는
    // 대신, 데이터가 오기 전부터 바로 로딩 표시로 바꾼다.
    trackBodyEl.hidden = !isTrack;
    trackPagination.hidden = true;
    listEl.style.display = isTrack ? "none" : "";
    if (isTrack) top3El.hidden = true;
    renderLoading(isTrack ? trackListEl : listEl);

    if (isCatalog) {
      await renderAlbumArtists();
      return;
    }
    if (isTrack) {
      // 곡 목록과 오른쪽 TOP 3 앨범은 같은 기간을 대상으로 하는 별개의 집계라
      // 병렬로 받아온다(둘 다 이미 있는 /api/stats/top 엔드포인트 재사용).
      const [trackData, albumData] = await Promise.all([
        api.getTopStats(period, "track", offset),
        api.getTopStats(period, "album", offset),
      ]);
      periodLabel.textContent = formatRange(trackData.range_start, trackData.range_end, period);
      nextBtn.disabled = offset <= 0;
      trackItems = await enrichTracks(trackData.items);
      trackPage = 0;
      renderTrackPage();
      lastAlbumItems = albumData.items.slice(0, 3);
      renderTop3Albums(lastAlbumItems);
    } else {
      const data = await api.getTopStats(period, group, offset);
      periodLabel.textContent = formatRange(data.range_start, data.range_end, period);
      nextBtn.disabled = offset <= 0;
      if (group === "artist") await loadArtistAlbumsMap();
      if (group === "album") {
        await store.ensureLoaded();
        albumMetaById = new Map(store.getAlbums().map((a) => [a.id, a]));
      }
      renderList(data.items, group);
    }
  }

  function buildTop3Card(item, i) {
    const card = document.createElement("div");
    card.className = "media-card";
    if (item.album && onOpenAlbum) {
      card.classList.add("media-card-clickable");
      card.title = "앨범 보기";
      card.addEventListener("click", () => onOpenAlbum(item));
    }

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    if (item.album_id) {
      const stopSpin = showArtSpinner(artWrap);
      const img = document.createElement("img");
      img.className = "media-card-art";
      img.alt = "";
      img.loading = "lazy";
      img.src = api.albumArtUrl(item.album_id);
      img.onload = () => stopSpin();
      img.onerror = () => {
        stopSpin();
        img.remove();
        artWrap.appendChild(iconSpan("music", "icon-lg"));
      };
      artWrap.appendChild(img);
    } else {
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    }
    const rank = document.createElement("span");
    rank.className = "media-card-rank";
    rank.textContent = `${i + 1} · ${item.count}회`;
    artWrap.appendChild(rank);
    card.appendChild(artWrap);

    const title = document.createElement("div");
    title.className = "media-card-title";
    title.textContent = item.album || "(앨범 없음)";
    card.appendChild(title);

    if (item.artist) {
      const artist = document.createElement("div");
      artist.className = "media-card-artist";
      artist.textContent = item.artist;
      card.appendChild(artist);
    }

    return card;
  }

  function renderTop3Albums(items) {
    top3El.innerHTML = "";
    if (!items.length) {
      top3El.hidden = true;
      return;
    }
    top3El.hidden = false;
    const heading = document.createElement("div");
    heading.className = "stats-track-top3-heading";
    heading.textContent = "TOP 3 앨범";
    top3El.appendChild(heading);
    items.forEach((item, i) => top3El.appendChild(buildTop3Card(item, i)));
  }

  // 재생 기록에는 재생 당시의 title/artist/album만 남고 duration/레이팅/가사
  // 유무는 없으므로, 현재 라이브러리 스냅샷과 track_id로 대조해 채운다. 라이브러리에서
  // 이미 지워진 곡은 기록에 남아있던 정보만으로 표시한다.
  async function enrichTracks(items) {
    let libraryTracks = [];
    try {
      await store.ensureLoaded();
      libraryTracks = store.getTracks();
    } catch (_err) {
      libraryTracks = [];
    }
    const byId = new Map(libraryTracks.map((t) => [t.track_id, t]));
    return items.map((item) => {
      const live = byId.get(item.track_id);
      const base = live
        ? { ...live }
        : {
            track_id: item.track_id,
            title: item.title,
            artist: item.artist,
            album: item.album,
            duration_ms: 0,
            has_lyrics: false,
            rating: 0,
          };
      base.play_count = item.count || 0;
      base.listened_ms = item.listened_ms || 0;
      base.last_played_at = item.last_played_at || null;
      return base;
    });
  }

  // 더블클릭 없이 한 번 클릭으로 바로 재생하고(요청사항), 이 최근 재생 목록
  // 전체를 임시 재생목록으로 잡아 다음/이전 곡이 이어지게 한다.
  function playTrack(track) {
    const index = trackItems.findIndex((t) => t.track_id === track.track_id);
    if (index < 0) return;
    player.setPlaylist({ name: "최근 재생", tracks: trackItems });
    player.playIndex(index);
  }

  function buildTrackRow(track) {
    const li = document.createElement("li");
    li.className = "playlist-row";
    li.dataset.trackId = track.track_id;
    const isPlaying = player.currentTrack && player.currentTrack.track_id === track.track_id;
    if (isPlaying) li.classList.add("playing");

    const label = document.createElement("span");
    label.className = "playlist-row-label";
    label.appendChild(
      createMarqueeClip(
        "playlist-row-title-clip",
        "playlist-row-title",
        (isPlaying ? "▶ " : "") + (track.title || track.track_id)
      )
    );
    const albumClip = createMarqueeClip("playlist-row-album", "", track.album || "");
    if (track.album && onOpenAlbum) {
      albumClip.classList.add("playlist-row-album-link");
      albumClip.title = "앨범 보기";
      // 행 자체의 클릭은 재생이라, 앨범명 클릭이 행까지 버블링돼 곧바로
      // 재생까지 겹쳐 실행되지 않도록 막는다.
      albumClip.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenAlbum(track);
      });
    }
    label.appendChild(albumClip);
    label.appendChild(buildArtistCell("playlist-row-artist", track.artist, onOpenArtist));
    li.appendChild(label);

    const lyricsFlag = iconSpan("mic", "icon-sm accent");
    if (!track.has_lyrics) lyricsFlag.style.visibility = "hidden";
    li.appendChild(lyricsFlag);

    const duration = document.createElement("span");
    duration.className = "playlist-row-duration";
    duration.textContent = fmtDuration(track.duration_ms);
    li.appendChild(duration);

    const lastPlayed = document.createElement("span");
    lastPlayed.className = "playlist-row-lastplayed";
    lastPlayed.textContent = fmtRelativeTime(track.last_played_at);
    lastPlayed.title = track.last_played_at || "";
    li.appendChild(lastPlayed);

    const playCount = document.createElement("span");
    playCount.className = "playlist-row-playcount";
    playCount.textContent = `${track.play_count || 0}회 · ${Math.round((track.listened_ms || 0) / 60000)}분`;
    li.appendChild(playCount);

    li.appendChild(createRatingBadge(track.rating));

    li.addEventListener("click", () => playTrack(track));
    return li;
  }

  function renderTrackPage() {
    trackListEl.innerHTML = "";
    if (!trackItems.length) {
      const empty = document.createElement("div");
      empty.className = "stats-empty";
      empty.textContent = "이 기간에 재생 기록이 없습니다.";
      trackListEl.appendChild(empty);
      trackPagination.hidden = true;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(trackItems.length / trackPageSize));
    trackPage = Math.min(trackPage, totalPages - 1);
    lastTrackPageTotalPages = totalPages;
    const pageStart = trackPage * trackPageSize;
    const fragment = document.createDocumentFragment();
    trackItems.slice(pageStart, pageStart + trackPageSize).forEach((track) => fragment.appendChild(buildTrackRow(track)));
    trackListEl.appendChild(fragment);

    trackPagination.hidden = totalPages <= 1;
    trackPrevPageBtn.disabled = trackPage <= 0;
    trackNextPageBtn.disabled = trackPage >= totalPages - 1;
    if (!trackPageLabelEditing) {
      trackPageLabel.textContent = `${trackPage + 1} / ${totalPages} (${trackItems.length}곡)`;
    }

    requestAnimationFrame(() => {
      applyColumnPriority(trackListEl);
      applyMarquee(trackListEl);
      recalcTrackPageSize();
    });
  }

  // 브라우즈 곡 목록과 동일하게, 스크롤 없이 목록 영역에 딱 들어가는 행 개수로
  // 페이지 크기를 실측해서 맞춘다.
  function recalcTrackPageSize() {
    const sampleRow = trackListEl.querySelector(".playlist-row");
    if (!sampleRow) return;
    const rowHeight = sampleRow.getBoundingClientRect().height;
    const containerHeight = trackListEl.clientHeight;
    if (!rowHeight || !containerHeight) return;
    const fitCount = Math.max(1, Math.floor(containerHeight / rowHeight));
    if (fitCount !== trackPageSize) {
      trackPageSize = fitCount;
      renderTrackPage();
    }
  }

  function goToTrackPage(nextPage) {
    trackPage = nextPage;
    renderTrackPage();
  }
  trackPrevPageBtn.addEventListener("click", () => {
    if (trackPage > 0) goToTrackPage(trackPage - 1);
  });
  trackNextPageBtn.addEventListener("click", () => goToTrackPage(trackPage + 1));

  // 페이지 라벨을 클릭하면 숫자 입력창으로 바뀌어 원하는 페이지로 바로 이동할 수 있다.
  function startEditingTrackPage() {
    if (trackPageLabelEditing || lastTrackPageTotalPages <= 1) return;
    trackPageLabelEditing = true;
    let cancelled = false;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pagination-page-input";
    input.min = "1";
    input.max = String(lastTrackPageTotalPages);
    input.value = String(trackPage + 1);
    trackPageLabel.textContent = "";
    trackPageLabel.appendChild(input);
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
      trackPageLabelEditing = false;
      if (cancelled) {
        renderTrackPage();
        return;
      }
      const target = Math.min(lastTrackPageTotalPages, Math.max(1, Math.round(Number(input.value)) || 1)) - 1;
      if (target !== trackPage) goToTrackPage(target);
      else renderTrackPage();
    });
    input.focus();
    input.select();
  }
  trackPageLabel.title = "클릭해서 페이지 번호 입력";
  trackPageLabel.addEventListener("click", startEditingTrackPage);

  function buildCard(item, i, group) {
    const card = document.createElement("div");
    card.className = "media-card";
    if (group === "artist") {
      card.classList.add("media-card-clickable");
      card.title = "이 아티스트가 참여한 곡 보기";
      card.addEventListener("click", () => openArtistDetail(item.artist));
    }

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    if (group === "artist") {
      fillArtistArt(artWrap, artistAlbumsMap.get(item.artist) || []);
    } else if (group === "album" && item.album_id) {
      const stopSpin = showArtSpinner(artWrap);
      const img = document.createElement("img");
      img.className = "media-card-art";
      img.alt = "";
      img.loading = "lazy";
      img.src = api.albumArtUrl(item.album_id);
      img.onload = () => stopSpin();
      img.onerror = () => {
        stopSpin();
        img.remove();
        artWrap.appendChild(iconSpan("music", "icon-lg"));
      };
      artWrap.appendChild(img);
    } else {
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    }
    const rank = document.createElement("span");
    rank.className = "media-card-rank";
    rank.textContent = String(i + 1);
    artWrap.appendChild(rank);
    card.appendChild(artWrap);

    const titleText = group === "track" ? item.title || item.track_id : group === "album" ? item.album : item.artist;
    const title = createMarqueeClip("media-card-title", "", titleText);
    card.appendChild(title);

    // 앨범 탭은 그 재생이 어떤 곡 아티스트였는지가 아니라, 앨범 자체의 대표
    // 아티스트(앨범 아티스트)를 보여준다 — 브라우즈의 앨범 탭과 동일한 기준.
    const displayArtist = group === "album" ? albumMetaById.get(item.album_id)?.artist || item.artist : item.artist;
    if (group !== "artist" && displayArtist) {
      const artist = document.createElement("div");
      artist.className = "media-card-artist";
      artist.textContent = displayArtist;
      card.appendChild(artist);
    }

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    meta.textContent = `${item.count}회 · ${Math.round(item.listened_ms / 60000)}분`;
    card.appendChild(meta);

    return card;
  }

  function renderList(items, group) {
    listEl.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "stats-empty";
      empty.textContent = "이 기간에 재생 기록이 없습니다.";
      listEl.appendChild(empty);
      return;
    }
    items.forEach((item, i) => listEl.appendChild(buildCard(item, i, group)));
    requestAnimationFrame(() => applyMarquee(listEl));
  }

  // '아티스트' 탭(앨범 아티스트) 카드 — 브라우즈 아티스트 탭과 똑같은 디자인
  // (콜라주 아트 + 앨범 개수)이며, 클릭하면 곡 아티스트 상세와 동일하게 이
  // 화면 안에서 서클 상세(그 서클의 앨범 목록)를 연다.
  function buildAlbumArtistCard(entry) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    card.title = "이 서클의 앨범 보기";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    fillArtistArt(artWrap, entry.albums);
    card.appendChild(artWrap);

    const titleRow = document.createElement("div");
    titleRow.className = "media-card-title-row";
    titleRow.appendChild(createMarqueeClip("media-card-title", "", entry.name || "(서클 없음)"));
    card.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    meta.textContent = `앨범 ${entry.albums.length}개 · ${entry.count}회 · ${Math.round(entry.listened_ms / 60000)}분`;
    card.appendChild(meta);

    card.addEventListener("click", () => openCircleDetail(entry.name));
    return card;
  }

  async function renderAlbumArtists() {
    // 이 기간에 재생된 앨범만 모은다(순위는 안 매기지만 목록 자체는 기간 필터를
    // 따라야 하므로 group="album" 집계를 limit=0(무제한)으로 재사용한다).
    // 앨범/서클 목록은 store(store.js)의 공유 캐시를 쓴다 — 기간별 재생 집계
    // (api.getTopStats)만 이 화면 고유의 요청이라 따로 부른다.
    await store.ensureLoaded();
    const periodAlbums = await api.getTopStats(period, "album", offset, 0);
    periodLabel.textContent = formatRange(periodAlbums.range_start, periodAlbums.range_end, period);
    nextBtn.disabled = offset <= 0;

    // 서클 이명 레지스트리로 대표 이름으로 묶는다(브라우즈 아티스트 탭과 동일) —
    // 그래야 표기가 다른 같은 서클이 여기서도 갈라지지 않는다.
    const resolveCircleName = buildArtistNameResolver(store.getCircles());
    const albumMeta = new Map(store.getAlbums().map((a) => [a.id, a]));
    const byArtist = new Map();
    for (const item of periodAlbums.items) {
      const album = item.album_id ? albumMeta.get(item.album_id) : null;
      // 곡 아티스트(item.artist)가 아니라 앨범의 대표 아티스트(album.artist)로
      // 묶는다 — 여러 곡 아티스트가 섞인 컴필레이션 앨범도 앨범 아티스트 기준
      // 하나로만 잡혀야 브라우즈의 앨범 아티스트 탭과 일관된다.
      const name = resolveCircleName((album ? album.artist : item.artist) || "");
      if (!byArtist.has(name)) byArtist.set(name, { albums: [], count: 0, listened_ms: 0 });
      const entry = byArtist.get(name);
      if (album) entry.albums.push(album);
      entry.count += item.count || 0;
      entry.listened_ms += item.listened_ms || 0;
    }
    let entries = [...byArtist.entries()].map(([name, v]) => ({
      name,
      albums: v.albums,
      count: v.count,
      listened_ms: v.listened_ms,
    }));
    entries.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));

    listEl.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "stats-empty";
      empty.textContent = "이 기간에 재생 기록이 없습니다.";
      listEl.appendChild(empty);
      return;
    }
    entries.forEach((entry) => listEl.appendChild(buildAlbumArtistCard(entry)));
    requestAnimationFrame(() => applyMarquee(listEl));
  }

  function buildArtistDetailRow(track) {
    const li = document.createElement("li");
    li.className = "playlist-row";
    li.dataset.trackId = track.track_id;
    const isPlaying = player.currentTrack && player.currentTrack.track_id === track.track_id;
    if (isPlaying) li.classList.add("playing");

    const label = document.createElement("span");
    label.className = "playlist-row-label";
    label.appendChild(
      createMarqueeClip(
        "playlist-row-title-clip",
        "playlist-row-title",
        (isPlaying ? "▶ " : "") + (track.title || track.track_id)
      )
    );
    const albumClip = createMarqueeClip("playlist-row-album", "", track.album || "");
    if (track.album && onOpenAlbum) {
      albumClip.classList.add("playlist-row-album-link");
      albumClip.title = "앨범 보기";
      // 행 자체의 클릭은 재생이라, 앨범명 클릭이 행까지 버블링돼 곧바로
      // 재생까지 겹쳐 실행되지 않도록 막는다.
      albumClip.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenAlbum(track);
      });
    }
    label.appendChild(albumClip);
    label.appendChild(buildArtistCell("playlist-row-artist", track.artist, onOpenArtist));
    li.appendChild(label);

    const lyricsFlag = iconSpan("mic", "icon-sm accent");
    if (!track.has_lyrics) lyricsFlag.style.visibility = "hidden";
    li.appendChild(lyricsFlag);

    const duration = document.createElement("span");
    duration.className = "playlist-row-duration";
    duration.textContent = fmtDuration(track.duration_ms);
    li.appendChild(duration);

    li.appendChild(createRatingBadge(track.rating));

    li.addEventListener("click", () => {
      const index = artistDetailTracks.findIndex((t) => t.track_id === track.track_id);
      if (index < 0) return;
      player.setPlaylist({ name: artistDetailArtist || "아티스트", tracks: artistDetailTracks });
      player.playIndex(index);
    });
    return li;
  }

  // identity(대표 이름 + 이명)에 속한 모든 이름과 매칭되는 곡을 앨범별로 묶어
  // 곡 목록 영역을 다시 그린다. 이명 추가/삭제나 대표 이름 변경 후에도 이걸로
  // 목록만 새로 매칭해서 다시 그린다(패널을 새로 열 필요 없음).
  function renderArtistDetailFromLibrary(tracks, identity) {
    const matchNames = new Set([identity.name, ...identity.aliases]);
    const matched = tracks.filter((t) => splitArtists(t.artist).some((n) => matchNames.has(n)));

    const byAlbum = new Map();
    for (const track of matched) {
      const key = track.album_id || "";
      if (!byAlbum.has(key)) byAlbum.set(key, { album: track.album || "(앨범 없음)", tracks: [] });
      byAlbum.get(key).tracks.push(track);
    }
    const sections = [...byAlbum.values()].sort((a, b) => (a.album || "").localeCompare(b.album || "", "ko"));

    artistDetailArtist = identity.name;
    artistDetailTracks = sections.flatMap((s) => s.tracks);

    artistDetailTitleEl.textContent = identity.name || "(아티스트 없음)";
    artistDetailAliasesEl.textContent = identity.aliases.length ? `이명: ${identity.aliases.join(", ")}` : "";
    artistDetailEditBtn.hidden = !identity.id;
    artistDetailListEl.innerHTML = "";
    if (!sections.length) {
      const empty = document.createElement("div");
      empty.className = "stats-empty";
      empty.textContent = "참여한 곡을 찾을 수 없습니다.";
      artistDetailListEl.appendChild(empty);
    } else {
      sections.forEach((section) => {
        const sectionEl = document.createElement("div");
        sectionEl.className = "album-section";
        const header = document.createElement("div");
        header.className = "album-section-header";
        header.textContent = section.album;
        sectionEl.appendChild(header);
        const list = document.createElement("ul");
        list.className = "playlist-list";
        section.tracks.forEach((t) => list.appendChild(buildArtistDetailRow(t)));
        sectionEl.appendChild(list);
        artistDetailListEl.appendChild(sectionEl);
      });
    }
  }

  // 곡 아티스트 카드를 클릭하면, 그 아티스트가 참여한(쉼표로 나열된 공동 작업곡
  // 포함) 모든 곡을 앨범별로 묶어 곡 목록으로 보여준다. 이명이 등록돼 있으면
  // 그 이름들로 활동한 곡도 같이 묶인다.
  async function openArtistDetail(artistName) {
    // "(아티스트 없음)" 자리표시자는 실제 아티스트가 아니라 이명 레지스트리에
    // 저장할 대상이 아니므로, 이때만 아이디 없는 임시 정체성을 만들어 쓴다.
    const isPlaceholder = !artistName || artistName === "(아티스트 없음)";
    const [identity] = await Promise.all([
      isPlaceholder ? Promise.resolve({ id: null, name: artistName || "", aliases: [] }) : api.resolveArtist(artistName),
      store.ensureLoaded(),
    ]);
    artistDetailIdentity = identity;
    renderArtistDetailFromLibrary(store.getTracks(), identity);

    listEl.style.display = "none";
    artistDetailPanel.hidden = false;
    requestAnimationFrame(() => applyMarquee(artistDetailListEl));
  }

  // 이명 편집 다이얼로그를 닫은 뒤(이름/이명이 바뀌었을 수 있음) 곡 목록을
  // 최신 정체성 기준으로 다시 매칭해서 보여준다.
  async function refreshArtistDetailAfterEdit() {
    if (!artistDetailIdentity || artistDetailPanel.hidden) return;
    await store.ensureLoaded();
    renderArtistDetailFromLibrary(store.getTracks(), artistDetailIdentity);
    requestAnimationFrame(() => applyMarquee(artistDetailListEl));
  }

  function closeArtistDetail() {
    if (artistDetailPanel.hidden) return;
    artistDetailPanel.hidden = true;
    artistDetailArtist = null;
    artistDetailTracks = [];
    artistDetailIdentity = null;
    if (group !== "track") listEl.style.display = "";
    if (artistIdentityDirty) {
      artistIdentityDirty = false;
      refresh();
    }
  }

  artistDetailEditBtn.addEventListener("click", () => {
    if (!artistDetailIdentity || !artistDetailIdentity.id) return;
    identityDialogApi.open(artistDetailIdentity, {
      getTracks: () => store.getTracks(),
      onChange: (updated) => {
        artistDetailIdentity = updated;
        artistIdentityDirty = true;
      },
      onClose: refreshArtistDetailAfterEdit,
    });
  });

  artistDetailBackBtn.addEventListener("click", closeArtistDetail);

  // 서클(앨범 아티스트) 정체성 편집은 곡 아티스트와 같은 다이얼로그를 재사용하되,
  // API만 circles.js 쪽으로 갈아 끼운다(브라우즈의 서클 편집과 동일한 패턴).
  const CIRCLE_ENDPOINTS = {
    rename: (id, name) => api.renameCircle(id, name),
    addAlias: (id, alias) => api.addCircleAlias(id, alias),
    removeAlias: (id, alias) => api.removeCircleAlias(id, alias),
  };

  function buildCircleDetailAlbumCard(album, trackCount) {
    const card = document.createElement("div");
    card.className = "media-card media-card-clickable";
    card.title = "앨범 보기";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    const stopSpin = showArtSpinner(artWrap);
    const img = document.createElement("img");
    img.className = "media-card-art";
    img.alt = "";
    img.loading = "lazy";
    img.src = api.albumArtUrl(album.id);
    img.onload = () => stopSpin();
    img.onerror = () => {
      stopSpin();
      img.remove();
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    };
    artWrap.appendChild(img);
    card.appendChild(artWrap);

    card.appendChild(createMarqueeClip("media-card-title", "", album.name || "(앨범 없음)"));

    const meta = document.createElement("div");
    meta.className = "media-card-meta";
    meta.textContent = `${trackCount}곡`;
    card.appendChild(meta);

    // 앨범 id 없이 앨범명+아티스트명만으로도 브라우즈의 앨범 상세를 찾을 수
    // 있다(TOP 3 앨범 카드와 동일한 방식) — track_id는 그냥 없다고 넘긴다.
    card.addEventListener("click", () => onOpenAlbum({ album: album.name, artist: album.artist, track_id: null }));
    return card;
  }

  // identity(대표 이름 + 이명)에 속한 모든 서클 표기와 일치하는 앨범을 모아
  // 상세 화면을 그린다 — 곡 아티스트 상세와 동일하게 기간과 무관하게 카탈로그
  // 전체에서 뽑는다(재생 순위가 아니라 그 서클의 전체 앨범을 훑어보는 화면).
  function renderCircleDetailFromLibrary(albums, tracks, identity) {
    const matchNames = new Set([identity.name, ...identity.aliases]);
    const matched = albums.filter((a) => matchNames.has(a.artist || ""));
    matched.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));

    const trackCountByAlbumId = new Map();
    for (const t of tracks) {
      if (!t.album_id) continue;
      trackCountByAlbumId.set(t.album_id, (trackCountByAlbumId.get(t.album_id) || 0) + 1);
    }

    circleDetailTitleEl.textContent = identity.name || "(서클 없음)";
    circleDetailAliasesEl.textContent = identity.aliases.length ? `이명: ${identity.aliases.join(", ")}` : "";
    circleDetailEditBtn.hidden = !identity.id;
    circleDetailListEl.innerHTML = "";
    if (!matched.length) {
      const empty = document.createElement("div");
      empty.className = "stats-empty";
      empty.textContent = "앨범을 찾을 수 없습니다.";
      circleDetailListEl.appendChild(empty);
    } else {
      matched.forEach((album) =>
        circleDetailListEl.appendChild(buildCircleDetailAlbumCard(album, trackCountByAlbumId.get(album.id) || 0))
      );
    }
  }

  // 서클 카드를 클릭하면, 그 서클의 모든 앨범(등록된 이명 포함)을 상세 화면으로
  // 보여준다. 곡 아티스트 상세(openArtistDetail)와 동일한 구조.
  async function openCircleDetail(circleName) {
    const isPlaceholder = !circleName || circleName === "(서클 없음)";
    const [identity] = await Promise.all([
      isPlaceholder ? Promise.resolve({ id: null, name: circleName || "", aliases: [] }) : api.resolveCircle(circleName),
      store.ensureLoaded(),
    ]);
    circleDetailIdentity = identity;
    renderCircleDetailFromLibrary(store.getAlbums(), store.getTracks(), identity);

    listEl.style.display = "none";
    circleDetailPanel.hidden = false;
    requestAnimationFrame(() => applyMarquee(circleDetailListEl));
  }

  // 이명 편집 다이얼로그를 닫은 뒤(이름/이명이 바뀌었을 수 있음) 앨범 목록을
  // 최신 정체성 기준으로 다시 매칭해서 보여준다.
  async function refreshCircleDetailAfterEdit() {
    if (!circleDetailIdentity || circleDetailPanel.hidden) return;
    await store.ensureLoaded();
    renderCircleDetailFromLibrary(store.getAlbums(), store.getTracks(), circleDetailIdentity);
    requestAnimationFrame(() => applyMarquee(circleDetailListEl));
  }

  function closeCircleDetail() {
    if (circleDetailPanel.hidden) return;
    circleDetailPanel.hidden = true;
    circleDetailIdentity = null;
    if (group !== "track") listEl.style.display = "";
    if (circleIdentityDirty) {
      circleIdentityDirty = false;
      refresh();
    }
  }

  circleDetailEditBtn.addEventListener("click", () => {
    if (!circleDetailIdentity || !circleDetailIdentity.id) return;
    identityDialogApi.open(circleDetailIdentity, {
      title: "서클 정보 수정",
      endpoints: CIRCLE_ENDPOINTS,
      getTracks: () => store.getAlbums().filter((a) => a.artist).map((a) => ({ artist: a.artist })),
      onChange: (updated) => {
        circleDetailIdentity = updated;
        circleIdentityDirty = true;
      },
      onClose: refreshCircleDetailAfterEdit,
    });
  });

  circleDetailBackBtn.addEventListener("click", closeCircleDetail);

  // 지금 보고 있는 기간/분류를 주소창에 반영한다(브라우즈 탭처럼 다른 화면
  // 진입/상태 변경이 매번 새 히스토리 항목을 쌓지 않도록 setUrl만 사용).
  function syncUrl() {
    if (refs && refs.router) refs.router.setUrl(`/stats/${period}/${group}`);
  }

  function switchTabs(tabsEl, dataKey, onSelect) {
    tabsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      [...tabsEl.children].forEach((b) => b.classList.toggle("active", b === btn));
      onSelect(btn.dataset[dataKey]);
      offset = 0;
      syncUrl();
      refresh();
    });
  }
  switchTabs(periodTabs, "period", (v) => (period = v));
  switchTabs(groupTabs, "group", (v) => (group = v));

  prevBtn.addEventListener("click", () => {
    offset += 1;
    refresh();
  });
  nextBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - 1);
    refresh();
  });

  // 재생 곡이 바뀌거나 재생바에서 레이팅을 바꾸면 지금 보이는 최근 재생 목록에도
  // 바로 반영한다(강조 표시/▶ 접두사, 레이팅 배지).
  // 목록 전체를 다시 그리는 대신(마퀴 리셋의 원인이었다) 지금 페이지에 보이는
  // 행 중 바뀐 것만 patch한다 — 바뀐 곡이 현재 페이지에 없으면 자연히 아무 일도
  // 일어나지 않는다.
  player.addEventListener("trackchange", () => {
    if (panelEl.classList.contains("active") && group === "track") {
      patchPlayingRow(trackListEl, player.currentTrack ? player.currentTrack.track_id : null);
    }
  });
  player.addEventListener("ratingchange", (e) => {
    const match = trackItems.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    if (panelEl.classList.contains("active") && group === "track") {
      patchRatingBadge(trackListEl, e.detail.trackId, e.detail.rating);
    }
  });

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      if (!artistDetailPanel.hidden) {
        applyColumnPriority(artistDetailListEl);
        applyMarquee(artistDetailListEl);
      } else if (!circleDetailPanel.hidden) {
        applyMarquee(circleDetailListEl);
      } else if (group === "track") {
        applyColumnPriority(trackListEl);
        applyMarquee(trackListEl);
        recalcTrackPageSize();
      } else {
        applyMarquee(listEl);
      }
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  return {
    show(route) {
      panelEl.classList.add("active");
      if (route && VALID_PERIODS.includes(route.period)) period = route.period;
      if (route && VALID_GROUPS.includes(route.group)) group = route.group;
      [...periodTabs.children].forEach((b) => b.classList.toggle("active", b.dataset.period === period));
      [...groupTabs.children].forEach((b) => b.classList.toggle("active", b.dataset.group === group));
      offset = 0;
      syncUrl();
      refresh();
    },
    hide() {
      panelEl.classList.remove("active");
    },
  };
}
