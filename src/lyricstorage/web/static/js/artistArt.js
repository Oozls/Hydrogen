import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { showArtSpinner } from "./artspinner.js";

// 같은 앨범 집합에 대한 무작위 선택을 화면 진입 동안 고정해 둔다. 브라우즈는
// 캐시로 먼저 그린 뒤 배경 새로고침이 끝나면 다시 그리는데, 그때마다 커버를 새로
// 뽑으면 방금 보인 커버가 다른 것으로 바뀌어 "두 번 로드"처럼 보인다.
// 키는 앨범 id 집합이라 라이브러리가 실제로 바뀐 아티스트만 새로 뽑힌다.
const pickCache = new Map();

// 화면에 새로 들어올 때 호출해 이번 진입에서 새 무작위 커버를 뽑게 한다.
export function resetArtistArtPicks() {
  pickCache.clear();
}

function pickRandomAlbums(list, n) {
  const src = list || [];
  const key = src.map((a) => a.id).sort().join("|") + `#${n}`;
  const cached = pickCache.get(key);
  if (cached) {
    const byId = new Map(src.map((a) => [a.id, a]));
    return cached.map((id) => byId.get(id));
  }
  const copy = src.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  const picked = copy.slice(0, n);
  pickCache.set(key, picked.map((a) => a.id));
  return picked;
}

// artWrap(.media-card-art-wrap, 이미 만들어진 빈 컨테이너)에 아티스트의 앨범 커버
// 콜라주를 채워 넣는다. 앨범이 1개면 커버 전체를 꽉 채우고, 2개는 좌우 반반,
// 3개는 위 두 칸(좌/우) + 아래 한 칸(전체 폭), 4개는 2x2 사분면 — 그보다 적으면
// 빈 칸으로 남긴다. 브라우즈 아티스트 탭과 재생 통계 아티스트 탭이 공유한다.
export function fillArtistArt(artWrap, albumsForArtist) {
  const covers = pickRandomAlbums(albumsForArtist, 4);
  if (!covers.length) {
    artWrap.appendChild(iconSpan("music", "icon-lg"));
    return;
  }
  if (covers.length === 1) {
    const stopSpin = showArtSpinner(artWrap);
    const img = document.createElement("img");
    img.className = "media-card-art";
    img.alt = "";
    img.loading = "lazy";
    img.src = api.albumArtUrl(covers[0].id);
    img.onload = () => stopSpin();
    img.onerror = () => {
      stopSpin();
      img.remove();
      artWrap.appendChild(iconSpan("music", "icon-lg"));
    };
    artWrap.appendChild(img);
    return;
  }

  const grid = document.createElement("div");
  grid.className = `artist-card-art-grid count-${covers.length}`;
  covers.forEach((album) => {
    const cell = document.createElement("div");
    cell.className = "artist-card-art-cell";
    const stopSpin = showArtSpinner(cell);
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = api.albumArtUrl(album.id);
    img.onload = () => stopSpin();
    img.onerror = () => {
      stopSpin();
      img.remove();
    };
    cell.appendChild(img);
    grid.appendChild(cell);
  });
  artWrap.appendChild(grid);
}
