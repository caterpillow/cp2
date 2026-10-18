// Output comparison. All modes report where the first difference is (1-based lines, 0-based
// columns in the original text) so the sidebar can highlight it.
//
//   standard   CPH semantics: lines compared after trimming each one; leading/trailing blank
//              lines ignored.
//   firstLine  only the first non-blank line is compared (same trimming).
//   precision  whitespace-separated tokens; numbers match within 1e-6 absolute or relative.
//   checker    external program: `checker <input> <output> <expected>`, exit 0 = accepted.

import * as fsp from 'fs/promises';
import type { CompareMode } from './store';

export interface DiffInfo {
  expectedLine: number;
  receivedLine: number;
  expectedCol: number;
  receivedCol: number;
  expectedLen: number;
  receivedLen: number;
}

export interface CompareResult {
  pass: boolean;
  diff?: DiffInfo;
  message?: string;
}

interface Line {
  no: number;
  text: string;
}

/** Iterates lines of a buffer without building one giant string. */
function* bufferLines(buf: Buffer): Generator<Line> {
  let start = 0;
  let no = 1;
  const n = buf.length;
  while (start < n) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = n;
    let e = end;
    if (e > start && buf[e - 1] === 13) e--;
    yield { no, text: buf.toString('utf8', start, e) };
    no++;
    start = end + 1;
  }
}

function leadingWs(s: string): number {
  return s.length - s.trimStart().length;
}

function firstDiffCol(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function lineDiff(exp: Line | undefined, rec: Line | undefined): DiffInfo {
  const et = exp?.text.trim() ?? '';
  const rt = rec?.text.trim() ?? '';
  const col = firstDiffCol(et, rt);
  return {
    expectedLine: exp?.no ?? 0,
    receivedLine: rec?.no ?? 0,
    expectedCol: exp ? leadingWs(exp.text) + col : 0,
    receivedCol: rec ? leadingWs(rec.text) + col : 0,
    expectedLen: Math.max(0, et.length - col),
    receivedLen: Math.max(0, rt.length - col),
  };
}

/** Lines with leading blank lines dropped (trailing ones are handled by the caller). */
function* contentLines(buf: Buffer): Generator<Line> {
  let started = false;
  for (const l of bufferLines(buf)) {
    if (!started && l.text.trim() === '') continue;
    started = true;
    yield l;
  }
}

function compareStandard(expected: Buffer, received: Buffer, firstOnly: boolean): CompareResult {
  const ei = contentLines(expected);
  const ri = contentLines(received);
  let lastE: Line | undefined;
  let lastR: Line | undefined;
  for (;;) {
    const e = ei.next();
    const r = ri.next();
    if (e.done && r.done) return { pass: true };
    if (!e.done) lastE = e.value;
    if (!r.done) lastR = r.value;
    if (e.done || r.done) {
      // One side ended: the rest of the other must be blank.
      const restIt = e.done ? ri : ei;
      let cur = (e.done ? r.value : e.value) as Line;
      for (;;) {
        if (cur.text.trim() !== '') {
          const extraE = e.done ? undefined : cur;
          const extraR = r.done ? undefined : cur;
          const d = lineDiff(extraE, extraR);
          if (e.done) d.expectedLine = (lastE?.no ?? 0) + 1;
          else d.receivedLine = (lastR?.no ?? 0) + 1;
          return { pass: false, diff: d, message: e.done ? 'received has extra lines' : 'received is missing lines' };
        }
        const nx = restIt.next();
        if (nx.done) return { pass: true };
        cur = nx.value;
      }
    }
    if (e.value.text.trim() !== r.value.text.trim()) return { pass: false, diff: lineDiff(e.value, r.value) };
    if (firstOnly) return { pass: true };
  }
}

interface Token {
  text: string;
  line: number;
  col: number;
}

function* tokens(buf: Buffer): Generator<Token> {
  for (const l of bufferLines(buf)) {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.text))) yield { text: m[0], line: l.no, col: m.index };
  }
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function numbersClose(expected: string, received: string, eps: number): boolean {
  if (!NUM.test(expected) || !NUM.test(received)) return false;
  const a = Number(expected);
  const b = Number(received);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const d = Math.abs(a - b);
  return d <= eps || d <= eps * Math.abs(a);
}

function comparePrecision(expected: Buffer, received: Buffer, eps: number): CompareResult {
  const ei = tokens(expected);
  const ri = tokens(received);
  for (;;) {
    const e = ei.next();
    const r = ri.next();
    if (e.done && r.done) return { pass: true };
    if (e.done || r.done) {
      const t = (e.done ? r.value : e.value) as Token;
      return {
        pass: false,
        message: e.done ? 'received has extra tokens' : 'received is missing tokens',
        diff: {
          expectedLine: e.done ? 0 : t.line,
          receivedLine: r.done ? 0 : t.line,
          expectedCol: e.done ? 0 : t.col,
          receivedCol: r.done ? 0 : t.col,
          expectedLen: e.done ? 0 : t.text.length,
          receivedLen: r.done ? 0 : t.text.length,
        },
      };
    }
    const et = e.value.text;
    const rt = r.value.text;
    if (et === rt || numbersClose(et, rt, eps)) continue;
    const both = NUM.test(et) && NUM.test(rt);
    return {
      pass: false,
      message: both ? `expected ${et}, got ${rt} (error ${Math.abs(Number(et) - Number(rt)).toExponential(2)} > ${eps})` : `expected "${et.slice(0, 40)}", got "${rt.slice(0, 40)}"`,
      diff: { expectedLine: e.value.line, receivedLine: r.value.line, expectedCol: e.value.col, receivedCol: r.value.col, expectedLen: et.length, receivedLen: rt.length },
    };
  }
}

/** Compares in memory (both buffers). Not used for `checker` mode. */
export function compareBuffers(expected: Buffer, received: Buffer, mode: CompareMode, eps = 1e-6): CompareResult {
  switch (mode) {
    case 'firstLine':
      return compareStandard(expected, received, true);
    case 'precision':
      return comparePrecision(expected, received, eps);
    default:
      return compareStandard(expected, received, false);
  }
}

export function compareStrings(expected: string, received: string, mode: CompareMode, eps = 1e-6): CompareResult {
  return compareBuffers(Buffer.from(expected), Buffer.from(received), mode, eps);
}

export async function compareFiles(expectedFile: string, receivedFile: string, mode: CompareMode, eps = 1e-6): Promise<CompareResult> {
  const [e, r] = await Promise.all([fsp.readFile(expectedFile).catch(() => Buffer.alloc(0)), fsp.readFile(receivedFile).catch(() => Buffer.alloc(0))]);
  return compareBuffers(e, r, mode, eps);
}

/** True when an expected answer is effectively empty (=> no verdict, just show the output). */
export function isBlank(buf: Buffer | string): boolean {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8', 0, Math.min(buf.length, 4096));
  if (s.trim() !== '') return false;
  return typeof buf === 'string' || buf.length <= 4096 || buf.toString('utf8').trim() === '';
}
