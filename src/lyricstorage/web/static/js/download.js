// <a download>를 잠깐 만들어 클릭한 뒤 치운다 — 실제 파일명은
// 서버의 Content-Disposition 헤더가 정해주므로 download 속성은 비워둔다.
export function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
