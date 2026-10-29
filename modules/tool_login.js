import { buildStandardName } from "./profile_name.js";
import { createLoginPause } from "./login_pause.js";
import { createLoginOperator } from "./login_operator.js";
import {
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

export function createLiveSheetWriter(sheetSession, profileId) {
  let tail = Promise.resolve();
  return {
    update(update) {
      const work = tail.then(() => {
        if (sheetSession.rows instanceof Map && !sheetSession.rows.has(profileId)) throw new Error("Khong tim thay dong profile trong Sheet; can nap lai du lieu Sheet.");
        return sheetSession.updateOne(profileId, expandSheetUpdate(update));
      });
      tail = work.catch(() => {});
      return work;
    },
    async commit(update = null) {
      if (update) await this.update(update);
      await tail;
      await sheetSession.flushAll();
    },
    discard() {}
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

function tileBounds(workerSlot = 0, workerTotal = 1) {
  const total = Math.max(1, Number(workerTotal || 1));
  if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
  if (total === 2) return { left: workerSlot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
  if (total === 3) return { left: workerSlot * 640, top: 0, width: 640, height: 980 };
  return {
    left: (workerSlot % 2) * 960,
    top: Math.floor(workerSlot / 2) * 520,
    width: 960,
    height: 520
  };
}

async function readViewportMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    hidden: document.hidden,
    visibilityState: document.visibilityState
  })).catch(() => null);
}

async function applyStableViewport(page, workerSlot = 0, workerTotal = 1) {
  if (!page || page.isClosed?.()) return null;
  const bounds = tileBounds(workerSlot, workerTotal);
  const viewport = {
    width: Math.max(900, bounds.width - 24),
    height: Math.max(640, bounds.height - 110),
    deviceScaleFactor: 1
  };
  await page.setViewport?.(viewport).catch(() => {});
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
    if (document.body) document.body.style.zoom = "";
  }).catch(() => {});
  return { ...viewport, zoom: 1, bounds, actual: await readViewportMetrics(page) };
}

function patchStableWindowTiling(manager, workerSlot = 0, workerTotal = 1) {
  const original = manager.maximizeBrowserWindow;
  manager.__toolWorkerSlot = workerSlot;
  manager.__toolWorkerTotal = workerTotal;
  manager.maximizeBrowserWindow = async (browser, page = null) => {
    const targetPage = page || (await browser.pages().catch(() => []))[0];
    if (!targetPage) return original?.call(manager, browser, page);
    const bounds = tileBounds(workerSlot, workerTotal);
    let session;
    try {
      session = await targetPage.createCDPSession();
      const windowInfo = await session.send("Browser.getWindowForTarget").catch(() => null);
      if (windowInfo?.windowId !== undefined) {
        await session.send("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "normal", left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
        });
      }
      await applyStableViewport(targetPage, workerSlot, workerTotal);
    } catch {
      await original?.call(manager, browser, page).catch(() => {});
    } finally {
      await session?.detach?.().catch(() => {});
    }
  };
}

function clearTwofaCountdown(job) {
  if (!job) return;
  job.twofaCountdownStartedAt = 0;
  job.twofaCountdownEndsAt = 0;
  job.twofaWaitingForInput = false;
}

function updateTwofaCountdown(job, meta) {
  if (!job || !meta?.twofaActive) return;
  job.twofaCountdownStartedAt = Number(meta.twofaCountdownStartedAt || 0);
  job.twofaCountdownEndsAt = Number(meta.twofaCountdownEndsAt || 0);
  job.twofaWaitingForInput = Boolean(meta.twofaWaitingForInput);
}

