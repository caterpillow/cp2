// Best-effort sample extraction from PDF statements (oj.uz, ORAC, QOJ, ...).
//
// Text items come from pdf.js with positions and a monospace flag. Lines are rebuilt from
// y-coordinates and split into columns at wide gaps. "Sample Input 1" / "Sample Output 1"
// headings (side by side or stacked) start a block; the block is the monospace text under the
// heading, within the heading's column, until the next non-monospace text or heading.

import type { SampleTest } from '../../../shared/protocol';

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mono: boolean;
}

export interface PdfPage {
  items: PdfItem[];
  width: number;
  height: number;
}

interface Seg {
  page: number;
  x: number;
  x2: number;
  y: number;
  h: number;
  text: string;
  mono: boolean;
}

type Kind = 'in' | 'out';

const HEADING: [RegExp, Kind][] = [
  [/^(?:sample|example)s?\s*(?:test\s*)?(?:#?\d+\s*)?(?:input|in)\s*#?\s*(\d+)?\s*:?$/i, 'in'],
  [/^(?:sample|example)s?\s*(?:test\s*)?(?:#?\d+\s*)?(?:output|out)\s*#?\s*(\d+)?\s*:?$/i, 'out'],
  [/^(?:sample\s+)?output\s+for\s+sample\s+input\s*(\d+)?$/i, 'out'],
  [/^(?:standard\s+input|stdin|input\.txt)$/i, 'in'],
  [/^(?:standard\s+output|stdout|output\.txt)$/i, 'out'],
  [/^(?:入力例|输入样例|样例输入|입력\s*예제|예제\s*입력)\s*#?\s*(\d+)?\s*:?$/, 'in'],
  [/^(?:出力例|输出样例|样例输出|출력\s*예제|예제\s*출력)\s*#?\s*(\d+)?\s*:?$/, 'out'],
];

function classify(text: string): { kind: Kind; num?: number } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const [re, kind] of HEADING) {
    const m = t.match(re);
    if (m) {
      const n = t.match(/(\d+)\D*$/);
      return { kind, num: n ? Number(n[1]) : undefined };
    }
  }
  return null;
}

/** Rebuilds text segments (runs of items on one line without a wide gap). */
function segments(pages: PdfPage[]): Seg[] {
  const out: Seg[] = [];
  pages.forEach((pg, pi) => {
    const items = pg.items.filter((i) => i.str.length > 0 && i.h > 0).sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: PdfItem[][] = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l[0].y - it.y) <= Math.max(1.5, 0.45 * Math.max(l[0].h, it.h)));
      if (line) line.push(it);
      else lines.push([it]);
    }
    for (const line of lines) {
      line.sort((a, b) => a.x - b.x);
      let cur: { items: PdfItem[] } | null = null;
      const flush = () => {
        if (!cur) return;
        const its = cur.items;
        let text = '';
        let end = its[0].x;
        for (const it of its) {
          const blank = !it.str.trim();
          const gap = it.x - end;
          const charW = blank ? it.h * 0.5 : it.w / it.str.length;
          if (text && gap > 0.15 * it.h && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' '.repeat(it.mono ? Math.max(1, Math.round(gap / Math.max(charW, 0.1))) : 1);
          text += blank ? ' ' : it.str;
          // Whitespace items can be huge (tabs between columns): they don't extend the segment.
          if (!blank) end = Math.max(end, it.x + it.w);
        }
        const nonSpace = its.filter((i) => i.str.trim());
        const monoChars = nonSpace.filter((i) => i.mono).reduce((s, i) => s + i.str.length, 0);
        const allChars = nonSpace.reduce((s, i) => s + i.str.length, 0);
        out.push({ page: pi, x: its[0].x, x2: end, y: its[0].y, h: Math.max(...its.map((i) => i.h)), text: text.replace(/\s+$/, ''), mono: allChars > 0 && monoChars * 2 >= allChars });
        cur = null;
      };
      let lastEnd = -Infinity;
      for (const it of line) {
        const blank = !it.str.trim();
        if (cur && !blank && it.x - lastEnd > 2.2 * Math.max(it.h, 6)) flush();
        if (!cur) {
          if (blank) continue;
          cur = { items: [] };
        }
        cur.items.push(it);
        if (!blank) lastEnd = Math.max(lastEnd, it.x + it.w);
      }
      flush();
    }
  });
  // reading order: page, then top to bottom, then left to right
  return out.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

export function samplesFromPdfPages(pages: PdfPage[]): SampleTest[] {
  const segs = segments(pages).filter((s) => s.text.trim());
  const heads = segs.map((s, i) => ({ s, i, c: classify(s.text) })).filter((h) => h.c) as { s: Seg; i: number; c: { kind: Kind; num?: number } }[];
  const anyMono = segs.some((s) => s.mono);
  const ins: { num?: number; text: string }[] = [];
  const outs: { num?: number; text: string }[] = [];
  for (const h of heads) {
    const sameLine = heads.filter((o) => o !== h && o.s.page === h.s.page && Math.abs(o.s.y - h.s.y) < h.s.h);
    const left = Math.max(-Infinity, ...sameLine.filter((o) => o.s.x < h.s.x).map((o) => o.s.x2)) + 1;
    const right = Math.min(Infinity, ...sameLine.filter((o) => o.s.x > h.s.x).map((o) => o.s.x)) - 1;
    const lines = new Map<number, Seg[]>();
    let lastY = h.s.y;
    for (let j = h.i + 1; j < segs.length; j++) {
      const s = segs[j];
      if (s.page !== h.s.page) break;
      if (Math.abs(s.y - h.s.y) < h.s.h) continue; // the heading line itself
      if (classify(s.text)) break;
      const inCol = s.x >= left - 2 && s.x < right;
      if (anyMono) {
        if (!s.mono) break;
      } else if (inCol) {
        // No monospace fonts at all: stop at a big vertical gap or a line that reads like prose.
        if (lastY - s.y > 3 * s.h || (s.text.length > 50 && /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(s.text))) break;
      }
      if (!inCol) continue;
      const key = Math.round(s.y);
      const near = [...lines.keys()].find((k) => Math.abs(k - s.y) < s.h * 0.45);
      const k = near ?? key;
      lines.set(k, [...(lines.get(k) ?? []), s]);
      lastY = s.y;
    }
    if (!lines.size) continue;
    const text =
      [...lines.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, ss]) =>
          ss
            .sort((a, b) => a.x - b.x)
            .map((x) => x.text)
            .join(' ')
            .replace(/\s+$/, ''),
        )
        .join('\n') + '\n';
    (h.c.kind === 'in' ? ins : outs).push({ num: h.c.num, text });
  }
  if (!ins.length) return [];
  const numbered = ins.every((x) => x.num !== undefined) && new Set(ins.map((x) => x.num)).size === ins.length;
  return ins.map((i, k) => ({ input: i.text, output: (numbered ? outs.find((o) => o.num === i.num) : outs[k])?.text ?? '' }));
}

/** Minimal shape of the pdf.js module we use (so this file doesn't import it). */
export interface PdfJs {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean; useSystemFonts?: boolean }): { promise: Promise<any> };
}

export async function pdfPages(pdfjs: PdfJs, data: Uint8Array, maxPages = 30): Promise<PdfPage[]> {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const pages: PdfPage[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const styles = tc.styles ?? {};
    const items: PdfItem[] = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const fam = String(styles[it.fontName]?.fontFamily ?? '');
      const t = it.transform as number[];
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: Math.hypot(t[2], t[3]) || it.height || 10, mono: /monospace|mono|courier|consol|typewriter|cmtt/i.test(fam) });
    }
    pages.push({ items, width: vp.width, height: vp.height });
  }
  await doc.destroy?.();
  return pages;
}

export async function samplesFromPdf(pdfjs: PdfJs, data: Uint8Array): Promise<SampleTest[]> {
  return samplesFromPdfPages(await pdfPages(pdfjs, data));
}
