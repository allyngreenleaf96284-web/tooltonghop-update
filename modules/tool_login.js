import { buildStandardName } from "./profile_name.js";
import {
  buildRuntimeProfileName,
  ensureMarketplaceCreatePageReady,
  ensureUsMarketplaceLocation,
  mapFullError,
  profileUid,
  stableBarValue,
  stripResolvedNamePrefixes
} from "./lamfull.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampConcurrency(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
  return Math.max(1, Math.min(4, parsed));
}

function expandSheetUpdate(update) {
  const next = { ...update };
  for (const [internalKey, sheetKey] of [
    ["trangThai", "trạng thái"],
    ["soVach", "số vạch"],
    ["chiTiet", "chi tiết"],
    ["diaChiBanDau", "địa chỉ ban đầu"],
    ["tenChuan", "tên chuẩn"]
  ]) {
    if (Object.prototype.hasOwnProperty.call(next, internalKey)) next[sheetKey] = next[internalKey];
    if (Object.prototype.hasOwnProperty.call(next, sheetKey)) next[internalKey] = next[sheetKey];
  }
  return next;
}

function createDeferredSheetWriter(sheetSession, profileId) {
  let pending = null;
  return {
    async update(update) {
      pending = { ...(pending || {}), ...expandSheetUpdate(update) };
    },
    async commit(update = null) {
      const finalUpdate = update ? { ...(pending || {}), ...expandSheetUpdate(update) } : pending;
      pending = null;
      if (!finalUpdate) return 0;
      return sheetSession.updateOne(profileId, finalUpdate);
    },
    discard() {
      pending = null;
    }
  };
}

function detectBar(state) {
  if (state?.kind === "publish_only") return "2v";
  if (state?.kind !== "progress") {
    throw new Error("Khong nhan dien duoc man hinh check vach Marketplace.");
  }
  const total = Number(state.totalSteps);
  if (![2, 3, 4].includes(total)) {
    throw new Error(`So vach Marketplace khong hop le: ${state.totalSteps || "trong"}.`);
  }
  return `${total}v`;
}

function tileBounds(workerSlot, workerTotal, screenWidth, screenHeight, screenLeft = 0, screenTop = 0) {
  const total = Math.max(1, Number(workerTotal || 1));
  const columns = total <= 2 ? total : Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / columns);
  const column = workerSlot % columns;
  const row = Math.floor(workerSlot / columns);
  const cellWidth = Math.floor(screenWidth / columns);
  const cellHeight = Math.floor(screenHeight / rows);
  return {
    left: screenLeft + column * cellWidth,
    top: screenTop + row * cellHeight,
    width: column === columns - 1 ? screenWidth - column * cellWidth : cellWidth,
    height: row === rows - 1 ? screenHeight - row * cellHeight : cellHeight
  };
}

async function applyViewport(browser, page, workerSlot, workerTotal) {
  const screen = await page.evaluate(() => ({
    width: window.screen.availWidth || window.screen.width,
    height: window.screen.availHeight || window.screen.height,
    left: window.screen.availLeft || 0,
    top: window.screen.availTop || 0
  })).catch(() => ({ width: 1920, height: 1080, left: 0, top: 0 }));
  const bounds = tileBounds(workerSlot, workerTotal, screen.width, screen.height, screen.left, screen.top);
  let session;
  try {
    session = await page.createCDPSession();
    const windowInfo = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId: windowInfo.windowId,
      bounds: { windowState: "normal", left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
    });
  } catch {
    try { await browser?.window?.setBounds?.(bounds); } catch {}
  } finally {
    await session?.detach?.().catch(() => {});
  }
  await page.setViewport?.({
    width: Math.max(320, bounds.width - 20),
    height: Math.max(240, bounds.height - 100),
    deviceScaleFactor: 1
  }).catch(() => {});
  return bounds;
}

