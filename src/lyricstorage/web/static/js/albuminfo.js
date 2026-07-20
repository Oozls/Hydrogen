import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

export function setupAlbumInfo(onSaved) {
  const dialog = document.getElementById("album-info-dialog");
  const artPreview = document.getElementById("album-info-art-preview");
  const artPlaceholder = document.getElementById("album-info-art-placeholder");
  const artBtn = document.getElementById("album-info-art-btn");
  const artInput = document.getElementById("album-info-art-input");
  const albumInput = document.getElementById("album-info-album");
  const artistText = document.getElementById("album-info-artist");
  const trackList = document.getElementById("album-info-track-list");
  const saveBtn = document.getElementById("album-info-save");
  const cancelBtn = document.getElementById("album-info-cancel");

  let originalAlbum = null;
  let originalArtist = null;
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

  function open(group) {
    originalAlbum = group.album;
    originalArtist = group.artist;
    pendingArtFile = null;
    albumInput.value = group.album || "";
    artistText.textContent = group.artist || "(아티스트 없음)";
    showArt(`${api.artUrl(group.track_id)}?t=${Date.now()}`);

    trackList.innerHTML = "";
    for (const track of group.tracks) {
      const row = document.createElement("div");
      row.className = "album-info-track-row";
      row.textContent = track.title || track.track_id;
      trackList.appendChild(row);
    }
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
    const newAlbum = albumInput.value.trim();
    if (!newAlbum) {
      await alertDialog("앨범명을 입력하세요.");
      return;
    }
    try {
      const result = await api.updateAlbum(originalAlbum, originalArtist, newAlbum, pendingArtFile);
      dialog.close();
      onSaved(result.tracks);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return { open };
}
