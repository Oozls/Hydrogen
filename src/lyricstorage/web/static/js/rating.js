import { api } from "./api.js";
import { setIcon } from "./icons.js";
import { alertDialog } from "./dialog.js";

// 재생바의 하트 5개짜리 레이팅 위젯. 현재 재생 중인 곡에 대해서만 동작하며,
// 값은 트랙 자체(모든 재생목록 사본 + 라이브러리)에 저장돼 어느 화면에서 보든
// 동일하게 나타난다.
export function setupRating(player) {
  const hearts = [...document.querySelectorAll("#track-rating .rating-heart")];

  function paint(previewValue) {
    const track = player.currentTrack;
    const rating = track ? track.rating || 0 : 0;
    const activeValue = previewValue != null ? previewValue : rating;
    hearts.forEach((btn) => {
      const value = Number(btn.dataset.value);
      const filled = value <= activeValue;
      setIcon(btn.querySelector(".icon"), filled ? "heart-filled" : "heart");
      btn.classList.toggle("filled", filled);
      btn.disabled = !track;
    });
  }

  hearts.forEach((btn) => {
    const value = Number(btn.dataset.value);
    btn.addEventListener("mouseenter", () => paint(value));
    btn.addEventListener("mouseleave", () => paint());
    btn.addEventListener("click", async () => {
      const track = player.currentTrack;
      if (!track) return;
      const prevRating = track.rating || 0;
      const nextRating = prevRating === value ? 0 : value; // 같은 하트를 다시 누르면 레이팅 해제
      track.rating = nextRating;
      paint();
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
  paint();
}
