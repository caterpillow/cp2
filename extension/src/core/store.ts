// The .cp2 store: one folder per source file mirroring the workspace tree.
//
//   .cp2/
//     .gitignore            "*"  (keeps it out of git and out of search / Ctrl+P)
//     cases/<rel>/problem.json   name, binding, settings, order, pins
//     cases/<rel>/<id>.in|.ans   one pair per stored case
//     dirs/<relDir>/dir.json     stress pickers etc. for a folder
//     index.json                 problem bindings, verdicts, pending contests
//     build/  runs/              compile cache and scratch space

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { CfKind, Site } from '../../../shared/problemId';
import type { VerdictStatus } from '../../../shared/protocol';
import { atomicWrite, exists, mkdirp, movePath, randomId, readJson, readText } from './fsutil';
import { findLegacyProb, readLegacyProb } from './legacy';

export const STORE_DIR = '.cp2';

export type CompareMode = 'standard' | 'firstLine' | 'precision' | 'checker';

export interface ProblemSettings {
  compare: CompareMode;
  precision: number;
  /** File name (relative to the source's folder) of the custom checker. */
  checker: string;
  interactive: boolean;
  /** File name of the interactive judge. */
  judge: string;
  /** How the judge receives the test: prepended to its stdin, or as argv[1] (testlib style). */
  judgeInput: 'stdin' | 'argv';
  /** Other files in the folder compiled/linked with this one (graders, headers). */
  compileWith: string[];
  /** Compile with judge-like flags (-O2, no sanitizers). */
  judgeFlags: boolean;
  timeLimitMs?: number;
}

export const DEFAULT_SETTINGS: ProblemSettings = {
  compare: 'standard',
  precision: 1e-6,
  checker: 'checker.cpp',
  interactive: false,
  judge: 'judge.cpp',
  judgeInput: 'stdin',
  compileWith: [],
  judgeFlags: false,
};

export interface Binding {
  site: Site;
  contestId: string;
  taskId: string;
  index?: string;
  url: string;
  cfKind?: CfKind;
  groupId?: string;
}

export interface VerdictState {
  status: VerdictStatus;
  text: string;
  short?: string;
  at: number;
  url?: string;
  submissionId?: string;
  everAccepted: boolean;
}

export type CaseOrigin = 'manual' | 'imported';

export interface StoredCase {
  id: string;
  origin: CaseOrigin;
  /** Sample number for imported cases (1-based). */
  sample?: number;
}

export interface ProblemMeta {
  version: 1;
  name?: string;
  binding?: Binding;
  memoryLimitMb?: number;
  settings: ProblemSettings;
  cases: StoredCase[];
  /** Display order of case keys ("s:<id>" stored, "f:<name>" text-file cases). */
  order: string[];
  pinned: string[];
  /** Text-file cases (input file names) shown in the sidebar; the folder's other matches are only listed under Files. */
  shownFiles: string[];
  verdict?: VerdictState;
  /** Where the snippet's $0 was, so the first open puts the cursor there. */
  snippetCursor?: { line: number; character: number };
  /** Samples were auto-imported when the problem tab was first visited. */
  autoImported?: boolean;
  legacy?: string;
}

export function emptyMeta(): ProblemMeta {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, cases: [], order: [], pinned: [], shownFiles: [] };
}

/** The parts of a problem that undo / redo restore. */
export interface ListState {
  cases: StoredCase[];
  order: string[];
  pinned: string[];
  shownFiles: string[];
}

/** Files of deleted cases are kept this long, so undo can bring the cases back (also from another window). */
const TRASH_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** "Sample 2" / "Case 3" as the sidebar shows it. */
export function caseLabel(meta: ProblemMeta, id: string): string {
  const c = meta.cases.find((x) => x.id === id);
  if (!c) return 'a case';
  if (c.origin === 'imported') return `Sample ${c.sample ?? ''}`.trim();
  return `Case ${meta.cases.filter((x) => x.origin === 'manual').findIndex((x) => x.id === id) + 1}`;
}

