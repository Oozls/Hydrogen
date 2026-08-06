import { applyMarquee } from "./marquee.js";

// 브라우즈/재생목록/재생 통계의 곡 행 목록은 트랙 전환·평점 변경마다 목록
// 전체를 통째로 다시 그렸다(모든 <li>를 새로 만듦). 그러면 화면에 보이던 모든
// 행의 마퀴 스크롤이 진행 중이던 위치와 무관하게 순간이동하듯 리셋되는 문제가
// 있었다 — 자동으로 다음 곡이 재생될 때마다(사용자가 목록을 스크롤/열람 중이든
// 아니든) 눈에 보이는 모든 제목이 처음 위치로 튀었다가 다시 흐르기 시작했다.
//
// 실제로 바뀌는 건 "어느 행이 재생 중인지"와 "특정 행의 평점" 둘뿐이므로,
// 전체 리렌더 대신 그 행 하나(많아야 둘: 이전/새 재생 행)만 patch한다 — 세
// 화면이 공유하는 곡 행 구조(.playlist-row[data-track-id], .playlist-row-title-clip,
// .playlist-row-rating)를 전제로 한다.

// 같은 곡이 한 재생목록에 두 번 이상 담겨 있을 수 있으므로(중복 추가 허용),
// track_id가 일치하는 행을 전부 찾아 함께 patch한다. 다만 "이 재생목록이
// 지금 재생 중이고, 그 안에 같은 곡이 중복으로 있는" 경우엔 실제로는 그 중
// 정확히 한 자리(재생 인덱스)만 재생 중이어야 하는데, patch는 track_id로만
// 판단하므로 그 좁은 경우엔 중복 행이 전부 재생 중으로 표시될 수 있다 —
// 드문 경우라 전체 리렌더 대신 이 patch 방식을 쓰는 이득이 더 크다고 보고 받아들인다.
function findRows(container, trackId) {
  return [...container.querySelectorAll(".playlist-row")].filter((row) => row.dataset.trackId === trackId);
}

function setRowPlaying(row, playing) {
  row.classList.toggle("playing", playing);
  const inner = row.querySelector(".playlist-row-title-clip .marquee-inner");
  if (!inner) return;
  // "▶ " 접두사만큼 텍스트 폭이 바뀌므로 이 행의 마퀴만 다시 측정해 재시작한다
  // (다른 행은 건드리지 않아 그 행들의 스크롤 진행은 그대로 유지된다).
  const firstCopy = inner.querySelector(".marquee-copy");
  const rawTitle = (firstCopy ? firstCopy.textContent : inner.textContent).replace(/^▶ /, "");
  inner.textContent = (playing ? "▶ " : "") + rawTitle;
  applyMarquee(row);
}

// container 안에서 현재 .playing으로 표시된 행을 찾아 해제하고, nextTrackId
// 행(있으면)을 재생 중으로 표시한다. "이전 재생 행"을 별도 인자로 받지 않고
// DOM에서 직접 찾는 이유: 탭 전환 등으로 다른 화면이 전체 리렌더될 때도 항상
// 실제 DOM 상태와 맞아떨어지게 하기 위함(리렌더 시점마다 어딘가에 별도로
// "마지막 재생 트랙"을 기록해두고 동기화할 필요가 없다).
export function patchPlayingRow(container, nextTrackId) {
  const prevRows = [...container.querySelectorAll(".playlist-row.playing")];
  const prevTrackId = prevRows.length ? prevRows[0].dataset.trackId : null;
  if (prevTrackId === nextTrackId) return;
  prevRows.forEach((row) => setRowPlaying(row, false));
  if (nextTrackId) {
    for (const row of findRows(container, nextTrackId)) setRowPlaying(row, true);
  }
}

// trackId와 일치하는 모든 행의 레이팅 배지를 갱신한다(createRatingBadge와
// 동일한 구조 전제: 아이콘 span 뒤에 숫자 텍스트 노드 하나).
export function patchRatingBadge(container, trackId, rating) {
  for (const row of findRows(container, trackId)) {
    const badge = row.querySelector(".playlist-row-rating");
    if (!badge) continue;
    badge.classList.toggle("empty", !rating);
    const textNode = [...badge.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = String(rating || 0);
  }
}
