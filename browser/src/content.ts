// Runs on judge pages: reports interactions (so the background knows which problem/contest page
// is the most recent one), answers scrape requests, and watches "my submissions" pages for
// verdicts. In iframes (e.g. oj.uz's PDF viewer) it only reports interactions to its tab.

import { analyzePage, PageInfo, submissionRows } from './scrape/page';

declare global {
  interface Window {
    /** Set by a running copy of this script; false once that copy's extension context is gone. */
    __cp2Alive?: () => boolean;
  }
}

const alive = () => {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
};

const inFrame = (() => {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
})();

const INTERACT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;

if (inFrame) {
  // Statements shown in an iframe (pdf.js viewers etc.): scrolling happens in here, not in the
  // page, so tell the background the tab was used; it reads the page itself from the top frame.
  if (!window.__cp2Alive?.()) {
    window.__cp2Alive = alive;
    let last = 0;
    const ping = () => {
      if (!alive() || Date.now() - last < 800) return;
      last = Date.now();
      try {
        chrome.runtime.sendMessage({ type: 'interactFrame' }).catch(() => undefined);
      } catch {
        /* extension reloaded */
      }
    };
    for (const ev of INTERACT_EVENTS) window.addEventListener(ev, ping, { capture: true, passive: true });
  }
} else if (!window.__cp2Alive?.()) {
  // A copy left behind by a reloaded extension can't talk to it anymore: let this one take over.
  window.__cp2Alive = alive;
  let lastY = window.innerHeight / 2;
  let lastSent = 0;
  let pending: number | undefined;

  const info = (): PageInfo => analyzePage(document, location.href, { y: lastY });

  const notify = () => {
    if (!alive()) return;
    const now = Date.now();
    const go = () => {
      lastSent = Date.now();
      pending = undefined;
      try {
        chrome.runtime.sendMessage({ type: 'interact', info: info() }).catch(() => undefined);
      } catch {
        /* extension reloaded */
      }
    };
    if (now - lastSent > 800) go();
    else if (!pending) pending = window.setTimeout(go, 800 - (now - lastSent));
  };

  window.addEventListener('pointerdown', (e) => ((lastY = e.clientY), notify()), { capture: true, passive: true });
  window.addEventListener('keydown', () => notify(), { capture: true, passive: true });
  window.addEventListener('wheel', () => ((lastY = window.innerHeight / 2), notify()), { capture: true, passive: true });
  window.addEventListener('scroll', () => ((lastY = window.innerHeight / 2), notify()), { capture: true, passive: true });
  window.addEventListener('focus', () => notify());
  // Statements embedded as PDFs (ORAC, QOJ) swallow every pointer, wheel and key event: the
  // browser's PDF viewer can't be scripted and the page isn't told when the pointer enters it.
  // So: clicking into it moves focus there (window blur, activeElement = the frame), and moving
  // into it shows up as the pointer going quiet right at the frame's edge.
  const isFrame = (el: Element | null) => !!el && /^(IFRAME|EMBED|OBJECT|FRAME)$/.test(el.tagName);
  document.addEventListener('pointerover', (e) => isFrame(e.target as Element) && notify(), { capture: true, passive: true });
  window.addEventListener('blur', () => setTimeout(() => isFrame(document.activeElement) && notify(), 0));
  let lastPos: { x: number; y: number } | null = null;
  let quiet: number | undefined;
  document.addEventListener(
    'pointermove',
    (e) => {
      lastPos = { x: e.clientX, y: e.clientY };
      if (quiet) clearTimeout(quiet);
      quiet = window.setTimeout(() => {
        const p = lastPos;
        if (!p) return;
        for (const f of Array.from(document.querySelectorAll('iframe, embed, object'))) {
          const r = f.getBoundingClientRect();
          if (r.width < 200 || r.height < 200) continue; // ads and widgets
          const dx = Math.max(r.left - p.x, 0, p.x - r.right);
          const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
          if (Math.hypot(dx, dy) <= 120) return notify();
        }
      }, 300);
    },
    { capture: true, passive: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notify();
  });
  if (document.visibilityState === 'visible') notify();

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'pageInfo') reply(info());
    else if (msg?.type === 'scrape') reply(analyzePage(document, location.href, { ...(msg.index ? { index: msg.index } : { y: lastY }), generic: !!msg.generic }).problem);
    else if (msg?.type === 'verdictRows') reply(submissionRows(document, location.href));
    return false;
  });

  const first = info();

  // AtCoder standings are rendered by script after load: report again once the task links exist.
  if (first.kind === 'contest' && first.site === 'atcoder' && !first.contest?.tasks) {
    const obs = new MutationObserver(() => {
      if (document.querySelector('a[href*="/tasks/"]')) {
        const i = info();
        if (i.contest?.tasks) {
          obs.disconnect();
          if (document.visibilityState === 'visible') notify();
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  // Live verdicts: the site updates the table itself; forward changes.
  if (first.kind === 'submissions') {
    let t: number | undefined;
    const send = () => {
      t = undefined;
      try {
        chrome.runtime.sendMessage({ type: 'verdicts', url: location.href, rows: submissionRows(document, location.href) }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    };
    send();
    const obs = new MutationObserver(() => {
      if (!t) t = window.setTimeout(send, 250);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  }
}
