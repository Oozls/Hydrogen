// 곡 행 제목이 컬럼 폭보다 길 때 자동으로 스크롤하는 마퀴.
// `.playlist-row-title-clip`(overflow 컨테이너) > `.playlist-row-title-inner`
// 구조를 전제로 하며, 브라우즈/재생목록/앨범 상세/재생바 등 곡 제목이 있는
// 모든 곳에서 공용으로 사용한다. 레이아웃이 확정된 뒤(다음 프레임)에 호출해야
// 폭 측정이 정확하다.
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

function stopMarquee(inner) {
  if (inner._marqueeAnim) {
    inner._marqueeAnim.cancel();
    inner._marqueeAnim = null;
  }
  inner.classList.remove("marquee");
}

export function applyMarquee(rootEl) {
  if (!rootEl) return;
  const clips = rootEl.querySelectorAll(".playlist-row-title-clip");
  clips.forEach((clip) => {
    const inner = clip.querySelector(".playlist-row-title-inner");
    if (!inner) return;

    stopMarquee(inner);

    // 우선 일반 텍스트로 되돌려서 실제(줄바꿈 없는) 폭을 측정한다.
    const text = inner.textContent;
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
