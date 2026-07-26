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
  const sidebarEl = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  const backdrop = document.getElementById("sidebar-backdrop");
  const homeBtn = document.getElementById("btn-sidebar-browse");
  const listEl = document.getElementById("sidebar-playlist-list");
  const statsBtn = document.getElementById("btn-sidebar-stats");
  const dataSizeText = document.getElementById("sidebar-data-size-text");

  let names = bootstrap.playlist_names.slice();
  let activeName = null;

  // 화면이 좁아 사이드바가 왼쪽에서 슬라이드로 열리는 드로어일 때만 쓰인다
  // (넓은 화면에선 CSS가 토글 버튼/배경을 아예 숨기므로 무해하다). 메뉴에서
  // 뭔가 선택하면(재생목록/브라우즈/통계) 곧바로 닫아 콘텐츠를 보여준다.
  function closeDrawer() {
    sidebarEl.classList.remove("open");
    backdrop.classList.remove("open");
  }
  function toggleDrawer() {
    sidebarEl.classList.toggle("open");
    backdrop.classList.toggle("open");
  }
  toggleBtn.addEventListener("click", toggleDrawer);
  backdrop.addEventListener("click", closeDrawer);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1000) closeDrawer();
  });

  function render() {
    homeBtn.classList.toggle("active", activeName === null);
    statsBtn.classList.toggle("active", activeName === "__stats__");
    listEl.innerHTML = "";
    for (const name of names) {
      const li = document.createElement("li");
      li.className = "sidebar-playlist-row";
      if (name === activeName) li.classList.add("active");
      li.textContent = name;
      li.addEventListener("click", () => {
        onSelectPlaylist(name);
        closeDrawer();
      });
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

  homeBtn.addEventListener("click", () => {
    onGoBrowse();
    closeDrawer();
  });
  if (onGoStats) {
    statsBtn.addEventListener("click", () => {
      onGoStats();
      closeDrawer();
    });
  }

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
