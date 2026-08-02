import { api } from "./api.js";
import { alertDialog } from "./dialog.js";
import { showArtSpinner } from "./artspinner.js";

export function setupAlbumInfo(onSaved) {
  const dialog = document.getElementById("album-info-dialog");
  const artPreview = document.getElementById("album-info-art-preview");
  const artPlaceholder = document.getElementById("album-info-art-placeholder");
  const artBtn = document.getElementById("album-info-art-btn");
  const artInput = document.getElementById("album-info-art-input");
  const albumInput = document.getElementById("album-info-album");
  const artistInput = document.getElementById("album-info-artist");
  const yearInput = document.getElementById("album-info-year");
  const saveBtn = document.getElementById("album-info-save");
  const cancelBtn = document.getElementById("album-info-cancel");

  let currentAlbumId = null;
  let pendingArtFile = null;

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

  function open(group) {
    currentAlbumId = group.id;
    pendingArtFile = null;
    albumInput.value = group.album || "";
    artistInput.value = group.artist || "";
    yearInput.value = group.year || "";
    showArt(`${api.albumArtUrl(group.id)}?t=${Date.now()}`);

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
    const name = albumInput.value.trim();
    if (!name) {
      await alertDialog("앨범명을 입력하세요.");
      return;
    }
    const artist = artistInput.value.trim();
    const year = yearInput.value.trim() ? Number(yearInput.value.trim()) : null;
    try {
      const result = await api.updateAlbum(currentAlbumId, { name, artist, year });
      if (pendingArtFile) {
        await api.uploadAlbumArt(currentAlbumId, pendingArtFile);
      }
      dialog.close();
      onSaved(result.tracks);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return { open };
}
