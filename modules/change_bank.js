import { patchStableWindowTiling } from "./tool_login.js";
import { createLoginDisplay } from "./login_display.js";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function bankCellText(cell, allowMarker = false) {
  if (!cell?.effectiveValue && !cell?.userEnteredValue) return "";
  const value = cell.effectiveValue || cell.userEnteredValue;
  if (allowMarker && /^x$/i.test(value.stringValue?.trim() || "")) return "x";
  if (typeof value.stringValue === "string" && /^\d*$/.test(value.stringValue.trim())) return value.stringValue.trim();
  const digits = cell.formattedValue?.trim() || "";
  if (Number.isSafeInteger(value.numberValue) && value.numberValue >= 0 && value.numberValue < 1e15
    && /^\d+$/.test(digits) && BigInt(digits) === BigInt(value.numberValue)) return digits;
  throw new Error("Giá trị không còn là chuỗi chữ số chính xác. Hãy nhập lại từ nguồn gốc dưới dạng Văn bản thuần.");
}

export async function openBankSheet(client, spreadsheetId, gid) {
  const meta = await client.metadata();
  const tab = meta.sheets?.find(({ properties }) => String(properties?.sheetId) === gid)?.properties;
  if (!tab) throw new Error("Không tìm thấy tab Sheet Đổi Bank theo gid.");
  const sheetId = tab.sheetId;
  const read = async () => {
    const params = new URLSearchParams({
      fields: "sheets(properties(sheetId),data(rowData(values(userEnteredValue,effectiveValue,formattedValue))))"
    });
    const result = await client.request(`:getByDataFilter?${params}`, {
      method: "POST",
      body: JSON.stringify({ dataFilters: [{ gridRange: { sheetId } }], includeGridData: true })
    });
    const data = result.sheets?.find(({ properties }) => properties?.sheetId === sheetId)?.data?.[0]?.rowData;
    if (!data?.length) throw new Error("Tab Đổi Bank không có hàng tiêu đề.");
    const headers = data[0].values?.map((cell) => String(cell.formattedValue || "").trim().toLowerCase().replace(/\s+/g, " ")) || [];
    const findColumn = (header) => {
      const index = headers.indexOf(header);
      if (index < 0 || index !== headers.lastIndexOf(header)) throw new Error(`Tab Đổi Bank cần đúng một cột "${header}".`);
      return index;
    };
    const accountColumn = findColumn("bank account number");
    const uidColumn = findColumn("uid");
    const rows = data.slice(1).map(({ values = [] }, index) => {
      const rowNumber = index + 2;
      try {
        const uidCell = values[uidColumn];
        if (uidCell?.userEnteredValue?.formulaValue) throw new Error("Ô UID chứa công thức.");
        return { rowNumber, account: bankCellText(values[accountColumn]), uid: bankCellText(uidCell, true) };
      } catch (error) {
        return { rowNumber, error: error.message };
      }
    });
    return { rows, accountColumn, uidColumn };
  };
  const write = (column, rows, value) => client.batchUpdate(rows.map(({ rowNumber }) => ({
    updateCells: {
      start: { sheetId, rowIndex: rowNumber - 1, columnIndex: column },
      rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
      fields: "userEnteredValue"
    }
  })), { maxAttempts: 1 });
  return { key: `${spreadsheetId}:${gid}`, read, write };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function observePayment(action, account) {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === "visible";
  };
  const text = (el) => String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="alertdialog"]')].filter(visible);
  const limitText = /\b1861012\b|this bank account has been added to facebook the maximum number of times/i;
  const limit = dialogs.filter((el) => limitText.test(text(el))).at(-1);
  const enabled = (el) => !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true";
  const form = dialogs.find((el) => /link payment account/i.test(text(el)));
  const inputs = [...(form || document).querySelectorAll("input")].filter(visible);
  const byLabel = (label) => inputs.find((el) => {
    const named = [
      el.getAttribute("aria-label"), el.placeholder,
      ...[...el.labels || []].map(text),
      ...String(el.getAttribute("aria-labelledby") || "").split(" ").map((id) => document.getElementById(id)?.innerText),
      el.parentElement?.innerText, el.parentElement?.parentElement?.innerText
    ];
    return named.some((name) => name?.trim().toLowerCase() === label);
  });
  const number = byLabel("bank account number");
  const confirm = byLabel("confirm bank account number");
  const formReady = Boolean(number && confirm && number !== confirm && enabled(number) && enabled(confirm));
  const buttonIn = (scope, pattern) => [...scope.querySelectorAll('button,[role="button"]')].filter(visible)
    .find((el) => pattern.test(text(el)) && enabled(el));
  const facebook = /(^|\.)facebook\.com$/i.test(location.hostname);
  const onPayments = facebook && /^\/marketplace\/seller\/link_payments\/?$/.test(location.pathname);
  const onSales = facebook && /^\/marketplace\/you\/sales\/?$/.test(location.pathname);
  if (limit) {
    if (action === "dismiss") buttonIn(limit, /^(ok|close|đóng|x)$/i)?.click();
    return "limit";
  }
  if ((facebook && /^\/(checkpoint|login|two_step_verification)(\/|$)/i.test(location.pathname))
    || dialogs.some((el) => /verify your identity|confirm your identity|security check/i.test(text(el)))) return "verification";
  if (location.protocol === "chrome-error:" || /ERR_(PROXY|TUNNEL|CONNECTION|INTERNET|TIMED_OUT)/.test(document.body?.innerText || "")) return "network";
  if (action === "result" && onSales) return "success";
  if (action === "result" && onPayments && limitText.test(document.body?.innerText || "")) return "limit";
  if (action === "recheck" && onPayments && formReady && number.value === account && !confirm.value) return "success";
  if (!onPayments) return "waiting";
  if (dialogs.some((el) => el !== form && /^(error\b|can't add bank account\b)/i.test(text(el)))) return "other-error";
  if (!formReady) return "waiting";
  if (action === "fill") {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const input of [number, confirm]) {
      set.call(input, account);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  if (action === "ready" || action === "click") {
    const submit = buttonIn(form || document, /^link bank account$/i);
    if (!submit || number.value !== account || confirm.value !== account) return "waiting";
    if (action === "click") {
      submit.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = submit.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!submit.contains(hit)) return "waiting";
      submit.click();
    }
    return "ready";
  }
  return "form";
}

export function createBankBrowser({ waitMs = 90000, pollMs = 350, dismissQuietMs = 1500 } = {}) {
  async function waitFor(page, action, account, expected, shouldStop = () => false) {
    const deadline = Date.now() + waitMs;
    let readySince = null;
    do {
      if (shouldStop()) throw new Error("Đã dừng.");
      let state;
      try { state = await page.evaluate(observePayment, action, account); }
      catch (error) {
        if (!/execution context was destroyed|cannot find context/i.test(error.message)) throw error;
      }
      if (expected.includes(state)) {
        if (action !== "dismiss") return state;
        readySince ??= Date.now();
        if (Date.now() - readySince >= dismissQuietMs) return state;
      } else {
        readySince = null;
        if (state === "network") throw Object.assign(new Error("Lỗi kết nối khi tải Facebook."), { code: "BANK_NETWORK" });
        if (state === "verification") throw Object.assign(new Error("Facebook yêu cầu đăng nhập hoặc xác minh tài khoản."), { code: "BANK_VERIFICATION" });
        if (state === "other-error") throw new Error("Facebook báo lỗi khác khi liên kết bank.");
      }
      await delay(pollMs);
    } while (Date.now() < deadline);
    throw new Error("Hết thời gian chờ trạng thái Facebook.");
  }
  return {
    async prepare(page, account, stop) {
      await waitFor(page, "fill", account, ["form"], stop);
      await waitFor(page, "ready", account, ["ready"], stop);
    },
    async submit(page, account) {
      // The caller records the attempt on disk before this single click.
      const state = await page.evaluate(observePayment, "click", account);
      if (state !== "ready") {
        const error = new Error("Nút liên kết chưa sẵn sàng.");
        error.code = "BANK_NOT_SENT";
        error.state = state;
        throw error;
      }
      return waitFor(page, "result", "", ["success", "limit"]);
    },
    dismiss: (page, stop) => waitFor(page, "dismiss", "", ["form"], stop),
    async recheck(page, account) {
      return await page.evaluate(observePayment, "recheck", account) === "success";
    }
  };
}

async function loadJournal(file) {
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (!state.secret || !state.records || typeof state.records !== "object") throw new Error();
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Không đọc được nhật ký Đổi Bank. Cần khôi phục nhật ký trước khi chạy.");
    state = { secret: randomBytes(32).toString("hex"), records: {} };
  }
  let tail = Promise.resolve();
  return {
    records: state.records,
    fingerprint: (account) => createHmac("sha256", state.secret).update(account).digest("hex"),
    set(key, record) {
      const save = tail.then(async () => {
        const records = { ...state.records };
        if (record) records[key] = record;
        else delete records[key];
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ secret: state.secret, records }), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        if (record) state.records[key] = record;
        else delete state.records[key];
      });
      tail = save.catch(() => {});
      return save;
    }
  };
}

