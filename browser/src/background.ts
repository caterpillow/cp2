// cp2 browser extension service worker.
//
// - remembers the most recent Codeforces/AtCoder problem page and contest page you interacted
//   with, and tells VS Code (through cp2-bridge on 127.0.0.1)
// - answers scrape / task-list / submit requests from VS Code
// - follows verdicts after a submit
// - toolbar icon: send the current problem straight into the active file in VS Code

import { contestKey, mySubmissionsUrl, parseContestUrl, parseProblemUrl, pdfName, pdfUrlOf, ProblemRef, problemKey, Site, submitPageUrl, webRef } from '../../shared/problemId';
import { BridgeToBrowser, BrowserToBridge, ContestInfo, ContestTask, DEFAULT_BRIDGE_PORT, FocusState, ProblemData, PROTOCOL_VERSION, SampleTest, SubmitArgs, SubmitResult, VerdictUpdate } from '../../shared/protocol';
import { tasksFromStandingsJson } from './scrape/atcoder';
import type { PageInfo } from './scrape/page';
import type { VerdictRow } from './scrape/verdicts';

const PORT = DEFAULT_BRIDGE_PORT;
const SITE_TABS = ['*://codeforces.com/*', '*://*.codeforces.com/*', '*://atcoder.jp/*', '*://dmoj.ca/*', '*://qoj.ac/*', '*://oj.uz/*', '*://orac2.info/*'];

interface Tracking {
  ref: ProblemRef;
  tabId: number;
  since: number;
  submissionId?: string;
  lastText?: string;
  lastUpdate: number;
}

interface Saved {
  lastProblem?: { tabId: number; data: ProblemData; at: number };
  lastContest?: { tabId: number; info: ContestInfo; at: number };
  /** tabId -> problem key already reported as a visit */
  visited?: Record<string, string>;
  tracking?: Tracking | null;
}

async function load(): Promise<Saved> {
  return ((await chrome.storage.session.get('cp2')).cp2 as Saved) ?? {};
}

async function save(s: Saved): Promise<void> {
  await chrome.storage.session.set({ cp2: s });
}

// ---------------- connection to cp2-bridge ----------------

let ws: WebSocket | null = null;
let backoff = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function connected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  let sock: WebSocket;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  } catch {
    scheduleRetry();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    send({ type: 'hello', role: 'browser', version: PROTOCOL_VERSION, agent: navigator.userAgent });
    void sendFocus(true).then(flushQueue);
    void chrome.action.setTitle({ title: 'cp2: send this problem to VS Code (connected)' });
  };
  sock.onmessage = (e) => {
    try {
      void onBridgeMessage(JSON.parse(String(e.data)) as BridgeToBrowser);
    } catch {
      /* ignore */
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    void chrome.action.setTitle({ title: 'cp2: VS Code is not connected (is cp2-bridge installed?)' });
    scheduleRetry();
  };
  sock.onerror = () => undefined;
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 20000);
}

// Messages that must not be lost while the socket is (re)connecting, e.g. right after the
// service worker was woken up by a page interaction. Focus is always re-sent on connect.
const queue: BrowserToBridge[] = [];

function send(m: BrowserToBridge): void {
  if (connected()) {
    ws!.send(JSON.stringify(m));
    return;
  }
  if (m.type === 'visit' || m.type === 'verdict' || m.type === 'icon') {
    queue.push(m);
    if (queue.length > 30) queue.shift();
  }
  connect();
}

function flushQueue(): void {
  while (queue.length && connected()) ws!.send(JSON.stringify(queue.shift()));
}

