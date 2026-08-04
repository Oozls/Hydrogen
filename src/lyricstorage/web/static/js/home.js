import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { buildArtEl } from "./artspinner.js";
import { startRecommendQueue } from "./queue.js";

const RECENT_LIMIT = 12;
const QUICKPICK_LIMIT = 9;

export function setupHome(player) {
  const panelEl = document.getElementById("home-panel");
  const recentRowEl = document.getElementById("home-recent-row");
  const recentPrevBtn = document.getElementById("btn-home-recent-prev");
  const recentNextBtn = document.getElementById("btn-home-recent-next");
  const quickpicksGridEl = document.getElementById("home-quickpicks-grid");
  const quickpicksPlayBtn = document.getElementById("btn-home-quickpicks-play");

  let recentItems = [];
  let quickpickItems = [];

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

    const title = document.createElement("div");
    title.className = "home-recent-card-title";
    title.textContent = item.title || item.track_id;
    card.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "home-recent-card-subtitle";
    subtitle.textContent = ["노래", item.artist || item.album].filter(Boolean).join(" · ");
    card.appendChild(subtitle);

    card.addEventListener("click", () => startRecommendQueue(player, item));
    return card;
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
  }

  function buildQuickpickRow(item) {
    const row = document.createElement("div");
    row.className = "home-quickpick-row";

    row.appendChild(buildArtEl(item.track_id, "home-quickpick-art-wrap"));

    const text = document.createElement("div");
    text.className = "home-quickpick-text";
    const title = document.createElement("div");
    title.className = "home-quickpick-title";
    title.textContent = item.title || item.track_id;
    const subtitle = document.createElement("div");
    subtitle.className = "home-quickpick-subtitle";
    const playCountLabel = item.play_count > 0 ? `${item.play_count}회 재생` : "안 들어봄";
    subtitle.textContent = [item.artist, playCountLabel].filter(Boolean).join(" · ");
    text.appendChild(title);
    text.appendChild(subtitle);
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
  }

  // 스크롤바는 평소엔 숨겨두고, 실제로 스크롤하는 동안만(휠/드래그/화살표 버튼)
  // 잠깐 보여준다 — 마지막 스크롤 후 일정 시간 지나면 다시 숨긴다.
  let recentScrollHideTimer = null;
  recentRowEl.addEventListener("scroll", () => {
    recentRowEl.classList.add("scrolling");
    clearTimeout(recentScrollHideTimer);
    recentScrollHideTimer = setTimeout(() => recentRowEl.classList.remove("scrolling"), 700);
  });

  recentPrevBtn.addEventListener("click", () => {
    recentRowEl.scrollBy({ left: -recentRowEl.clientWidth, behavior: "smooth" });
  });
  recentNextBtn.addEventListener("click", () => {
    recentRowEl.scrollBy({ left: recentRowEl.clientWidth, behavior: "smooth" });
  });
  quickpicksPlayBtn.addEventListener("click", () => {
    if (!quickpickItems.length) return;
    startRecommendQueue(player, quickpickItems[0]);
  });

  async function load() {
    // reroll에 매번 새 무작위 토큰을 넘겨서, "오늘의 곡"처럼 하루 종일 고정되지
    // 않고 홈 화면을 새로 볼 때마다(새로고침 포함) 빠른 선곡 구성이 바뀌게 한다.
    const reroll = Math.random().toString(36).slice(2);
    const [recentResult, quickpicksResult] = await Promise.all([
      api.getRecentPlays(RECENT_LIMIT).catch(() => ({ items: [] })),
      api.getTodaySongs(QUICKPICK_LIMIT, reroll, false).catch(() => ({ items: [] })),
    ]);
    recentItems = recentResult.items;
    quickpickItems = quickpicksResult.items;
    renderRecent();
    renderQuickpicks();
  }

  return {
    show() {
      panelEl.classList.add("active");
      load();
    },
    hide() {
      panelEl.classList.remove("active");
    },
  };
}