export const skipBankProfile = (name) => /pau|order|ddbank/i.test(String(name || ""));

function isConnectionError(error) {
  return error?.code === "BANK_NETWORK" || /ERR_(PROXY|TUNNEL|CONNECTION|INTERNET|TIMED_OUT)|ECONNRESET|ECONNREFUSED|target closed|session closed|connection closed|proxy.{0,20}(expired|het han)/i.test(error?.message || "");
}

const TOOL = "doi bank";
const PAYMENTS_URL = "https://www.facebook.com/marketplace/seller/link_payments?locale=en_US";
function statusText(record) {
  if (record.phase === "confirmed") {
    return record.sheetDone
      ? "Facebook đã xác nhận và đã ghi UID. Còn bước đổi tên."
      : "Facebook đã xác nhận. Còn bước ghi Sheet hoặc đổi tên.";
  }
  if (record.phase === "limit") return "Đã xác nhận giới hạn bank. Còn bước đánh dấu Sheet.";
  return "Cần kiểm tra kết quả trên Facebook.";
}

export function createChangeBankTool({
  runtime, openSheet, getManager, getRowsByProfileIds, buildToolRow, dangNhap, stateProxy,
  addRuntimeLog, journalPath, bankBrowser = createBankBrowser(), configureWindow = patchStableWindowTiling, closeRetryMs = 1000
}) {
  const unclosedProfiles = new Map();
  const report = (profileId, uid, rowNumber, message, type = "info") => {
    const status = `${uid ? `UID ${uid} · ` : ""}${rowNumber ? `dòng ${rowNumber} · ` : ""}${message}`;
    const job = runtime.jobs.get(profileId);
    if (job) job.liveStatus = status;
    addRuntimeLog(status, type, profileId, { tool: TOOL, step: "Đổi Bank" });
  };

  async function run(profileIds, config, { concurrency, sheetLink, authorized, retryOnly } = {}) {
    if (runtime.running || runtime.batch?.active) throw new Error("Đang có tool khác chạy.");
    const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chọn ít nhất một profile.");
    if (!retryOnly && authorized !== true) throw new Error("Xác nhận các bank trong tab được phép liên kết với các profile đã chọn.");
    const workers = Math.min(4, ids.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = TOOL;
    try {
      for (const [id, close] of unclosedProfiles) {
        try {
          await close();
          unclosedProfiles.delete(id);
        } catch {
          throw new Error("Đổi Bank còn profile chưa đóng được. Hãy đóng profile đó trong GPM hoặc HideMyAcc rồi chạy lại.");
        }
      }
      const journal = await loadJournal(journalPath);
      const sheet = await openSheet(config, sheetLink);
      let snapshot = await sheet.read();
      const seenErrors = new Set();
      const reportRows = () => {
        for (const row of snapshot.rows) {
          if (!row.error || seenErrors.has(row.rowNumber)) continue;
          seenErrors.add(row.rowNumber);
          report("", "", row.rowNumber, row.error, "warn");
        }
      };
      reportRows();
      const profileRows = retryOnly ? new Map() : await getRowsByProfileIds(config, ids, { forceRefresh: true, source: TOOL });
      const display = createLoginDisplay();
      const leases = new Map();
      const rejected = new Set();
      let sheetTail = Promise.resolve();
      const serialized = (work) => {
        const task = sheetTail.then(work);
        sheetTail = task.catch(() => {});
        return task;
      };
      const reload = async () => { snapshot = await sheet.read(); reportRows(); };
      const fingerprint = (row) => journal.fingerprint(row.account);
      const reserve = async () => {
        while (!runtime.stopRequested) {
          const result = await serialized(() => {
            const pending = Object.values(journal.records);
            const unavailable = new Set(pending.map((record) => record.bankHash));
            const pendingRows = new Set(pending.filter((record) => record.sheetKey === sheet.key).map((record) => record.rowNumber));
            let waiting = false;
            for (const row of snapshot.rows) {
              if (row.error || row.uid || !row.account) continue;
              const bankHash = fingerprint(row);
              if (rejected.has(bankHash)) continue;
              if (leases.has(bankHash) || [...leases.values()].some((lease) => lease.rowNumber === row.rowNumber)) {
                waiting = true;
                continue;
              }
              if (unavailable.has(bankHash) || pendingRows.has(row.rowNumber)) continue;
              const lease = { ...row, bankHash, accountColumn: snapshot.accountColumn, uidColumn: snapshot.uidColumn };
              leases.set(bankHash, lease);
              return { lease };
            }
            return { waiting };
          });
          if (result.lease || !result.waiting) return result.lease;
          await delay(100);
        }
        return null;
      };
      const matchesRow = (row, record) => row && !row.error && row.account && fingerprint(row) === record.bankHash;
      const requireRow = (record, allowedUid) => {
        const row = snapshot.rows[record.rowNumber - 2];
        if (snapshot.uidColumn !== record.uidColumn || snapshot.accountColumn !== record.accountColumn
          || !matchesRow(row, record) || (row.uid && row.uid !== allowedUid)) {
          throw Object.assign(new Error("Dòng Sheet đã thay đổi."), { code: "BANK_SHEET_CHANGED" });
        }
        return row;
      };

      async function persistResult(key, record, manager, profileId) {
        if (record.sheetKey !== sheet.key) throw Object.assign(new Error("Chọn đúng link tab Sheet của lần thử trước."), { code: "BANK_SHEET_MISMATCH" });
        if (!record.sheetDone) {
          await serialized(async () => {
            await reload();
            const value = record.phase === "limit" ? "x" : record.uid;
            requireRow(record, value);
            const targets = record.phase === "limit"
              ? snapshot.rows.filter((row) => row.rowNumber >= record.rowNumber && !row.uid && matchesRow(row, record))
              : snapshot.rows.filter((row) => row.rowNumber === record.rowNumber && !row.uid);
            if (targets.length) {
              await sheet.write(snapshot.uidColumn, targets, value);
              await reload();
              requireRow(record, value);
              if (targets.some(({ rowNumber }) => {
                const row = snapshot.rows[rowNumber - 2];
                return !matchesRow(row, record) || row.uid !== value;
              })) throw new Error("Chưa xác nhận được cập nhật UID trên Sheet.");
            }
            await journal.set(key, { ...record, sheetDone: true });
          });
        }
        if (record.phase === "confirmed") {
          const profile = await manager.getProfileById(profileId);
          if (!profile?.name) throw new Error("Chưa đọc được tên profile để đổi tên.");
          if (!/^ddbank-/i.test(profile.name)) await manager.updateProfileName(profileId, `ddbank-${profile.name}`);
        }
        await journal.set(key, null);
      }

      async function runProfile(profileId, workerSlot) {
        const job = runtime.jobs.get(profileId);
        const key = JSON.stringify([config.browserApiProvider, profileId]);
        const manager = getManager({ fresh: true });
        manager.__profileConfig = async () => config;
        configureWindow(manager, workerSlot, workers, config.loginZoomPercent, display);
        const row = buildToolRow(profileId, profileRows.get(profileId) || {});
        const prior = journal.records[key];
        const uid = prior?.uid || String(row.uid || "").trim();
        job.status = "running";
        job.startedAt = new Date().toISOString();
        let lease, proxyLease, previousLease, browser, page, opening = false;
        let proxyRetries = 0;
        let lastRowNumber = prior?.rowNumber;
        let stage = "đọc profile";
        const progress = (message, type = "info") => report(profileId, uid, lastRowNumber, message, type);
        const close = async () => {
          if (page) { try { await page.close({ runBeforeUnload: false }); } catch {} }
          if (browser) { try { await browser.disconnect(); } catch {} }
          if (opening) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const result = await manager.stopHideMyAccProfile(profileId, { reportFailure: true });
                if (result !== false && result?.success !== false) {
                  opening = false;
                  break;
                }
              } catch {}
              if (attempt < 3) await delay(closeRetryMs);
            }
            if (opening) throw Object.assign(new Error("Chưa đóng được profile."), { code: "BANK_CLOSE_FAILED" });
          }
          if (proxyLease) {
            previousLease = proxyLease;
            try { stateProxy?.release?.(proxyLease); } catch {}
          }
          page = browser = proxyLease = null;
          opening = false;
        };
        const stop = () => runtime.stopRequested;
        const open = async () => {
          stage = "cấp proxy";
          proxyLease = await stateProxy?.ensureForProfile?.({ config, profileId, row, previousLease });
          stage = "mở profile";
          const profile = await manager.getProfileById(profileId);
          if (!profile?.name) throw new Error("Không tìm thấy tên profile.");
          if (skipBankProfile(profile.name)) return false;
          if (stop() && !journal.records[key]) return false;
          opening = true;
          browser = await manager.connectBrowser(profileId);
          page = await browser.newPage();
          await manager.maximizeBrowserWindow?.(browser, page).catch(() => progress("Không xếp được cửa sổ.", "warn"));
          stage = "đăng nhập Facebook";
          const login = await dangNhap.ensureFacebookLogin(manager, page, row, profileId, () => {}, { shouldStop: () => stop() && !journal.records[key] });
          if (login?.page && login.page !== page) {
            page = login.page;
            await manager.maximizeBrowserWindow?.(browser, page).catch(() => progress("Không xếp được cửa sổ.", "warn"));
          }
          const cookies = await page.cookies("https://www.facebook.com");
          if (cookies.find((cookie) => cookie.name === "c_user")?.value !== uid) {
            throw Object.assign(new Error("UID Facebook không khớp với profile đã chọn."), { code: "BANK_UID_MISMATCH" });
          }
          stage = "tải trang liên kết bank";
          await page.goto(PAYMENTS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
          return true;
        };
        try {
          if (prior) {
            if (prior.phase === "submitting") {
              job.status = "error";
              progress(statusText(prior), "warn");
              return;
            }
            stage = "đối soát";
            progress(statusText(prior));
            if (prior.phase === "limit") rejected.add(prior.bankHash);
            await persistResult(key, prior, manager, profileId);
            job.status = "success";
            progress(prior.phase === "limit" ? "Đã đánh dấu bank đạt giới hạn." : "Đã hoàn tất ghi Sheet và đổi tên.", "success");
            return;
          }
          if (retryOnly) { job.status = "skipped"; progress("Không có bước còn thiếu để thử lại."); return; }
          const profile = await manager.getProfileById(profileId);
          if (!profile?.name) throw new Error("Không tìm thấy tên profile.");
          if (skipBankProfile(profile.name)) { job.status = "skipped"; progress("Bỏ qua tên chứa pau, order hoặc ddbank."); return; }
          if (!profileRows.has(profileId) || !/^\d+$/.test(uid) || uid === profileId) {
            throw Object.assign(new Error("Thiếu UID trong Sheet quản lý profile."), { code: "BANK_UID_MISSING" });
          }
          while (!stop()) {
            lease = await reserve();
            if (!lease) { job.status = stop() ? "stopped" : "skipped"; progress(stop() ? "Đã dừng." : "Hết bank hợp lệ."); return; }
            lastRowNumber = lease.rowNumber;
            progress("Đã giữ chỗ bank.");
            try {
              let result;
              let attemptRecord;
              for (;;) {
                try {
                  if (!page && !await open()) { job.status = stop() ? "stopped" : "skipped"; progress(stop() ? "Đã dừng." : "Bỏ qua tên chứa pau, order hoặc ddbank."); return; }
                  stage = "điền hai ô bank";
                  await bankBrowser.prepare(page, lease.account, stop);
                  stage = "kiểm tra lại dòng Sheet trước khi gửi";
                  await serialized(async () => { await reload(); requireRow(lease, ""); });
                  if (stop()) { job.status = "stopped"; progress("Đã dừng."); return; }
                  attemptRecord = { phase: "submitting", sheetKey: sheet.key, bankHash: lease.bankHash,
                    rowNumber: lease.rowNumber, uidColumn: lease.uidColumn, accountColumn: lease.accountColumn, uid };
                  await journal.set(key, attemptRecord);
                  if (stop()) {
                    await journal.set(key, null);
                    job.status = "stopped";
                    progress("Đã dừng.");
                    return;
                  }
                  stage = "chờ Facebook sau khi gửi";
                  progress("Đang chờ kết quả Facebook.");
                  result = await bankBrowser.submit(page, lease.account);
                  break;
                } catch (error) {
                  if (error.code === "BANK_NOT_SENT") {
                    await journal.set(key, null);
                    if (error.state === "verification") error.code = "BANK_VERIFICATION";
                    throw error;
                  }
                  if (attemptRecord && journal.records[key]) {
                    if (stop() || !isConnectionError(error) && !/hết thời gian chờ/i.test(error.message)) throw error;
                    await close();
                    if (await open() && await bankBrowser.recheck(page, lease.account)) { result = "success"; break; }
                    throw error;
                  }
                  if (!isConnectionError(error) || proxyRetries++ >= 2 || stop()) throw error;
                  progress("Lỗi kết nối trước khi gửi. Đang cấp lại proxy và mở lại profile.", "warn");
                  await close();
                }
              }
              stage = "lưu kết quả Facebook";
              const record = { ...attemptRecord, phase: result === "limit" ? "limit" : "confirmed" };
              if (record.phase === "limit") rejected.add(record.bankHash);
              await journal.set(key, record);
              stage = "đối soát";
              await persistResult(key, record, manager, profileId);
              if (record.phase === "confirmed") {
                job.status = "success";
                progress("Đã liên kết, ghi UID và đổi tên.", "success");
                return;
              }
              progress("Bank đạt giới hạn. Đã đánh dấu x.", "warn");
              if (!stop()) {
                stage = "đóng thông báo giới hạn";
                await bankBrowser.dismiss(page, stop);
              }
            } finally {
              leases.delete(lease.bankHash);
              lease = null;
            }
          }
          job.status = "stopped";
          progress("Đã dừng.");
        } catch (error) {
          const record = journal.records[key];
          job.status = !record && stop() ? "stopped" : "error";
          let message = `Lỗi bước ${stage}.`;
          if (record) message = statusText(record);
          if (error.code === "BANK_VERIFICATION" || /checkpoint|captcha|capcha|2fa/i.test(error.status || error.message)) {
            message += " Facebook yêu cầu xác minh hoặc đăng nhập.";
          }
          if (error.code === "BANK_UID_MISMATCH" || error.code === "BANK_UID_MISSING") message += ` ${error.message}`;
          if (isConnectionError(error)) message += " Lỗi kết nối/proxy.";
          if (error.code === "BANK_SHEET_CHANGED") message += " Dòng Sheet đã thay đổi. Đối chiếu vị trí dòng, số tài khoản và cột UID.";
          if (error.code === "BANK_SHEET_MISMATCH") message += " Chọn đúng link tab Sheet của lần thử trước.";
          progress(job.status === "stopped" ? "Đã dừng." : message, "error");
        } finally {
          try {
            await close();
          } catch (error) {
            if (error.code === "BANK_CLOSE_FAILED") unclosedProfiles.set(key, close);
            throw error;
          }
          job.finishedAt = new Date().toISOString();
        }
      }

      for (const profileId of ids) runtime.jobs.set(profileId, { profileId, tool: TOOL, status: "queued", liveStatus: "Chờ xử lý.", logs: [] });
      let cursor = 0;
      setImmediate(async () => {
        try {
          await Promise.allSettled(Array.from({ length: workers }, async (_, workerSlot) => {
            while (!runtime.stopRequested && cursor < ids.length) {
              const id = ids[cursor++];
              try { await runProfile(id, workerSlot); }
              catch (error) {
                const job = runtime.jobs.get(id);
                job.status = "error";
                job.finishedAt = new Date().toISOString();
                if (error.code === "BANK_CLOSE_FAILED") {
                  report(id, "", null, "Chưa đóng được profile. Luồng này dừng mở profile mới.", "error");
                  break;
                }
                report(id, "", null, "Không khởi tạo được phiên xử lý.", "error");
              }
            }
          }));
        } finally {
          for (const id of ids.slice(cursor)) {
            const job = runtime.jobs.get(id);
            job.status = "stopped";
            job.liveStatus = runtime.stopRequested ? "Đã dừng." : "Chưa chạy vì các luồng chưa đóng được profile.";
            job.finishedAt = new Date().toISOString();
          }
          runtime.running = false;
          runtime.stopRequested = false;
          runtime.currentTool = "";
        }
      });
      return { started: ids.length, concurrency: workers };
    } catch (error) {
      runtime.running = false;
      runtime.currentTool = "";
      throw error;
    }
  }
  return { run };
}
