import { buildStandardName } from "./profile_name.js";
import { withFacebookLocale } from "./facebook_locale.js";

export function createCheckTb({
  getManager,
  getLoginManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  mapErrorForSheet,
  createSheetRowSession,
  stateProxy,
  runtime
}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clampToolConcurrency(value, fallback = 1) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
    return Math.max(1, Math.min(4, parsed));
  }

  function tileBounds(workerSlot = 0, workerTotal = 1) {
    const total = Math.max(1, Number(workerTotal || 1));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    if (total === 2) return { left: workerSlot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
    if (total === 3) return { left: workerSlot * 640, top: 0, width: 640, height: 980 };
    return { left: (workerSlot % 2) * 960, top: Math.floor(workerSlot / 2) * 520, width: 960, height: 520 };
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
    if (!page || page.isClosed?.()) return;
    const bounds = tileBounds(workerSlot, workerTotal);
    const viewport = {
      width: Math.max(760, bounds.width - 24),
      height: Math.max(520, bounds.height - 110),
      deviceScaleFactor: 1
    };
    await page.setViewport?.(viewport).catch(() => {});
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      if (document.body) document.body.style.zoom = "";
    }).catch(() => {});
    return { ...viewport, zoom: 1, bounds, actual: await readViewportMetrics(page) };
  }

  async function tileBrowserWindow(page, workerSlot = 0, workerTotal = 1) {
    if (!page || page.isClosed?.()) return false;
    const bounds = tileBounds(workerSlot, workerTotal);
    try {
      const session = await page.createCDPSession();
      const windowInfo = await session.send("Browser.getWindowForTarget").catch(() => null);
      if (windowInfo?.windowId !== undefined) {
        await session.send("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "normal", ...bounds }
        });
      }
      await session.detach().catch(() => {});
      await applyStableViewport(page, workerSlot, workerTotal);
      return true;
    } catch {
      return false;
    }
  }

  function stripResolvedNamePrefixes(name) {
    let next = String(name || "").trim();
    const prefixes = [
      /^loilogin-/i,
      /^loi login-/i,
      /^loi\s+2v-/i,
      /^loi\s+3v-/i,
      /^loi\s+seller info-/i,
      /^loi\s+ssn-/i,
      /^loi\s+bank-/i,
      /^loi-/i,
      /^loicapcha-/i,
      /^cp282-/i,
      /^cp956-/i,
      /^cp049-/i,
      /^loipb-/i,
      /^hetproxy-/i,
      /^biout-/i,
      /^k co Offer shipping(?:-3v)?-/i,
      /^die cho-/i
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const prefix of prefixes) {
        const updated = next.replace(prefix, "").trim();
        if (updated !== next) {
          next = updated;
          changed = true;
        }
      }
    }
    next = next.replace(/^-+/, "").trim();
    return next || String(name || "").trim();
  }

  function buildRuntimeProfileName({ status = "", tenChuan = "" }) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const base = String(tenChuan || "").trim() || "profile-tool";
    if (!normalizedStatus || normalizedStatus === "thanh cong" || normalizedStatus === "thành công") return base;
    if (normalizedStatus === "loi") return `loi-${base}`;
    return `${normalizedStatus}-${base}`;
  }

  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      step,
      detail,
      tool: "xem thong bao"
    });
  }

  function buildStoppedError() {
    const error = new Error("Da nhan lenh dung han, tool dung batch hien tai.");
    error.status = "stopped";
    error.step = "dung han";
    return error;
  }

  async function readLatestHideProfileName(manager, profileId, fallbackName = "") {
    const latestProfile = await manager.getProfileById(profileId).catch(() => null);
    return String(latestProfile?.name || fallbackName || profileId).trim();
  }

  async function runStep(profileId, job, step, action) {
    if (runtime.stopRequested) throw buildStoppedError();
    if (job) job.liveStatus = step;
    log(profileId, step, `bat dau: ${step}`);
    const startedAt = Date.now();
    try {
      const result = await action();
      if (runtime.stopRequested) throw buildStoppedError();
      log(profileId, step, `xong: ${step} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      const rawMessage = String(error?.message || error || "loi khong ro");
      const isTimeout = /timeout|timed out|waiting/i.test(rawMessage);
      const prefix = isTimeout ? `Timeout o buoc "${step}"` : `Loi o buoc "${step}"`;
      if (error && typeof error === "object") {
        error.step = error.step || step;
        error.message = `${prefix}: ${rawMessage}`;
        log(profileId, step, error.message, "error", rawMessage);
        throw error;
      }
      const wrapped = new Error(`${prefix}: ${rawMessage}`);
      wrapped.step = step;
      log(profileId, step, wrapped.message, "error", rawMessage);
      throw wrapped;
    }
  }

  function expandSheetUpdate(update) {
    const next = { ...update };
    const pairs = [
      ["trangThai", "trạng thái"],
      ["soVach", "số vạch"],
      ["chiTiet", "chi tiết"],
      ["diaChiBanDau", "địa chỉ ban đầu"],
      ["tenChuan", "tên chuẩn"]
    ];
    for (const [internalKey, sheetKey] of pairs) {
      if (Object.prototype.hasOwnProperty.call(next, internalKey)) next[sheetKey] = next[internalKey];
      if (Object.prototype.hasOwnProperty.call(next, sheetKey)) next[internalKey] = next[sheetKey];
    }
    return next;
  }

  async function writeSheetWithRetry(sheetSession, profileId, update) {
    const payload = expandSheetUpdate(update);
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await sheetSession.updateOne(profileId, payload);
        log(profileId, "ghi Sheet", "da ghi ket qua ra Sheet", "success");
        return true;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        const isQuota = /quota|rate|429|write requests|read requests/i.test(message);
        log(profileId, "ghi Sheet", `ghi Sheet loi lan ${attempt}: ${message}`, isQuota ? "warn" : "error", message);
        if (!isQuota || attempt >= 5) break;
        await sleep(1500 * attempt);
      }
    }

    const job = runtime.jobs.get(profileId);
    if (job) {
      job.sheetWriteError = lastError?.message || "Khong ghi duoc Sheet.";
      job.liveStatus = `da xu ly xong nhung ghi Sheet loi: ${job.sheetWriteError}`;
    }
    return false;
  }

  function buildLoggedOutError(context = "") {
    const error = new Error(context || "Nick bi out giua chung, tool da dung.");
    error.status = "biout";
    return error;
  }

  function patchManagerForCentralizedLogin(manager, row) {
    const originals = {
      ensureMarketplaceSession: manager.ensureMarketplaceSession,
      ensureMarketplaceReadyOrRelogin: manager.ensureMarketplaceReadyOrRelogin,
      waitForMarketplaceReady: manager.waitForMarketplaceReady
    };

    manager.ensureMarketplaceSession = async () => {
      throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung khi vao Marketplace.`);
    };

    manager.ensureMarketplaceReadyOrRelogin = async (page) => {
      if (await manager.isLoggedOutMarketplace?.(page).catch(() => false)) {
        throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung trong luc chay tool xem thong bao.`);
      }
    };

    manager.waitForMarketplaceReady = async (page, currentRow = null) => {
      await manager.gotoWithRetry(page, withFacebookLocale("https://www.facebook.com/marketplace/create/item"), currentRow || row, 3);
      if (await manager.isLoggedOutMarketplace?.(page).catch(() => false)) {
        throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung khi vao Marketplace.`);
      }
      await manager.waitForMarketplaceUiStable?.(page);
    };

    return () => {
      for (const [key, value] of Object.entries(originals)) {
        if (value) manager[key] = value;
      }
    };
  }

  async function runNotificationJob(profileId, sheetRow, options = {}) {
    const manager = getManager({ fresh: true });
    const loginManager = typeof getLoginManager === "function" ? getLoginManager({ fresh: true }) : manager;
    const currentManagerConfig = typeof manager.getConfig === "function" ? manager.getConfig() : {};
    if (typeof manager.saveConfig === "function") {
      manager.saveConfig({ ...currentManagerConfig, maxConcurrency: 1 });
    } else if (manager.config && typeof manager.config === "object") {
      manager.config.maxConcurrency = 1;
    }
    if (manager.windowSlots?.clear) manager.windowSlots.clear();
    const row = buildToolRow(profileId, sheetRow);
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    let currentName = "";
    let originalName = "";
    const restoreManagerLoginGuards = patchManagerForCentralizedLogin(manager, row);

    try {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      if (!runtime.activeManagers) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid: row.uid || profileId });

      const profileInfo = await runStep(profileId, job, "kiem tra profile HideMyAcc", async () => {
        const info = await manager.getProfileById(profileId);
        currentName = String(info?.name || profileId).trim();
        originalName = currentName;
        const browserType = String(info?.browserType || "").trim().toLowerCase();
        const browserSource = String(info?.browserSource || "").trim().toLowerCase();
        if ((browserType && browserType !== "chrome") || browserSource === "ghosty") {
          const error = new Error(browserSource === "ghosty" ? "HideMyAcc profile browserSource=ghosty." : `HideMyAcc profile browserType=${browserType}.`);
          error.status = "loipb";
          throw error;
        }
        return info;
      });

      proxyLease = await runStep(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config: options.config || {},
          profileId,
          row,
          log: (step, message, type = "info") => log(profileId, step, message, type)
        })
      );

      await runStep(profileId, job, "mo profile HideMyAcc", async () => {
        browser = await loginManager.connectBrowser(profileId);
        page = await browser.newPage();
        page.__toolUid = String(row.uid || profileId || "").trim();
        await page.bringToFront();
        const tiled = await tileBrowserWindow(page, options.workerSlot || 0, options.concurrency || 1);
        if (!tiled && typeof loginManager.maximizeBrowserWindow === "function") {
          await loginManager.maximizeBrowserWindow(browser, page).catch(() => {});
        }
        const viewport = await applyStableViewport(page, options.workerSlot || 0, options.concurrency || 1);
        log(profileId, "viewport", `worker ${(options.workerSlot || 0) + 1}/${options.concurrency || 1} bounds=${viewport?.bounds?.width || ""}x${viewport?.bounds?.height || ""} viewport=${viewport?.width || 1365}x${viewport?.height || 900}, zoom=1, actual=${JSON.stringify(viewport?.actual || {})}`);
      });

      await runStep(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(loginManager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      });

      currentName = await runStep(profileId, job, "quet ten profile Hide", async () =>
        readLatestHideProfileName(manager, profileId, currentName || profileInfo?.name || profileId)
      );

      const cleanedNameAfterLogin = stripResolvedNamePrefixes(currentName || profileInfo?.name || profileId);
      if (cleanedNameAfterLogin && cleanedNameAfterLogin !== currentName) {
        await runStep(profileId, job, "xoa prefix loi login cu", async () => {
          await manager.updateProfileName(profileId, cleanedNameAfterLogin);
          currentName = cleanedNameAfterLogin;
        });
      }

      const notificationResult = await runStep(profileId, job, "quet thong bao", async () => {
        return manager.scanNotifications(page, row);
      });

      const nameStatus = notificationResult.flags.paused ? "pause" : notificationResult.flags.order ? "order" : "";
      const resolvedBaseName = stripResolvedNamePrefixes(currentName || profileInfo?.name || profileId);
      const canonicalName = buildStandardName({
        currentName: resolvedBaseName,
        sheetRow,
        pauseOrder: nameStatus,
        uid: row.uid
      });
      await runStep(profileId, job, "doi ten profile theo ket qua", async () => {
        await manager.updateProfileName(profileId, canonicalName);
        currentName = canonicalName;
      });

      await runStep(profileId, job, "don ten profile sau thanh cong", async () => {
        const latestName = await readLatestHideProfileName(manager, profileId, currentName || profileInfo?.name || profileId);
        const cleanedLatestName = stripResolvedNamePrefixes(latestName);
        const cleanedCanonicalName = buildStandardName({
          currentName: cleanedLatestName,
          sheetRow,
          pauseOrder: nameStatus,
          uid: row.uid
        });
        if (cleanedCanonicalName && cleanedCanonicalName !== latestName) {
          await manager.updateProfileName(profileId, cleanedCanonicalName);
          currentName = cleanedCanonicalName;
          return;
        }
        currentName = latestName;
      });

      const resultDetail = notificationResult.flags.paused
        ? "pause"
        : notificationResult.flags.order
          ? "order"
          : "khong co pause va order";

      const finalUpdate = {
        Tool: "da check tb",
        trangThai: "thành công",
        chiTiet: resultDetail,
        tenChuan: canonicalName
      };

      job.status = "success";
      job.liveStatus = "xem thong bao thanh cong";
      job.result = finalUpdate;
      log(profileId, "ket thuc", `xem thong bao thanh cong: ${resultDetail}`, "success");
      return finalUpdate;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (originalName) await manager.updateProfileName(profileId, originalName).catch(() => {});
        job.status = "stopped";
        job.liveStatus = "da dung han, giu nguyen Sheet";
        job.result = null;
        return { stopped: true };
      }
      const mapped = mapErrorForSheet(error);
      const stableName = buildStandardName({
        currentName: stripResolvedNamePrefixes(currentName || profileId),
        sheetRow,
        uid: row.uid
      });
      const runtimeName = buildRuntimeProfileName({
        status: mapped.renameStatus || "loi",
        tenChuan: stableName
      });
      await manager.updateProfileName(profileId, runtimeName).catch((renameError) => {
        log(profileId, "doi ten profile khi loi", `khong doi duoc ten profile: ${renameError.message}`, "error");
      });
      const finalUpdate = {
        Tool: "xem tb",
        trangThai: "loi",
        chiTiet: mapped.detail || "loi xem thong bao",
        tenChuan: stableName
      };
      job.status = "error";
      job.liveStatus = mapped.detail;
      job.result = finalUpdate;
      log(profileId, error.step || "loi tong", `loi xem thong bao: ${mapped.detail}`, "error");
      return finalUpdate;
    } finally {
      restoreManagerLoginGuards();
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      try { stateProxy?.release?.(proxyLease); } catch {}
      await loginManager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runNotificationQueue(profileIds, config, options = {}) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");

    const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");

    const sheetSession = await createSheetRowSession(config, ids);
    const rowsById = sheetSession.rows;
    const concurrency = Math.min(clampToolConcurrency(options.concurrency, 1), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "xem thong bao",
        status: "queued",
        liveStatus: "dang cho worker",
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang chay check tb voi ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "xem thong bao";
    setImmediate(async () => {
      try {
        const queue = [...ids];
        let activeCount = 0;
        const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
          while (queue.length > 0) {
            if (runtime.stopRequested) break;
            const id = queue.shift();
            if (!id) break;

            const row = rowsById.get(id);
            const job = runtime.jobs.get(id);
            if (job) job.liveStatus = `worker ${workerIndex + 1} dang bat dau`;
            activeCount += 1;
            log(id, "worker", `worker ${workerIndex + 1}/${concurrency} start, active=${activeCount}, queue_con_lai=${queue.length}`);

            try {
              if (!row) {
                const update = {
                  Tool: "xem tb",
                  trangThai: "loi",
                  chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide."
                };
                if (job) {
                  job.status = "error";
                  job.liveStatus = update.chiTiet;
                  job.finishedAt = new Date().toISOString();
                  job.result = update;
                }
                log(id, "doc Sheet", update.chiTiet, "error");
                await writeSheetWithRetry(sheetSession, id, update);
                continue;
              }

              const update = await runNotificationJob(id, row, { concurrency, workerSlot: workerIndex, config });
              if (update?.stopped) continue;
              await writeSheetWithRetry(sheetSession, id, update);
            } finally {
              activeCount = Math.max(0, activeCount - 1);
              log(id, "worker", `worker ${workerIndex + 1}/${concurrency} end, active=${activeCount}, queue_con_lai=${queue.length}`);
            }
          }
        });
        await Promise.all(workers);
        if (runtime.stopRequested) {
          for (const id of ids) {
            const job = runtime.jobs.get(id);
            if (job && (job.status === "queued" || job.status === "running")) {
              job.status = "stopped";
              job.liveStatus = "da dung han";
              job.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        addRuntimeLog(`Loi queue xem thong bao: ${error.message}`, "error", "", {
          step: "queue checktb",
          tool: "xem thong bao"
        });
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });

    return { started: ids.length, concurrency };
  }

  return { runNotificationQueue };
}
