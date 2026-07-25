import { fetchNonGlobalPlaylistNames } from "./playlistNames.js";

export function setupSidebar(bootstrap, { onSelectPlaylist, onGoBrowse }) {
  const homeBtn = document.getElementById("btn-sidebar-browse");
  const listEl = document.getElementById("sidebar-playlist-list");

  let names = bootstrap.playlist_names.slice();
  let activeName = null;

  function render() {
    homeBtn.classList.toggle("active", activeName === null);
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

  homeBtn.addEventListener("click", () => onGoBrowse());

  render();

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
  };
}
