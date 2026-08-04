// 곡 행 제목/앨범명/아티스트명이 칸 폭보다 길 때 자동으로 스크롤하는 마퀴.
// `.marquee-clip`(overflow 컨테이너) > `.marquee-inner` 구조를 전제로 하며,
// 브라우즈/재생목록/앨범 상세/재생바 등 곡 정보가 있는 모든 곳에서 공용으로
// 사용한다. 레이아웃이 확정된 뒤(다음 프레임)에 호출해야 폭 측정이 정확하다.
//
// 제목을 두 벌 나란히 두고 정확히 한 벌 폭(+간격)만큼 한 방향으로 이동시켜,
// 끝에 닿으면 순간적으로 처음 제목 텍스트가 이어지는 것처럼 보이는 이음매 없는
// 루프를 만든다. 속도(px/s)는 고정이라 제목 길이와 무관하게 동일한 체감 속도로
// 흐르고, 한 바퀴 도는 데 걸리는 시간(길이에 비례)만 달라진다.
//
// 처음 위치로 돌아오면 PAUSE_MS만큼 정지했다가 다시 스크롤한다. 이 정지 구간은
// 제목마다 전체 주기에서 차지하는 비율이 다르므로(짧은 제목일수록 비중이 큼)
// CSS @keyframes의 고정 퍼센트로는 표현할 수 없어, 제목별로 정확한 타이밍을
// 계산해 Web Animations API(element.animate)로 직접 구동한다.

const PIXELS_PER_SECOND = 40;
const LOOP_GAP_PX = 48;
const PAUSE_MS = 3000;
const EDGE_FADE_PX = 14; // .marquee-clip의 CSS --marquee-fade-edge 값과 반드시 같아야 함
const EDGE_FADE_TRANSITION_MS = 400;

// 곡 행 텍스트에 쓰는 커스텀 웹폰트(Apple SD Gothic Neo, Noto Sans JP)는
// font-display: swap이라, 최초 렌더 시점엔 아직 폭이 다른 대체 폰트로 표시되다가
// 로딩이 끝나면 실제 폰트로 바뀐다. applyColumnPriority/applyMarquee는 렌더 직후
// 딱 한 번만 폭을 재는데, 그 시점이 폰트 로딩 완료 전이면(특히 느린 모바일
// 네트워크에서 앱을 열자마자 목록을 빠르게 넘길 때) 대체 폰트 기준으로 잘못된
// 숨김 판단이 그대로 굳어버린다. 폰트 로딩이 끝나면, 이미 각 화면에 있는
// 리사이즈 시 재계산 로직이 다시 돌도록 가짜 resize 이벤트를 한 번 발생시켜
// 전체 목록의 폭 측정을 실제 폰트 기준으로 바로잡는다.
if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => window.dispatchEvent(new Event("resize")));
}

// 곡 행의 제목/앨범명/아티스트명 칸을 공용 마퀴 구조(overflow:hidden 컨테이너 +
// 텍스트를 담는 내부 span)로 만들어준다. clipClassName은 열의 폭(flex-basis)을
// 정하고, innerClassName은 필요한 경우(제목처럼 색상을 별도로 상속받아야 하는
// 경우)에만 추가로 지정한다.
export function createMarqueeClip(clipClassName, innerClassName, text) {
  const clip = document.createElement("span");
  clip.className = `${clipClassName} marquee-clip`;
  const inner = document.createElement("span");
  inner.className = innerClassName ? `${innerClassName} marquee-inner` : "marquee-inner";
  inner.textContent = text;
  clip.appendChild(inner);
  return clip;
}

function stopMarquee(inner) {
  if (inner._marqueeAnim) {
    inner._marqueeAnim.cancel();
    inner._marqueeAnim = null;
  }
  inner.classList.remove("marquee");
}

function stopMarqueeFade(clip) {
  if (clip._marqueeFadeAnim) {
    clip._marqueeFadeAnim.cancel();
    clip._marqueeFadeAnim = null;
  }
  clip.style.removeProperty("--marquee-fade-left");
}

// 곡 행의 앨범명/아티스트명은 공간이 부족할 때 제목보다 먼저 희생된다. 앨범+아티스트를
// 각자의 고정 폭(CSS flex-basis) 그대로 보여준다고 가정했을 때 제목에게 남는 공간이
// 그 고정 폭 합보다 좁아지면, 제목을 지키기 위해 앨범/아티스트를 통째로 숨긴다. 칸 폭
// 자체는 항상 CSS 기본값을 그대로 쓰고 절대 늘리지 않는다 — 칸 안 텍스트가 폭보다 길어도
// 칸을 넓히는 대신 이미 같은 컨테이너를 쓰는 마퀴 스크롤(applyMarquee)이 알아서 흡수하므로,
// 텍스트 길이는 숨김 여부와 무관하다. 표처럼 정렬을 유지해야 하므로 이 판단은 행마다
// 따로 내리지 않고 목록 전체에서 한 번만 내려 모든 행에 동일하게 적용한다 — 그래야 유독
// 이름이 긴 곡 한두 개 때문에 그 행만 앨범/아티스트가 사라지거나 칸 폭이 어긋나는 일이
// 없다. applyMarquee와 마찬가지로 레이아웃이 확정된 뒤(다음 프레임)에 호출해야 하고,
// 제목 폭 측정에 영향을 주므로 applyMarquee보다 먼저 호출해야 한다.
const LABEL_GAP_PX = 10;
const ALBUM_COLUMN_WIDTH = 170; // .playlist-row-album의 CSS flex-basis와 반드시 같아야 함
const ARTIST_COLUMN_WIDTH = 150; // .playlist-row-artist의 CSS flex-basis와 반드시 같아야 함

