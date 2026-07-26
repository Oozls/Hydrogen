import { confirmDialog, alertDialog } from "./dialog.js";

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} 요청 실패 (${res.status})`);
  return res.json();
}

const treeEl = document.getElementById("files-tree");
const refreshBtn = document.getElementById("files-refresh-btn");

const contentDialog = document.getElementById("file-content-dialog");
const contentTitleEl = document.getElementById("file-content-title");
const contentBodyEl = document.getElementById("file-content-body");
const contentCloseBtn = document.getElementById("file-content-close");

const CHEVRON_RIGHT = "url(/static/icons/chevron-right.svg)";
const CHEVRON_DOWN = "url(/static/icons/chevron-down.svg)";
const TEXT_EXTENSIONS = new Set(["lrc", "json", "log"]);

function extOf(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

function isTextFile(name) {
  return TEXT_EXTENSIONS.has(extOf(name));
}

async function openContent(entry) {
  contentTitleEl.textContent = entry.name;
  contentBodyEl.textContent = "불러오는 중...";
  contentDialog.showModal();
  try {
    const data = await fetchJSON(`/api/files/content?path=${encodeURIComponent(entry.path)}`);
    contentBodyEl.textContent = data.content;
  } catch (err) {
    contentBodyEl.textContent = err.message;
  }
}

contentCloseBtn.addEventListener("click", () => contentDialog.close());

async function deleteEntry(entry, node) {
  const ok = await confirmDialog(`"${entry.name}" 파일을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`);
  if (!ok) return;
  try {
    await fetchJSON(`/api/files/entry?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
    node.remove();
  } catch (err) {
    await alertDialog(err.message);
  }
}

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
    row.classList.add("files-tree-row-clickable");
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

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "icon-btn files-tree-delete";
    deleteBtn.title = "삭제";
    const deleteIcon = document.createElement("span");
    deleteIcon.className = "icon icon-sm";
    deleteIcon.style.setProperty("--icon", "url(/static/icons/trash-2.svg)");
    deleteBtn.appendChild(deleteIcon);
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEntry(entry, node);
    });

    if (isTextFile(entry.name)) {
      row.classList.add("files-tree-row-clickable");
      row.addEventListener("click", () => openContent(entry));
    }

    row.append(toggle, icon, name, meta, deleteBtn);
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
