import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as status from "../modules/seller_info_status.js";

function fixture() {
  const writes = [];
  const row = (rowNumber, ssn, uid, address) => ({ rowNumber, values: [ssn, address, uid], raw: { SSN: ssn, Address: address, UID: uid } });
  const sheet = { title: "Seller's Info", headers: ["SSN", "Address", "UID"], uidIndex: 2,
    rows: [row(2, "111-22-3333", "dang dung:p1", "A"), row(3, "111223333", "dang dung:p2", "A"), row(4, "222334444", "", "B")],
    client: { async batchUpdateValues(data) { writes.push(...data); } } };
  const allocation = { sheetTitle: sheet.title, rowNumber: 2, raw: { ...sheet.rows[0].raw }, lockValue: "dang dung:p1" };
  return { sheet, allocation, writes };
}

test("Invalid address marks every matching SSN in UID cells while preserving other data", async () => {
  const { sheet, allocation, writes } = fixture();
  assert.deepEqual(await status.markSellerAddressInvalid(sheet, allocation), { updated: 2 });
  assert.deepEqual(sheet.rows.map((row) => row.values[2]), ["lỗi địa chỉ", "lỗi địa chỉ", ""]);
  assert.deepEqual(sheet.rows.map((row) => row.values[1]), ["A", "A", "B"]);
  assert.deepEqual(writes.map((entry) => entry.range), ["'Seller''s Info'!C2", "'Seller''s Info'!C3"]);
  assert.ok(writes.every((entry) => entry.values[0].length === 1));
  assert.equal(allocation.addressInvalid, true);
});

test("an empty SSN marks only the failed row, never every blank SSN row", async () => {
  const { sheet, allocation, writes } = fixture();
  allocation.raw.SSN = "";
  sheet.rows[0].raw.SSN = ""; sheet.rows[1].raw.SSN = "";
  await status.markSellerAddressInvalid(sheet, allocation);
  assert.equal(writes.length, 1);
  assert.equal(sheet.rows[1].raw.UID, "dang dung:p2");
});

test("SSN comparison tolerates formatting and lost leading zeros without treating blanks as equal", () => {
  assert.equal(status.sellerSsn({ " ssn ": "001-22-3333" }), status.sellerSsn({ SSN: 1223333 }));
  assert.equal(status.sellerSsn({ SSN: "" }), "");
  assert.equal(status.sellerSsn({}), "");
});

test("actual server release cannot clear errors, and allocation skips duplicate blocked SSNs", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const { sheet, allocation, writes } = fixture();
  const context = { ...status, withSellerInfoLock: async (action) => action(), readSellerInfoSheet: async () => sheet };
  const updateStart = source.indexOf("async function updateSellerInfoUid(");
  const updateEnd = source.indexOf("\nlet marketplacePostResultWriteQueue", updateStart);
  const update = vm.runInNewContext(`(${source.slice(updateStart, updateEnd)})`, context);
  await update({}, allocation, "lỗi địa chỉ");
  const siblingAllocation = { sheetTitle: sheet.title, rowNumber: 3, raw: { SSN: "111223333" }, lockValue: "dang dung:p2" };
  assert.equal(await update({}, allocation, ""), false);
  assert.equal(await update({}, siblingAllocation, "p2"), false);
  assert.equal(writes.length, 2);
  const allocateStart = source.indexOf("async function allocateSellerInfoRow(");
  const allocate = vm.runInNewContext(`(${source.slice(allocateStart, updateStart)})`, context);
  // A newly added, blank copy must not resurrect an already blocked SSN.
  sheet.rows.push({ rowNumber: 5, values: ["111223333", "A", ""], raw: { SSN: "111223333", UID: "" } });
  const next = await allocate({}, "p3");
  assert.equal(next.rowNumber, 4);
  assert.equal(sheet.rows[0].raw.UID, "lỗi địa chỉ");
  assert.equal(sheet.rows[1].raw.UID, "lỗi địa chỉ");
});
