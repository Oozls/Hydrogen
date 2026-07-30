import { confirmDialog, alertDialog } from "./dialog.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";

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
const contentSaveBtn = document.getElementById("file-content-save");

let openEntry = null;

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
  openEntry = entry;
  contentTitleEl.textContent = entry.name;
  contentBodyEl.value = "불러오는 중...";
  contentBodyEl.disabled = true;
  contentSaveBtn.disabled = true;
  contentDialog.showModal();
  try {
    const data = await fetchJSON(`/api/files/content?path=${encodeURIComponent(entry.path)}`);
    contentBodyEl.value = data.content;
    contentBodyEl.disabled = false;
    contentSaveBtn.disabled = false;
  } catch (err) {
    contentBodyEl.value = err.message;
  }
}

contentCloseBtn.addEventListener("click", () => contentDialog.close());

contentSaveBtn.addEventListener("click", async () => {
  if (!openEntry) return;
  contentSaveBtn.disabled = true;
  try {
    await fetchJSON(`/api/files/content?path=${encodeURIComponent(openEntry.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: contentBodyEl.value }),
    });
  } catch (err) {
    await alertDialog(err.message);
  } finally {
    contentSaveBtn.disabled = false;
  }
});

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

function formatDate(iso) {
  return iso ? iso.replace("T", " ") : "";
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

  const name = createMarqueeClip("files-tree-name", "", entry.name);

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
      // 접혀 있는 동안엔 폭이 0이라 마퀴가 실제로 넘치는지 정확히 잴 수 없다
      // (숨김 상태에서 미리 계산해두면 항상 "넘침"으로 잘못 판단한다). 펼칠
      // 때마다 그 시점의 실제 폭으로 다시 계산한다.
      if (expanded) requestAnimationFrame(() => applyMarquee(childrenWrap));
    });

    row.append(toggle, icon, name, meta);
    node.append(row, childrenWrap);
  } else {
    icon.style.setProperty("--icon", "url(/static/icons/music.svg)");
    const metaParts = [formatSize(entry.size || 0)];
    if (entry.created) metaParts.push(formatDate(entry.created));
    meta.textContent = metaParts.join(" · ");

    let titleSpan = null;
    if (entry.title) {
      name.classList.add("files-tree-name-fixed");
      titleSpan = document.createElement("span");
      titleSpan.className = "files-tree-title";
      titleSpan.textContent = `— ${entry.title}`;
    }

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

    row.append(toggle, icon, name);
    if (titleSpan) row.appendChild(titleSpan);
    row.append(meta, deleteBtn);
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
    requestAnimationFrame(() => applyMarquee(treeEl));
  } catch (err) {
    renderMessage(err.message);
  }
}

refreshBtn.addEventListener("click", load);

let marqueeResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(marqueeResizeTimer);
  marqueeResizeTimer = setTimeout(() => applyMarquee(treeEl), 150);
});

load();
