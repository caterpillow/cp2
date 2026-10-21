// Stress sections at the bottom of the sidebar: pickers, Set up, Run/Stop, live status.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { atomicWrite, copyFileP, exists, formatBytes, mkdirp, readText, sha1, statOrNull } from '../core/fsutil';
import { isSourceFile } from '../core/lang';
import { classifyRun, describeExit, runProcess } from '../core/runner';
import { resolveSnippet, snippetVars } from '../core/snippet';
import { caseLabel, DirMeta, loadDirMeta, saveDirMeta, SHRINK_STEPS, shrinkIndex, storedKey } from '../core/store';
import { StressConfig, StressLive, StressRun, StressStatus } from '../core/stress';
import { autofill, defaultGen, plain, planSetup, Slot } from '../core/stressFiles';
import type { FromWebview, GenSectionVM, SectionMode, SlotVM, StressSectionVM, StressStatusVM } from '../../../shared/viewModel';
import type { Controller } from './controller';
import type { DirListing } from './dirIndex';
import type { CaseResult } from './session';

type Mode = 'wa' | 're';

interface RunState {
  run: StressRun | null;
  compiling: boolean;
  /** Stopped while compiling: don't start once the builds finish. */
  cancelled?: boolean;
  status: StressStatusVM | undefined;
}

export class StressHost {
  private metas = new Map<string, Promise<DirMeta>>();
  private runs = new Map<string, RunState>();
  private caseResults = new Map<string, CaseResult>();
  /** "Gen case" in progress / last outcome, per folder. */
  private genRuns = new Map<string, { running: boolean; status?: StressStatusVM }>();
  /** Files the stress case was shown for this session (so hiding it afterwards sticks). */
  private stressShownFor = new Set<string>();

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

  /**
   * Where generated cases go: the open file when it's a solution, else the folder's sus (with gen.cpp or a brute
   * open, the case is still meant for the solution).
   */
  private async genTarget(dir: string, listing: DirListing, active: string, meta: DirMeta, gen: string): Promise<string | null> {
    const sl = this.slots(dir, listing, active, meta);
    // Every program the folder's pickers use as a helper (a hand-picked ref.cpp or chk.cpp isn't the solution).
    const helpers = new Set([gen, meta.gen.brute, meta.wa.brute, meta.wa.gen, meta.re.gen, sl.wa.brute.value]);
    for (const sus of [sl.wa.sus.value, sl.re.sus.value]) {
      if (!sus || !listing.files.includes(sus)) continue;
      const st = (await this.c.getProblem(path.join(dir, sus))).meta.settings;
      if (st.compare === 'checker') helpers.add(st.checker);
      if (st.interactive) helpers.add(st.judge);
    }
    const other = (n: string) => !!n && !helpers.has(n) && listing.files.includes(n);
    const a = path.basename(active);
    if (path.dirname(active) === dir && plain(a) && other(a)) return active;
    const sus = [sl.wa.sus.value, sl.re.sus.value].find(other);
    return sus ? path.join(dir, sus) : null;
  }

  /** The generator of "Generate test case": its own pick, else the stress sections' pick, else gen.cpp / gen.py / gen*. */
  private genSlot(dir: string, listing: DirListing, active: string, meta: DirMeta): Slot {
    const own = meta.gen.gen && listing.files.includes(meta.gen.gen) ? meta.gen.gen : undefined;
    if (own) return { value: own, auto: false };
    // The stress sections' gen counts as a suggestion here (shown as "auto").
    const picked = [meta.wa.gen, meta.re.gen].find((n) => !!n && listing.files.includes(n));
    return picked ? { value: picked, auto: true } : autofill(dir, listing.files, active, {}).gen;
  }

