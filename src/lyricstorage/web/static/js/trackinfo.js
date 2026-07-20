import { api } from "./api.js";

export function setupTrackInfo(onSaved) {
  const dialog = document.getElementById("track-info-dialog");
  const artPreview = document.getElementById("track-info-art-preview");
  const artPlaceholder = document.getElementById("track-info-art-placeholder");
  const artBtn = document.getElementById("track-info-art-btn");
  const artInput = document.getElementById("track-info-art-input");
  const titleInput = document.getElementById("track-info-title");
  const artistInput = document.getElementById("track-info-artist");
  const albumInput = document.getElementById("track-info-album");
  const saveBtn = document.getElementById("track-info-save");
  const cancelBtn = document.getElementById("track-info-cancel");

  let trackId = null;
  let pendingArtFile = null;

  function showArt(url) {
    artPreview.onerror = () => {
      artPreview.style.display = "none";
      artPlaceholder.style.display = "";
    };
    artPreview.onload = () => {
      artPreview.style.display = "";
      artPlaceholder.style.display = "none";
    };
    artPreview.src = url;
  }

  function open(track) {
    trackId = track.track_id;
    pendingArtFile = null;
    titleInput.value = track.title || "";
    artistInput.value = track.artist || "";
    albumInput.value = track.album || "";
    showArt(`${api.artUrl(trackId)}?t=${Date.now()}`);
    dialog.showModal();
  }

  artBtn.addEventListener("click", () => artInput.click());
  artInput.addEventListener("change", () => {
    const file = artInput.files[0];
    if (!file) return;
    pendingArtFile = file;
    showArt(URL.createObjectURL(file));
  });

  cancelBtn.addEventListener("click", () => dialog.close());

  saveBtn.addEventListener("click", async () => {
    if (!trackId) return;
    const title = titleInput.value.trim();
    if (!title) {
      alert("제목을 입력하세요.");
      return;
    }
    try {
      const updated = await api.updateTrackMetadata(trackId, {
        title,
        artist: artistInput.value.trim(),
        album: albumInput.value.trim(),
      });
      if (pendingArtFile) {
        await api.uploadTrackArt(trackId, pendingArtFile);
      }
      dialog.close();
      onSaved(trackId, updated);
    } catch (err) {
      alert(err.message);
    }
  });

  return { open };
}
