// Detects plain-text test files in a folder: `in`, `in3`, `a.in`, `a-in.txt`, `wormin.txt`, ...
// and pairs each with an expected-output file (`ans`, `out`, `a.ans`, `a-out.txt`, ...).

import { naturalCompare } from './fsutil';
import { stemOf } from './lang';

export interface FileCaseMatch {
  /** Input file name. */
  input: string;
  /** Matched expected-output file name, or null when none exists. */
  expected: string | null;
  /** Preferred name for creating the expected file when it's missing. */
  expectedCandidate: string;
}

const NOT_INPUT_EXT = /\.(cpp|cc|cxx|c|h|hpp|py|java|rs|go|js|ts|kt|exe|o|obj|bin|gch|json|md|pdf|png|jpe?g|gif|zip|gz|tar|sh|prob)$/i;

// "<pre><in|input><digits?><.txt?>" where <pre> is empty or ends with '.', '-' or '_'.
const SEPARATED = /^(?<pre>(?:.*[._-])?)(?<tok>in|input)(?<post>\d*(?:\.txt)?)$/i;
// AIO style "<name>in.txt" (no separator); only trusted when a source or the out file shares the name.
const GLUED = /^(?<pre>[a-z][a-z0-9]*?)(?<tok>in)(?<post>\.txt)$/i;

const OUT_TOKENS: Record<string, string[]> = {
  in: ['ans', 'out', 'output', 'expected', 'answer'],
  input: ['output', 'answer', 'ans', 'out', 'expected'],
};

function matchCase(tok: string, cand: string): string {
  if (tok === tok.toUpperCase()) return cand.toUpperCase();
  return cand;
}

/** Pure matcher over the file names of one folder. */
export function matchFileCases(fileNames: string[]): FileCaseMatch[] {
  const lower = new Map<string, string>();
  for (const n of fileNames) lower.set(n.toLowerCase(), n);
  const stems = new Set(fileNames.filter((n) => /\.(cpp|cc|cxx|c|py)$/i.test(n)).map((n) => stemOf(n).toLowerCase()));
  const out: FileCaseMatch[] = [];
  for (const name of fileNames) {
    if (NOT_INPUT_EXT.test(name) || name.startsWith('.')) continue;
    let m = name.match(SEPARATED);
    let glued = false;
    if (!m) {
      m = name.match(GLUED);
      glued = true;
    }
    if (!m?.groups) continue;
    const { pre, tok, post } = m.groups;
    const cands = OUT_TOKENS[tok.toLowerCase()].map((c) => pre + matchCase(tok, c) + post);
    const expected = cands.map((c) => lower.get(c.toLowerCase())).find((x) => x !== undefined) ?? null;
    if (glued && !expected && !stems.has(pre.toLowerCase())) continue;
    out.push({ input: name, expected, expectedCandidate: cands[0] });
  }
  return out.sort((a, b) => naturalCompare(a.input, b.input));
}
