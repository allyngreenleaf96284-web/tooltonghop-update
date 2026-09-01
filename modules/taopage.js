import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREATE_PAGE_URL = "https://www.facebook.com/pages/creation/?ref_type=launch_point";
const STABLE_PAGE_CONCURRENCY = 4;
const REQUESTED_DATA_DIR = "D:\\tổng hợp tool\\tooltonghop\\data";
const LOCAL_DATA_DIR = path.resolve(__dirname, "../data");
const PAGE_NAME_FILES = [
  path.join(REQUESTED_DATA_DIR, "page_names.txt"),
  path.join(LOCAL_DATA_DIR, "page_names.txt")
];
const PAGE_CATEGORY_FILES = [
  path.join(REQUESTED_DATA_DIR, "page_categories.txt"),
  path.join(LOCAL_DATA_DIR, "page_categories.txt")
];

const DEFAULT_PAGE_NAMES = [
  "James Carter",
  "Michael Anderson",
  "Robert Johnson",
  "William Thompson",
  "David Miller",
  "Jessica Davis",
  "Ashley Moore",
  "Sarah Taylor",
  "Emily White",
  "Amanda Harris"
];

const DEFAULT_PAGE_CATEGORIES = [
  "Digital creator",
  "Gaming video creator",
  "Reel creator",
  "Video creator",
  "Public figure"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampToolConcurrency(value, fallback = STABLE_PAGE_CONCURRENCY) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
  return Math.max(1, Math.min(4, parsed));
}

function randomItem(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return "";
  return values[Math.floor(Math.random() * values.length)] || "";
}

function randomDifferentItem(items, current = "") {
  const values = (Array.isArray(items) ? items : []).filter((item) => String(item || "").trim() && String(item || "").trim() !== String(current || "").trim());
  return randomItem(values) || randomItem(items);
}

function ensureTextFile(filePath, defaults) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `${defaults.join("\n")}\n`, "utf8");
}

function readLines(paths, defaults) {
  for (const filePath of paths) {
    try {
      ensureTextFile(filePath, defaults);
      const lines = fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) return lines;
    } catch {}
  }
  return [...defaults];
}

function sheetValue(row, ...keys) {
  const wanted = new Set(keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean));
  for (const [key, value] of Object.entries(row || {})) {
    if (!wanted.has(String(key || "").trim().toLowerCase())) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function pageCountValue(row) {
  const raw = sheetValue(row, "số lượng page", "so luong page", "page count", "so page");
  const parsed = Math.floor(Number(String(raw || "").replace(/[^\d.-]/g, "")));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildStoppedError() {
  const error = new Error("Da nhan lenh dung han, tool tao page dung batch hien tai.");
  error.status = "stopped";
  error.step = "dung han";
  return error;
}

function mapPageError(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  const message = String(error?.message || error || "loi khong ro");
  if (status === "stopped") return { status: "stopped", detail: "Da dung han theo yeu cau." };
  const lower = message.toLowerCase();
  if (lower.includes("login") || lower.includes("logged out") || lower.includes("see more on facebook") || lower.includes("bi out")) {
    return { status: "biout", detail: message };
  }
  if (lower.includes("captcha") || lower.includes("checkpoint") || lower.includes("not a robot")) {
    return { status: "loicapcha", detail: message };
  }
  if (lower.includes("create page") || lower.includes("category") || lower.includes("page name")) {
    return { status: "loi tao page", detail: message };
  }
  return { status: "loi", detail: message };
}

function tileBounds(workerSlot = 0, workerTotal = 1) {
  const total = Math.max(1, Number(workerTotal || 1));
  if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
  if (total === 2) return { left: workerSlot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
  if (total === 3) return { left: workerSlot * 640, top: 0, width: 640, height: 980 };
  return {
    left: (workerSlot % 2) * 960,
    top: Math.floor(workerSlot / 2) * 520,
    width: 960,
    height: 520
  };
}

async function readViewportMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    hidden: document.hidden,
    visibilityState: document.visibilityState
  })).catch(() => null);
}

