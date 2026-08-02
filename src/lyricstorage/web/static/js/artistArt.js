import { api } from "./api.js";
import { iconSpan } from "./icons.js";
import { showArtSpinner } from "./artspinner.js";

export function pickRandomAlbums(list, n) {
  const copy = (list || []).slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
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
