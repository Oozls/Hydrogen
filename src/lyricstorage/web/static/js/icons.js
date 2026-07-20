// Feather 아이콘(SVG, stroke="currentColor")을 CSS mask-image로 재색상화.
// 데스크톱 앱의 icons.py(QSvgRenderer로 currentColor를 치환)와 동일한 역할을,
// 브라우저에서는 래스터화 없이 CSS만으로 수행한다.

export function setIcon(el, name) {
  el.style.setProperty("--icon", `url(/static/icons/${name}.svg)`);
}

export function iconSpan(name, extraClass = "") {
  const span = document.createElement("span");
  span.className = `icon ${extraClass}`.trim();
  setIcon(span, name);
  return span;
}
