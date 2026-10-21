// Picking the samples inside a selection of a PDF that holds several problems: the selected (or copied) text is
// located in the statement's own text, and only samples whose input block falls in that region are kept.

/** Where each sample's input block is in the PDF's text (squashed coordinates), for matching selections. */
export interface PdfIndex {
  text: string;
  /** Per sample (same order as the tests): from its "Sample Input" heading to its last line. */
  spans: [number, number][];
}

/** Text as compared here: compatibility forms (ligatures, full-width digits) folded, whitespace removed. */
export function squash(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

/**
 * Where `selection` is in the squashed document text, or null if it isn't part of it. Viewers copy text in their
 * own order and spelling (columns side by side, hyphenation, symbols), so when it isn't found as a whole, pieces
 * near both ends anchor the region; pieces that occur only once win (sample data repeats a lot).
 */
export function locate(doc: string, selection: string): [number, number] | null {
  const s = squash(selection);
  if (s.length < 6) return null;
  const exact = doc.indexOf(s);
  if (exact >= 0 && doc.indexOf(s, exact + 1) < 0) return [exact, exact + s.length];
  const k = Math.min(16, Math.floor(s.length / 2));
  // Start: the first piece (from the selection's start) found exactly once; else the first one found at all.
  let start = -1;
  let fallback = -1;
  for (let i = 0; i + k <= s.length; i += 3) {
    const at = doc.indexOf(s.slice(i, i + k));
    if (at < 0) continue;
    if (doc.indexOf(s.slice(i, i + k), at + 1) < 0) {
      start = Math.max(0, at - i);
      break;
    }
    if (fallback < 0) fallback = Math.max(0, at - i);
  }
  if (start < 0) start = fallback;
  if (start < 0) return null;
  // End: likewise from the selection's end, after the start.
  let end = -1;
  for (let j = s.length; j - k >= 0; j -= 3) {
    const piece = s.slice(j - k, j);
    const at = doc.indexOf(piece, start);
    if (at < 0) continue;
    const e = Math.min(doc.length, at + k + (s.length - j));
    if (doc.indexOf(piece, at + 1) < 0) return [start, e];
    if (end < 0) end = e;
  }
  return [start, end >= 0 ? end : Math.min(doc.length, start + s.length)];
}

/**
 * Indices of the samples a selection covers; null when the selection isn't from this PDF (or is empty), so
 * everything should be imported. An empty list: it's from this PDF but holds no samples.
 */
export function samplesInSelection(index: PdfIndex, selection: string): number[] | null {
  const r = locate(index.text, selection);
  if (!r) return null;
  return index.spans.flatMap(([a, b], i) => (a < r[1] && b > r[0] ? [i] : []));
}
