import assert from "node:assert/strict";
import { test } from "node:test";
import { accountIdentityRecord, resolveFallbackAccountIdentity } from "../modules/account_identity.js";

const original = {
  id: "gpm:original", provider: "gpm", fallback: true,
  email: "GPM Login (3 group)", baseUrl: "http://127.0.0.1:12003/api/v3",
  folderIds: ["all", "group-a", "group-b"]
};
function configWith(account = original) {
  return {
    spreadsheetId: "sheet-existing", spreadsheetIds: ["sheet-existing"],
    accountSheets: { [account.id]: "sheet-existing" }, lastHideAccountId: account.id,
    knownHideAccounts: { [account.id]: accountIdentityRecord(account) }
  };
}

test("existing GPM Sheet binding survives restart, group changes, and local API port changes", () => {
  let config = configWith();
  for (const folderIds of [["all", "group-a", "group-b", "group-c"], ["all", "group-b"], ["all", "group-b", "group-d"]]) {
    config = JSON.parse(JSON.stringify(config));
    const detected = { ...original, id: "gpm:changed-hash", baseUrl: "http://localhost:18000/api/v3", folderIds };
    const resolved = resolveFallbackAccountIdentity(detected, config);
    assert.equal(resolved.id, original.id);
    assert.equal(config.accountSheets[resolved.id], "sheet-existing");
    config.knownHideAccounts[resolved.id] = accountIdentityRecord(resolved);
  }
  assert.equal(Object.keys(config.accountSheets).length, 1);
});

test("a single legacy GPM binding is restored without asking for another Spreadsheet", () => {
  const config = configWith();
  config.knownHideAccounts = { [original.id]: { id: original.id, email: original.email } };
  const resolved = resolveFallbackAccountIdentity({ ...original, id: "gpm:new-fingerprint" }, config);
  assert.equal(resolved.id, original.id);
  const metadata = accountIdentityRecord(resolved);
  assert.deepEqual(metadata.folderIds, ["group-a", "group-b"]);
  assert.equal(metadata.baseUrl, original.baseUrl);
});

test("a new account with disjoint groups never takes the old account Sheet through the shared all group", () => {
  const detected = { ...original, id: "gpm:different", folderIds: ["all", "different-group"] };
  assert.equal(resolveFallbackAccountIdentity(detected, configWith()).id, detected.id);
});

test("legacy updates that accumulated old Sheets restore the last active binding and persist real group evidence", () => {
  const config = configWith();
  config.spreadsheetIds.push("obsolete-sheet");
  config.accountSheets["gpm:obsolete-hash"] = "obsolete-sheet";
  config.knownHideAccounts = {
    [original.id]: { id: original.id, email: original.email },
    "gpm:obsolete-hash": { id: "gpm:obsolete-hash", email: original.email }
  };
  const detected = { ...original, id: "gpm:new-hash-after-update" };
  const restored = resolveFallbackAccountIdentity(detected, config);
  assert.equal(restored.id, original.id);
  assert.equal(config.accountSheets[restored.id], "sheet-existing");
  config.knownHideAccounts[restored.id] = accountIdentityRecord(restored);
  assert.equal(resolveFallbackAccountIdentity({ ...detected, folderIds: ["all", "unrelated"] }, config).id, detected.id);
});

test("multiple accounts resolve by actual group IDs, not group count or most recently used account", () => {
  const config = configWith();
  const second = { ...original, id: "gpm:second", folderIds: ["all", "group-x", "group-y"] };
  config.spreadsheetIds.push("sheet-second");
  config.accountSheets[second.id] = "sheet-second";
  config.knownHideAccounts[second.id] = accountIdentityRecord(second);
  config.lastHideAccountId = original.id;
  const detected = { ...second, id: "gpm:new-second-hash", folderIds: ["all", "group-x", "new-group"] };
  assert.equal(resolveFallbackAccountIdentity(detected, config).id, second.id);
});

test("ambiguous legacy accounts, removed Sheets, and other providers are never auto-reassigned", () => {
  const config = configWith();
  config.accountSheets["gpm:other"] = "sheet-other";
  config.spreadsheetIds.push("sheet-other");
  config.knownHideAccounts = {};
  const detected = { ...original, id: "gpm:unknown" };
  assert.equal(resolveFallbackAccountIdentity(detected, config).id, detected.id);
  assert.equal(resolveFallbackAccountIdentity(detected, { ...configWith(), spreadsheetIds: ["sheet-replacement"] }).id, detected.id);
  const hide = { ...detected, id: "hide:unknown", provider: "hide" };
  assert.equal(resolveFallbackAccountIdentity(hide, configWith()).id, hide.id);
});

test("known exact identities remain unchanged, and real account IDs do not use fallback recovery", () => {
  assert.equal(resolveFallbackAccountIdentity(original, configWith()).id, original.id);
  const real = { ...original, id: "real-account", fallback: false };
  assert.equal(resolveFallbackAccountIdentity(real, configWith()), real);
});
