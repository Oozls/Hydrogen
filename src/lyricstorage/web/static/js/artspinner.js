import { api } from "./api.js";
import { iconSpan } from "./icons.js";

// 앨범 커버 <img>가 로딩되는 동안 아트 컨테이너 위에 스피너를 겹쳐 보여준다.
// 컨테이너는 position:relative여야 하고(대부분 이미 그렇게 스타일돼 있음), 로드
// 완료/실패 시 호출부가 반환된 함수를 불러 스피너를 제거해야 한다.
export function showArtSpinner(wrapEl) {
  if (!wrapEl) return () => {};
  const spinner = document.createElement("span");
  spinner.className = "art-spinner";
  wrapEl.appendChild(spinner);
  return () => spinner.remove();
}

// 트랙 아트(로딩 스피너 + 실패 시 음표 아이콘 폴백)를 담은 wrapEl을 만든다.
// home.js/expanded-player.js처럼 트랙 카드/행을 그리는 여러 화면에서 공유한다.
export function buildArtEl(trackId, wrapClass, size) {
  const wrap = document.createElement("div");
  wrap.className = wrapClass;
  const stopSpin = showArtSpinner(wrap);
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  // 브라우저 기본 이미지 드래그(고스트 썸네일이 붙는 그 동작)를 꺼둔다 —
  // 켜져 있으면 커버 아트를 누른 채 살짝만 움직여도 우리 pointer 기반
  // 드래그(재생 대기 CD 스크럽 등)보다 먼저 네이티브 드래그가 가로채간다.
  img.draggable = false;
  img.src = api.artUrl(trackId, size);
  img.onload = () => stopSpin();
  img.onerror = () => {
    stopSpin();
    img.remove();
    wrap.appendChild(iconSpan("music", "icon-lg"));
  };
  wrap.appendChild(img);
  return wrap;
}
