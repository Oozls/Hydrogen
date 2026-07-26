import { api } from "./api.js";
import { alertDialog, confirmDialog } from "./dialog.js";
import { distinctValues, buildAutocomplete } from "./autocomplete.js";
import { showArtSpinner } from "./artspinner.js";

// onSaved(updatedTracks, trackIds): 저장 성공 시 호출된다. updatedTracks는
// 메타데이터(title/artist/album) 중 하나라도 dirty해서 실제로 PUT된 경우에만
// api.updateTrackMetadataBatch가 반환한 갱신 트랙 배열이고, 메타데이터 변경 없이
// 표지 이미지만 바꾼 경우에는 빈 배열이다. trackIds는 이번에 저장이 적용된 선택 곡
// 전체 id 배열(메타데이터/아트 여부와 무관하게 항상 채워짐) — 표지만 바뀐 경우에도
// 재생 중인 곡의 아트 캐시를 무효화하려면 이 값을 사용해야 한다.
// onDeleted(trackIds): "전체 삭제" 성공 시 삭제된 트랙 id 배열을 전달(재생목록/브라우즈
// 갱신 및 재생 중이던 곡 정지는 호출자 책임).
export function setupBulkEdit(onSaved, onDeleted) {
  const dialog = document.getElementById("bulk-edit-dialog");
  const countEl = document.getElementById("bulk-edit-count");
  const artPreview = document.getElementById("bulk-edit-art-preview");
  const artPlaceholder = document.getElementById("bulk-edit-art-placeholder");
  const artBtn = document.getElementById("bulk-edit-art-btn");
  const artInput = document.getElementById("bulk-edit-art-input");
  const saveBtn = document.getElementById("bulk-edit-save");
  const cancelBtn = document.getElementById("bulk-edit-cancel");
  const deleteBtn = document.getElementById("bulk-edit-delete");

  const fields = [
    { key: "title", input: document.getElementById("bulk-edit-title"), dirty: false },
    { key: "artist", input: document.getElementById("bulk-edit-artist"), dirty: false },
    { key: "album", input: document.getElementById("bulk-edit-album"), dirty: false },
  ];

  let trackIds = [];
  let pendingArtFile = null;
  let libraryValues = { title: [], artist: [], album: [] };

  const autocompletes = fields.map((field) =>
    buildAutocomplete(
      field.input,
      document.getElementById(`bulk-edit-${field.key}-suggestions`),
      () => libraryValues[field.key]
    )
  );

  for (const field of fields) {
    field.input.addEventListener("input", () => {
      field.dirty = true;
    });
  }

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

  function resetArt() {
    pendingArtFile = null;
    artPreview.style.display = "none";
    artPreview.removeAttribute("src");
    artPlaceholder.style.display = "";
  }

  artBtn.addEventListener("click", () => artInput.click());
  artInput.addEventListener("change", () => {
    const file = artInput.files[0];
    if (!file) return;
    pendingArtFile = file;
    showArt(URL.createObjectURL(file));
  });

  function hideAllAutocompletes() {
    for (const ac of autocompletes) ac.hide();
  }

  async function open(ids) {
    trackIds = Array.from(new Set(ids));
    if (!trackIds.length) return;

    resetArt();
    artInput.value = "";
    countEl.textContent = `선택한 ${trackIds.length}곡에 적용됩니다.`;

    const library = await api.getLibrary();
    const selected = library.tracks.filter((t) => trackIds.includes(t.track_id));

    for (const field of fields) {
      field.dirty = false;
      const values = new Set(selected.map((t) => (t[field.key] || "").trim()));
      if (values.size === 1) {
        field.input.value = [...values][0];
        field.input.placeholder = "";
      } else {
        field.input.value = "";
        field.input.placeholder = "...";
      }
    }

    libraryValues = {
      title: distinctValues(library.tracks, "title"),
      artist: distinctValues(library.tracks, "artist"),
      album: distinctValues(library.tracks, "album"),
    };

    dialog.showModal();
  }

  cancelBtn.addEventListener("click", () => {
    hideAllAutocompletes();
    dialog.close();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!trackIds.length) return;
    if (
      !(await confirmDialog(
        `선택한 ${trackIds.length}곡을 모든 재생목록과 라이브러리에서 완전히 삭제할까요? 파일도 함께 삭제되며 되돌릴 수 없습니다.`
      ))
    )
      return;
    try {
      const deletedIds = trackIds;
      const result = await api.deleteTracksBatch(deletedIds);
      hideAllAutocompletes();
      dialog.close();
      onDeleted(result.deleted || deletedIds);
      if (result.errors && result.errors.length) {
        await alertDialog(`${result.errors.length}곡은 삭제하지 못했습니다.`);
      }
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    const patch = {};
    for (const field of fields) {
      if (!field.dirty) continue;
      const value = field.input.value.trim();
      if (field.key === "title" && !value) {
        await alertDialog("제목을 입력하세요.");
        return;
      }
      patch[field.key] = value;
    }
    if (!Object.keys(patch).length && !pendingArtFile) {
      await alertDialog("적용할 항목을 하나 이상 입력하세요.");
      return;
    }

    try {
      let updated = [];
      if (Object.keys(patch).length) {
        const result = await api.updateTrackMetadataBatch(trackIds, patch);
        updated = result.updated;
        if (result.errors && result.errors.length) {
          await alertDialog(`${result.errors.length}곡은 수정하지 못했습니다.`);
        }
      }
      if (pendingArtFile) {
        await Promise.all(trackIds.map((trackId) => api.uploadTrackArt(trackId, pendingArtFile)));
      }
      hideAllAutocompletes();
      dialog.close();
      onSaved(updated, trackIds);
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return { open };
}
