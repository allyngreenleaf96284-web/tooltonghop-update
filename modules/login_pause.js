import { AsyncLocalStorage } from "node:async_hooks";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const interrupted = () => Object.assign(new Error("Tool Login tam dung; doc lai trang khi tiep tuc."), { code: "LOGIN_PAUSED" });
const stopped = () => Object.assign(new Error("Da dung han Tool Login."), { status: "stopped" });

export function createLoginPause(runtime) {
  const context = new AsyncLocalStorage();
  const records = new Map();
  const wrapped = new WeakSet();
  let all = false;
  const record = (id) => {
    if (!records.has(id)) records.set(id, { local: false, listeners: new Set() });
    return records.get(id);
  };
  const paused = (id) => all || record(id).local;
  function publish(id) {
    const job = runtime.jobs.get(id);
    if (!job) return;
    job.loginPaused = paused(id);
    job.loginLocalPaused = record(id).local;
    if (job.loginPaused && !job.loginPausedAt) job.loginPausedAt = Date.now();
    if (!job.loginPaused && job.loginPausedAt) {
      const elapsed = Date.now() - job.loginPausedAt;
      if (job.twofaCountdownEndsAt) job.twofaCountdownEndsAt += elapsed;
      job.loginPausedAt = 0;
    }
  }
  function toggle(id = "") {
    if (!runtime.running || runtime.currentTool !== "tool login") return { paused: false };
    if (id) {
      if (!["queued", "running"].includes(runtime.jobs.get(id)?.status) || runtime.jobs.get(id)?.loginPauseSupported === false) throw new Error("Profile khong dang o luong Tool Login.");
      record(id).local = !record(id).local;
    } else all = !all;
    runtime.loginPaused = all;
    for (const [key, job] of runtime.jobs) {
      if (job.tool !== "tool login" || job.loginPauseSupported === false || !["queued", "running"].includes(job.status)) continue;
      publish(key);
      if (paused(key)) for (const notify of record(key).listeners) notify();
    }
    return { paused: id ? paused(id) : all };
  }
  async function gate(id) {
    while (paused(id)) {
      if (runtime.stopRequested) throw stopped();
      await delay(100);
    }
    if (runtime.stopRequested) throw stopped();
  }
  function assertCurrent() {
    const token = context.getStore();
    if (!token) return;
    if (!token.valid) throw interrupted();
    if (runtime.stopRequested) throw stopped();
    if (token.restartable && paused(token.id)) throw interrupted();
  }
  async function run(id, action, timeoutMs = 0, restartable = false) {
    let remaining = timeoutMs, resumed = false;
    for (;;) {
      await gate(id);
      const token = { id, valid: true, resumed, restartable };
      let timer, notify;
      const startedAt = Date.now();
      try {
        const work = context.run(token, action);
        const races = [work];
        if (restartable) races.push(new Promise((_, reject) => {
          notify = () => { token.valid = false; reject(interrupted()); };
          record(id).listeners.add(notify);
        }));
        if (remaining > 0) races.push(new Promise((_, reject) => {
          let left = remaining, previous = Date.now();
          timer = setInterval(() => {
            const now = Date.now();
            if (!paused(id)) left -= now - previous;
            previous = now;
            if (runtime.stopRequested) reject(stopped());
            else if (left <= 0) reject(new Error("Tool Login: buoc hien tai qua thoi gian cho."));
          }, 100);
        }));
        const result = await Promise.race(races);
        await gate(id);
        return result;
      } catch (error) {
        if (error.code !== "LOGIN_PAUSED" || !restartable) throw error;
        if (timeoutMs) remaining = Math.max(1, remaining - (Date.now() - startedAt));
        resumed = true;
      } finally {
        token.valid = false;
        clearInterval(timer);
        if (notify) record(id).listeners.delete(notify);
      }
    }
  }
  function guard(object, methods) {
    if (!object || wrapped.has(object)) return object;
    wrapped.add(object);
    for (const name of methods) {
      if (typeof object[name] !== "function") continue;
      const original = object[name];
      object[name] = async function (...args) {
        assertCurrent();
        const value = await original.apply(this, args);
        assertCurrent();
        if (["$", "$$", "waitForSelector", "evaluateHandle"].includes(name)) {
          for (const handle of Array.isArray(value) ? value : [value]) guard(handle, ["click", "type", "press", "focus", "evaluate", "$", "$$", "evaluateHandle"]);
        }
        return value;
      };
    }
    return object;
  }
  async function attach(page) {
    const bind = "__toolLoginTogglePause";
    await page.exposeFunction(bind, () => toggle());
    const install = () => {
      if (window.__toolLoginF8Installed) return;
      window.__toolLoginF8Installed = true;
      addEventListener("keydown", (event) => {
        if (event.code !== "F8" || event.repeat) return;
        event.preventDefault(); event.stopImmediatePropagation();
        window.__toolLoginTogglePause().catch(() => {});
      }, true);
    };
    await page.evaluateOnNewDocument(install);
    await page.evaluate(install);
    guard(page, ["goto", "reload", "evaluate", "evaluateHandle", "$", "$$", "$eval", "$$eval", "click", "type", "focus", "select", "waitForSelector", "waitForFunction", "setCookie", "deleteCookie"]);
    const frames = page.frames.bind(page);
    page.frames = () => frames().map((frame) => guard(frame, ["goto", "evaluate", "evaluateHandle", "$", "$$", "$eval", "$$eval", "click", "type", "select", "waitForSelector", "waitForFunction"]));
    guard(page.keyboard, ["type", "press", "down", "up", "sendCharacter"]);
    guard(page.mouse, ["click", "down", "up", "move", "wheel"]);
  }
  return { toggle, run, gate, attach, guard,
    resuming: () => context.getStore()?.resumed === true,
    isCurrent: () => context.getStore()?.valid !== false,
    reset: () => { all = false; records.clear(); runtime.loginPaused = false; }
  };
}