export const storedKey = (id: string) => `s:${id}`;
export const fileKey = (name: string) => `f:${name}`;
export const isStoredKey = (k: string) => k.startsWith('s:');
export const isFileKey = (k: string) => k.startsWith('f:');
export const keyId = (k: string) => k.slice(2);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** One .cp2 folder. */
export class Store {
  readonly root: string;

  constructor(readonly base: string) {
    this.root = path.join(base, STORE_DIR);
  }

  rel(abs: string): string {
    return toPosix(path.relative(this.base, abs));
  }

  abs(rel: string): string {
    return path.join(this.base, ...rel.split('/'));
  }

  problemDir(file: string): string {
    return path.join(this.root, 'cases', ...this.rel(file).split('/'));
  }

  dirMetaFile(dir: string): string {
    const r = this.rel(dir);
    return path.join(this.root, 'dirs', ...(r ? r.split('/') : []), 'dir.json');
  }

  get buildRoot(): string {
    return path.join(this.root, 'build');
  }

  get runsRoot(): string {
    return path.join(this.root, 'runs');
  }

  get indexFile(): string {
    return path.join(this.root, 'index.json');
  }

  private ensured = false;

  async ensure(): Promise<void> {
    if (this.ensured) return;
    await mkdirp(this.root);
    const gi = path.join(this.root, '.gitignore');
    if (!(await exists(gi))) await atomicWrite(gi, '# cp2 data: test cases, build cache\n*\n');
    const v = path.join(this.root, 'version');
    if (!(await exists(v))) await atomicWrite(v, '1\n');
    this.ensured = true;
  }
}

/** Finds which .cp2 a file belongs to: nearest ancestor that has one, else its workspace root. */
export class StoreLocator {
  private byDir = new Map<string, string>();
  private stores = new Map<string, Store>();

  constructor(private workspaceRoots: () => string[]) {}

  async storeFor(file: string): Promise<Store> {
    const base = await this.baseFor(path.dirname(file));
    let s = this.stores.get(base);
    if (!s) {
      s = new Store(base);
      this.stores.set(base, s);
    }
    return s;
  }

