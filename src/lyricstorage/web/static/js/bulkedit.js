import { api } from "./api.js";
import { alertDialog } from "./dialog.js";

export function setupBulkEdit(onSaved) {
  const dialog = document.getElementById("bulk-edit-dialog");
  const countEl = document.getElementById("bulk-edit-count");
  const saveBtn = document.getElementById("bulk-edit-save");
  const cancelBtn = document.getElementById("bulk-edit-cancel");

  const fields = [
    {
      key: "title",
      apply: document.getElementById("bulk-edit-title-apply"),
      input: document.getElementById("bulk-edit-title"),
    },
    {
      key: "artist",
      apply: document.getElementById("bulk-edit-artist-apply"),
      input: document.getElementById("bulk-edit-artist"),
    },
    {
      key: "album",
      apply: document.getElementById("bulk-edit-album-apply"),
      input: document.getElementById("bulk-edit-album"),
    },
  ];

  let trackIds = [];

  for (const field of fields) {
    field.apply.addEventListener("change", () => {
      field.input.disabled = !field.apply.checked;
      if (field.apply.checked) field.input.focus();
    });
  }

  function resetForm() {
    for (const field of fields) {
      field.apply.checked = false;
      field.input.value = "";
      field.input.disabled = true;
    }
  }

  function open(ids) {
    trackIds = Array.from(new Set(ids));
    if (!trackIds.length) return;
    resetForm();
    countEl.textContent = `선택한 ${trackIds.length}곡에 적용됩니다.`;
    dialog.showModal();
  }

  cancelBtn.addEventListener("click", () => dialog.close());

  saveBtn.addEventListener("click", async () => {
    const patch = {};
    for (const field of fields) {
      if (!field.apply.checked) continue;
      const value = field.input.value.trim();
      if (field.key === "title" && !value) {
        await alertDialog("제목을 입력하세요.");
        return;
      }
      patch[field.key] = value;
    }
    if (!Object.keys(patch).length) {
      await alertDialog("적용할 항목을 하나 이상 선택하세요.");
      return;
    }

    try {
      const result = await api.updateTrackMetadataBatch(trackIds, patch);
      dialog.close();
      onSaved(result.updated);
      if (result.errors && result.errors.length) {
        await alertDialog(`${result.errors.length}곡은 수정하지 못했습니다.`);
      }
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return { open };
}