  async sections(active: string, listing: DirListing): Promise<{ gen: GenSectionVM; wa: StressSectionVM; re: StressSectionVM }> {
    const dir = path.dirname(active);
    const meta = await this.meta(dir);
    const files = listing.files.filter(isSourceFile).sort();
    const sl = this.slots(dir, listing, active, meta);
    const has = (n: string) => !!n && listing.files.includes(n);
    const out = {} as { gen: GenSectionVM; wa: StressSectionVM; re: StressSectionVM };
    const g = this.genSlot(dir, listing, active, meta);
    const target = await this.genTarget(dir, listing, active, meta, g.value);
    // Interactive: the generated file is the judge's input; there's no expected output to fill.
    const interactive = !!target && (await this.c.getProblem(target)).meta.settings.interactive;
    const answer = interactive ? '' : (meta.gen.brute ?? '');
    const gr = this.genRuns.get(dir);
    const genSlots: SlotVM[] = [{ role: 'gen', value: g.value, auto: g.auto, missing: !has(g.value), options: files }];
    if (!interactive) genSlots.push({ role: 'answer', value: answer, auto: false, missing: !!answer && !has(answer), options: files, optional: true });
    out.gen = {
      open: meta.open.gen,
      slots: genSlots,
      canRun: has(g.value) && !!target && (!answer || has(answer)),
      reason: !has(g.value) ? 'pick a generator (or Set up)' : !target ? 'open the solution file' : answer && !has(answer) ? `${answer} doesn't exist` : undefined,
      needsSetup: !has(g.value),
      running: !!gr?.running,
      status: gr?.status,
      genName: has(g.value) ? g.value : undefined,
      targetName: target ? path.basename(target) : undefined,
    };
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
        if (m.mode === 'gen') {
          const k = m.role === 'answer' ? 'brute' : 'gen';
          if (m.value) meta.gen[k] = m.value;
          else delete meta.gen[k];
          await this.saveMeta(dir);
        } else if (m.role === 'checker' || m.role === 'judge') {
          const listing = await this.c.dirs.get(dir);
          const sus = this.slots(dir, listing, active, meta)[m.mode].sus.value;
          if (sus) (await this.c.getProblem(path.join(dir, sus))).updateSettings(m.role === 'checker' ? { checker: m.value } : { judge: m.value });
        } else {
          const role = m.role as 'sus' | 'brute' | 'gen';
          if (m.value) meta[m.mode][role] = m.value;
          else delete meta[m.mode][role];
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
        // Moves the file and its cases: not while case edits / undo are being applied.
        await this.c.serial(() => this.setup(active, m.mode));
        return;
      case 'stressRun':
        await this.run(active, m.mode);
        return;
      case 'stressStop': {
        const rs = this.runs.get(this.runKey(dir, m.mode));
        if (rs) this.stopRun(rs);
        break;
      }
    }
    this.c.requestRender(0);
  }

  // ---------------- Set up: x.cpp -> x/x.cpp + xbrute.cpp + gen.cpp ----------------

