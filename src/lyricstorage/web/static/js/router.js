function parseRoute(hash) {
  const raw = (hash || "").replace(/^#\/?/, "");
  if (raw.startsWith("playlist/")) {
    const name = decodeURIComponent(raw.slice("playlist/".length));
    if (name) return { type: "playlist", name };
  }
  if (raw === "stats") return { type: "stats" };
  if (raw === "today") return { type: "today" };
  if (raw === "browse") return { type: "browse" };
  return { type: "home" };
}

export function setupRouter({ onHome, onBrowse, onPlaylist, onStats, onToday }) {
  function dispatch() {
    const route = parseRoute(location.hash);
    if (route.type === "playlist") onPlaylist(route.name);
    else if (route.type === "stats") onStats();
    else if (route.type === "today") onToday();
    else if (route.type === "browse") onBrowse();
    else onHome();
  }

  function navigate(hash) {
    if (location.hash === hash) {
      dispatch();
      return;
    }
    location.hash = hash;
  }

  window.addEventListener("hashchange", dispatch);
  dispatch();

  return {
    goHome() {
      navigate("#/home");
    },
    goBrowse() {
      navigate("#/browse");
    },
    goPlaylist(name) {
      navigate(`#/playlist/${encodeURIComponent(name)}`);
    },
    goStats() {
      navigate("#/stats");
    },
    goToday() {
      navigate("#/today");
    },
  };
}
