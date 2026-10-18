// Stress testing, checker.py-style: gen > in, brute < in > ans, sus < in, compare. Several
// workers run in parallel in private scratch folders; the visible `in`/`ans` files are refreshed
// a few times a second and finally hold the failing test.

import { EventEmitter } from 'events';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { compareFiles, DiffInfo } from './compare';
import { copyFileP, mkdirp, statOrNull } from './fsutil';
import { InterEvent, runChecker, runInteractive } from './interactive';
import { classifyRun, describeExit, Limits, runProcess } from './runner';
import type { CompareMode } from './store';

export interface StressProgram {
  cmd: string[];
  cwd: string;
}

export interface StressConfig {
  mode: 'wa' | 're';
  /** Folder whose `in` / `ans` files show the current test. */
  dir: string;
  scratch: string;
  sus: StressProgram;
  brute?: StressProgram;
  gen: StressProgram;
  checker?: StressProgram;
  judge?: StressProgram;
  judgeInput: 'stdin' | 'argv';
  compare: CompareMode;
  precision: number;
  workers: number;
  maxIterations: number;
  /** Keep looking this long after the first failure for a smaller failing input. */
  shrinkMs: number;
  susTimeLimitMs: number;
  helperTimeoutMs: number;
  limits: Limits;
  publishIntervalMs: number;
}

export type StressState = 'running' | 'shrinking' | 'found' | 'clean' | 'stopped' | 'error';

export interface StressFailure {
  verdict: 'WA' | 'RE' | 'TLE' | 'OLE';
  iteration: number;
  size: number;
  /** Published copies in the stress folder. */
  inputFile: string;
  answerFile?: string;
  /** sus's output on the failing test. */
  outputFile: string;
  stderr: string;
  message: string;
  diff?: DiffInfo;
  events?: InterEvent[];
  timeMs: number;
}

export interface StressStatus {
  mode: 'wa' | 're';
  state: StressState;
  iterations: number;
  elapsedMs: number;
  rate: number;
  message?: string;
  /** Extra detail for errors (e.g. gen's stderr). */
  detail?: string;
  failure?: StressFailure;
  /** Size of the smallest failing input found so far while shrinking. */
  bestSize?: number;
  shrinkLeftMs?: number;
}

interface Pending {
  verdict: StressFailure['verdict'];
  stderr: string;
  message: string;
  diff?: DiffInfo;
  events?: InterEvent[];
  timeMs: number;
}

export class StressRun extends EventEmitter {
  private abort = new AbortController();
  private started = 0;
  private completed = 0;
  private t0 = 0;
  private state: StressState = 'running';
  private message?: string;
  private detail?: string;
  private best: (Pending & { iteration: number; size: number }) | null = null;
  private failureChain: Promise<void> = Promise.resolve();
  private shrinkDeadline = 0;
  private shrinkTimer: NodeJS.Timeout | undefined;
  private lastPublish = 0;
  private publishing = false;
  private finished = false;
  private resolveDone!: (s: StressStatus) => void;
  readonly done: Promise<StressStatus>;
  private final: StressFailure | undefined;

