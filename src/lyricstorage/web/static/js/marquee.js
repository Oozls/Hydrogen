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

// 곡 행의 앨범명/아티스트명은 공간이 부족할 때 제목보다 먼저 희생된다. 앨범+아티스트를
// 원래 폭 그대로 보여준다고 가정했을 때 제목에게 남는 공간이 앨범+아티스트의 원래 폭
// 합보다 좁아지면, 제목을 지키기 위해 앨범/아티스트를 통째로 숨긴다. 그렇지 않고 여유가
// 있으면(제목을 침범하지 않는 한도 안에서) 칸이 넘치는 만큼 폭을 넓혀 스크롤 없이 보여
// 준다 — 표처럼 정렬을 유지해야 하므로 이 폭은 행마다 따로가 아니라 목록 전체에서 한
// 번에 계산해 모든 행에 동일하게 적용한다. 고정 픽셀 기준(미디어 쿼리)이 아니라 실측
// 텍스트 폭으로 판단한다. applyMarquee와 마찬가지로 레이아웃이 확정된 뒤(다음 프레임)에
// 호출해야 하고, 제목 폭 측정에 영향을 주므로 applyMarquee보다 먼저 호출해야 한다.
const LABEL_GAP_PX = 10;

// 앨범/아티스트 칸은 표처럼 목록 전체에서 폭이 맞아야 하므로, 행마다 따로
// 넓히지 않고 목록 단위로 한 번에 계산해 모든 행에 같은 폭을 적용한다.
export function applyColumnPriority(rootEl) {
  if (!rootEl) return;
  const rows = rootEl.querySelectorAll(".playlist-row");
  const entries = [];
  rows.forEach((row) => {
    const label = row.querySelector(".playlist-row-label");
    const album = row.querySelector(".playlist-row-album");
    const artist = row.querySelector(".playlist-row-artist");
    if (!label || (!album && !artist)) return;

    // 실제 텍스트 폭을 다시 재려면 우선 숨김/이전 렌더의 폭 조정을 풀어야 한다
    // (숨겨진 요소는 scrollWidth가 0이고, 리사이즈로 재계산할 때는 지난번에
    // 넓혀둔 폭이 그대로 남아있어 측정을 왜곡한다).
    if (album) { album.hidden = false; album.style.flexBasis = ""; }
    if (artist) { artist.hidden = false; artist.style.flexBasis = ""; }
    entries.push({ label, album, artist });
  });
  if (!entries.length) return;

  const gapCount = (entries[0].album ? 1 : 0) + (entries[0].artist ? 1 : 0);
  // 행 구조(체크박스/가사 아이콘/재생시간/레이팅 등)는 모든 행이 동일해서 라벨
  // 폭도 원래 같아야 하지만, 혹시 모를 오차에 대비해 가장 좁은 값을 기준으로 삼는다.
  const labelWidth = Math.min(...entries.map((e) => e.label.clientWidth));
  const safeCombinedWidth = Math.max(0, (labelWidth - LABEL_GAP_PX * gapCount) / 2);

  // 1차: 행마다 "자기 폭 그대로" 보여줬을 때 제목 몫을 침범하는지로 숨김 여부를
  // 정하고, 숨기지 않는 행들 중 각 칸이 필요로 하는 최대 폭을 구한다.
  let maxAlbumWidth = 0;
  let maxArtistWidth = 0;
  entries.forEach((e) => {
    const naturalWidth = (e.album ? e.album.scrollWidth : 0) + (e.artist ? e.artist.scrollWidth : 0);
    if (naturalWidth === 0) return;
    const shouldHide = naturalWidth > safeCombinedWidth;
    if (e.album) e.album.hidden = shouldHide;
    if (e.artist) e.artist.hidden = shouldHide;
    if (shouldHide) return;
    if (e.album) maxAlbumWidth = Math.max(maxAlbumWidth, e.album.scrollWidth);
    if (e.artist) maxArtistWidth = Math.max(maxArtistWidth, e.artist.scrollWidth);
  });
  if (maxAlbumWidth === 0 && maxArtistWidth === 0) return;

  // 2차: 서로 다른 행에서 뽑힌 최대 폭끼리 더하면 안전 한도를 넘을 수 있으니
  // (예: 앨범명이 긴 행과 아티스트명이 긴 행이 서로 다름), 넘칠 경우 두 칸을
  // 같은 비율로 줄여 제목 몫을 지킨다.
  const desiredCombined = maxAlbumWidth + maxArtistWidth;
  const scale = desiredCombined > safeCombinedWidth ? safeCombinedWidth / desiredCombined : 1;
  const albumWidth = Math.floor(maxAlbumWidth * scale);
  const artistWidth = Math.floor(maxArtistWidth * scale);

  // 이미 기본 폭(CSS의 flex-basis)에 다 들어가는 칸은 그대로 두고, 목록 전체에서
  // 실제로 더 넓혀야 하는 칸에만 같은 폭을 적용해 모든 행에서 정렬을 맞춘다.
  entries.forEach((e) => {
    if (e.album && !e.album.hidden && albumWidth > e.album.clientWidth) {
      e.album.style.flexBasis = `${albumWidth}px`;
    }
    if (e.artist && !e.artist.hidden && artistWidth > e.artist.clientWidth) {
      e.artist.style.flexBasis = `${artistWidth}px`;
    }
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
