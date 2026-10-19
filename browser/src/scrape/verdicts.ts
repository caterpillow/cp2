// Reads verdicts from "my submissions" pages.

import type { VerdictStatus } from '../../../shared/protocol';
import { cleanText } from './common';

export interface VerdictRow {
  submissionId: string;
  contestId: string | null;
  taskId: string | null;
  text: string;
  status: VerdictStatus;
  short: string;
  final: boolean;
  url: string;
}

export function cfShort(t: string): string {
  if (/^(Accepted|Pretests passed|Happy)/i.test(t)) return 'AC';
  if (/Wrong answer/i.test(t)) return 'WA';
  if (/Time limit/i.test(t)) return 'TL';
  if (/Memory limit/i.test(t)) return 'ML';
  if (/Runtime error/i.test(t)) return 'RE';
  if (/Compilation error/i.test(t)) return 'CE';
  if (/Idleness/i.test(t)) return 'IL';
  if (/Hacked/i.test(t)) return 'HK';
  if (/Presentation/i.test(t)) return 'PE';
  if (/Output limit/i.test(t)) return 'OL';
  if (/Denial|Judgement failed/i.test(t)) return 'JF';
  if (/Partial/i.test(t)) return 'PA';
  if (/Skipped/i.test(t)) return 'SK';
  return '';
}

export function parseCfSubmissions(doc: Document): VerdictRow[] {
  const rows: VerdictRow[] = [];
  doc.querySelectorAll('tr[data-submission-id]').forEach((tr) => {
    const id = tr.getAttribute('data-submission-id') ?? '';
    const a = tr.querySelector('a[href*="/problem/"]');
    const href = a?.getAttribute('href') ?? '';
    const m = href.match(/\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)/) ?? href.match(/\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/);
    const cell = tr.querySelector('td.status-verdict-cell, td.status-cell');
    const text = cleanText(cell);
    let status: VerdictStatus;
    if (cell?.querySelector('.verdict-accepted') || /^(Accepted|Pretests passed)/i.test(text)) status = 'accepted';
    else if (/Partial result/i.test(text)) status = 'partial';
    else if (cell?.querySelector('.verdict-rejected, .verdict-failed') || /(Wrong answer|limit exceeded|error|Hacked|Denial|failed|Skipped)/i.test(text)) status = 'rejected';
    else status = 'judging';
    const waiting = cell?.getAttribute('waiting') === 'true' || /(Running|In queue|Judging|Testing|Compiling|Waiting)/i.test(text);
    if (waiting && status !== 'accepted') status = 'judging';
    rows.push({ submissionId: id, contestId: m ? m[1] : null, taskId: m ? m[2].toUpperCase() : null, text: text || 'In queue', status, short: cfShort(text), final: status !== 'judging', url: `https://codeforces.com${href.replace(/\/problem\/.*/, '')}/submission/${id}` });
  });
  return rows;
}

const AC_FINAL: Record<string, [VerdictStatus, string]> = {
  AC: ['accepted', 'AC'],
  WA: ['rejected', 'WA'],
  TLE: ['rejected', 'TL'],
  MLE: ['rejected', 'ML'],
  RE: ['rejected', 'RE'],
  CE: ['rejected', 'CE'],
  OLE: ['rejected', 'OL'],
  IE: ['rejected', 'IE'],
  QLE: ['rejected', 'QL'],
};

export function parseAcSubmissions(doc: Document): VerdictRow[] {
  const rows: VerdictRow[] = [];
  doc.querySelectorAll('tbody tr').forEach((tr) => {
    const sub = Array.from(tr.querySelectorAll('a[href*="/submissions/"]')).find((x) => /\/submissions\/\d+/.test(x.getAttribute('href') ?? ''));
    const task = tr.querySelector('a[href*="/tasks/"]');
    if (!sub || !task) return;
    const sh = sub.getAttribute('href') ?? '';
    const id = sh.match(/\/submissions\/(\d+)/)![1];
    const th = task.getAttribute('href') ?? '';
    const tm = th.match(/\/contests\/([^/]+)\/tasks\/([^/?#]+)/);
    const label = tr.querySelector('span.label');
    const code = cleanText(label);
    const fin = AC_FINAL[code];
    const status: VerdictStatus = fin ? fin[0] : 'judging';
    rows.push({ submissionId: id, contestId: tm ? tm[1] : null, taskId: tm ? tm[2] : null, text: fin ? code : code ? `Judging ${code}` : 'Waiting for judge', status, short: fin ? fin[1] : '', final: !!fin, url: `https://atcoder.jp${sh}` });
  });
  return rows;
}

const DMOJ: Record<string, [VerdictStatus, string]> = {
  AC: ['accepted', 'AC'],
  WA: ['rejected', 'WA'],
  TLE: ['rejected', 'TL'],
  MLE: ['rejected', 'ML'],
  OLE: ['rejected', 'OL'],
  IR: ['rejected', 'IR'],
  RTE: ['rejected', 'RE'],
  CE: ['rejected', 'CE'],
  IE: ['rejected', 'IE'],
  AB: ['rejected', 'AB'],
  SC: ['rejected', 'SC'],
};

/** DMOJ submission rows (list pages and the /widgets/single_submission snippet). */
export function parseDmojSubmissions(doc: Document): VerdictRow[] {
  const results = Array.from(doc.querySelectorAll('.sub-result'));
  return results.map((res) => {
    const row = res.closest('.submission-row');
    const id = row?.getAttribute('id') ?? '';
    const code = cleanText(res.querySelector('.state .status')) || (res.className.match(/sub-result\s+(\w+)/)?.[1] ?? '');
    const score = cleanText(res.querySelector('.score'));
    const sm = score.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    const fin = DMOJ[code];
    let status: VerdictStatus = fin ? fin[0] : 'judging';
    if (status === 'rejected' && sm && Number(sm[1]) > 0) status = 'partial';
    const a = (row ?? doc).querySelector('.name a[href^="/problem/"]');
    const text = fin ? `${res.querySelector('.state .status')?.getAttribute('title') || code}${sm ? ` (${sm[1]}/${sm[2]})` : ''}` : code === 'QU' ? 'In queue' : 'Grading…';
    return { submissionId: id, contestId: '', taskId: a ? (a.getAttribute('href') ?? '').split('/')[2] : null, text, status, short: fin ? fin[1] : '', final: !!fin, url: id ? `https://dmoj.ca/submission/${id}` : '' };
  });
}