  constructor(readonly cfg: StressConfig) {
    super();
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  status(): StressStatus {
    const elapsedMs = this.t0 ? Math.round(performance.now() - this.t0) : 0;
    return {
      mode: this.cfg.mode,
      state: this.state,
      iterations: this.completed,
      elapsedMs,
      rate: elapsedMs > 0 ? (this.completed * 1000) / elapsedMs : 0,
      message: this.message,
      detail: this.detail,
      failure: this.final,
      bestSize: this.best?.size,
      shrinkLeftMs: this.state === 'shrinking' ? Math.max(0, Math.round(this.shrinkDeadline - performance.now())) : undefined,
    };
  }

  async start(): Promise<StressStatus> {
    this.t0 = performance.now();
    await fsp.rm(this.cfg.scratch, { recursive: true, force: true }).catch(() => undefined);
    await mkdirp(this.cfg.scratch);
    const ticker = setInterval(() => this.emit('status', this.status()), 200);
    const workers = Array.from({ length: Math.max(1, this.cfg.workers) }, (_, k) => this.worker(k));
    await Promise.all(workers);
    await this.failureChain;
    clearInterval(ticker);
    if (!this.finished) await this.finish(this.best ? 'found' : this.state === 'error' ? 'error' : this.abort.signal.aborted ? 'stopped' : 'clean');
    return this.done;
  }

  stop(): void {
    if (this.finished || this.abort.signal.aborted) return;
    if (this.state === 'shrinking') {
      // Stopping while shrinking keeps the best failure found so far.
      void this.endShrink();
      return;
    }
    this.state = 'stopped';
    this.message = 'stopped';
    this.abort.abort();
  }

  private async worker(k: number): Promise<void> {
    const c = this.cfg;
    const wdir = path.join(c.scratch, `w${k}`);
    await mkdirp(wdir);
    const inF = path.join(wdir, 'in');
    const ansF = path.join(wdir, 'ans');
    const outF = path.join(wdir, 'out');
    const signal = this.abort.signal;
    while (!signal.aborted) {
      if (this.started >= c.maxIterations && c.maxIterations > 0) break;
      const it = ++this.started;
      const g = await runProcess({ cmd: [...c.gen.cmd, String(it)], cwd: c.gen.cwd, stdin: 'ignore', stdoutFile: inF, timeLimitMs: c.helperTimeoutMs, limits: c.limits, maxStderr: 16384 }, signal);
      if (signal.aborted) break;
      if (classifyRun(g) !== 'OK') {
        await this.error(`gen failed: ${describeExit(g)}`, g.stderr, inF);
        break;
      }
      let failure: Pending | null = null;
      if (c.mode === 'wa') {
        const b = await runProcess({ cmd: c.brute!.cmd, cwd: c.brute!.cwd, stdin: { file: inF }, stdoutFile: ansF, timeLimitMs: c.helperTimeoutMs, limits: c.limits, maxStderr: 16384 }, signal);
        if (signal.aborted) break;
        if (classifyRun(b) !== 'OK') {
          await this.error(`brute failed: ${describeExit(b)}`, b.stderr, inF);
          break;
        }
        const s = await runProcess({ cmd: c.sus.cmd, cwd: c.sus.cwd, stdin: { file: inF }, stdoutFile: outF, timeLimitMs: c.susTimeLimitMs, limits: c.limits, maxStderr: 65536 }, signal);
        if (signal.aborted) break;
        const v = classifyRun(s);
        if (v === 'STOPPED') break;
        if (v !== 'OK') {
          failure = { verdict: v === 'ERR' ? 'RE' : v, stderr: s.stderr, message: describeExit(s), timeMs: s.timeMs };
        } else if (c.compare === 'checker' && c.checker) {
          const r = await runChecker(c.checker.cmd, c.checker.cwd, inF, outF, ansF, c.limits, c.helperTimeoutMs);
          if (signal.aborted) break;
          if (r.error) {
            await this.error(r.message, '', inF);
            break;
          }
          if (!r.pass) failure = { verdict: 'WA', stderr: s.stderr, message: r.message, timeMs: s.timeMs };
        } else {
          const r = await compareFiles(ansF, outF, c.compare, c.precision);
          if (!r.pass) failure = { verdict: 'WA', stderr: s.stderr, message: r.message ?? 'wrong answer', diff: r.diff, timeMs: s.timeMs };
        }
      } else if (c.judge) {
        const r = await runInteractive({ program: c.sus.cmd, judge: c.judge.cmd, cwd: c.sus.cwd, testFile: inF, judgeInput: c.judgeInput, timeLimitMs: c.susTimeLimitMs, limits: c.limits, maxEvents: 5000 }, signal);
        if (signal.aborted || r.verdict === 'STOPPED') break;
        if (r.verdict === 'ERR') {
          await this.error(r.message, '', inF);
          break;
        }
        if (r.verdict !== 'AC') {
          await fsp.writeFile(outF, r.events.filter((e) => e.kind === 'out').map((e) => e.text).join('\n') + '\n');
          failure = { verdict: r.verdict === 'WA' ? 'WA' : r.verdict === 'TLE' ? 'TLE' : 'RE', stderr: r.events.filter((e) => e.kind === 'err').map((e) => e.text).join('\n'), message: r.message, events: r.events, timeMs: r.timeMs };
        }
      } else {
        const s = await runProcess({ cmd: c.sus.cmd, cwd: c.sus.cwd, stdin: { file: inF }, stdoutFile: outF, timeLimitMs: c.susTimeLimitMs, limits: c.limits, maxStderr: 65536 }, signal);
        if (signal.aborted) break;
        const v = classifyRun(s);
        if (v === 'STOPPED') break;
        if (v !== 'OK') failure = { verdict: v === 'ERR' ? 'RE' : v, stderr: s.stderr, message: describeExit(s), timeMs: s.timeMs };
      }
      this.completed++;
      if (failure) await this.onFailure(it, failure, inF, ansF, outF);
      else await this.maybePublish(inF, ansF);
    }
  }

  private async maybePublish(inF: string, ansF: string): Promise<void> {
    const now = performance.now();
    if (this.publishing || this.state !== 'running' || now - this.lastPublish < this.cfg.publishIntervalMs) return;
    this.publishing = true;
    this.lastPublish = now;
    try {
      await copyFileP(inF, path.join(this.cfg.dir, 'in'));
      if (this.cfg.mode === 'wa') await copyFileP(ansF, path.join(this.cfg.dir, 'ans'));
      this.emit('publish');
    } catch {
      /* the folder may be gone; ignore */
    } finally {
      this.publishing = false;
    }
  }

  private onFailure(iteration: number, f: Pending, inF: string, ansF: string, outF: string): Promise<void> {
    this.failureChain = this.failureChain.then(async () => {
      if (this.finished) return;
      const size = (await statOrNull(inF))?.size ?? 0;
      if (!this.best || size < this.best.size) {
        const bdir = path.join(this.cfg.scratch, 'best');
        await copyFileP(inF, path.join(bdir, 'in'));
        if (this.cfg.mode === 'wa') await copyFileP(ansF, path.join(bdir, 'ans'));
        await copyFileP(outF, path.join(bdir, 'out'));
        this.best = { ...f, iteration, size };
      }
      if (this.state === 'running') {
        if (this.cfg.shrinkMs <= 0) {
          await this.endShrink();
        } else {
          this.state = 'shrinking';
          this.shrinkDeadline = performance.now() + this.cfg.shrinkMs;
          this.shrinkTimer = setTimeout(() => void this.endShrink(), this.cfg.shrinkMs);
          this.emit('status', this.status());
        }
      }
    });
    return this.failureChain;
  }

  private async endShrink(): Promise<void> {
    if (this.shrinkTimer) clearTimeout(this.shrinkTimer);
    this.abort.abort();
    await this.finish('found');
  }

  private async error(message: string, detail: string, inF: string): Promise<void> {
    if (this.finished || this.abort.signal.aborted) return;
    this.state = 'error';
    this.message = message;
    this.detail = detail.trim().slice(0, 4000);
    this.abort.abort();
    // Show the input that broke gen/brute.
    await copyFileP(inF, path.join(this.cfg.dir, 'in')).catch(() => undefined);
    await this.finish('error');
  }

  private async finish(state: StressState): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.shrinkTimer) clearTimeout(this.shrinkTimer);
    this.abort.abort();
    if (state === 'found' && this.best) {
      const bdir = path.join(this.cfg.scratch, 'best');
      const inputFile = path.join(this.cfg.dir, 'in');
      await copyFileP(path.join(bdir, 'in'), inputFile);
      let answerFile: string | undefined;
      if (this.cfg.mode === 'wa') {
        answerFile = path.join(this.cfg.dir, 'ans');
        await copyFileP(path.join(bdir, 'ans'), answerFile);
      }
      const b = this.best;
      this.final = { verdict: b.verdict, iteration: b.iteration, size: b.size, inputFile, answerFile, outputFile: path.join(bdir, 'out'), stderr: b.stderr, message: b.message, diff: b.diff, events: b.events, timeMs: b.timeMs };
      this.state = 'found';
      this.message = `${b.verdict} after ${this.completed.toLocaleString('en-US')} runs`;
    } else if (state === 'clean') {
      this.state = 'clean';
      this.message = `no failure in ${this.completed.toLocaleString('en-US')} runs`;
    } else {
      this.state = state;
    }
    const s = this.status();
    this.emit('status', s);
    this.resolveDone(s);
  }
}
