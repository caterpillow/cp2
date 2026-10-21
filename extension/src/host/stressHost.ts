// Stress sections at the bottom of the sidebar: pickers, Set up, Run/Stop, live status.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { atomicWrite, copyFileP, exists, readText, sha1, statOrNull } from '../core/fsutil';
import { isSourceFile } from '../core/lang';
import { classifyRun, describeExit, runProcess } from '../core/runner';
import { resolveSnippet, snippetVars } from '../core/snippet';
import { DirMeta, loadDirMeta, saveDirMeta, SHRINK_STEPS, shrinkIndex } from '../core/store';
import { StressConfig, StressRun, StressStatus } from '../core/stress';
import { autofill, defaultGen, planSetup, Slot } from '../core/stressFiles';
import type { FromWebview, SlotVM, StressSectionVM, StressStatusVM } from '../../../shared/viewModel';
import type { Controller } from './controller';
import type { DirListing } from './dirIndex';
import type { CaseResult } from './session';

type Mode = 'wa' | 're';

interface RunState {
  run: StressRun | null;
  compiling: boolean;
  status: StressStatusVM | undefined;
}

export class StressHost {
  private metas = new Map<string, Promise<DirMeta>>();
  private runs = new Map<string, RunState>();
  private caseResults = new Map<string, CaseResult>();

  constructor(private c: Controller) {}

  private runKey(dir: string, mode: Mode): string {
    return `${dir}|${mode}`;
  }

  private async meta(dir: string): Promise<DirMeta> {
    let m = this.metas.get(dir);
    if (!m) {
      m = (async () => loadDirMeta(await this.c.storeFor(path.join(dir, 'x')), dir))();
      this.metas.set(dir, m);
    }
    return m;
  }

  private async saveMeta(dir: string): Promise<void> {
    const m = await this.meta(dir);
    await saveDirMeta(await this.c.storeFor(path.join(dir, 'x')), dir, m);
  }

  caseResult(dir: string): CaseResult | undefined {
    return this.caseResults.get(dir);
  }

  isStressDir(dir: string): boolean {
    return this.runs.has(this.runKey(dir, 'wa')) || this.runs.has(this.runKey(dir, 're')) || this.caseResults.has(dir);
  }

  private slots(dir: string, listing: DirListing, active: string, meta: DirMeta): { wa: Record<'sus' | 'brute' | 'gen', Slot>; re: Record<'sus' | 'brute' | 'gen', Slot> } {
    return { wa: autofill(dir, listing.files, active, meta.wa), re: autofill(dir, listing.files, active, meta.re) };
  }

  async sections(active: string, listing: DirListing): Promise<{ wa: StressSectionVM; re: StressSectionVM }> {
    const dir = path.dirname(active);
    const meta = await this.meta(dir);
    const files = listing.files.filter(isSourceFile).sort();
    const sl = this.slots(dir, listing, active, meta);
    const has = (n: string) => !!n && listing.files.includes(n);
    const out = {} as { wa: StressSectionVM; re: StressSectionVM };
    for (const mode of ['wa', 're'] as Mode[]) {
      const s = sl[mode];
      const susFile = s.sus.value ? path.join(dir, s.sus.value) : null;
      const susSettings = susFile ? (await this.c.getProblem(susFile)).meta.settings : null;
      const interactive = !!susSettings?.interactive;
      const slot = (role: SlotVM['role'], v: Slot): SlotVM => ({ role, value: v.value, auto: v.auto, missing: !has(v.value), options: files });
      const slots: SlotVM[] = [slot('sus', s.sus)];
      if (mode === 'wa') slots.push(slot('brute', s.brute));
      slots.push(slot('gen', s.gen));
      if (mode === 'wa' && susSettings?.compare === 'checker') slots.push({ role: 'checker', value: susSettings.checker, auto: false, missing: !has(susSettings.checker), options: files });
      if (mode === 're' && interactive) slots.push({ role: 'judge', value: susSettings!.judge, auto: false, missing: !has(susSettings!.judge), options: files });
      const rs = this.runs.get(this.runKey(dir, mode));
      const running = !!rs && (rs.compiling || !!rs.run);
      const missing = slots.filter((x) => x.missing);
      let disabled: string | undefined;
      if (mode === 'wa' && interactive) disabled = 'Interactive problem: use RE stress with a judge.';
      let reason: string | undefined;
      if (missing.length) reason = `pick ${missing.map((x) => (x.role === 'checker' ? `checker (${x.value})` : x.role === 'judge' ? `judge (${x.value})` : x.role)).join(', ')}`;
      out[mode] = {
        open: meta.open[mode],
        slots,
        shrink: this.shrinkOf(meta, mode),
        canRun: !disabled && !missing.length,
        reason,
        needsSetup: !disabled && (mode === 'wa' ? !has(s.brute.value) || !has(s.gen.value) : !has(s.gen.value)),
        running,
        disabled,
        status: rs?.status,
        compare: mode === 'wa' && susSettings ? { mode: susSettings.compare, precision: susSettings.precision } : undefined,
        susName: s.sus.value || undefined,
      };
    }
    return out;
  }