async function applyStableViewport(page, workerSlot = 0, workerTotal = 1) {
  if (!page || page.isClosed?.()) return null;
  const bounds = tileBounds(workerSlot, workerTotal);
  const viewport = {
    width: Math.max(900, bounds.width - 24),
    height: Math.max(640, bounds.height - 110),
    deviceScaleFactor: 1
  };
  await page.setViewport?.(viewport).catch(() => {});
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
    if (document.body) document.body.style.zoom = "";
  }).catch(() => {});
  return { ...viewport, zoom: 1, bounds, actual: await readViewportMetrics(page) };
}

function patchStableWindowTiling(manager, workerSlot = 0, workerTotal = 1) {
  const original = manager.maximizeBrowserWindow;
  manager.__toolWorkerSlot = workerSlot;
  manager.__toolWorkerTotal = workerTotal;
  manager.maximizeBrowserWindow = async (browser, page = null) => {
    const targetPage = page || (await browser.pages().catch(() => []))[0];
    if (!targetPage) return original?.call(manager, browser, page);
    const bounds = tileBounds(workerSlot, workerTotal);
    try {
      const session = await targetPage.createCDPSession();
      const windowInfo = await session.send("Browser.getWindowForTarget").catch(() => null);
      if (windowInfo?.windowId !== undefined) {
        await session.send("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: {
            windowState: "normal",
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height
          }
        });
      }
      await session.detach().catch(() => {});
      await applyStableViewport(targetPage, workerSlot, workerTotal);
    } catch {
      await original?.call(manager, browser, page).catch(() => {});
    }
  };
}

async function waitForBody(page, timeout = 30000) {
  await page.waitForSelector("body", { timeout }).catch(() => {});
}

async function gotoWithRetry(manager, page, url, row, attempts = 3) {
  if (typeof manager.gotoWithRetry === "function") return manager.gotoWithRetry(page, url, row, attempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForBody(page);
      return true;
    } catch (error) {
      lastError = error;
      await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error(`Khong vao duoc ${url}`);
}

async function fillByLabel(page, labels, value) {
  const result = await page.evaluate(({ labels, value }) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = labels.map(normalize);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']"))
      .filter((element) => visible(element));
    const scored = candidates.map((element) => {
      const aria = normalize(element.getAttribute("aria-label"));
      const placeholder = normalize(element.getAttribute("placeholder"));
      const text = normalize(element.innerText || element.textContent);
      const parentText = normalize(element.closest("label, div")?.innerText || "");
      const haystack = [aria, placeholder, text, parentText].filter(Boolean).join(" ");
      const score = wanted.some((label) => aria.includes(label) || placeholder.includes(label)) ? 100
        : wanted.some((label) => haystack.includes(label)) ? 50
          : 0;
      return { element, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    const target = scored[0]?.element;
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = "";
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      target.value = value;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    target.textContent = "";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    target.textContent = value;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return true;
  }, { labels, value }).catch(() => false);
  if (!result) return false;
  await sleep(500);
  return true;
}

async function typeByLabel(page, labels, value) {
  const focused = await page.evaluate((labels) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = labels.map(normalize);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']"))
      .filter((element) => visible(element));
    const target = candidates.find((element) => {
      const text = [
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.closest("label, div")?.innerText
      ].map(normalize).join(" ");
      return wanted.some((label) => text.includes(label));
    });
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    return true;
  }, labels).catch(() => false);
  if (!focused) return false;
  await page.keyboard.down("Control").catch(() => {});
  await page.keyboard.press("KeyA").catch(() => {});
  await page.keyboard.up("Control").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(value, { delay: 35 });
  await sleep(1200);
  return true;
}

async function clickFirstCategorySuggestion(page, category) {
  async function createPageEnabled() {
    return page.evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const button = Array.from(document.querySelectorAll("button, [role='button']")).find((element) => {
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return visible(element) && text === "create page";
      });
      if (!(button instanceof HTMLElement)) return false;
      const ariaDisabled = String(button.getAttribute("aria-disabled") || "").toLowerCase() === "true";
      return !ariaDisabled && !button.matches?.(":disabled");
    }).catch(() => false);
  }

  async function clickSuggestionByMouse() {
    const rect = await page.evaluate((category) => {
      const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = normalize(category);
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const nodes = Array.from(document.querySelectorAll("[role='option'], [role='listbox'] [role='button'], div[role='button'], li, span, div"))
        .filter((element) => visible(element));
      const option = nodes.find((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        return text === wanted || text.includes(wanted);
      }) || nodes.find((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        return /digital creator|gaming video creator|reel creator|video creator|public figure/i.test(text);
      });
      if (!(option instanceof HTMLElement)) return null;
      const row = option.closest("[role='option'], [role='button'], li, div") || option;
      row.scrollIntoView({ block: "center", inline: "center" });
      const box = row.getBoundingClientRect();
      return {
        x: box.left + Math.min(Math.max(20, box.width / 2), box.width - 10),
        y: box.top + Math.min(Math.max(10, box.height / 2), box.height - 6),
        width: box.width,
        height: box.height,
        text: row.innerText || row.textContent || ""
      };
    }, category).catch(() => false);
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
    await page.mouse.click(rect.x, rect.y, { delay: 80 }).catch(() => {});
    await sleep(1000);
    return createPageEnabled();
  }

  async function keyboardPick(keys) {
    for (const key of keys) {
      await page.keyboard.press(key).catch(() => {});
      await sleep(250);
    }
    await sleep(900);
    return createPageEnabled();
  }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (await clickSuggestionByMouse()) return true;
    if (await keyboardPick(["ArrowDown", "Enter"])) return true;
    if (await createPageEnabled()) {
      await sleep(1200);
      return true;
    }
    await sleep(800);
  }
  return false;
}

