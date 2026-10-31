// Only Latin-script names are submitted automatically. Never transliterate
// other scripts into a guessed account-holder identity.
export function normalizeBankAccountName(value) {
  const source = String(value ?? "").normalize("NFC").trim();
  if ([...source].some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch))) {
    const error = new Error("cdt: Name on account co chu ngoai Latin; can kiem tra va doi ten thu cong.");
    error.status = "cdt";
    error.retryable = false;
    throw error;
  }
  return source.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

export function buildCdtProfileName(value) {
  return `cdt-${String(value || "").trim().replace(/^(?:cdt-)+/i, "")}`;
}

export function installBankAccountNameGuard(manager) {
  const original = manager.setFieldValueByExactLabel;
  if (typeof original !== "function") return () => {};
  manager.setFieldValueByExactLabel = function(page, label, value, ...args) {
    const labels = Array.isArray(label) ? label : [label];
    const isAccountName = labels.some((text) => /^name on account$/i.test(String(text).trim()));
    return original.call(this, page, label, isAccountName ? normalizeBankAccountName(value) : value, ...args);
  };
  return () => { manager.setFieldValueByExactLabel = original; };
}