let focusSig = '';
async function sendFocus(force = false): Promise<void> {
  const s = await load();
  const focus: FocusState = { problem: s.lastProblem?.data ?? null, contest: s.lastContest?.info ?? null };
  const sig = JSON.stringify([focus.problem ? `${problemKey(focus.problem.ref)}|${focus.problem.tests.length}|${focus.problem.name}` : '', focus.contest ? `${contestKey(focus.contest.ref)}|${focus.contest.tasks?.length ?? 0}|${focus.contest.name}` : '']);
  if (!force && sig === focusSig) return;
  if (!connected()) {
    // Sent (with whatever is newest by then) as soon as the connection opens.
    connect();
    return;
  }
  focusSig = sig;
  send({ type: 'focus', focus });
}

// ---------------- tracking the most recent pages ----------------

async function onInteract(tabId: number, info: PageInfo): Promise<void> {
  if (info.kind === 'other' || info.kind === 'submissions') return;
  const s = await load();
  if (info.problem) {
    s.lastProblem = { tabId, data: info.problem, at: Date.now() };
    const visited = s.visited ?? {};
    const key = problemKey(info.problem.ref);
    if (visited[tabId] !== key && !info.problem.anonymous) {
      visited[tabId] = key;
      s.visited = visited;
      send({ type: 'visit', problem: info.problem });
    }
  }
  if (info.contest) {
    // Keep a known task list if this page (e.g. AtCoder's top page) doesn't show one.
    const prev = s.lastContest?.info;
    if (!info.contest.tasks && prev && contestKey(prev.ref) === contestKey(info.contest.ref)) info.contest.tasks = prev.tasks;
    s.lastContest = { tabId, info: info.contest, at: Date.now() };
  }
  await save(s);
  await sendFocus();
}

async function pageInfoOf(tabId: number): Promise<PageInfo | null> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, { type: 'pageInfo' }, { frameId: 0 })) as PageInfo) ?? null;
  } catch {
    return null;
  }
}

/** A tab showing a PDF (browser viewer or a viewer extension like Adobe's): an anonymous problem. */
function pdfProblem(url: string | undefined): ProblemData | null {
  const pdf = url ? pdfUrlOf(url) : null;
  if (!pdf) return null;
  return { ref: webRef(pdf), name: pdfName(pdf), tests: [], pdfUrl: pdf, anonymous: true, scrapedAt: Date.now() };
}

/** Tab switched to / finished loading: judge pages answer for themselves, PDFs are recognised by URL. */
async function trackTab(tabId: number): Promise<void> {
  const info = await pageInfoOf(tabId);
  if (info && info.kind !== 'other') return onInteract(tabId, info);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const pdf = pdfProblem(tab.url);
  if (pdf) await onInteract(tabId, { kind: 'problem', site: 'web', url: tab.url ?? '', problem: pdf, contest: null });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === 'offscreen') return false;
  const tabId = sender.tab?.id;
  if (msg?.type === 'interact' && tabId !== undefined) void onInteract(tabId, msg.info as PageInfo);
  else if (msg?.type === 'interactFrame' && tabId !== undefined) void trackTab(tabId);
  else if (msg?.type === 'verdicts' && tabId !== undefined) void onRows(tabId, msg.rows as VerdictRow[], false);
  reply(undefined);
  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => void trackTab(tabId));

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId < 0) return;
  void chrome.tabs.query({ active: true, windowId }).then(([t]) => {
    if (t?.id !== undefined) void trackTab(t.id);
  });
});

// PDF tabs have no content script, so loading one in the foreground counts as using it.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active && pdfUrlOf(tab.url ?? '')) void trackTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void load().then((s) => {
    if (s.visited?.[tabId]) {
      delete s.visited[tabId];
      return save(s);
    }
  });
});

// ---------------- requests from VS Code ----------------

async function onBridgeMessage(m: BridgeToBrowser): Promise<void> {
  if (m.type === 'ping') return send({ type: 'pong' });
  if (m.type === 'ack') return onAck(m.requestId, m.ok, m.message);
  if (m.type !== 'request') return;
  try {
    let result: unknown;
    if (m.op === 'scrape') result = await scrape(m.args.ref);
    else if (m.op === 'tasks') result = await tasks(m.args.site, m.args.contestId);
    else if (m.op === 'submit') result = await submit(m.args);
    send({ type: 'response', id: m.id, ok: true, result });
  } catch (e) {
    send({ type: 'response', id: m.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
}

async function siteTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: SITE_TABS });
}

