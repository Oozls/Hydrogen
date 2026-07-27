// 앨범 커버 등 이미지를 클릭하면 화면 중앙에 확대해서 보여주는 공용 라이트박스.
// 오버레이 DOM은 최초 호출 시 한 번만 만들어 재사용한다.
let overlayEl = null;
let imgEl = null;

function ensureOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement("div");
  overlayEl.className = "image-lightbox-overlay";
  overlayEl.hidden = true;
  imgEl = document.createElement("img");
  imgEl.className = "image-lightbox-img";
  imgEl.alt = "";
  overlayEl.appendChild(imgEl);
  overlayEl.addEventListener("click", closeImageLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlayEl.hidden) closeImageLightbox();
  });
  document.body.appendChild(overlayEl);
}

export function openImageLightbox(url) {
  if (!url) return;
  ensureOverlay();
  imgEl.src = url;
  overlayEl.hidden = false;
}

export function closeImageLightbox() {
  if (overlayEl) overlayEl.hidden = true;
}
