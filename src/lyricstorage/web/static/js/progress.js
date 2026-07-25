// 업로드 등 시간이 걸리는 작업 공용 진행률 오버레이.
const overlayEl = document.getElementById("progress-overlay");
const labelEl = document.getElementById("progress-label");
const fillEl = document.getElementById("progress-fill");
const percentEl = document.getElementById("progress-percent");

export function showProgress(label) {
  labelEl.textContent = label;
  setProgress(0);
  overlayEl.classList.add("active");
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
