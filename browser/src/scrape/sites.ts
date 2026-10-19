// Scrapers for DMOJ, QOJ, oj.uz, ORAC and arbitrary pages.

import { ContestRef, parseContestUrl, parseProblemUrl, ProblemRef, webRef } from '../../../shared/problemId';
import type { ContestInfo, ContestTask, ProblemData } from '../../../shared/protocol';
import { cleanText, embeddedPdf, headerTable, parseMemoryLimit, parseTimeLimit } from './common';
import { genericSamples, genericTitle } from './generic';

const INTERACTIVE = /this (is an|problem is) interactive|interactive (problem|task)|交互题|インタラクティブ/i;

function problem(ref: ProblemRef, name: string, extra: Partial<ProblemData>): ProblemData {
  return { ref, name, tests: [], scrapedAt: Date.now(), ...extra };
}

// ---------------- DMOJ ----------------

function dmojInfo(doc: Document, label: RegExp): string {
  for (const e of Array.from(doc.querySelectorAll('.problem-info-entry'))) {
    if (label.test(cleanText(e.querySelector('.pi-name')))) return cleanText(e.querySelector('.pi-value'));
  }
  return '';
}

export function scrapeDmojProblem(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'dmoj') return null;
  const body = doc.querySelector('.content-description') ?? doc.querySelector('#content-left') ?? doc.body;
  const name = cleanText(doc.querySelector('.problem-title h2')) || genericTitle(doc);
  return problem(ref, name, {
    timeLimitMs: parseTimeLimit(dmojInfo(doc, /time limit/i)),
    memoryLimitMb: parseMemoryLimit(dmojInfo(doc, /memory limit/i)),
    interactive: INTERACTIVE.test(body?.textContent ?? ''),
    tests: genericSamples(body),
  });
}

export function scrapeDmojContest(doc: Document, url: string): ContestInfo | null {
  const ref: ContestRef | null = parseContestUrl(url);
  if (!ref || ref.site !== 'dmoj') return null;
  const seen = new Set<string>();
  const tasks: ContestTask[] = [];
  doc.querySelectorAll('.contest-problems a[href^="/problem/"], #contest-problems a[href^="/problem/"]').forEach((a) => {
    const code = (a.getAttribute('href') ?? '').split('/')[2];
    if (!code || seen.has(code)) return;
    seen.add(code);
    tasks.push({ index: code, taskId: code, name: cleanText(a) || undefined, url: `https://dmoj.ca/problem/${code}` });
  });
  const name = cleanText(doc.querySelector('#content h2, .tabs h2, h2')) || (doc.title || '').replace(/\s*-\s*DMOJ.*$/, '');
  return { ref, name: name || ref.contestId, tasks: tasks.length ? tasks : null, seenAt: Date.now() };
}

// ---------------- QOJ (UOJ) ----------------

export function scrapeQojProblem(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'qoj') return null;
  const badges = Array.from(doc.querySelectorAll('.badge')).map((b) => cleanText(b));
  const tl = badges.find((b) => /time limit/i.test(b)) ?? '';
  const ml = badges.find((b) => /memory limit/i.test(b)) ?? '';
  const article = doc.querySelector('#tab-statement article, article.uoj-article');
  const pdf = doc.querySelector('#statements-pdf') ? embeddedPdf(doc, url) : undefined;
  const title = cleanText(doc.querySelector('h1.text-center, .page-header h1, h1')) || (doc.title || '').replace(/\s*-\s*Problem\s*-\s*QOJ\.ac\s*$/, '');
  return problem(ref, title.replace(/^#\d+\.\s*/, ''), {
    timeLimitMs: parseTimeLimit(tl),
    memoryLimitMb: parseMemoryLimit(ml),
    interactive: INTERACTIVE.test(article?.textContent ?? ''),
    tests: genericSamples(article),
    pdfUrl: pdf,
  });
}

export function scrapeQojContest(doc: Document, url: string): ContestInfo | null {
  const ref = parseContestUrl(url);
  if (!ref || ref.site !== 'qoj') return null;
  const tasks: ContestTask[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll(`a[href*="/contest/${ref.contestId}/problem/"]`).forEach((a) => {
    const id = (a.getAttribute('href') ?? '').split('/problem/')[1]?.split(/[?#/]/)[0];
    if (!id || seen.has(id)) return;
    const row = a.closest('tr');
    const label = cleanText(row?.querySelector('td')) || cleanText(a).match(/^([A-Z][0-9]?)\b/)?.[1] || String(tasks.length + 1);
    seen.add(id);
    tasks.push({ index: label.length <= 3 ? label : String(tasks.length + 1), taskId: id, name: cleanText(a).replace(/^[A-Z][0-9]?\.\s*/, '') || undefined, url: `https://qoj.ac/contest/${ref.contestId}/problem/${id}` });
  });
  const name = cleanText(doc.querySelector('.page-header h1, h1')) || (doc.title || '').replace(/\s*-\s*QOJ\.ac\s*$/, '');
  return { ref, name: name || `QOJ ${ref.contestId}`, tasks: tasks.length ? tasks : null, seenAt: Date.now() };
}

// ---------------- oj.uz ----------------

export function scrapeOjuzProblem(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'ojuz') return null;
  const h1 = doc.querySelector('h1');
  let name = '';
  if (h1) {
    const clone = h1.cloneNode(true) as Element;
    clone.querySelectorAll('small, button').forEach((x) => x.remove());
    name = cleanText(clone);
  }
  const t = headerTable(doc);
  return problem(ref, name || ref.taskId, {
    timeLimitMs: parseTimeLimit(t.get('time limit') ?? ''),
    memoryLimitMb: parseMemoryLimit(t.get('memory limit') ?? ''),
    pdfUrl: embeddedPdf(doc, url),
    interactive: /communication|interactive/i.test(cleanText(h1)),
  });
}

// ---------------- ORAC ----------------

export function scrapeOracProblem(doc: Document, url: string): ProblemData | null {
  const ref = parseProblemUrl(url);
  if (!ref || ref.site !== 'orac2') return null;
  const t = headerTable(doc);
  const input = t.get('input file');
  const output = t.get('output file');
  return problem(ref, cleanText(doc.querySelector('h1')) || ref.taskId, {
    timeLimitMs: parseTimeLimit(t.get('time limit') ?? ''),
    memoryLimitMb: parseMemoryLimit(t.get('memory limit') ?? ''),
    pdfUrl: embeddedPdf(doc, url),
    ioFiles: input && output && !/stdin|standard/i.test(input) ? { input, output } : undefined,
  });
}

// ---------------- anything else (toolbar icon) ----------------

export function scrapeGeneric(doc: Document, url: string): ProblemData {
  const ref = webRef(url);
  const body = doc.body;
  const text = body?.textContent ?? '';
  return problem(ref, genericTitle(doc), {
    tests: genericSamples(body),
    timeLimitMs: parseTimeLimit(text.match(/time limit[^\n]{0,40}/i)?.[0] ?? ''),
    memoryLimitMb: parseMemoryLimit(text.match(/memory limit[^\n]{0,40}/i)?.[0] ?? ''),
    pdfUrl: embeddedPdf(doc, url),
    interactive: INTERACTIVE.test(text),
  });
}
