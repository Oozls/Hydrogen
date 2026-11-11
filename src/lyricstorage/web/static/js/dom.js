// 검색창/가사 편집/페이지 번호 입력 등 텍스트를 입력 중일 때는 스페이스바/
// 화살표 키가 그 입력에 쓰여야 하므로 단축키를 발동하지 않는 용도.
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
