import { api } from "./api.js";
import { alertDialog } from "./dialog.js";
import { makeArtShower, artVersionQuery, bumpArtVersion } from "./artDisplay.js";

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

  const showArt = makeArtShower(artPreview, artPlaceholder);

  function open(group) {
    currentAlbumId = group.id;
    pendingArtFile = null;
    albumInput.value = group.album || "";
    artistInput.value = group.artist || "";
    yearInput.value = group.year || "";
    showArt(`${api.albumArtUrl(group.id)}${artVersionQuery(group.id)}`);

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
        bumpArtVersion(currentAlbumId);
      }
      dialog.close();
      onSaved(result.tracks);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return { open };
}
