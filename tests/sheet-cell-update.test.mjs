import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

test("session reads fresh Sheet and writes only changed cells, preserving external credentials", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("async function createSheetRowSession(");
  const end = source.indexOf("\nasync function ", start + 1);
  const headers = [" ID GPM ", "password", "bang", "status", "name"];
  const remote = ["p1", "new password entered directly in Sheet", "Texas", "old", "old name"];
  let fresh = false;
  const normalizeProfileIdText = (value) => String(value || "").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
  const normalizeHeaderName = (value) => String(value).trim().toLowerCase();
  const helperStart = source.indexOf("function sheetProfileId(");
  const sheetProfileId = vm.runInNewContext(`(${source.slice(helperStart, start)})`, { normalizeProfileIdText, normalizeHeaderName });
  assert.equal(sheetProfileId({ " ID GPM ": " p\u200b1 " }), "p1");
  assert.equal(sheetProfileId({ "id hide": "", "ID GPM": "p1" }), "p1");
  assert.equal(sheetProfileId({ "id hide": "p1", "ID GPM": "p2" }), "");
  const context = {
    normalizeProfileIdText, sheetProfileId,
    readManagedSheetData: async (_, options) => { fresh = options.forceRefresh; return { client: {}, headers,
      data: new Map([["Profiles", { headers, rows: [{ " ID GPM ": " p\u200b1 ", password: "stale", bang: "California", status: "old", name: "old name" }] }]]) }; },
    ensureRequiredHeadersForSession: async () => {}, DEFAULT_CONFIG: { headers },
    normalizeHeaderName: (value) => value, preserveStableSheetFields() {},
    objectToRow: (cols, row) => cols.map((key) => row[key] ?? ""),
    toolRuntime: {}, getGoogleAccessToken: async () => "fixture",
    SheetsClient: class { async batchUpdateValues(data) {
      for (const entry of data) {
        assert.equal(entry.values[0].length, 1);
        const column = entry.range.match(/!([A-Z]+)2$/)[1];
        remote[column.charCodeAt(0) - 65] = entry.values[0][0];
      }
    } },
    updateManagedSheetCacheRows() {}, setTimeout, clearTimeout, console
  };
  const create = vm.runInNewContext(`(${source.slice(start, end)})`, context);
  const session = await create({ spreadsheetId: "fixture" }, ["p1"]);
  assert.equal(fresh, true);
  await session.updateOne("p1", { status: "running" });
  await session.updateOne("p1", { name: "new GPM name" });
  await session.flushAll();
  assert.deepEqual(remote, ["p1", "new password entered directly in Sheet", "Texas", "running", "new GPM name"]);
});