export function createToolLogin({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, { tool: "tool login", step, detail });
  }

  async function step(profileId, job, name, action, timeoutMs = 0) {
    if (runtime.stopRequested) {
      const error = new Error("Da nhan lenh dung han.");
      error.status = "stopped";
      throw error;
    }
    if (job) job.liveStatus = name;
    log(profileId, name, `bat dau: ${name}`);
    try {
      const execution = Promise.resolve().then(action);
      const result = timeoutMs
        ? await Promise.race([
          execution,
          sleep(timeoutMs).then(() => {
            const error = new Error(`buoc \"${name}\" treo qua ${Math.round(timeoutMs / 1000)}s`);
            error.status = "loi";
            throw error;
          })
        ])
        : await execution;
      log(profileId, name, `xong: ${name}`, "success");
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause || "loi khong ro"));
      error.step = error.step || name;
      error.message = `Loi o buoc \"${name}\": ${error.message}`;
      log(profileId, name, error.message, "error");
      throw error;
    }
  }

  async function rename(manager, profileId, nextName) {
    if (!nextName) return;
    await manager.updateProfileName(profileId, nextName);
  }

  async function readProfileName(manager, profileId, fallback) {
    const profile = await manager.getProfileById(profileId).catch(() => null);
    return String(profile?.name || fallback || profileId).trim();
  }

  async function readBar(manager, page) {
    let lastState = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      lastState = await manager.detectInitialMarketplaceState(page);
      try {
        return detectBar(lastState);
      } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(2000);
      }
    }
    return detectBar(lastState);
  }

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot, workerTotal) {
    const manager = getManager({ fresh: true });
    if (typeof manager.getProfileById !== "function") {
      manager.getProfileById = async (id) => {
        const profiles = await manager.listProfiles();
        return profiles.find((profile) => String(profile?.id || "") === String(id || "")) || null;
      };
    }
    const row = buildToolRow(profileId, sheetRow);
    const uid = profileUid(row, profileId);
    const job = runtime.jobs.get(profileId);
    const writer = createDeferredSheetWriter(sheetSession, profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    let currentName = String(sheetRow["tên profile hiện tại"] || sheetRow["ten profile hien tai"] || profileId).trim();
    let originalName = currentName;
    let barStatus = "";
    const location = { initial: "", current: "" };

    try {
      job.status = "running";
      const profileInfo = await step(profileId, job, "kiem tra profile", () => manager.getProfileById(profileId), 30000);
      currentName = String(profileInfo?.name || currentName).trim();
      originalName = currentName;
      const browserType = String(profileInfo?.browserType || "").toLowerCase();
      const browserSource = String(profileInfo?.browserSource || "").toLowerCase();
      if ((browserType && browserType !== "chrome") || browserSource === "ghosty") {
        const error = new Error(browserSource === "ghosty" ? "HideMyAcc profile browserSource=ghosty." : `HideMyAcc profile browserType=${browserType}.`);
        error.status = "loipb";
        throw error;
      }

      await writer.update({ Tool: "tool login", trangThai: "", chiTiet: "dang dang nhap va check vach" });
      proxyLease = await step(profileId, job, "gan proxy bang", () => stateProxy?.ensureForProfile?.({
        config,
        profileId,
        row,
        log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
      }), 180000);

      await step(profileId, job, "mo profile", async () => {
        browser = await manager.connectBrowser(profileId);
        page = await browser.newPage();
        await page.bringToFront().catch(() => {});
        if (typeof manager.maximizeBrowserWindow === "function") await manager.maximizeBrowserWindow(browser, page).catch(() => {});
        await applyViewport(browser, page, workerSlot, workerTotal);
      }, 120000);

      await step(profileId, job, "dang nhap Facebook", () => dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
        if (job) job.liveStatus = status;
        if (!String(status || "").startsWith("2FA: đang chờ") && !String(status || "").startsWith("2FA: đã chờ")) {
          log(profileId, "dang nhap Facebook", status);
        }
      }), 900000);

      currentName = await step(profileId, job, "quet ten profile", () => readProfileName(manager, profileId, currentName), 30000);
      const cleanedName = stripResolvedNamePrefixes(currentName);
      if (cleanedName !== currentName) {
        await step(profileId, job, "xoa prefix loi cu", () => rename(manager, profileId, cleanedName), 30000);
        currentName = cleanedName;
      }

      const resolved = await step(profileId, job, "kiem tra va doi bang My", () => ensureUsMarketplaceLocation(manager, page, row), 180000);
      location.initial = String(resolved?.initialLocation || "").trim();
      location.current = String(resolved?.currentLocation || location.initial).trim();
      if (location.initial) await writer.update({ diaChiBanDau: location.initial });

      await step(profileId, job, "vao man hinh check vach", () => ensureMarketplaceCreatePageReady(manager, page, row), 150000);
      barStatus = await step(profileId, job, "check vach", () => readBar(manager, page), 45000);

      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid,
        soVach: barStatus,
        location: location.current || location.initial
      });
      await step(profileId, job, "doi ten profile", () => rename(manager, profileId, tenChuan), 30000);
      const update = {
        Tool: "tool login",
        trangThai: "thành công",
        soVach: barStatus,
        chiTiet: `da dang nhap, location ${location.current || "My"}, check ${barStatus}`,
        tenChuan
      };
      if (location.initial) update.diaChiBanDau = location.initial;
      await writer.commit(update);
      job.status = "success";
      job.result = update;
      job.liveStatus = `da xong ${barStatus}`;
      return update;
    } catch (error) {
      const mapped = mapFullError(error);
      if (mapped.status === "stopped") {
        writer.discard();
        await rename(manager, profileId, originalName).catch(() => {});
        job.status = "stopped";
        job.liveStatus = "da dung han";
        return { stopped: true };
      }
      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid,
        soVach: stableBarValue(currentName, sheetRow, barStatus),
        location: location.current || location.initial
      });
      await rename(manager, profileId, buildRuntimeProfileName({ status: mapped.status, tenChuan })).catch(() => {});
      const update = {
        Tool: "tool login",
        trangThai: "loi",
        soVach: stableBarValue(currentName, sheetRow, barStatus),
        chiTiet: mapped.detail,
        tenChuan
      };
      if (location.initial) update.diaChiBanDau = location.initial;
      await writer.commit(update);
      job.status = "error";
      job.liveStatus = mapped.detail;
      job.result = update;
      log(profileId, error.step || "loi tong", `loi tool login: ${mapped.detail}`, "error");
      return update;
    } finally {
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      try { stateProxy?.release?.(proxyLease); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runQueue(profileIds, config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set((profileIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");
    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampConcurrency(config.loginConcurrency, 4), ids.length);
    for (const id of ids) {
      runtime.jobs.set(id, { profileId: id, tool: "tool login", status: "queued", liveStatus: `dang cho ${concurrency} luong`, logs: [], startedAt: "", finishedAt: "", result: null, sheetWriteError: "" });
    }
    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "tool login";
    setImmediate(async () => {
      try {
        let cursor = 0;
        const nextId = () => !runtime.stopRequested && cursor < ids.length ? ids[cursor++] : "";
        const workers = Array.from({ length: concurrency }, async (_, workerSlot) => {
          for (;;) {
            const id = nextId();
            if (!id) break;
            const job = runtime.jobs.get(id);
            const row = sheetSession.rows.get(id);
            if (!row) {
              const update = { Tool: "tool login", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id Hide." };
              if (job) Object.assign(job, { status: "error", liveStatus: update.chiTiet, finishedAt: new Date().toISOString(), result: update });
              continue;
            }
            if (job) job.startedAt = new Date().toISOString();
            await runOne(id, row, config, sheetSession, workerSlot, concurrency);
          }
        });
        await Promise.all(workers);
        await sheetSession.flushAll();
      } catch (error) {
        addRuntimeLog(`Loi queue tool login: ${error.message}`, "error", "", { tool: "tool login", step: "queue" });
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });
    return { started: ids.length, concurrency };
  }

  return { runQueue };
}
