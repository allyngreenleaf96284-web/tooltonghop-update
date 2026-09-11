const FINAL_JOB_STATUSES = new Set(["success", "done", "completed", "stopped", "cancelled", "skipped"]);
const GENERIC_FAILURE_STATUSES = new Set(["", "loi", "error", "fail", "failed", "false"]);
const KNOWN_FAILURE_PATTERNS = [
  /cp282|cp956|checkpoint/i,
  /captcha|recaptcha|not a robot/i,
  /bi out|bị out|logged out|see more on facebook/i,
  /het proxy|hết proxy|proxy.*(sai|loi|lỗi|failed|rejected|not active)/i,
  /khong tim thay|không tìm thấy|missing|not found|chua nhap|chưa nhập|thieu|thiếu/i,
  /limit reached|daily limit|not able to create new listings/i,
  /4v|workflow.*chua ho tro|workflow.*chưa hỗ trợ|unsupported/i,
  /seller info|offer shipping|location|loi login|lỗi login|loi bank|lỗi bank|loi ssn|lỗi ssn/i,
  /phien ban|phiên bản|about:blank|dung han|dừng hẳn|stopped/i
];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

function jobMessage(job) {
  const result = job?.result || {};
  return [
    result.chiTiet,
    result["chi tiết"],
    result.detail,
    result.message,
    job?.liveStatus
  ].filter(Boolean).join(" | ");
}