  /** The folder's slider position, or the cp2.stress.shrinkSeconds default if it was never moved. */
  private shrinkOf(meta: DirMeta, mode: 'wa' | 're'): number {
    return meta.shrink[mode] ?? shrinkIndex(this.c.cfg().stress.shrinkSeconds);
  }

  async onMessage(active: string, m: Extract<FromWebview, { type: `stress${string}` }>): Promise<void> {
    const dir = path.dirname(active);
    const meta = await this.meta(dir);
    switch (m.type) {
      case 'stressOpen':
        meta.open[m.mode] = m.open;
        await this.saveMeta(dir);
        break;
      case 'stressShrink':
        meta.shrink[m.mode] = Math.max(0, Math.min(SHRINK_STEPS.length - 1, m.index));
        await this.saveMeta(dir);
        break;
      case 'stressPick': {
        if (m.role === 'checker' || m.role === 'judge') {
          const listing = await this.c.dirs.get(dir);
          const sus = this.slots(dir, listing, active, meta)[m.mode].sus.value;
          if (sus) (await this.c.getProblem(path.join(dir, sus))).updateSettings(m.role === 'checker' ? { checker: m.value } : { judge: m.value });
        } else {
          if (m.value) meta[m.mode][m.role] = m.value;
          else delete meta[m.mode][m.role];
          await this.saveMeta(dir);
        }
        break;
      }
      case 'stressSetting': {
        const listing = await this.c.dirs.get(dir);
        const sus = this.slots(dir, listing, active, meta)[m.mode].sus.value;
        if (sus) (await this.c.getProblem(path.join(dir, sus))).updateSettings(m.patch);
        break;
      }
      case 'stressSetup':
        await this.setup(active, m.mode);
        return;
      case 'stressRun':
        await this.run(active, m.mode);
        return;
      case 'stressStop':
        this.runs.get(this.runKey(dir, m.mode))?.run?.stop();
        break;
    }
    this.c.requestRender(0);
  }

  // ---------------- Set up: x.cpp -> x/x.cpp + xbrute.cpp + gen.cpp ----------------

