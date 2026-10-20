import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConfigStore } from "../modules/config_store.js";

const initial = {
  spreadsheetId: "main-sheet", spreadsheetIds: ["main-sheet", "other-sheet"],
  accountSheets: { "gpm:one": "main-sheet", "hide:two": "other-sheet" },
  knownHideAccounts: { "gpm:one": { email: "fixture" } }, lastHideAccountId: "gpm:one",
  sellerSpreadsheetId: "seller-sheet", fourVPostSpreadsheetId: "listing-results", proxyProvider: "clipproxy"
};
async function fixture(t, content = initial) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-preservation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config.json");
  await fs.writeFile(filePath, typeof content === "string" ? content : JSON.stringify(content));
  return { root, filePath, store: createConfigStore(filePath) };
}

test("an empty/stale tool form cannot remove locally configured Sheet IDs or account bindings", async (t) => {
  const { store, filePath } = await fixture(t);
  const result = await store.write({ ...initial, spreadsheetId: "", spreadsheetIds: [], accountSheets: {}, knownHideAccounts: {}, fourVPostUnknownRetryCount: 2 });
  assert.deepEqual(result.spreadsheetIds, initial.spreadsheetIds);
  assert.deepEqual(result.accountSheets, initial.accountSheets);
  assert.deepEqual(result.knownHideAccounts, initial.knownHideAccounts);
  assert.equal(result.spreadsheetId, initial.spreadsheetId);
  assert.equal(JSON.parse(await fs.readFile(filePath)).fourVPostUnknownRetryCount, 2);
});

test("malformed config is never replaced with defaults if there is no valid backup", async (t) => {
  const original = '{"spreadsheetIds":["important-sheet"],';
  const { store, filePath } = await fixture(t, original);
  await assert.rejects(store.read(), /khong reset/);
  await assert.rejects(store.write({ spreadsheetIds: [] }), /khong reset/);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("corrupt JSON restores a valid local backup and preserves the corrupt bytes", async (t) => {
  const { store, filePath, root } = await fixture(t);
  await store.write({ ...initial, fourVPostUnknownRetryCount: 2 });
  await fs.writeFile(filePath, '{"incomplete":');
  assert.deepEqual((await store.read()).accountSheets, initial.accountSheets);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath)).spreadsheetIds, initial.spreadsheetIds);
  const invalid = (await fs.readdir(root)).find((name) => name.includes(".invalid-"));
  assert.equal(await fs.readFile(path.join(root, invalid), "utf8"), '{"incomplete":');
});

test("concurrent writes and reads keep JSON valid and preserve every existing Sheet binding", async (t) => {
  const { store } = await fixture(t);
  const tasks = [];
  for (let index = 0; index < 20; index += 1) {
    tasks.push(store.write({ counter: index, spreadsheetIds: [], accountSheets: {} }));
    tasks.push(store.read());
  }
  for (const result of await Promise.all(tasks)) {
    assert.deepEqual(result.accountSheets, initial.accountSheets);
    assert.deepEqual(result.spreadsheetIds, initial.spreadsheetIds);
  }
});

test("only an explicit Sheet-list edit can remove bindings; its backup remains recoverable", async (t) => {
  const { store } = await fixture(t);
  const cleared = { ...initial, spreadsheetId: "", spreadsheetIds: [], accountSheets: {}, lastHideAccountId: "", knownHideAccounts: {} };
  await store.write(cleared, { replaceSheetRegistry: true });
  assert.deepEqual((await store.read()).spreadsheetIds, []);
  const result = await store.restoreSheets();
  assert.deepEqual(result.spreadsheetIds, initial.spreadsheetIds);
  assert.deepEqual(result.accountSheets, initial.accountSheets);
});

test("a pre-update snapshot restores only Sheet settings and keeps current proxy/tool settings", async (t) => {
  const { store, root, filePath } = await fixture(t);
  await store.backup(path.join(root, "data", "update-backups", "version-fixture", "config.json"));
  await fs.writeFile(filePath, JSON.stringify({ spreadsheetIds: [], accountSheets: {}, proxyProvider: "nineproxy", postCondition: "New" }));
  const result = await store.restoreSheets();
  assert.deepEqual(result.accountSheets, initial.accountSheets);
  assert.equal(result.sellerSpreadsheetId, initial.sellerSpreadsheetId);
  assert.equal(result.fourVPostSpreadsheetId, initial.fourVPostSpreadsheetId);
  assert.equal(result.proxyProvider, "nineproxy");
  assert.equal(result.postCondition, "New");
});

test("missing backups report recovery unavailable instead of inventing or assigning Sheets", async (t) => {
  const { store, filePath } = await fixture(t, { spreadsheetIds: [], accountSheets: {} });
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(store.restoreSheets(), /Khong tim thay ban sao luu/);
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});
