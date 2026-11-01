const prepared = new WeakSet();

export async function prepareLinkCheckScrolling(page) {
  if (prepared.has(page)) return;
  const manual = () => { try { history.scrollRestoration = "manual"; } catch {} };
  await page.evaluateOnNewDocument(manual);
  await page.evaluate(manual);
  prepared.add(page);
}

// Move the document and product scroll ancestors. If virtualization removed
// the title, recover the pane under the right/center content area first.
export async function recoverLinkCheckScroll(page, phase = 0) {
  return page.evaluate(step => {
    const rendered = el => {
      if (!el || el.closest('[aria-hidden="true"], [inert]')) return false;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const clean = el => String(el.innerText || el.textContent || "").replace(/\s+/g," ").trim();
    const headings = [...document.querySelectorAll('h1,h2,[role="heading"]')].filter(rendered)
      .filter(el => !el.closest('aside,nav,[role="navigation"],[role="feed"]'))
      .filter(el => clean(el) && !/^(marketplace|details|seller information|today.s picks|related items|recommended(?: for you)?|shipping (?:and|&) returns)$/i.test(clean(el)))
      .sort((a,b) => Number(b.matches('h1,[aria-level="1"]')) - Number(a.matches('h1,[aria-level="1"]'))
        || b.getBoundingClientRect().left - a.getBoundingClientRect().left || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const title = headings[0], root = document.scrollingElement;
    const containers = [];
    for (let el = title?.parentElement; el && el !== document.body && el !== root; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) containers.push(el);
    }
    if (!title) {
      for (const fraction of [0.85, 0.6]) {
        const hit = document.elementFromPoint(innerWidth * fraction, innerHeight * 0.45);
        if (hit?.closest('nav,[role="navigation"],[role="feed"]')) continue;
        for (let el = hit; el && el !== document.body && el !== root; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY) && !containers.includes(el)) containers.push(el);
        }
      }
    }
    if (root) containers.push(root);
    if (step === 0 || step === 2 || step === 4) {
      for (const el of containers) el.scrollTo({top:0,left:el.scrollLeft,behavior:"instant"});
      if (title) title.scrollIntoView({block:"start",inline:"nearest",behavior:"instant"});
    } else {
      const el = containers[0];
      if (el) el.scrollTo({top:el.scrollTop + Math.max(80, el.clientHeight * (step === 1 ? 0.6 : 1.2)),behavior:"instant"});
    }
    return {phase:step, containers:containers.length};
  }, phase).catch(() => null);
}
