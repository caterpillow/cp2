// Everything that talks to the browser (through cp2-bridge): importing samples, submitting,
// writing contests, verdict colours in the explorer and the contest strip in the status bar.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { exists, readText, statOrNull } from '../core/fsutil';
import { langOf } from '../core/lang';
import { resolveSnippet, snippetVars } from '../core/snippet';
import { Binding, Problem, Store, StoreIndex, VerdictState } from '../core/store';
import { canSubmit, contestKey, fileStemForIndex, problemKey, ProblemRef, shortProblemId, siteLabel } from '../../../shared/problemId';
import { BridgeEvent, BridgeState, CMD_BRIDGE_ACK, CMD_BRIDGE_EVENT, CMD_BRIDGE_REQUEST, CMD_BRIDGE_SNIPPET, CMD_BRIDGE_STATE, ContestInfo, ContestTask, ProblemData, SubmitResult, VerdictUpdate } from '../../../shared/protocol';
import type { Controller, Extras } from './controller';

function bindingFromRef(ref: ProblemRef): Binding {
  return { site: ref.site, contestId: ref.contestId, taskId: ref.taskId, index: ref.index, url: ref.url, cfKind: ref.cfKind, groupId: ref.groupId };
}

function refFromBinding(b: Binding): ProblemRef {
  return { site: b.site, contestId: b.contestId, taskId: b.taskId, index: b.index, url: b.url, cfKind: b.cfKind, groupId: b.groupId };
}

const SHADES = [1, 2, 3, 4, 3, 2];

