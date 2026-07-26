async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 요청 실패 (${res.status})`);
  return res.json();
}

const treeEl = document.getElementById("files-tree");
const refreshBtn = document.getElementById("files-refresh-btn");

const CHEVRON_RIGHT = "url(/static/icons/chevron-right.svg)";
const CHEVRON_DOWN = "url(/static/icons/chevron-down.svg)";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function renderMessage(message) {
  treeEl.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "logs-empty";
  empty.textContent = message;
  treeEl.appendChild(empty);
}

function buildNode(entry, depth) {
  const node = document.createElement("div");
  node.className = "files-tree-node";

  const row = document.createElement("div");
  row.className = "files-tree-row";
  row.style.paddingLeft = `${depth * 18 + 10}px`;

  // 파일 행은 폴더 행과 들여쓰기를 맞추기 위한 빈 자리표시자일 뿐이라 "icon" 클래스를
  // 넣지 않는다(넣으면 --icon이 없는 채로 background-color만 적용돼 회색 사각형이 됨).
  const toggle = document.createElement("span");
  toggle.className = "icon-sm files-tree-toggle";

  const icon = document.createElement("span");
  icon.className = "icon icon-sm";

  const name = document.createElement("span");
  name.className = "files-tree-name";
  name.textContent = entry.name;

  const meta = document.createElement("span");
  meta.className = "files-tree-meta";

  if (entry.type === "dir") {
    icon.style.setProperty("--icon", "url(/static/icons/folder.svg)");
    meta.textContent = `${entry.children.length}개 항목`;

    const childrenWrap = document.createElement("div");
    childrenWrap.className = "files-tree-children";

    toggle.classList.add("icon");
    let expanded = depth === 0;
    toggle.style.setProperty("--icon", expanded ? CHEVRON_DOWN : CHEVRON_RIGHT);
    childrenWrap.hidden = !expanded;

    entry.children.forEach((child) => childrenWrap.appendChild(buildNode(child, depth + 1)));

    row.addEventListener("click", () => {
      expanded = !expanded;
      childrenWrap.hidden = !expanded;
      toggle.style.setProperty("--icon", expanded ? CHEVRON_DOWN : CHEVRON_RIGHT);
    });

    row.append(toggle, icon, name, meta);
    node.append(row, childrenWrap);
  } else {
    icon.style.setProperty("--icon", "url(/static/icons/music.svg)");
    meta.textContent = formatSize(entry.size || 0);
    row.append(toggle, icon, name, meta);
    node.append(row);
  }

  return node;
}

async function load() {
  renderMessage("불러오는 중...");
  try {
    const root = await fetchJSON("/api/files/tree");
    if (!root.children.length) {
      renderMessage("data 폴더가 비어 있습니다.");
      return;
    }
    treeEl.innerHTML = "";
    root.children.forEach((entry) => treeEl.appendChild(buildNode(entry, 0)));
  } catch (err) {
    renderMessage(err.message);
  }
}

refreshBtn.addEventListener("click", load);

load();
