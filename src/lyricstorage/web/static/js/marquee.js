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

// 곡 행의 앨범명/아티스트명은 공간이 부족할 때 제목보다 먼저 희생된다. 앨범+아티스트를
// 원래 폭 그대로 보여준다고 가정했을 때 제목에게 남는 공간이 앨범+아티스트의 원래 폭
// 합보다 좁아지면, 제목을 지키기 위해 앨범/아티스트를 통째로 숨긴다. 행마다 텍스트
// 길이가 다르므로 고정 픽셀 기준(미디어 쿼리)이 아니라 실측 텍스트 폭으로 판단한다.
// applyMarquee와 마찬가지로 레이아웃이 확정된 뒤(다음 프레임)에 호출해야 하고, 제목
// 폭 측정에 영향을 주므로 applyMarquee보다 먼저 호출해야 한다.
const LABEL_GAP_PX = 10;

export function applyColumnPriority(rootEl) {
  if (!rootEl) return;
  const rows = rootEl.querySelectorAll(".playlist-row");
  rows.forEach((row) => {
    const label = row.querySelector(".playlist-row-label");
    const album = row.querySelector(".playlist-row-album");
    const artist = row.querySelector(".playlist-row-artist");
    if (!label || (!album && !artist)) return;

    // 실제 텍스트 폭을 다시 재려면 우선 숨김을 풀어야 한다(숨겨진 요소는 scrollWidth가 0).
    if (album) album.hidden = false;
    if (artist) artist.hidden = false;

    const naturalWidth = (album ? album.scrollWidth : 0) + (artist ? artist.scrollWidth : 0);
    if (naturalWidth === 0) return;

    const gapCount = (album ? 1 : 0) + (artist ? 1 : 0);
    const titleSpaceIfShown = label.clientWidth - naturalWidth - LABEL_GAP_PX * gapCount;
    const shouldHide = titleSpaceIfShown < naturalWidth;

    if (album) album.hidden = shouldHide;
    if (artist) artist.hidden = shouldHide;
  });
}

export function applyMarquee(rootEl) {
  if (!rootEl) return;
  const clips = rootEl.querySelectorAll(".marquee-clip");
  clips.forEach((clip) => {
    const inner = clip.querySelector(".marquee-inner");
    if (!inner) return;

    stopMarquee(inner);

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
  });
}
