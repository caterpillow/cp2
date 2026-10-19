// Site-independent sample extraction from HTML: finds "Sample Input 1" / "Output for Sample Input 1" /
// "Example" / "Input:" style labels and the <pre> blocks that follow them, plus two-column sample
// tables (Kattis style). Used by DMOJ / QOJ and for any page imported through the toolbar icon.

import type { SampleTest } from '../../../shared/protocol';
import { cleanText, preText } from './common';

type Kind = 'in' | 'out';

const EXCLUDE = /(explanation|note|notes|figure|description|format|constraints|limits|clarification|hint|subtask)/i;
// "Sample Input 1", "Example input #2", "Sample 1 Input", "输入样例 1", "入力例 1", "예제 입력 1"
const SAMPLE_IN = /^(?:(?:sample|example)s?\s*(?:test\s*(?:case)?\s*)?(?:#?\d+\s*)?(?:input|in)\b|input\s+(?:sample|example)|样例\s*输入|输入\s*样例|入力例|예제\s*입력|входные\s+данные|пример\s+входных)/i;
const SAMPLE_OUT = /^(?:(?:sample|example)s?\s*(?:test\s*(?:case)?\s*)?(?:#?\d+\s*)?(?:output|out|answer)\b|output\s+(?:for\s+)?(?:sample|example)|样例\s*输出|输出\s*样例|出力例|예제\s*출력|выходные\s+данные|пример\s+выходных)/i;
// bare "Input" / "Output:" labels (CSES style) only count when a <pre> follows immediately
const BARE_IN = /^(?:input|stdin|standard input)\s*(?:#?\d+)?\s*:?$/i;
const BARE_OUT = /^(?:output|stdout|standard output)\s*(?:#?\d+)?\s*:?$/i;

const LABEL_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV', 'STRONG', 'B', 'DT', 'TH', 'SPAN', 'LABEL', 'SUMMARY', 'LI', 'TD']);

function classify(text: string): { kind: Kind; num?: number; bare: boolean } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60 || EXCLUDE.test(t)) return null;
  const num = (() => {
    const m = t.match(/(\d+)\D*$/);
    return m ? Number(m[1]) : undefined;
  })();
  // "Output for Sample Input 1" mentions both: output wins.
  if (SAMPLE_OUT.test(t) || /^output\s+for\s+sample\s+input/i.test(t)) return { kind: 'out', num, bare: false };
  if (SAMPLE_IN.test(t)) return { kind: 'in', num, bare: false };
  if (BARE_OUT.test(t)) return { kind: 'out', num, bare: true };
  if (BARE_IN.test(t)) return { kind: 'in', num, bare: true };
  return null;
}

/** Direct text of an element ignoring a trailing "Copy" button etc. */
function labelText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('button, .copy, .input-output-copier, script, style').forEach((x) => x.remove());
  return cleanText(clone);
}

function isPre(el: Element): boolean {
  return el.tagName === 'PRE' || (el.tagName === 'CODE' && el.parentElement?.tagName !== 'PRE' && /\n/.test(el.textContent ?? ''));
}

export function genericSamples(root: Element | null | undefined): SampleTest[] {
  if (!root) return [];
  const fromTables = tableSamples(root);
  if (fromTables.length) return fromTables;

  const ins: { num?: number; text: string }[] = [];
  const outs: { num?: number; text: string }[] = [];
  let pending: { kind: Kind; num?: number; bare: boolean; textSince: number } | null = null;
  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all) {
    if (isPre(el)) {
      if (el.parentElement?.closest('pre')) continue;
      if (pending && (!pending.bare || pending.textSince < 40)) {
        (pending.kind === 'in' ? ins : outs).push({ num: pending.num, text: preText(el) });
      }
      pending = null;
      continue;
    }
    if (!LABEL_TAGS.has(el.tagName)) continue;
    if (el.closest('pre')) continue;
    // Only consider the innermost element carrying the label text.
    const own = labelText(el);
    if (!own || own.length > 60) {
      if (pending && el.children.length === 0) pending.textSince += (el.textContent ?? '').trim().length;
      continue;
    }
    const childWithSame = Array.from(el.children).some((c) => labelText(c) === own);
    if (childWithSame) continue;
    const c = classify(own);
    if (c) pending = { ...c, textSince: 0 };
    else if (pending && el.children.length === 0) pending.textSince += own.length;
  }
  return pair(ins, outs);
}

function pair(ins: { num?: number; text: string }[], outs: { num?: number; text: string }[]): SampleTest[] {
  if (!ins.length) return [];
  const numbered = ins.every((x) => x.num !== undefined) && outs.every((x) => x.num !== undefined) && new Set(ins.map((x) => x.num)).size === ins.length;
  if (numbered) {
    return ins.map((i) => ({ input: i.text, output: outs.find((o) => o.num === i.num)?.text ?? '' }));
  }
  return ins.map((i, k) => ({ input: i.text, output: outs[k]?.text ?? '' }));
}

/** Tables whose header says input/output and whose rows hold two <pre>s. */
function tableSamples(root: Element): SampleTest[] {
  const out: SampleTest[] = [];
  root.querySelectorAll('table').forEach((t) => {
    const rows = Array.from(t.querySelectorAll('tr'));
    const head = rows.find((r) => r.querySelector('th, td') && !r.querySelector('pre'));
    if (!head) return;
    const cells = Array.from(head.querySelectorAll('th, td')).map((c) => cleanText(c));
    const inCol = cells.findIndex((c) => /input|stdin/i.test(c));
    const outCol = cells.findIndex((c) => /output|stdout/i.test(c));
    if (inCol < 0 || outCol < 0) return;
    for (const r of rows) {
      const tds = Array.from(r.querySelectorAll('td'));
      const a = tds[inCol]?.querySelector('pre');
      const b = tds[outCol]?.querySelector('pre');
      if (a) out.push({ input: preText(a), output: b ? preText(b) : '' });
    }
  });
  return out;
}

/** Best guess at a problem name on an unknown page. */
export function genericTitle(doc: Document): string {
  const h = doc.querySelector('h1, .problem-title, .title, h2');
  const t = cleanText(h) || (doc.title || '').trim();
  return t.slice(0, 120);
}
