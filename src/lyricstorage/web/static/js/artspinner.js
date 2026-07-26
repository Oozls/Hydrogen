// 앨범 커버 <img>가 로딩되는 동안 아트 컨테이너 위에 스피너를 겹쳐 보여준다.
// 컨테이너는 position:relative여야 하고(대부분 이미 그렇게 스타일돼 있음), 로드
// 완료/실패 시 호출부가 반환된 함수를 불러 스피너를 제거해야 한다.
export function showArtSpinner(wrapEl) {
  if (!wrapEl) return () => {};
  const spinner = document.createElement("span");
  spinner.className = "art-spinner";
  wrapEl.appendChild(spinner);
  return () => spinner.remove();
}
