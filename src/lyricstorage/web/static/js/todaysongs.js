import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { alertDialog } from "./dialog.js";
import { setupRowContextMenu } from "./rowContextMenu.js";
import { applyMarquee, applyColumnPriority, createMarqueeClip } from "./marquee.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
}

const DEFAULT_LIMIT = 8;
// 브라우즈 곡 목록/재생 통계와 동일한 페이지네이션 방식을 쓴다: 아직 한 번도
// 실측하지 못했을 때만 쓰는 임시 페이지 크기.
const PAGE_SIZE_FALLBACK = 50;
const MARQUEE_RESIZE_DEBOUNCE_MS = 150;

// recommend.py의 FEATURE_KEYS와 이름을 맞춘 색상표. 슬라이더/그래프는 실제 요소
// 목록을 서버 응답(labels)에서 매번 읽어오므로, 여기 없는 새 요소가 추가돼도
// 폴백 색상으로 자동으로 그려진다.
const WEIGHT_COLORS = {
  rating: "#7c9cff",
  artist: "#ff8a65",
  album: "#66d9a8",
  never_played: "#f2c94c",
  explicit: "#c792ea",
  freshness: "#4fc3f7",
};
const WEIGHT_COLOR_FALLBACK = "#9aa0b4";
function weightColor(key) {
  return WEIGHT_COLORS[key] || WEIGHT_COLOR_FALLBACK;
}
const WEIGHT_CHART_W = 400;
const WEIGHT_CHART_H = 120;
const WEIGHT_CHART_PAD_Y = 10;

