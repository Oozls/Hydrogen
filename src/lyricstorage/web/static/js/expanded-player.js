import { api } from "./api.js";
import { store } from "./store.js";
import { buildArtEl } from "./artspinner.js";
import { getDisplayQueue } from "./queue.js";
import { attachScrollAutoHide } from "./scrollAutoHide.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";
import { buildArtistCell, buildArtistNameResolver } from "./songArtist.js";
import { iconSpan } from "./icons.js";

const SLOT_PCT = 25; // 한 칸 옮길 때의 translateX(%) — 커질수록 CD 사이 간격이 넓어진다
const SETTLE_MS_BASE = 320; // 한 칸짜리 이동의 기준 시간
const SETTLE_MS_PER_STEP = 70; // 여러 칸을 한 번에 넘어갈 때 칸마다 더해주는 시간
const SETTLE_MS_MAX = 720;
// abs(slot) >= 3이면 slotStyle의 opacity/scale이 이미 0/최소치라 화면엔 안
// 보인다 — 그러니 딱 그만큼(+진입 애니메이션이 자연스럽도록 여유 없이 정확히)만
// 실제 엘리먼트를 만들어 두고, 드래그로 몇 칸을 넘어가든 매 칸 경계를 지날
// 때마다 이 몇 장을 새 자리에 맞게 재활용한다(가상 스크롤과 같은 방식) — 그러면
// 드래그 거리와 무관하게 항상 딱 화면에 보일 만큼의 CD 엘리먼트만 존재한다.
const CD_RADIUS = 3;
// 클릭으로 곡을 넘기는 건 화면에 또렷이 보이는 칸까지만 허용한다(그 바깥은
// 어차피 안 보이므로 눌러도 의미가 없고, 투명한 클릭 영역만 남는 걸 막는다).
const CD_CLICKABLE_RADIUS = 2;