export function isUnknownFailure(job) {
  if (!job || String(job.status || "").toLowerCase() !== "error") return false;
  const result = job.result || {};
  const status = normalize(result.trangThai ?? result["trạng thái"] ?? result.status ?? "");
  if (!GENERIC_FAILURE_STATUSES.has(status)) return false;
  const message = jobMessage(job);
  return !KNOWN_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function isCompleted(job) {
  return FINAL_JOB_STATUSES.has(String(job?.status || "").toLowerCase());
}

function uniqueIds(ids) {
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setPhaseForJobs(runtime, ids, batch, phase, attempt) {
  const wanted = new Set(ids);
  for (const [profileId, job] of runtime.jobs.entries()) {
    if (!wanted.has(String(profileId))) continue;
    job.batchId = batch.id;
    job.batchOrder = batch.order.get(String(profileId));
    job.phase = phase;
    job.attempt = attempt;
    job.phaseState = phase === "retry" ? "retry_queued" : "queued";
    job.retryEligible = false;
    job.retryReason = "";
  }
}

function preserveJobs(runtime, excludedIds) {
  const excluded = new Set(excludedIds);
  const preserved = new Map();
  for (const [id, job] of runtime.jobs.entries()) {
    if (excluded.has(String(id))) continue;
    preserved.set(id, { ...job, logs: Array.isArray(job.logs) ? [...job.logs] : [] });
  }
  return preserved;
}

function restoreJobs(runtime, preserved) {
  for (const [id, job] of preserved.entries()) runtime.jobs.set(id, job);
}

function updateBatchCounts(runtime, batch) {
  const jobs = batch.orderKeys.map((id) => runtime.jobs.get(id)).filter(Boolean);
  const retryWaiting = jobs.filter((job) => job.phaseState === "retry_waiting").length;
  const retryRunning = jobs.filter((job) => job.phase === "retry" && String(job.status || "").toLowerCase() === "running").length;
  const queued = jobs.filter((job) => ["queued", "retry_queued"].includes(String(job.status || "").toLowerCase())).length;
  const finished = jobs.filter((job) => isCompleted(job) && job.phaseState !== "retry_waiting").length;
  batch.finished = finished;
  batch.retryWaiting = retryWaiting;
  batch.retryRunning = retryRunning;
  batch.queued = queued;
  batch.running = jobs.filter((job) => String(job.status || "").toLowerCase() === "running").length;
  return batch;
}

async function waitForQueueToFinish(runtime, batch) {
  while (runtime.batch === batch && runtime.running) {
    updateBatchCounts(runtime, batch);
    await wait(300);
  }
  updateBatchCounts(runtime, batch);
}

function annotateRetryResults(runtime, retryIds, batch) {
  for (const id of retryIds) {
    const job = runtime.jobs.get(id);
    if (!job) continue;
    job.phase = "retry";
    job.attempt = 1;
    job.phaseState = "finished";
    job.retryFinal = String(job.status || "").toLowerCase() === "error";
  }
}

export async function startAutoRetryBatch({
  runtime,
  module,
  tool,
  profileIds,
  config,
  options = {},
  invoke,
  addRuntimeLog,
  maxRetries = 1
}) {
  if (runtime.batch?.active) throw new Error("Dang co batch dang chay, vui long doi xong.");
  const ids = uniqueIds(profileIds);
  if (!ids.length) throw new Error("Chua chon profile de chay.");
  const order = new Map(ids.map((id, index) => [id, index]));
  const batch = {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tool,
    active: true,
    phase: "initial",
    attempt: 0,
    maxRetries: Math.max(0, Math.min(3, Number(maxRetries) || 0)),
    initialIds: ids,
    currentIds: ids,
    retryIds: [],
    retryWaiting: 0,
    retryRunning: 0,
    finished: 0,
    queued: ids.length,
    running: 0,
    order,
    orderKeys: ids,
    startedAt: new Date().toISOString(),
    stopRequested: false,
    lastError: ""
  };
  runtime.batch = batch;
  runtime.currentTool = tool;

  const callQueue = async (runIds, runOptions = options) => {
    if (typeof invoke === "function") return invoke(runIds, runOptions);
    return module.runQueue(runIds, config, runOptions);
  };

  const firstData = await callQueue(ids, options);
  setPhaseForJobs(runtime, ids, batch, "initial", 0);
  updateBatchCounts(runtime, batch);

  void (async () => {
    try {
      await waitForQueueToFinish(runtime, batch);
      if (runtime.stopRequested || batch.stopRequested) return;

      let retryIds = ids.filter((id) => isUnknownFailure(runtime.jobs.get(id)));
      batch.retryIds = retryIds;
      batch.currentIds = retryIds;
      for (const id of retryIds) {
        const job = runtime.jobs.get(id);
        if (!job) continue;
        job.retryEligible = true;
        job.retryReason = jobMessage(job);
        job.phaseState = "retry_waiting";
        job.status = "retry_waiting";
      }
      updateBatchCounts(runtime, batch);
      if (retryIds.length && addRuntimeLog) {
        addRuntimeLog(`[${tool}] Luot dau da xong, gom ${retryIds.length} profile loi khong xac dinh de chay lai.`, "warn", "", {
          tool,
          step: "cho chay lai",
          detail: retryIds.join(", ")
        });
      }

      for (let attempt = 1; attempt <= batch.maxRetries && retryIds.length; attempt += 1) {
        if (runtime.stopRequested || batch.stopRequested) break;
        batch.phase = "retry";
        batch.attempt = attempt;
        batch.currentIds = retryIds;
        batch.retryWaiting = retryIds.length;
        runtime.currentTool = tool;
        const preserved = preserveJobs(runtime, retryIds);
        const runOptions = { ...options, retryAttempt: attempt };
        const retryData = await callQueue(retryIds, runOptions);
        restoreJobs(runtime, preserved);
        setPhaseForJobs(runtime, retryIds, batch, "retry", attempt);
        updateBatchCounts(runtime, batch);
        await waitForQueueToFinish(runtime, batch);
        annotateRetryResults(runtime, retryIds, batch);
        updateBatchCounts(runtime, batch);
        retryIds = retryIds.filter((id) => isUnknownFailure(runtime.jobs.get(id)));
        batch.retryIds = retryIds;
        batch.currentIds = retryIds;
        batch.lastRetryData = retryData || null;
        for (const id of retryIds) {
          const job = runtime.jobs.get(id);
          if (job) {
            job.retryEligible = true;
            job.retryReason = jobMessage(job);
            job.phaseState = "retry_waiting";
            job.status = "retry_waiting";
          }
        }
        if (retryIds.length && addRuntimeLog) {
          addRuntimeLog(`[${tool}] Con ${retryIds.length} profile van loi khong xac dinh sau lan thu lai ${attempt}.`, "warn", "", {
            tool,
            step: "retry",
            detail: retryIds.join(", ")
          });
        }
      }
      if (retryIds.length) {
        for (const id of retryIds) {
          const job = runtime.jobs.get(id);
          if (!job) continue;
          job.retryEligible = false;
          job.retryFinal = true;
          job.phaseState = "retry_failed";
          job.status = "error";
          job.liveStatus = `retry van loi khong xac dinh sau ${batch.maxRetries} lan`;
        }
      }
    } catch (error) {
      batch.lastError = String(error?.message || error || "loi batch retry");
      addRuntimeLog?.(`[${tool}] Loi bo xu ly chay lai: ${batch.lastError}`, "error", "", {
        tool,
        step: "batch retry",
        detail: batch.lastError
      });
    } finally {
      batch.phase = batch.stopRequested || runtime.stopRequested ? "stopped" : "done";
      batch.active = false;
      batch.finishedAt = new Date().toISOString();
      updateBatchCounts(runtime, batch);
      if (!runtime.running) runtime.currentTool = "";
    }
  })();

  return {
    ...(firstData || {}),
    batchId: batch.id,
    autoRetryUnknown: true,
    maxRetries: batch.maxRetries
  };
}
