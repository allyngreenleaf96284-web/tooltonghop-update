import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const dialogScript = readFileSync(new URL("../public/login-operator-dialog.js", import.meta.url), "utf8");
export function createLoginOperator(runtime, pauseControl) {
  const profiles = new Map();
  function request(id, input = {}) {
    return pauseControl.runManual(() => performRequest(id, input));
  }
  async function performRequest(id, input) {
    const state = profiles.get(id);
    if (!state || state.done || state.job.status !== "running") throw new Error("Profile nay khong con trong luong Tool Login.");
    if (state.job.loginRetryRequested) throw new Error("Profile dang khoi dong lai bang F10.");
    pauseControl.setLocal(id, true);
    if (input.action === "open") {
      if (state.saving) throw new Error("Dang luu profile nay.");
      await state.renameIdle?.();
      const profile = await state.manager.getProfileById(id);
      if (typeof profile?.name !== "string") throw new Error("Khong doc duoc ten hien tai tu GPM/HideMyAcc. Hay thu lai.");
      state.token = randomUUID(); state.expected = profile.name;
      return { profileId: id, name: profile.name, token: state.token };
    }
    if (input.action !== "save" || !input.token || input.token !== state.token) throw new Error("Hop sua ten da cu. Hay mo lai bang F9.");
    if (state.saving) throw new Error("Dang luu profile nay, vui long doi.");
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Ten profile khong duoc de trong.");
    state.saving = true;
    try {
      if (runtime.stopRequested) throw new Error("Tool da nhan lenh dung han.");
      await state.renameIdle?.();
      const current = await state.manager.getProfileById(id);
      if (current?.name !== state.expected && current?.name !== state.savedName) throw new Error("Ten GPM da thay doi. Hay huy va bam F9 de doc lai ten moi.");
      // Manual naming is authoritative; don't reapply automated error prefixes.
      state.manager.__captchaProfileNames?.delete(String(id));
      state.manager.__marketplaceBlockedNames?.delete(String(id));
      await state.manager.updateProfileName(id, name);
      const verified = await state.manager.getProfileById(id);
      if (verified?.name !== name) throw new Error("GPM chua xac nhan luu dung ten; giu profile de thu lai.");
      state.savedName = name;
      const update = { Tool: "tool login", trangThai: "Đã xử lý thủ công", chiTiet: "Nguoi dung doi ten va dong profile bang F9", tenChuan: name, "tên profile hiện tại": name };
      await state.writer.commit(update);
      const closed = await state.manager.stopHideMyAccProfile(id);
      if (closed === false || closed?.success === false) throw new Error("Da luu ten nhung chua dong duoc profile. Hay thu lai.");
      state.closedByOperator = true;
      state.done = true;
      Object.assign(state.job, { manualHandled: true, currentName: name, result: update, liveStatus: "Đã xử lý thủ công", loginNeedsAttention: false });
      pauseControl.finish(id);
      return { saved: true, profileId: id, name };
    } catch (error) {
      state.job.liveStatus = `Chờ xử lý: ${error.message}`;
      throw error;
    } finally { state.saving = false; }
  }
  async function attach(page, id) {
    await page.exposeFunction("__toolLoginOperator", (input) => request(id, input));
    const install = `${dialogScript}\nif (!window.__toolLoginF9Installed) {
      window.__toolLoginF9Installed = true;
      addEventListener('keydown', event => {
        if (event.code !== 'F9' || event.repeat) return;
        event.preventDefault(); event.stopImmediatePropagation();
        window.openLoginOperatorDialog(input => window.__toolLoginOperator(input));
      }, true);
    }`;
    await page.evaluateOnNewDocument(install);
    await page.evaluate(install);
  }
  return { request, attach,
    register: (id, state) => profiles.set(id, state),
    get: (id) => profiles.get(id),
    remove: (id) => profiles.delete(id)
  };
}