  private async setup(file: string, mode: Mode): Promise<void> {
    const p = await this.c.getProblem(file);
    const cfg = this.c.cfg();
    const store = p.store;
    const tplRel = cfg.stress.genTemplate;
    const tplPath = tplRel ? (path.isAbsolute(tplRel) ? tplRel : path.join(store.base, tplRel)) : '';
    const genExt = tplPath && (await exists(tplPath)) ? path.extname(tplPath) || '.cpp' : '.cpp';
    const plan = await planSetup(file, mode, p.meta.settings.compileWith, genExt);
    if (plan.error) {
      void vscode.window.showErrorMessage(`cp2: ${plan.error}`);
      return;
    }
    await this.c.saveIfDirty(file);
    if (plan.removeExecutable) await fsp.rm(plan.removeExecutable, { force: true });
    let sus = file;
    if (plan.needMove) {
      await fsp.mkdir(plan.targetDir, { recursive: true });
      // The rename event moves the test cases; wait for that before touching the new location.
      const moved = this.c.waitForMove(plan.susTarget, 5000);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(file), vscode.Uri.file(plan.susTarget), { overwrite: false });
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok || !(await exists(plan.susTarget))) {
        void vscode.window.showErrorMessage(`cp2: couldn't move ${path.basename(file)} into ${path.basename(plan.targetDir)}/`);
        return;
      }
      await moved;
      sus = plan.susTarget;
      for (const [src, dst] of plan.copy) await copyFileP(src, dst);
    }
    const opened: string[] = [];
    if (plan.createBrute) {
      await atomicWrite(plan.createBrute, (await readText(sus)) ?? '');
      opened.push(plan.createBrute);
    }
    if (plan.createGen) {
      let text = defaultGen(path.extname(plan.createGen));
      let cursor: { line: number; character: number } | null = null;
      const tpl = tplPath ? await readText(tplPath) : null;
      if (tpl !== null) {
        const r = resolveSnippet(tpl, { vars: snippetVars(plan.createGen), insertSpaces: cfg.newFile.insertSpaces, tabSize: cfg.newFile.tabSize });
        text = r.text;
        cursor = r.cursor;
      }
      await atomicWrite(plan.createGen, text);
      if (cursor) {
        const gp = await this.c.getProblem(plan.createGen);
        gp.meta.snippetCursor = cursor;
        await gp.flush();
      }
      opened.push(plan.createGen);
    }
    const meta = await this.meta(plan.targetDir);
    const base = path.basename(sus);
    meta.wa.sus = meta.wa.sus ?? base;
    meta.re.sus = meta.re.sus ?? base;
    if (plan.createBrute) meta.wa.brute = path.basename(plan.createBrute);
    if (plan.createGen) meta.wa.gen = meta.re.gen = path.basename(plan.createGen);
    meta.open[mode] = true;
    await this.saveMeta(plan.targetDir);
    this.c.dirs.invalidate(plan.targetDir);
    this.c.dirs.invalidate(path.dirname(file));
    for (const f of opened) await vscode.window.showTextDocument(vscode.Uri.file(f), { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Active });
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(sus), { preview: false, preserveFocus: false });
    await this.c.setActive(sus, ed);
  }

  // ---------------- Run ----------------

  private async run(active: string, mode: Mode): Promise<void> {
    const dir = path.dirname(active);
    const key = this.runKey(dir, mode);
    if (this.runs.get(key)?.run || this.runs.get(key)?.compiling) return;
    const listing = await this.c.dirs.get(dir);
    const meta = await this.meta(dir);
    const s = this.slots(dir, listing, active, meta)[mode];
    const susFile = path.join(dir, s.sus.value);
    const sp = await this.c.getProblem(susFile);
    const st = sp.meta.settings;
    const cfg = this.c.cfg();
    const rs: RunState = { run: null, compiling: true, status: { state: 'compiling', text: 'compiling…' } };
    this.runs.set(key, rs);
    this.c.requestRender(0);

    const kind = mode === 'wa' ? 'stressWA' : 'stressRE';
    const jobs: Promise<[string, Awaited<ReturnType<Controller['build']>>]>[] = [
      this.c.build(susFile, kind).then((b) => ['sus', b]),
      this.c.build(path.join(dir, s.gen.value), 'stressWA').then((b) => ['gen', b]),
    ];
    if (mode === 'wa') jobs.push(this.c.build(path.join(dir, s.brute.value), 'stressWA').then((b) => ['brute', b]));
    if (mode === 'wa' && st.compare === 'checker') jobs.push(this.c.build(path.join(dir, st.checker), 'helper').then((b) => ['checker', b]));
    if (mode === 're' && st.interactive) jobs.push(this.c.build(path.join(dir, st.judge), 'helper', st).then((b) => ['judge', b]));
    let built: Record<string, Awaited<ReturnType<Controller['build']>>>;
    try {
      built = Object.fromEntries(await Promise.all(jobs));
    } catch (e) {
      rs.compiling = false;
      rs.status = { state: 'error', text: `build failed: ${e}` };
      this.c.requestRender(0);
      return;
    }
    const broken = Object.entries(built).find(([, b]) => !b.ok);
    if (broken) {
      rs.compiling = false;
      const name = broken[0] === 'sus' ? s.sus.value : broken[0] === 'gen' ? s.gen.value : broken[0] === 'brute' ? s.brute.value : broken[0] === 'checker' ? st.checker : st.judge;
      rs.status = { state: 'error', text: `${name} doesn't compile`, detail: broken[1].output };
      this.c.requestRender(0);
      return;
    }
    if (mode === 're') {
      // A stale `ans` from an earlier WA run would show up as the expected output.
      const ans = path.join(dir, 'ans');
      const stt = await statOrNull(ans);
      if (stt && meta.ansFromStress && Math.floor(stt.mtimeMs) === meta.ansFromStress) {
        await fsp.rm(ans, { force: true });
        delete meta.ansFromStress;
        await this.saveMeta(dir);
      }
    }
    const store = sp.store;
    const sc: StressConfig = {
      mode,
      dir,
      scratch: path.join(store.runsRoot, 'stress', sha1(dir).slice(0, 12) + '-' + mode),
      sus: { cmd: built.sus.cmd, cwd: dir },
      brute: built.brute ? { cmd: built.brute.cmd, cwd: dir } : undefined,
      gen: { cmd: built.gen.cmd, cwd: dir },
      checker: built.checker ? { cmd: built.checker.cmd, cwd: dir } : undefined,
      judge: built.judge ? { cmd: built.judge.cmd, cwd: dir } : undefined,
      judgeInput: st.judgeInput,
      compare: st.compare,
      precision: st.precision,
      workers: Math.max(1, cfg.stress.workers),
      maxIterations: cfg.stress.maxIterations,
      shrinkMs: SHRINK_STEPS[this.shrinkOf(meta, mode)] * 1000,
      susTimeLimitMs: this.c.timeLimit(sp),
      helperTimeoutMs: cfg.stress.helperTimeoutMs,
      limits: this.c.limits(),
      publishIntervalMs: 150,
    };
    const run = new StressRun(sc);
    rs.run = run;
    rs.compiling = false;
    this.caseResults.delete(dir);
    run.on('status', (x: StressStatus) => {
      rs.status = this.statusVM(x);
      if (this.c.active && path.dirname(this.c.active) === dir) this.c.requestRender(120);
    });
    run.on('publish', () => {
      for (const f of [path.join(dir, 'in'), path.join(dir, 'ans')]) this.invalidateFile(dir, f);
    });
    const final = await run.start();
    rs.run = null;
    rs.status = this.statusVM(final);
    for (const f of [path.join(dir, 'in'), path.join(dir, 'ans')]) this.invalidateFile(dir, f);
    this.c.dirs.invalidate(dir);
    if (final.state === 'found' && final.failure) {
      const f = final.failure;
      if (mode === 'wa' && f.answerFile) {
        const ast = await statOrNull(f.answerFile);
        if (ast) {
          meta.ansFromStress = Math.floor(ast.mtimeMs);
          await this.saveMeta(dir);
        }
      }
      const result: CaseResult = {
        verdict: f.verdict,
        timeMs: f.timeMs,
        detail: `${f.message} · stress run ${f.iteration}`,
        outFile: f.outputFile,
        stderr: f.stderr,
        diff: f.diff,
        transcript: f.events?.filter((e) => e.kind !== 'judgeErr').map((e) => ({ k: e.kind as 'in' | 'out' | 'err', t: e.text })),
        at: Date.now(),
      };
      this.caseResults.set(dir, result);
      this.c.requestRender(0);
      setTimeout(() => this.c.poster?.post({ type: 'reveal', key: 'f:in' }), 120);
      void this.debugRerun(dir, susFile, result);
    } else this.c.requestRender(0);
  }

  /** Rerun the failing test with the normal (-DLOCAL) build so dbg() output is visible. */
  private async debugRerun(dir: string, susFile: string, result: CaseResult): Promise<void> {
    const sp = await this.c.getProblem(susFile);
    if (sp.meta.settings.interactive) return;
    const b = await this.c.build(susFile, 'debug');
    if (!b.ok) {
      result.debugStderr = `(debug build failed)\n${b.output}`;
    } else {
      const out = path.join(this.c.runDir(await this.c.getSession(susFile)), 'stress-debug.out');
      const r = await runProcess({ cmd: b.cmd, cwd: dir, stdin: { file: path.join(dir, 'in') }, stdoutFile: out, timeLimitMs: Math.max(5000, this.c.timeLimit(sp) * 3), limits: this.c.limits() });
      const v = classifyRun(r);
      result.debugStderr = r.stderr + (v !== 'OK' ? `\n[debug build: ${describeExit(r)}]` : '');
    }
    for (const s of [this.c.sessionIfLoaded(susFile), this.c.active ? this.c.sessionIfLoaded(this.c.active) : undefined]) s?.invalidateText('f:in|dbg');
    this.c.requestRender(0);
  }

  private invalidateFile(dir: string, file: string): void {
    for (const s of this.c.sessionsIn(dir)) s.invalidateFile(file);
  }

  private statusVM(x: StressStatus): StressStatusVM {
    const runs = x.iterations.toLocaleString('en-US');
    const rate = x.rate >= 100 ? `${Math.round(x.rate).toLocaleString('en-US')}/s` : `${x.rate.toFixed(1)}/s`;
    const secs = `${(x.elapsedMs / 1000).toFixed(1)} s`;
    switch (x.state) {
      case 'running':
        return { state: 'running', text: `${runs} runs · ${rate} · ${secs}` };
      case 'shrinking':
        return { state: 'shrinking', text: `failure found · looking for a smaller one (${((x.shrinkLeftMs ?? 0) / 1000).toFixed(1)} s left, best ${x.bestSize} B) · ${runs} runs` };
      case 'found':
        return { state: 'found', text: `${x.failure?.verdict} after ${runs} runs (${secs}) — see the in case`, detail: x.failure?.message };
      case 'clean':
        return { state: 'clean', text: `no failure in ${runs} runs (${secs})` };
      case 'stopped':
        return { state: 'stopped', text: `stopped after ${runs} runs` };
      default:
        return { state: 'error', text: x.message ?? 'error', detail: x.detail };
    }
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.run?.stop();
  }
}
