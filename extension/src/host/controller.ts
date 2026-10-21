// The hub: tracks the active source file, runs test cases, and keeps the sidebar in sync.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { compareFiles, isBlank } from '../core/compare';
import { Built, Compiler } from '../core/compiler';
import { Cp2Config } from '../core/config';
import { atomicWrite, exists, readText, sha1, statOrNull } from '../core/fsutil';
import { ManualSession, runChecker, runInteractive } from '../core/interactive';
import { isCompileWithCandidate, isSourceFile, langOf } from '../core/lang';
import { classifyRun, describeExit, runProcess } from '../core/runner';
import { caseLabel, displayOrder, fileKey, isStoredKey, keyId, Problem, ProblemSettings, Store, StoreIndex, StoreLocator, StoredCase, storedKey, swapSamples } from '../core/store';
import type { CaseVM, FromWebview, ResultVM, ToWebview, TranscriptLine, ViewState } from '../../../shared/viewModel';
import { DirIndex, DirListing } from './dirIndex';
import { diffListState, HistoryEntry } from './history';
import { CaseResult, Session } from './session';
import { legacySaveLocation, readConfig } from './settings';
import type { StressHost } from './stressHost';

export type BuildKind = 'debug' | 'judge' | 'stressWA' | 'stressRE' | 'helper';

export interface Poster {
  post(msg: ToWebview): void;
  readonly visible: boolean;
  reveal(): void;
}

/** Hooks implemented by the import / submit / contest modules. */
export interface Extras {
  importButton(problem: Problem): { label: string; title: string; enabled: boolean; note?: string };
  submitButton(problem: Problem): { label: string; title: string; enabled: boolean };
  bridgeConnected(): boolean;
  doImport(file: string): Promise<void>;
  doSubmit(file: string): Promise<void>;
  onVerdictChanged?(file: string): void;
}

export class Controller implements vscode.Disposable {
  readonly locator: StoreLocator;
  readonly dirs = new DirIndex();
  readonly output: vscode.OutputChannel;
  private problems = new Map<string, Promise<Problem>>();
  private sessions = new Map<string, Session>();
  private compilers = new Map<string, Compiler>();
  private indexes = new Map<string, Promise<StoreIndex>>();
  active: string | null = null;
  private settingsOpen = false;
  private renderTimer: NodeJS.Timeout | undefined;
  private rendering = false;
  private renderAgain = false;
  private config: Cp2Config | null = null;
  private disposables: vscode.Disposable[] = [];
  /** Changes to cases run one at a time, in the order the sidebar sent them (an edit flushed right before Ctrl+Z). */
  private mutations: Promise<unknown> = Promise.resolve();
  /** Old path -> new path of source files moved in this session. */
  private movedTo = new Map<string, string>();
  poster: Poster | null = null;
  stress!: StressHost;
  extras: Extras | null = null;

