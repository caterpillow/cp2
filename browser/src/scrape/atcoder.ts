import { ContestRef, parseContestUrl, parseProblemUrl } from '../../../shared/problemId';
import type { ContestInfo, ContestTask, ProblemData, SampleTest } from '../../../shared/protocol';
import { cleanText, parseMemoryLimit, parseTimeLimit, preText } from './common';

function momentTime(html: string, name: 'startTime' | 'endTime'): number | undefined {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*moment\\("([^"]+)"\\)`));
  if (!m) return undefined;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : undefined;
}

function scriptsText(doc: Document): string {
  return Array.from(doc.querySelectorAll('script'))
    .map((s) => s.textContent ?? '')
    .join('\n');
}

export function scrapeAcTask(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'atcoder') return null;
  const h2 = doc.querySelector('span.h2');
  let title = '';
  if (h2) {
    const clone = h2.cloneNode(true) as Element;
    clone.querySelectorAll('a, .btn').forEach((x) => x.remove());
    title = cleanText(clone);
  }
  if (!title) title = (doc.title || '').trim();
  const idx = title.match(/^([A-Za-z0-9]+)\s*-\s*/);
  if (idx) ref.index = idx[1];
  const limits = Array.from(doc.querySelectorAll('#main-container p, .col-sm-12 > p'))
    .map((p) => cleanText(p))
    .find((t) => /(Time Limit|実行時間制限)/.test(t));
  const statement = doc.querySelector('#task-statement');
  const root = statement?.querySelector('.lang-en') ?? statement?.querySelector('.lang-ja') ?? statement;
  const inputs = new Map<number, string>();
  const outputs = new Map<number, string>();
  root?.querySelectorAll('h3').forEach((h3) => {
    const t = cleanText(h3);
    const mi = t.match(/^(Sample Input|入力例)\s*(\d+)/i);
    const mo = t.match(/^(Sample Output|出力例)\s*(\d+)/i);
    if (!mi && !mo) return;
    let pre: Element | null = h3.nextElementSibling;
    while (pre && pre.tagName !== 'PRE') pre = pre.nextElementSibling;
    if (!pre) pre = h3.parentElement?.querySelector('pre') ?? null;
    if (!pre) return;
    if (mi) inputs.set(Number(mi[2]), preText(pre));
    else if (mo) outputs.set(Number(mo[2]), preText(pre));
  });
  const nums = [...new Set([...inputs.keys(), ...outputs.keys()])].sort((a, b) => a - b);
  const tests: SampleTest[] = nums.map((n) => ({ input: inputs.get(n) ?? '', output: outputs.get(n) ?? '' }));
  const text = root?.textContent ?? '';
  const interactive = /this is an interactive (task|problem)|interactive task|インタラクティブ/i.test(text);
  let tl: number | undefined;
  let ml: number | undefined;
  if (limits) {
    tl = parseTimeLimit(limits.replace(/実行時間制限\s*:/, 'Time Limit:'));
    ml = parseMemoryLimit(limits);
  }
  return { ref, name: title, timeLimitMs: tl, memoryLimitMb: ml, interactive, tests, scrapedAt: Date.now() };
}

/** Contest top page, task list or standings. Task list comes from links (standings links work before the start). */
export function scrapeAcContest(doc: Document, url: string): ContestInfo | null {
  const ref: ContestRef | null = parseContestUrl(url);
  if (!ref || ref.site !== 'atcoder') return null;
  const name = cleanText(doc.querySelector('.contest-title')) || (doc.title || '').replace(/\s*-\s*AtCoder\s*$/, '').replace(/^Tasks\s*-\s*/, '').trim();
  const scripts = scriptsText(doc);
  let tasks: ContestTask[] | null = null;
  const path = new URL(url).pathname;
  const prefix = `/contests/${ref.contestId}/tasks/`;
  if (/\/tasks\/?$/.test(path)) {
    tasks = [];
    doc.querySelectorAll('tbody tr').forEach((tr) => {
      const links = Array.from(tr.querySelectorAll(`a[href*="${prefix}"]`));
      if (!links.length) return;
      const href = links[0].getAttribute('href') ?? '';
      const taskId = href.slice(href.indexOf(prefix) + prefix.length).split(/[?#/]/)[0];
      const tds = Array.from(tr.querySelectorAll('td'));
      tasks!.push({ index: cleanText(links[0]), taskId, name: links[1] ? cleanText(links[1]) : undefined, url: `https://atcoder.jp${prefix}${taskId}`, timeLimitMs: tds[2] ? parseTimeLimit(cleanText(tds[2])) : undefined, memoryLimitMb: tds[3] ? parseMemoryLimit(cleanText(tds[3])) : undefined });
    });
  } else if (/\/standings/.test(path)) {
    const seen = new Set<string>();
    tasks = [];
    doc.querySelectorAll(`thead a[href*="${prefix}"], a[href*="${prefix}"]`).forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      const taskId = href.slice(href.indexOf(prefix) + prefix.length).split(/[?#/]/)[0];
      const index = cleanText(a);
      if (!taskId || seen.has(taskId) || !index || index.length > 3) return;
      seen.add(taskId);
      tasks!.push({ index, taskId, url: `https://atcoder.jp${prefix}${taskId}` });
    });
  }
  if (tasks && !tasks.length) tasks = null;
  return { ref, name: name || ref.contestId, tasks, startTime: momentTime(scripts, 'startTime'), endTime: momentTime(scripts, 'endTime'), seenAt: Date.now() };
}

/** Task list from /contests/<id>/standings/json (works before the start when logged in). */
export function tasksFromStandingsJson(contestId: string, json: any): ContestTask[] | null {
  const info = json?.TaskInfo;
  if (!Array.isArray(info) || !info.length) return null;
  return info.map((t: any) => ({ index: String(t.Assignment), taskId: String(t.TaskScreenName), name: t.TaskName ? String(t.TaskName) : undefined, url: `https://atcoder.jp/contests/${contestId}/tasks/${t.TaskScreenName}` }));
}
