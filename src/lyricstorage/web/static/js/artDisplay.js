import { showArtSpinner } from "./artspinner.js";

// 표지 URL 캐시 버스터: 예전에는 열 때마다 ?t=Date.now()로 매번 새로 받았다.
// 이제는 표지를 실제로 업로드/교체한 직후(bumpArtVersion)에만 값이 바뀌고, 그
// 외에는 같은 URL이라 브라우저 캐시를 쓴다. 초기값은 페이지 로드 시각이라
// 새로고침하면 한 번은 다시 받는다(다른 경로로 바뀐 표지 대비).
const sessionSeed = Date.now();
const artVersions = new Map();

export function artVersionQuery(id) {
  return `?v=${sessionSeed}.${artVersions.get(id) || 0}`;
}

export function bumpArtVersion(id) {
  artVersions.set(id, (artVersions.get(id) || 0) + 1);
}

// 미리보기 <img>와 플레이스홀더를 받아 showArt(url) 함수를 돌려준다.
export function makeArtShower(artPreview, artPlaceholder) {
  return function showArt(url) {
    const stopSpin = showArtSpinner(artPreview.parentElement);
    artPreview.onerror = () => {
      stopSpin();
      artPreview.style.display = "none";
      artPlaceholder.style.display = "";
    };
    artPreview.onload = () => {
      stopSpin();
      artPreview.style.display = "";
      artPlaceholder.style.display = "none";
    };
    artPreview.src = url;
  };
}