/** A tab showing this problem (its own page, or Codeforces' all-problems page of the contest). */
async function findProblemTab(ref: ProblemRef): Promise<chrome.tabs.Tab | null> {
  const key = problemKey(ref);
  const tabs = await siteTabs();
  const own = tabs.find((t) => {
    if (t.url && t.url.split('#')[0] === ref.url.split('#')[0]) return true;
    const r = t.url ? parseProblemUrl(t.url) : null;
    return r && problemKey(r) === key;
  });
  if (own) return own;
  return (
    tabs.find((t) => {
      if (!t.url || ref.site !== 'codeforces') return false;
      const c = parseContestUrl(t.url);
      return !!c && c.contestId === ref.contestId && /\/problems\/?$/.test(new URL(t.url).pathname);
    }) ?? null
  );
}

async function scrapeTab(tabId: number, ref?: ProblemRef): Promise<ProblemData | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'scrape', index: ref?.site === 'codeforces' ? ref.taskId : undefined }, { frameId: 0 })) as ProblemData | null;
  } catch {
    return null;
  }
}

let offscreenReady: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = await (chrome.offscreen as any).hasDocument?.();
      if (!has) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: 'Parse Codeforces / AtCoder pages fetched for cp2' });
    })().catch((e) => {
      offscreenReady = null;
      if (!/single offscreen/i.test(String(e))) throw e;
    });
  }
  return offscreenReady;
}

async function parseRemote<T>(type: 'page' | 'rows', html: string, url: string, pick?: unknown): Promise<T> {
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage({ target: 'offscreen', type, html, url, pick })) as T;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** Samples from a PDF statement. The offscreen document downloads (also file:// URLs) and parses it. */
async function pdfSamples(url: string): Promise<SampleTest[]> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'pdf', url })) as { ok: boolean; tests?: SampleTest[]; error?: string };
  if (!res?.ok) throw new Error(res?.error ?? "couldn't read the PDF");
  return res.tests ?? [];
}

/** Statements that are PDFs get their samples extracted when importing (not on every visit). */
async function withPdf(d: ProblemData | null): Promise<ProblemData | null> {
  if (!d || d.tests.length || !d.pdfUrl) return d;
  try {
    d.tests = await pdfSamples(d.pdfUrl);
  } catch (e) {
    d.note = String((e as Error).message ?? e);
  }
  if (!d.tests.length && !d.note) d.note = "the statement is a PDF and cp2 couldn't find Sample Input / Output blocks in it";
  return d;
}

async function scrape(ref?: ProblemRef): Promise<ProblemData | null> {
  if (!ref) {
    const s = await load();
    const lp = s.lastProblem;
    if (!lp) return null;
    return withPdf((await scrapeTab(lp.tabId, lp.data.ref)) ?? lp.data);
  }
  const tab = await findProblemTab(ref);
  if (tab?.id !== undefined) {
    const d = await scrapeTab(tab.id, ref);
    if (d) return withPdf(d);
  }
  const pdf = ref.site === 'web' ? pdfProblem(ref.url) : null;
  if (pdf) return withPdf(pdf);
  const html = await fetchText(ref.url);
  const info = await parseRemote<PageInfo>('page', html, ref.url, { index: ref.site === 'codeforces' ? ref.taskId : undefined, generic: ref.site === 'web' });
  if (!info?.problem) throw new Error(`couldn't read the problem page (open ${ref.url} in a tab and try again)`);
  return withPdf(info.problem);
}

const CONTEST_PAGE: Partial<Record<Site, (id: string) => string>> = {
  codeforces: (id) => `https://codeforces.com/contest/${id}`,
  dmoj: (id) => `https://dmoj.ca/contest/${id}`,
  qoj: (id) => `https://qoj.ac/contest/${id}`,
};