async function clickCreatePageButton(page) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const alreadyMoved = await page.evaluate(() => {
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
      return /finish setting up your page|step \d+ of \d+|success!\s*you'?ve created|manage page|professional dashboard/i.test(body);
    }).catch(() => false);
    if (alreadyMoved) return true;

    const rect = await page.evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const box = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const disabled = (element) => {
        const ariaDisabled = String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true";
        return ariaDisabled || element.matches?.(":disabled");
      };
      const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((element) => {
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          return visible(element) && !disabled(element) && text === "create page";
        })
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
            width: box.width,
            height: box.height,
            tag: element.tagName,
            role: element.getAttribute("role") || "",
            text: element.innerText || element.textContent || ""
          };
        })
        .sort((a, b) => b.y - a.y);
      return candidates[0] || null;
    }).catch(() => null);
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      await page.mouse.click(rect.x, rect.y, { delay: 100 }).catch(() => {});
      await sleep(2500);
      const moved = await page.evaluate(() => {
        const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /finish setting up your page|step \d+ of \d+|success!\s*you'?ve created|manage page|professional dashboard/i.test(body);
      }).catch(() => false);
      if (moved) return true;
    }
    await sleep(1000);
  }
  return false;
}

async function readPageCreationError(page) {
  const message = await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (element) => normalize(element?.innerText || element?.textContent || "");
    const containers = Array.from(document.querySelectorAll("[role='alert'], [aria-live], div"))
      .filter((element) => visible(element))
      .map((element) => textOf(element))
      .filter(Boolean);
    const error = containers.find((text) =>
      /suspicious activity|sms verification|before creating a new page|couldn't create|could not create|try again later|something went wrong|request not completed|temporar/i.test(text)
    );
    if (error) return error;
    const body = textOf(document.body);
    const match = body.match(/We noticed suspicious activity:[\s\S]{0,180}/i)
      || body.match(/Finish SMS verification[\s\S]{0,160}/i)
      || body.match(/Something went wrong[\s\S]{0,120}/i)
      || body.match(/Try again later[\s\S]{0,120}/i);
    return match ? normalize(match[0]) : "";
  }).catch(() => "");
  return String(message || "").trim();
}

