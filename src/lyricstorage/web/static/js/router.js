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
  if (raw === "stats" || raw.startsWith("stats/")) {
    const rest = raw === "stats" ? "" : raw.slice("stats/".length);
    const [period, group] = rest.split("/").filter(Boolean);
    return { type: "stats", period: period || null, group: group || null };
  }
  if (raw === "today") return { type: "today" };
  if (raw === "match") return { type: "match" };
  if (raw === "browse" || raw.startsWith("browse/")) {
    const rest = raw === "browse" ? "" : raw.slice("browse/".length);
    // URL은 화면에 보이는 이름(서클/아티스트)을 그대로 따르지만, 내부 mode
    // 값은 예전 이름("artist"=서클 탭, "song-artist"=아티스트 탭)을 그대로
    // 쓴다 — browse.js 전체에 흩어진 mode 비교를 다 바꾸는 대신 이 경계에서만
    // URL 이름과 내부 이름을 잇는다.
    if (rest === "" || rest === "circles") return { type: "browse", mode: "artist" };
    if (rest === "artists") return { type: "browse", mode: "song-artist" };
    if (rest.startsWith("artists/")) {
      const name = decodeURIComponent(rest.slice("artists/".length));
      if (name) return { type: "browse", mode: "song-artist", songArtistName: name };
    }
    if (rest === "albums") return { type: "browse", mode: "album", artistFilter: params.get("circle") || null };
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

export function setupRouter({ onHome, onBrowse, onPlaylist, onStats, onToday, onMatch }) {
  function dispatch() {
    const route = parseRoute(location.pathname, location.search);
    if (route.type === "playlist") onPlaylist(route.name);
    else if (route.type === "stats") onStats(route);
    else if (route.type === "today") onToday();
    else if (route.type === "match") onMatch();
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
  // setupRouter()가 반환되기 전에 dispatch()를 바로 부르면, onBrowse/onStats
  // 콜백 안에서 쓰는 refs.router(main.js가 setupRouter의 반환값을 받아 대입하는
  // 시점은 이 함수가 "리턴한 뒤"라 아직 null)가 첫 진입(새로고침으로 바로 들어온
  // 딥링크) 때만 비어 있어, 그 안의 주소창 보정(setUrl) 호출이 조용히 무시된다.
  // 마이크로태스크로 한 틱 미루면 대입이 먼저 끝난 뒤 실행돼 항상 refs.router가
  // 채워져 있다.
  queueMicrotask(dispatch);

  return {
    goHome() {
      navigate("/");
    },
    goBrowse() {
      navigate("/browse/circles");
    },
    goBrowseSongs() {
      navigate("/browse/songs");
    },
    goBrowseArtists() {
      navigate("/browse/artists");
    },
    goBrowseAlbums(circleFilter) {
      navigate(circleFilter ? `/browse/albums?circle=${encodeURIComponent(circleFilter)}` : "/browse/albums");
    },
    goAlbumDetail(albumId) {
      navigate(`/browse/albums/${encodeURIComponent(albumId)}`);
    },
    goSongArtistDetail(name) {
      navigate(`/browse/artists/${encodeURIComponent(name)}`);
    },
    goPlaylist(name) {
      navigate(`/playlist/${encodeURIComponent(name)}`);
    },
    goStats(period, group) {
      navigate(period && group ? `/stats/${period}/${group}` : "/stats");
    },
    goToday() {
      navigate("/today");
    },
    goMatch() {
      navigate("/match");
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
