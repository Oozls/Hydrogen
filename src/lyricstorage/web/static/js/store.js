import { api } from "./api.js";

// 라이브러리 전체(곡/앨범/곡 아티스트/서클) 캐시 하나를 앱 전체가 공유한다.
// 예전엔 browse.js/stats.js/playlist.js(라이브러리에서 추가 피커)가 각자
// api.getLibrary() 등을 따로 불러 자기 모듈 안에 사본을 들고 있었다 — 그 결과
// (1) 브라우즈 화면에 들어갈 때마다 이미 불러온 데이터를 매번 다시 fetch했고
// (그 fetch가 끝나기 전까지 엉뚱한 탭이 보이는 버그의 원인이었다), (2) 한
// 화면에서 곡/앨범을 고치면 다른 화면들에도 일일이 "이것도 갱신해줘" 콜백을
// 손으로 연결해야 했다. 이 모듈이 fetch를 한 곳으로 모으고, 구독자에게
// 변경을 알린다.
const state = {
  tracks: [],
  albums: [],
  artists: [],
  circles: [],
  libraryName: null,
  loaded: false,
};

const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(state);
}

let inFlight = null;

// 이미 refresh가 진행 중이면 새로 또 fetch하지 않고 같은 결과를 같이 기다린다
// — 여러 화면이 동시에(예: 앱 시작 직후 store.refresh()와 첫 라우팅 진입이
// 겹칠 때) refresh를 부르는 경우를 대비.
function refresh() {
  if (inFlight) return inFlight;
  inFlight = Promise.all([api.getLibrary(), api.getAlbums(), api.getArtists(), api.getCircles()])
    .then(([library, albumsResult, artistsResult, circlesResult]) => {
      state.tracks = library.tracks;
      state.libraryName = library.name;
      state.albums = albumsResult.albums;
      state.artists = artistsResult.artists;
      state.circles = circlesResult.circles;
      state.loaded = true;
      notify();
      return state;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// fn(state)를 등록해두면 refresh()가 끝날 때마다 호출된다. 반환값은 구독 해제 함수.
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 화면 진입 시 "데이터를 보여줘야 하는데 fetch를 기다려야 하나?"에 대한 공용
// 답. 이미 한 번이라도 불러온 적 있으면(흔한 경우) 지금 있는 캐시를 바로 쓰고
// 새로고침은 배경에서만 돈다 — 화면은 fetch를 기다리지 않고 즉시 그려진다.
// 아직 한 번도 못 불러왔으면(세션 첫 진입) 보여줄 데이터 자체가 없으니 이번만
// 기다린다.
function ensureLoaded() {
  if (state.loaded) {
    refresh();
    return Promise.resolve(state);
  }
  return refresh();
}

export const store = {
  refresh,
  ensureLoaded,
  subscribe,
  getTracks: () => state.tracks,
  getAlbums: () => state.albums,
  getArtists: () => state.artists,
  getCircles: () => state.circles,
  getLibraryName: () => state.libraryName,
  isLoaded: () => state.loaded,
};
