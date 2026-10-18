import { canonicalCfProblemUrl, CfKind, ContestRef, parseContestUrl, parseProblemUrl, ProblemRef } from '../../../shared/problemId';
import type { ContestInfo, ContestTask, ProblemData, SampleTest } from '../../../shared/protocol';
import { cleanText, parseMemoryLimit, parseTimeLimit, preText } from './common';

/** Samples, limits and name from one `.problem-statement` element. */
export function cfStatement(statement: Element, ref: ProblemRef): ProblemData {
  const header = statement.querySelector('.header');
  const name = cleanText(header?.querySelector('.title'));
  const prop = (sel: string) => {
    const el = header?.querySelector(sel);
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelector('.property-title')?.remove();
    return cleanText(clone);
  };
  const tests: SampleTest[] = [];
  statement.querySelectorAll('.sample-test').forEach((st) => {
    const ins = Array.from(st.querySelectorAll('.input pre'));
    const outs = Array.from(st.querySelectorAll('.output pre'));
    for (let i = 0; i < Math.max(ins.length, outs.length); i++) {
      tests.push({ input: ins[i] ? preText(ins[i]) : '', output: outs[i] ? preText(outs[i]) : '' });
    }
  });
  const interactive = Array.from(statement.querySelectorAll('.section-title')).some((e) => /^\s*Interaction\s*$/i.test(e.textContent ?? '')) || /this is an interactive problem/i.test(statement.textContent ?? '');
  return { ref, name, timeLimitMs: parseTimeLimit(prop('.time-limit')), memoryLimitMb: parseMemoryLimit(prop('.memory-limit')), interactive, tests, scrapedAt: Date.now() };
}

export function scrapeCfProblem(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'codeforces') return null;
  const st = doc.querySelector('.problem-statement');
  return st ? cfStatement(st, ref) : null;
}

/**
 * The all-problems page (/contest/<id>/problems): every statement on one page. Picks the one
 * containing `focusY` (viewport y of the last interaction), else the first.
 */
export function scrapeCfProblemsPage(doc: Document, url: string, pick?: { index?: string; y?: number }): ProblemData | null {
  const c = parseContestUrl(url);
  if (!c || c.site !== 'codeforces') return null;
  const holders = Array.from(doc.querySelectorAll('.problemindexholder[problemindex]'));
  if (!holders.length) return null;
  let h = holders[0];
  if (pick?.index) h = holders.find((x) => x.getAttribute('problemindex')?.toUpperCase() === pick.index!.toUpperCase()) ?? h;
  else if (pick?.y !== undefined) {
    for (const x of holders) {
      const r = (x as HTMLElement).getBoundingClientRect?.();
      if (r && r.top <= pick.y && r.bottom >= pick.y) {
        h = x;
        break;
      }
      if (r && r.top > pick.y) break;
      h = x;
    }
  }
  const index = (h.getAttribute('problemindex') ?? '').toUpperCase();
  const st = h.querySelector('.problem-statement');
  if (!st) return null;
  const kind: CfKind = c.cfKind ?? 'contest';
  const ref: ProblemRef = { site: 'codeforces', contestId: c.contestId, taskId: index, index, url: kind === 'group' ? `https://codeforces.com/group/${c.groupId}/contest/${c.contestId}/problem/${index}` : canonicalCfProblemUrl(kind, c.contestId, index), cfKind: kind, groupId: c.groupId };
  return cfStatement(st, ref);
}

function contestName(doc: Document): string {
  const side = cleanText(doc.querySelector('#sidebar .rtable th.left a, #sidebar .rtable th a'));
  if (side) return side;
  const t = (doc.title || '').replace(/\s*-\s*Codeforces\s*$/, '').replace(/^(Dashboard|Problems)\s*-\s*/, '');
  return t.trim();
}

/** Countdown "hh:mm:ss" / "d days hh:mm:ss" in the sidebar -> ms. */
function countdownMs(doc: Document): number | undefined {
  const t = cleanText(doc.querySelector('#sidebar .countdown'));
  const m = t.match(/(?:(\d+)\s*days?\s*)?(\d+):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2])) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
}

export function scrapeCfContest(doc: Document, url: string): ContestInfo | null {
  const ref: ContestRef | null = parseContestUrl(url);
  if (!ref || ref.site !== 'codeforces') return null;
  const base = ref.url;
  let tasks: ContestTask[] | null = null;
  const table = doc.querySelector('table.problems');
  if (table) {
    tasks = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const idA = tr.querySelector('td.id a, td:first-child a[href*="/problem/"]');
      if (!idA) return;
      const index = cleanText(idA).toUpperCase();
      if (!index) return;
      const nameA = tr.querySelectorAll('td')[1]?.querySelector('a');
      const notice = cleanText(tr.querySelector('.notice'));
      tasks!.push({ index, taskId: index, name: cleanText(nameA) || undefined, url: `${base}/problem/${index}`, timeLimitMs: parseTimeLimit(notice), memoryLimitMb: parseMemoryLimit(notice) });
    });
  } else {
    const holders = Array.from(doc.querySelectorAll('.problemindexholder[problemindex]'));
    if (holders.length) {
      tasks = holders.map((h) => {
        const index = (h.getAttribute('problemindex') ?? '').toUpperCase();
        const title = cleanText(h.querySelector('.header .title'));
        return { index, taskId: index, name: title.replace(/^[A-Z0-9]+\.\s*/i, '') || undefined, url: `${base}/problem/${index}`, timeLimitMs: parseTimeLimit(cleanText(h.querySelector('.time-limit'))), memoryLimitMb: parseMemoryLimit(cleanText(h.querySelector('.memory-limit'))) };
      });
    }
  }
  if (tasks && !tasks.length) tasks = null;
  const phase = cleanText(doc.querySelector('#sidebar .contest-state-phase'));
  const cd = countdownMs(doc);
  const now = Date.now();
  let startTime: number | undefined;
  let endTime: number | undefined;
  if (cd !== undefined) {
    if (/before/i.test(phase)) startTime = now + cd;
    else endTime = now + cd;
  }
  return { ref, name: contestName(doc) || `Codeforces ${ref.contestId}`, tasks, startTime, endTime, seenAt: now };
}

/** The handle of the logged-in user (top right). */
export function cfHandle(doc: Document): string | null {
  const a = Array.from(doc.querySelectorAll('.lang-chooser a[href^="/profile/"]'))[0];
  return a ? (a.getAttribute('href') ?? '').replace('/profile/', '') : null;
}
