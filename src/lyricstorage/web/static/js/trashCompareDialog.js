import { api } from "./api.js";
import { fmtDuration, fmtBytes } from "./formatters.js";

// 휴지통(data/trash)에 있는 파일을 현재 라이브러리에 남아있는 대응 곡과 나란히
// 놓고 들어볼 수 있는 다이얼로그. 재작성이 자동으로 확정한 중복 정리가 맞는지
// 사용자가 언제든 다시 확인하고 싶을 때 연다(재작성 직후가 아니어도 됨).
export function setupTrashCompareDialog() {
  const dialogEl = document.getElementById("trash-compare-dialog");
  const closeBtn = document.getElementById("trash-compare-close");
  const listEl = document.getElementById("trash-compare-list");

  closeBtn.addEventListener("click", () => dialogEl.close());

  function buildFileCol(file, label) {
    const col = document.createElement("div");
    col.className = "trash-compare-col";

    const badge = document.createElement("div");
    badge.className = "trash-compare-col-label";
    badge.textContent = label;
    col.appendChild(badge);

    if (!file) {
      const empty = document.createElement("div");
      empty.className = "trash-compare-empty";
      empty.textContent = "대응하는 곡을 찾지 못했습니다.";
      col.appendChild(empty);
      return col;
    }

    const meta = document.createElement("div");
    meta.className = "rebuild-dup-file-meta";
    meta.textContent = `${file.filename} · ${fmtDuration(file.duration_ms)} · ${fmtBytes(file.size_bytes)}`;
    col.appendChild(meta);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = api.songFileAudioUrl(file.filename);
    col.appendChild(audio);

    return col;
  }

  function buildItem(item) {
    const card = document.createElement("div");
    card.className = "rebuild-dup-group";

    const title = document.createElement("div");
    title.className = "rebuild-dup-title";
    title.textContent = item.trash_file.title || "(제목 없음)";

    const meta = document.createElement("div");
    meta.className = "rebuild-dup-meta";
    meta.textContent = [
      item.kept_file && item.kept_file.circle,
      item.trash_file.album,
      item.trash_file.artist,
    ]
      .filter(Boolean)
      .join(" · ");

    const cols = document.createElement("div");
    cols.className = "trash-compare-cols";
    cols.appendChild(buildFileCol(item.kept_file, "현재 라이브러리"));
    cols.appendChild(buildFileCol(item.trash_file, "휴지통"));

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(cols);
    return card;
  }

  async function open() {
    listEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "list-loading";
    loading.textContent = "불러오는 중...";
    listEl.appendChild(loading);
    dialogEl.showModal();

    try {
      const { items } = await api.getTrashComparisons();
      listEl.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "playlist-empty-state";
        empty.textContent = "휴지통이 비어 있습니다.";
        listEl.appendChild(empty);
        return;
      }
      items.forEach((item) => listEl.appendChild(buildItem(item)));
    } catch (err) {
      listEl.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "playlist-empty-state";
      errorEl.textContent = err.message;
      listEl.appendChild(errorEl);
    }
  }

  return { open };
}