export function setupTodaySongs(bootstrap, player, playlistApi, onEditTrack, onBulkEdit) {
  const panelEl = document.getElementById("today-panel");
  const listEl = document.getElementById("today-songs-list");
  const rerollBtn = document.getElementById("btn-today-reroll");
  const limitSelect = document.getElementById("today-limit-select");
  const paginationEl = document.getElementById("today-songs-pagination");
  const prevPageBtn = document.getElementById("today-songs-prev-page");
  const nextPageBtn = document.getElementById("today-songs-next-page");
  const pageLabel = document.getElementById("today-songs-page-label");

  const weightsToggleBtn = document.getElementById("btn-today-weights-toggle");
  const weightsDialogEl = document.getElementById("today-weights-dialog");
  const weightsCloseBtn = document.getElementById("today-weights-close");
  const weightsAutoToggle = document.getElementById("today-weights-auto-toggle");
  const weightsSlidersEl = document.getElementById("today-weights-sliders");
  const weightsSvgEl = document.getElementById("today-weights-svg");
  const weightsLegendEl = document.getElementById("today-weights-legend");

  let items = [];
  let limit = bootstrap.settings.today_limit || DEFAULT_LIMIT;
  limitSelect.value = String(limit);
  let page = 0;
  let pageSize = PAGE_SIZE_FALLBACK;
  let pageLabelEditing = false;
  let lastPageTotalCount = 0;
  let lastPageTotalPages = 1;

  const rowMenu = setupRowContextMenu({
    onEditTrack: (track) => onEditTrack(track),
    onAddToPlaylist: (track, playlistName) => addTrackToPlaylist(track, playlistName),
    onBulkEdit: (ids) => onBulkEdit(ids),
    getSelectedIds: () => new Set(),
  });

  async function addTrackToPlaylist(track, playlistName) {
    if (!playlistName) return;
    try {
      const updated = await api.addTracksFromLibrary(playlistName, [track.track_id]);
      playlistApi.applyExternalUpdate(updated);
    } catch (err) {
      await alertDialog(err.message);
    }
  }

  function playTrack(track) {
    player.setPlaylist({ name: "오늘의 곡", tracks: items });
    player.playIndex(items.indexOf(track));
  }

  function renderEmpty() {
    listEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "playlist-empty-state";
    empty.textContent = "추천할 곡이 없습니다. 라이브러리에 곡을 먼저 등록해 주세요.";
    listEl.appendChild(empty);
  }

  function renderLoading() {
    listEl.innerHTML = "";
    paginationEl.hidden = true;
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    listEl.appendChild(loading);
  }

  function buildRow(track) {
    const li = document.createElement("li");
    li.className = "playlist-row";
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

    const playCount = document.createElement("span");
    playCount.className = "playlist-row-playcount";
    playCount.textContent = track.play_count > 0 ? `${track.play_count}회` : "안 들어봄";
    li.appendChild(playCount);

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

    li.addEventListener("dblclick", () => playTrack(track));
    return li;
  }

  function render() {
    if (!items.length) {
      renderEmpty();
      paginationEl.hidden = true;
      return;
    }
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, totalPages - 1);
    const pageStart = page * pageSize;
    const pageItems = items.slice(pageStart, pageStart + pageSize);

    listEl.innerHTML = "";
    const fragment = document.createDocumentFragment();
    pageItems.forEach((track) => fragment.appendChild(buildRow(track)));
    listEl.appendChild(fragment);
    requestAnimationFrame(() => {
      applyColumnPriority(listEl);
      applyMarquee(listEl);
      recalcPageSize();
    });
    renderPagination(items.length, totalPages);
  }

  // 브라우즈 곡 목록/재생 통계와 동일하게, 목록 영역에 스크롤 없이 딱 들어가는
  // 행 개수로 페이지 크기를 실측해서 맞춘다.
  function recalcPageSize() {
    const sampleRow = listEl.querySelector(".playlist-row");
    if (!sampleRow) return;
    const rowHeight = sampleRow.getBoundingClientRect().height;
    const containerHeight = listEl.clientHeight;
    if (!rowHeight || !containerHeight) return;
    const fitCount = Math.max(1, Math.floor(containerHeight / rowHeight));
    if (fitCount !== pageSize) {
      pageSize = fitCount;
      render();
    }
  }

  function renderPagination(totalCount, totalPages) {
    lastPageTotalCount = totalCount;
    lastPageTotalPages = totalPages;
    paginationEl.hidden = totalPages <= 1;
    prevPageBtn.disabled = page <= 0;
    nextPageBtn.disabled = page >= totalPages - 1;
    if (pageLabelEditing) return; // 입력 중인 <input>을 렌더로 덮어쓰지 않는다.
    pageLabel.textContent = `${page + 1} / ${totalPages} (${totalCount}곡)`;
  }

  function goToPage(nextPage) {
    page = nextPage;
    render();
  }
  prevPageBtn.addEventListener("click", () => {
    if (page > 0) goToPage(page - 1);
  });
  nextPageBtn.addEventListener("click", () => goToPage(page + 1));

  // 페이지 라벨을 클릭하면 숫자 입력창으로 바뀌어 원하는 페이지로 바로 이동할 수 있다.
  function startEditingPage() {
    if (pageLabelEditing || lastPageTotalPages <= 1) return;
    pageLabelEditing = true;
    let cancelled = false;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pagination-page-input";
    input.min = "1";
    input.max = String(lastPageTotalPages);
    input.value = String(page + 1);
    pageLabel.textContent = "";
    pageLabel.appendChild(input);
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
      pageLabelEditing = false;
      const target = cancelled
        ? page
        : Math.min(lastPageTotalPages, Math.max(1, Math.round(Number(input.value)) || 1)) - 1;
      if (target !== page) goToPage(target);
      else renderPagination(lastPageTotalCount, lastPageTotalPages);
    });
    input.focus();
    input.select();
  }
  pageLabel.title = "클릭해서 페이지 번호 입력";
  pageLabel.addEventListener("click", startEditingPage);

  let weightsState = null;

  // 재생 화면의 seek/volume 슬라이더와 동일하게, 채워진 부분을 --range-progress
  // 퍼센트로 표현해 theme.css의 그라디언트 트랙 배경이 이를 참조하게 한다.
  function updateRangeFill(el) {
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 0;
    const value = Number(el.value) || 0;
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    el.style.setProperty("--range-progress", `${pct}%`);
  }

  // 슬라이더 행을 서버가 내려준 요소 목록(labels) 순서대로 매번 새로 그린다 —
  // recommend.py 쪽에 새 요소가 추가/제거돼도 이 파일을 손댈 필요가 없다.
  function renderWeightSliders(state) {
    const isManual = state.mode === "manual";
    weightsAutoToggle.checked = !isManual;
    weightsSlidersEl.innerHTML = "";
    Object.keys(state.labels || {}).forEach((key) => {
      const row = document.createElement("div");
      row.className = "today-weight-row";

      const label = document.createElement("span");
      label.className = "today-weight-label";
      label.textContent = state.labels[key] || key;
      label.title = state.labels[key] || key;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "today-weight-slider";
      slider.min = String(state.min);
      slider.max = String(state.max);
      slider.step = "0.01";
      slider.disabled = !isManual;
      slider.value = String(state.weights[key] ?? 0);

      const valueEl = document.createElement("span");
      valueEl.className = "today-weight-value";
      valueEl.textContent = Number(slider.value).toFixed(2);

      updateRangeFill(slider);
      slider.addEventListener("input", () => {
        updateRangeFill(slider);
        valueEl.textContent = Number(slider.value).toFixed(2);
      });
      slider.addEventListener("change", async () => {
        if (!weightsState || weightsState.mode !== "manual") return;
        try {
          await api.updateTodayWeights({ manual_weights: { [key]: Number(slider.value) } });
        } catch (err) {
          await alertDialog(err.message);
          return;
        }
        load();
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueEl);
      weightsSlidersEl.appendChild(row);
    });
  }

  function renderWeightLegend(state) {
    weightsLegendEl.innerHTML = "";
    Object.keys(state.labels || {}).forEach((key) => {
      const item = document.createElement("span");
      item.className = "today-weights-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "today-weights-legend-swatch";
      swatch.style.background = weightColor(key);
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(state.labels[key] || key));
      weightsLegendEl.appendChild(item);
    });
  }

  // 새로고침/다시 뽑기마다 서버에 쌓이는 가중치 이력을 요소별 꺾은선 그래프로
  // 그린다 — 0~1 사이 값이 아니라 WEIGHT_MIN~WEIGHT_MAX 범위라 그 범위로 스케일링.
  function renderWeightChart(state) {
    weightsSvgEl.innerHTML = "";
    const history = state.history;
    if (!history || history.length === 0) return;
    const keys = Object.keys(state.labels || {});
    const n = history.length;
    const range = state.max - state.min || 1;
    const yFor = (v) =>
      WEIGHT_CHART_H - WEIGHT_CHART_PAD_Y - ((v - state.min) / range) * (WEIGHT_CHART_H - WEIGHT_CHART_PAD_Y * 2);
    const xFor = (i) => (n <= 1 ? WEIGHT_CHART_W / 2 : (i / (n - 1)) * WEIGHT_CHART_W);

    keys.forEach((key) => {
      const points = history.map((entry, i) => `${xFor(i)},${yFor(entry.weights?.[key] ?? 0)}`).join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      poly.setAttribute("points", points);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", weightColor(key));
      poly.setAttribute("stroke-width", "2");
      poly.setAttribute("vector-effect", "non-scaling-stroke");
      weightsSvgEl.appendChild(poly);
    });
  }

  async function loadWeights() {
    try {
      weightsState = await api.getTodayWeights();
    } catch (_err) {
      return;
    }
    renderWeightSliders(weightsState);
    renderWeightLegend(weightsState);
    renderWeightChart(weightsState);
  }

  weightsToggleBtn.addEventListener("click", () => {
    weightsDialogEl.showModal();
    loadWeights();
  });
  weightsCloseBtn.addEventListener("click", () => weightsDialogEl.close());

  // 자동 학습 <-> 수동 조절 전환. 수동으로 바꾸는 순간에는 그 직전까지 자동
  // 학습되던 값을 그대로 이어받아서, 슬라이더가 갑자기 기본값으로 튀지 않게 한다.
  weightsAutoToggle.addEventListener("change", async () => {
    const goingManual = !weightsAutoToggle.checked;
    const patch = { mode: goingManual ? "manual" : "auto" };
    if (goingManual && weightsState) {
      patch.manual_weights = { ...weightsState.weights };
    }
    try {
      await api.updateTodayWeights(patch);
    } catch (err) {
      await alertDialog(err.message);
      return;
    }
    load();
  });

  async function load(reroll) {
    renderLoading();
    try {
      const result = await api.getTodaySongs(limit, reroll);
      items = result.items;
    } catch (err) {
      items = [];
      await alertDialog(err.message);
    }
    page = 0;
    render();
    // pick_today_songs가 이번 호출에서도 가중치 이력에 한 점을 남겼으니, 다이얼로그가
    // 열려 있으면 그래프/슬라이더도 같이 최신 상태로 맞춘다.
    if (weightsDialogEl.open) loadWeights();
  }

  rerollBtn.addEventListener("click", () => load(String(Date.now())));

  // 개수를 바꾸면 설정에 저장해 다음에 열 때도 유지되고, 재뽑기 없이(오늘의
  // 추첨 순서는 그대로 두고) 늘어나거나 줄어든 개수만큼만 다시 불러온다 —
  // 추첨이 순서대로 진행되는 결정적 시드라 개수를 늘려도 기존 상위 곡들의
  // 순서는 그대로 유지된다.
  limitSelect.addEventListener("change", () => {
    limit = Number(limitSelect.value) || DEFAULT_LIMIT;
    api.updateSettings({ today_limit: limit }).catch(() => {});
    load();
  });

  player.addEventListener("trackchange", () => {
    if (panelEl.classList.contains("active")) render();
  });

  player.addEventListener("ratingchange", (e) => {
    const match = items.find((t) => t.track_id === e.detail.trackId);
    if (match) match.rating = e.detail.rating;
    if (panelEl.classList.contains("active")) render();
  });

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => {
      if (!panelEl.classList.contains("active")) return;
      applyColumnPriority(listEl);
      applyMarquee(listEl);
      recalcPageSize();
    }, MARQUEE_RESIZE_DEBOUNCE_MS);
  });

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