class VerdictDecorations implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private verdicts = new Map<string, VerdictState>();
  private phase = 0;
  private timer: NodeJS.Timeout | undefined;

  set(file: string, v: VerdictState | undefined): void {
    if (v) this.verdicts.set(file, v);
    else this.verdicts.delete(file);
    this.emitter.fire(this.uris(file));
    this.updateTimer();
  }

  get(file: string): VerdictState | undefined {
    return this.verdicts.get(file);
  }

  /** The file, plus its stress folder (x/x.cpp) so the colour shows when collapsed. */
  private uris(file: string): vscode.Uri[] {
    const out = [vscode.Uri.file(file)];
    const dir = path.dirname(file);
    if (path.basename(dir) === path.parse(file).name) out.push(vscode.Uri.file(dir));
    return out;
  }

  private updateTimer(): void {
    const judging = [...this.verdicts.entries()].filter(([, v]) => v.status === 'judging');
    if (judging.length && !this.timer) {
      this.timer = setInterval(() => {
        this.phase = (this.phase + 1) % SHADES.length;
        const now = [...this.verdicts.entries()].filter(([, v]) => v.status === 'judging');
        if (!now.length) return this.updateTimer();
        this.emitter.fire(now.flatMap(([f]) => this.uris(f)));
      }, 280);
    } else if (!judging.length && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    let v = this.verdicts.get(uri.fsPath);
    if (!v) {
      // stress folder x/ shows its x/x.cpp's verdict
      const inner = path.join(uri.fsPath, path.basename(uri.fsPath));
      for (const ext of ['.cpp', '.cc', '.c', '.py']) {
        v = this.verdicts.get(inner + ext);
        if (v) break;
      }
    }
    if (!v) return undefined;
    const badge = (v.short ?? '').slice(0, 2) || undefined;
    switch (v.status) {
      case 'accepted':
        return new vscode.FileDecoration(badge ?? 'AC', v.text, new vscode.ThemeColor('cp2.verdict.accepted'));
      case 'rejected':
        return new vscode.FileDecoration(badge ?? '✗', v.text, new vscode.ThemeColor('cp2.verdict.rejected'));
      case 'partial':
        return new vscode.FileDecoration(badge ?? '~', v.text, new vscode.ThemeColor('cp2.verdict.partial'));
      default:
        return new vscode.FileDecoration('…', v.text, new vscode.ThemeColor(`cp2.verdict.judging${SHADES[this.phase]}`));
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

export class Integrations implements Extras, vscode.Disposable {
  private state: BridgeState = { connected: false, focus: { problem: null, contest: null }, leader: false };
  private bridgeInstalled: boolean | null = null;
  private decorations = new VerdictDecorations();
  private statusItem = vscode.window.createStatusBarItem('cp2.contest', vscode.StatusBarAlignment.Left, 50);
  private problemItem = vscode.window.createStatusBarItem('cp2.problem', vscode.StatusBarAlignment.Left, 51);
  private disposables: vscode.Disposable[] = [];
  private probeTimer: NodeJS.Timeout | undefined;
  private clock: NodeJS.Timeout;

  constructor(
    private c: Controller,
    ctx: vscode.ExtensionContext,
  ) {
    void ctx;
    this.statusItem.name = 'cp2 contest';
    this.statusItem.command = 'cp2.writeContest';
    this.problemItem.name = 'cp2 browser problem';
    this.problemItem.command = 'cp2.import';
    this.disposables.push(
      this.statusItem,
      this.problemItem,
      this.decorations,
      vscode.window.registerFileDecorationProvider(this.decorations),
      vscode.commands.registerCommand(CMD_BRIDGE_EVENT, (ev: BridgeEvent) => this.onEvent(ev)),
    );
    this.clock = setInterval(() => this.updateStatusBar(), 30000);
    void this.loadVerdicts();
    void this.probe();
  }

  // ---------------- bridge ----------------

  private async probe(): Promise<void> {
    try {
      const st = await vscode.commands.executeCommand<BridgeState>(CMD_BRIDGE_STATE);
      if (st) {
        this.bridgeInstalled = true;
        this.state = st;
        this.afterStateChange();
        return;
      }
    } catch {
      this.bridgeInstalled = false;
    }
    // The bridge may activate a little later (or get installed); keep checking slowly.
    this.probeTimer = setTimeout(() => void this.probe(), this.bridgeInstalled === false ? 10000 : 3000);
  }

  private async request<T>(op: string, args: unknown): Promise<T> {
    try {
      return (await vscode.commands.executeCommand<T>(CMD_BRIDGE_REQUEST, op, args)) as T;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/not found/i.test(msg) && /cp2bridge/.test(msg)) throw new Error('cp2-bridge is not installed (it runs next to the browser and relays to it)');
      throw e;
    }
  }

  bridgeConnected(): boolean {
    return this.state.connected;
  }

  private async onEvent(ev: BridgeEvent): Promise<void> {
    this.bridgeInstalled = true;
    try {
      switch (ev.type) {
        case 'connection':
          this.state.connected = ev.connected;
          break;
        case 'focus':
          this.state.focus = ev.focus;
          this.state.connected = true;
          await this.checkPending(ev.focus.contest);
          break;
        case 'visit':
          await this.autoImport(ev.problem);
          break;
        case 'icon':
          await this.iconImport(ev.requestId, ev.problem, ev.error);
          break;
        case 'verdict':
          await this.onVerdict(ev.update);
          break;
      }
    } catch (e) {
      this.c.log(`bridge event ${ev.type} failed: ${(e as Error).stack ?? e}`);
    }
    this.afterStateChange();
  }

  private afterStateChange(): void {
    void vscode.commands.executeCommand('setContext', 'cp2.contestLoaded', !!this.state.focus.contest);
    this.updateStatusBar();
    this.c.requestRender();
  }

  // ---------------- import ----------------

  importButton(p: Problem): { label: string; title: string; enabled: boolean; note?: string } {
    if (this.bridgeInstalled === false) return { label: 'Import', title: 'cp2-bridge is not installed', enabled: false };
    const b = p.meta.binding;
    const bound = b ? refFromBinding(b) : null;
    const focus = this.state.connected ? this.state.focus.problem : null;
    if (focus?.anonymous) {
      // A plain PDF or another page: samples only, nothing to link to.
      return {
        label: `Import · ${focus.name}`,
        title: `Import the samples from ${focus.pdfUrl ?? focus.ref.url} (Ctrl+Shift+I)`,
        enabled: true,
        note: bound ? `Linked to ${shortProblemId(bound)}. Importing these samples unlinks this file.` : undefined,
      };
    }
    if (focus) {
      // The problem page you touched last in the browser always wins (it can replace a link).
      const id = shortProblemId(focus.ref);
      const name = focus.name.replace(/^[A-Za-z0-9]+[.\s-]+\s*/, '');
      if (bound && problemKey(bound) === problemKey(focus.ref)) return { label: `Re-import · ${id}`, title: `Re-import the samples of ${focus.name} (Ctrl+Shift+I)`, enabled: true };
      return {
        label: `Import · ${id} — ${name}`,
        title: `Import the samples of ${focus.name} (${focus.ref.url}) (Ctrl+Shift+I)`,
        enabled: true,
        note: bound ? `Linked to ${shortProblemId(bound)}. Importing links this file to ${id} instead.` : undefined,
      };
    }
    if (bound) {
      const id = shortProblemId(bound);
      return { label: `Re-import · ${id}`, title: this.state.connected ? `Re-import the samples of ${p.meta.name ?? id}` : 'The browser extension is not connected', enabled: this.state.connected };
    }
    if (!this.state.connected) return { label: 'Import', title: 'The browser extension is not connected', enabled: false };
    return { label: 'Import', title: 'Open a problem in the browser first (or click the cp2 toolbar icon on any page)', enabled: false };
  }

  async doImport(file: string): Promise<void> {
    const p = await this.c.getProblem(file);
    // Latest browser problem first; fall back to the problem this file is linked to.
    const latest = this.state.connected ? this.state.focus.problem : null;
    const ref = latest ? undefined : p.meta.binding ? refFromBinding(p.meta.binding) : undefined;
    if (!latest && !ref) {
      void vscode.window.showInformationMessage('cp2: open a problem in the browser first (or click the cp2 toolbar icon on the page)');
      return;
    }
    const data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'cp2: importing samples' }, () => this.request<ProblemData | null>('scrape', { ref }));
    if (!data) {
      void vscode.window.showWarningMessage('cp2: no problem found on that page');
      return;
    }
    await this.applyImport(file, data, false);
  }

  private async applyImport(file: string, data: ProblemData, quiet: boolean): Promise<void> {
    const p = await this.c.getProblem(file);
    const tests = data.interactive ? [] : data.tests;
    const idx = await this.c.indexFor(p.store);
    const old = p.meta.binding ? refFromBinding(p.meta.binding) : null;
    const relinked = old && (data.anonymous || problemKey(old) !== problemKey(data.ref)) ? old : null;
    if (relinked) {
      // A different problem now (or none): drop the old link and its verdict.
      if (idx.data.bindings[problemKey(relinked)] === p.store.rel(file)) delete idx.data.bindings[problemKey(relinked)];
      p.meta.verdict = undefined;
      delete idx.data.verdicts[p.store.rel(file)];
      this.decorations.set(file, undefined);
      p.meta.autoImported = false;
    }
    if (tests.length || !data.note) {
      // Not an undo step: an import also relinks the file (name, limits, verdict), which undo couldn't put back.
      await this.c.serial(async () => {
        await p.replaceImported(tests);
        this.c.forgetHistory(file);
      });
    }
    if (data.anonymous) {
      // Samples only: the file isn't linked to anything (and keeps no name from a judge).
      p.meta.binding = undefined;
      if (relinked) p.meta.name = undefined;
      await p.flush();
      idx.save();
      this.c.requestRender(0);
      this.updateStatusBar();
      const msg = tests.length ? `imported ${tests.length} sample${tests.length === 1 ? '' : 's'} from ${data.name} into ${path.basename(file)}${relinked ? ` (unlinked from ${shortProblemId(relinked)})` : ''}` : `no samples found in ${data.name}${data.note ? `: ${data.note}` : ''}`;
      if (!quiet) {
        if (!tests.length) void vscode.window.showWarningMessage(`cp2: ${msg}`);
        else vscode.window.setStatusBarMessage(`cp2: ${msg}`, 5000);
      }
      this.c.log(msg);
      return;
    }
    p.meta.name = data.name;
    p.meta.binding = bindingFromRef(data.ref);
    if (data.memoryLimitMb) p.meta.memoryLimitMb = data.memoryLimitMb;
    const patch: Partial<Problem['meta']['settings']> = {};
    if (data.timeLimitMs) patch.timeLimitMs = data.timeLimitMs;
    if (data.interactive) patch.interactive = true;
    p.updateSettings(patch);
    await p.flush();
    idx.data.bindings[problemKey(data.ref)] = p.store.rel(file);
    idx.save();
    const s = this.c.sessionIfLoaded(file);
    if (s) for (const k of [...s.results.keys()]) if (!p.meta.order.includes(k) && !k.startsWith('f:')) s.results.delete(k);
    this.c.requestRender(0);
    this.updateStatusBar();
    const id = shortProblemId(data.ref);
    let msg: string;
    if (data.interactive) msg = `${id} is interactive: linked it, samples not imported`;
    else if (!tests.length && data.note) msg = `linked ${path.basename(file)} to ${id}, but ${data.note}`;
    else msg = `imported ${tests.length} sample${tests.length === 1 ? '' : 's'} from ${id} into ${path.basename(file)}${relinked ? ` (was linked to ${shortProblemId(relinked)})` : ''}`;
    if (!quiet) {
      if (!tests.length && data.note && !data.interactive) void vscode.window.showWarningMessage(`cp2: ${msg}`);
      else vscode.window.setStatusBarMessage(`cp2: ${msg}`, 5000);
    }
    this.c.log(msg);
  }

  /** First visit of a problem tab whose file was created by Write Contest: import its samples once. */
  private async autoImport(data: ProblemData): Promise<void> {
    const file = await this.fileForProblem(data.ref);
    if (!file) return;
    const p = await this.c.getProblem(file);
    if (p.meta.autoImported || p.meta.cases.some((c) => c.origin === 'imported')) return;
    p.meta.autoImported = true;
    await this.applyImport(file, data, true);
    vscode.window.setStatusBarMessage(`cp2: ${path.basename(file)} ← ${data.tests.length} samples from ${shortProblemId(data.ref)}`, 4000);
  }

  private async iconImport(requestId: string, data: ProblemData | null, error?: string): Promise<void> {
    const file = this.c.active;
    let ok = false;
    let message: string;
    if (error || !data) message = error ?? 'no problem on this page';
    else if (!file) message = 'open a source file in VS Code first';
    else {
      await this.applyImport(file, data, false);
      ok = true;
      message = `imported into ${path.basename(file)}`;
    }
    try {
      await vscode.commands.executeCommand(CMD_BRIDGE_ACK, requestId, ok, message);
    } catch {
      /* bridge gone */
    }
  }

  /** Source file bound to a problem, searching the stores we know about. */
  private async fileForProblem(ref: ProblemRef): Promise<string | null> {
    const key = problemKey(ref);
    for (const store of await this.knownStores()) {
      const idx = await this.c.indexFor(store);
      const rel = idx.data.bindings[key];
      if (rel) {
        const f = store.abs(rel);
        if (await exists(f)) return f;
      }
    }
    return null;
  }

  private async knownStores(): Promise<Store[]> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const stores = await Promise.all(roots.map((r) => this.c.storeFor(path.join(r, '__cp2__'))));
    for (const s of this.c.locator.allStores()) if (!stores.includes(s)) stores.push(s);
    return stores;
  }

  // ---------------- submit ----------------

  submitButton(p: Problem): { label: string; title: string; enabled: boolean } {
    const b = p.meta.binding;
    if (!b) return { label: 'Submit', title: 'Import the samples or write the contest first, so cp2 knows which problem this is', enabled: false };
    const id = shortProblemId(refFromBinding(b));
    if (!canSubmit(b.site)) return { label: `Submit · ${id}`, title: `Submitting to ${siteLabel(b.site)} isn't supported (Codeforces, AtCoder and DMOJ are)`, enabled: false };
    if (this.bridgeInstalled === false) return { label: `Submit · ${id}`, title: 'cp2-bridge is not installed', enabled: false };
    return { label: `Submit · ${id}`, title: this.state.connected ? `Submit to ${b.url}` : 'The browser extension is not connected', enabled: this.state.connected };
  }

  async doSubmit(file: string): Promise<void> {
    const p = await this.c.getProblem(file);
    const b = p.meta.binding;
    if (!b) {
      void vscode.window.showWarningMessage('cp2: this file is not linked to a problem yet (import its samples or write the contest first)');
      return;
    }
    const ref = refFromBinding(b);
    const id = shortProblemId(ref);
    const lang = langOf(file) ?? 'cpp';
    if (vscode.workspace.getConfiguration('cp2', vscode.Uri.file(file)).get<boolean>('submit.confirm', true)) {
      const reasons: string[] = [];
      const s = this.c.sessionIfLoaded(file);
      const mtime = (await statOrNull(file))?.mtimeMs ?? 0;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
      if (!s?.lastRun?.anyRun) reasons.push("the tests haven't been run");
      else {
        if (s.lastRun.failed) reasons.push('the last run had failures');
        if (doc?.isDirty || mtime > s.lastRun.sourceMtime + 1) reasons.push('the file changed since the last run');
      }
      if (p.meta.settings.interactive && lang === 'cpp') {
        const src = doc?.getText() ?? (await readText(file)) ?? '';
        if (!/^\s*#\s*define\s+INTERACTIVE\b/m.test(src)) reasons.push("it doesn't #define INTERACTIVE (output won't be flushed)");
      }
      if (reasons.length) {
        const pick = await vscode.window.showWarningMessage(`Submit ${path.basename(file)} to ${id}?`, { modal: true, detail: reasons.map((r) => `• ${r[0].toUpperCase()}${r.slice(1)}.`).join('\n') }, 'Submit anyway', 'Run tests');
        if (pick === 'Run tests') {
          await this.c.runAll(file);
          return;
        }
        if (pick !== 'Submit anyway') return;
      }
    }
    await this.c.saveIfDirty(file);
    const code = await fsp.readFile(file, 'utf8');
    const patterns = this.c.cfg().submitLanguages[ref.site]?.[lang] ?? [];
    const before = p.meta.verdict;
    await this.setVerdict(file, { status: 'judging', text: 'Submitting…', at: Date.now(), everAccepted: before?.everAccepted ?? false });
    let res: SubmitResult;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `cp2: submitting to ${id}` }, () => this.request<SubmitResult>('submit', { ref, code, fileName: path.basename(file), languagePatterns: patterns }));
    } catch (e) {
      res = { ok: false, message: String((e as Error).message ?? e) };
    }
    if (!res?.ok) {
      await this.setVerdict(file, before);
      void vscode.window.showErrorMessage(`cp2: submit failed — ${res?.message ?? 'no response from the browser'}`);
      return;
    }
    await this.setVerdict(file, { status: 'judging', text: res.message || 'In queue', at: Date.now(), everAccepted: before?.everAccepted ?? false });
  }

  private async onVerdict(u: VerdictUpdate): Promise<void> {
    const file = await this.fileForProblem(u.ref);
    if (!file) return;
    const p = await this.c.getProblem(file);
    const prev = p.meta.verdict;
    const ever = (prev?.everAccepted ?? false) || (u.status === 'accepted' && u.final);
    // Once accepted, a problem stays green except while a new submission is being judged.
    const shown: VerdictState = u.final && u.status !== 'accepted' && ever ? { status: 'accepted', text: `Accepted earlier · latest: ${u.text}`, short: 'AC', at: u.at, url: u.url, everAccepted: true, submissionId: u.submissionId } : { status: u.status, text: u.text, short: u.short, at: u.at, url: u.url, submissionId: u.submissionId, everAccepted: ever };
    await this.setVerdict(file, shown);
    if (u.final) vscode.window.setStatusBarMessage(`cp2: ${path.basename(file)} — ${u.text}`, 8000);
  }

  private async setVerdict(file: string, v: VerdictState | undefined): Promise<void> {
    const p = await this.c.getProblem(file);
    p.meta.verdict = v;
    p.scheduleSave();
    const idx = await this.c.indexFor(p.store);
    const rel = p.store.rel(file);
    if (v) idx.data.verdicts[rel] = v;
    else delete idx.data.verdicts[rel];
    idx.save();
    this.decorations.set(file, v);
    this.updateStatusBar();
    this.c.requestRender(0);
  }

  onVerdictChanged(file: string): void {
    void this.c.getProblem(file).then((p) => this.decorations.set(file, p.meta.verdict));
  }

  private async loadVerdicts(): Promise<void> {
    for (const store of await this.knownStores()) {
      const idx = await this.c.indexFor(store);
      for (const [rel, v] of Object.entries(idx.data.verdicts)) {
        // A judging state left over from a previous session can't finish anymore.
        const fixed = v.status === 'judging' ? { ...v, status: v.everAccepted ? ('accepted' as const) : ('rejected' as const), text: `${v.text} (not followed up)` } : v;
        this.decorations.set(store.abs(rel), fixed);
      }
    }
    this.updateStatusBar();
  }

  // ---------------- contests ----------------

  async writeContest(uri: vscode.Uri | undefined, here: boolean): Promise<void> {
    const contest = this.state.focus.contest;
    if (!contest) {
      void vscode.window.showInformationMessage('cp2: open a contest page in the browser first (codeforces.com/contest/<id> or atcoder.jp/contests/<id>)');
      return;
    }
    const roots = vscode.workspace.workspaceFolders ?? [];
    let folder: string | undefined;
    if (here) folder = uri?.fsPath ?? (roots.length === 1 ? roots[0].uri.fsPath : undefined);
    if (!folder) folder = await this.pickFolder(contest);
    if (!folder) return;
    let tasks = contest.tasks;
    if (!tasks?.length) {
      try {
        tasks = await this.request<ContestTask[] | null>('tasks', { site: contest.ref.site, contestId: contest.ref.contestId });
      } catch (e) {
        this.c.log(`fetching tasks failed: ${e}`);
      }
    }
    const rel = vscode.workspace.asRelativePath(folder, true);
    const label = `${siteLabel(contest.ref.site)} ${contest.ref.contestId}`;
    if (!tasks?.length) {
      const pick = await vscode.window.showQuickPick([{ label: `$(clock) Create the files when the task list appears`, detail: `${contest.name} hasn't published its problems yet. cp2 will write them into ${rel} the next time the browser sees the task list (open the contest page after it starts).`, ok: true }, { label: 'Cancel', ok: false }], { title: `Write ${label}` });
      if (!pick?.ok) return;
      const store = await this.c.storeFor(path.join(folder, '__cp2__'));
      const idx = await this.c.indexFor(store);
      idx.data.pendingContests = idx.data.pendingContests.filter((p) => !(p.site === contest.ref.site && p.contestId === contest.ref.contestId));
      idx.data.pendingContests.push({ site: contest.ref.site, contestId: contest.ref.contestId, folderRel: store.rel(folder), ext: this.c.cfg().newFile.extension, createdAt: Date.now() });
      await idx.flush();
      return;
    }
    const ext = this.c.cfg().newFile.extension;
    const names = tasks.map((t) => fileStemForIndex(t.index) + ext);
    const pick = await vscode.window.showQuickPick([{ label: `$(check) Write ${names.join(', ')}`, detail: `${contest.name} (${label}) → ${rel}`, ok: true }, { label: 'Cancel', ok: false }], { title: `Write ${contest.name}` });
    if (!pick?.ok) return;
    const n = await this.writeFiles(folder, contest, tasks);
    vscode.window.setStatusBarMessage(`cp2: wrote ${n} new file${n === 1 ? '' : 's'} into ${rel}`, 6000);
  }

  private suggestedFolder(contest: ContestInfo): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const pats = this.c.cfg().contestFolders;
    const id = contest.ref.contestId;
    const vars: Record<string, string> = { contestId: id, site: contest.ref.site };
    const m = id.match(/^([a-z]+)(\d+)$/i);
    if (m) {
      const num = Number(m[2]);
      vars.number = String(num);
      vars.hundreds = String(Math.floor(num / 100));
    }
    const tpl = (m ? pats[`${contest.ref.site}.${m[1].toLowerCase()}`] : undefined) ?? pats[contest.ref.site] ?? `${contest.ref.site}/\${contestId}`;
    return path.join(root, tpl.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
  }

  private async pickFolder(contest: ContestInfo): Promise<string | undefined> {
    const sug = this.suggestedFolder(contest);
    const items: (vscode.QuickPickItem & { folder?: string; browse?: boolean })[] = [];
    if (sug) items.push({ label: `$(folder) ${vscode.workspace.asRelativePath(sug, true)}`, description: (await exists(sug)) ? 'exists' : 'new folder', folder: sug });
    items.push({ label: '$(folder-opened) Choose a folder…', browse: true });
    const pick = await vscode.window.showQuickPick(items, { title: `Write ${contest.name} into…` });
    if (!pick) return undefined;
    if (pick.folder) return pick.folder;
    const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: 'Write contest here' });
    return r?.[0]?.fsPath;
  }

  private async snippetText(file: string): Promise<{ text: string; cursor: { line: number; character: number } | null }> {
    const cfg = this.c.cfg();
    let body: string | null = null;
    if (cfg.newFile.snippet) {
      try {
        body = (await vscode.commands.executeCommand<string | null>(CMD_BRIDGE_SNIPPET, cfg.newFile.language, cfg.newFile.snippet)) ?? null;
      } catch {
        body = null;
      }
    }
    if (body === null) return { text: '', cursor: null };
    return resolveSnippet(body, { vars: snippetVars(file, vscode.workspace.name ?? ''), insertSpaces: cfg.newFile.insertSpaces, tabSize: cfg.newFile.tabSize });
  }

  /** Creates a.cpp, b.cpp, ... (never overwriting) and links each to its problem. */
  private async writeFiles(folder: string, contest: ContestInfo, tasks: ContestTask[]): Promise<number> {
    await fsp.mkdir(folder, { recursive: true });
    const ext = this.c.cfg().newFile.extension;
    let created = 0;
    for (const t of tasks) {
      const file = path.join(folder, fileStemForIndex(t.index) + ext);
      const p = await this.c.getProblem(file);
      if (!(await exists(file))) {
        const s = await this.snippetText(file);
        await fsp.writeFile(file, s.text);
        if (s.cursor) p.meta.snippetCursor = s.cursor;
        created++;
      }
      if (!p.meta.binding) {
        const ref: ProblemRef = { site: contest.ref.site, contestId: contest.ref.contestId, taskId: t.taskId, index: t.index, url: t.url, cfKind: contest.ref.cfKind, groupId: contest.ref.groupId };
        p.meta.binding = bindingFromRef(ref);
        if (t.name) p.meta.name = contest.ref.site === 'codeforces' ? `${t.index}. ${t.name}` : `${t.index} - ${t.name}`;
        if (t.timeLimitMs) p.meta.settings.timeLimitMs = t.timeLimitMs;
        if (t.memoryLimitMb) p.meta.memoryLimitMb = t.memoryLimitMb;
        const idx = await this.c.indexFor(p.store);
        idx.data.bindings[problemKey(ref)] = p.store.rel(file);
        idx.save();
      }
      await p.flush();
    }
    this.c.dirs.invalidate(folder);
    this.c.requestRender();
    return created;
  }

  /** A contest written before it started: create the files once its task list shows up. */
  private async checkPending(contest: ContestInfo | null): Promise<void> {
    if (!contest?.tasks?.length) return;
    for (const store of await this.knownStores()) {
      const idx: StoreIndex = await this.c.indexFor(store);
      const due = idx.data.pendingContests.filter((p) => contestKey(p) === contestKey(contest.ref));
      if (!due.length) continue;
      idx.data.pendingContests = idx.data.pendingContests.filter((p) => !due.includes(p));
      await idx.flush();
      for (const d of due) {
        const folder = store.abs(d.folderRel);
        const n = await this.writeFiles(folder, contest, contest.tasks);
        void vscode.window.showInformationMessage(`cp2: ${contest.name} started — wrote ${n} files into ${d.folderRel}`);
      }
    }
  }

  // ---------------- status bar ----------------

  private updateStatusBar(): void {
    this.updateProblemItem();
    const contest = this.state.focus.contest;
    if (!contest) {
      this.statusItem.hide();
      return;
    }
    void (async () => {
      const parts: string[] = [`$(flag) ${siteLabel(contest.ref.site)} ${contest.ref.contestId}`];
      if (contest.tasks?.length) {
        const letters: string[] = [];
        for (const [i, t] of contest.tasks.entries()) {
          const f = await this.fileForProblem({ site: contest.ref.site, contestId: contest.ref.contestId, taskId: t.taskId, url: t.url });
          const v = f ? this.decorations.get(f) : undefined;
          const mark = !v ? '' : v.status === 'accepted' ? '✓' : v.status === 'rejected' ? '✗' : v.status === 'partial' ? '~' : '…';
          letters.push((t.index.length > 3 ? String(i + 1) : t.index) + mark);
        }
        parts.push(letters.join(' '));
      }
      if (contest.endTime) {
        const left = contest.endTime - Date.now();
        const start = contest.startTime ?? 0;
        if (start > Date.now()) parts.push(`starts in ${fmtDur(start - Date.now())}`);
        else if (left > 0) parts.push(`${fmtDur(left)} left`);
        else parts.push('ended');
      }
      this.statusItem.text = parts.join(' · ');
      this.statusItem.tooltip = new vscode.MarkdownString(`**${contest.name}**\n\nClick to write this contest's files (a.cpp, b.cpp, …) into a folder.`);
      this.statusItem.show();
    })();
  }

  /** The problem page you touched last in the browser: what Import / Ctrl+Shift+I will use. */
  private updateProblemItem(): void {
    const p = this.state.connected ? this.state.focus.problem : null;
    if (!p) {
      this.problemItem.text = this.bridgeInstalled && !this.state.connected ? '$(debug-disconnect) cp2' : '';
      this.problemItem.tooltip = 'cp2: the browser extension is not connected';
      if (this.problemItem.text) this.problemItem.show();
      else this.problemItem.hide();
      return;
    }
    if (p.anonymous) {
      const n = p.name.length > 32 ? p.name.slice(0, 31) + '…' : p.name;
      this.problemItem.text = `${p.pdfUrl ? '$(file-pdf)' : '$(globe)'} ${n}`;
      this.problemItem.tooltip = new vscode.MarkdownString(`**${p.name}**\n\n${p.pdfUrl ?? p.ref.url}\n\nNot a judge problem: Import (Ctrl+Shift+I) copies its samples only.`);
      this.problemItem.show();
      return;
    }
    const name = p.name.replace(/^[A-Za-z0-9]+[.\s-]+\s*/, '');
    this.problemItem.text = `$(browser) ${shortProblemId(p.ref)}${name ? ` · ${name.length > 28 ? name.slice(0, 27) + '…' : name}` : ''}`;
    const target = this.c.active ? path.basename(this.c.active) : 'the active file';
    this.problemItem.tooltip = new vscode.MarkdownString(`**${p.name}**\n\n${p.ref.url}\n\nThe problem page you used last in the browser. Click (or Ctrl+Shift+I) to import its samples into ${target}.`);
    this.problemItem.show();
  }

  dispose(): void {
    clearInterval(this.clock);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}
