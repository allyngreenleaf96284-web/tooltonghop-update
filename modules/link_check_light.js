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

export function createLinkCheckProgress(runtime, profileCount, retryStatus) {
  const rows = new Map();
  const startedAt = Date.now();
  const summary = runtime.linkOrderProgress = {
    total: 0, checked: 0, completed: 0, retryable: 0, pending: 0, manualReview: 0,
    inFlight: 0, activeProfiles: 0, profileCount, attempts: 0, pass: 1,
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
    wrote(plan, task, status) { setStatus(key(plan, task.rowNumber), status); },
    finish() { summary.running = false; summary.finishedAt = Date.now(); }
  };
}
