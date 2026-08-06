import { api } from "./api.js";
import { alertDialog } from "./dialog.js";
import { distinctValues, buildAutocomplete } from "./autocomplete.js";

// 업로드로 새로 생긴 앨범의 아티스트를 확인/수정하게 하는 다이얼로그. 새 앨범의
// 아티스트는 일단 곡 아티스트로 추측해 채워두는데(albums.get_or_create_album),
// 컴필레이션 앨범 등 추측이 틀릴 수 있어 사용자가 바로 확인/수정할 수 있게 한다.
// onResolved는 앨범 아티스트가 실제로 저장될 때마다 호출된다.
export function setupAlbumArtistPrompt() {
  const dialog = document.getElementById("album-artist-prompt-dialog");
  const listEl = document.getElementById("album-artist-prompt-list");
  const closeBtn = document.getElementById("album-artist-prompt-close");

  let onResolved = null;
  let onClose = null;

  function markResolved(li, controls, artist) {
    controls.innerHTML = "";
    const done = document.createElement("span");
    done.className = "album-artist-prompt-done";
    done.textContent = artist ? `설정됨 · ${artist}` : "설정됨(서클 없음)";
    controls.appendChild(done);
  }

  function buildRow(album, artistValues) {
    const li = document.createElement("li");
    li.className = "album-artist-prompt-row";

    const name = document.createElement("div");
    name.className = "album-artist-prompt-name";
    name.textContent = album.name || "(앨범 없음)";
    li.appendChild(name);

    const controls = document.createElement("div");
    controls.className = "album-artist-prompt-controls";

    const inputWrap = document.createElement("div");
    inputWrap.className = "album-artist-prompt-input-wrap";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.value = album.artist || "";
    inputWrap.appendChild(input);
    const suggestions = document.createElement("ul");
    suggestions.className = "autocomplete-list";
    suggestions.hidden = true;
    inputWrap.appendChild(suggestions);
    controls.appendChild(inputWrap);

    const autocomplete = buildAutocomplete(input, suggestions, () => artistValues);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = "저장";
    saveBtn.addEventListener("click", async () => {
      const artist = input.value.trim();
      saveBtn.disabled = true;
      try {
        await api.updateAlbum(album.album_id, { name: album.name, artist, year: album.year });
        autocomplete.hide();
        markResolved(li, controls, artist);
        if (onResolved) onResolved();
      } catch (err) {
        saveBtn.disabled = false;
        await alertDialog(err.message);
      }
    });
    controls.appendChild(saveBtn);

    li.appendChild(controls);
    return li;
  }

  closeBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (onClose) onClose();
  });

  function open(newAlbums, onResolvedCallback, onCloseCallback) {
    if (!newAlbums || !newAlbums.length) return;
    onResolved = onResolvedCallback || null;
    onClose = onCloseCallback || null;
    listEl.innerHTML = "";
    // 자동완성 후보는 기존 앨범들의 아티스트명(=앨범 아티스트)에서 뽑는다 —
    // 곡 아티스트 자동완성과 같은 buildAutocomplete 메커니즘을 그대로 쓰되,
    // 데이터 출처만 앨범 아티스트로 다르다.
    api
      .getAlbums()
      .then(({ albums }) => {
        const artistValues = distinctValues(albums, "artist");
        newAlbums.forEach((album) => listEl.appendChild(buildRow(album, artistValues)));
      })
      .catch(() => {
        newAlbums.forEach((album) => listEl.appendChild(buildRow(album, [])));
      });
    dialog.showModal();
  }

  return { open };
}
