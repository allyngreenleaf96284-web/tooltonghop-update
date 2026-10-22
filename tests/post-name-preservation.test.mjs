import assert from "node:assert/strict";
import { test } from "node:test";
import { createDangBai, buildStandardPostSuccessProfileName, buildStandardPostErrorProfileName } from "../modules/dangbai.js";

const tail = "full 18/10 624446936-3v-61583080715416-Taylorsville, Georgia-tool";
const original = `Vip14-01-${tail}`;
test("posting replaces only the prefix before full and the detected bar, matching the requested example", () => {
  assert.equal(buildStandardPostSuccessProfileName("db1", original, "2v"), "db1--full 18/10 624446936-2v-61583080715416-Taylorsville, Georgia-tool");
  assert.equal(buildStandardPostSuccessProfileName("db1", original, "3v"), `db1--${tail}`);
  assert.equal(buildStandardPostSuccessProfileName("", original, "3v"), tail);
});

test("repeated successes and retries replace labels without changing or duplicating the full segment", () => {
  let name = original;
  for (let run = 0; run < 5; run += 1) {
    name = buildStandardPostErrorProfileName("loi", name);
    assert.equal(name, `loi--${tail}`);
  }
  name = buildStandardPostSuccessProfileName("db1-", name, "2v");
  assert.equal(name, `db1--${tail.replace("-3v-", "-2v-")}`);
  assert.equal(buildStandardPostSuccessProfileName("db2-", name, "3v"), `db2--${tail}`);
});

test("every error status preserves full and its complete suffix byte-for-byte", () => {
  for (const status of ["loi", "lỗi sp", "lỗi link sp", "die cho", "capcha", "loicapcha", "cp282", "cp956", "hetproxy", "biout", "limitdb"]) {
    const next = buildStandardPostErrorProfileName(status, original);
    assert.equal(next.slice(next.indexOf("full")), tail, status);
    assert.equal(buildStandardPostErrorProfileName(status, next), next);
  }
});

test("full is prioritised over an earlier v-marker and its formatting remains unchanged", () => {
  const suffix = "FULL  18/10 624446936-custom-7V-61583080715416-Taylorsville,  Georgia-tool-extra";
  const value = `old-2v-Vip14-${suffix}`;
  assert.equal(buildStandardPostSuccessProfileName("db1", value, "2v"), `db1--${suffix.replace("-7V-", "-2v-")}`);
  assert.equal(buildStandardPostErrorProfileName("loi", value), `loi--${suffix}`);
});

test("without full the existing nv anchor is kept and all following name data is preserved", () => {
  for (const bar of ["2v", "3v", "4v", "12v"]) {
    const suffix = `${bar}-61583080715416-Taylorsville, Georgia-tool-extra`;
    assert.equal(buildStandardPostSuccessProfileName("db1-", `vip-old-${suffix}`, "2v"), `db1-2v-61583080715416-Taylorsville, Georgia-tool-extra`);
    assert.equal(buildStandardPostErrorProfileName("loi", `vip-old-${suffix}`), `loi-${suffix}`);
  }
});

test("a name without any v-marker is preserved instead of rebuilding UID/location fields", () => {
  assert.equal(buildStandardPostSuccessProfileName("db1", "vip-full 18/10 624446936-custom-tail", "2v"), "db1--full 18/10 624446936-custom-tail");
  assert.equal(buildStandardPostErrorProfileName("loi", "vip-full 18/10 624446936-custom-tail"), "loi--full 18/10 624446936-custom-tail");
});

test("posting queue failures and reruns preserve the full suffix in both profile and Sheet", async (t) => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = schedule(callback, milliseconds, ...args);
    if (milliseconds >= 30000) timer.unref();
    return timer;
  });
  let name = original;
  const writes = [];
  const runtime = { jobs: new Map() };
  const sheet = { rows: new Map([["p1", { "tên profile hiện tại": original }]]),
    async updateOne(id, update) { writes.push(update); }, async flushAll() {} };
  const posting = createDangBai({
    getManager: () => ({ saveConfig() {}, async getProfileById() { return { name }; },
      async updateProfileName(id, next) { name = next; }, async stopHideMyAccProfile() {} }),
    dangNhap: {}, addRuntimeLog() {}, buildToolRow: () => ({ uid: "different-sheet-uid", raw: {} }),
    createSheetRowSession: async () => sheet,
    stateProxy: { async ensureForProfile() { throw new Error("fixture failure"); } }, runtime
  });
  for (let run = 0; run < 2; run += 1) {
    await posting.runQueue(["p1"], { fullDataRoot: "fixture", fullPriceMin: 20, fullPriceMax: 25, postConcurrency: 1 });
    for (let attempt = 0; attempt < 100 && runtime.running; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.running, false);
    assert.equal(runtime.jobs.get("p1").status, "error");
    assert.equal(name, `loi--${tail}`);
    assert.equal(writes.at(-1).tenChuan, name);
  }
});
