import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { showArtSpinner } from "./artspinner.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";

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

export function setupStats(player, onOpenAlbum) {
  const panelEl = document.getElementById("stats-panel");
  const periodTabs = document.getElementById("stats-period-tabs");
  const groupTabs = document.getElementById("stats-group-tabs");
  const prevBtn = document.getElementById("btn-stats-prev");
  const nextBtn = document.getElementById("btn-stats-next");
  const periodLabel = document.getElementById("stats-period-label");
  const listEl = document.getElementById("stats-list");
  const trackBodyEl = document.getElementById("stats-track-body");
  const trackListEl = document.getElementById("stats-track-list");
  const top3El = document.getElementById("stats-track-top3");
  const trackPagination = document.getElementById("stats-track-pagination");
  const trackPrevPageBtn = document.getElementById("stats-track-prev-page");
  const trackNextPageBtn = document.getElementById("stats-track-next-page");
  const trackPageLabel = document.getElementById("stats-track-page-label");

  let period = "day";
  let group = "track";
  let offset = 0;
  // "곡" 그룹은 앨범 커버 카드 대신 일반 곡 목록처럼(최근 재생 순) 보여준다.
  let trackItems = [];
  let trackPage = 0;
  let trackPageSize = TRACK_PAGE_SIZE_FALLBACK;
  let lastTrackPageTotalPages = 1;
  let trackPageLabelEditing = false;
  // 가사 패널이 열려 있으면 통계 화면의 TOP 3 앨범 패널은 숨긴다(공간 확보).
  let lyricsActive = false;
  let lastAlbumItems = [];

  async function refresh() {
    if (group === "track") {
      // 곡 목록과 오른쪽 TOP 3 앨범은 같은 기간을 대상으로 하는 별개의 집계라
      // 병렬로 받아온다(둘 다 이미 있는 /api/stats/top 엔드포인트 재사용).
      const [trackData, albumData] = await Promise.all([
        api.getTopStats(period, "track", offset),
        api.getTopStats(period, "album", offset),
      ]);
      periodLabel.textContent = formatRange(trackData.range_start, trackData.range_end, period);
      nextBtn.disabled = offset <= 0;
      listEl.style.display = "none";
      trackBodyEl.hidden = false;
      trackItems = await enrichTracks(trackData.items);
      trackPage = 0;
      renderTrackPage();
      lastAlbumItems = albumData.items.slice(0, 3);
      renderTop3Albums(lastAlbumItems);
    } else {
      const data = await api.getTopStats(period, group, offset);
      periodLabel.textContent = formatRange(data.range_start, data.range_end, period);
      nextBtn.disabled = offset <= 0;
      trackBodyEl.hidden = true;
      trackPagination.hidden = true;
      listEl.style.display = "";
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
    if (item.track_id) {
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
    if (lyricsActive || !items.length) {
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
      libraryTracks = (await api.getLibrary()).tracks;
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
    label.appendChild(createMarqueeClip("playlist-row-artist", "", track.artist || ""));
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

  // 브라우즈/재생목록의 applyColumnPriority(제목 옆 앨범/아티스트 자연 폭 기준)와
  // 달리, 여기서는 재생 횟수/마지막 재생 등 고정 컬럼이 더 많아 곡 목록 너비 대비
  // 제목 영역이 유독 좁아지기 쉽다. 그래서 기준을 단순화해서, 앨범/아티스트를
  // 보여줬을 때 제목 영역이 곡 목록 전체 너비의 절반보다 좁아지면 숨긴다.
  function applyTrackColumnPriority() {
    const listWidth = trackListEl.clientWidth;
    if (!listWidth) return;
    trackListEl.querySelectorAll(".playlist-row").forEach((row) => {
      const titleClip = row.querySelector(".playlist-row-title-clip");
      const album = row.querySelector(".playlist-row-album");
      const artist = row.querySelector(".playlist-row-artist");
      if (!titleClip || (!album && !artist)) return;

      // 실제 제목 폭을 다시 재려면 우선 숨김을 풀어야 한다.
      if (album) album.hidden = false;
      if (artist) artist.hidden = false;

      const shouldHide = titleClip.clientWidth < listWidth / 2;
      if (album) album.hidden = shouldHide;
      if (artist) artist.hidden = shouldHide;
    });
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
      applyTrackColumnPriority();
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

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    if (group !== "artist" && item.track_id) {
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

    if (group !== "artist" && item.artist) {
      const artist = document.createElement("div");
      artist.className = "media-card-artist";
      artist.textContent = item.artist;
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

  function switchTabs(tabsEl, dataKey, onSelect) {
    tabsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      [...tabsEl.children].forEach((b) => b.classList.toggle("active", b === btn));
      onSelect(btn.dataset[dataKey]);
      offset = 0;
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
  player.addEventListener("trackchange", () => {
    if (panelEl.classList.contains("active") && group === "track") renderTrackPage();
  });
  player.addEventListener("ratingchange", (e) => {
    const match = trackItems.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    if (panelEl.classList.contains("active") && group === "track") renderTrackPage();
  });

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      if (group === "track") {
        applyTrackColumnPriority();
        applyMarquee(trackListEl);
        recalcTrackPageSize();
      } else {
        applyMarquee(listEl);
      }
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

  return {
    show() {
      panelEl.classList.add("active");
      offset = 0;
      refresh();
    },
    hide() {
      panelEl.classList.remove("active");
    },
    setLyricsActive(active) {
      lyricsActive = active;
      if (group === "track") renderTop3Albums(lastAlbumItems);
    },
  };
}
