import { api } from "./api.js";
import { confirmDialog } from "./dialog.js";

// LyricTrack.current_index와 동일한 이진 탐색: timestamp_ms <= position인
// 마지막 줄의 인덱스를 반환, 없으면 -1.
function currentIndexForPosition(lines, positionMs) {
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timestamp_ms <= positionMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// 편집 UI 전용 표시 포맷("1:12:500" = 1분 12초 500밀리초). 저장 포맷(.lrc)과는 무관.
function formatMinSecMs(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}:${String(millis).padStart(3, "0")}`;
}

function parseMinSecMs(text) {
  const parts = (text || "").trim().split(":");
  if (parts.length !== 3) return null;
  const [minStr, secStr, msStr] = parts.map((p) => p.trim());
  if (![minStr, secStr, msStr].every((p) => /^\d+$/.test(p))) return null;
  return parseInt(minStr, 10) * 60_000 + parseInt(secStr, 10) * 1000 + parseInt(msStr, 10);
}

export function setupLyrics(player, onLyricsSaved) {
  const tabViewBtn = document.getElementById("tab-lyrics-view-btn");
  const tabEditBtn = document.getElementById("tab-lyrics-edit-btn");
  const viewPanel = document.getElementById("lyrics-view-panel");
  const editPanel = document.getElementById("lyrics-edit-panel");

  const viewList = document.getElementById("lyrics-view-list");

  const editScroll = document.getElementById("lyrics-edit-scroll");
  const editBody = document.getElementById("lyrics-edit-body");
  const addRowBtn = document.getElementById("btn-lyrics-add-row");
  const removeRowBtn = document.getElementById("btn-lyrics-remove-row");
  const clearBtn = document.getElementById("btn-lyrics-clear");

  let trackId = null;
  let lines = []; // {timestamp_ms, text, html}
  let lastHighlighted = -2;
  let selectedRow = null;

  // 편집 탭이 display:none인 동안엔 scrollHeight가 0으로 읽혀 textarea 높이가
  // 찌그러진 채로 고정된다. 탭이 실제로 보이게 된 "다음" 프레임에 전부 재측정한다.
  function regrowEditTextareas() {
    requestAnimationFrame(() => {
      editBody.querySelectorAll("textarea.lyrics-text-input").forEach((t) => {
        t.style.height = "auto";
        t.style.height = `${t.scrollHeight}px`;
      });
    });
  }

  function switchTab(which) {
    tabViewBtn.classList.toggle("active", which === "view");
    tabEditBtn.classList.toggle("active", which === "edit");
    viewPanel.classList.toggle("active", which === "view");
    editPanel.classList.toggle("active", which === "edit");
    if (which === "edit") regrowEditTextareas();
  }
  tabViewBtn.addEventListener("click", () => switchTab("view"));
  tabEditBtn.addEventListener("click", () => switchTab("edit"));
  window.addEventListener("resize", () => {
    if (editPanel.classList.contains("active")) regrowEditTextareas();
  });

  function renderView() {
    viewList.innerHTML = "";
    if (!lines.length) {
      const li = document.createElement("li");
      li.className = "lyrics-placeholder";
      li.textContent = "아직 가사가 없습니다. '가사 편집' 탭에서 추가해보세요.";
      viewList.appendChild(li);
      return;
    }
    for (const line of lines) {
      const li = document.createElement("li");
      li.className = "lyrics-line";
      li.innerHTML = line.html;
      li.addEventListener("click", () => player.seek(line.timestamp_ms));
      viewList.appendChild(li);
    }
    lastHighlighted = -2;
    applyHighlight(currentIndexForPosition(lines, player.position()));
  }

  function applyHighlight(idx) {
    if (!lines.length) return;
    const items = viewList.querySelectorAll(".lyrics-line");
    items.forEach((el, row) => el.classList.toggle("active", row === idx));
    if (idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  player.addEventListener("tick", (e) => {
    if (!lines.length) return;
    const idx = currentIndexForPosition(lines, e.detail.positionMs);
    if (idx === lastHighlighted) return;
    lastHighlighted = idx;
    applyHighlight(idx);
  });

  function selectRow(tr) {
    if (selectedRow) selectedRow.classList.remove("selected");
    selectedRow = tr;
    tr.classList.add("selected");
  }

  function renderEditRow(line) {
    const tr = document.createElement("tr");

    const timeTd = document.createElement("td");
    const timeInput = document.createElement("input");
    timeInput.type = "text";
    timeInput.className = "lyrics-time-input";
    timeInput.value = formatMinSecMs(line.timestamp_ms);
    timeInput.addEventListener("input", () => scheduleAutoSave(1800));
    timeInput.addEventListener("blur", () => flushSave());
    timeTd.appendChild(timeInput);

    const textTd = document.createElement("td");
    const textarea = document.createElement("textarea");
    textarea.className = "lyrics-text-input";
    textarea.value = line.text;
    textarea.rows = 1;
    textarea.addEventListener("input", () => scheduleAutoSave(1800));
    textarea.addEventListener("blur", () => flushSave());
    textTd.appendChild(textarea);

    tr.appendChild(timeTd);
    tr.appendChild(textTd);
    tr.addEventListener("click", () => selectRow(tr));

    // 행 높이가 늘어나며 편집 영역 스크롤이 튀지 않도록, 변경 직전 스크롤
    // 위치를 저장했다가 같은 틱에서 즉시 복원한다 (데스크톱 델리게이트와 동일 패턴).
    const grow = () => {
      const scrollTop = editScroll.scrollTop;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
      editScroll.scrollTop = scrollTop;
    };
    textarea.addEventListener("input", grow);

    return { tr, grow };
  }

  function renderEdit() {
    editBody.innerHTML = "";
    selectedRow = null;
    const rows = lines.map((line) => renderEditRow(line));
    for (const { tr } of rows) editBody.appendChild(tr);
    // 행이 전부 DOM에 붙고 테이블 열 너비/스크롤바가 확정된 "다음" 프레임에
    // 한 번에 높이를 재계산한다. 행을 하나씩 붙이면서 각자 높이를 바로 재는
    // 방식은, 뒤이어 붙는 행 때문에 스크롤바가 새로 생겨 열 너비가 좁아지는
    // 경우 앞선 행들의 높이가 좁아지기 "전" 너비 기준으로 낮게 고정되어(줄바꿈
    // 안 됨) 글자가 잘려 보이는 원인이 된다.
    requestAnimationFrame(() => {
      for (const { grow } of rows) grow();
    });
  }

  async function setTrack(track) {
    // 곡을 바꾸기 전, 이전 곡에 대해 대기 중이던 저장을 반드시 먼저 끝낸다.
    // 그렇지 않으면 디바운스 타이머가 나중에 엉뚱한(새) 트랙 상태에 대해
    // 발동하거나, 이전 트랙의 편집 내용이 그대로 유실된다.
    if (trackId !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await performSave();
    }
    trackId = track ? track.track_id : null;
    if (!trackId) {
      lines = [];
      renderView();
      renderEdit();
      return;
    }
    const data = await api.getLyrics(trackId);
    lines = data.lines;
    renderView();
    renderEdit();
  }

  player.addEventListener("trackchange", (e) => setTrack(e.detail.track));

  let autoSaveTimer = null;
  let saving = false;
  let saveAgainAfter = false;

  // 편집 중인 textarea/시간칸의 포커스·커서 위치가 날아가지 않도록, 저장은
  // 편집 테이블을 다시 그리지 않는다. 시간 형식이 잘못된 줄은 조용히 건너뛴다.
  async function performSave() {
    if (!trackId) return;
    if (saving) {
      saveAgainAfter = true;
      return;
    }
    saving = true;
    try {
      const rows = Array.from(editBody.querySelectorAll("tr"));
      const validLines = [];
      rows.forEach((tr) => {
        const timeText = tr.querySelector(".lyrics-time-input").value;
        const text = tr.querySelector(".lyrics-text-input").value.trim();
        if (!text) return;
        const ms = parseMinSecMs(timeText);
        if (ms === null) return;
        validLines.push({ timestamp_ms: ms, text });
      });

      validLines.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
      const result = await api.saveLyrics(trackId, validLines);
      lines = result.lines;
      renderView();
      if (onLyricsSaved) onLyricsSaved(trackId);
    } finally {
      saving = false;
      if (saveAgainAfter) {
        saveAgainAfter = false;
        performSave();
      }
    }
  }

  // 필드에 오래 머무르며 타이핑하는 경우를 대비한 배경 안전장치. 실제 저장은
  // 대부분 flushSave()(blur)가 즉시 처리하므로, 이 타이머는 만료 전에 다른 곳으로
  // 넘어가면 clearTimeout으로 취소되는 경우가 대부분이다.
  function scheduleAutoSave(delayMs = 600) {
    if (!trackId) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      performSave();
    }, delayMs);
  }

  function flushSave() {
    if (!trackId) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    performSave();
  }

  addRowBtn.addEventListener("click", () => {
    const { tr, grow } = renderEditRow({ timestamp_ms: 0, text: "" });
    editBody.appendChild(tr);
    selectRow(tr);
    tr.querySelector(".lyrics-text-input").focus();
    requestAnimationFrame(grow);
  });

  removeRowBtn.addEventListener("click", () => {
    if (selectedRow) {
      selectedRow.remove();
      selectedRow = null;
      clearTimeout(autoSaveTimer);
      performSave();
    }
  });

  // "저장" 버튼이 없어진 뒤로는 전체 지우기가 되돌릴 수 없는 작업이라 확인을 받는다.
  clearBtn.addEventListener("click", async () => {
    if (!(await confirmDialog("가사를 전체 삭제할까요? 이 작업은 되돌릴 수 없습니다."))) return;
    clearTimeout(autoSaveTimer);
    editBody.innerHTML = "";
    selectedRow = null;
    performSave();
  });

  // 탭을 닫거나 새로고침하는 순간의 마지막 안전장치(best-effort, 완료 보장은 없음).
  window.addEventListener("beforeunload", () => {
    clearTimeout(autoSaveTimer);
    performSave();
  });

  return { setTrack };
}