async function tasks(site: Site, contestId: string): Promise<ContestTask[] | null> {
  const s = await load();
  const lc = s.lastContest?.info;
  if (lc && lc.ref.site === site && lc.ref.contestId === contestId && lc.tasks?.length) return lc.tasks;
  if (site === 'atcoder') {
    const url = `https://atcoder.jp/contests/${contestId}/tasks?lang=en`;
    try {
      const info = await parseRemote<PageInfo>('page', await fetchText(url), url);
      if (info?.contest?.tasks?.length) return info.contest.tasks;
    } catch {
      /* not started yet: fall through */
    }
    try {
      const r = await fetch(`https://atcoder.jp/contests/${contestId}/standings/json`, { credentials: 'include' });
      if (r.ok) return tasksFromStandingsJson(contestId, await r.json());
    } catch {
      /* ignore */
    }
    return null;
  }
  const page = CONTEST_PAGE[site];
  if (!page) return null;
  const url = page(contestId);
  const info = await parseRemote<PageInfo>('page', await fetchText(url), url);
  return info?.contest?.tasks ?? null;
}

// ---------------- submitting ----------------

function waitForLoad(tabId: number, timeoutMs = 30000): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    const done = (t: chrome.tabs.Tab | null) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(t);
    };
    const listener = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === 'complete') done(tab);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') done(t);
    });
  });
}

