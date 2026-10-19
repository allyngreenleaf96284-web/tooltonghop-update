function realFolderIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((id) => String(id || "").trim())
    .filter((id) => id && id !== "all"))].sort();
}

export function accountIdentityRecord(account) {
  return {
    id: account.id,
    email: account.email || "",
    plan: account.plan || "",
    provider: account.provider || "",
    baseUrl: account.baseUrl || "",
    folderIds: realFolderIds(account.folderIds)
  };
}

export function resolveFallbackAccountIdentity(account, config = {}) {
  if (!account.fallback) return account;
  const assignments = config.accountSheets || {};
  const known = config.knownHideAccounts || {};
  const validSheets = new Set(config.spreadsheetIds?.length ? config.spreadsheetIds : [config.spreadsheetId]);
  const candidates = Object.entries(assignments).filter(([id, sheet]) =>
    id.startsWith(`${account.provider}:`) && validSheets.has(sheet));
  if (candidates.some(([id]) => id === account.id)) return account;

  const folders = new Set(realFolderIds(account.folderIds));
  const matches = candidates.map(([id]) => ({
    id,
    overlap: realFolderIds(known[id]?.folderIds).filter((folder) => folders.has(folder)).length
  })).filter((item) => item.overlap > 0).sort((a, b) => b.overlap - a.overlap);
  if (matches.length && (matches.length === 1 || matches[0].overlap > matches[1].overlap)) {
    return { ...account, id: matches[0].id };
  }
  if (matches.length) return account;

  // Recover the last explicitly active legacy binding after an update, even
  // if earlier versions accumulated additional obsolete account hashes.
  const active = candidates.find(([id, sheet]) => id === config.lastHideAccountId && sheet === config.spreadsheetId);
  if (active && !Array.isArray(known[active[0]]?.folderIds)
    && known[active[0]]?.email === account.email) {
    return { ...account, id: active[0] };
  }

  // Old versions stored only a hash and a label. Recover the sole legacy
  // binding, but never guess between multiple accounts/sheets.
  const sheets = new Set(candidates.map(([, sheet]) => sheet));
  if (sheets.size === 1 && candidates.every(([id]) => !Array.isArray(known[id]?.folderIds))) {
    const previous = candidates.find(([id]) => id === config.lastHideAccountId) || candidates[0];
    return { ...account, id: previous[0] };
  }
  return account;
}
