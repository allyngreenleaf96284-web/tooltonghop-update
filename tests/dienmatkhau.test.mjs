import assert from "node:assert/strict";
import { test } from "node:test";
import { createDienMatKhau } from "../modules/dienmatkhau.js";

test("password tool uses cell writer and preserves existing 2FA/cookie", async () => {
  const writes = [];
  const rows = new Map([["p1", { uid: "61500000000001", "mật khẩu": "", "2fa": "existing", cookie: "existing cookie" }],
    ["p2", { uid: "61500000000002", "mật khẩu": "keep" }]]);
  const runtime = { jobs: new Map(), running: false };
  const tool = createDienMatKhau({ runtime, addRuntimeLog() {},
    createSheetRowSession: async () => ({ rows, pending: new Map(),
      async updateOne(id, update) { writes.push({ id, update }); }, async flushAll() {}, async flush() {} }),
    readCredentialSourceMap: async () => ({ title: "source", byUid: new Map([["61500000000001", { password: "fixture", twofa: "new", cookie: "new" }]]) }) });
  const result = await tool.runQueue(["p1", "p2", "missing"], { spreadsheetId: "destination", credentialSourceSpreadsheetId: "source" });
  assert.equal(result.updated, 1);
  assert.deepEqual(writes, [{ id: "p1", update: { "mật khẩu": "fixture" } }]);
  assert.equal(runtime.jobs.get("missing").status, "error");
});
