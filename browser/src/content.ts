// Runs on Codeforces / AtCoder pages: reports interactions (so the background knows which
// problem/contest page is the most recent one), answers scrape requests, and watches
// "my submissions" pages for verdicts.

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

// A copy left behind by a reloaded extension can't talk to it anymore: let this one take over.
if (!window.__cp2Alive?.()) {
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
