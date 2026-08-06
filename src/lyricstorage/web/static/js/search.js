import { store } from "./store.js";
import { splitArtists, buildArtistNameResolver } from "./songArtist.js";

// store.js의 캐시 위에서 곡/앨범/서클/곡아티스트 네 종류를 한 번에 훑는 통합
// 검색. 브라우즈 화면의 탭별 검색(browse.js)은 "지금 보고 있는 탭 안에서 좁혀
// 찾기"용으로 그대로 남겨두고, 이건 어느 탭에 있든 이름 하나로 네 종류를
// 가로질러 찾을 수 있는 별도 진입점(사이드바)이다.
const RESULT_LIMIT = 8;

export function searchAll(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return { tracks: [], albums: [], circles: [], songArtists: [] };

  const tracks = store.getTracks();
  const albums = store.getAlbums();

  const tracksMatch = tracks.filter((t) => (t.title || "").toLowerCase().includes(q)).slice(0, RESULT_LIMIT);
  const albumsMatch = albums.filter((a) => (a.name || "").toLowerCase().includes(q)).slice(0, RESULT_LIMIT);

  // 서클(앨범 아티스트)/곡 아티스트는 이명 레지스트리로 대표 이름을 구해서
  // 이름 단위로 중복 없이 모은다 — 브라우즈의 아티스트/곡아티스트 탭과 동일한 기준.
  const resolveCircle = buildArtistNameResolver(store.getCircles());
  const circleNames = new Set();
  for (const album of albums) {
    const name = resolveCircle(album.artist || "");
    if (name) circleNames.add(name);
  }
  const circlesMatch = [...circleNames]
    .filter((name) => name.toLowerCase().includes(q))
    .slice(0, RESULT_LIMIT);

  const resolveSongArtist = buildArtistNameResolver(store.getArtists());
  const songArtistNames = new Set();
  for (const track of tracks) {
    for (const raw of splitArtists(track.artist)) {
      const name = resolveSongArtist(raw);
      if (name) songArtistNames.add(name);
    }
  }
  const songArtistsMatch = [...songArtistNames]
    .filter((name) => name.toLowerCase().includes(q))
    .slice(0, RESULT_LIMIT);

  return { tracks: tracksMatch, albums: albumsMatch, circles: circlesMatch, songArtists: songArtistsMatch };
}