async function closePageCreationErrorToast(page) {
  await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const toasts = Array.from(document.querySelectorAll("[role='alert'], [aria-live], div"))
      .filter((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        return visible(element) && /suspicious activity|sms verification|creating a new page|something went wrong|try again later|request not completed/.test(text);
      });
    for (const toast of toasts) {
      const close = Array.from(toast.querySelectorAll("[aria-label='Close'], [role='button'], button"))
        .find((button) => visible(button));
      if (close instanceof HTMLElement) {
        close.click();
        return true;
      }
      const rect = toast.getBoundingClientRect();
      const clickable = Array.from(document.elementsFromPoint(rect.right - 26, rect.top + 26))
        .map((element) => element instanceof HTMLElement ? (element.closest("[role='button'], button") || element) : null)
        .find((element) => element instanceof HTMLElement && visible(element));
      if (clickable instanceof HTMLElement) {
        clickable.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
  await sleep(600);
}

async function createPageButtonEnabled(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const button = Array.from(document.querySelectorAll("button, [role='button']")).find((element) => {
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return visible(element) && text === "create page";
    });
    if (!(button instanceof HTMLElement)) return false;
    const ariaDisabled = String(button.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    return !ariaDisabled && !button.matches?.(":disabled");
  }).catch(() => false);
}

async function hasPageNameError(page) {
  return page.evaluate(() => {
    const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
    if (/name.*not available|can't use this name|cannot use this name|page name.*invalid|try another name/i.test(body)) return true;
    const fields = Array.from(document.querySelectorAll("input, textarea, [role='textbox']"));
    return fields.some((element) => {
      const text = String([
        element.getAttribute("aria-label"),
        element.getAttribute("aria-invalid"),
        element.closest("div")?.innerText
      ].join(" "));
      return /page name/i.test(text) && (/true/i.test(String(element.getAttribute("aria-invalid") || "")) || /invalid|try another|not available/i.test(text));
    });
  }).catch(() => false);
}

async function clickByText(page, texts, options = {}) {
  const exact = options.exact !== false;
  const clicked = await page.evaluate(({ texts, exact }) => {
    const wanted = texts.map((text) => String(text || "").trim().toLowerCase()).filter(Boolean);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const disabled = (element) => {
      const ariaDisabled = String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true";
      return ariaDisabled || element.matches?.(":disabled");
    };
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, span, div"))
      .filter((element) => visible(element) && !disabled(element));
    const target = nodes.find((element) => {
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) return false;
      return wanted.some((item) => exact ? text === item : text.includes(item));
    });
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, { texts, exact }).catch(() => false);
  if (clicked) await sleep(Number(options.delayMs || 1500));
  return clicked;
}

async function dismissCreatedToast(page) {
  const closed = await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const toastTextMatch = (element) => {
      const text = normalize(element?.innerText || element?.textContent || "");
      return text.includes("was created") || text.includes("now you can add images") || text.includes("you can add images");
    };
    const toasts = Array.from(document.querySelectorAll("[role='alert'], [aria-live], div"))
      .filter((element) => visible(element) && toastTextMatch(element));
    for (const toast of toasts) {
      const close = Array.from(toast.querySelectorAll("[aria-label='Close'], [role='button'], button, i, svg"))
        .find((button) => visible(button) && /close|x|dismiss/i.test(String(button.getAttribute("aria-label") || button.innerText || button.textContent || "")));
      if (close instanceof HTMLElement) {
        close.click();
        return true;
      }
      const rect = toast.getBoundingClientRect();
      const topRight = Array.from(document.elementsFromPoint(rect.right - 26, rect.top + 26))
        .find((element) => element instanceof HTMLElement && visible(element) && (element.closest("[role='button'], button") || element.getAttribute("aria-label")));
      const clickable = topRight?.closest?.("[role='button'], button") || topRight;
      if (clickable instanceof HTMLElement) {
        clickable.click();
        return true;
      }
    }
    const closeButtons = Array.from(document.querySelectorAll("[aria-label='Close'], button, [role='button']"))
      .filter((button) => {
        if (!visible(button)) return false;
        const boxText = normalize(button.closest("[role='alert'], [aria-live], div")?.innerText || "");
        return boxText.includes("was created") || boxText.includes("now you can add images") || boxText.includes("you can add images");
      });
    if (closeButtons[0] instanceof HTMLElement) {
      closeButtons[0].click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (!closed) {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await sleep(500);
}

async function clickSetupFooterButton(page, labels) {
  const wanted = labels.map((label) => String(label || "").trim().toLowerCase()).filter(Boolean);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.evaluate(() => {
      const scrollables = Array.from(document.querySelectorAll("div, main, section, aside"))
        .filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 80);
      scrollables.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      for (const element of scrollables.slice(0, 3)) element.scrollTop = element.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(350);
    const rect = await page.evaluate((wanted) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const box = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const disabled = (element) => {
        const ariaDisabled = String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true";
        return ariaDisabled || element.matches?.(":disabled");
      };
      const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((element) => {
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          return visible(element) && !disabled(element) && wanted.includes(text);
        })
        .map((element) => {
          const box = element.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2, text: element.innerText || element.textContent || "" };
        })
        .sort((a, b) => b.y - a.y);
      return candidates[0] || null;
    }, wanted).catch(() => null);
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      await page.mouse.click(rect.x, rect.y, { delay: 90 }).catch(() => {});
      await sleep(1000);
      return true;
    }
    await sleep(700);
  }
  return false;
}

async function waitForCreatePageReady(page) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const ready = await page.evaluate(() => {
      const body = String(document.body?.innerText || "");
      return /create a page/i.test(body) && /page name/i.test(body) && /category/i.test(body);
    }).catch(() => false);
    if (ready) return true;
    await sleep(1000);
  }
  throw new Error("Khong thay giao dien Create a Page.");
}