// 앨범/아티스트 칸은 표처럼 목록 전체에서 보임/숨김과 폭이 맞아야 하므로, 행마다
// 따로 판단하지 않고 목록 단위로 한 번에 계산해 모든 행에 동일하게 적용한다.
export function applyColumnPriority(rootEl) {
  if (!rootEl) return;
  const rows = rootEl.querySelectorAll(".playlist-row");
  const entries = [];
  rows.forEach((row) => {
    const label = row.querySelector(".playlist-row-label");
    const album = row.querySelector(".playlist-row-album");
    const artist = row.querySelector(".playlist-row-artist");
    if (!label || (!album && !artist)) return;
    if (album) album.hidden = false;
    if (artist) artist.hidden = false;
    entries.push({ label, album, artist });
  });
  if (!entries.length) return;

  const gapCount = (entries[0].album ? 1 : 0) + (entries[0].artist ? 1 : 0);
  const columnWidth = (entries[0].album ? ALBUM_COLUMN_WIDTH : 0) + (entries[0].artist ? ARTIST_COLUMN_WIDTH : 0);
  // 행 구조(체크박스/가사 아이콘/재생시간/레이팅 등)는 모든 행이 동일해서 라벨
  // 폭도 원래 같아야 하지만, 혹시 모를 오차에 대비해 가장 좁은 값을 기준으로 삼는다.
  const labelWidth = Math.min(...entries.map((e) => e.label.clientWidth));
  const safeCombinedWidth = Math.max(0, (labelWidth - LABEL_GAP_PX * gapCount) / 2);

  const shouldHide = columnWidth > safeCombinedWidth;
  entries.forEach((e) => {
    if (e.album) e.album.hidden = shouldHide;
    if (e.artist) e.artist.hidden = shouldHide;
  });
}

export function applyMarquee(rootEl) {
  if (!rootEl) return;
  const clips = rootEl.querySelectorAll(".marquee-clip");
  clips.forEach((clip) => {
    const inner = clip.querySelector(".marquee-inner");
    if (!inner) return;

    stopMarquee(inner);
    stopMarqueeFade(clip);

    // 우선 일반 텍스트로 되돌려서 실제(줄바꿈 없는) 폭을 측정한다.
    // 이미 marquee 복사본 2벌이 남아있다면 textContent를 그대로 읽으면 이어붙여져
    // 중복되므로, 복사본 중 하나만 원본으로 취급한다.
    const firstCopy = inner.querySelector(".marquee-copy");
    const text = firstCopy ? firstCopy.textContent : inner.textContent;
    inner.innerHTML = "";
    inner.textContent = text;
    const singleWidth = inner.scrollWidth;
    const clipWidth = clip.clientWidth;

    if (singleWidth <= clipWidth) return; // 스크롤 불필요한 제목은 그대로 둔다.

    const loopWidth = singleWidth + LOOP_GAP_PX;
    inner.innerHTML = "";
    const first = document.createElement("span");
    first.className = "marquee-copy";
    first.textContent = text;
    first.style.marginRight = `${LOOP_GAP_PX}px`;
    const second = document.createElement("span");
    second.className = "marquee-copy";
    second.textContent = text;
    inner.appendChild(first);
    inner.appendChild(second);
    inner.classList.add("marquee");

    const scrollMs = (loopWidth / PIXELS_PER_SECOND) * 1000;
    const totalMs = PAUSE_MS + scrollMs;
    const pauseOffset = PAUSE_MS / totalMs;

    inner._marqueeAnim = inner.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: pauseOffset },
        { transform: `translateX(-${loopWidth}px)`, offset: 1 },
      ],
      { duration: totalMs, iterations: Infinity, easing: "linear" }
    );

    // 왼쪽 끝 그라데이션은 정지 구간(offset 0~pauseOffset, 텍스트의 진짜
    // 시작 부분이 왼쪽 끝에 그대로 있는 상태)에서는 꺼두고, 실제로 스크롤이
    // 시작되는 시점(pauseOffset)부터 서서히 켠 뒤, 다시 정지 위치로 돌아오기
    // 직전에 서서히 끈다. 순간적으로 켜졌다 꺼지면 눈에 확 띄므로 짧게
    // 크로스페이드한다. transform 애니메이션과 duration/iterations가 완전히
    // 같으므로 두 애니메이션은 항상 같은 위상으로 돈다.
    const rampMs = Math.min(EDGE_FADE_TRANSITION_MS, scrollMs / 2);
    const rampOffset = rampMs / totalMs;
    clip._marqueeFadeAnim = clip.animate(
      [
        { offset: 0, "--marquee-fade-left": "0px" },
        { offset: pauseOffset, "--marquee-fade-left": "0px" },
        { offset: pauseOffset + rampOffset, "--marquee-fade-left": `${EDGE_FADE_PX}px` },
        { offset: 1 - rampOffset, "--marquee-fade-left": `${EDGE_FADE_PX}px` },
        { offset: 1, "--marquee-fade-left": "0px" },
      ],
      { duration: totalMs, iterations: Infinity, easing: "linear" }
    );
  });
}
