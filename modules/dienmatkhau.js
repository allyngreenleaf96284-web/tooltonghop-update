function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rowValue(row, ...keys) {
  const entries = Object.entries(row || {});
  for (const key of keys) {
    const direct = row?.[key];
    if (direct !== undefined && direct !== null) return direct;
    const normalizedKey = normalizeText(key);
    const match = entries.find(([entryKey, entryValue]) =>
      entryValue !== undefined &&
      entryValue !== null &&
      normalizeText(entryKey) === normalizedKey
    );
    if (match) return match[1];
  }
  return "";
}

function hasValue(value) {
  return Boolean(String(value || "").trim());
}

function normalizeUid(value) {
  return String(value || "").replace(/\D+/g, "").trim();
}

export function createDienMatKhau({
  addRuntimeLog,
  createSheetRowSession,
  readCredentialSourceMap,
  runtime
}) {
  function buildStoppedError() {
    const error = new Error("Da nhan lenh dung han, tool dung batch hien tai.");
    error.status = "stopped";
    return error;
  }

  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      step,
      detail,
      tool: "dien mat khau"
    });
  }

  async function runQueue(profileIds, config, options = {}) {
    const ids = [...new Set((profileIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return { started: 0, updated: 0, matched: 0, skipped: 0 };
    if (runtime.running) throw new Error("Dang co tool khac chay. Hay doi tool hien tai xong da.");

    const sourceSpreadsheetId = String(
      options.sourceSpreadsheetId ||
      config.credentialSourceSpreadsheetId ||
      ""
    ).trim();
    if (!sourceSpreadsheetId) {
      throw new Error("Ban chua nhap Spreadsheet ID cua sheet tong mat khau.");
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "dien mat khau";
    runtime.jobs.clear();
    const startedAt = Date.now();

    try {
      const sheetSession = await createSheetRowSession(config, ids);
      const source = await readCredentialSourceMap(config, sourceSpreadsheetId);
      let updated = 0;
      let matched = 0;
      let skipped = 0;
      let processed = 0;

      for (const profileId of ids) {
        runtime.jobs.set(profileId, {
          profileId,
          tool: "dien mat khau",
          status: "queued",
          liveStatus: "dang cho",
          startedAt: new Date().toISOString(),
          logs: []
        });
      }

      for (const profileId of ids) {
        if (runtime.stopRequested) throw buildStoppedError();
        const job = runtime.jobs.get(profileId);
        if (!job) continue;
        job.status = "running";
        job.liveStatus = `dang doi chieu ${processed}/${ids.length}`;

        const row = sheetSession.rows.get(profileId);
        if (!row) {
          skipped += 1;
          processed += 1;
          job.status = "done";
          job.liveStatus = `khong tim thay dong sheet (${processed}/${ids.length})`;
          log(profileId, "tim dong sheet", "khong tim thay dong sheet de cap nhat", "warn");
          continue;
        }

        const uid = normalizeUid(rowValue(row, "uid"));
        const currentPassword = String(rowValue(row, "mật khẩu", "mat khau") || "").trim();
        const current2fa = String(rowValue(row, "2fa") || "").trim();
        const currentCookie = String(rowValue(row, "cookie") || "").trim();

        if (hasValue(currentPassword)) {
          skipped += 1;
          processed += 1;
          job.status = "done";
          job.liveStatus = `da co mat khau, bo qua (${processed}/${ids.length})`;
          log(profileId, "kiem tra mat khau", "mat khau da co san, bo qua", "success");
          continue;
        }

        if (!uid) {
          skipped += 1;
          processed += 1;
          job.status = "done";
          job.liveStatus = `khong co uid (${processed}/${ids.length})`;
          log(profileId, "doi chieu uid", "dong sheet khong co uid, de trong", "warn");
          continue;
        }

        const found = source.byUid.get(uid);
        if (!found || !hasValue(found.password)) {
          skipped += 1;
          processed += 1;
          job.status = "done";
          job.liveStatus = `khong tim thay uid trong sheet tong (${processed}/${ids.length})`;
          log(profileId, "doi chieu uid", `khong tim thay uid ${uid} trong sheet tong`, "warn");
          continue;
        }

        matched += 1;
        const update = {
          "mật khẩu": found.password
        };
        if (!hasValue(current2fa) && hasValue(found.twofa)) update["2fa"] = found.twofa;
        if (!hasValue(currentCookie) && hasValue(found.cookie)) update.cookie = found.cookie;

        const current = sheetSession.rows.get(profileId);
        const next = { ...current, ...update };
        sheetSession.rows.set(profileId, next);
        sheetSession.pending.set(profileId, next);
        updated += 1;
        processed += 1;
        job.status = "done";
        job.liveStatus = `da dien du lieu (${processed}/${ids.length})`;
        log(profileId, "ghi sheet", `da dien du lieu theo uid ${uid}`, "success");

        if (sheetSession.pending.size >= 50) {
          await sheetSession.flush();
        }
      }

      await sheetSession.flushAll();
      return {
        started: ids.length,
        updated,
        matched,
        skipped,
        sourceSpreadsheetId,
        sourceSheetTitle: source.title,
        durationMs: Date.now() - startedAt
      };
    } finally {
      runtime.running = false;
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
      runtime.stopRequested = false;
      runtime.currentTool = "";
    }
  }

  return { runQueue };
}
