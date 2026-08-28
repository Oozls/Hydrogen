import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

// 재생바의 하트 5개짜리 레이팅 위젯. 0.5점 단위까지 매길 수 있는데, 하트마다
// 새 아이콘을 만드는 대신 채워진 하트(heart-filled)를 clip-path로 왼쪽
// 절반만 보이게 잘라 "반쪽 하트"로 표현한다(테마 CSS의 .rating-heart-fill).
// 현재 재생 중인 곡에 대해서만 동작하며, 값은 트랙 자체(모든 재생목록 사본 +
// 라이브러리)에 저장돼 어느 화면에서 보든 동일하게 나타난다.
export function setupRating(player) {
  const hearts = [...document.querySelectorAll("#track-rating .rating-heart")];

  // 버튼 안에서의 클릭/커서 x좌표로 "이 하트를 절반만 채울지 완전히 채울지"를
  // 결정한다: 왼쪽 절반을 누르면 (하트번호 - 0.5), 오른쪽 절반을 누르면
  // (하트번호) 그대로.
  function valueFromEvent(btn, clientX) {
    const value = Number(btn.dataset.value);
    const rect = btn.getBoundingClientRect();
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 1;
    return frac <= 0.5 ? value - 0.5 : value;
  }

  function paint(previewValue) {
    const track = player.currentTrack;
    const rating = track ? track.rating || 0 : 0;
    const activeValue = previewValue != null ? previewValue : rating;
    hearts.forEach((btn) => {
      const value = Number(btn.dataset.value);
      const fill = btn.querySelector(".rating-heart-fill");
      const diff = Math.min(1, Math.max(0, activeValue - (value - 1)));
      fill.classList.toggle("full", diff >= 1);
      fill.classList.toggle("half", diff > 0 && diff < 1);
      btn.classList.toggle("filled", diff > 0);
      btn.disabled = !track;
    });
  }

  hearts.forEach((btn) => {
    btn.addEventListener("mousemove", (e) => paint(valueFromEvent(btn, e.clientX)));
    btn.addEventListener("mouseleave", () => paint());
    btn.addEventListener("click", async (e) => {
      const track = player.currentTrack;
      if (!track) return;
      const clickedValue = valueFromEvent(btn, e.clientX);
      const prevRating = track.rating || 0;
      const nextRating = prevRating === clickedValue ? 0 : clickedValue; // 같은 값을 다시 누르면 레이팅 해제
      track.rating = nextRating;
      paint(nextRating);
      try {
        await api.setRating(track.track_id, nextRating);
      } catch (err) {
        track.rating = prevRating;
        paint();
        await alertDialog(err.message);
        return;
      }
      player.dispatchEvent(
        new CustomEvent("ratingchange", { detail: { trackId: track.track_id, rating: nextRating } })
      );
    });
  });

  player.addEventListener("trackchange", () => paint());
  player.addEventListener("ratingchange", () => paint()); // 축 평가 다이얼로그 등 외부에서 바꾼 값도 반영
  paint();
}