// slot(연속값 — 드래그·애니메이션 도중엔 소수도 들어온다. 0=재생 중)에
// 대응하는 위치/크기/투명도/쌓임 순서. 정지 상태(-2..2 정수)든 드래그나
// 자동 이동 도중의 임의의 실수든 같은 식 하나로 계산하므로, 어떤 디스크가
// 중앙(0)을 스쳐 지나가는 순간엔 자동으로 scale이 1까지 커졌다 작아진다.
function slotStyle(slot) {
  const abs = Math.abs(slot);
  return {
    offset: slot * SLOT_PCT,
    scale: Math.max(0.3, 1 - abs * 0.26),
    opacity: Math.max(0, 1 - abs * 0.42),
    z: Math.round(10 - abs),
  };
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function setupExpandedPlayer(player, { onOpen, onOpenAlbum, onOpenArtist } = {}) {
  const btn = document.getElementById("btn-expand-player");
  const panel = document.getElementById("expanded-player-panel");
  const transportStack = document.getElementById("transport-stack");
  const stageEl = document.getElementById("expanded-player-cd-stage");
  const highlightEl = stageEl.querySelector(".expanded-player-cd-highlight");
  const holeEl = stageEl.querySelector(".expanded-player-cd-hole");
  // CD 엘리먼트는 마크업에 미리 박아두는 대신 CD_RADIUS로부터 만들어서, 반경을
  // 하나(위 상수)만 바꾸면 HTML을 따로 손대지 않아도 되게 한다.
  const discEls = [];
  for (let i = 0; i < CD_RADIUS * 2 + 1; i++) {
    const el = document.createElement("div");
    el.className = "expanded-player-cd-disc";
    stageEl.insertBefore(el, highlightEl);
    discEls.push(el);
  }
  const titleEl = document.getElementById("expanded-player-title");
  const artistEl = document.getElementById("expanded-player-artist");
  const circleEl = document.getElementById("expanded-player-circle");
  const albumEl = document.getElementById("expanded-player-album");
  const statsEl = document.getElementById("expanded-player-stats-text");
  const statsPeriodEl = document.getElementById("expanded-player-stats-period");
  const queueEl = document.getElementById("expanded-player-queue");
  const queueListEl = document.getElementById("expanded-player-queue-list");

  attachScrollAutoHide(queueEl);

  statsPeriodEl.addEventListener("change", () => {
    const track = player.currentTrack;
    if (!track) return;
    fetchAndRenderStats(track);
  });

  let open = false;
  let lastTrack = null;
  let animationToken = 0; // 새 슬라이드/드래그가 시작될 때마다 올려서, 이전에 진행 중이던 rAF 루프를 멈춘다
  // 슬라이드나 드래그가 진행 중인 동안은 true — 대기열만 바뀌었을 때의 새로고침이
  // 이 위를 덮어써서(자리를 인덱스 기준으로 강제로 다시 맞추면서) 진행 중이던
  // 움직임을 끊거나, 그 시점에 아직 최종 자리로 정착하지 않은 dataset.slot을
  // 잘못된 기준으로 읽어 곡 그림을 통째로 다시 불러오는 깜빡임을 막는다.
  let busy = false;
  // 홀드 앤 드래그를 놓아서 곡이 바뀔 때는, 드래그 자체가 이미 그 자리까지
  // 손가락을 따라 움직여 보여준 뒤이므로 자동 슬라이드를 또 재생할 필요가
  // 없다 — 다음 트랙 변경 한 번만 애니메이션 없이 자리를 맞추도록 표시해 둔다.
  let suppressNextSlideAnimation = false;

  // 지금 중앙(slot 0)에 있는 디스크에만, 그것도 재생 중일 때만 회전을 건다.
  // 슬라이드/드래그 중에는 위치·크기(transform)를 JS가 인라인으로 애니메이션
  // 하므로 같은 속성을 쓰는 회전 애니메이션과 반드시 겹치지 않게 매번 전부
  // 껐다가 다시 판단한다.
  function applySpinState() {
    discEls.forEach((el) => el.classList.remove("spinning"));
    const current = discEls.find((el) => el.classList.contains("is-current"));
    if (current && player.isPlaying()) current.classList.add("spinning");
  }
  player.addEventListener("playstate", applySpinState);

  function windowAt(queue, idx) {
    const win = {};
    for (let s = -CD_RADIUS; s <= CD_RADIUS; s++) win[s] = queue[idx + s] || null;
    return win;
  }

  function setDiscClick(el, track) {
    el.onclick = track
      ? () => {
          const realIndex = player.playlist.tracks.indexOf(track);
          if (realIndex >= 0) player.playIndex(realIndex);
        }
      : null;
  }

  // 센터 홀/유광 하이라이트는 "지금 중앙에 가장 가까운 디스크"에 붙어있는
  // 물리적 CD의 특징이라, 그 디스크가 중앙에서 벗어난 만큼만(항상 -0.5~0.5칸)
  // 따라 움직이고 같은 비율로 커졌다 작아져야 한다 — offsetSlots를 그대로
  // 쓰면 디스크 여러 장을 건너뛸 때 계속 한 방향으로만 밀려나 화면 밖으로
  // 사라진 채 돌아오지 않는다. 정수 부분을 반올림해 떼어내면(나머지만 남기면)
  // 매 칸을 지날 때마다 저절로 원위치로 리셋되며 다음 디스크로 넘어간다.
  // hasTrack이 false면(그 방향에 곡 자체가 없어 중앙에 보여줄 CD가 없으면)
  // 홀/하이라이트도 같이 숨긴다 — 안 그러면 CD 없이 "CD처럼 보이게 하는
  // 장식"만 남아 있는 상태가 된다.
  function applyShadingOffset(offsetSlots, stageWidthPx, hasTrack) {
    const nearest = offsetSlots - Math.round(offsetSlots);
    const style = slotStyle(nearest);
    const px = nearest * (SLOT_PCT / 100) * stageWidthPx;
    holeEl.style.opacity = hasTrack ? "1" : "0";
    highlightEl.style.opacity = hasTrack ? "1" : "0";
    holeEl.style.transform = `translate(calc(-50% + ${px}px), -50%) scale(${style.scale})`;
    highlightEl.style.transform = `translateX(${px}px) scale(${style.scale})`;
  }

  function renderEntry(entry, offsetSlots) {
    const style = slotStyle(entry.baseSlot + offsetSlots);
    entry.el.style.transform = `translateX(${style.offset}%) scale(${style.scale})`;
    entry.el.style.opacity = entry.el._track ? String(style.opacity) : "0";
    entry.el.style.zIndex = String(style.z);
  }

  // entries([{el, baseSlot}])를 offsetSlots(0 기준 상대 이동량) 하나로 한꺼번에
  // 그린다 — 드래그 미리보기와 자동 슬라이드 둘 다 이 함수 하나만 쓴다(요청:
  // "자동 애니메이션은 자동으로 수행되는 드래그와 거의 같다"). 지금 중앙에
  // 가장 가까운 자리를 맡은 엔트리를 찾아, 그 엔트리에 실제 곡이 있는지로
  // 홀/하이라이트 표시 여부를 판단한다. baseSlot === round(-offsetSlots)로
  // 정확히 일치하는 자리를 찾으면, 드래그 중 슬롯 경계에서 offsetSlots가
  // 정확히 -0.5가 되는 순간 Math.round가 항상 위로 반올림해 실제 중앙(0)이
  // 아닌 옆 칸(1)을 찾아버리는 동점 문제가 있었다 — 거리 기반으로 가장 가까운
  // 엔트리를 찾으면 이 동점 문제 자체가 없어진다.
  function renderGroup(entries, offsetSlots, stageWidthPx) {
    entries.forEach((entry) => renderEntry(entry, offsetSlots));
    let nearestEntry = null;
    let nearestDist = Infinity;
    for (const entry of entries) {
      const dist = Math.abs(entry.baseSlot + offsetSlots);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestEntry = entry;
      }
    }
    applyShadingOffset(offsetSlots, stageWidthPx, !!(nearestEntry && nearestEntry.el._track));
  }

  // offsetSlots를 fromOffset -> toOffset까지 rAF로 부드럽게 움직인다.
  // animationToken이 도중에 바뀌면(새 드래그/슬라이드가 시작되면) 조용히
  // 멈춘다 — 다음 상호작용이 지금 화면 위치를 이어받는다.
  function runGroupTween(entries, fromOffset, toOffset, duration) {
    const myToken = animationToken;
    const stageWidthPx = stageEl.getBoundingClientRect().width;
    return new Promise((resolve) => {
      if (duration <= 0) {
        renderGroup(entries, toOffset, stageWidthPx);
        resolve();
        return;
      }
      const start = performance.now();
      function tick(now) {
        if (myToken !== animationToken) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - start) / duration);
        const offset = fromOffset + (toOffset - fromOffset) * easeOutCubic(t);
        renderGroup(entries, offset, stageWidthPx);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
  }

  // 트랜지션이 끝난 뒤 각 엔트리를 정확한 정수 자리에 "정착"시킨다 — 트랙
  // 내용, dataset.slot, is-current, 클릭 핸들러를 모두 최종 상태로 맞춘다.
  function settleEntries(entries) {
    entries.forEach(({ el, finalSlot }) => {
      const style = slotStyle(finalSlot);
      el.dataset.slot = String(finalSlot);
      el.classList.toggle("is-current", finalSlot === 0);
      el.style.transform = `translateX(${style.offset}%) scale(${style.scale})`;
      el.style.opacity = el._track ? String(style.opacity) : "0";
      el.style.zIndex = String(style.z);
      const clickable = el._track && Math.abs(finalSlot) <= CD_CLICKABLE_RADIUS;
      el.style.pointerEvents = clickable ? "" : "none";
      setDiscClick(el, finalSlot === 0 ? null : clickable ? el._track : null);
    });
    const centerEntry = entries.find((e) => e.finalSlot === 0);
    applyShadingOffset(0, stageEl.getBoundingClientRect().width, !!(centerEntry && centerEntry.el._track));
  }

  // 패널을 처음 열 때, 또는 트랙 자체는 안 바뀐 채 대기열 내용만 바뀌었을 때처럼
  // 슬라이드로 보여줄 게 없는 경우 곧바로 모든 자리를 맞춰 그린다(애니메이션 없이).
  function renderDiscsSnap() {
    discEls.forEach((el) => el.classList.remove("spinning"));
    const track = player.currentTrack;
    const queue = getDisplayQueue(player);
    const idx = track ? queue.indexOf(track) : -1;
    const win = idx >= 0 ? windowAt(queue, idx) : { 0: track || null };
    // 각 엘리먼트가 "몇 번째로 만들어졌는지"가 아니라 지금 실제로 자리하고 있는
    // slot(dataset.slot)을 기준으로 내용을 맞춘다 — 슬라이드가 한 번이라도
    // 일어나면 엘리먼트 배열 순서와 실제 자리는 더 이상 같지 않으므로, 생성
    // 순서(i - CD_RADIUS)로 억지로 다시 맞추면 거의 모든 디스크가 "내용이
    // 다르다"고 오판해 한꺼번에 이미지를 다시 불러오며 화면이 깜빡인다. 처음
    // 열 때처럼 아직 slot이 없는 경우에만 생성 순서를 기본값으로 쓴다.
    const entries = discEls.map((el, i) => ({
      el,
      finalSlot: el.dataset.slot !== undefined ? Number(el.dataset.slot) : i - CD_RADIUS,
    }));
    entries.forEach(({ el, finalSlot }) => {
      const track2 = win[finalSlot] || null;
      if (track2 !== el._track) {
        el.innerHTML = "";
        if (track2) el.appendChild(buildArtEl(track2.track_id, "expanded-player-cd-inner"));
        el._track = track2;
      }
    });
    settleEntries(entries);
    applySpinState();
  }

  // deltaSlots만큼 옮겼을 때 각 디스크가 어디서 시작해(baseSlot) 어디로
  // 가는지(finalSlot)를 계산하고, 새로 자리를 맡는(entrant) 디스크에는 맞는
  // 트랙 이미지를 채워 넣는다. slideDiscs(자동 애니메이션)와 shiftDragPool
  // (드래그 중 칸 경계를 넘을 때의 즉시 재배치) 둘 다 이 계산 하나를 공유한다.
  //
  // dataset.slot(= "지금 이 엘리먼트가 실제로 몇 번 자리인가")은 여기서 바로
  // 커밋한다 — 뒤이은 rAF 트윈이 끝까지 못 가고 새 상호작용(연타로 곡을 더
  // 넘기는 등)에 가로채여도, 이미 화면에 반영된 내용(el._track)과 위치
  // 장부(dataset.slot)가 서로 어긋나지 않게 하기 위해서다. 어긋나면 다음
  // 계산이 잘못된 기준 위에서 시작해 CD 그림과 실제 재생 곡이 안 맞을 수 있다.
  //
  // entrant는 내용을 바꾸기 전에 먼저 시작 자리(baseSlot, 항상 CD_RADIUS
  // 바깥이라 opacity 0)로 transform을 옮겨둔다 — 순서를 반대로 하면, 아직
  // 화면에 보이는 옛 자리에 있는 채로 그림만 먼저 바뀌어 버려(예: 방금까지
  // 중앙에 있던 디스크가 재활용되는 큰 폭 전환) CD가 잠깐 사라진 것처럼
  // 보인다.
  //
  // 살아남는 디스크가 하나도 없을 만큼(2*CD_RADIUS보다) 먼 점프(셔플, 대기
  // 목록에서 아주 먼 곡 클릭 등)에서는, 실제 건너뛴 칸 수(deltaSlots) 그대로
  // 가상 시작 자리를 잡으면 그 칸 수에 비례해 화면 밖에 머무는 시간도 길어져
  // — 곡이 많이 떨어져 있을수록 CD가 그만큼 오래 안 보인다. 그럴 땐 실제
  // 거리 대신 "화면 가장자리 바로 밖"(FLIGHT_RADIUS)에서만 들어오게 한다 —
  // 그 너머는 어차피 안 보이므로 실제 몇 칸을 건너뛰었는지와 무관하게 항상
  // 화면에 보이는 채로(또는 거의 바로) 슬라이드가 시작된다. 어느 트랙이
  // 어디로 가는지(finalSlot)와 실제 화면 내용(targetWindow)은 이 값과 무관
  // 하게 여전히 정확한 큐 위치를 따른다 — 달라지는 건 순전히 "얼마나 멀리서
  // 날아오는 척 하느냐"는 연출뿐이다.
  const FLIGHT_RADIUS = CD_RADIUS + 2;
  function computeSlideEntries(deltaSlots, targetWindow) {
    const survivors = [];
    const exitingEls = [];
    discEls.forEach((el) => {
      const newSlot = Number(el.dataset.slot) - deltaSlots;
      if (newSlot >= -CD_RADIUS && newSlot <= CD_RADIUS) survivors.push(el);
      else exitingEls.push(el);
    });
    const coveredSlots = new Set(survivors.map((el) => Number(el.dataset.slot) - deltaSlots));
    const entrantSlots = [];
    for (let s = -CD_RADIUS; s <= CD_RADIUS; s++) if (!coveredSlots.has(s)) entrantSlots.push(s);

    const flightDelta = survivors.length === 0 ? Math.sign(deltaSlots) * FLIGHT_RADIUS : deltaSlots;

    const entries = survivors.map((el) => {
      const baseSlot = Number(el.dataset.slot);
      const finalSlot = baseSlot - deltaSlots;
      el.dataset.slot = String(finalSlot);
      return { el, baseSlot, finalSlot };
    });
    entrantSlots.forEach((targetSlot, i) => {
      const el = exitingEls[i];
      if (!el) return;
      const baseSlot = targetSlot + flightDelta;
      renderEntry({ el, baseSlot }, 0);
      const track = targetWindow[targetSlot];
      if (track !== el._track) {
        el.innerHTML = "";
        if (track) el.appendChild(buildArtEl(track.track_id, "expanded-player-cd-inner"));
        el._track = track;
      }
      el.dataset.slot = String(targetSlot);
      entries.push({ el, baseSlot, finalSlot: targetSlot });
    });
    return { entries, flightDelta };
  }

  // deltaSlots(정수, 부호 있음: +면 다음 곡 방향, -면 이전 곡 방향)만큼 디스크
  // 전부를 한 번의 연속된 rAF 트윈으로 옮긴다. 화면 밖으로 밀려나는 디스크는
  // (반대편) "가상의 시작 자리"(목표 자리 + deltaSlots, ±CD_RADIUS 밖일 수도
  // 있음)를 baseSlot으로 삼아 처음부터 같은 트윈에 참여시킨다 — deltaSlots가
  // CD_RADIUS보다 커도(예: 아주 먼 곡으로 셔플) 그냥 더 먼 가상 자리에서
  // 출발할 뿐 로직은 그대로다. 모든 디스크가 정확히 같은 시간 동안 같은
  // 각도만큼 움직이므로 계단 없이 하나의 매끄러운 동작으로 보이고, 디스크가
  // 중앙(0)을 지나칠 땐 slotStyle이 매 프레임 실제 자리를 다시 계산하므로
  // 커졌다 작아지는 것도 저절로 나온다.
  async function slideDiscs(deltaSlots, targetWindow, instant = false) {
    // runGroupTween은 도중에 새 상호작용이 끼어들어도(animationToken 불일치)
    // "중단됐다"는 뜻으로 그냥 정상적으로 resolve한다 — 그러니 여기서도 직접
    // 토큰을 확인하지 않으면, 끊긴 이 호출이 뒤늦게 settleEntries를 불러
    // 그 사이 이미 새 호출이 만들어 둔(더 최신인) 자리/그림을 도로 덮어써
    // 버릴 수 있다(빠르게 곡을 넘길 때 CD 그림이 실제 재생 곡과 안 맞는 버그).
    const myToken = animationToken;
    const { entries, flightDelta } = computeSlideEntries(deltaSlots, targetWindow);
    const steps = Math.abs(deltaSlots);
    const duration = instant ? 0 : Math.min(SETTLE_MS_MAX, SETTLE_MS_BASE + (steps - 1) * SETTLE_MS_PER_STEP);
    await runGroupTween(entries, 0, -flightDelta, duration);
    if (myToken !== animationToken) return;
    settleEntries(entries);
  }

  // oldTrack -> newTrack 사이 큐 상의 거리(steps)를 한 번의 연속 동작으로
  // 넘긴다. 도중에 또 다른 곡 변경/드래그가 들어오면(연타, 트윈 중 드래그
  // 시작 등) animationToken이 달라져 이 결과는 버려지고 그 새 호출이
  // 이어받는다.
  async function animateTrackChange(oldTrack, newTrack) {
    animationToken++;
    const myToken = animationToken;
    // 홀드 앤 드래그를 놓아서 생긴 곡 변경이면, 드래그가 이미 그때그때 칸
    // 경계를 넘을 때마다 dataset.slot/내용을 맞는 자리로 옮겨 놨으므로(아래
    // shiftDragPool) 다시 계산할 게 없다 — 지금 자리를 그대로 최종 상태로
    // 정착만 시킨다(트윈 없이).
    const instant = suppressNextSlideAnimation;
    suppressNextSlideAnimation = false;
    busy = true;
    try {
      if (instant) {
        settleEntries(discEls.map((el) => ({ el, finalSlot: Number(el.dataset.slot) })));
        applySpinState();
        return;
      }
      const queue = getDisplayQueue(player);
      const oldIdx = oldTrack ? queue.indexOf(oldTrack) : -1;
      const newIdx = newTrack ? queue.indexOf(newTrack) : -1;
      const steps = oldIdx >= 0 && newIdx >= 0 ? Math.abs(newIdx - oldIdx) : 0;
      // 몇 칸을 건너뛰든(셔플, 아주 먼 곡 클릭 등) slideDiscs는 목표 자리를 기준으로
      // 진입하는 CD의 가상 시작 위치만 멀리 잡을 뿐이라 거리 제한 없이 그대로
      // 슬라이드로 처리된다 — 곡이 그대로일 때만 애니메이션할 게 없어 스냅한다.
      if (!steps) {
        renderDiscsSnap();
        return;
      }
      const deltaSlots = newIdx > oldIdx ? steps : -steps;
      await slideDiscs(deltaSlots, windowAt(queue, newIdx));
      if (myToken === animationToken) applySpinState();
    } finally {
      if (myToken === animationToken) busy = false;
    }
  }

  // -- 홀드 앤 드래그로 곡 넘기기 --------------------------------------------
  // 드래그 중에는 손가락 이동량을 정수 칸(rounded)과 그 나머지(frac, 항상
  // -0.5~0.5)로 나눈다. frac은 renderGroup으로 매 프레임 1:1로 그리기만
  // 하고, rounded가 바뀔 때(칸 경계를 넘을 때)만 shiftDragPool로 디스크
  // 엘리먼트들을 "지금 중앙에 가장 가까운 곡"(centerIdx) 기준으로 재배치한다
  // — 재배치 자체는 즉시(트윈 없이) 일어나고 그 결과가 다음 프레임부터 바로
  // frac 오프셋으로 그려지니 화면상으로는 계속 손가락을 따라가는 것처럼
  // 보인다. 이 덕분에 디스크 엘리먼트는 화면에 보이는 몇 장(CD_RADIUS)만
  // 있으면 되고, 드래그를 아무리 멀리 끌어도(칸 경계를 넘을 때마다 재활용되니)
  // 큐에 곡이 남아있는 한 계속 CD가 나온다.
  let dragState = null;

  // 손을 뗐는데 온전한 한 칸도 못 넘겼거나(살짝 건드린 정도) 그 방향에 곡이
  // 없으면, 지금 드래그로 미리 보여준 자리(fromOffset)에서 제자리(0)까지
  // 같은 rAF 트윈으로 되돌린다 — 곡이 바뀔 때와 똑같은 함수를 쓰므로 여기서도
  // 계단 없이 매끄럽다.
  async function settleDragBack(fromOffset) {
    animationToken++;
    const myToken = animationToken;
    busy = true;
    try {
      const entries = discEls.map((el) => ({ el, baseSlot: Number(el.dataset.slot) }));
      await runGroupTween(entries, fromOffset, 0, SETTLE_MS_BASE);
      if (myToken !== animationToken) return;
      settleEntries(entries.map(({ el, baseSlot }) => ({ el, finalSlot: baseSlot })));
      applySpinState();
    } finally {
      if (myToken === animationToken) busy = false;
    }
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (!player.currentTrack) return;
    const rect = stageEl.getBoundingClientRect();
    if (!rect.width) return;
    animationToken++; // 진행 중이던 자동 슬라이드가 있으면 여기서 멈춘다
    busy = true; // 드래그 중에는 대기열만 바뀐 새로고침이 자리를 건드리지 못하게 막는다
    const queue = getDisplayQueue(player);
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      stageWidth: rect.width,
      offsetSlots: 0,
      rounded: 0,
      // 드래그를 시작한 순간 중앙에 있던 곡의 큐 상 절대 인덱스 — 칸 경계를
      // 넘을 때마다 이 값을 그만큼 밀어서 "지금 중앙에 가장 가까운 곡"을 계속
      // 추적한다.
      centerIdx: queue.indexOf(player.currentTrack),
    };
    discEls.forEach((el) => el.classList.remove("spinning"));
    stageEl.classList.add("dragging");
    stageEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const slotWidthPx = (SLOT_PCT / 100) * dragState.stageWidth;
    dragState.offsetSlots = slotWidthPx > 0 ? (e.clientX - dragState.startX) / slotWidthPx : 0;
    const rounded = Math.round(dragState.offsetSlots);
    if (rounded !== dragState.rounded) {
      const step = rounded - dragState.rounded;
      dragState.rounded = rounded;
      // 오른쪽으로 끌수록(step 양수) 이전 곡이 중앙으로 다가오므로 큐
      // 인덱스는 거꾸로(-) 움직인다.
      dragState.centerIdx -= step;
      const queue = getDisplayQueue(player);
      computeSlideEntries(-step, windowAt(queue, dragState.centerIdx));
    }
    const frac = dragState.offsetSlots - dragState.rounded;
    renderGroup(
      discEls.map((el) => ({ el, baseSlot: Number(el.dataset.slot) })),
      frac,
      dragState.stageWidth
    );
  }

  function onPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const frac = dragState.offsetSlots - dragState.rounded;
    const centerIdx = dragState.centerIdx;
    dragState = null;
    stageEl.classList.remove("dragging");
    try {
      stageEl.releasePointerCapture(e.pointerId);
    } catch (_err) {
      /* 이미 풀렸으면 무시 */
    }

    const queue = getDisplayQueue(player);
    const targetTrack = centerIdx >= 0 && centerIdx < queue.length ? queue[centerIdx] : null;
    if (!targetTrack) {
      // 큐 시작/끝을 넘어서까지 끌었다 — 보여줄 곡이 없으니 실제 재생 중인
      // 자리로 곧바로 되돌린다.
      busy = false;
      renderDiscsSnap();
      return;
    }
    if (targetTrack === player.currentTrack) {
      settleDragBack(frac);
      return;
    }
    const realIndex = player.playlist.tracks.indexOf(targetTrack);
    if (realIndex >= 0) {
      // 드래그 중 칸 경계를 넘을 때마다 이미 이 자리로 옮겨 놨으므로, 뒤이어
      // 오는 trackchange가 슬라이드를 처음부터 다시 계산하지 않고 지금 자리를
      // 그대로 정착만 시키게 한다.
      suppressNextSlideAnimation = true;
      player.playIndex(realIndex);
    } else {
      settleDragBack(frac);
    }
  }

  stageEl.addEventListener("pointerdown", onPointerDown);
  stageEl.addEventListener("pointermove", onPointerMove);
  stageEl.addEventListener("pointerup", onPointerUp);
  stageEl.addEventListener("pointercancel", onPointerUp);
  stageEl.addEventListener("dragstart", (e) => e.preventDefault());

  function renderNowPlaying() {
    const track = player.currentTrack;
    titleEl.innerHTML = "";
    artistEl.innerHTML = "";
    albumEl.innerHTML = "";
    circleEl.textContent = "";
    circleEl.classList.add("is-empty");
    circleEl.onclick = null;
    if (!track) {
      statsEl.textContent = "";
      return;
    }
    // 통계(총 재생 횟수/시간)는 서버에 물어봐야 해서 곧바로 채울 수 없다.
    // 여기서 비워버리면 응답이 올 때까지 그 줄이 찌부러졌다가 늘어나며
    // 레이아웃이 출렁이므로, 새 값이 도착할 때까지는 이전 곡 값을 그대로
    // 둔다(min-height도 CSS에서 같은 문제를 한 번 더 막아준다).

    titleEl.appendChild(createMarqueeClip("expanded-player-title-clip", "", track.title || track.track_id));
    if (track.artist) artistEl.appendChild(buildArtistCell("expanded-player-artist-clip", track.artist, onOpenArtist));

    const album = store.getAlbums().find((a) => a.id === track.album_id);
    const albumLine = [track.album, album && album.year].filter(Boolean).join(" · ");
    if (albumLine) {
      const albumClip = createMarqueeClip("expanded-player-album-clip", "", albumLine);
      if (track.album && onOpenAlbum) {
        albumClip.classList.add("playlist-row-album-link");
        albumClip.title = "앨범 보기";
        albumClip.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenAlbum(track);
        });
      }
      albumEl.appendChild(albumClip);
    }

    // 서클명은 앨범 아티스트를 서클 레지스트리에서 찾아 정식 명칭으로 바꾼
    // 값이다. 곡 아티스트와 같으면(흔한 경우) 중복 표시를 피한다.
    const circleName = album ? buildArtistNameResolver(store.getCircles())(album.artist) : null;
    if (circleName && circleName !== track.artist) {
      circleEl.textContent = circleName;
      circleEl.classList.remove("is-empty");
      if (onOpenArtist) circleEl.onclick = () => onOpenArtist(circleName);
    }

    fetchAndRenderStats(track);

    requestAnimationFrame(() => applyMarquee(titleEl.parentElement));
  }

  function fetchAndRenderStats(track) {
    api
      .getTrackTotals(track.track_id, statsPeriodEl.value, 0)
      .then((totals) => {
        if (player.currentTrack !== track) return;
        statsEl.innerHTML = "";
        statsEl.appendChild(iconSpan("bar-chart-2", "icon-sm"));
        statsEl.appendChild(document.createTextNode(`${totals.count || 0}회`));
        statsEl.appendChild(iconSpan("clock", "icon-sm"));
        statsEl.appendChild(document.createTextNode(`${Math.round((totals.listened_ms || 0) / 60000)}분`));
      })
      .catch(() => {});
  }

  function buildQueueRow(track, isCurrent) {
    const row = document.createElement("div");
    row.className = "expanded-queue-row" + (isCurrent ? " current" : "");
    row.appendChild(buildArtEl(track.track_id, "expanded-queue-row-art-wrap"));

    const text = document.createElement("div");
    text.className = "expanded-queue-row-text";
    text.appendChild(createMarqueeClip("expanded-queue-row-title", "", track.title || track.track_id));

    const subtitle = document.createElement("div");
    subtitle.className = "expanded-queue-row-subtitle";
    if (track.artist) subtitle.appendChild(buildArtistCell("expanded-queue-row-artist", track.artist, onOpenArtist));
    if (track.artist && track.album) subtitle.appendChild(document.createTextNode("·"));
    if (track.album) {
      const albumClip = createMarqueeClip("expanded-queue-row-album", "", track.album);
      if (onOpenAlbum) {
        albumClip.classList.add("playlist-row-album-link");
        albumClip.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenAlbum(track);
        });
      }
      subtitle.appendChild(albumClip);
    }
    text.appendChild(subtitle);
    row.appendChild(text);

    if (!isCurrent) {
      row.addEventListener("click", () => {
        const realIndex = player.playlist.tracks.indexOf(track);
        if (realIndex >= 0) player.playIndex(realIndex);
      });
    }
    return row;
  }

  function renderQueue() {
    queueListEl.innerHTML = "";
    const queue = getDisplayQueue(player);
    // 큐가 이제 지나간 곡도 포함하므로(더는 끝난 곡이라고 목록에서 지우지
    // 않음), "현재 재생 중"은 배열의 첫 자리가 아니라 실제 재생 중인 트랙과
    // 같은 객체인지로 판단한다.
    queue.forEach((track) => queueListEl.appendChild(buildQueueRow(track, track === player.currentTrack)));
    requestAnimationFrame(() => applyMarquee(queueListEl));
  }

  function renderAll() {
    if (!open) return;
    renderNowPlaying();
    const track = player.currentTrack;
    if (track !== lastTrack) {
      animateTrackChange(lastTrack, track);
      lastTrack = track;
    } else if (!busy) {
      // 트랙 자체는 그대로지만(큐 확장 등) 대기 목록이 바뀌었을 수 있으니
      // 옆 칸 내용만 애니메이션 없이 새로고침한다. 슬라이드나 드래그가 한창
      // 진행 중이면 건드리지 않는다 — 여기서 자리를 강제로 다시 맞추면 그
      // 진행 중이던 움직임이 끊기고, 아직 최종 자리로 정착 전인 dataset.slot을
      // 기준으로 내용을 다시 골라 화면이 통째로 깜빡인다. 어차피 대기열은
      // 보이는 범위(±CD_RADIUS) 훨씬 밖으로만 늘어나므로 조금 늦게 반영돼도
      // 상관없다.
      renderDiscsSnap();
    }
    renderQueue();
  }

  // 재생 중인(불러온) 곡이 하나도 없으면 볼 대기 목록 자체가 없으므로 버튼을 막는다.
  function updateButtonAvailability() {
    btn.disabled = !player.currentTrack;
  }

  function setOpen(next) {
    open = next;
    panel.classList.toggle("active", open);
    transportStack.classList.toggle("expanded", open);
    if (open) {
      // 패널이 닫혀 있는 동안 곡이 여러 번 바뀌었을 수 있다 — 다시 열 때는
      // 그 변화를 슬라이드로 몰아서 보여줄 필요 없이 곧장 스냅해야 하므로,
      // renderAll의 방향 판단을 거치지 않고 직접 그린다.
      lastTrack = player.currentTrack;
      animationToken++;
      renderNowPlaying();
      renderDiscsSnap();
      renderQueue();
      // 좁은 화면(사이드바가 토글 드로어인 환경)에서는 드로어가 열려 있는 채로
      // 재생바를 확장하면 서로 겹치므로, 확장하는 순간 드로어를 닫아준다.
      if (onOpen) onOpen();
    }
  }

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    if (!open) return;
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => applyMarquee(queueListEl), 150);
  });

  btn.addEventListener("click", () => setOpen(!open));
  player.addEventListener("trackchange", () => {
    updateButtonAvailability();
    renderAll();
  });
  player.addEventListener("queuechange", renderAll);
  player.addEventListener("shufflechange", renderQueue);
  updateButtonAvailability();

  return {
    show: () => setOpen(true),
    hide: () => setOpen(false),
  };
}
