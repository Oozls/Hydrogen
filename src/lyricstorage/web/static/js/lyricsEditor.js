import { api } from "./api.js";
import { setIcon } from "./icons.js";

// 표시 전용 분:초.밀리초 클럭. 태깅 정밀도가 이 기능의 핵심이라 밀리초까지 보여준다.
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms || 0));
  const totalSeconds = Math.floor(total / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const millis = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// 가사 상세 편집: (1) 가사 텍스트를 줄 단위로 먼저 입력 → (2) 곡을 재생하며
// 들리는 순간마다 Enter로 타임코드를 태깅 → (3) 사람 반응 시간만큼 전체를
// 앞당기는 보정값을 적용해 저장. 기존 가사 편집 탭(lyrics.js)의 표/행 편집과
// 달리, 타이밍을 "귀로 듣고 맞추는" 별도 워크플로우를 제공한다.
export function setupLyricsEditor(player) {
  const dialog = document.getElementById("lyrics-editor-dialog");
  const titleEl = document.getElementById("lyrics-editor-title");
  const closeBtn = document.getElementById("lyrics-editor-close");

  const phaseDraft = document.getElementById("lyrics-editor-phase-draft");
  const phaseTagging = document.getElementById("lyrics-editor-phase-tagging");
  const phaseOffset = document.getElementById("lyrics-editor-phase-offset");
  const draftTextarea = document.getElementById("lyrics-editor-draft");
  const toTaggingBtn = document.getElementById("lyrics-editor-to-tagging");

  const restartBtn = document.getElementById("lyrics-editor-restart");
  const playPauseBtn = document.getElementById("lyrics-editor-playpause");
  const timeEl = document.getElementById("lyrics-editor-time");
  const progressEl = document.getElementById("lyrics-editor-progress");
  const taggingList = document.getElementById("lyrics-editor-tagging-list");
  const backToDraftBtn = document.getElementById("lyrics-editor-back-to-draft");
  const toOffsetBtn = document.getElementById("lyrics-editor-to-offset");

  const offsetInput = document.getElementById("lyrics-editor-offset");
  const previewList = document.getElementById("lyrics-editor-preview-list");
  const backToTaggingBtn = document.getElementById("lyrics-editor-back-to-tagging");
  const saveBtn = document.getElementById("lyrics-editor-save");

  let trackId = null;
  let onDone = null;
  let taggedLines = []; // {text, timestamp_ms: number|null}
  let cursor = 0; // 다음에 태깅할 줄의 인덱스

  function switchPhase(phase) {
    phaseDraft.classList.toggle("active", phase === "draft");
    phaseTagging.classList.toggle("active", phase === "tagging");
    phaseOffset.classList.toggle("active", phase === "offset");
  }

  function open(id, label, initialLines, doneCallback) {
    trackId = id;
    onDone = doneCallback;
    titleEl.textContent = label ? `가사 상세 편집 - ${label}` : "가사 상세 편집";
    draftTextarea.value = (initialLines || []).map((l) => l.text).join("\n");
    switchPhase("draft");
    player.autoAdvance = false;
    dialog.showModal();
    requestAnimationFrame(() => draftTextarea.focus());
  }

  function close() {
    if (dialog.open) dialog.close();
  }
  closeBtn.addEventListener("click", close);

  // 곡이 끝났을 때 자동으로 다음 곡으로 넘어가면 저장하지 않은 태깅 진행
  // 상황이 날아가므로, 다이얼로그가 열려 있는 동안은 자동 전환을 막는다.
  // 네이티브 dialog가 ESC 등으로 우리 close() 호출 없이 닫히는 경로까지
  // 커버하기 위해 dialog 자체의 close 이벤트에서 복원한다.
  dialog.addEventListener("close", () => {
    player.autoAdvance = true;
  });

  // 편집 도중 트랜스포트 바 등에서 다른 곡으로 넘어가면 태깅 대상이 바뀌어
  // 버려야 하는 상태가 되므로 그냥 닫는다.
  player.addEventListener("trackchange", (e) => {
    if (dialog.open && (!e.detail.track || e.detail.track.track_id !== trackId)) close();
  });

  // 1단계: 초안 텍스트 -> 2단계: 태깅 목록.
  toTaggingBtn.addEventListener("click", () => {
    const rawLines = draftTextarea.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!rawLines.length) return;
    taggedLines = rawLines.map((text) => ({ text, timestamp_ms: null }));
    cursor = 0;
    player.seek(0);
    renderTaggingList();
    updateProgress();
    updateTransport();
    switchPhase("tagging");
  });

  backToDraftBtn.addEventListener("click", () => switchPhase("draft"));

  function buildRow(time, text, { current, tagged } = {}) {
    const li = document.createElement("li");
    li.className = "lyrics-editor-row";
    if (current) li.classList.add("current");
    if (tagged) li.classList.add("tagged");

    const timeSpan = document.createElement("span");
    timeSpan.className = "lyrics-editor-row-time";
    timeSpan.textContent = time;
    li.appendChild(timeSpan);

    const textSpan = document.createElement("span");
    textSpan.className = "lyrics-editor-row-text";
    textSpan.textContent = text;
    li.appendChild(textSpan);

    return li;
  }

  function renderTaggingList() {
    taggingList.innerHTML = "";
    taggedLines.forEach((line, i) => {
      const tagged = line.timestamp_ms !== null;
      const li = buildRow(tagged ? fmtClock(line.timestamp_ms) : "-:--.---", line.text, {
        current: i === cursor,
        tagged,
      });
      taggingList.appendChild(li);
    });
    const currentEl = taggingList.children[cursor];
    if (currentEl) currentEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function updateProgress() {
    const done = taggedLines.filter((l) => l.timestamp_ms !== null).length;
    progressEl.textContent = `${done} / ${taggedLines.length}`;
    toOffsetBtn.disabled = taggedLines.length === 0 || done < taggedLines.length;
  }

  // Enter를 누른 정확한 순간의 raw ms 대신 50ms 단위로 반올림해 기록한다
  // (사람이 완벽히 일정한 타이밍으로 누르지 못하는 오차를 자연스럽게 흡수).
  const TAG_ROUND_MS = 50;
  function roundToTagUnit(ms) {
    return Math.round(ms / TAG_ROUND_MS) * TAG_ROUND_MS;
  }

  function tagCurrent() {
    if (cursor >= taggedLines.length) return;
    taggedLines[cursor].timestamp_ms = roundToTagUnit(player.position());
    cursor += 1;
    renderTaggingList();
    updateProgress();
  }

  function untagPrevious() {
    if (cursor <= 0) return;
    cursor -= 1;
    taggedLines[cursor].timestamp_ms = null;
    renderTaggingList();
    updateProgress();
  }

  // 상세 편집에서는 화살표(전역 10초 이동)와 별개로 대괄호/중괄호로 더
  // 촘촘하게 탐색할 수 있게 한다: [ ] = 5초, { } = 1초.
  function seekBy(deltaMs) {
    const target = player.position() + deltaMs;
    const dur = player.duration();
    const clamped = dur > 0 ? Math.min(target, dur) : target;
    player.seek(Math.max(0, clamped));
  }

  dialog.addEventListener("keydown", (e) => {
    if (!phaseTagging.classList.contains("active")) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      tagCurrent();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      untagPrevious();
    } else if (e.key === "[") {
      e.preventDefault();
      seekBy(-5000);
    } else if (e.key === "]") {
      e.preventDefault();
      seekBy(5000);
    } else if (e.key === "{") {
      e.preventDefault();
      seekBy(-1000);
    } else if (e.key === "}") {
      e.preventDefault();
      seekBy(1000);
    }
  });

  restartBtn.addEventListener("click", () => player.seek(0));
  playPauseBtn.addEventListener("click", () => player.togglePlayPause());

  function updateTransport() {
    setIcon(playPauseBtn.querySelector(".icon"), player.isPlaying() ? "pause" : "play");
    timeEl.textContent = `${fmtClock(player.position())} / ${fmtClock(player.duration())}`;
  }
  function taggingVisible() {
    return dialog.open && phaseTagging.classList.contains("active");
  }
  player.addEventListener("tick", () => {
    if (taggingVisible()) updateTransport();
  });
  player.addEventListener("playstate", () => {
    if (taggingVisible()) updateTransport();
  });
  player.addEventListener("durationchange", () => {
    if (taggingVisible()) updateTransport();
  });

  // 2단계 -> 3단계.
  toOffsetBtn.addEventListener("click", () => {
    player.stop();
    renderPreview();
    switchPhase("offset");
  });

  backToTaggingBtn.addEventListener("click", () => switchPhase("tagging"));

  function renderPreview() {
    const offset = Number(offsetInput.value) || 0;
    previewList.innerHTML = "";
    taggedLines.forEach((line) => {
      const adjusted = Math.max(0, (line.timestamp_ms || 0) - offset);
      previewList.appendChild(buildRow(fmtClock(adjusted), line.text, { tagged: true }));
    });
  }
  offsetInput.addEventListener("input", renderPreview);

  saveBtn.addEventListener("click", async () => {
    if (!trackId) return;
    const offset = Number(offsetInput.value) || 0;
    const finalLines = taggedLines
      .filter((l) => l.timestamp_ms !== null)
      .map((l) => ({ text: l.text, timestamp_ms: Math.max(0, l.timestamp_ms - offset) }));
    saveBtn.disabled = true;
    try {
      const result = await api.saveLyrics(trackId, finalLines);
      close();
      if (onDone) onDone(result.lines);
    } finally {
      saveBtn.disabled = false;
    }
  });

  return { open };
}