  constructor(readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('cp2');
    this.locator = new StoreLocator(() => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    this.disposables.push(
      this.output,
      this.dirs,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cp2') || e.affectsConfiguration('cph')) {
          this.config = null;
          this.compilers.clear();
          this.requestRender();
        }
      }),
      this.dirs.onDidChange((ch) => {
        for (const s of this.sessions.values()) {
          if (path.dirname(s.file) !== ch.dir) continue;
          for (const n of ch.names) s.invalidateFile(path.join(ch.dir, n));
        }
        if (this.active && path.dirname(this.active) === ch.dir) this.requestRender();
      }),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onEditor(e)),
      vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
    );
  }

  log(msg: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  cfg(): Cp2Config {
    if (!this.config) this.config = readConfig(this.active ? vscode.Uri.file(this.active) : undefined);
    return this.config;
  }

  // ---------------- problems & sessions ----------------

  async storeFor(file: string): Promise<Store> {
    return this.locator.storeFor(file);
  }

  async indexFor(store: Store): Promise<StoreIndex> {
    let p = this.indexes.get(store.root);
    if (!p) {
      p = new StoreIndex(store).load();
      this.indexes.set(store.root, p);
    }
    return p;
  }

  getProblem(file: string): Promise<Problem> {
    let p = this.problems.get(file);
    if (!p) {
      p = (async () => {
        const store = await this.storeFor(file);
        store.sweepTrash().catch((e) => this.log(`trash sweep failed: ${e}`));
        return Problem.load(file, store, legacySaveLocation(vscode.Uri.file(file)));
      })();
      this.problems.set(file, p);
      p.catch(() => this.problems.delete(file));
    }
    return p;
  }

  async getSession(file: string): Promise<Session> {
    let s = this.sessions.get(file);
    if (!s) {
      s = new Session(await this.getProblem(file));
      this.sessions.set(file, s);
    }
    return s;
  }

  sessionIfLoaded(file: string): Session | undefined {
    return this.sessions.get(file);
  }

  compilerFor(store: Store): Compiler {
    let c = this.compilers.get(store.root);
    if (!c) {
      const cfg = this.cfg();
      c = new Compiler({ buildRoot: store.buildRoot, pchRoot: path.join(cfg.cacheDir, 'pch'), pchEnabled: cfg.pch.enabled, pchHeaders: cfg.pch.headers, stackMb: cfg.stackMb, log: (m) => this.log(m) });
      this.compilers.set(store.root, c);
      void c.prune();
    }
    return c;
  }

  async build(file: string, kind: BuildKind, settings?: ProblemSettings): Promise<Built> {
    const cfg = this.cfg();
    const lang = langOf(file);
    const store = await this.storeFor(file);
    const st = settings ?? (await this.getProblem(file)).meta.settings;
    const dir = path.dirname(file);
    const extra: string[] = [];
    for (const n of st.compileWith) {
      const f = path.join(dir, n);
      if (f !== file && (await exists(f))) extra.push(f);
    }
    const lc = lang === 'c' ? cfg.c : cfg.cpp;
    const flags =
      kind === 'debug' ? lc.flags : kind === 'judge' ? lc.judgeFlags : kind === 'stressWA' ? (lang === 'c' ? cfg.c.judgeFlags : cfg.stress.waFlags) : kind === 'stressRE' ? (lang === 'c' ? cfg.c.flags : cfg.stress.reFlags) : lang === 'c' ? cfg.c.judgeFlags : cfg.helperFlags;
    await this.saveIfDirty(file);
    for (const f of extra) await this.saveIfDirty(f);
    return this.compilerFor(store).build({ main: file, extra, compiler: lc.compiler, flags, python: cfg.python });
  }

  async saveIfDirty(file: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (doc?.isDirty) await doc.save();
  }

  limits() {
    const c = this.cfg();
    return { stackMb: c.stackMb, outputLimitMb: c.outputLimitMb };
  }

  timeLimit(p: Problem): number {
    return p.meta.settings.timeLimitMs || this.cfg().timeLimitMs;
  }

  // ---------------- active file ----------------

  private onEditor(e: vscode.TextEditor | undefined): void {
    if (!e || e.document.uri.scheme !== 'file') return;
    const f = e.document.uri.fsPath;
    if (!isSourceFile(f)) return;
    void this.setActive(f, e);
  }

  async setActive(file: string, editor?: vscode.TextEditor): Promise<void> {
    const changed = this.active !== file;
    this.active = file;
    if (changed) this.config = null;
    const s = await this.getSession(file);
    if (changed) s.resetSent();
    if (editor && s.problem.meta.snippetCursor) this.applySnippetCursor(s.problem, editor);
    // Not awaited: setActive also runs inside queued steps (Set up), and this queues a step of its own.
    if (changed) void this.stress.opened(file);
    this.requestRender(0);
  }

  /** First open of a file created from a snippet: put the cursor where $0 was. */
  private applySnippetCursor(p: Problem, editor: vscode.TextEditor): void {
    const c = p.meta.snippetCursor!;
    delete p.meta.snippetCursor;
    p.scheduleSave();
    if (c.line >= editor.document.lineCount) return;
    const pos = new vscode.Position(c.line, c.character);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private onSave(d: vscode.TextDocument): void {
    const f = d.uri.fsPath;
    for (const s of this.sessions.values()) {
      if (f.startsWith(s.problem.dir + path.sep)) {
        s.invalidateFile(f);
        if (s.file === this.active) this.requestRender();
      }
    }
  }

  private moveWaiters = new Map<string, () => void>();

  /** Resolves once the rename event for `newPath` has been handled (or after a timeout). */
  waitForMove(newPath: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.moveWaiters.delete(newPath);
        resolve();
      }, timeoutMs);
      this.moveWaiters.set(newPath, () => {
        clearTimeout(t);
        this.moveWaiters.delete(newPath);
        resolve();
      });
    });
  }

  private async onRename(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      if (oldUri.scheme !== 'file') continue;
      const oldPath = oldUri.fsPath;
      const newPath = newUri.fsPath;
      try {
        const st = await statOrNull(newPath);
        if (st?.isDirectory()) await this.moveFolderData(oldPath, newPath);
        else if (isSourceFile(oldPath)) await this.moveProblem(oldPath, newPath);
      } catch (err) {
        this.log(`moving test data for ${oldPath} failed: ${err}`);
      }
      this.dirs.invalidate(path.dirname(oldPath));
      this.dirs.invalidate(path.dirname(newPath));
      this.moveWaiters.get(newPath)?.();
    }
    this.requestRender();
  }

  sessionsIn(dir: string): Session[] {
    return [...this.sessions.values()].filter((s) => path.dirname(s.file) === dir);
  }

  /** Carry test cases along when a source file is renamed or moved inside VS Code. */
  async moveProblem(oldPath: string, newPath: string): Promise<void> {
    const p = await this.getProblem(oldPath);
    const oldStore = p.store;
    const newStore = await this.storeFor(newPath);
    const oldRel = oldStore.rel(oldPath);
    await p.moveTo(newPath, newStore);
    this.problems.delete(oldPath);
    this.problems.set(newPath, Promise.resolve(p));
    const s = this.sessions.get(oldPath);
    if (s) {
      this.sessions.delete(oldPath);
      this.sessions.set(newPath, s);
    }
    this.movedTo.set(oldPath, newPath);
    this.movedTo.delete(newPath);
    if (oldStore === newStore) (await this.indexFor(oldStore)).renameFile(oldRel, newStore.rel(newPath));
    if (this.active === oldPath) this.active = newPath;
    this.extras?.onVerdictChanged?.(newPath);
  }

  private async moveFolderData(oldDir: string, newDir: string): Promise<void> {
    const store = await this.storeFor(oldDir + path.sep + 'x');
    const oldRel = store.rel(oldDir);
    const newRel = store.rel(newDir);
    for (const sub of ['cases', 'dirs']) {
      const from = path.join(store.root, sub, ...oldRel.split('/'));
      const to = path.join(store.root, sub, ...newRel.split('/'));
      if (await exists(from)) {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to).catch((err) => this.log(`could not move ${from}: ${err}`));
      }
    }
    const idx = await this.indexFor(store);
    for (const [k, v] of Object.entries(idx.data.bindings)) if (v.startsWith(oldRel + '/')) idx.data.bindings[k] = newRel + v.slice(oldRel.length);
    for (const [k, v] of Object.entries(idx.data.verdicts)) {
      if (k.startsWith(oldRel + '/')) {
        idx.data.verdicts[newRel + k.slice(oldRel.length)] = v;
        delete idx.data.verdicts[k];
      }
    }
    idx.save();
    for (const key of [...this.problems.keys(), ...this.sessions.keys()]) if (key.startsWith(oldDir + path.sep)) this.movedTo.set(key, newDir + key.slice(oldDir.length));
    for (const key of [...this.problems.keys()]) if (key.startsWith(oldDir + path.sep)) this.problems.delete(key);
    for (const key of [...this.sessions.keys()]) if (key.startsWith(oldDir + path.sep)) this.sessions.delete(key);
    if (this.active?.startsWith(oldDir + path.sep)) this.active = newDir + this.active.slice(oldDir.length);
  }

  // ---------------- rendering ----------------

  /** Waits for queued case changes (typing sent just before a run). */
  settled(): Promise<void> {
    return this.mutations.then(() => undefined);
  }

  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(fn, fn);
    this.mutations = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs a change to a file's case list as one undo step. Call it inside serial(). Follows moves that happened while
   * the caller was busy (a file that's gone throws instead of conjuring up an empty problem).
   */
  async recordList<T>(file: string, label: string, fn: (p: Problem) => T | Promise<T>): Promise<{ value: T; entry: HistoryEntry | null; file: string }> {
    file = this.currentPath(file);
    if (!(await exists(file))) throw new Error(`${path.basename(file)} was moved or deleted`);
    const s = await this.getSession(file);
    const before = s.problem.listState();
    const value = await fn(s.problem);
    const e = diffListState(label, before, s.problem.listState());
    return { value, entry: e ? s.history.push(e) : null, file };
  }

  /** An import replaced the samples: earlier undo steps now apply to the new ones (and never revert the import). */
  rebaseHistory(file: string, old: StoredCase[], fresh: StoredCase[]): void {
    const s = this.sessions.get(this.currentPath(file));
    if (!s) return;
    const gone = new Set(old.map((c) => c.id));
    s.history.rebase((st) => swapSamples(st, old, fresh), (id) => gone.has(id));
    for (const id of gone) s.results.delete(storedKey(id));
  }

  notice(text: string, action?: 'undo' | 'redo', id?: number): void {
    this.poster?.post({ type: 'notice', text, action, id });
  }

  requestRender(delay = 25): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    if (!this.poster) return;
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    try {
      const state = await this.buildState();
      this.poster.post({ type: 'state', state });
    } catch (e) {
      this.log(`render failed: ${(e as Error).stack ?? e}`);
    } finally {
      this.rendering = false;
      if (this.renderAgain) {
        this.renderAgain = false;
        this.requestRender();
      }
    }
  }

  webviewReady(): void {
    for (const s of this.sessions.values()) {
      s.resetSent();
      s.resetSeqs();
    }
    const s = this.active ? this.sessions.get(this.active) : undefined;
    if (s) this.poster?.post({ type: 'manual', events: s.manualEvents, reset: true });
    this.requestRender(0);
  }

  private emptyState(): ViewState {
    const sec = { open: false, slots: [], shrink: 0, canRun: false, needsSetup: false, running: false };
    const gen = { open: false, slots: [], canRun: false, needsSetup: false, running: false };
    return {
      file: null,
      problem: null,
      compile: { state: 'idle', judgeFlags: false },
      cases: [],
      running: false,
      importBtn: { label: 'Import', title: '', enabled: false },
      submitBtn: { label: 'Submit', title: '', enabled: false },
      stress: { gen, wa: sec, re: sec },
      fileCases: [],
      manual: { visible: false, running: false },
      ui: { settingsOpen: this.settingsOpen },
      warnings: [],
      bridgeConnected: this.extras?.bridgeConnected() ?? false,
    };
  }

  private async buildState(): Promise<ViewState> {
    const file = this.active;
    if (!file) return this.emptyState();
    const s = await this.getSession(file);
    const p = s.problem;
    const meta = p.meta;
    const dir = path.dirname(file);
    const listing = await this.dirs.get(dir);
    const st = meta.settings;
    const store = p.store;
    const shown = new Set(meta.shownFiles);
    const matches = listing.matches.filter((m) => shown.has(m.input));
    const order = displayOrder(meta, matches.map((m) => fileKey(m.input)));
    const cases = (await Promise.all(order.map((o) => this.caseVM(s, o.key, o.pinned, listing)))).filter((c): c is CaseVM => !!c);
    const dirFiles = listing.files.filter(isSourceFile).sort();
    const title = meta.name ?? path.basename(file);
    const warnings: string[] = [];
    if (st.interactive && langOf(file) === 'cpp') {
      const src = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText() ?? (await readText(file)) ?? '';
      if (!/^\s*#\s*define\s+INTERACTIVE\b/m.test(src)) warnings.push("This file doesn't #define INTERACTIVE, so output isn't flushed after each line (Idleness limit exceeded on the judge).");
    }
    const vd = meta.verdict;
    return {
      file: { name: path.basename(file), rel: store.rel(file), path: file, lang: langOf(file) ?? '' },
      problem: {
        title,
        url: meta.binding?.url,
        shortId: meta.binding ? `${meta.binding.site === 'codeforces' ? 'CF' : 'AtCoder'} ${meta.binding.contestId} ${meta.binding.index ?? meta.binding.taskId}` : undefined,
        timeLimitMs: this.timeLimit(p),
        settings: { ...st },
        dirFiles,
        compileCandidates: listing.files.filter((n) => isCompileWithCandidate(n) && n !== path.basename(file)).sort(),
        checkerExists: listing.files.includes(st.checker),
        judgeExists: listing.files.includes(st.judge),
        verdict: vd ? { status: vd.status, text: vd.text, url: vd.url } : undefined,
      },
      compile: { ...s.compile, judgeFlags: st.judgeFlags },
      cases,
      running: s.running,
      importBtn: this.extras?.importButton(p) ?? { label: 'Import', title: 'cp2-bridge not available', enabled: false },
      submitBtn: this.extras?.submitButton(p) ?? { label: 'Submit', title: 'cp2-bridge not available', enabled: false },
      stress: await this.stress.sections(file, listing),
      fileCases: listing.matches.map((m) => ({ name: m.input, expected: m.expected, shown: shown.has(m.input) })),
      manual: { visible: st.interactive, running: !!s.manual?.running, exit: s.manualExit },
      ui: { settingsOpen: this.settingsOpen },
      warnings,
      bridgeConnected: this.extras?.bridgeConnected() ?? false,
    };
  }

  /** Files backing a case: [input, expected or null]. */
  caseFiles(s: Session, key: string, listing: DirListing): { input: string; expected: string | null; candidate?: string } | null {
    const p = s.problem;
    if (isStoredKey(key)) {
      const id = keyId(key);
      if (!p.findCase(id)) return null;
      return { input: p.caseFile(id, 'in'), expected: p.caseFile(id, 'ans') };
    }
    const name = keyId(key);
    const m = listing.matches.find((x) => x.input === name);
    if (!m) return null;
    const dir = path.dirname(s.file);
    return { input: path.join(dir, name), expected: m.expected ? path.join(dir, m.expected) : null, candidate: path.join(dir, m.expectedCandidate) };
  }

  private async caseVM(s: Session, key: string, pinned: boolean, listing: DirListing): Promise<CaseVM | null> {
    const p = s.problem;
    const files = this.caseFiles(s, key, listing);
    if (!files) return null;
    const cfg = this.cfg();
    const interactive = p.meta.settings.interactive;
    let origin: CaseVM['origin'];
    let label: string;
    let fileLabel: string | undefined;
    let stress = false;
    if (isStoredKey(key)) {
      const c = p.findCase(keyId(key))!;
      origin = c.origin;
      label = caseLabel(p.meta, c.id);
    } else {
      origin = 'file';
      const name = keyId(key);
      label = name;
      fileLabel = `${name} → ${files.expected ? path.basename(files.expected) : `${path.basename(files.candidate!)}?`}`;
      stress = name === 'in' && this.stress.isStressDir(path.dirname(s.file));
    }
    const res = this.resultFor(s, key);
    const inline = cfg.inlineBytes;
    // Text-file cases are read-only here: Keep copies them into an editable case.
    const editable = origin !== 'file';
    const input = await s.fileText(`${key}|in`, files.input, inline, editable);
    const expected = interactive ? null : await s.fileText(`${key}|ans`, files.expected, inline, editable, res?.diff?.expectedLine);
    const vm: CaseVM = {
      key,
      origin,
      label,
      files: fileLabel,
      pinned,
      stress,
      input,
      expected,
      expectedMissing: !interactive && origin === 'file' && !files.expected,
      expectedHint: !interactive && origin === 'file' && !files.expected ? `no answer file (${path.basename(files.candidate!)}) — press Keep to make an editable copy` : undefined,
    };
    if (res) vm.result = await this.resultVM(s, key, res);
    return vm;
  }

  /** A case's latest result, preferring a newer stress result for the stress `in` case. */
  resultFor(s: Session, key: string): CaseResult | undefined {
    const own = s.results.get(key);
    if (key === 'f:in') {
      const st = this.stress.caseResult(path.dirname(s.file));
      if (st && (!own || st.at > own.at)) return st;
    }
    return own;
  }

  private async resultVM(s: Session, key: string, r: CaseResult): Promise<ResultVM> {
    const inline = this.cfg().inlineBytes;
    const vm: ResultVM = { verdict: r.verdict, at: r.at, live: r.live, timeMs: r.timeMs, detail: r.detail };
    if (r.outFile) vm.received = await s.fileText(`${key}|out`, r.outFile, inline, false, r.diff?.receivedLine);
    if (r.stderr && r.stderr.trim()) vm.stderr = s.memText(`${key}|err`, r.stderr, inline);
    if (r.debugStderr !== undefined) vm.debug = s.memText(`${key}|dbg`, r.debugStderr || '(no output on stderr)', inline);
    if (r.diff) {
      vm.diffExpected = { line: r.diff.expectedLine, col: r.diff.expectedCol, len: r.diff.expectedLen };
      vm.diffReceived = { line: r.diff.receivedLine, col: r.diff.receivedCol, len: r.diff.receivedLen };
    }
    if (r.transcript) vm.transcript = r.transcript.slice(0, 3000);
    return vm;
  }

  setResult(s: Session, key: string, r: CaseResult): void {
    s.results.set(key, r);
    s.invalidateText(`${key}|out`);
    s.invalidateText(`${key}|err`);
    s.invalidateText(`${key}|dbg`);
    s.invalidateText(`${key}|ans`);
    if (s.file === this.active) this.requestRender();
  }

  // ---------------- running ----------------

  async runAll(file?: string): Promise<void> {
    await this.settled();
    const f = file ?? this.active;
    if (!f) {
      void vscode.window.showInformationMessage('cp2: open a source file first');
      return;
    }
    this.poster?.reveal();
    const s = await this.getSession(f);
    const listing = await this.dirs.get(path.dirname(f));
    const meta = s.problem.meta;
    const matches = listing.matches.filter((m) => meta.shownFiles.includes(m.input));
    const keys = displayOrder(meta, matches.map((m) => fileKey(m.input))).map((o) => o.key);
    await this.runKeys(s, keys);
  }

  async runOne(key: string): Promise<void> {
    await this.settled();
    if (!this.active) return;
    const s = await this.getSession(this.active);
    await this.runKeys(s, [key]);
  }

  stop(): void {
    if (!this.active) return;
    const s = this.sessions.get(this.active);
    s?.abort?.abort();
  }

  private async runKeys(s: Session, keys: string[]): Promise<void> {
    s.abort?.abort();
    const abort = new AbortController();
    s.abort = abort;
    s.running = true;
    const p = s.problem;
    const st = p.meta.settings;
    const kind: BuildKind = st.judgeFlags ? 'judge' : 'debug';
    const now = Date.now();
    for (const k of keys) this.setResult(s, k, { verdict: 'QUEUED', at: now });
    s.compile = { state: 'compiling', judgeFlags: st.judgeFlags };
    this.requestRender(0);
    const sourceMtime = (await statOrNull(s.file))?.mtimeMs ?? 0;
    let built: Built;
    let judge: Built | null = null;
    let checker: Built | null = null;
    try {
      built = await this.build(s.file, kind);
    } catch (e) {
      built = { ok: false, cmd: [], output: String(e), cached: false, timeMs: 0, pch: false, lang: 'cpp' };
    }
    if (abort.signal.aborted) return;
    s.compile = { state: built.ok ? 'ok' : 'error', output: built.output, judgeFlags: st.judgeFlags, pch: built.pch };
    if (!built.ok) {
      for (const k of keys) s.results.delete(k);
      s.running = false;
      s.lastRun = { at: Date.now(), sourceMtime, failed: true, anyRun: false };
      this.requestRender(0);
      return;
    }
    const dir = path.dirname(s.file);
    if (st.interactive) {
      const jf = path.join(dir, st.judge);
      if (await exists(jf)) {
        judge = await this.build(jf, 'helper', p.meta.settings);
        if (!judge.ok) {
          s.compile = { state: 'error', output: `judge ${st.judge} doesn't compile:\n${judge.output}`, judgeFlags: st.judgeFlags };
          s.running = false;
          for (const k of keys) s.results.delete(k);
          this.requestRender(0);
          return;
        }
      }
    } else if (st.compare === 'checker') {
      const cf = path.join(dir, st.checker);
      if (await exists(cf)) {
        checker = await this.build(cf, 'helper');
        if (!checker.ok) {
          s.compile = { state: 'error', output: `checker ${st.checker} doesn't compile:\n${checker.output}`, judgeFlags: st.judgeFlags };
          s.running = false;
          for (const k of keys) s.results.delete(k);
          this.requestRender(0);
          return;
        }
      }
    }
    const listing = await this.dirs.get(dir);
    const queue = [...keys];
    let failed = false;
    let anyRun = false;
    // Deleted (or hidden) while queued or running: no result, and it doesn't count as a failure.
    const gone = (k: string) => (isStoredKey(k) ? !p.findCase(keyId(k)) : !p.meta.shownFiles.includes(keyId(k)));
    const worker = async () => {
      while (queue.length && !abort.signal.aborted) {
        const k = queue.shift()!;
        if (gone(k)) {
          s.results.delete(k);
          continue;
        }
        this.setResult(s, k, { verdict: 'RUNNING', at: Date.now() });
        const r = await this.runCaseWith(s, k, listing, built, judge, checker, abort.signal);
        if (gone(k)) {
          s.results.delete(k);
          continue;
        }
        if (abort.signal.aborted && r.verdict !== 'STOPPED') r.verdict = 'STOPPED';
        if (!['AC', 'RAN', 'NOCHECK', 'STOPPED'].includes(r.verdict)) failed = true;
        anyRun = true;
        this.setResult(s, k, r);
      }
    };
    const conc = st.interactive ? 1 : Math.max(1, this.cfg().runConcurrency);
    await Promise.all(Array.from({ length: conc }, worker));
    if (abort.signal.aborted) for (const k of queue) s.results.delete(k);
    if (s.abort === abort) {
      s.running = false;
      s.abort = null;
    }
    s.lastRun = { at: Date.now(), sourceMtime, failed, anyRun };
    this.requestRender(0);
  }

  runDir(s: Session): string {
    return path.join(s.problem.store.runsRoot, sha1(s.file).slice(0, 12));
  }

  private async runCaseWith(s: Session, key: string, listing: DirListing, built: Built, judge: Built | null, checker: Built | null, signal: AbortSignal): Promise<CaseResult> {
    const p = s.problem;
    const st = p.meta.settings;
    const files = this.caseFiles(s, key, listing);
    if (!files) return { verdict: 'ERR', detail: 'case disappeared', at: Date.now() };
    const dir = path.dirname(s.file);
    const outFile = path.join(this.runDir(s), `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.out`);
    const tl = this.timeLimit(p);
    const limits = this.limits();
    if (st.interactive) {
      if (!judge) return { verdict: 'ERR', detail: `no judge: create ${st.judge} next to this file, or use Manual run`, at: Date.now() };
      const r = await runInteractive({ program: built.cmd, judge: judge.cmd, cwd: dir, testFile: files.input, judgeInput: st.judgeInput, timeLimitMs: tl, limits }, signal);
      await atomicWrite(outFile, r.events.filter((e) => e.kind === 'out').map((e) => e.text).join('\n') + '\n');
      const transcript: TranscriptLine[] = r.events.filter((e) => e.kind !== 'judgeErr').map((e) => ({ k: e.kind as TranscriptLine['k'], t: e.text }));
      const verdict = r.verdict === 'STOPPED' ? 'STOPPED' : r.verdict;
      return { verdict, timeMs: r.timeMs, detail: r.message, outFile, stderr: r.events.filter((e) => e.kind === 'err').map((e) => e.text).join('\n'), transcript, at: Date.now() };
    }
    const r = await runProcess({ cmd: built.cmd, cwd: dir, stdin: { file: files.input }, stdoutFile: outFile, timeLimitMs: tl, limits }, signal);
    const v = classifyRun(r);
    const base = { timeMs: r.timeMs, outFile, stderr: r.stderr, at: Date.now() };
    if (v === 'STOPPED') return { ...base, verdict: 'STOPPED' };
    if (v !== 'OK') return { ...base, verdict: v === 'ERR' ? 'ERR' : v, detail: describeExit(r) };
    return { ...base, ...(await this.judgeOutput(s, files, outFile, checker, r.stderr)) };
  }

  /** Decides a verdict for an output that ran successfully. */
  async judgeOutput(s: Session, files: { input: string; expected: string | null }, outFile: string, checker: Built | null, stderr: string): Promise<Pick<CaseResult, 'verdict' | 'detail' | 'diff'>> {
    const st = s.problem.meta.settings;
    const dir = path.dirname(s.file);
    if (st.compare === 'checker') {
      if (!checker) {
        if (!(await exists(path.join(dir, st.checker)))) return { verdict: 'NOCHECK', detail: `${st.checker} doesn't exist yet` };
        checker = await this.build(path.join(dir, st.checker), 'helper');
        if (!checker.ok) return { verdict: 'ERR', detail: `checker doesn't compile` };
      }
      const c = await runChecker(checker.cmd, dir, files.input, outFile, files.expected, this.limits());
      if (c.error) return { verdict: 'ERR', detail: c.message };
      return { verdict: c.pass ? 'AC' : 'WA', detail: c.message };
    }
    const expectedBuf = files.expected ? await fsp.readFile(files.expected).catch(() => null) : null;
    if (!expectedBuf || isBlank(expectedBuf)) return { verdict: 'RAN' };
    const cmp = await compareFiles(files.expected!, outFile, st.compare, st.precision);
    if (cmp.pass && !this.cfg().ignoreStderr && stderr.trim()) return { verdict: 'WA', detail: 'stderr is not empty (cp2.ignoreStderr is off)' };
    return { verdict: cmp.pass ? 'AC' : 'WA', detail: cmp.pass ? undefined : cmp.message, diff: cmp.diff };
  }

  /** Re-judge existing outputs after the comparison mode changes (no rerun needed). */
  private async rejudge(s: Session): Promise<void> {
    const listing = await this.dirs.get(path.dirname(s.file));
    for (const [k, r] of s.results) {
      if (!r.outFile || r.transcript || !['AC', 'WA', 'RAN', 'NOCHECK'].includes(r.verdict)) continue;
      const files = this.caseFiles(s, k, listing);
      if (!files) continue;
      const j = await this.judgeOutput(s, files, r.outFile, null, r.stderr ?? '');
      this.setResult(s, k, { ...r, ...j, diff: j.diff, at: r.at });
    }
  }

  // ---------------- webview messages ----------------

  async onMessage(m: FromWebview): Promise<void> {
    const file = this.active;
    switch (m.type) {
      case 'ready':
        return this.webviewReady();
      case 'runAll':
        return this.runAll();
      case 'runCase':
        return this.runOne(m.key);
      case 'stop':
        return this.stop();
      case 'toggleSettings':
        this.settingsOpen = m.open;
        return this.requestRender();
      case 'openUrl':
        void vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'import':
        if (file) await this.extras?.doImport(file);
        return;
      case 'submit':
        if (file) await this.extras?.doSubmit(file);
        return;
      case 'stressPick':
      case 'stressRun':
      case 'stressStop':
      case 'stressSetup':
      case 'stressShrink':
      case 'stressOpen':
      case 'stressSetting':
        if (file) await this.stress.onMessage(file, m);
        return;
      case 'genCase':
        if (file) await this.stress.genCase(file);
        return;
    }
    if (!file) return;
    switch (m.type) {
      case 'addCase':
      case 'deleteCase':
      case 'hideCase':
      case 'showFiles':
      case 'edit':
      case 'pin':
      case 'reorder':
      case 'keep':
      case 'undo':
      case 'redo':
        return this.serial(() => this.mutate(m, file));
    }
    const s = await this.getSession(file);
    const p = s.problem;
    const listing = await this.dirs.get(path.dirname(file));
    switch (m.type) {
      case 'open': {
        const files = this.caseFiles(s, m.key, listing);
        const r = s.results.get(m.key) ?? this.resultFor(s, m.key);
        let target: string | null = null;
        if (m.field === 'in') target = files?.input ?? null;
        else if (m.field === 'ans') target = files?.expected ?? files?.candidate ?? null;
        else if (m.field === 'out') target = r?.outFile ?? null;
        else {
          const text = m.field === 'err' ? r?.stderr : r?.debugStderr;
          if (text !== undefined) {
            target = path.join(this.runDir(s), `${m.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.${m.field}.txt`);
            await atomicWrite(target, text);
          }
        }
        if (target) {
          if (!(await exists(target))) await atomicWrite(target, '');
          await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true, preserveFocus: false });
        }
        return;
      }
      case 'diff': {
        const files = this.caseFiles(s, m.key, listing);
        const r = this.resultFor(s, m.key);
        if (files?.expected && r?.outFile) {
          await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(files.expected), vscode.Uri.file(r.outFile), `${path.basename(file)}: expected ↔ received`);
        }
        return;
      }
      case 'setting': {
        const patch = { ...m.patch } as Partial<ProblemSettings>;
        if (patch.timeLimitMs !== undefined && !(patch.timeLimitMs > 0)) patch.timeLimitMs = undefined;
        const compareChanged = ['compare', 'precision', 'checker'].some((k) => k in patch);
        p.updateSettings(patch);
        if (compareChanged) await this.rejudge(s);
        return this.requestRender(0);
      }
      case 'manualStart':
        return this.manualStart(s);
      case 'manualSend':
        s.manual?.send(m.text);
        return;
      case 'manualEof':
        s.manual?.eof();
        return;
      case 'manualStop':
        s.manual?.stop();
        return;
      case 'openFile': {
        const f = path.join(path.dirname(file), m.name);
        if (await exists(f)) await vscode.window.showTextDocument(vscode.Uri.file(f), { preview: false });
        return;
      }
    }
  }

  /** Where a file is now, following moves (Set up, renames) the webview or a slow task may not know about yet. */
  currentPath(file: string): string {
    for (let i = 0; i < 10 && this.movedTo.has(file); i++) file = this.movedTo.get(file)!;
    return file;
  }

  /** Changes to a file's cases; every one is an undo step. Runs inside serial(). */
  private async mutate(m: FromWebview, active: string): Promise<void> {
    const target = this.currentPath((m.type === 'edit' || m.type === 'undo' || m.type === 'redo') && m.file ? m.file : active);
    if (target !== active && !(await exists(target))) return; // a file that's gone: don't conjure up an empty problem
    const s = await this.getSession(target);
    const p = s.problem;
    const listing = await this.dirs.get(path.dirname(target));
    const label = (key: string) => (isStoredKey(key) ? caseLabel(p.meta, keyId(key)) : keyId(key));
    switch (m.type) {
      case 'addCase': {
        const { value: c } = await this.recordList(target, 'adding a case', (p) => p.addCase('manual', '', ''));
        this.requestRender(0);
        this.reveal(storedKey(c.id), { focus: true });
        return;
      }
      case 'deleteCase':
      case 'hideCase': {
        const name = label(m.key);
        let entry: HistoryEntry | null;
        if (isStoredKey(m.key)) {
          if (m.type === 'hideCase' || !p.findCase(keyId(m.key))) return;
          ({ entry } = await this.recordList(target, `deleting ${name}`, (p) => p.deleteCase(keyId(m.key))));
          this.notice(`Deleted ${name}`, 'undo', entry?.id);
        } else {
          if (!p.meta.shownFiles.includes(name)) return;
          ({ entry } = await this.recordList(target, `hiding ${name}`, (p) => p.showFile(name, false)));
          this.notice(`Hid ${name} · Files shows it again`, 'undo', entry?.id);
        }
        s.results.delete(m.key);
        return this.requestRender(0);
      }
      case 'showFiles': {
        const names = m.names.filter((n) => listing.matches.some((x) => x.input === n) || !m.show);
        if (!names.length) return;
        await this.recordList(target, `${m.show ? 'showing' : 'hiding'} ${names.length === 1 ? names[0] : `${names.length} files`}`, (p) => {
          for (const n of names) p.showFile(n, m.show);
        });
        if (!m.show) for (const n of names) s.results.delete(fileKey(n));
        return this.requestRender(0);
      }
      case 'edit': {
        if (!isStoredKey(m.key)) return; // text-file cases are read-only (Keep makes an editable copy)
        const files = this.caseFiles(s, m.key, listing);
        if (!files) return;
        const file = m.field === 'in' ? files.input : files.expected;
        if (!file) return;
        const id = `${m.key}|${m.field}`;
        const before = (await readText(file)) ?? '';
        if (before === m.text) {
          s.noteSeq(id, m.seq);
          return;
        }
        await atomicWrite(file, m.text);
        s.setTextFromWebview(id, m.text, file, m.seq);
        s.history.pushText({ kind: 'text', label: `typing in ${label(m.key)}`, caseId: keyId(m.key), field: m.field, before, after: m.text, at: Date.now() });
        p.scheduleSave();
        if (m.field === 'ans') await this.rejudgeOne(s, m.key, listing);
        return this.requestRender();
      }
      case 'pin':
        await this.recordList(target, `${m.pinned ? 'pinning' : 'unpinning'} ${label(m.key)}`, (p) => p.setPinned(m.key, m.pinned));
        return this.requestRender(0);
      case 'reorder':
        await this.recordList(target, 'moving a case', (p) => p.reorder(m.keys));
        return this.requestRender(0);
      case 'keep': {
        const files = this.caseFiles(s, m.key, listing);
        if (!files) return;
        // Copied file to file: text files can be big.
        const { value: c } = await this.recordList(target, `keeping ${label(m.key)}`, (p) => p.addCaseFromFiles(files.input, files.expected, m.key));
        this.requestRender(0);
        this.reveal(storedKey(c.id), { focus: true });
        return;
      }
      case 'undo':
      case 'redo':
        return this.undoRedo(s, m.type, listing, m.id);
    }
  }

  /** Scroll a case into view once the state that contains it has arrived. */
  reveal(key: string, opts: { focus?: boolean; expand?: boolean } = {}): void {
    setTimeout(() => this.poster?.post({ type: 'reveal', key, ...opts }), 80);
  }

  private async undoRedo(s: Session, dir: 'undo' | 'redo', listing: DirListing, id?: number): Promise<void> {
    const top = s.history.peek(dir);
    if (!top) return this.notice(`Nothing to ${dir}`);
    // A notice's Undo / Redo button: only the step it describes.
    if (id !== undefined && top.id !== id) return this.notice(`There are newer changes: use ${dir === 'undo' ? 'Ctrl+Z' : 'Ctrl+R'} to step through them`);
    const e = s.history.take(dir)!;
    const p = s.problem;
    let reveal: string | undefined;
    try {
      if (e.kind === 'text') {
        const key = storedKey(e.caseId);
        if (!p.findCase(e.caseId)) return this.notice(`Can't ${dir} ${e.label}: that case is gone`);
        // Changed in an editor meanwhile ("open in editor"): don't overwrite that.
        if ((await p.readCaseText(e.caseId, e.field)) !== (dir === 'undo' ? e.after : e.before)) return this.notice(`Can't ${dir} ${e.label}: it was changed outside the sidebar`);
        await p.writeCaseText(e.caseId, e.field, dir === 'undo' ? e.before : e.after);
        s.invalidateText(`${key}|${e.field}`);
        if (e.field === 'ans') await this.rejudgeOne(s, key, listing);
        reveal = key;
      } else {
        const st = dir === 'undo' ? e.before : e.after;
        const lost = st.cases ? await p.lostCases(st.cases) : [];
        if (lost.length) return this.notice(`Can't ${dir} ${e.label}: the files of ${caseLabel({ ...p.meta, cases: st.cases! }, lost[0].id)} are gone`);
        const visible = () => [...p.meta.cases.map((c) => storedKey(c.id)), ...p.meta.shownFiles.map(fileKey)];
        const had = new Set(visible());
        await p.applyListState(st, dir === 'undo' ? { add: e.shown.removed, remove: e.shown.added } : { add: e.shown.added, remove: e.shown.removed });
        const now = visible();
        // Results of cases that go, and of cases that come back (anything stored while they were away is stale).
        for (const k of [...s.results.keys()]) if (!now.includes(k) || !had.has(k)) s.results.delete(k);
        for (const k of [...had].filter((k) => !now.includes(k)).concat(now.filter((k) => !had.has(k)))) if (isStoredKey(k)) s.invalidatePrefix(`${k}|`);
        reveal = now.find((k) => !had.has(k));
      }
    } catch (err) {
      s.history.restore(dir, e);
      this.log(`${dir} failed: ${(err as Error).stack ?? err}`);
      return this.notice(`Couldn't ${dir} ${e.label}: ${(err as Error).message ?? err}`);
    }
    s.history.applied(dir, e);
    this.requestRender(0);
    if (reveal) this.reveal(reveal, { expand: true });
    this.notice(`${dir === 'undo' ? 'Undid' : 'Redid'} ${e.label}`, dir === 'undo' ? 'redo' : 'undo', e.id);
  }

  /** Re-judge a case's existing output after its expected output changed. */
  private async rejudgeOne(s: Session, key: string, listing: DirListing): Promise<void> {
    const r = s.results.get(key);
    if (!r?.outFile || r.transcript || !['AC', 'WA', 'RAN'].includes(r.verdict)) return;
    const files = this.caseFiles(s, key, listing);
    if (!files) return;
    const j = await this.judgeOutput(s, files, r.outFile, null, r.stderr ?? '');
    s.results.set(key, { ...r, ...j, diff: j.diff });
    s.invalidateText(`${key}|out`);
  }

  private async manualStart(s: Session): Promise<void> {
    const st = s.problem.meta.settings;
    s.manual?.stop();
    s.manualExit = 'compiling…';
    s.manualEvents = [];
    this.poster?.post({ type: 'manual', events: [], reset: true });
    this.requestRender(0);
    const built = await this.build(s.file, st.judgeFlags ? 'judge' : 'debug');
    s.compile = { state: built.ok ? 'ok' : 'error', output: built.output, judgeFlags: st.judgeFlags, pch: built.pch };
    if (!built.ok) {
      s.manualExit = 'compile error';
      this.requestRender(0);
      return;
    }
    const m = new ManualSession();
    s.manual = m;
    s.manualExit = undefined;
    let batch: TranscriptLine[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!batch.length || s.manual !== m) return;
      if (s.file === this.active) this.poster?.post({ type: 'manual', events: batch, reset: false });
      batch = [];
    };
    m.on('event', (e: { kind: string; text: string }) => {
      const line: TranscriptLine = { k: e.kind === 'in' ? 'in' : e.kind === 'out' ? 'out' : 'err', t: e.text };
      s.manualEvents.push(line);
      batch.push(line);
      if (!timer) timer = setTimeout(flush, 30);
    });
    m.on('exit', (x: { code: number | null; signal: string | null; timeMs: number; error?: string }) => {
      flush();
      s.manualExit = x.error ? `could not start: ${x.error}` : x.signal ? `killed by ${x.signal} · ${x.timeMs} ms` : `exited ${x.code} · ${x.timeMs} ms`;
      this.requestRender(0);
    });
    m.start(built.cmd, path.dirname(s.file), this.limits());
    this.requestRender(0);
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      s.abort?.abort();
      s.manual?.stop();
    }
    for (const d of this.disposables) d.dispose();
  }
}
