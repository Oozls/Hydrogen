import { fetchNonGlobalPlaylistNames } from "./playlistNames.js";

// 곡 행 "⋮" 버튼 클릭 시 마우스 위치에 뜨는 컨텍스트 메뉴. 브라우즈/재생목록/
// 앨범 상세 목록 등 곡 행이 있는 모든 화면에서 공용으로 사용한다.
// document.body에 한 번만 붙는 단일 DOM 요소를 재사용하며, 열려있는 동안만
// 바깥 클릭/Escape/스크롤/리사이즈 리스너를 부착했다가 닫힐 때 정리한다.
export function setupRowContextMenu({ onEditTrack, onAddToPlaylist, onBulkEdit, getSelectedIds }) {
  const menu = document.createElement("div");
  menu.id = "row-context-menu";
  menu.className = "row-context-menu";
  menu.hidden = true;
  document.body.appendChild(menu);

  let bound = false;

  function onOutsideClick(e) {
    if (!menu.contains(e.target)) close();
  }
  function onKeyDown(e) {
    if (e.key === "Escape") close();
  }
  function onScrollOrResize() {
    close();
  }

  function bindGlobalListeners() {
    if (bound) return;
    bound = true;
    // 메뉴를 연 클릭 자체가 곧바로 "바깥 클릭"으로 잡혀 닫히지 않도록 한 틱 늦춰 부착한다.
    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
  }

  function unbindGlobalListeners() {
    if (!bound) return;
    bound = false;
    document.removeEventListener("click", onOutsideClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }

  function close() {
    menu.hidden = true;
    menu.innerHTML = "";
    unbindGlobalListeners();
  }

  function makeItem(label, handler, disabled = false) {
    const item = document.createElement("div");
    item.className = "context-menu-item" + (disabled ? " disabled" : "");
    item.textContent = label;
    if (!disabled && handler) item.addEventListener("click", handler);
    return item;
  }

  function position(x, y) {
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.min(Math.max(4, x), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(4, y), maxTop)}px`;
  }

  function renderRoot(track, x, y) {
    menu.innerHTML = "";
    menu.appendChild(
      makeItem("곡 정보 수정", () => {
        close();
        onEditTrack(track);
      })
    );
    // 여러 곡을 선택한 상태에서만 활성화 — 한 곡 이하 선택 시엔 위 "곡 정보 수정"으로 충분하다.
    const selectedIds = getSelectedIds ? getSelectedIds() : new Set();
    menu.appendChild(
      makeItem(
        "일괄 수정",
        () => {
          close();
          onBulkEdit(Array.from(selectedIds));
        },
        selectedIds.size < 2
      )
    );
    menu.appendChild(makeItem("재생목록에 추가 ▸", () => renderPlaylistSubmenu(track, x, y)));
    position(x, y);
  }

  async function renderPlaylistSubmenu(track, x, y) {
    menu.innerHTML = "";
    menu.appendChild(makeItem("◂ 뒤로", () => renderRoot(track, x, y)));
    const names = await fetchNonGlobalPlaylistNames();
    if (!names.length) {
      menu.appendChild(makeItem("플레이리스트 없음", null, true));
    } else {
      for (const name of names) {
        menu.appendChild(
          makeItem(name, () => {
            close();
            onAddToPlaylist(track, name);
          })
        );
      }
    }
    position(x, y);
  }

  return {
    open(track, x, y) {
      menu.hidden = false;
      renderRoot(track, x, y);
      bindGlobalListeners();
    },
  };
}
