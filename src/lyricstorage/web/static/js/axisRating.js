import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

// 하나의 감으로 매기는 하트 위젯과 달리, 곡의 여러 측면을 각각 매긴 뒤
// 평균으로 최종 레이팅을 정하는 보조 다이얼로그. 취향 기준이 곡이 쌓일수록
// 흔들리는 걸 줄이기 위한 계산기일 뿐이라, 축 점수 자체는 저장하지 않고
// 계산된 값만 기존 rating 필드(하트 위젯과 동일한 API)에 반영한다.
// levels[n]은 그 축에서 n점이 뭘 뜻하는지 적어둔 기준 — 채점 기준 자체가
// 곡이 쌓일수록 흔들리는 걸 막기 위한 것이라, 정수 점수(0~5)만 문구를 두고
// 0.5점은 가까운 정수 문구로 갈음한다. 기준이 바뀌면 여기 텍스트만 고치면 됨.
const AXES = [
  {
    key: "melody",
    label: "멜로디/훅",
    levels: [
      "기억에 남는 부분이 전혀 없음",
      "들을 땐 괜찮은데 끝나면 바로 잊음",
      "한 소절 정도 흥얼거려짐",
      "후렴이나 특정 구간이 꽤 좋아서 다시 듣고 싶어짐",
      "곡 전체 흐름이 좋고 여러 구간이 인상적",
      "처음 듣자마자 각인, 계속 맴도는 수준",
    ],
  },
  {
    key: "lyrics",
    label: "가사",
    levels: [
      "가사에 신경 안 쓰임",
      "무난하거나 뻔함",
      "특정 구절 하나 정도 눈에 띔",
      "스토리/감정선이 잘 짜여 있어 몰입됨",
      "여러 번 곱씹게 되는 표현이 있음",
      "가사만으로도 곡을 듣는 이유가 됨",
    ],
  },
  {
    key: "vocal",
    label: "보컬·편곡",
    levels: [
      "거슬리거나 아쉬운 부분이 있음",
      "무난한 수준",
      "기술적으로 안정적",
      "표현력/사운드가 곡과 잘 어울림",
      "편곡 디테일(브릿지, 악기 배치 등)이 인상적",
      "보컬·편곡이 곡을 완전히 다른 차원으로 끌어올림",
    ],
  },
  {
    key: "replay",
    label: "재청취 의향",
    levels: [
      "다시 들을 일 없음",
      "플레이리스트에 있어도 넘기진 않는 정도",
      "가끔 생각나면 찾아 들음",
      "기분에 따라 자주 찾게 됨",
      "요즘 반복해서 듣고 있음",
      "지금 제일 듣고 싶은 곡",
    ],
  },
];

export function setupAxisRating(player) {
  const dialog = document.getElementById("axis-rating-dialog");
  const rowsEl = document.getElementById("axis-rating-rows");
  const totalEl = document.getElementById("axis-rating-total");
  const saveBtn = document.getElementById("axis-rating-save");
  const cancelBtn = document.getElementById("axis-rating-cancel");
  const openBtn = document.getElementById("btn-axis-rating");

  const values = {};

  function computeTotal() {
    const avg = AXES.reduce((sum, a) => sum + (values[a.key] || 0), 0) / AXES.length;
    return Math.round(avg * 2) / 2;
  }

  function paintTotal() {
    totalEl.textContent = computeTotal().toFixed(1);
  }

  // rating.js의 하트-행 물리(호버/클릭 위치로 0.5점 단위 판정)와 동일한
  // 동작을 축마다 독립된 값으로 반복하기 위해 행 단위로 만들어 낸다.
  function buildRow(axis) {
    const wrap = document.createElement("div");
    wrap.className = "axis-rating-block";
    const row = document.createElement("div");
    row.className = "axis-rating-row";
    const label = document.createElement("span");
    label.className = "axis-rating-label";
    label.textContent = axis.label;
    const hearts = document.createElement("div");
    hearts.className = "track-rating";
    row.append(label, hearts);

    const descList = document.createElement("ul");
    descList.className = "axis-rating-desc";
    const descItems = axis.levels.map((text, level) => {
      const li = document.createElement("li");
      li.textContent = `${level} — ${text}`;
      descList.appendChild(li);
      return li;
    });

    function paint(previewValue) {
      const active = previewValue != null ? previewValue : values[axis.key] || 0;
      [...hearts.children].forEach((btn) => {
        const value = Number(btn.dataset.value);
        const fill = btn.querySelector(".rating-heart-fill");
        const diff = Math.min(1, Math.max(0, active - (value - 1)));
        fill.classList.toggle("full", diff >= 1);
        fill.classList.toggle("half", diff > 0 && diff < 1);
        btn.classList.toggle("filled", diff > 0);
      });
      const activeLevel = Math.round(active);
      descItems.forEach((li, level) => li.classList.toggle("active", level === activeLevel));
    }

    function valueFromEvent(btn, clientX) {
      const value = Number(btn.dataset.value);
      const rect = btn.getBoundingClientRect();
      const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 1;
      return frac <= 0.5 ? value - 0.5 : value;
    }

    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rating-heart";
      btn.dataset.value = String(i);
      btn.innerHTML =
        '<span class="icon icon-sm rating-heart-base" style="--icon: url(/static/icons/heart.svg)"></span>' +
        '<span class="icon icon-sm rating-heart-fill" style="--icon: url(/static/icons/heart-filled.svg)"></span>';
      btn.addEventListener("mousemove", (e) => paint(valueFromEvent(btn, e.clientX)));
      btn.addEventListener("mouseleave", () => paint());
      btn.addEventListener("click", (e) => {
        const clicked = valueFromEvent(btn, e.clientX);
        values[axis.key] = values[axis.key] === clicked ? 0 : clicked;
        paint();
        paintTotal();
      });
      hearts.appendChild(btn);
    }
    paint();
    wrap.append(row, descList);
    return wrap;
  }

  function open() {
    if (!player.currentTrack) return;
    AXES.forEach((a) => (values[a.key] = 0));
    rowsEl.innerHTML = "";
    AXES.forEach((a) => rowsEl.appendChild(buildRow(a)));
    paintTotal();
    dialog.showModal();
  }

  function syncOpenBtn() {
    openBtn.disabled = !player.currentTrack;
  }

  openBtn.addEventListener("click", open);
  cancelBtn.addEventListener("click", () => dialog.close());

  saveBtn.addEventListener("click", async () => {
    const track = player.currentTrack;
    if (!track) return;
    const nextRating = computeTotal();
    const prevRating = track.rating || 0;
    track.rating = nextRating;
    try {
      await api.setRating(track.track_id, nextRating);
    } catch (err) {
      track.rating = prevRating;
      await alertDialog(err.message);
      return;
    }
    dialog.close();
    player.dispatchEvent(
      new CustomEvent("ratingchange", { detail: { trackId: track.track_id, rating: nextRating } })
    );
  });

  player.addEventListener("trackchange", syncOpenBtn);
  syncOpenBtn();
}
