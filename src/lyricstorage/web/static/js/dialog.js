const dialog = document.getElementById("confirm-dialog");
const messageEl = document.getElementById("confirm-dialog-message");
const okBtn = document.getElementById("confirm-dialog-ok");
const cancelBtn = document.getElementById("confirm-dialog-cancel");

export function confirmDialog(message) {
  return new Promise((resolve) => {
    messageEl.textContent = message;
    const cleanup = (result) => {
      dialog.close();
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel); // Esc로 닫는 경우
    dialog.showModal();
  });
}
