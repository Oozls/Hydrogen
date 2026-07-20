import { api } from "./api.js";
import { iconSpan } from "./icons.js";

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

export function setupStats() {
  const overlay = document.getElementById("stats-overlay");
  const openBtn = document.getElementById("btn-stats");
  const closeBtn = document.getElementById("btn-stats-close");
  const periodTabs = document.getElementById("stats-period-tabs");
  const groupTabs = document.getElementById("stats-group-tabs");
  const prevBtn = document.getElementById("btn-stats-prev");
  const nextBtn = document.getElementById("btn-stats-next");
  const periodLabel = document.getElementById("stats-period-label");
  const listEl = document.getElementById("stats-list");

  let period = "day";
  let group = "track";
  let offset = 0;

  async function refresh() {
    const data = await api.getTopStats(period, group, offset);
    periodLabel.textContent = formatRange(data.range_start, data.range_end, period);
    nextBtn.disabled = offset <= 0;
    renderList(data.items, group);
  }

  function buildCard(item, i, group) {
    const card = document.createElement("div");
    card.className = "media-card";

    const artWrap = document.createElement("div");
    artWrap.className = "media-card-art-wrap";
    if (group !== "artist" && item.track_id) {
      const img = document.createElement("img");
      img.className = "media-card-art";
      img.alt = "";
      img.src = api.artUrl(item.track_id);
      img.onerror = () => {
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

    const title = document.createElement("div");
    title.className = "media-card-title";
    title.textContent = group === "track" ? item.title || item.track_id : group === "album" ? item.album : item.artist;
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
  openBtn.addEventListener("click", () => {
    overlay.hidden = false;
    offset = 0;
    refresh();
  });
  closeBtn.addEventListener("click", () => {
    overlay.hidden = true;
  });
}
