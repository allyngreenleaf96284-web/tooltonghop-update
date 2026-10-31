export const SELLER_ADDRESS_ERROR = "lỗi địa chỉ";

function clean(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").trim().toLowerCase();
}

export function isSellerAddressError(value) {
  const text = clean(typeof value === "object" ? `${value?.sellerInfoReason || ""} ${value?.message || ""}` : value);
  return /loi dia chi|sai address|invalid address|please make sure (?:that )?your address is correct|po boxes can[’']t be used/.test(text);
}

export function sellerSsn(raw) {
  const entry = Object.entries(raw || {}).find(([key]) => clean(key) === "ssn");
  const value = String(entry?.[1] ?? "").replace(/[\s-]/g, "");
  return /^\d{1,9}$/.test(value) ? value.padStart(9, "0") : value;
}

export function setSellerUid(sheet, row, value) {
  row.values[sheet.uidIndex] = value;
  for (const key of Object.keys(row.raw)) if (clean(key) === "uid") row.raw[key] = value;
  row.raw.uid = value;
}

export async function writeSellerUidCells(sheet, rows, value) {
  let number = sheet.uidIndex + 1, column = "";
  while (number > 0) { number--; column = String.fromCharCode(65 + number % 26) + column; number = Math.floor(number / 26); }
  await sheet.client.batchUpdateValues(rows.map((row) => ({
    range: `'${sheet.title.replace(/'/g, "''")}'!${column}${row.rowNumber}`, values: [[value]]
  })));
}

export async function markSellerAddressInvalid(sheet, allocation) {
  if (allocation.sheetTitle !== sheet.title) throw new Error("Seller Info: tab da thay doi, chua danh dau loi dia chi.");
  const ssn = sellerSsn(allocation.raw);
  const matches = sheet.rows.filter((row) => ssn ? sellerSsn(row.raw) === ssn : row.rowNumber === allocation.rowNumber);
  if (!matches.length) throw new Error("Seller Info: khong tim thay nhom dong can danh dau loi dia chi.");
  // Reserve the whole group in memory even if a network error interrupts the
  // write. Never expose the SSN in logs or error messages.
  allocation.addressInvalid = true;
  for (const row of matches) setSellerUid(sheet, row, SELLER_ADDRESS_ERROR);
  await writeSellerUidCells(sheet, matches, SELLER_ADDRESS_ERROR);
  return { updated: matches.length };
}

export function sellerAddressIsBlocked(row) {
  const uid = Object.entries(row?.raw || {}).find(([key]) => clean(key) === "uid")?.[1];
  return clean(uid) === clean(SELLER_ADDRESS_ERROR);
}
