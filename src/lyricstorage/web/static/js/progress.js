// 업로드 등 시간이 걸리는 작업 공용 진행률 오버레이.
const overlayEl = document.getElementById("progress-overlay");
const labelEl = document.getElementById("progress-label");
const fillEl = document.getElementById("progress-fill");
const percentEl = document.getElementById("progress-percent");
const logEl = document.getElementById("progress-log");

export function showProgress(label) {
  labelEl.textContent = label;
  setProgress(0);
  setProgressLog([]);
  overlayEl.classList.add("active");
}

// 진행률(fraction)은 그대로 두고 라벨 문구만 바꾼다 — 서버 폴링처럼 매번
// showProgress를 다시 부르면 진행률이 0으로 리셋돼버리는 걸 피하기 위함.
export function setProgressLabel(label) {
  labelEl.textContent = label;
}

// 글로벌 플레이리스트 재작성처럼 진행 중 상세 로그를 계속 보여줘야 하는
// 작업용. 줄 배열을 넘기면 그대로 표시하고, 비어 있으면 로그 영역을 숨긴다.
export function setProgressLog(lines) {
  if (!logEl) return;
  if (!lines || !lines.length) {
    logEl.hidden = true;
    logEl.textContent = "";
    return;
  }
  logEl.hidden = false;
  logEl.textContent = lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

// fraction: 0~1 사이 진행률. null이면 진행률을 알 수 없는 단계(예: 서버 처리 대기)로
// 표시한다.
export function setProgress(fraction) {
  if (fraction === null || fraction === undefined) {
    fillEl.classList.add("indeterminate");
    fillEl.style.width = "";
    percentEl.textContent = "";
    return;
  }
  fillEl.classList.remove("indeterminate");
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  fillEl.style.width = `${pct}%`;
  percentEl.textContent = `${pct}%`;
}

export function hideProgress() {
  overlayEl.classList.remove("active");
}