async function waitAfterCreate(page) {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const state = await page.evaluate(() => {
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        setup: /finish setting up your page|step \d+ of \d+|success!\s*you'?ve created/i.test(body),
        manage: /manage page|professional dashboard|add cover photo|what's on your mind/i.test(body),
        failed: /couldn't create|try again later|something went wrong/i.test(body)
      };
    }).catch(() => ({}));
    if (state.failed) throw new Error("Facebook bao loi khi tao Page.");
    if (state.setup || state.manage) return state;
    await sleep(1000);
  }
  throw new Error("Create Page load qua lau, chua sang buoc setup.");
}

async function finishPageSetup(page) {
  let sawDone = false;
  for (let attempt = 1; attempt <= 35; attempt += 1) {
    await dismissCreatedToast(page);
    await sleep(150);
    const done = await clickSetupFooterButton(page, ["Done"]);
    if (done) {
      sawDone = true;
      break;
    }
    const skipped = await clickSetupFooterButton(page, ["Skip"]);
    if (skipped) continue;
    const next = await clickSetupFooterButton(page, ["Next"]);
    if (next) continue;
    const state = await page.evaluate(() => {
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
      const url = String(location.href || "");
      return {
        manage: /manage page|professional dashboard|add cover photo|what's on your mind/i.test(body),
        urlLooksDone: /profile\.php\?id=|\/pages\/|\/profile\.php/i.test(url)
      };
    }).catch(() => ({}));
    if (state.manage && state.urlLooksDone) return true;
    await sleep(600);
  }
  if (sawDone) {
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const complete = await page.evaluate(() => {
        const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /manage page|professional dashboard|add cover photo|what's on your mind/i.test(body);
      }).catch(() => false);
      if (complete) return true;
      await sleep(700);
    }
  }
  throw new Error("Chua xac nhan duoc man hinh tao Page thanh cong.");
}

async function runCreatePageFlow(manager, page, row, pageName, category) {
  await gotoWithRetry(manager, page, "https://www.facebook.com/", row, 2);
  await sleep(1500);
  await gotoWithRetry(manager, page, CREATE_PAGE_URL, row, 3);
  await waitForCreatePageReady(page);

  const pageNames = readLines(PAGE_NAME_FILES, DEFAULT_PAGE_NAMES);
  let activePageName = pageName;
  let filledName = await typeByLabel(page, ["Page name (required)", "Page name"], activePageName);
  if (!filledName) throw new Error("Khong dien duoc Page name.");

  const typedCategory = await typeByLabel(page, ["Category (required)", "Category"], category);
  if (!typedCategory) throw new Error("Khong dien duoc Category.");
  const pickedCategory = await clickFirstCategorySuggestion(page, category);
  if (!pickedCategory) throw new Error("Khong chon duoc goi y Category dau tien.");

  let lastCreateError = "";
  let created = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await hasPageNameError(page) || !(await createPageButtonEnabled(page))) {
      const replacementName = randomDifferentItem(pageNames, activePageName);
      if (replacementName && replacementName !== activePageName) {
        activePageName = replacementName;
        filledName = await typeByLabel(page, ["Page name (required)", "Page name"], activePageName);
        if (!filledName) throw new Error("Khong dien lai duoc Page name.");
        await sleep(1200);
      }
    }
    const clickedCreatePage = await clickCreatePageButton(page);
    if (clickedCreatePage) {
      created = true;
      break;
    }
    lastCreateError = await readPageCreationError(page);
    if (lastCreateError) {
      await closePageCreationErrorToast(page);
    }
    await sleep(1500);
  }
  if (!created) {
    const detail = lastCreateError || await readPageCreationError(page) || "Bam Create Page 3 lan nhung khong qua duoc buoc tao page.";
    throw new Error(detail);
  }
  await waitAfterCreate(page);
  await finishPageSetup(page);
  return { pageName: activePageName, category };
}

