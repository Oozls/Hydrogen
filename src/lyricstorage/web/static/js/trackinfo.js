import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

const MAX_SUGGESTIONS = 8;

function distinctValues(tracks, field) {
  const seen = new Set();
  const values = [];
  for (const track of tracks) {
    const value = (track[field] || "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return values;
}

// 입력칸 아래 커스텀 자동완성 목록. 필드별로 독립적으로 동작하며(다른 필드는
// 건드리지 않음), 항목 선택은 blur보다 먼저 발생하는 mousedown으로 처리한다.
function buildAutocomplete(inputEl, listEl, getValues) {
  let highlighted = -1;

  function hide() {
    listEl.hidden = true;
    listEl.innerHTML = "";
    highlighted = -1;
  }

  function select(value) {
    inputEl.value = value;
    hide();
  }

  function render() {
    const query = inputEl.value.trim().toLowerCase();
    let matches = getValues().filter((v) => v.toLowerCase().includes(query));
    if (matches.length === 1 && matches[0].toLowerCase() === query) {
      matches = [];
    }
    matches = matches.slice(0, MAX_SUGGESTIONS);

    listEl.innerHTML = "";
    if (!matches.length) {
      hide();
      return;
    }
    matches.forEach((value, i) => {
      const li = document.createElement("li");
      li.className = "picker-row";
      li.textContent = value;
      if (i === highlighted) li.classList.add("highlighted");
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        select(value);
      });
      listEl.appendChild(li);
    });
    listEl.hidden = false;
  }

  inputEl.addEventListener("input", () => {
    highlighted = -1;
    render();
  });
  inputEl.addEventListener("focus", render);
  inputEl.addEventListener("blur", hide);
  inputEl.addEventListener("keydown", (e) => {
    if (listEl.hidden) return;
    const items = [...listEl.children];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, items.length - 1);
      items.forEach((li, i) => li.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      items.forEach((li, i) => li.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      select(items[highlighted].textContent);
    } else if (e.key === "Escape") {
      hide();
    }
  });

  return { hide };
}

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
