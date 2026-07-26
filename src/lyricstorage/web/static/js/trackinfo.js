import { api } from "./api.js";
import { alertDialog, confirmDialog } from "./dialog.js";
import { distinctValues, buildAutocomplete } from "./autocomplete.js";
import { showArtSpinner } from "./artspinner.js";

export function setupTrackInfo(onSaved, onDeleted) {
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
  const deleteBtn = document.getElementById("track-info-delete");

  let trackId = null;
  let pendingArtFile = null;
  let titleValues = [];
  let artistValues = [];
  let albumValues = [];

  const titleAutocomplete = buildAutocomplete(
    titleInput,
    document.getElementById("track-info-title-suggestions"),
    () => titleValues
  );
  const artistAutocomplete = buildAutocomplete(
    artistInput,
    document.getElementById("track-info-artist-suggestions"),
    () => artistValues
  );
  const albumAutocomplete = buildAutocomplete(
    albumInput,
    document.getElementById("track-info-album-suggestions"),
    () => albumValues
  );

  function showArt(url) {
    const stopSpin = showArtSpinner(artPreview.parentElement);
    artPreview.onerror = () => {
      stopSpin();
      artPreview.style.display = "none";
      artPlaceholder.style.display = "";
    };
    artPreview.onload = () => {
      stopSpin();
      artPreview.style.display = "";
      artPlaceholder.style.display = "none";
    };
    artPreview.src = url;
  }

  async function open(track) {
    trackId = track.track_id;
    pendingArtFile = null;
    titleInput.value = track.title || "";
    artistInput.value = track.artist || "";
    albumInput.value = track.album || "";
    showArt(`${api.artUrl(trackId)}?t=${Date.now()}`);
    dialog.showModal();

    const library = await api.getLibrary();
    titleValues = distinctValues(library.tracks, "title");
    artistValues = distinctValues(library.tracks, "artist");
    albumValues = distinctValues(library.tracks, "album");
  }

  artBtn.addEventListener("click", () => artInput.click());
  artInput.addEventListener("change", () => {
    const file = artInput.files[0];
    if (!file) return;
    pendingArtFile = file;
    showArt(URL.createObjectURL(file));
  });

  cancelBtn.addEventListener("click", () => {
    titleAutocomplete.hide();
    artistAutocomplete.hide();
    albumAutocomplete.hide();
    dialog.close();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!trackId) return;
    const label = titleInput.value.trim() || trackId;
    if (
      !(await confirmDialog(
        `'${label}'을(를) 모든 재생목록과 라이브러리에서 완전히 삭제할까요? 파일도 함께 삭제되며 되돌릴 수 없습니다.`
      ))
    )
      return;
    try {
      const deletedId = trackId;
      await api.deleteTrackEntirely(deletedId);
      titleAutocomplete.hide();
      artistAutocomplete.hide();
      albumAutocomplete.hide();
      dialog.close();
      onDeleted(deletedId);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!trackId) return;
    const title = titleInput.value.trim();
    if (!title) {
      await alertDialog("제목을 입력하세요.");
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
      await alertDialog(err.message);
    }
  });

  return { open };
}