export function createTaoPage({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "tao page",
      step,
      detail
    });
  }

  async function step(profileId, job, name, action, options = {}) {
    if (runtime.stopRequested) throw buildStoppedError();
    const timeoutMs = Number(options.timeoutMs || 0);
    if (job) job.liveStatus = name;
    log(profileId, name, `bat dau: ${name}`);
    const startedAt = Date.now();
    try {
      const work = Promise.resolve().then(action);
      const result = timeoutMs > 0
        ? await Promise.race([
            work,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout o buoc "${name}" sau ${timeoutMs}ms.`)), timeoutMs))
          ])
        : await work;
      if (runtime.stopRequested) throw buildStoppedError();
      log(profileId, name, `xong: ${name} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") throw error;
      error.step = error.step || name;
      log(profileId, name, `loi o buoc "${name}": ${error.message || error}`, "error");
      throw error;
    }
  }

  function expandSheetUpdate(update) {
    const next = { ...update };
    const pairs = [
      ["trangThai", "trạng thái"],
      ["chiTiet", "chi tiết"],
      ["soLuongPage", "số lượng page"]
    ];
    for (const [camelKey, labelKey] of pairs) {
      if (next[camelKey] !== undefined && next[labelKey] === undefined) next[labelKey] = next[camelKey];
      if (next[labelKey] !== undefined && next[camelKey] === undefined) next[camelKey] = next[labelKey];
    }
    return next;
  }

  async function writeSheet(session, profileId, update) {
    await session.updateOne(profileId, expandSheetUpdate(update));
  }

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot = 0, workerTotal = 1) {
    const manager = getManager({ fresh: true });
    patchStableWindowTiling(manager, workerSlot, workerTotal);
    const row = buildToolRow(profileId, sheetRow);
    const uid = String(row.uid || profileId || "").trim();
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;

    try {
      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid, shouldFinish: () => false });

      const pageName = randomItem(readLines(PAGE_NAME_FILES, DEFAULT_PAGE_NAMES));
      const category = randomItem(readLines(PAGE_CATEGORY_FILES, DEFAULT_PAGE_CATEGORIES));
      if (!pageName) throw new Error("File page_names.txt khong co ten page.");
      if (!category) throw new Error("File page_categories.txt khong co category.");

      proxyLease = await step(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      );

      browser = await step(profileId, job, "mo profile HideMyAcc", async () => manager.connectBrowser(profileId), { timeoutMs: 120000 });
      page = await step(profileId, job, "mo tab Facebook", async () => {
        const pages = await browser.pages().catch(() => []);
        const target = pages.find((item) => !item.isClosed?.()) || await browser.newPage();
        if (typeof manager.maximizeBrowserWindow === "function") await manager.maximizeBrowserWindow(browser, target).catch(() => {});
        const viewport = await applyStableViewport(target, workerSlot, workerTotal);
        log(profileId, "viewport", `worker ${workerSlot + 1}/${workerTotal} bounds=${viewport?.bounds?.width || ""}x${viewport?.bounds?.height || ""} viewport=${viewport?.width || ""}x${viewport?.height || ""}, zoom=1, actual=${JSON.stringify(viewport?.actual || {})}`);
        return target;
      });

      await step(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      }, { timeoutMs: 300000 });

      const result = await step(profileId, job, "tao Page", async () =>
        runCreatePageFlow(manager, page, row, pageName, category)
      , { timeoutMs: 360000 });

      await step(profileId, job, "chuyen ve nick chinh sau tao Page", async () => {
        if (typeof dangNhap.ensureMainFacebookIdentity === "function") {
          const identity = await dangNhap.ensureMainFacebookIdentity(manager, page, row, profileId, (status) => {
            if (job) job.liveStatus = status;
            log(profileId, "chuyen ve nick chinh sau tao Page", status);
          });
          if (!identity.ok && !identity.skipped) {
            throw new Error(`Da tao Page nhung khong chuyen ve duoc nick chinh: ${identity.beforeUrl || identity.reason || ""}`);
          }
        }
      }, { timeoutMs: 120000 });

      const nextPageCount = pageCountValue(sheetRow) + 1;
      const finalUpdate = {
        Tool: "đã tạo page",
        trangThai: "thành công",
        chiTiet: `đã tạo page thành công: ${result.pageName} (${result.category})`,
        soLuongPage: String(nextPageCount)
      };
      await writeSheet(sheetSession, profileId, finalUpdate);
      if (job) {
        job.status = "success";
        job.liveStatus = "tao page thanh cong";
        job.result = finalUpdate;
      }
      log(profileId, "ket thuc", `tao page thanh cong: ${result.pageName}`, "success");
      return finalUpdate;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = "da dung han, giu nguyen Sheet";
          job.result = null;
        }
        return { stopped: true };
      }
      const mapped = mapPageError(error);
      const finalUpdate = {
        Tool: "tạo page",
        trangThai: "loi",
        chiTiet: mapped.detail
      };
      await writeSheet(sheetSession, profileId, finalUpdate);
      if (job) {
        job.status = "error";
        job.liveStatus = mapped.detail;
        job.result = finalUpdate;
      }
      return finalUpdate;
    } finally {
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      try { stateProxy?.release?.(proxyLease); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runQueue(profileIds, config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");
    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampToolConcurrency(config.pageConcurrency), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "tao page",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang tao page ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "tao page";
    setImmediate(async () => {
      try {
        let cursor = 0;
        let activeCount = 0;
        const nextId = () => {
          if (runtime.stopRequested) return "";
          if (cursor >= ids.length) return "";
          const id = ids[cursor];
          cursor += 1;
          return id;
        };
        const workers = Array.from({ length: concurrency }, async (_, workerSlot) => {
          for (;;) {
            const id = nextId();
            if (!id) break;
            const row = sheetSession.rows.get(id);
            const job = runtime.jobs.get(id);
            if (!row) {
              const update = { Tool: "tạo page", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide." };
              if (job) {
                job.status = "error";
                job.liveStatus = update.chiTiet;
                job.finishedAt = new Date().toISOString();
                job.result = update;
              }
              await writeSheet(sheetSession, id, update);
              continue;
            }
            if (job) {
              job.status = "running";
              job.startedAt = new Date().toISOString();
              job.liveStatus = `dang bat dau o luong ${workerSlot + 1}/${concurrency}`;
            }
            activeCount += 1;
            log(id, "worker", `worker ${workerSlot + 1}/${concurrency} start, active=${activeCount}, queue_con_lai=${Math.max(0, ids.length - cursor)}`);
            try {
              await runOne(id, row, config, sheetSession, workerSlot, concurrency);
            } finally {
              activeCount = Math.max(0, activeCount - 1);
              log(id, "worker", `worker ${workerSlot + 1}/${concurrency} end, active=${activeCount}, queue_con_lai=${Math.max(0, ids.length - cursor)}`);
            }
          }
        });
        await Promise.all(workers);
        await sheetSession.flushAll();
        if (runtime.stopRequested) {
          for (const id of ids) {
            const job = runtime.jobs.get(id);
            if (job && (job.status === "queued" || job.status === "running")) {
              job.status = "stopped";
              job.liveStatus = "da dung han, giu nguyen Sheet";
              job.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        addRuntimeLog(`Loi queue tao page: ${error.message}`, "error", "", {
          step: "queue tao page",
          tool: "tao page"
        });
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });
    return { started: ids.length, concurrency };
  }

  return { runQueue };
}
