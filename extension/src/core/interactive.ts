// Custom checkers and interactive judges.
//
// Checker:  `checker <input> <output> <expected>`  -> exit 0 accepted, anything else rejected.
// Judge:    judge stdout -> program stdin, program stdout -> judge stdin. The judge gets the test
//           first on its stdin (so a judge written with the usual template just reads it), or as
//           argv[1] in testlib style. Judge exit 0 = accepted, non-zero = wrong answer.

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Limits, runProcess, spawnLimited } from './runner';

export interface CheckerOutcome {
  pass: boolean;
  /** Checker's own message (testlib prints "ok ..." / "wrong answer ..." to stderr). */
  message: string;
  /** The checker itself crashed or timed out. */
  error?: boolean;
}

export async function runChecker(checkerCmd: string[], cwd: string, inputFile: string, outputFile: string, expectedFile: string | null, limits: Limits, timeoutMs = 10000): Promise<CheckerOutcome> {
  let ans = expectedFile;
  let tmp: string | null = null;
  if (!ans) {
    tmp = path.join(os.tmpdir(), `cp2-empty-${process.pid}-${Date.now()}`);
    await fsp.writeFile(tmp, '');
    ans = tmp;
  }
  const outFile = path.join(os.tmpdir(), `cp2-checker-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  try {
    const r = await runProcess({ cmd: [...checkerCmd, inputFile, outputFile, ans], cwd, stdin: 'ignore', stdoutFile: outFile, timeLimitMs: timeoutMs, limits, maxStderr: 64 * 1024 });
    const stdout = (await fsp.readFile(outFile, 'utf8').catch(() => '')).slice(0, 4096);
    const msg = (r.stderr.trim() || stdout.trim()).slice(0, 4000);
    if (r.spawnError) return { pass: false, message: `checker could not start: ${r.spawnError}`, error: true };
    if (r.timedOut) return { pass: false, message: 'checker timed out', error: true };
    if (r.signal) return { pass: false, message: `checker crashed (${r.signal})${msg ? `: ${msg}` : ''}`, error: true };
    return { pass: r.exitCode === 0, message: msg || (r.exitCode === 0 ? 'ok' : `checker exit code ${r.exitCode}`) };
  } finally {
    if (tmp) void fsp.rm(tmp, { force: true });
    void fsp.rm(outFile, { force: true });
  }
}

export type StreamKind = 'in' | 'out' | 'err' | 'judgeErr';

export interface InterEvent {
  kind: StreamKind;
  text: string;
  t: number;
}

export interface InteractiveResult {
  verdict: 'AC' | 'WA' | 'RE' | 'TLE' | 'ERR' | 'STOPPED';
  timeMs: number;
  programExit: number | null;
  programSignal: string | null;
  judgeExit: number | null;
  judgeSignal: string | null;
  /** Interleaved transcript: `in` = judge -> program, `out` = program -> judge, plus stderr. */
  events: InterEvent[];
  judgeStderr: string;
  message: string;
}

export interface InteractiveSpec {
  program: string[];
  judge: string[];
  cwd: string;
  testFile: string;
  judgeInput: 'stdin' | 'argv';
  timeLimitMs: number;
  limits: Limits;
  maxEvents?: number;
}

/** Splits a stream into lines and records them as transcript events. */
class LineRecorder {
  private partial = '';
  constructor(
    private kind: StreamKind,
    private push: (e: InterEvent) => void,
    private t0: number,
  ) {}
  feed(chunk: string): void {
    const s = this.partial + chunk;
    const parts = s.split('\n');
    this.partial = parts.pop() ?? '';
    const t = Math.round(performance.now() - this.t0);
    for (const p of parts) this.push({ kind: this.kind, text: p.replace(/\r$/, ''), t });
  }
  end(): void {
    if (this.partial) this.push({ kind: this.kind, text: this.partial, t: Math.round(performance.now() - this.t0) });
    this.partial = '';
  }
}

export function runInteractive(spec: InteractiveSpec, abort?: AbortSignal): Promise<InteractiveResult> {
  return new Promise((resolve) => {
    const maxEvents = spec.maxEvents ?? 20000;
    const events: InterEvent[] = [];
    let dropped = 0;
    const push = (e: InterEvent) => {
      if (events.length < maxEvents) events.push(e);
      else dropped++;
    };
    const t0 = performance.now();
    let prog: ChildProcess;
    let judge: ChildProcess;
    const judgeArgs = spec.judgeInput === 'argv' ? [...spec.judge, spec.testFile] : spec.judge;
    try {
      prog = spawnLimited(spec.program, spec.cwd, spec.limits, ['pipe', 'pipe', 'pipe']);
      judge = spawnLimited(judgeArgs, spec.cwd, spec.limits, ['pipe', 'pipe', 'pipe']);
    } catch (e: any) {
      resolve({ verdict: 'ERR', timeMs: 0, programExit: null, programSignal: null, judgeExit: null, judgeSignal: null, events, judgeStderr: '', message: `could not start: ${e?.message ?? e}` });
      return;
    }
    const recIn = new LineRecorder('in', push, t0);
    const recOut = new LineRecorder('out', push, t0);
    const recErr = new LineRecorder('err', push, t0);
    let judgeStderr = '';
    let progDone: { code: number | null; signal: string | null; t: number } | null = null;
    let judgeDone: { code: number | null; signal: string | null } | null = null;
    let timedOut = false;
    let stopped = false;
    let spawnErr = '';
    const swallow = () => undefined;
    prog.stdin!.on('error', swallow);
    judge.stdin!.on('error', swallow);
    prog.on('error', (e) => (spawnErr = `program: ${e.message}`));
    judge.on('error', (e) => (spawnErr = `judge: ${e.message}`));

    if (spec.judgeInput === 'stdin') {
      let test = '';
      try {
        test = fs.readFileSync(spec.testFile, 'utf8');
      } catch {
        /* empty test */
      }
      if (test && !test.endsWith('\n')) test += '\n';
      judge.stdin!.write(test);
    }
    prog.stdout!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      recOut.feed(s);
      if (!judge.stdin!.destroyed) judge.stdin!.write(d);
    });
    judge.stdout!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      recIn.feed(s);
      if (!prog.stdin!.destroyed) prog.stdin!.write(d);
    });
    prog.stderr!.on('data', (d: Buffer) => recErr.feed(d.toString('utf8')));
    judge.stderr!.on('data', (d: Buffer) => {
      if (judgeStderr.length < 65536) judgeStderr += d.toString('utf8');
    });

    const killAll = () => {
      for (const c of [prog, judge]) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, spec.timeLimitMs);
    const onAbort = () => {
      stopped = true;
      killAll();
    };
    abort?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      if (!progDone || !judgeDone) return;
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      recIn.end();
      recOut.end();
      recErr.end();
      const timeMs = Math.round(progDone.t);
      let verdict: InteractiveResult['verdict'];
      let message = judgeStderr.trim().slice(0, 4000);
      if (stopped) verdict = 'STOPPED';
      else if (spawnErr) {
        verdict = 'ERR';
        message = spawnErr;
      } else if (timedOut) {
        verdict = 'TLE';
        message = message || 'time limit exceeded (program or judge stopped responding)';
      } else if (judgeDone.code !== 0 || judgeDone.signal) {
        verdict = 'WA';
        message = message || (judgeDone.signal ? `judge crashed (${judgeDone.signal})` : `judge exit code ${judgeDone.code}`);
      } else if (progDone.code !== 0 || progDone.signal) {
        verdict = 'RE';
        message = progDone.signal ? `program killed by ${progDone.signal}` : `program exit code ${progDone.code}`;
      } else verdict = 'AC';
      if (dropped) message += `\n(${dropped} more transcript lines not shown)`;
      resolve({ verdict, timeMs, programExit: progDone.code, programSignal: progDone.signal, judgeExit: judgeDone.code, judgeSignal: judgeDone.signal, events, judgeStderr, message });
    };
    prog.on('exit', (code, signal) => {
      progDone = { code, signal, t: performance.now() - t0 };
    });
    prog.on('close', () => {
      if (!progDone) progDone = { code: null, signal: null, t: performance.now() - t0 };
      judge.stdin!.end();
      finish();
    });
    judge.on('close', (code, signal) => {
      judgeDone = { code, signal };
      prog.stdin!.end();
      // A program still waiting for input after the judge quit would hang until the time limit.
      setTimeout(() => {
        if (!progDone) {
          try {
            prog.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 500);
      finish();
    });
  });
}

/** A live session where the user plays the judge: lines typed in the sidebar go to stdin. */
export class ManualSession extends EventEmitter {
  private child: ChildProcess | null = null;
  private t0 = 0;
  private recOut: LineRecorder | null = null;
  private recErr: LineRecorder | null = null;
  readonly events: InterEvent[] = [];

  get running(): boolean {
    return this.child !== null;
  }

  start(cmd: string[], cwd: string, limits: Limits): void {
    this.stop();
    this.events.length = 0;
    this.t0 = performance.now();
    const push = (e: InterEvent) => {
      this.events.push(e);
      this.emit('event', e);
    };
    this.recOut = new LineRecorder('out', push, this.t0);
    this.recErr = new LineRecorder('err', push, this.t0);
    const child = spawnLimited(cmd, cwd, limits, ['pipe', 'pipe', 'pipe']);
    this.child = child;
    child.stdin!.on('error', () => undefined);
    child.stdout!.on('data', (d: Buffer) => this.recOut?.feed(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => this.recErr?.feed(d.toString('utf8')));
    child.on('error', (e) => this.emit('exit', { code: null, signal: null, timeMs: 0, error: e.message }));
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.recOut?.end();
      this.recErr?.end();
      this.child = null;
      this.emit('exit', { code, signal, timeMs: Math.round(performance.now() - this.t0) });
    });
  }

  send(text: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) return;
    const t = Math.round(performance.now() - this.t0);
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) {
      const e: InterEvent = { kind: 'in', text: l, t };
      this.events.push(e);
      this.emit('event', e);
    }
    this.child.stdin.write(lines.join('\n') + '\n');
  }

  eof(): void {
    this.child?.stdin?.end();
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}
