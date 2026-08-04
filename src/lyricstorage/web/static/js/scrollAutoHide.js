// 스크롤바를 평소엔 숨겨두고, 실제로 스크롤하는 동안만 잠깐 보여준다(theme.css의
// .scroll-autohide 클래스와 짝을 이룬다). 이 클래스가 붙은 요소라면 어디든 재사용한다.
export function attachScrollAutoHide(el, hideDelayMs = 700) {
  if (!el) return;
  let timer = null;
  el.addEventListener("scroll", () => {
    el.classList.add("scrolling");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("scrolling"), hideDelayMs);
  });
}
