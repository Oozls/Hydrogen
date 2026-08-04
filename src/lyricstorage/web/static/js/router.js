// 경로 기반(pushState) 라우터. 화면마다(브라우즈의 각 탭/상세 포함) 실제 주소가
// 대응되도록, 해시(#) 없이 History API로 주소창을 직접 바꾼다. 새로고침/직접
// 접속해도 같은 화면이 열려야 하므로, 서버(pages.py)도 이 경로들을 전부
// index.html로 돌려주는 폴백 라우트를 갖고 있어야 한다.
function parseRoute(pathname, search) {
  const raw = pathname.replace(/^\/+|\/+$/g, "");
  const params = new URLSearchParams(search);

  if (raw === "") return { type: "home" };
  if (raw.startsWith("playlist/")) {
    const name = decodeURIComponent(raw.slice("playlist/".length));
    if (name) return { type: "playlist", name };
  }
  if (raw === "stats") return { type: "stats" };
  if (raw === "today") return { type: "today" };
  if (raw === "browse" || raw.startsWith("browse/")) {
    const rest = raw === "browse" ? "" : raw.slice("browse/".length);
    if (rest === "" || rest === "artists") return { type: "browse", mode: "artist" };
    if (rest === "song-artists") return { type: "browse", mode: "song-artist" };
    if (rest.startsWith("song-artists/")) {
      const name = decodeURIComponent(rest.slice("song-artists/".length));
      if (name) return { type: "browse", mode: "song-artist", songArtistName: name };
    }
    if (rest === "albums") return { type: "browse", mode: "album", artistFilter: params.get("artist") || null };
    if (rest.startsWith("albums/")) {
      const id = decodeURIComponent(rest.slice("albums/".length));
      if (id) return { type: "browse", mode: "album", albumId: id };
    }
    if (rest === "songs") return { type: "browse", mode: "song" };
    return { type: "browse", mode: "artist" };
  }
  return { type: "home" };
}

function currentPath() {
  return location.pathname + location.search;
}

export function setupRouter({ onHome, onBrowse, onPlaylist, onStats, onToday }) {
  function dispatch() {
    const route = parseRoute(location.pathname, location.search);
    if (route.type === "playlist") onPlaylist(route.name);
    else if (route.type === "stats") onStats();
    else if (route.type === "today") onToday();
    else if (route.type === "browse") onBrowse(route);
    else onHome();
  }

  function navigate(path, { replace = false } = {}) {
    if (currentPath() === path) {
      dispatch();
      return;
    }
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    dispatch();
  }

  window.addEventListener("popstate", dispatch);
  dispatch();

  return {
    goHome() {
      navigate("/");
    },
    goBrowse() {
      navigate("/browse/artists");
    },
    goBrowseSongs() {
      navigate("/browse/songs");
    },
    goBrowseSongArtists() {
      navigate("/browse/song-artists");
    },
    goBrowseAlbums(artistFilter) {
      navigate(artistFilter ? `/browse/albums?artist=${encodeURIComponent(artistFilter)}` : "/browse/albums");
    },
    goAlbumDetail(albumId) {
      navigate(`/browse/albums/${encodeURIComponent(albumId)}`);
    },
    goSongArtistDetail(name) {
      navigate(`/browse/song-artists/${encodeURIComponent(name)}`);
    },
    goPlaylist(name) {
      navigate(`/playlist/${encodeURIComponent(name)}`);
    },
    goStats() {
      navigate("/stats");
    },
    goToday() {
      navigate("/today");
    },
    // 탭 전환/상세 열기·닫기처럼 화면이 자체적으로 상태를 바꿀 때, 주소창만 그
    // 상태에 맞게 조용히 갱신한다(히스토리 항목을 새로 쌓지 않고 dispatch도
    // 다시 부르지 않는다 — 그러지 않으면 상태 변경 → dispatch → 같은 상태 변경을
    // 다시 트리거하는 무한 루프가 생긴다).
    setUrl(path) {
      if (currentPath() !== path) history.replaceState(null, "", path);
    },
  };
}