async function waitForUrl(tabId: number, pred: (u: string) => boolean, timeoutMs: number): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.url && pred(t.url) && t.status === 'complete') return t.url;
    } catch {
      return null;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

type FillResult = { ok?: boolean; noform?: boolean; needsCaptcha?: boolean; message?: string };

/** Runs in the page (MAIN world): fills the site's own submit form and clicks submit. Must be self-contained. */
async function fillAndSubmit(site: string, code: string, fileName: string, patterns: string[], index: string, taskId: string, clickOnly: boolean): Promise<FillResult> {
  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const pick = (sel: HTMLSelectElement): HTMLOptionElement | null => {
    const opts = Array.from(sel.options);
    for (const p of patterns) {
      let re: RegExp;
      try {
        re = new RegExp(p, 'i');
      } catch {
        continue;
      }
      const o = opts.find((x) => re.test(x.textContent ?? ''));
      if (o) return o;
    }
    return null;
  };
  const w = window as any;
  if (site === 'codeforces') {
    const forms = Array.from(document.querySelectorAll('form')).filter((f) => f.querySelector('select[name="programTypeId"]'));
    if (!forms.length) return { noform: true };
    const form = forms.find((f) => f.querySelector('textarea[name="source"]')) ?? forms[0];
    if (!clickOnly) {
      const sel = form.querySelector('select[name="programTypeId"]') as HTMLSelectElement;
      const opt = pick(sel);
      if (!opt) return { message: `no language matching ${patterns.join(' | ')} (available: ${Array.from(sel.options).slice(0, 8).map((o) => o.textContent?.trim()).join('; ')}…)` };
      sel.value = opt.value;
      fire(sel, 'change');
      const idxSel = form.querySelector('select[name="submittedProblemIndex"]') as HTMLSelectElement | null;
      if (idxSel && index) {
        idxSel.value = index;
        fire(idxSel, 'change');
      }
      const codeField = form.querySelector('input[name="submittedProblemCode"]') as HTMLInputElement | null;
      if (codeField && !codeField.value && index) codeField.value = index;
      const ta = form.querySelector('textarea[name="source"]') as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = code;
        fire(ta, 'input');
        fire(ta, 'change');
        try {
          if (w.ace && document.getElementById('editor')) w.ace.edit('editor').setValue(code, -1);
        } catch {
          /* textarea is what gets submitted anyway */
        }
      } else {
        const file = form.querySelector('input[type="file"][name="sourceFile"]') as HTMLInputElement | null;
        if (!file) return { noform: true };
        const dt = new DataTransfer();
        dt.items.add(new File([code], fileName, { type: 'text/plain' }));
        file.files = dt.files;
        fire(file, 'change');
      }
    }
    const btn = form.querySelector('#singlePageSubmitButton, input[type="submit"], button[type="submit"]') as HTMLElement | null;
    if (!btn) return { message: 'submit button not found' };
    btn.click();
    return { ok: true };
  }
  if (site === 'dmoj') {
    const form = document.getElementById('problem_submit');
    const lang = document.getElementById('id_language') as HTMLSelectElement | null;
    if (!form || !lang) return { noform: true };
    if (!clickOnly) {
      const opt = pick(lang);
      if (!opt) return { message: `no language matching ${patterns.join(' | ')}` };
      if (w.jQuery) w.jQuery(lang).val(opt.value).trigger('change');
      else {
        lang.value = opt.value;
        fire(lang, 'change');
      }
      // Changing language loads a template into the editor asynchronously; put the code in after.
      await new Promise((r) => setTimeout(r, 900));
      const ta = document.getElementById('id_source') as HTMLTextAreaElement | null;
      try {
        w.ace_source?.getSession().setValue(code);
      } catch {
        /* textarea below */
      }
      if (ta) {
        ta.value = code;
        fire(ta, 'change');
      }
    }
    const btn = form.querySelector('input[type="submit"], button[type="submit"]') as HTMLElement | null;
    if (!btn) return { message: 'submit button not found' };
    btn.click();
    return { ok: true };
  }
  // AtCoder: the form under the statement, or /contests/<id>/submit
  const holder = document.getElementById(`select-lang-${taskId}`);
  const sel = ((holder && holder.querySelector('select[name="data.LanguageId"]')) || Array.from(document.querySelectorAll('select[name="data.LanguageId"]')).find((s) => (s as HTMLElement).offsetParent !== null) || document.querySelector('select[name="data.LanguageId"]')) as HTMLSelectElement | null;
  if (!sel) return { noform: true };
  const taskSel = document.querySelector('select[name="data.TaskScreenName"]') as HTMLSelectElement | null;
  if (!clickOnly) {
    if (taskSel && taskSel.value !== taskId) {
      taskSel.value = taskId;
      if (w.jQuery) w.jQuery(taskSel).trigger('change');
      else fire(taskSel, 'change');
    }
    const opt = pick(sel);
    if (!opt) return { message: `no language matching ${patterns.join(' | ')}` };
    if (w.jQuery) w.jQuery(sel).val(opt.value).trigger('change');
    else {
      sel.value = opt.value;
      fire(sel, 'change');
    }
    const ta = document.querySelector('textarea[name="sourceCode"]') as HTMLTextAreaElement | null;
    if (ta) {
      ta.value = code;
      fire(ta, 'input');
    }
    try {
      if (w.ace && document.getElementById('editor')) w.ace.edit('editor').setValue(code, -1);
      else if (w.editor?.setValue) w.editor.setValue(code);
    } catch {
      /* ignore */
    }
  }
  const captcha = document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const resp = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null;
  if (captcha && (!resp || !resp.value)) return { needsCaptcha: true };
  const btn = (document.getElementById('submit') || document.querySelector('form button[type="submit"]')) as HTMLElement | null;
  if (!btn) return { message: 'submit button not found' };
  btn.click();
  return { ok: true };
}

/** Error text shown by the site when a submit was refused. */
function readSubmitError(): string {
  const sel = ['.error.for__source', 'span.error', '.alert-danger', '.alert-warning', '#flash-message'];
  for (const s of sel) {
    const el = Array.from(document.querySelectorAll(s)).find((e) => (e.textContent ?? '').trim());
    if (el) return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return '';
}

async function runInPage<A extends unknown[], R>(tabId: number, func: (...a: A) => R, args: A): Promise<R | null> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: func as any, args: args as any });
  return (res?.result as R) ?? null;
}

