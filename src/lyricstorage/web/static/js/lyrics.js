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

export function setupLyrics(player, bootstrap, onLyricsSaved) {
  const tabViewBtn = document.getElementById("tab-lyrics-view-btn");
  const tabEditBtn = document.getElementById("tab-lyrics-edit-btn");
  const viewPanel = document.getElementById("lyrics-view-panel");
  const editPanel = document.getElementById("lyrics-edit-panel");

  const viewList = document.getElementById("lyrics-view-list");
  const slideModeCheckbox = document.getElementById("lyrics-slide-mode-checkbox");
  const fetchExternalBtn = document.getElementById("btn-lyrics-fetch-external");
  const translateBtn = document.getElementById("btn-lyrics-translate");

  const editScroll = document.getElementById("lyrics-edit-scroll");
  const editBody = document.getElementById("lyrics-edit-body");
  const addRowBtn = document.getElementById("btn-lyrics-add-row");
  const removeRowBtn = document.getElementById("btn-lyrics-remove-row");
  const clearBtn = document.getElementById("btn-lyrics-clear");
  const detailEditBtn = document.getElementById("btn-lyrics-detail-edit");

  const candidatesDialog = document.getElementById("lyrics-candidates-dialog");
  const candidatesCloseBtn = document.getElementById("lyrics-candidates-close");
  const candidatesListEl = document.getElementById("lyrics-candidates-list");

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

  // 기본은 줄이 바뀔 때마다 그 줄을 중앙으로 점프시키는 방식(스크롤도
  // scrollIntoView가 알아서 처리). 슬라이딩 모드를 켜면 그 대신, 지금 줄의
  // 타임스탬프부터 다음 줄(또는 마지막 줄이면 곡 길이)까지의 구간 안에서
  // 스크롤 위치를 매 프레임 선형 보간해 계속 위로 흘러가게 한다. volume/
  // today_limit과 같은 방식으로 /api/settings에 저장해 다음 접속에도 유지된다.
  let slideModeOn = !!(bootstrap.settings && bootstrap.settings.lyrics_slide_mode);
  slideModeCheckbox.checked = slideModeOn;

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
    userScrollPausedUntil = 0; // 새 트랙/재렌더는 사용자의 이전 스크롤 일시정지를 이어받지 않는다
    refreshLyricsPosition(player.position() + syncOffsetMs, { immediate: true });
  }

  // idx번 줄을 컨테이너 중앙에 두는 데 필요한 scrollTop. 위아래로 빈 여백이
  // 생기지 않도록 [0, 최대 스크롤]로 clamp한다 — 네이티브 scrollIntoView가
  // 목록 양 끝에서 알아서 하는 것과 같은 clamp를 슬라이딩 모드에서도 직접 재현.
  function centerScrollTopFor(items, idx) {
    const el = items[idx];
    if (!el) return 0;
    const maxScroll = Math.max(0, viewList.scrollHeight - viewList.clientHeight);
    const target = el.offsetTop - (viewList.clientHeight - el.offsetHeight) / 2;
    return Math.max(0, Math.min(target, maxScroll));
  }

  function applyHighlight(idx) {
    if (!lines.length) return;
    const items = viewList.querySelectorAll(".lyrics-line");
    items.forEach((el, row) => el.classList.toggle("active", row === idx));
    if (!slideModeOn && idx >= 0 && items[idx]) {
      items[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // 슬라이딩 모드 전용: posMs가 속한 구간([이 줄, 다음 줄] 또는 첫 줄 이전엔
  // [0, 첫 줄], 마지막 줄이면 [마지막 줄, 곡 길이])에서 진행률을 구해 그
  // 구간의 시작/끝 중앙 스크롤 위치를 선형 보간한 "목표" scrollTop을 계산한다.
  // 다음 줄이 없어도(마지막 줄) 곡 길이를 끝점으로 삼아 계속 흘러가는 게 핵심
  // 요구사항. 실제로 화면에 쓰는 값은 이 목표를 향해 매끄럽게 따라가는
  // applySlideScroll이 담당(목표 자체는 이지→다음 구간 경계에서 기울기가
  // 바뀌지만, 화면 값은 그 경계를 부드럽게 넘어가도록 뒤에서 완충한다).
  function computeSlideTarget(posMs, idx, items) {
    const maxScroll = Math.max(0, viewList.scrollHeight - viewList.clientHeight);
    let fromMs, toMs, fromScroll, toScroll;
    if (idx < 0) {
      fromMs = 0;
      toMs = lines[0].timestamp_ms;
      fromScroll = 0;
      toScroll = centerScrollTopFor(items, 0);
    } else {
      fromMs = lines[idx].timestamp_ms;
      // 첫 줄이 곡 시작(0ms)부터 바로 활성이면 위 idx<0 구간이 아예 없어서
      // "이전에 스크롤된 적"이 없다 — 이때는 중앙 정렬 대신 맨 위(0)에서
      // 시작해야 재생 시작 시 가사 맨 윗줄이 보인다는 기대와 맞는다. 그 밖의
      // 모든 줄은 직전 구간이 항상 이 줄을 이미 중앙으로 가져다 놨으므로
      // 그대로 이어받는다.
      fromScroll = idx === 0 && fromMs <= 0 ? 0 : centerScrollTopFor(items, idx);
      if (idx + 1 < lines.length) {
        toMs = lines[idx + 1].timestamp_ms;
        toScroll = centerScrollTopFor(items, idx + 1);
      } else {
        toMs = Math.max(player.duration(), fromMs + 1);
        toScroll = maxScroll;
      }
    }
    const progress = Math.max(0, Math.min(1, (posMs - fromMs) / Math.max(1, toMs - fromMs)));
    return fromScroll + (toScroll - fromScroll) * progress;
  }

  // 우리 코드가 마지막으로 지정한 scrollTop(반올림) — 아래 scroll 리스너가
  // "이건 우리가 방금 쓴 값이라 사용자 스크롤이 아니다"를 판단하는 기준.
  let lastAutoScrollTop = null;
  function setSlideScrollTop(value) {
    lastAutoScrollTop = Math.round(value);
    viewList.scrollTop = value;
  }

  // 슬라이딩 모드 중 사용자가 휠/터치/스크롤바로 직접 스크롤을 옮기면, 그 시도를
  // 덮어써 자동 스크롤로 되돌리는 대신 잠시 손을 뗀다 — USER_SCROLL_PAUSE_MS
  // 동안 자동 스크롤 쓰기를 건너뛰고, 그 시간이 지나면 그때의 실제 재생 위치로
  // (아래 이지 감쇠 덕에) 부드럽게 다시 붙는다. 브라우저 scroll 이벤트는 우리가
  // 직접 쓴 경우에도 발생하므로, 방금 우리가 쓴 값과 실제 값이 다를 때만(사용자가
  // 개입해 값이 바뀐 경우) 사용자 스크롤로 간주한다.
  const USER_SCROLL_PAUSE_MS = 5000;
  let userScrollPausedUntil = 0;
  viewList.addEventListener("scroll", () => {
    if (!slideModeOn) return;
    const current = Math.round(viewList.scrollTop);
    if (lastAutoScrollTop !== null && Math.abs(current - lastAutoScrollTop) <= 1) return;
    userScrollPausedUntil = Date.now() + USER_SCROLL_PAUSE_MS;
  });

  // dtMs가 없으면(트랙 전환, 일시정지 중 탐색, 슬라이딩 모드를 막 켠 순간 등)
  // 목표 위치로 즉시 스냅한다. dtMs가 있으면(재생 중 rAF 루프) 목표를 향해
  // 지수 감쇠로 매끄럽게 따라간다 — 구간 경계에서 기울기가 바뀌어도 화면에
  // 보이는 움직임 자체는 급이 꺾이지 않고, 사용자 스크롤 일시정지가 풀린
  // 뒤에도 같은 방식으로 자연스럽게 다시 붙는다.
  const SLIDE_SMOOTHING_TAU_MS = 260;
  function applySlideScroll(posMs, idx, dtMs) {
    const items = viewList.querySelectorAll(".lyrics-line");
    if (!items.length) return;
    const target = computeSlideTarget(posMs, idx, items);
    if (dtMs == null) {
      setSlideScrollTop(target);
      return;
    }
    const current = viewList.scrollTop;
    const alpha = 1 - Math.exp(-dtMs / SLIDE_SMOOTHING_TAU_MS);
    setSlideScrollTop(current + (target - current) * alpha);
  }

  // tick(재생 중 성긴 timeupdate)과 rAF 루프(재생 중 매 프레임) 양쪽에서 공유하는
  // 진입점. 줄이 실제로 바뀔 때만 하이라이트를 갱신한다(applyHighlight 자체가
  // idx==row 비교라 매번 불러도 안전은 하지만, scrollIntoView(smooth)를 매
  // 프레임 다시 트리거하면 애니메이션이 끊기므로 idx 변화 시에만 부른다).
  // skipScroll은 tick 전용 — rAF 루프가 이미 돌고 있는 동안은 tick이 스크롤
  // 쪽엔 손대지 않는다(하이라이트만 갱신), 그러지 않으면 tick의 스냅이 rAF의
  // 감쇠 애니메이션과 부딪혀 끊겨 보인다.
  function refreshLyricsPosition(posMs, { immediate = false, skipScroll = false } = {}) {
    if (!lines.length) return;
    const idx = currentIndexForPosition(lines, posMs);
    if (idx !== lastHighlighted) {
      lastHighlighted = idx;
      applyHighlight(idx);
    }
    if (!slideModeOn || skipScroll) return;
    if (!immediate && Date.now() < userScrollPausedUntil) return;
    applySlideScroll(posMs, idx, immediate ? null : lastFrameDtMs);
  }

  // 가사 싱크 보정: 저장된 타임스탬프는 건드리지 않고, 하이라이트 계산에
  // 쓰이는 재생 위치만 세션 동안 이 값만큼 밀어서 계산한다.
  function setSyncOffset(ms) {
    syncOffsetMs = Math.max(-SYNC_OFFSET_MAX_MS, Math.min(SYNC_OFFSET_MAX_MS, ms));
    syncOffsetValueEl.textContent = `${syncOffsetMs > 0 ? "+" : ""}${syncOffsetMs}ms`;
    lastHighlighted = -2;
    refreshLyricsPosition(player.position() + syncOffsetMs, { immediate: true });
  }
  syncOffsetMinusBtn.addEventListener("click", () => setSyncOffset(syncOffsetMs - SYNC_OFFSET_STEP_MS));
  syncOffsetPlusBtn.addEventListener("click", () => setSyncOffset(syncOffsetMs + SYNC_OFFSET_STEP_MS));

  player.addEventListener("tick", (e) =>
    refreshLyricsPosition(e.detail.positionMs + syncOffsetMs, { immediate: true, skipScroll: slideRafId != null })
  );

  // 슬라이딩 모드는 tick(초당 몇 번 안 되는 timeupdate)만으로 움직이면 계단식으로
  // 보이므로, 재생 중일 때만 rAF로 매 프레임 다시 계산한다(재생바 진행 슬라이더와
  // 동일한 이유·패턴 — nowplaying.js의 progressStep 참고). 프레임 간 실제 경과
  // 시간(dt)을 재서 감쇠 속도가 프레임레이트에 흔들리지 않게 한다.
  let slideRafId = null;
  let lastFrameTimeMs = null;
  let lastFrameDtMs = 16;
  function slideStep(nowMs) {
    lastFrameDtMs = lastFrameTimeMs != null ? nowMs - lastFrameTimeMs : 16;
    lastFrameTimeMs = nowMs;
    refreshLyricsPosition(player.position() + syncOffsetMs);
    slideRafId = requestAnimationFrame(slideStep);
  }
  function startSlideLoop() {
    if (slideRafId == null) {
      lastFrameTimeMs = null;
      slideRafId = requestAnimationFrame(slideStep);
    }
  }
  function stopSlideLoop() {
    if (slideRafId != null) {
      cancelAnimationFrame(slideRafId);
      slideRafId = null;
    }
  }
  player.addEventListener("playstate", (e) => {
    if (slideModeOn && e.detail.playing) startSlideLoop();
    else stopSlideLoop();
  });

  slideModeCheckbox.addEventListener("change", () => {
    slideModeOn = slideModeCheckbox.checked;
    userScrollPausedUntil = 0;
    if (slideModeOn && player.isPlaying()) startSlideLoop();
    else stopSlideLoop();
    lastHighlighted = -2;
    refreshLyricsPosition(player.position() + syncOffsetMs, { immediate: true });
    api.updateSettings({ lyrics_slide_mode: slideModeOn }).catch(() => {});
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

  // 곡이 빠르게 연달아 바뀌면(연타로 스킵, 셔플 등) setTrack이 겹쳐 호출될 수
  // 있다. 매번 await(이전 곡 저장, 가사 조회)를 거치므로, 먼저 시작된 호출이
  // 나중에 시작된 호출보다 늦게 끝나면 trackId/lines를 이미 지난 트랙 값으로
  // 덮어써버린다(재생 중인 곡과 안 맞는 엉뚱한 가사가 뜨는 원인). 매 호출마다
  // 토큰을 새로 발급해, 그 사이 더 최신 호출이 시작됐으면 조용히 멈춘다
  // (expanded-player.js의 animationToken과 같은 패턴).
  let setTrackToken = 0;

  async function setTrack(track) {
    const myToken = ++setTrackToken;
    // 곡을 바꾸기 전, 이전 곡에 대해 대기 중이던 저장을 반드시 먼저 끝낸다.
    // 그렇지 않으면 디바운스 타이머가 나중에 엉뚱한(새) 트랙 상태에 대해
    // 발동하거나, 이전 트랙의 편집 내용이 그대로 유실된다.
    if (trackId !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await performSave();
    }
    if (myToken !== setTrackToken) return; // 그 사이 더 최신 트랙 전환이 시작됨
    trackId = track ? track.track_id : null;
    trackLabel = track ? [track.title, track.artist].filter(Boolean).join(" - ") : "";
    if (!trackId) {
      lines = [];
      renderView();
      renderEdit();
      return;
    }
    const data = await api.getLyrics(trackId);
    if (myToken !== setTrackToken) return; // 응답 오는 사이 더 최신 트랙 전환이 시작됨
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

  // 후보 하나(가사 텍스트 몇 줄)를 미리보기로 보여준다 — TouhouDB는 한 후보에
  // 실제 줄이 전부 하나의 LyricLine(00:00)에 \n으로 합쳐져 들어있으므로, 표시
  // 줄(LyricLine) 단위가 아니라 실제 텍스트 줄 단위로 다시 쪼개야 한다.
  function candidateSnippet(candidate) {
    const realLines = candidate.lines.flatMap((l) => l.text.split("\n")).filter((t) => t.trim());
    return realLines.slice(0, 3).join("\n");
  }

  function renderCandidateRow(candidate) {
    const li = document.createElement("li");
    li.className = "lyrics-candidate-row";

    const head = document.createElement("div");
    head.className = "lyrics-candidate-row-head";
    const sourceEl = document.createElement("span");
    sourceEl.className = "lyrics-candidate-row-source";
    sourceEl.textContent = candidate.source;
    const badgeEl = document.createElement("span");
    badgeEl.className = "lyrics-candidate-row-badge";
    const badgeParts = [candidate.synced ? "동기화됨" : "타이밍 없음"];
    if (candidate.title) badgeParts.push(candidate.title);
    if (candidate.artist) badgeParts.push(candidate.artist);
    if (candidate.album) badgeParts.push(candidate.album);
    badgeEl.textContent = badgeParts.join(" · ");
    head.appendChild(sourceEl);
    head.appendChild(badgeEl);

    const snippetEl = document.createElement("div");
    snippetEl.className = "lyrics-candidate-row-snippet";
    snippetEl.textContent = candidateSnippet(candidate);

    li.appendChild(head);
    li.appendChild(snippetEl);
    li.addEventListener("click", () => applyCandidate(candidate));
    return li;
  }

  // 후보 하나를 그리다 실패해도(예상 밖 데이터 모양) 그 후보만 건너뛰고 나머지는
  // 계속 보여준다 — 한 후보의 예외로 목록 전체가 빈 채로 뜨는 것을 막는다.
  function renderCandidatesList(candidates) {
    candidatesListEl.innerHTML = "";
    for (const candidate of candidates) {
      try {
        candidatesListEl.appendChild(renderCandidateRow(candidate));
      } catch (err) {
        console.error("가사 후보 렌더링 실패", candidate, err);
      }
    }
    if (!candidatesListEl.children.length) {
      const empty = document.createElement("li");
      empty.className = "lyrics-candidates-empty";
      empty.textContent = "후보를 표시하지 못했습니다.";
      candidatesListEl.appendChild(empty);
    }
  }

  async function applyCandidate(candidate) {
    candidatesDialog.close();
    try {
      const result = await api.saveLyrics(trackId, candidate.lines);
      lines = result.lines;
      renderView();
      renderEdit();
      if (onLyricsSaved) onLyricsSaved(trackId);
      await alertDialog(
        candidate.synced
          ? `${candidate.source}에서 동기화된 가사를 적용했습니다.`
          : `${candidate.source}에서 가사를 적용했습니다 (타이밍 정보 없음 — '가사 편집' 탭에서 직접 맞춰주세요).`
      );
    } catch (err) {
      await alertDialog(err.message || "가사를 적용하지 못했습니다.");
    }
  }

  candidatesCloseBtn.addEventListener("click", () => candidatesDialog.close());

  fetchExternalBtn.addEventListener("click", async () => {
    if (!trackId) {
      await alertDialog("먼저 곡을 재생하거나 선택하세요.");
      return;
    }
    if (lines.length && !(await confirmDialog("인터넷에서 가사를 가져와 지금 가사를 덮어쓸까요? 기존 가사는 자동으로 백업됩니다.")))
      return;
    fetchExternalBtn.disabled = true;
    try {
      const { candidates } = await api.fetchExternalLyricsCandidates(trackId);
      renderCandidatesList(candidates);
      candidatesDialog.showModal();
    } catch (err) {
      await alertDialog(err.message || "가사를 가져오지 못했습니다.");
    } finally {
      fetchExternalBtn.disabled = false;
    }
  });

  translateBtn.addEventListener("click", async () => {
    if (!trackId) {
      await alertDialog("먼저 곡을 재생하거나 선택하세요.");
      return;
    }
    if (!lines.length) {
      await alertDialog("번역할 가사가 없습니다. 먼저 가사를 추가하세요.");
      return;
    }
    translateBtn.disabled = true;
    try {
      const result = await api.translateLyrics(trackId);
      lines = result.lines;
      renderView();
      renderEdit();
      if (onLyricsSaved) onLyricsSaved(trackId);
    } catch (err) {
      await alertDialog(err.message || "번역에 실패했습니다.");
    } finally {
      translateBtn.disabled = false;
    }
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
