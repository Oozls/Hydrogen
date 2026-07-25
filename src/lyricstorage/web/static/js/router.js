function parseRoute(hash) {
  const raw = (hash || "").replace(/^#\/?/, "");
  if (raw.startsWith("playlist/")) {
    const name = decodeURIComponent(raw.slice("playlist/".length));
    if (name) return { type: "playlist", name };
  }
  if (raw === "stats") return { type: "stats" };
  return { type: "browse" };
}

export function setupRouter({ onBrowse, onPlaylist, onStats }) {
  function dispatch() {
    const route = parseRoute(location.hash);
    if (route.type === "playlist") onPlaylist(route.name);
    else if (route.type === "stats") onStats();
    else onBrowse();
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
    goBrowse() {
      navigate("#/browse");
    },
    goPlaylist(name) {
      navigate(`#/playlist/${encodeURIComponent(name)}`);
    },
    goStats() {
      navigate("#/stats");
    },
  };
}
