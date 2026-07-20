const dialog = document.getElementById("confirm-dialog");
const messageEl = document.getElementById("confirm-dialog-message");
const inputEl = document.getElementById("confirm-dialog-input");
const okBtn = document.getElementById("confirm-dialog-ok");
const cancelBtn = document.getElementById("confirm-dialog-cancel");

function open({ message, showInput, defaultValue = "", showCancel }) {
  return new Promise((resolve) => {
    messageEl.textContent = message;
    inputEl.hidden = !showInput;
    inputEl.value = showInput ? defaultValue : "";
    cancelBtn.style.display = showCancel ? "" : "none";

    const cleanup = (result) => {
      dialog.close();
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      inputEl.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(showInput ? inputEl.value : true);
    const onCancel = () => cleanup(showInput ? null : false);
    const onKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel); // Esc로 닫는 경우
    if (showInput) inputEl.addEventListener("keydown", onKeydown);

    dialog.showModal();
    if (showInput) {
      inputEl.focus();
      inputEl.select();
    }
  });
}

export function confirmDialog(message) {
  return open({ message, showInput: false, showCancel: true });
}

export function promptDialog(message, defaultValue = "") {
  return open({ message, showInput: true, defaultValue, showCancel: true });
}

export function alertDialog(message) {
  return open({ message, showInput: false, showCancel: false }).then(() => undefined);
}