async function submit(a: SubmitArgs): Promise<SubmitResult> {
  const ref = a.ref;
  let tab = await findProblemTab(ref);
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    // The all-problems page has no per-problem form: go to the problem's own page.
    if (tab.url && !parseProblemUrl(tab.url)) {
      await chrome.tabs.update(tab.id, { url: ref.url });
      await waitForLoad(tab.id);
    }
  } else {
    tab = await chrome.tabs.create({ url: ref.url, active: true });
    await waitForLoad(tab.id!);
  }
  const tabId = tab.id!;
  const index = ref.site === 'codeforces' ? ref.taskId : (ref.index ?? '');
  const args = [ref.site, a.code, a.fileName, a.languagePatterns, index, ref.taskId] as const;
  let r = await runInPage(tabId, fillAndSubmit, [...args, false]);
  if (r?.noform) {
    await chrome.tabs.update(tabId, { url: submitPageUrl(ref) });
    await waitForLoad(tabId);
    r = await runInPage(tabId, fillAndSubmit, [...args, false]);
  }
  if (r?.needsCaptcha) {
    setBadge(tabId, '!', '#d29922', 'Finish the captcha; cp2 submits right after');
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await runInPage(tabId, fillAndSubmit, [...args, true]);
      if (!r?.needsCaptcha) break;
    }
  }
  if (!r?.ok) return { ok: false, message: r?.noform ? "couldn't find the submit form (are you logged in / registered for the contest?)" : r?.needsCaptcha ? 'captcha not completed' : (r?.message ?? 'submit failed') };
  const landed = await waitForUrl(tabId, (u) => /\/(my|status)(\?|$)|\/submissions\/me|\/submissions\/\d+|\/submissions\?|\/submission\/\d+/.test(u), 20000);
  if (!landed) {
    const err = await runInPage(tabId, readSubmitError, []);
    return { ok: false, message: err || 'the site did not accept the submission' };
  }
  const s = await load();
  s.tracking = { ref, tabId, since: Date.now(), lastUpdate: Date.now(), submissionId: landed.match(/\/submission\/(\d+)/)?.[1] };
  await save(s);
  setBadge(tabId, '…', '#6e7681', 'Judging…');
  scheduleVerdictPoll();
  return { ok: true, message: 'In queue' };
}

// ---------------- verdicts ----------------

function rowMatches(ref: ProblemRef, r: VerdictRow): boolean {
  if (ref.site === 'codeforces') return r.contestId === ref.contestId && (r.taskId ?? '').toUpperCase() === ref.taskId.toUpperCase();
  return r.taskId === ref.taskId;
}

async function onRows(tabId: number, rows: VerdictRow[], fromPoll: boolean): Promise<void> {
  const s = await load();
  const t = s.tracking;
  if (!t || !rows?.length) return;
  // Until we know our submission's id, only trust the tab we submitted from (fresh page).
  if (!t.submissionId && !fromPoll && tabId !== t.tabId) return;
  const row = t.submissionId ? rows.find((r) => r.submissionId === t.submissionId) : rows.find((r) => rowMatches(t.ref, r));
  if (!row) return;
  t.submissionId = row.submissionId;
  t.lastUpdate = Date.now();
  if (row.text !== t.lastText) {
    t.lastText = row.text;
    const update: VerdictUpdate = { ref: t.ref, submissionId: row.submissionId, status: row.status, text: row.text, short: row.short, url: row.url, at: Date.now(), final: row.final };
    send({ type: 'verdict', update });
    if (row.final) setBadge(t.tabId, row.status === 'accepted' ? '✓' : '✗', row.status === 'accepted' ? '#2ea043' : '#da3633', row.text);
  }
  s.tracking = row.final ? null : t;
  await save(s);
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleVerdictPoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void verdictPoll(), 3000);
}

