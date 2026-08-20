import { api } from "./api.js";
import { confirmDialog, alertDialog } from "./dialog.js";
import { setupLyricsEditor } from "./lyricsEditor.js";

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

// 텍스트(.lrc) 편집 모드 전용 변환. 저장 포맷과 동일한 [mm:ss.xx] 규칙을 그대로
// 써서, 여기서 만든 텍스트를 파일 탐색기에서 본 실제 .lrc 파일과 그대로 맞바꿀 수 있게 한다.
function formatLrcTimestamp(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centis = Math.floor((ms % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function linesToLrcText(list) {
  return list.map((l) => `[${formatLrcTimestamp(l.timestamp_ms)}]${l.text.replace(/\n/g, "\\n")}`).join("\n");
}

const LRC_LINE_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,2}))?\](.*)$/;

function parseLrcText(text) {
  const result = [];
  for (const raw of text.split("\n")) {
    const match = LRC_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const [, minStr, secStr, fracStr, content] = match;
    let ms = parseInt(minStr, 10) * 60_000 + parseInt(secStr, 10) * 1000;
    if (fracStr) ms += parseInt(fracStr.padEnd(2, "0").slice(0, 2), 10) * 10;
    const lineText = content.trim().replace(/\\n/g, "\n");
    if (!lineText) continue;
    result.push({ timestamp_ms: ms, text: lineText });
  }
  result.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return result;
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
  const detailEditBtn = document.getElementById("btn-lyrics-detail-edit");

  const backupsBtn = document.getElementById("btn-lyrics-backups");
  const backupsDialog = document.getElementById("lyrics-backups-dialog");
  const backupsCloseBtn = document.getElementById("lyrics-backups-close");
  const backupsListView = document.getElementById("lyrics-backups-list-view");
  const backupsListEl = document.getElementById("lyrics-backups-list");
  const backupsEmptyEl = document.getElementById("lyrics-backups-empty");
  const backupsPreviewView = document.getElementById("lyrics-backups-preview");
  const backupsPreviewBody = document.getElementById("lyrics-backups-preview-body");
  const backupsPreviewBackBtn = document.getElementById("lyrics-backups-preview-back");
  const backupsRestoreBtn = document.getElementById("lyrics-backups-restore");

  const textModeBtn = document.getElementById("btn-lyrics-text-mode");
  const textArea = document.getElementById("lyrics-edit-text-area");

  const helpBtn = document.getElementById("btn-lyrics-help");
  const helpDialog = document.getElementById("lyrics-format-help-dialog");
  const helpCloseBtn = document.getElementById("lyrics-format-help-close");
  const syncOffsetMinusBtn = document.getElementById("btn-lyrics-sync-offset-minus");
  const syncOffsetPlusBtn = document.getElementById("btn-lyrics-sync-offset-plus");
  const syncOffsetValueEl = document.getElementById("lyrics-sync-offset-value");

  const lyricsEditorApi = setupLyricsEditor(player);

  let trackId = null;
  let trackLabel = "";
  let lines = []; // {timestamp_ms, text, html}
  let lastHighlighted = -2;
  let selectedRow = null;
  let textModeOn = false;

  const SYNC_OFFSET_STEP_MS = 50;
  const SYNC_OFFSET_MAX_MS = 2000;
  let syncOffsetMs = 0; // 재생 위치 하이라이트 계산에만 쓰이는 세션 한정 보정값. 저장되지 않는다.

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

  // 보기/편집 패널은 서로 배타적으로 표시한다. 패널 폭은 탭과 무관하게 항상 동일하다.
  function switchTab(which) {
    tabViewBtn.classList.toggle("active", which === "view");
    tabEditBtn.classList.toggle("active", which === "edit");
    viewPanel.classList.toggle("active", which === "view");
    editPanel.classList.toggle("active", which === "edit");
    if (which === "edit") regrowEditTextareas();
  }
  tabViewBtn.addEventListener("click", () => switchTab("view"));
  tabEditBtn.addEventListener("click", () => switchTab("edit"));
  helpBtn.addEventListener("click", () => helpDialog.showModal());
  helpCloseBtn.addEventListener("click", () => helpDialog.close());
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
    applyHighlight(currentIndexForPosition(lines, player.position() + syncOffsetMs));
  }

  function applyHighlight(idx) {
    if (!lines.length) return;
    const items = viewList.querySelectorAll(".lyrics-line");
    items.forEach((el, row) => el.classList.toggle("active", row === idx));
    if (idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // 가사 싱크 보정: 저장된 타임스탬프는 건드리지 않고, 하이라이트 계산에
  // 쓰이는 재생 위치만 세션 동안 이 값만큼 밀어서 계산한다.
  function setSyncOffset(ms) {
    syncOffsetMs = Math.max(-SYNC_OFFSET_MAX_MS, Math.min(SYNC_OFFSET_MAX_MS, ms));
    syncOffsetValueEl.textContent = `${syncOffsetMs > 0 ? "+" : ""}${syncOffsetMs}ms`;
    lastHighlighted = -2;
    applyHighlight(currentIndexForPosition(lines, player.position() + syncOffsetMs));
  }
  syncOffsetMinusBtn.addEventListener("click", () => setSyncOffset(syncOffsetMs - SYNC_OFFSET_STEP_MS));
  syncOffsetPlusBtn.addEventListener("click", () => setSyncOffset(syncOffsetMs + SYNC_OFFSET_STEP_MS));

  player.addEventListener("tick", (e) => {
    if (!lines.length) return;
    const idx = currentIndexForPosition(lines, e.detail.positionMs + syncOffsetMs);
    if (idx === lastHighlighted) return;
    lastHighlighted = idx;
    applyHighlight(idx);
  });

  function selectRow(tr) {
    if (selectedRow) selectedRow.classList.remove("selected");
    selectedRow = tr;
    tr.classList.add("selected");
  }

  // 시간칸/가사칸에서 위/아래 화살표로 그 줄의 타임코드를 ±100ms씩 조정한다
  // (가사를 들으며 미세 보정할 때 마우스 없이 빠르게 맞추기 위함).
  function bumpTimestamp(timeInput, deltaMs) {
    const current = parseMinSecMs(timeInput.value);
    const base = current === null ? 0 : current;
    timeInput.value = formatMinSecMs(Math.max(0, base + deltaMs));
    scheduleAutoSave(600);
  }

  function handleTimestampArrowKey(timeInput, e) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      bumpTimestamp(timeInput, 100);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      bumpTimestamp(timeInput, -100);
    }
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
    timeInput.addEventListener("keydown", (e) => handleTimestampArrowKey(timeInput, e));
    timeTd.appendChild(timeInput);

    const textTd = document.createElement("td");
    const textarea = document.createElement("textarea");
    textarea.className = "lyrics-text-input";
    textarea.value = line.text;
    textarea.rows = 1;
    textarea.addEventListener("input", () => scheduleAutoSave(1800));
    textarea.addEventListener("blur", () => flushSave());
    textarea.addEventListener("keydown", (e) => handleTimestampArrowKey(timeInput, e));
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
    if (textModeOn) textArea.value = linesToLrcText(lines);
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
    trackLabel = track ? [track.title, track.artist].filter(Boolean).join(" - ") : "";
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
  // 모든 저장 요청(자동저장 디바운스, blur, 곡 전환 시 flush)이 이 체인을 타고
  // 순서대로 실행된다. 각 요청은 예약되는 "시점"의 trackId/가사 내용을 미리
  // 캡처해두므로, 저장이 실제로 서버에 도착하는 시점에 트랙이 이미 바뀌어
  // 있어도 엉뚱한(새) 트랙에 이전 곡 가사가 저장되는 일이 없다.
  let saveChain = Promise.resolve();

  function collectTableLines() {
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
    return validLines;
  }

  // 편집 중인 textarea/시간칸의 포커스·커서 위치가 날아가지 않도록, 저장은
  // 편집 테이블을 다시 그리지 않는다. 시간 형식이 잘못된 줄은 조용히 건너뛴다.
  //
  // force가 아닌 한 결과가 빈 가사면 저장 자체를 하지 않는다 — 곡을 그냥
  // 재생/전환하기만 해도(편집 없이) blur/트랙전환 시 flush가 매번 걸리는데,
  // 이때 가사가 원래 없던 곡까지 빈 가사로 "저장"되어 버리는 문제가 있었다.
  // 의도적으로 전체를 지우는 경우(clearBtn)는 force=true로 호출해 우회한다.
  async function performSave(force = false) {
    if (!trackId) return;
    // trackId와 저장할 가사는 반드시 "지금" 동기적으로 캡처한다 — 아래 체인이
    // 실제로 실행될 때까지 기다렸다가 읽으면 그 사이 다른 곡으로 넘어가 있을 수 있다.
    const targetTrackId = trackId;
    const validLines = textModeOn ? parseLrcText(textArea.value) : collectTableLines();
    if (!validLines.length && !force) return;
    const run = async () => {
      const result = await api.saveLyrics(targetTrackId, validLines);
      if (trackId === targetTrackId) {
        lines = result.lines;
        renderView();
      }
      if (onLyricsSaved) onLyricsSaved(targetTrackId);
    };
    const next = saveChain.then(run, run);
    saveChain = next;
    await next;
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

  function setTextMode(on) {
    textModeOn = on;
    textModeBtn.classList.toggle("active", on);
    editScroll.hidden = on;
    textArea.hidden = !on;
    addRowBtn.disabled = on;
    removeRowBtn.disabled = on;
  }

  textModeBtn.addEventListener("click", () => {
    if (textModeOn) {
      lines = parseLrcText(textArea.value);
      setTextMode(false);
      renderEdit();
    } else {
      textArea.value = linesToLrcText(collectTableLines());
      setTextMode(true);
      requestAnimationFrame(() => textArea.focus());
    }
    flushSave();
  });

  textArea.addEventListener("input", () => scheduleAutoSave(1800));
  textArea.addEventListener("blur", () => flushSave());

  detailEditBtn.addEventListener("click", async () => {
    if (!trackId) {
      await alertDialog("먼저 곡을 재생하거나 선택하세요.");
      return;
    }
    lyricsEditorApi.open(trackId, trackLabel, lines, (newLines) => {
      lines = newLines;
      renderView();
      renderEdit();
      if (onLyricsSaved) onLyricsSaved(trackId);
    });
  });

  function formatBackupTimestamp(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  let previewingBackupName = null;

  function showBackupsList() {
    previewingBackupName = null;
    backupsPreviewView.hidden = true;
    backupsListView.hidden = false;
  }

  async function showBackupPreview(name) {
    const data = await api.getLyricsBackup(trackId, name);
    previewingBackupName = name;
    backupsPreviewBody.textContent = data.lines.length
      ? data.lines.map((l) => `[${formatMinSecMs(l.timestamp_ms)}] ${l.text}`).join("\n")
      : "(빈 가사)";
    backupsListView.hidden = true;
    backupsPreviewView.hidden = false;
  }

  async function renderBackupsList() {
    backupsListEl.innerHTML = "";
    const { backups } = await api.getLyricsBackups(trackId);
    backupsEmptyEl.hidden = backups.length > 0;
    for (const backup of backups) {
      const li = document.createElement("li");
      li.className = "lyrics-backup-row";
      li.textContent = formatBackupTimestamp(backup.timestamp);
      li.addEventListener("click", () => showBackupPreview(backup.name));
      backupsListEl.appendChild(li);
    }
  }

  backupsBtn.addEventListener("click", async () => {
    if (!trackId) {
      await alertDialog("먼저 곡을 재생하거나 선택하세요.");
      return;
    }
    showBackupsList();
    backupsDialog.showModal();
    await renderBackupsList();
  });

  backupsCloseBtn.addEventListener("click", () => backupsDialog.close());
  backupsPreviewBackBtn.addEventListener("click", showBackupsList);

  backupsRestoreBtn.addEventListener("click", async () => {
    if (!previewingBackupName || !trackId) return;
    if (!(await confirmDialog("이 백업으로 복원할까요? 현재 가사는 자동으로 백업된 뒤 교체됩니다.")))
      return;
    const result = await api.restoreLyricsBackup(trackId, previewingBackupName);
    lines = result.lines;
    renderView();
    renderEdit();
    if (onLyricsSaved) onLyricsSaved(trackId);
    backupsDialog.close();
  });

  // "저장" 버튼이 없어진 뒤로는 전체 지우기가 되돌릴 수 없는 작업이라 확인을 받는다.
  clearBtn.addEventListener("click", async () => {
    if (!(await confirmDialog("가사를 전체 삭제할까요? 이 작업은 되돌릴 수 없습니다."))) return;
    clearTimeout(autoSaveTimer);
    editBody.innerHTML = "";
    textArea.value = "";
    selectedRow = null;
    performSave(true);
  });

  // 탭을 닫거나 새로고침하는 순간의 마지막 안전장치(best-effort, 완료 보장은 없음).
  window.addEventListener("beforeunload", () => {
    clearTimeout(autoSaveTimer);
    performSave();
  });

  return { setTrack };
}
