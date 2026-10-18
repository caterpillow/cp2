// Reads test cases from the original CPH extension's `.cph/.<file>_<md5>.prob` files.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface LegacyProblem {
  name?: string;
  url?: string;
  timeLimit?: number;
  interactive?: boolean;
  local?: boolean;
  srcPath?: string;
  tests: { input: string; output: string }[];
}

function probName(file: string): string {
  const hash = crypto.createHash('md5').update(file).digest('hex');
  return `.${path.basename(file)}_${hash}.prob`;
}

/** Exact CPH location first; if the folder moved since, any `.prob` for a file of the same name. */
export async function findLegacyProb(file: string, saveLocation?: string): Promise<string | null> {
  const dirs = [path.join(path.dirname(file), '.cph')];
  if (saveLocation) dirs.unshift(saveLocation);
  for (const d of dirs) {
    const exact = path.join(d, probName(file));
    try {
      await fsp.access(exact);
      return exact;
    } catch {
      /* fall through */
    }
  }
  const prefix = `.${path.basename(file)}_`;
  for (const d of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(d);
    } catch {
      continue;
    }
    const cands = names.filter((n) => n.startsWith(prefix) && n.endsWith('.prob') && /^[0-9a-f]{32}\.prob$/.test(n.slice(prefix.length)));
    if (!cands.length) continue;
    let best: { p: string; t: number } | null = null;
    for (const n of cands) {
      const p = path.join(d, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
    }
    if (best) return best.p;
  }
  return null;
}

export async function readLegacyProb(p: string): Promise<LegacyProblem | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(p, 'utf8'));
    const tests = Array.isArray(raw.tests)
      ? raw.tests.map((t: { input?: unknown; output?: unknown }) => ({ input: String(t.input ?? ''), output: String(t.output ?? '') }))
      : [];
    return { name: raw.name, url: raw.url, timeLimit: raw.timeLimit, interactive: raw.interactive, local: raw.local, srcPath: raw.srcPath, tests };
  } catch {
    return null;
  }
}