  private async setup(file: string, mode: SectionMode): Promise<void> {
    const p = await this.c.getProblem(file);
    const cfg = this.c.cfg();
    const store = p.store;
    const tplRel = cfg.stress.genTemplate;
    const tplPath = tplRel ? (path.isAbsolute(tplRel) ? tplRel : path.join(store.base, tplRel)) : '';
    const genExt = tplPath && (await exists(tplPath)) ? path.extname(tplPath) || '.cpp' : '.cpp';
    // "Generate test case" needs what RE stress needs: its own folder and a gen.
    const plan = await planSetup(file, mode === 'wa' ? 'wa' : 're', p.meta.settings.compileWith, genExt);
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
    if (plan.createGen) meta.gen.gen = meta.wa.gen = meta.re.gen = path.basename(plan.createGen);
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
      if (rs.cancelled) return;
    } catch (e) {
      if (rs.cancelled) return;
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
    // The stress case lives in `in` / `ans`: show it for sus and for the file you're looking at.
    void this.showStressCase([susFile, active]);
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
    // Stopped (or started again) while we were getting here: don't start a second run on the same folder.
    if (rs.cancelled || this.runs.get(key) !== rs) {
      this.c.requestRender(0);
      return;
    }
    const run = new StressRun(sc);
    rs.run = run;
    rs.compiling = false;
    this.caseResults.delete(dir);
    run.on('status', (x: StressStatus) => {
      rs.status = this.statusVM(x);
      if (this.c.active && path.dirname(this.c.active) === dir) this.c.requestRender(120);
    });
    let published = false;
    run.on('publish', (live: StressLive) => {
      // `in` / `ans` may have just been created: don't wait for the file watcher to list them.
      if (!published) this.c.dirs.invalidate(dir);
      published = true;
      for (const f of [path.join(dir, 'in'), path.join(dir, 'ans')]) this.invalidateFile(dir, f);
      if (live.outputFile) this.invalidateFile(dir, live.outputFile);
      this.invalidateText(dir, 'f:in|err');
      this.caseResults.set(dir, { verdict: 'RUNNING', live: true, timeMs: live.timeMs, detail: `stress run ${live.iteration.toLocaleString('en-US')} · passed`, outFile: live.outputFile, stderr: live.stderr, at: Date.now() });
      if (this.c.active && path.dirname(this.c.active) === dir) this.c.requestRender(120);
    });
    const final = await run.start();
    rs.run = null;
    rs.status = this.statusVM(final);
    for (const f of [path.join(dir, 'in'), path.join(dir, 'ans')]) this.invalidateFile(dir, f);
    this.c.dirs.invalidate(dir);
    const live = this.caseResults.get(dir);
    if (live?.live) {
      // The last test shown passed; after an error, `in` holds gen's / brute's input instead.
      if (final.state === 'clean' || final.state === 'stopped') this.caseResults.set(dir, { ...live, verdict: 'AC' });
      else this.caseResults.delete(dir);
    }
    // ...and for whatever is open in this folder by the time it ends.
    if ((final.state === 'found' || final.state === 'error') && this.c.active && path.dirname(this.c.active) === dir) await this.showStressCase([this.c.active]);
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
      this.c.reveal('f:in');
      void this.debugRerun(dir, susFile, result);
    } else this.c.requestRender(0);
  }

  private showStressCase(files: string[]): Promise<void> {
    for (const f of files) this.stressShownFor.add(f);
    // Through the case-change queue, so it can't land inside an undo step being recorded.
    return this.c
      .serial(async () => {
        for (const f of new Set(files)) (await this.c.getProblem(f)).showFile('in', true);
        this.c.requestRender();
      })
      .catch((e) => this.c.log(`showing the stress case failed: ${e}`));
  }

  /** A file was opened: in a folder with a stress run this session, show the stress case once (a later hide sticks). */
  async opened(file: string): Promise<void> {
    if (this.stressShownFor.has(file) || !this.isStressDir(path.dirname(file))) return;
    await this.showStressCase([file]);
  }

  // ---------------- Gen case ----------------

  /** Runs the folder's generator once (seed in argv[1]) and adds the output as a new case of `active`. */
  async genCase(active: string): Promise<void> {
    const dir = path.dirname(active);
    if (this.genRuns.get(dir)?.running) return;
    const gs: { running: boolean; status?: StressStatusVM } = { running: true, status: { state: 'compiling', text: 'compiling…' } };
    this.genRuns.set(dir, gs);
    this.c.requestRender(0);
    const meta = await this.meta(dir);
    const fail = async (text: string, detail?: string) => {
      gs.running = false;
      gs.status = { state: 'error', text, detail: detail?.trim().slice(0, 4000) || undefined };
      if (!meta.open.gen) {
        meta.open.gen = true;
        await this.saveMeta(dir);
      }
      this.c.requestRender(0);
    };
    try {
      await this.genCaseSteps(active, dir, meta, gs, fail);
    } catch (e) {
      await fail(`couldn't generate a case: ${(e as Error).message ?? e}`);
    }
  }

  private async genCaseSteps(active: string, dir: string, meta: DirMeta, gs: { running: boolean; status?: StressStatusVM }, fail: (text: string, detail?: string) => Promise<void>): Promise<void> {
    const listing = await this.c.dirs.get(dir);
    const gen = this.genSlot(dir, listing, active, meta).value;
    if (!gen || !listing.files.includes(gen)) return fail('no generator: pick one or Set up');
    const target = await this.genTarget(dir, listing, active, meta, gen);
    if (!target) return fail('open the solution file first');
    const p = await this.c.getProblem(target);
    const answer = p.meta.settings.interactive ? undefined : meta.gen.brute;
    if (answer && !listing.files.includes(answer)) return fail(`${answer} doesn't exist`);
    let built: Awaited<ReturnType<Controller['build']>>[];
    try {
      built = await Promise.all([this.c.build(path.join(dir, gen), 'stressWA'), ...(answer ? [this.c.build(path.join(dir, answer), 'stressWA')] : [])]);
    } catch (e) {
      return fail(`build failed: ${e}`);
    }
    if (!built[0].ok) return fail(`${gen} doesn't compile`, built[0].output);
    if (built[1] && !built[1].ok) return fail(`${answer} doesn't compile`, built[1].output);
    gs.status = { state: 'running', text: 'generating…' };
    this.c.requestRender(0);
    const cfg = this.c.cfg();
    const work = path.join(p.store.runsRoot, 'gen', sha1(dir).slice(0, 12));
    await mkdirp(work);
    const inF = path.join(work, 'in');
    const ansF = path.join(work, 'ans');
    // Like stress (which passes the run number): gens that read argv[1] get a different seed each time.
    const seed = 1 + Math.floor(Math.random() * 2147483646);
    const limits = this.c.limits();
    const g = await runProcess({ cmd: [...built[0].cmd, String(seed)], cwd: dir, stdin: 'ignore', stdoutFile: inF, timeLimitMs: cfg.stress.helperTimeoutMs, limits, maxStderr: 16384 });
    if (classifyRun(g) !== 'OK') return fail(`${gen} failed: ${describeExit(g)}`, g.stderr);
    let expected: string | null = null;
    let note = '';
    if (built[1]) {
      const b = await runProcess({ cmd: built[1].cmd, cwd: dir, stdin: { file: inF }, stdoutFile: ansF, timeLimitMs: cfg.stress.helperTimeoutMs, limits, maxStderr: 16384 });
      if (classifyRun(b) === 'OK') expected = ansF;
      else note = ` · ${answer} failed (${describeExit(b)}), so no expected output`;
    }
    const size = (await statOrNull(inF))?.size ?? 0;
    // recordList follows the file if it was moved while generating (and refuses if it's gone).
    const { value: added, file } = await this.c.serial(() =>
      this.c.recordList(target, 'generating a case', async (q) => {
        const c = await q.addCaseFromFiles(inF, expected);
        return { key: storedKey(c.id), label: caseLabel(q.meta, c.id) };
      }),
    );
    const where = file === this.c.active ? '' : ` to ${path.basename(file)}`;
    gs.running = false;
    gs.status = { state: note ? 'error' : 'clean', text: `added ${added.label}${where} · ${formatBytes(size)}${note}` };
    this.c.requestRender(0);
    if (file === this.c.active) this.c.reveal(added.key, { expand: true });
    else this.c.notice(`Added ${added.label}${where}`);
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

  private invalidateText(dir: string, id: string): void {
    for (const s of this.c.sessionsIn(dir)) s.invalidateText(id);
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

  /** Stop at once, including while still compiling. */
  private stopRun(rs: RunState): void {
    if (rs.run) rs.run.stop();
    else if (rs.compiling) {
      rs.cancelled = true;
      rs.compiling = false;
      rs.status = { state: 'stopped', text: 'stopped before it started' };
    }
  }

  stopAll(): void {
    for (const r of this.runs.values()) this.stopRun(r);
  }
}
