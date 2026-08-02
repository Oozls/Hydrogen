import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

// 업로드 직후, 표지가 없는 상태로 남은 앨범들에 대해 "곡 내부 표지 사용" 또는
// "직접 업로드" 중 하나를 고르게 하는 다이얼로그. onResolved는 앨범 표지가
// 하나라도 실제로 바뀔 때마다 호출된다(호출한 쪽이 목록/재생바 아트를 새로고침할 수 있게).
export function setupAlbumArtPrompt() {
  const dialog = document.getElementById("album-art-prompt-dialog");
  const listEl = document.getElementById("album-art-prompt-list");
  const closeBtn = document.getElementById("album-art-prompt-close");
  const fileInput = document.getElementById("album-art-prompt-file-input");

  let pendingUploadAlbumId = null;
  let onResolved = null;

  function markResolved(li) {
    li.classList.add("resolved");
    const actions = li.querySelector(".album-art-prompt-actions");
    actions.innerHTML = "";
    const done = document.createElement("span");
    done.className = "album-art-prompt-done";
    done.textContent = "설정됨";
    actions.appendChild(done);
  }

  function buildRow(album) {
    const li = document.createElement("li");
    li.className = "album-art-prompt-row";
    li.dataset.albumId = album.album_id;

    const info = document.createElement("div");
    info.className = "album-art-prompt-info";
    const name = document.createElement("div");
    name.className = "album-art-prompt-name";
    name.textContent = album.name || "(앨범 없음)";
    const artist = document.createElement("div");
    artist.className = "album-art-prompt-artist";
    artist.textContent = album.artist || "";
    info.appendChild(name);
    info.appendChild(artist);
    li.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "album-art-prompt-actions";

    const useTrackBtn = document.createElement("button");
    useTrackBtn.type = "button";
    useTrackBtn.textContent = "곡 표지 사용";
    useTrackBtn.disabled = !album.has_embedded_art;
    useTrackBtn.title = album.has_embedded_art ? "" : "이 앨범엔 표지가 있는 곡이 없습니다";
    useTrackBtn.addEventListener("click", async () => {
      useTrackBtn.disabled = true;
      uploadBtn.disabled = true;
      try {
        await api.useTrackArtForAlbum(album.album_id);
        markResolved(li);
        if (onResolved) onResolved();
      } catch (err) {
        useTrackBtn.disabled = false;
        uploadBtn.disabled = false;
        await alertDialog(err.message);
      }
    });
    actions.appendChild(useTrackBtn);

    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.textContent = "직접 업로드";
    uploadBtn.addEventListener("click", () => {
      pendingUploadAlbumId = album.album_id;
      fileInput.value = "";
      fileInput.click();
    });
    actions.appendChild(uploadBtn);

    li.appendChild(actions);
    return li;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    const albumId = pendingUploadAlbumId;
    pendingUploadAlbumId = null;
    if (!file || !albumId) return;
    try {
      await api.uploadAlbumArt(albumId, file);
      const li = listEl.querySelector(`[data-album-id="${albumId}"]`);
      if (li) markResolved(li);
      if (onResolved) onResolved();
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  closeBtn.addEventListener("click", () => dialog.close());

  function open(albums, onResolvedCallback) {
    if (!albums || !albums.length) return;
    onResolved = onResolvedCallback || null;
    listEl.innerHTML = "";
    albums.forEach((album) => listEl.appendChild(buildRow(album)));
    dialog.showModal();
  }

  return { open };
}