export function createToolLogin({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  runFullProfile = null,
  stateProxy,
  runtime
}) {
  const pauseControl = createLoginPause(runtime, { onChange: (id, job) => {
    const live = operator.get(id);
    if (!live || live.done || job.manualHandled) return;
    void live.writer.update({ trangThai: job.loginNeedsAttention ? "chờ xử lý" : job.loginPaused ? "tạm dừng" : "đang chạy", chiTiet: job.liveStatus }).catch((error) => { job.sheetWriteError = error.message; });
  } });
  const operator = createLoginOperator(runtime, pauseControl);
  const restartLeases = new Map();
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, { tool: "tool login", step, detail });
  }

  async function step(profileId, job, name, action, timeoutMs = 0) {
    let resumedFromError = false;
    for (;;) {
    if (runtime.stopRequested) {
      const error = new Error("Da nhan lenh dung han.");
      error.status = "stopped";
      throw error;
    }
    if (job) {
      job.liveStatus = name;
      if (name !== "dang nhap Facebook") clearTwofaCountdown(job);
    }
    log(profileId, name, `bat dau: ${name}`);
    try {
      const live = operator.get(profileId);
      await live?.writer.update({ Tool: "tool login", trangThai: "đang chạy", chiTiet: name });
      const result = await pauseControl.run(profileId, action, timeoutMs,
        ["dang nhap Facebook", "kiem tra va doi bang My", "vao man hinh check vach", "check vach"].includes(name), resumedFromError);
      log(profileId, name, `xong: ${name}`, "success");
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause || "loi khong ro"));
      if (error.code === "LOGIN_RETRY" || error.code === "LOGIN_MANUAL_DONE" || (error.status === "stopped" && runtime.stopRequested)) throw error;
      error.step = error.step || name;
      error.message = `Loi o buoc \"${name}\": ${error.message}`;
      log(profileId, name, error.message, "error");
      job.loginNeedsAttention = true;
      job.liveStatus = `Chờ bạn xử lý — ${error.message}`;
      clearTwofaCountdown(job);
      pauseControl.setLocal(profileId, true);
      await operator.get(profileId)?.writer.commit({ trangThai: "chờ xử lý", chiTiet: error.message }).catch((sheetError) => { job.sheetWriteError = sheetError.message; });
      await pauseControl.gate(profileId);
      job.loginNeedsAttention = false;
      resumedFromError = true;
    }
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
    patchStableWindowTiling(manager, workerSlot, workerTotal);
    if (typeof manager.getProfileById !== "function") {
      manager.getProfileById = async (id) => {
        const profiles = await manager.listProfiles();
        return profiles.find((profile) => String(profile?.id || "") === String(id || "")) || null;
      };
    }
    const row = buildToolRow(profileId, sheetRow);
    const uid = profileUid(row, profileId);
    const job = runtime.jobs.get(profileId);
    const writer = createLiveSheetWriter(sheetSession, profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    let currentName = String(sheetRow["tên profile hiện tại"] || sheetRow["ten profile hien tai"] || profileId).trim();
    let barStatus = "";
    const location = { initial: "", current: "" };
    let renameTail = Promise.resolve();
    const updateProfileName = manager.updateProfileName.bind(manager);
    manager.updateProfileName = (id, name, ...args) => {
      const work = renameTail.then(async () => {
        if (!pauseControl.isCurrent()) throw Object.assign(new Error("Thao tac doi ten cu da bi huy."), { code: "LOGIN_PAUSED" });
        const result = await updateProfileName(id, name, ...args);
        let actual;
        for (let attempt = 0; attempt < 5; attempt++) {
          actual = await manager.getProfileById(id);
          if (actual?.name === name) break;
          if (attempt < 4) await sleep(300);
        }
        if (typeof actual?.name !== "string") throw new Error("Khong doc lai duoc ten profile sau khi doi ten.");
        if (actual.name !== name) throw new Error("GPM/HideMyAcc chua luu dung ten yeu cau.");
        if (String(id) === String(profileId)) {
          currentName = actual.name; job.currentName = actual.name;
          await writer.update({ "tên profile hiện tại": actual.name, tenChuan: actual.name });
        }
        return result;
      });
      renameTail = work.catch(() => {});
      return work;
    };
    pauseControl.guard(manager, ["updateProfileName"]);
    operator.register(profileId, { manager, writer, job, proxyEnabled: config.stateProxyEnabled !== false, renameIdle: () => renameTail });

    try {
      job.status = "running";
      const profileInfo = await step(profileId, job, "kiem tra profile", async () => {
        const profile = await manager.getProfileById(profileId);
        if (!profile) throw new Error("Khong doc duoc profile tu GPM/HideMyAcc.");
        return profile;
      }, 30000);
      currentName = String(profileInfo?.name || currentName).trim();
      job.currentName = currentName;
      await writer.update({ "tên profile hiện tại": currentName });
      const browserType = String(profileInfo?.browserType || "").toLowerCase();
      const browserSource = String(profileInfo?.browserSource || "").toLowerCase();
      if ((browserType && browserType !== "chrome") || browserSource === "ghosty") {
        const error = new Error(browserSource === "ghosty" ? "HideMyAcc profile browserSource=ghosty." : `HideMyAcc profile browserType=${browserType}.`);
        error.status = "loipb";
        throw error;
      }

      await writer.update({ Tool: "tool login", trangThai: "", chiTiet: "dang dang nhap va check vach" });
      proxyLease = await step(profileId, job, "gan proxy bang", async () => (proxyLease = await stateProxy?.ensureForProfile?.({
        config,
        profileId,
        row,
        previousLease: restartLeases.get(profileId),
        log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
      })), 0);

      await step(profileId, job, "mo profile", async () => {
        browser = await manager.connectBrowser(profileId);
        page = await browser.newPage();
        await page.bringToFront().catch(() => {});
        if (typeof manager.maximizeBrowserWindow === "function") await manager.maximizeBrowserWindow(browser, page).catch(() => {});
        await applyStableViewport(page, workerSlot, workerTotal);
      }, 120000);
      await pauseControl.attach(page);
      await operator.attach(page, profileId);
      await page.exposeFunction("__toolLoginRetry", () => pauseControl.runManual(() => retryProfile(profileId)));
      const installRetry = () => {
        if (window.__toolLoginF10Installed) return;
        window.__toolLoginF10Installed = true;
        addEventListener("keydown", (event) => {
          if (event.code !== "F10" || event.repeat) return;
          event.preventDefault(); event.stopImmediatePropagation();
          window.__toolLoginRetry().catch((error) => alert(error.message));
        }, true);
      };
      await page.evaluateOnNewDocument(installRetry);
      await page.evaluate(installRetry);

      await step(profileId, job, "dang nhap Facebook", () => dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status, meta) => {
        if (!pauseControl.isCurrent()) return;
        if (job) {
          job.liveStatus = status;
          updateTwofaCountdown(job, meta);
        }
        const stableStatus = String(status || "").replace(/\d+/g, "#");
        if (job.lastSheetLoginStatus !== stableStatus) {
          job.lastSheetLoginStatus = stableStatus;
          void writer.update({ trangThai: "đang chạy", chiTiet: status }).catch((error) => { job.sheetWriteError = error.message; });
        }
        if (!String(status || "").startsWith("2FA: đang chờ") && !String(status || "").startsWith("2FA: đã chờ")) {
          log(profileId, "dang nhap Facebook", status);
        }
      }, { forceAccountLogin: true, holdErrorsForOperator: true, waitForManualCaptcha: config.loginWaitForManualCaptcha === true,
        resumeAfterManualCaptcha: pauseControl.resuming(),
        shouldStop: () => Boolean(runtime.stopRequested) || !pauseControl.isCurrent(),
        isActive: pauseControl.isCurrent }), config.loginWaitForManualCaptcha === true ? 0 : 900000);

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
      if (barStatus === "3v" && config.loginThreeVFull === true) {
        log(profileId, "chuyen lam full", "Da nhan dien 3v, chuyen sang luong tool Full.");
        await writer.commit({ soVach: "3v", chiTiet: "3v - dang chuyen sang lam Full" });
        return { continueWithFull: true };
      }

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
      await step(profileId, job, "luu ket qua vao Sheet", () => writer.commit(update));
      job.status = "success";
      job.result = update;
      job.liveStatus = `da xong ${barStatus}`;
      return update;
    } catch (error) {
      if (error.code === "LOGIN_RETRY" || job.loginRetryRequested) {
        restartLeases.set(profileId, proxyLease || restartLeases.get(profileId));
        return { retryCurrent: true };
      }
      if (error.code === "LOGIN_MANUAL_DONE" || job.manualHandled) {
        job.status = "skipped";
        job.liveStatus = "Đã xử lý thủ công";
        return { manualHandled: true };
      }
      const mapped = mapFullError(page?.__marketplaceAccess?.error || error);
      if (mapped.status === "stopped" && runtime.stopRequested) {
        writer.discard();
        job.status = "stopped";
        job.liveStatus = "da dung han";
        return { stopped: true };
      }
      const update = {
        Tool: "tool login",
        trangThai: "chờ xử lý",
        soVach: stableBarValue(currentName, sheetRow, barStatus),
        chiTiet: mapped.detail,
        "tên profile hiện tại": currentName
      };
      if (location.initial) update.diaChiBanDau = location.initial;
      job.loginOuterError = true;
      job.loginNeedsAttention = true;
      job.liveStatus = mapped.detail;
      job.result = update;
      log(profileId, error.step || "loi tong", `loi tool login: ${mapped.detail}`, "error");
      pauseControl.setLocal(profileId, true);
      await writer.commit(update).catch((sheetError) => { job.sheetWriteError = sheetError.message; });
      while (!job.manualHandled && !runtime.stopRequested && !job.loginRetryRequested) await sleep(100);
      job.loginOuterError = false;
      if (job.loginRetryRequested && !runtime.stopRequested) {
        restartLeases.set(profileId, proxyLease || restartLeases.get(profileId));
        return { retryCurrent: true };
      }
      job.status = job.manualHandled ? "skipped" : "stopped";
      return job.manualHandled ? { manualHandled: true } : { stopped: true };
    } finally {
      const closedByOperator = operator.get(profileId)?.closedByOperator;
      operator.remove(profileId);
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      if (!closedByOperator) {
        for (;;) {
          try {
            const closed = await manager.stopHideMyAccProfile(profileId);
            if (closed === false || closed?.success === false) throw new Error("GPM chua dong duoc profile.");
            break;
          } catch (error) {
            if (!job.loginRetryRequested || runtime.stopRequested) break;
            job.liveStatus = `F10: chờ đóng profile cũ — ${error.message}`;
            await sleep(1000);
          }
        }
      }
      try { stateProxy?.release?.(proxyLease); } catch {}
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runQueue(profileIds, config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set((profileIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");
    if (config.loginThreeVFull === true) {
      if (typeof runFullProfile !== "function") throw new Error("Chua cau hinh luong Full cho Tool Login.");
      if (!config.fullDataRoot || !config.fullPriceMin || !config.fullPriceMax || !config.sellerSpreadsheetId) {
        throw new Error("Can dien thu muc dang bai, gia min/max va Seller Info Spreadsheet ID trong tool Full truoc khi bat lam Full cho 3v.");
      }
    }
    const sheetSession = await createSheetRowSession(config, ids);
    pauseControl.reset();
    restartLeases.clear();
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
            while (runtime.loginPaused && !runtime.stopRequested) await sleep(100);
            const id = nextId();
            if (!id) break;
            const job = runtime.jobs.get(id);
            const row = sheetSession.rows.get(id) || {};
            if (job) job.startedAt = new Date().toISOString();
            let outcome;
            do {
              if (outcome?.retryCurrent) {
                pauseControl.resetProfile(id);
                job.loginRetryRequested = false;
                job.loginNeedsAttention = false;
                clearTwofaCountdown(job);
              }
              job.finishedAt = "";
              outcome = await runOne(id, sheetSession.rows.get(id) || row, config, sheetSession, workerSlot, concurrency);
            } while (outcome?.retryCurrent && !runtime.stopRequested);
            if (outcome?.continueWithFull && !runtime.stopRequested) {
              await pauseControl.gate(id);
              job.loginPauseSupported = false;
              job.loginPaused = false;
              job.finishedAt = "";
              job.liveStatus = "3v - dang chuyen sang lam Full";
              await runFullProfile(id, row, config, sheetSession, workerSlot, concurrency);
            }
          }
        });
        await Promise.all(workers);
        await sheetSession.flushAll();
        if (runtime.stopRequested) {
          for (const id of ids) {
            const job = runtime.jobs.get(id);
            if (job && ["queued", "running"].includes(job.status)) {
              job.status = "stopped";
              job.liveStatus = "da dung han";
              job.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        addRuntimeLog(`Loi queue tool login: ${error.message}`, "error", "", { tool: "tool login", step: "queue" });
      } finally {
        pauseControl.reset();
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });
    return { started: ids.length, concurrency };
  }

  function retryProfile(profileId) {
    const job = runtime.jobs.get(profileId);
    if (!runtime.running || runtime.stopRequested || job?.tool !== "tool login" ||
        job.status !== "running" || job.manualHandled || job.loginPauseSupported === false) {
      throw new Error("Profile khong dang o luong Tool Login.");
    }
    if (operator.get(profileId)?.proxyEnabled === false) throw new Error("Can bat Proxy theo bang de F10 doi proxy va chay lai.");
    if (job.loginRetryRequested) return { retrying: true };
    if (operator.get(profileId)?.saving) throw new Error("Dang luu ten F9; hay doi luu xong.");
    job.loginRetryRequested = true;
    job.liveStatus = "F10: đóng nick, đổi proxy và chạy lại từ đầu";
    pauseControl.requestRetry(profileId);
    return { retrying: true };
  }

  return { runQueue, retryProfile, togglePause: pauseControl.toggle, manualProfile: operator.request };
}
