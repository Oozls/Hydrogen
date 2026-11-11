import { iconSpan } from "./icons.js";

// 가사 유무 아이콘과 같은 이유로 레이팅이 없는 곡도 배지 자리를 항상 차지하게
// 만들고 visibility로만 숨긴다(폭 고정은 CSS .playlist-row-rating이 담당) —
// 그래야 레이팅 있는 행과 없는 행에서 라벨 폭이 똑같이 남아 컬럼이 어긋나지 않는다.
// rowPatch.js가 이 구조(아이콘 span + 텍스트 노드 1개)에 의존한다.
export function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
}
