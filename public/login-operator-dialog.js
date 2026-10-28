// Shared by the tool UI and the profile's F9 overlay. All names are text, never HTML.
window.openLoginOperatorDialog = async function (request) {
  if (document.getElementById("tool-login-operator-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "tool-login-operator-dialog";
  dialog.style.cssText = "color:#172033;background:white;border:1px solid #64748b;border-radius:12px;padding:24px;width:min(560px,85vw);font:15px sans-serif;z-index:2147483647";
  const title = document.createElement("h3"); title.textContent = "Sửa tên & đóng riêng profile (F9)";
  const profile = document.createElement("p"); profile.textContent = "Đang đọc tên hiện tại…";
  const label = document.createElement("label"); label.textContent = "Tên mới";
  const input = document.createElement("input"); input.disabled = true; input.style.cssText = "display:block;width:100%;box-sizing:border-box;padding:10px;margin:12px 0;color:#172033;background:white";
  const message = document.createElement("p"); message.style.color = "#b91c1c";
  const save = document.createElement("button"); save.textContent = "Lưu tên & đóng profile"; save.disabled = true;
  const cancel = document.createElement("button"); cancel.textContent = "Hủy — giữ profile tạm dừng"; cancel.style.marginLeft = "12px";
  dialog.append(title, profile, label, input, message, save, cancel); document.body.append(dialog); dialog.showModal();
  let data, saving = false;
  const close = () => { dialog.close(); dialog.remove(); };
  cancel.onclick = close;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!saving) close(); });
  try {
    data = await request({ action: "open" });
    profile.textContent = `Profile: ${data.profileId}\nTên hiện tại: ${data.name}`; profile.style.whiteSpace = "pre-wrap";
    input.value = data.name; save.disabled = input.disabled = false; input.focus(); input.select();
  } catch (error) { message.textContent = error.message; }
  save.onclick = async () => {
    if (!data || saving) return;
    saving = true; save.disabled = cancel.disabled = input.disabled = true;
    message.textContent = "Đang lưu GPM và Sheet…";
    try {
      await request({ action: "save", token: data.token, name: input.value });
      close();
    } catch (error) {
      message.textContent = error.message;
      saving = false; save.disabled = cancel.disabled = input.disabled = false;
    }
  };
};
