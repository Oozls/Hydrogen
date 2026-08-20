import { api } from "./api.js";
import { store } from "./store.js";
import { iconSpan } from "./icons.js";
import { buildArtEl } from "./artspinner.js";
import { startRecommendQueue } from "./queue.js";
import { attachScrollAutoHide } from "./scrollAutoHide.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";
import { buildArtistCell } from "./songArtist.js";

const RECENT_LIMIT = 12;
const QUICKPICK_LIMIT = 18;

export function setupHome(player, onOpenAlbum, onOpenArtist, onOpenAutoPlaylist) {
  const panelEl = document.getElementById("home-panel");
  const recentRowEl = document.getElementById("home-recent-row");
  const quickpicksGridEl = document.getElementById("home-quickpicks-grid");
  const autoPlaylistsSectionEl = document.getElementById("home-auto-playlists-section");
  const autoPlaylistsRowEl = document.getElementById("home-auto-playlists-row");

  let recentItems = [];
  let quickpickItems = [];
  let autoPlaylistItems = [];

  function buildRecentCard(item) {
    const card = document.createElement("div");
    card.className = "home-recent-card";
    card.title = item.title || item.track_id;

    const artWrap = buildArtEl(item.track_id, "home-recent-card-art-wrap");
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "home-recent-card-play";
    playBtn.appendChild(iconSpan("play", "icon-lg"));
    artWrap.appendChild(playBtn);
    card.appendChild(artWrap);

    card.appendChild(createMarqueeClip("home-recent-card-title", "", item.title || item.track_id));

    // 아티스트명과 앨범명을 한 줄에 이어 붙이지 않고 각각 따로 줄을 차지하게 한다
    // (아티스트명 아래에 앨범명).
    if (item.artist) card.appendChild(buildArtistCell("home-recent-card-subtitle", item.artist, onOpenArtist));
    if (item.album) {
      const albumClip = createMarqueeClip("home-recent-card-album", "", item.album);
      if (onOpenAlbum) {
        albumClip.classList.add("playlist-row-album-link");
        albumClip.title = "앨범 보기";
        albumClip.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenAlbum(item);
        });
      }
      card.appendChild(albumClip);
    }

    // /api/stats/recent가 주는 항목은 title/artist/album 등 표시용 필드만
    // 있고 rating/duration_ms/has_lyrics가 없다 — 이 항목을 그대로 재생하면
    // 재생바가 "이 트랙엔 값이 없다"로 읽어 레이팅 하트가 항상 비어 보인다.
    // 라이브러리에 아직 있는 곡이면 거기서 전체 필드를 가진 사본을 찾아 쓴다.
    card.addEventListener("click", () => {
      const live = store.getTracks().find((t) => t.track_id === item.track_id);
      startRecommendQueue(player, live || item);
    });
    return card;
  }

  function renderLoading(container) {
    container.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    container.appendChild(loading);
  }

  function renderRecent() {
    recentRowEl.innerHTML = "";
    if (!recentItems.length) {
      const empty = document.createElement("div");
      empty.className = "home-empty";
      empty.textContent = "아직 재생 기록이 없습니다.";
      recentRowEl.appendChild(empty);
      return;
    }
    recentItems.forEach((item) => recentRowEl.appendChild(buildRecentCard(item)));
    requestAnimationFrame(() => applyMarquee(recentRowEl));
  }

  function buildQuickpickRow(item) {
    const row = document.createElement("div");
    row.className = "home-quickpick-row";

    row.appendChild(buildArtEl(item.track_id, "home-quickpick-art-wrap"));

    const text = document.createElement("div");
    text.className = "home-quickpick-text";
    text.appendChild(createMarqueeClip("home-quickpick-title", "", item.title || item.track_id));
    // 아티스트명을 앨범명 위에, 각각 따로 줄을 차지하게 한다(다시 듣기 카드와 동일).
    if (item.artist) text.appendChild(buildArtistCell("home-quickpick-subtitle", item.artist, onOpenArtist));
    if (item.album) {
      const albumClip = createMarqueeClip("home-quickpick-album", "", item.album);
      if (onOpenAlbum) {
        albumClip.classList.add("playlist-row-album-link");
        albumClip.title = "앨범 보기";
        albumClip.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenAlbum(item);
        });
      }
      text.appendChild(albumClip);
    }
    row.appendChild(text);

    row.addEventListener("click", () => startRecommendQueue(player, item));
    return row;
  }

  function renderQuickpicks() {
    quickpicksGridEl.innerHTML = "";
    if (!quickpickItems.length) {
      const empty = document.createElement("div");
      empty.className = "home-empty";
      empty.textContent = "추천할 곡이 없습니다.";
      quickpicksGridEl.appendChild(empty);
      return;
    }
    quickpickItems.forEach((item) => quickpicksGridEl.appendChild(buildQuickpickRow(item)));
    requestAnimationFrame(() => applyMarquee(quickpicksGridEl));
  }

  // 안 들어본 곡/자주 듣는 곡/특정 아티스트·서클 위주로 서버가 즉석에서 골라주는,
  // 사이드바에는 남지 않는 테마별 플레이리스트. 곡 하나짜리 카드가 아니라 목록
  // 자체를 대표하는 카드다. 아티스트/서클 테마는 대표 곡의 앨범 아트를 보여주고
  // (item.track_id가 있을 때만 — 안 들어본 곡/자주 듣는 곡은 대표 곡이 하나로
  // 고정되지 않으므로 고정 아이콘을 그대로 쓴다), 다시 듣기 카드처럼 가로로
  // 나열한다(개수가 곡 카드보다 적어 세로 그리드로 채우면 휑해 보인다).
  function buildAutoPlaylistCard(item) {
    const card = document.createElement("div");
    card.className = "home-recent-card home-auto-playlist-card";
    card.title = item.title;

    if (item.track_id) {
      card.appendChild(buildArtEl(item.track_id, "home-recent-card-art-wrap"));
    } else {
      const iconWrap = document.createElement("div");
      iconWrap.className = "home-recent-card-art-wrap";
      iconWrap.appendChild(iconSpan("list", "icon-lg"));
      card.appendChild(iconWrap);
    }

    card.appendChild(createMarqueeClip("home-recent-card-title", "", item.title));

    card.addEventListener("click", () => onOpenAutoPlaylist(item.id));
    return card;
  }

  function renderAutoPlaylists() {
    autoPlaylistsRowEl.innerHTML = "";
    autoPlaylistsSectionEl.hidden = !autoPlaylistItems.length;
    if (!autoPlaylistItems.length) return;
    autoPlaylistItems.forEach((item) => autoPlaylistsRowEl.appendChild(buildAutoPlaylistCard(item)));
    requestAnimationFrame(() => applyMarquee(autoPlaylistsRowEl));
  }

  attachScrollAutoHide(recentRowEl);
  attachScrollAutoHide(autoPlaylistsRowEl);
  attachScrollAutoHide(panelEl);

  // 패널 폭이 바뀌면(사이드바 토글, 창 크기 조절 등) 마퀴가 필요한지 다시 재야 한다.
  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      applyMarquee(recentRowEl);
      applyMarquee(quickpicksGridEl);
      applyMarquee(autoPlaylistsRowEl);
    }, 150);
  });

  async function load() {
    // reroll에 매번 새 무작위 토큰을 넘겨서, "오늘의 곡"처럼 하루 종일 고정되지
    // 않고 홈 화면을 새로 볼 때마다(새로고침 포함) 빠른 선곡 구성이 바뀌게 한다.
    const reroll = Math.random().toString(36).slice(2);
    const [recentResult, quickpicksResult, autoPlaylistsResult] = await Promise.all([
      api.getRecentPlays(RECENT_LIMIT).catch(() => ({ items: [] })),
      api.getTodaySongs(QUICKPICK_LIMIT, reroll, false).catch(() => ({ items: [] })),
      api.getAutoPlaylists().catch(() => ({ playlists: [] })),
      store.ensureLoaded().catch(() => null),
    ]);
    recentItems = recentResult.items;
    quickpickItems = quickpicksResult.items;
    autoPlaylistItems = autoPlaylistsResult.playlists;
    renderRecent();
    renderQuickpicks();
    renderAutoPlaylists();
  }

  return {
    show() {
      panelEl.classList.add("active");
      // 새로 불러오는 동안 이전 화면(다른 새로고침 시점)의 목록이 잠깐 그대로
      // 보이다 교체되는 대신, 곧바로 로딩 중 표시로 바꾼다.
      renderLoading(recentRowEl);
      renderLoading(quickpicksGridEl);
      load();
    },
    hide() {
      panelEl.classList.remove("active");
    },
  };
}
