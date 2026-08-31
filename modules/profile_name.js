function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeKey(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sheetValue(row, ...keys) {
  const source = row || {};
  const wanted = new Set(keys.map((key) => normalizeKey(key)).filter(Boolean));
  for (const [key, value] of Object.entries(source)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function extractUidFromText(text) {
  const matches = String(text || "").match(/\b[61]\d{12,14}\b/g) || [];
  return matches[0] ? String(matches[0]).trim() : "";
}

function extractBarFromText(text) {
  const match = String(text || "").match(/(?:^|-)(2v|3v|4v)(?=-|$)/i);
  return match?.[1] ? String(match[1]).toLowerCase() : "";
}

function extractPauseOrderFromText(text) {
  const match = String(text || "").match(/^(pause|order)(?=-|$)/i);
  return match?.[1] ? String(match[1]).toLowerCase() : "";
}

function extractDbVipToken(text) {
  const match = String(text || "").match(/(?:^|-)(DB VIP\s*\d+)(?=-|$)/i);
  return match?.[1] ? normalizeSegment(match[1]) : "";
}

function extractDbToken(text) {
  const match = String(text || "").match(/(?:^|-)(DB\s+\d+)(?=-|$)/i);
  return match?.[1] ? normalizeSegment(match[1]) : "";
}

function extractLocationFromText(text) {
  const match = String(text || "").match(/(?:^|-)([^-]+,\s*[^-]+?)(?:-tool)?$/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function extractFullTokenFromText(text) {
  const match = String(text || "").match(/(?:^|-)(full[^-]*)(?=-|$)/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function normalizeSegment(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .trim();
}

export function buildFullSuccessToken(ssnValue, now = new Date()) {
  const ssnDigits = String(ssnValue || "").replace(/\D/g, "");
  if (!ssnDigits) return "";
  const day = now.getDate();
  const month = now.getMonth() + 1;
  return `full ${day}/${month} ${ssnDigits}`;
}

export function buildStandardName({
  currentName = "",
  sheetRow = {},
  pauseOrder = "",
  dbVipToken = "",
  fullToken = "",
  dbToken = "",
  soVach = "",
  uid = "",
  location = ""
} = {}) {
  const tenChuan = firstNonEmpty(
    sheetValue(sheetRow, "tên chuẩn", "ten chuan"),
    sheetValue(sheetRow, "tên profile hiện tại", "ten profile hien tai")
  );
  const sourceText = [currentName, tenChuan].filter(Boolean).join(" ");

  const finalPauseOrder = normalizeSegment(
    firstNonEmpty(pauseOrder, extractPauseOrderFromText(currentName), extractPauseOrderFromText(tenChuan))
  ).toLowerCase();
  const finalDbVipToken = normalizeSegment(
    firstNonEmpty(
      dbVipToken,
      extractDbVipToken(currentName),
      extractDbVipToken(tenChuan)
    )
  );
  const finalFullToken = normalizeSegment(
    firstNonEmpty(fullToken, extractFullTokenFromText(currentName), extractFullTokenFromText(tenChuan))
  );
  const finalDbToken = normalizeSegment(
    firstNonEmpty(
      dbToken,
      extractDbToken(currentName),
      extractDbToken(tenChuan)
    )
  );
  const finalBar = normalizeSegment(
    firstNonEmpty(
      soVach,
      sheetValue(sheetRow, "số vạch", "so vach", "soVach"),
      extractBarFromText(currentName),
      extractBarFromText(tenChuan)
    )
  ).toLowerCase();
  const finalUid = normalizeSegment(
    firstNonEmpty(uid, sheetValue(sheetRow, "uid"), extractUidFromText(sourceText))
  );
  const finalLocation = normalizeSegment(
    firstNonEmpty(
      location,
      extractLocationFromText(currentName),
      extractLocationFromText(tenChuan),
      sheetValue(sheetRow, "địa chỉ ban đầu", "dia chi ban dau", "diaChiBanDau")
    )
  );

  const parts = [];
  if (finalPauseOrder) parts.push(finalPauseOrder);
  if (finalDbVipToken) parts.push(finalDbVipToken);
  if (finalFullToken) parts.push(finalFullToken);
  if (finalDbToken) parts.push(finalDbToken);
  if (finalBar) parts.push(finalBar);
  if (finalUid) parts.push(finalUid);
  if (finalLocation) parts.push(finalLocation);
  parts.push("tool");

  return parts.join("-");
}

export function buildTenChuanName(options = {}) {
  return buildStandardName({
    ...options,
    pauseOrder: String(options.pauseOrder || "").trim().toLowerCase()
  });
}


