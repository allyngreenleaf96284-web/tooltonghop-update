import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

test("failed Sheet flush preserves a newer name queued while the old request was in flight", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("    async flush() {", source.indexOf("async function createSheetRowSession"));
  const end = source.indexOf("    async flushAll()", start);
  assert.ok(start > 0 && end > start);
  const method = vm.runInNewContext(`({${source.slice(start, end)}}).flush`, {
    config: {}, headers: [], objectToRow: () => [], getGoogleAccessToken: async () => "fixture",
    SheetsClient: class {}, updateManagedSheetCacheRows() {}, clearTimeout
  });
  let rejectWrite, started;
  const entered = new Promise((resolve) => { started = resolve; });
  const session = { pending: new Map([["p1", { name: "old", _dirtyCells: { 3: "old status", 4: "old" }, _sheetTitle: "Profiles", _rowNumber: 2 }]]), waiters: [],
    writeBatchWithRetry: () => { started(); return new Promise((resolve, reject) => { rejectWrite = reject; }); } };
  const work = method.call(session);
  await entered;
  session.pending.set("p1", { name: "operator name", _dirtyCells: { 4: "operator name" }, _sheetTitle: "Profiles", _rowNumber: 2 });
  rejectWrite(Error("network failed"));
  await assert.rejects(work, /network failed/);
  assert.equal(session.pending.get("p1").name, "operator name");
  assert.equal(session.pending.get("p1")._dirtyCells[3], "old status");
  assert.equal(session.pending.get("p1")._dirtyCells[4], "operator name");
});
