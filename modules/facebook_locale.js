const FACEBOOK_LOCALE = "en_US";

export function withFacebookLocale(rawUrl) {
  if (typeof rawUrl !== "string") return rawUrl;
  const text = rawUrl.trim();
  if (!/^https?:\/\//i.test(text)) return rawUrl;
  try {
    const url = new URL(text);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return rawUrl;
    url.searchParams.set("locale", FACEBOOK_LOCALE);
    return url.toString();
  } catch {
    if (!/facebook\.com/i.test(text) || /[?&]locale=/i.test(text)) return rawUrl;
    return text + (text.includes("?") ? "&" : "?") + "locale=" + FACEBOOK_LOCALE;
  }
}

export async function gotoFacebookLocale(page, rawUrl, options = {}) {
  return page.goto(withFacebookLocale(rawUrl), options);
}
