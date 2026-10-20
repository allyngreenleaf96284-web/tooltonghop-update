import { readFile, writeFile, rename, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const sheetFields = ["spreadsheetId", "spreadsheetIds", "accountSheets", "lastHideAccountId", "knownHideAccounts",
  "sellerSpreadsheetId", "credentialSourceSpreadsheetId", "fourVPostSpreadsheetId", "checkOrderSpreadsheetId",
  "marketplaceCheckSpreadsheetId", "marketplaceCheckSpreadsheetIds"];
const unique = (items) => [...new Set(items.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];

function parseConfig(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config phai la JSON object.");
  return value;
}

export function preserveSheetRegistry(current, next, replace = false) {
  if (replace) return next;
  const accountSheets = { ...next.accountSheets, ...current.accountSheets };
  return {
    ...next,
    spreadsheetId: next.spreadsheetId || current.spreadsheetId || "",
    spreadsheetIds: unique([...(current.spreadsheetIds || []), current.spreadsheetId,
      ...(next.spreadsheetIds || []), next.spreadsheetId, ...Object.values(accountSheets)]),
    accountSheets,
    lastHideAccountId: next.lastHideAccountId || current.lastHideAccountId || "",
    knownHideAccounts: { ...current.knownHideAccounts, ...next.knownHideAccounts }
  };
}

export function createConfigStore(filePath, { defaults = () => ({}) } = {}) {
  const backupPath = `${filePath}.bak`;
  let pending = Promise.resolve();
  function locked(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }
  async function atomicWrite(target, text) {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, target);
  }
  async function readRaw() {
    try { return parseConfig(await readFile(filePath, "utf8")); }
    catch (error) {
      if (error.code && error.code !== "ENOENT") throw error;
      let backup;
      try { backup = parseConfig(await readFile(backupPath, "utf8")); }
      catch (backupError) {
        if (error.code === "ENOENT" && backupError.code === "ENOENT") return structuredClone(defaults());
        throw new Error("Khong doc duoc config.json. Da giu nguyen file, khong reset cau hinh hay link Sheet.");
      }
      if (error.code !== "ENOENT") {
        const original = await readFile(filePath, "utf8");
        await writeFile(`${filePath}.invalid-${Date.now()}`, original, "utf8");
      }
      await atomicWrite(filePath, JSON.stringify(backup, null, 2));
      return backup;
    }
  }
  async function saveRaw(next, options = {}) {
    const current = await readRaw();
    const result = preserveSheetRegistry(current, next, options.replaceSheetRegistry === true);
    // Keep a link-bearing backup even if a later config has lost its Sheet list.
    const backup = current.spreadsheetIds?.length || current.spreadsheetId || Object.keys(current.accountSheets || {}).length
      ? current : result.spreadsheetIds?.length ? result : null;
    if (backup) {
      await atomicWrite(backupPath, JSON.stringify(backup, null, 2));
    }
    await atomicWrite(filePath, JSON.stringify(result, null, 2));
    return result;
  }
  return {
    read: () => locked(readRaw),
    write: (next, options) => locked(() => saveRaw(next, options)),
    backup: (target) => locked(async () => {
      const current = await readRaw();
      await atomicWrite(target, JSON.stringify(current, null, 2));
    }),
    restoreSheets: () => locked(async () => {
      const current = await readRaw();
      const candidates = [backupPath];
      const updateRoot = path.join(path.dirname(filePath), "data", "update-backups");
      for (const entry of await readdir(updateRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if (entry.isDirectory()) candidates.push(path.join(updateRoot, entry.name, "config.json"));
      }
      const snapshots = [];
      for (const candidate of candidates) {
        try {
          const value = parseConfig(await readFile(candidate, "utf8"));
          if (value.spreadsheetIds?.length || value.spreadsheetId || Object.keys(value.accountSheets || {}).length) {
            snapshots.push({ value, modified: (await stat(candidate)).mtimeMs });
          }
        } catch (error) { if (error.code && error.code !== "ENOENT") throw error; }
      }
      snapshots.sort((a, b) => b.modified - a.modified);
      if (!snapshots.length) throw new Error("Khong tim thay ban sao luu co link Sheet. Can config.json cu tren may nay de khoi phuc, khong can tao Sheet moi.");
      const restored = { ...current };
      for (const field of sheetFields) {
        if (snapshots[0].value[field] !== undefined) restored[field] = snapshots[0].value[field];
      }
      return saveRaw(preserveSheetRegistry(current, restored));
    })
  };
}