  private async baseFor(dir: string): Promise<string> {
    const cached = this.byDir.get(dir);
    if (cached) return cached;
    const roots = this.workspaceRoots().map((r) => path.resolve(r));
    const owner = roots.filter((r) => dir === r || dir.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
    let cur = dir;
    let found: string | undefined;
    for (;;) {
      if (await exists(path.join(cur, STORE_DIR))) {
        found = cur;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const base = found ?? owner ?? dir;
    this.byDir.set(dir, base);
    return base;
  }

  allStores(): Store[] {
    return [...this.stores.values()];
  }

  clearCache(): void {
    this.byDir.clear();
  }
}

/** Test case metadata + text files for one source file. */
export class Problem {
  private saveTimer: NodeJS.Timeout | undefined;
  private materialized = false;
  readonly dir: string;

  private constructor(
    public file: string,
    public store: Store,
    public meta: ProblemMeta,
  ) {
    this.dir = store.problemDir(file);
  }

  static async load(file: string, store: Store, legacySaveLocation?: string): Promise<Problem> {
    const dir = store.problemDir(file);
    const raw = await readJson<ProblemMeta>(path.join(dir, 'problem.json'));
    if (raw) {
      const p = new Problem(file, store, normalizeMeta(raw));
      p.materialized = true;
      void p.emptyTrash(TRASH_MAX_AGE_MS);
      return p;
    }
    const p = new Problem(file, store, emptyMeta());
    const legacy = await findLegacyProb(file, legacySaveLocation);
    if (legacy) {
      const data = await readLegacyProb(legacy);
      if (data && data.tests.length) {
        for (const t of data.tests) await p.addCase('manual', t.input, t.output);
        p.meta.legacy = legacy;
        await p.flush();
      }
    }
    return p;
  }

  get isMaterialized(): boolean {
    return this.materialized;
  }

  caseFile(id: string, kind: 'in' | 'ans'): string {
    return path.join(this.dir, `${id}.${kind}`);
  }

  private trashFile(id: string, kind: 'in' | 'ans'): string {
    return path.join(this.dir, '.trash', `${id}.${kind}`);
  }

  /** Moves a removed case's files aside (undo brings them back; old ones are cleared on load). */
  private async trashCase(id: string): Promise<void> {
    for (const kind of ['in', 'ans'] as const) {
      const src = this.caseFile(id, kind);
      if (!(await exists(src))) continue;
      const dst = this.trashFile(id, kind);
      await mkdirp(path.dirname(dst));
      await fsp.rename(src, dst);
      const now = new Date();
      await fsp.utimes(dst, now, now).catch(() => undefined);
    }
  }

  private async untrashCase(id: string): Promise<void> {
    for (const kind of ['in', 'ans'] as const) {
      const dst = this.caseFile(id, kind);
      if (!(await exists(dst))) await fsp.rename(this.trashFile(id, kind), dst);
    }
  }

  /** Cases of `cases` that aren't here now and whose files are gone (neither in place nor in the trash). */
  async lostCases(cases: StoredCase[]): Promise<StoredCase[]> {
    const lost: StoredCase[] = [];
    for (const c of cases) {
      if (this.findCase(c.id)) continue;
      for (const kind of ['in', 'ans'] as const) {
        if ((await exists(this.caseFile(c.id, kind))) || (await exists(this.trashFile(c.id, kind)))) continue;
        lost.push(c);
        break;
      }
    }
    return lost;
  }

  async emptyTrash(maxAgeMs: number): Promise<void> {
    const dir = path.join(this.dir, '.trash');
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    let left = names.length;
    for (const n of names) {
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (st && st.mtimeMs >= cutoff) continue;
      await fsp.rm(path.join(dir, n), { force: true }).catch(() => undefined);
      left--;
    }
    if (!left) await fsp.rmdir(dir).catch(() => undefined);
  }

  /** Copy of what undo / redo restore. */
  listState(): ListState {
    const m = this.meta;
    return { cases: m.cases.map((c) => ({ ...c })), order: [...m.order], pinned: [...m.pinned], shownFiles: [...m.shownFiles] };
  }

  /**
   * Restores (part of) an earlier list state. Cases that come back get their files back from the trash; cases that go
   * away are trashed. `shown` adds / removes single names instead of replacing the list, so files shown in the meantime
   * (the stress `in`) stay.
   */
  async applyListState(st: Partial<Omit<ListState, 'shownFiles'>>, shown?: { add: string[]; remove: string[] }): Promise<void> {
    if (st.cases) {
      const now = new Set(this.meta.cases.map((c) => c.id));
      const next = new Set(st.cases.map((c) => c.id));
      await this.store.ensure();
      for (const id of now) if (!next.has(id)) await this.trashCase(id);
      for (const id of next) if (!now.has(id)) await this.untrashCase(id);
      this.meta.cases = st.cases.map((c) => ({ ...c }));
    }
    if (st.order) this.meta.order = [...st.order];
    if (st.pinned) this.meta.pinned = [...st.pinned];
    if (shown) {
      this.meta.shownFiles = this.meta.shownFiles.filter((n) => !shown.remove.includes(n));
      for (const n of shown.add) if (!this.meta.shownFiles.includes(n)) this.meta.shownFiles.push(n);
    }
    this.scheduleSave();
  }

  findCase(id: string): StoredCase | undefined {
    return this.meta.cases.find((c) => c.id === id);
  }

  async addCase(origin: CaseOrigin, input: string, expected: string, where: 'end' | 'top' = 'end', sample?: number): Promise<StoredCase> {
    const c: StoredCase = { id: randomId(8), origin, ...(sample ? { sample } : {}) };
    await this.writeCaseFiles(c.id, input, expected);
    this.meta.cases.push(c);
    if (where === 'top') this.meta.order.unshift(storedKey(c.id));
    else this.meta.order.push(storedKey(c.id));
    this.scheduleSave();
    return c;
  }

  private async writeCaseFiles(id: string, input: string, expected: string): Promise<void> {
    await this.store.ensure();
    await Promise.all([atomicWrite(this.caseFile(id, 'in'), input), atomicWrite(this.caseFile(id, 'ans'), expected)]);
  }

  async writeCaseText(id: string, kind: 'in' | 'ans', text: string): Promise<void> {
    await this.store.ensure();
    await atomicWrite(this.caseFile(id, kind), text);
    this.scheduleSave();
  }

  async readCaseText(id: string, kind: 'in' | 'ans'): Promise<string> {
    return (await readText(this.caseFile(id, kind))) ?? '';
  }

  async deleteCase(id: string): Promise<void> {
    this.meta.cases = this.meta.cases.filter((c) => c.id !== id);
    const k = storedKey(id);
    this.meta.order = this.meta.order.filter((x) => x !== k);
    this.meta.pinned = this.meta.pinned.filter((x) => x !== k);
    await this.trashCase(id);
    this.scheduleSave();
  }

  /** A new manual case from files on disk (generated tests can be big: they never pass through a string). */
  async addCaseFromFiles(input: string, expected: string | null, afterKey?: string): Promise<StoredCase> {
    const c: StoredCase = { id: randomId(8), origin: 'manual' };
    await this.store.ensure();
    await mkdirp(this.dir);
    await fsp.copyFile(input, this.caseFile(c.id, 'in'));
    if (expected) await fsp.copyFile(expected, this.caseFile(c.id, 'ans'));
    else await atomicWrite(this.caseFile(c.id, 'ans'), '');
    this.meta.cases.push(c);
    this.placeAfter(storedKey(c.id), afterKey);
    this.scheduleSave();
    return c;
  }

  private placeAfter(k: string, afterKey?: string): void {
    this.meta.order = this.meta.order.filter((x) => x !== k);
    const i = afterKey ? this.meta.order.indexOf(afterKey) : -1;
    this.meta.order.splice(i < 0 ? this.meta.order.length : i + 1, 0, k);
  }

  /** Clones a case (or any input/expected pair) into a new manual case placed after `afterKey`. */
  async addManualAfter(input: string, expected: string, afterKey?: string): Promise<StoredCase> {
    const c = await this.addCase('manual', input, expected, 'end');
    if (afterKey) this.placeAfter(storedKey(c.id), afterKey);
    return c;
  }

  /**
   * Replaces every imported case with `tests`. The new block takes the old block's place in the
   * order (top of the list on first import); pins carry over by sample number.
   */
  async replaceImported(tests: { input: string; output: string }[]): Promise<void> {
    const old = this.meta.cases.filter((c) => c.origin === 'imported');
    const oldKeys = new Set(old.map((c) => storedKey(c.id)));
    let at = this.meta.order.findIndex((k) => oldKeys.has(k));
    if (at < 0) at = 0;
    const fresh: StoredCase[] = [];
    for (let i = 0; i < tests.length; i++) {
      const c: StoredCase = { id: randomId(8), origin: 'imported', sample: i + 1 };
      await this.writeCaseFiles(c.id, tests[i].input, tests[i].output);
      fresh.push(c);
    }
    const before = this.meta.order.slice(0, at).filter((k) => !oldKeys.has(k));
    const after = this.meta.order.slice(at).filter((k) => !oldKeys.has(k));
    this.meta.order = [...before, ...fresh.map((c) => storedKey(c.id)), ...after];
    const pinOrder = this.meta.pinned.map((k) => {
      if (!oldKeys.has(k)) return k;
      const s = old.find((c) => storedKey(c.id) === k)?.sample;
      const n = fresh.find((c) => c.sample === s);
      return n ? storedKey(n.id) : '';
    });
    this.meta.pinned = pinOrder.filter((k) => k);
    this.meta.cases = [...this.meta.cases.filter((c) => c.origin !== 'imported'), ...fresh];
    for (const c of old) await this.trashCase(c.id);
    this.scheduleSave();
  }

  setPinned(key: string, on: boolean): void {
    this.meta.pinned = this.meta.pinned.filter((k) => k !== key);
    if (on) this.meta.pinned.push(key);
    this.scheduleSave();
  }

  /** `keys` is the full visible order as dragged in the sidebar. */
  reorder(keys: string[]): void {
    const pinned = keys.filter((k) => this.meta.pinned.includes(k));
    const rest = keys.filter((k) => !this.meta.pinned.includes(k));
    const known = new Set(keys);
    this.meta.pinned = [...pinned, ...this.meta.pinned.filter((k) => !known.has(k))];
    this.meta.order = [...rest, ...this.meta.order.filter((k) => !known.has(k) && !this.meta.pinned.includes(k))];
    this.scheduleSave();
  }

  /** Shows or hides a text-file case (hiding also unpins it). */
  showFile(name: string, on: boolean): void {
    if (on) {
      if (!this.meta.shownFiles.includes(name)) this.meta.shownFiles.push(name);
    } else {
      this.meta.shownFiles = this.meta.shownFiles.filter((n) => n !== name);
      const k = fileKey(name);
      this.meta.pinned = this.meta.pinned.filter((x) => x !== k);
    }
    this.scheduleSave();
  }

  updateSettings(patch: Partial<ProblemSettings>): void {
    this.meta.settings = { ...this.meta.settings, ...patch };
    this.scheduleSave();
  }

  /** Nothing worth writing to disk yet. */
  isTrivial(): boolean {
    const m = this.meta;
    return (
      !m.cases.length &&
      !m.pinned.length &&
      !m.shownFiles.length &&
      !m.binding &&
      !m.name &&
      !m.verdict &&
      !m.snippetCursor &&
      JSON.stringify(m.settings) === JSON.stringify(DEFAULT_SETTINGS)
    );
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.materialized && this.isTrivial()) return;
    await this.store.ensure();
    await atomicWrite(path.join(this.dir, 'problem.json'), JSON.stringify(this.meta, null, 1));
    this.materialized = true;
  }

  /** Moves this problem's data after its source file was renamed/moved. */
  async moveTo(newFile: string, newStore: Store): Promise<void> {
    await this.flush();
    const newDir = newStore.problemDir(newFile);
    if (this.materialized && (await exists(this.dir)) && path.resolve(newDir) !== path.resolve(this.dir)) {
      await newStore.ensure();
      if (await exists(newDir)) await fsp.rm(newDir, { recursive: true, force: true });
      await movePath(this.dir, newDir);
    }
    this.file = newFile;
    this.store = newStore;
    (this as { dir: string }).dir = newDir;
  }
}

function normalizeMeta(raw: Partial<ProblemMeta>): ProblemMeta {
  const m = emptyMeta();
  Object.assign(m, raw);
  m.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
  m.cases = Array.isArray(raw.cases) ? raw.cases : [];
  m.order = Array.isArray(raw.order) ? raw.order : [];
  m.pinned = Array.isArray(raw.pinned) ? raw.pinned : [];
  // Before 0.3 every text-file case was shown unless hidden; now they're opt-in. Keep the pinned ones.
  m.shownFiles = Array.isArray(raw.shownFiles) ? raw.shownFiles : m.pinned.filter(isFileKey).map(keyId);
  delete (m as { hiddenFiles?: unknown }).hiddenFiles;
  return m;
}

/**
 * Display order: pinned first (in pin order), then the saved order; keys the order doesn't know
 * yet (new cases / new files) are appended.
 */
export function displayOrder(meta: ProblemMeta, fileKeys: string[]): { key: string; pinned: boolean }[] {
  const all = new Set<string>([...meta.cases.map((c) => storedKey(c.id)), ...fileKeys]);
  const out: { key: string; pinned: boolean }[] = [];
  const seen = new Set<string>();
  for (const k of meta.pinned) if (all.has(k) && !seen.has(k)) out.push({ key: k, pinned: true }), seen.add(k);
  for (const k of meta.order) if (all.has(k) && !seen.has(k)) out.push({ key: k, pinned: false }), seen.add(k);
  for (const c of meta.cases) {
    const k = storedKey(c.id);
    if (!seen.has(k)) out.push({ key: k, pinned: false }), seen.add(k);
  }
  for (const k of fileKeys) if (!seen.has(k)) out.push({ key: k, pinned: false }), seen.add(k);
  return out;
}

// ---------------- per-folder data (stress pickers) ----------------

export interface StressPicks {
  sus?: string;
  brute?: string;
  gen?: string;
}

export interface DirMeta {
  version: 2;
  /** "Generate test case": gen, and brute = the optional answer program. */
  gen: StressPicks;
  wa: StressPicks;
  re: StressPicks;
  /** Index into SHRINK_STEPS for each mode; unset until the slider is moved (then cp2.stress.shrinkSeconds applies). */
  shrink: { wa?: number; re?: number };
  open: { gen: boolean; wa: boolean; re: boolean };
  /** mtime of the `ans` file last written by WA stress (lets RE stress clear it safely). */
  ansFromStress?: number;
}

export const SHRINK_STEPS = [0, 0.2, 0.5, 1, 2, 5, 10];

/** The slider step closest to `seconds`. */
export function shrinkIndex(seconds: number): number {
  let best = 0;
  SHRINK_STEPS.forEach((s, i) => {
    if (Math.abs(s - seconds) < Math.abs(SHRINK_STEPS[best] - seconds)) best = i;
  });
  return best;
}

export function emptyDirMeta(): DirMeta {
  return { version: 2, gen: {}, wa: {}, re: {}, shrink: {}, open: { gen: false, wa: false, re: false } };
}

export async function loadDirMeta(store: Store, dir: string): Promise<DirMeta> {
  const raw = await readJson<Partial<DirMeta>>(store.dirMetaFile(dir));
  const m = emptyDirMeta();
  if (raw) {
    Object.assign(m, raw);
    m.gen = { ...(raw.gen ?? {}) };
    m.wa = { ...(raw.wa ?? {}) };
    m.re = { ...(raw.re ?? {}) };
    m.shrink = { ...(raw.shrink ?? {}) };
    if ((raw.version ?? 1) < 2) {
      // Version 1 saved the old default (0) for every folder: treat it as "never moved".
      if (m.shrink.wa === 0) delete m.shrink.wa;
      if (m.shrink.re === 0) delete m.shrink.re;
      m.version = 2;
    }
    m.open = { gen: false, wa: false, re: false, ...(raw.open ?? {}) };
  }
  return m;
}

export async function saveDirMeta(store: Store, dir: string, meta: DirMeta): Promise<void> {
  await store.ensure();
  await atomicWrite(store.dirMetaFile(dir), JSON.stringify(meta, null, 1));
}

// ---------------- store-wide index ----------------

export interface PendingContest {
  site: Site;
  contestId: string;
  folderRel: string;
  ext: string;
  createdAt: number;
}

export interface IndexData {
  version: 1;
  /** problemKey -> source file (relative to the store base). */
  bindings: Record<string, string>;
  /** source file (relative) -> verdict, so explorer colours load without reading every problem. */
  verdicts: Record<string, VerdictState>;
  pendingContests: PendingContest[];
}

export class StoreIndex {
  data: IndexData = { version: 1, bindings: {}, verdicts: {}, pendingContests: [] };
  private timer: NodeJS.Timeout | undefined;
  private loaded = false;

  constructor(readonly store: Store) {}

  async load(): Promise<this> {
    if (this.loaded) return this;
    const raw = await readJson<Partial<IndexData>>(this.store.indexFile);
    if (raw) {
      this.data.bindings = raw.bindings ?? {};
      this.data.verdicts = raw.verdicts ?? {};
      this.data.pendingContests = raw.pendingContests ?? [];
    }
    this.loaded = true;
    return this;
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.store.ensure();
    await atomicWrite(this.store.indexFile, JSON.stringify(this.data, null, 1));
  }

  renameFile(oldRel: string, newRel: string): void {
    let changed = false;
    for (const [k, v] of Object.entries(this.data.bindings)) {
      if (v === oldRel) {
        this.data.bindings[k] = newRel;
        changed = true;
      }
    }
    if (this.data.verdicts[oldRel]) {
      this.data.verdicts[newRel] = this.data.verdicts[oldRel];
      delete this.data.verdicts[oldRel];
      changed = true;
    }
    if (changed) this.save();
  }
}
