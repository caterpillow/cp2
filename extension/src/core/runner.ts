// Runs a program with a big stack, an output-size cap and a time limit. Input is handed to the
// process as a file and output goes straight to a file, so huge cases never pass through JS.

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Limits {
  stackMb: number;
  outputLimitMb: number;
}

let prlimitPath: string | null | undefined;

function findPrlimit(): string | null {
  if (prlimitPath !== undefined) return prlimitPath;
  prlimitPath = null;
  if (process.platform === 'linux') {
    for (const p of ['/usr/bin/prlimit', '/bin/prlimit', '/usr/local/bin/prlimit']) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        prlimitPath = p;
        break;
      } catch {
        /* next */
      }
    }
  }
  return prlimitPath;
}

/** Wraps a command so it starts with the requested stack size / output cap. */
export function wrapWithLimits(cmd: string[], limits: Limits): string[] {
  if (process.platform === 'win32') return cmd;
  const stack = Math.max(8, limits.stackMb) * 1024 * 1024;
  const fsize = Math.max(1, limits.outputLimitMb) * 1024 * 1024;
  const pl = findPrlimit();
  if (pl) return [pl, `--stack=${stack}`, `--fsize=${fsize}`, '--', ...cmd];
  const kb = process.platform === 'darwin' ? 'hard' : String(stack / 1024);
  return ['/bin/sh', '-c', `ulimit -s ${kb} 2>/dev/null; ulimit -f ${fsize / 512} 2>/dev/null; exec "$@"`, 'sh', ...cmd];
}

export function spawnLimited(cmd: string[], cwd: string, limits: Limits, stdio: SpawnOptions['stdio'], env?: NodeJS.ProcessEnv): ChildProcess {
  const full = wrapWithLimits(cmd, limits);
  return spawn(full[0], full.slice(1), { cwd, stdio, env: env ?? process.env, windowsHide: true });
}

export type StdinSpec = { file: string } | { text: string } | 'ignore';

export interface RunSpec {
  cmd: string[];
  cwd: string;
  stdin: StdinSpec;
  /** Where stdout goes. */
  stdoutFile: string;
  timeLimitMs: number;
  limits: Limits;
  env?: NodeJS.ProcessEnv;
  maxStderr?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stderr: string;
  stderrTruncated: boolean;
  spawnError?: string;
  killed: boolean;
}

export function runProcess(spec: RunSpec, abort?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const maxErr = spec.maxStderr ?? 1 << 20;
    let inFd: number | 'ignore' | 'pipe' = 'ignore';
    let outFd: number;
    try {
      fs.mkdirSync(path.dirname(spec.stdoutFile), { recursive: true });
      outFd = fs.openSync(spec.stdoutFile, 'w');
      if (typeof spec.stdin === 'object' && 'file' in spec.stdin) inFd = fs.openSync(spec.stdin.file, 'r');
      else if (typeof spec.stdin === 'object') inFd = 'pipe';
    } catch (e: any) {
      resolve({ exitCode: null, signal: null, timeMs: 0, timedOut: false, outputLimitExceeded: false, stderr: '', stderrTruncated: false, spawnError: String(e?.message ?? e), killed: false });
      return;
    }
    const closeFds = () => {
      try {
        fs.closeSync(outFd);
      } catch {
        /* ignore */
      }
      if (typeof inFd === 'number') {
        try {
          fs.closeSync(inFd);
        } catch {
          /* ignore */
        }
      }
    };
    const t0 = performance.now();
    let child: ChildProcess;
    try {
      child = spawnLimited(spec.cmd, spec.cwd, spec.limits, [inFd, outFd, 'pipe'], spec.env);
    } catch (e: any) {
      closeFds();
      resolve({ exitCode: null, signal: null, timeMs: 0, timedOut: false, outputLimitExceeded: false, stderr: '', stderrTruncated: false, spawnError: String(e?.message ?? e), killed: false });
      return;
    }
    closeFds();
    let stderr = '';
    let stderrTruncated = false;
    let timedOut = false;
    let killed = false;
    let spawnError: string | undefined;
    let finished = false;
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < maxErr) stderr += d.toString('utf8');
      else stderrTruncated = true;
    });
    if (inFd === 'pipe' && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end((spec.stdin as { text: string }).text);
    }
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeLimitMs);
    const onAbort = () => {
      killed = true;
      kill();
    };
    abort?.addEventListener('abort', onAbort, { once: true });
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null; t: number } | null = null;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, t: performance.now() - t0 };
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      const info = exitInfo ?? { code, signal, t: performance.now() - t0 };
      if (stderr.length > maxErr) stderr = stderr.slice(0, maxErr);
      resolve({
        exitCode: info.code,
        signal: info.signal,
        timeMs: Math.round(info.t),
        timedOut,
        outputLimitExceeded: info.signal === 'SIGXFSZ',
        stderr,
        stderrTruncated,
        spawnError,
        killed,
      });
    });
  });
}

export type RunVerdict = 'OK' | 'RE' | 'TLE' | 'OLE' | 'ERR' | 'STOPPED';

export function classifyRun(r: RunResult): RunVerdict {
  if (r.spawnError) return 'ERR';
  if (r.killed) return 'STOPPED';
  if (r.timedOut) return 'TLE';
  if (r.outputLimitExceeded) return 'OLE';
  if (r.signal || (r.exitCode !== null && r.exitCode !== 0)) return 'RE';
  return 'OK';
}

/** "exit code 1", "SIGSEGV (segmentation fault)", sanitizer summary... */
export function describeExit(r: RunResult): string {
  if (r.spawnError) return `could not start: ${r.spawnError}`;
  if (r.timedOut) return `killed after ${r.timeMs} ms (time limit)`;
  if (r.outputLimitExceeded) return 'output limit exceeded';
  if (r.signal) {
    const names: Record<string, string> = {
      SIGSEGV: 'segmentation fault',
      SIGABRT: 'aborted (assertion failed?)',
      SIGFPE: 'floating point exception (division by zero?)',
      SIGILL: 'illegal instruction (UB trap?)',
      SIGBUS: 'bus error',
      SIGKILL: 'killed',
    };
    return `${r.signal}${names[r.signal] ? ` — ${names[r.signal]}` : ''}`;
  }
  const san = r.stderr.match(/(ERROR: AddressSanitizer: [^\n]+|runtime error: [^\n]+|SUMMARY: \w+Sanitizer: [^\n]+)/);
  return `exit code ${r.exitCode}${san ? ` — ${san[1].slice(0, 160)}` : ''}`;
}
