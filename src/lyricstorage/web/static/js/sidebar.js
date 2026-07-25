import { api } from "./api.js";
import { fetchNonGlobalPlaylistNames } from "./playlistNames.js";

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function setupSidebar(bootstrap, { onSelectPlaylist, onGoBrowse, onGoStats }) {
  const homeBtn = document.getElementById("btn-sidebar-browse");
  const listEl = document.getElementById("sidebar-playlist-list");
  const statsBtn = document.getElementById("btn-sidebar-stats");
  const dataSizeText = document.getElementById("sidebar-data-size-text");

  let names = bootstrap.playlist_names.slice();
  let activeName = null;

  function render() {
    homeBtn.classList.toggle("active", activeName === null);
    statsBtn.classList.toggle("active", activeName === "__stats__");
    listEl.innerHTML = "";
    for (const name of names) {
      const li = document.createElement("li");
      li.className = "sidebar-playlist-row";
      if (name === activeName) li.classList.add("active");
      li.textContent = name;
      li.addEventListener("click", () => onSelectPlaylist(name));
      listEl.appendChild(li);
    }
  }

  async function refreshDataSize() {
    try {
      const result = await api.getDataSize();
      dataSizeText.textContent = fmtBytes(result.bytes);
    } catch (_err) {
      dataSizeText.textContent = "-";
    }
  }

  homeBtn.addEventListener("click", () => onGoBrowse());
  if (onGoStats) statsBtn.addEventListener("click", () => onGoStats());

  render();
  refreshDataSize();

  return {
    async refreshNames() {
      names = await fetchNonGlobalPlaylistNames();
      render();
      return names;
    },
    setActive(nameOrNull) {
      activeName = nameOrNull;
      render();
    },
    getNames: () => names,
    refreshDataSize,
  };
}