/** Fallback when the submissions page isn't open: fetch it every few seconds until final. */
async function verdictPoll(): Promise<void> {
  pollTimer = undefined;
  const s = await load();
  const t = s.tracking;
  if (!t) return;
  if (Date.now() - t.since > 10 * 60 * 1000) {
    s.tracking = null;
    await save(s);
    return;
  }
  if (t.ref.site === 'dmoj' && t.submissionId) {
    // DMOJ's submission page doesn't list rows; its row widget gives the live status.
    try {
      const url = `https://dmoj.ca/widgets/single_submission?id=${t.submissionId}`;
      const rows = await parseRemote<VerdictRow[]>('rows', await fetchText(url), url);
      for (const r of rows) {
        r.submissionId = t.submissionId;
        r.taskId = t.ref.taskId;
        r.url = `https://dmoj.ca/submission/${t.submissionId}`;
      }
      await onRows(-1, rows.slice(0, 1), true);
    } catch {
      /* try again */
    }
  } else if (Date.now() - t.lastUpdate > 5000 || (!t.submissionId && Date.now() - t.since > 15000)) {
    try {
      const url = mySubmissionsUrl(t.ref);
      const rows = await parseRemote<VerdictRow[]>('rows', await fetchText(url), url);
      await onRows(-1, rows, true);
    } catch {
      /* try again */
    }
  }
  scheduleVerdictPoll();
}

// ---------------- toolbar icon ----------------

const acks = new Map<string, number>();

function setBadge(tabId: number, text: string, color: string, title?: string): void {
  if (tabId < 0) return;
  void chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
  if (title) void chrome.action.setTitle({ tabId, title: `cp2: ${title}` }).catch(() => undefined);
  if (text !== '…' && text !== '!')
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    }, 5000);
}

function onAck(requestId: string, ok: boolean, message: string): void {
  const tabId = acks.get(requestId);
  acks.delete(requestId);
  if (tabId !== undefined) setBadge(tabId, ok ? '✓' : '✗', ok ? '#2ea043' : '#da3633', message);
}

/** Toolbar icon on a page that isn't a known judge: PDFs directly, anything else heuristically. */
async function iconScrape(tab: chrome.tabs.Tab): Promise<ProblemData | null> {
  const pdf = pdfProblem(tab.url);
  if (pdf) return pdf;
  // activeTab lets us inject into the page the icon was clicked on.
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
  return (await chrome.tabs.sendMessage(tab.id!, { type: 'scrape', generic: true })) as ProblemData | null;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  if (!connected()) {
    connect();
    setBadge(tabId, '✗', '#da3633', 'VS Code is not connected (is cp2-bridge installed and VS Code open?)');
    return;
  }
  setBadge(tabId, '…', '#6e7681');
  const info = await pageInfoOf(tabId);
  let problem = info?.problem ?? null;
  let error: string | undefined;
  if (info) await onInteract(tabId, info);
  try {
    if (!problem && info?.kind !== 'contest') problem = await iconScrape(tab);
    problem = await withPdf(problem);
    if (problem && !problem.tests.length && !problem.interactive) error = problem.note ?? "no samples found on this page";
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  if (!problem && !error) error = 'this page has no problem cp2 can read';
  const requestId = Math.random().toString(36).slice(2);
  acks.set(requestId, tabId);
  send({ type: 'icon', requestId, problem: error && !problem?.tests.length ? null : problem, error });
  setTimeout(() => {
    if (acks.has(requestId)) onAck(requestId, false, 'VS Code did not answer');
  }, 15000);
});

// ---------------- lifecycle ----------------

chrome.runtime.onInstalled.addListener(async () => {
  // Pages opened before the extension was installed don't have the content script yet.
  for (const t of await siteTabs()) {
    if (t.id !== undefined) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => undefined);
  }
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.alarms.create('cp2-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'cp2-reconnect') return;
  connect();
  void load().then((s) => {
    if (s.tracking) scheduleVerdictPoll();
  });
});

connect();
