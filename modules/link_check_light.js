const installed = new WeakSet();
const blocked = new Set(["image", "media", "font"]);

// Only owned check tabs: login/challenge pages retain their normal resources.
export async function installLightLinkCheck(page) {
  if (installed.has(page)) return;
  await page.setRequestInterception(true);
  const handler = (request) => {
    if (request.isInterceptResolutionHandled?.()) return;
    const work = blocked.has(request.resourceType()) ? request.abort("blockedbyclient") : request.continue();
    void work.catch(() => {}); // Navigation/close can dispose outstanding requests.
  };
  page.on("request", handler);
  page.once("close", () => page.off("request", handler));
  installed.add(page);
}

export function createLinkCheckProgress(runtime, profileCount, retryStatus, now = Date.now) {
  const rows = new Map();
  const startedAt = now();
  let speedStart = null, batchStart = null, batchCount = 0, checkMs = 0, saveMs = 0;
  const summary = runtime.linkOrderProgress = {
    total: 0, checked: 0, completed: 0, retryable: 0, pending: 0, manualReview: 0,
    inFlight: 0, activeProfiles: 0, profileCount, attempts: 0, pass: 1,
    speed: { processed: 0, batches: 0, first100Ms: null, last100Ms: null, average100Ms: null, recent: [] },
    running: true, startedAt, finishedAt: null
  };
  const key = (plan, rowNumber) => JSON.stringify([plan.spreadsheetId, plan.title, rowNumber]);
  const setStatus = (id, status) => {
    const old = rows.get(id) || "";
    summary.checked += Number(Boolean(status)) - Number(Boolean(old));
    summary.retryable += Number(Boolean(status) && retryStatus(status)) - Number(Boolean(old) && retryStatus(old));
    const unknown = value => /^(không rõ|khong ro)$/i.test(String(value || "").trim());
    summary.manualReview += Number(unknown(status)) - Number(unknown(old));
    rows.set(id, status);
    summary.total = rows.size;
    summary.completed = summary.checked - summary.retryable;
    summary.pending = summary.total - summary.completed;
  };
  return {
    summary,
    register(plans) {
      for (const plan of plans) {
        for (const task of plan.sharedQueue.tasks) if (!rows.has(key(plan, task.rowNumber))) rows.set(key(plan, task.rowNumber), "");
        // Honour successfully written results if a retry reload observes them.
        for (let i = 1; i < plan.values.length; i++) {
          const id = key(plan, i + 1), status = String(plan.values[i]?.[plan.nick1Index] || "").trim();
          if (rows.has(id)) setStatus(id, status);
        }
      }
      summary.total = rows.size;
      summary.pending = summary.total - summary.completed;
    },
    startTask() { if(speedStart === null) speedStart = batchStart = now(); },
    wrote(plan, task, status, timing = {}) {
      setStatus(key(plan, task.rowNumber), status);
      if(speedStart === null) speedStart = batchStart = now();
      const speed=summary.speed, time=now();
      speed.processed++;batchCount++;
      checkMs+=Number(timing.checkMs||0);saveMs+=Number(timing.saveMs||0);
      speed.average100Ms=(time-speedStart)*100/speed.processed;
      if(batchCount===100){
        const duration=time-batchStart;
        speed.batches++;speed.first100Ms ??= duration;speed.last100Ms=duration;
        speed.lastCheckMs=checkMs/100;speed.lastSaveMs=saveMs/100;
        speed.recent.push({batch:speed.batches,durationMs:duration});
        speed.recent=speed.recent.slice(-10);
        batchStart=time;batchCount=0;checkMs=0;saveMs=0;
      }
    },
    finish() { summary.running = false; summary.finishedAt = Date.now(); }
  };
}
