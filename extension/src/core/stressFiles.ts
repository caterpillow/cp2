// Stress folder layout: autofill for the sus / brute / gen pickers and the "Set up" plan
// (x.cpp -> x/x.cpp + xbrute.cpp + gen.cpp).

import * as path from 'path';
import { exists, isDir, isExecutableFile, statOrNull } from './fsutil';
import { isSourceFile, stemOf } from './lang';
import type { StressPicks } from './store';

export type Role = 'sus' | 'brute' | 'gen';

export interface Slot {
  value: string;
  /** Filled in automatically rather than picked by hand. */
  auto: boolean;
}

const GEN = /^gen/i;
const BRUTE = /brute|naive|slow/i;
const HELPER = /^(checker|judge|interactor|validator|grader)/i;

export function isGenName(n: string): boolean {
  return GEN.test(n);
}

/** Not a gen, brute, checker, judge, …: a name a solution would have. */
export function plain(n: string): boolean {
  return !GEN.test(n) && !BRUTE.test(n) && !HELPER.test(n);
}

/** Picks (sus, brute, gen) for a folder: saved choices win, otherwise guess from the names. */
export function autofill(dir: string, files: string[], activeFile: string | null, picks: StressPicks): Record<Role, Slot> {
  const srcs = files.filter(isSourceFile);
  const has = (n: string | undefined): n is string => !!n && srcs.includes(n);
  const dirName = path.basename(dir);
  const exts = ['.cpp', '.cc', '.py', '.c'];
  const activeName = activeFile && path.dirname(activeFile) === dir ? path.basename(activeFile) : null;

  let sus: Slot;
  if (has(picks.sus)) sus = { value: picks.sus, auto: false };
  else {
    const byDir = exts.map((e) => dirName + e).find((n) => srcs.includes(n));
    const v = byDir ?? (activeName && plain(activeName) && srcs.includes(activeName) ? activeName : srcs.find(plain)) ?? '';
    sus = { value: v, auto: true };
  }

  let brute: Slot;
  if (has(picks.brute)) brute = { value: picks.brute, auto: false };
  else {
    const stem = sus.value ? stemOf(sus.value) : dirName;
    const v = exts.map((e) => `${stem}brute${e}`).find((n) => srcs.includes(n)) ?? srcs.find((n) => BRUTE.test(n) && n !== sus.value) ?? '';
    brute = { value: v, auto: true };
  }

  let gen: Slot;
  if (has(picks.gen)) gen = { value: picks.gen, auto: false };
  else {
    const v = ['gen.cpp', 'gen.py', 'gen.cc', 'gen.c'].find((n) => srcs.includes(n)) ?? srcs.find((n) => GEN.test(n)) ?? '';
    gen = { value: v, auto: true };
  }
  return { sus, brute, gen };
}

export interface SetupPlan {
  error?: string;
  /** Folder the stress files live in. */
  targetDir: string;
  /** Final location of the solution. */
  susTarget: string;
  needMove: boolean;
  /** An old compiled binary named like the folder that has to go first. */
  removeExecutable?: string;
  createGen?: string;
  createBrute?: string;
  /** Graders/headers to copy along (compile-with files). */
  copy: [string, string][];
}

export async function planSetup(file: string, mode: 'wa' | 're', compileWith: string[], genExt: string): Promise<SetupPlan> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const stem = stemOf(file);
  const ext = path.extname(file);
  const inOwnFolder = path.basename(dir) === stem;
  const targetDir = inOwnFolder ? dir : path.join(dir, stem);
  const susTarget = path.join(targetDir, base);
  const plan: SetupPlan = { targetDir, susTarget, needMove: !inOwnFolder, copy: [] };

  if (!inOwnFolder) {
    const st = await statOrNull(targetDir);
    if (st?.isFile()) {
      if (await isExecutableFile(targetDir)) plan.removeExecutable = targetDir;
      else return { ...plan, error: `"${stem}" already exists here and isn't a compiled program, so the folder can't be created` };
    } else if (st?.isDirectory() && (await exists(susTarget))) {
      return { ...plan, error: `${stem}/${base} already exists` };
    }
    for (const f of compileWith) {
      const src = path.join(dir, f);
      const dst = path.join(targetDir, f);
      if ((await exists(src)) && !(await exists(dst))) plan.copy.push([src, dst]);
    }
  }

  const existing = (await isDir(targetDir)) ? await listNames(targetDir) : [];
  if (!existing.some((n) => GEN.test(n) && isSourceFile(n))) plan.createGen = path.join(targetDir, `gen${genExt}`);
  if (mode === 'wa' && !existing.some((n) => BRUTE.test(n) && isSourceFile(n))) plan.createBrute = path.join(targetDir, `${stem}brute${ext}`);
  return plan;
}

async function listNames(dir: string): Promise<string[]> {
  const fsp = await import('fs/promises');
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Minimal generator used when no gen template is configured. */
export function defaultGen(ext: string): string {
  if (ext === '.py') return 'import random, sys\n\nrandom.seed()\nn = random.randint(1, 10)\nprint(n)\nprint(*[random.randint(1, 10) for _ in range(n)])\n';
  return [
    '#include <bits/stdc++.h>',
    'using namespace std;',
    '',
    'mt19937 rng(chrono::steady_clock::now().time_since_epoch().count());',
    'int gen(int l, int r) { return uniform_int_distribution<int>(l, r)(rng); }',
    '',
    'int main() {',
    '    int n = gen(1, 10);',
    '    cout << n << "\\n";',
    '    for (int i = 0; i < n; i++) cout << gen(1, 10) << " \\n"[i == n - 1];',
    '}',
    '',
  ].join('\n');
}
