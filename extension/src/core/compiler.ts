// Compiles C/C++ with a content-addressed cache and automatic precompiled headers.
//
// A build is reused when the sources' contents, compiler and flags are unchanged and none of
// the non-system headers it included (from gcc -MD) changed since. Extra translation units
// (graders) are compiled to cached objects so only the edited file gets rebuilt.

import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { atomicWrite, exists, mkdirp, readJson, sha1, splitArgs, statOrNull } from './fsutil';
import { isHeaderFile, langOf, LangId } from './lang';

export interface BuildSpec {
  main: string;
  /** Other files ticked under "compile with": sources get compiled+linked, headers are tracked. */
  extra: string[];
  compiler: string;
  flags: string;
  python?: { command: string; args: string };
}

export interface Built {
  ok: boolean;
  /** Command line to run the program (exe path, or python + script). */
  cmd: string[];
  output: string;
  cached: boolean;
  timeMs: number;
  pch: boolean;
  lang: LangId;
}

export interface CompilerOptions {
  buildRoot: string;
  pchRoot: string;
  pchEnabled: boolean;
  pchHeaders: string[];
  stackMb: number;
  log?: (msg: string) => void;
}

interface ToolInfo {
  version: string;
  machine: string;
  mingw: boolean;
}

interface CacheMeta {
  ok: boolean;
  output: string;
  deps: [string, number, number][];
  pch: boolean;
}

const SYSTEM_PREFIXES = process.platform === 'win32' ? [/^[a-z]:[\\/](msys64|mingw|program files|llvm)/i] : [/^\/usr\//, /^\/lib\//, /^\/opt\//];

function isSystemPath(p: string): boolean {
  return SYSTEM_PREFIXES.some((r) => r.test(p));
}

export function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

interface ExecResult {
  code: number | null;
  out: string;
  error?: string;
}

function exec(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 120000): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(cmd, args, { cwd, env: process.env, windowsHide: true });
    const timer = setTimeout(() => {
      if (!done) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, out, error: e.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Parses a make-style dependency file written by gcc -MD. */
export function parseDepFile(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const colon = joined.search(/:(\s|$)/);
  const body = colon >= 0 ? joined.slice(colon + 1) : joined;
  const deps: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/\s/.test(c)) {
      if (cur) deps.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) deps.push(cur);
  return deps;
}

/** The first `#include <...>` before any code, if it is one we precompile. */
export function pchCandidate(source: string, headers: string[]): string | null {
  let inBlock = false;
  const lines = source.split('\n', 200);
  for (const raw of lines) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (!line || line.startsWith('//')) continue;
    const m = line.match(/^#\s*include\s*<([^>]+)>/);
    if (m) return headers.includes(m[1]) ? m[1] : null;
    if (line.startsWith('#')) {
      if (/^#\s*(define|pragma|if|ifdef|ifndef|else|elif|endif|undef)\b/.test(line)) continue;
      return null;
    }
    return null;
  }
  return null;
}

export class Compiler {
  private tools = new Map<string, Promise<ToolInfo>>();
  private inflight = new Map<string, Promise<Built>>();
  private pch: PchManager;

  constructor(private opts: CompilerOptions) {
    this.pch = new PchManager(opts.pchRoot, opts.log);
  }

  private tool(compiler: string): Promise<ToolInfo> {
    let t = this.tools.get(compiler);
    if (!t) {
      t = (async () => {
        const v = await exec(compiler, ['-dumpversion'], os.tmpdir(), undefined, 20000);
        const m = await exec(compiler, ['-dumpmachine'], os.tmpdir(), undefined, 20000);
        const machine = m.out.trim();
        return { version: v.out.trim(), machine, mingw: /mingw|windows|msys|cygwin/i.test(machine) };
      })();
      this.tools.set(compiler, t);
    }
    return t;
  }

  /** Platform fix-ups: MinGW can't link ASan, so drop it and make UBSan trap instead. */
  private adjust(flags: string[], tool: ToolInfo): string[] {
    let out = [...flags];
    if (tool.mingw) {
      out = out
        .map((f) => {
          const m = f.match(/^-fsanitize=(.*)$/);
          if (!m) return f;
          const kept = m[1].split(',').filter((s) => s !== 'address' && s !== 'leak' && s !== 'thread');
          return kept.length ? `-fsanitize=${kept.join(',')}` : '';
        })
        .filter((f) => f);
      if (out.some((f) => /^-fsanitize=.*undefined/.test(f))) out.push('-fsanitize-undefined-trap-on-error');
      out.push(`-Wl,--stack,${this.opts.stackMb * 1024 * 1024}`);
    }
    return out;
  }

  async build(spec: BuildSpec): Promise<Built> {
    const lang = langOf(spec.main);
    if (!lang) return { ok: false, cmd: [], output: `cp2: unsupported file type: ${spec.main}`, cached: false, timeMs: 0, pch: false, lang: 'cpp' };
    if (lang === 'python') {
      const py = spec.python ?? { command: 'python3', args: '' };
      return { ok: true, cmd: [py.command, ...splitArgs(py.args), spec.main], output: '', cached: true, timeMs: 0, pch: false, lang };
    }
    const t0 = Date.now();
    const tool = await this.tool(spec.compiler);
    const flags = this.adjust(splitArgs(spec.flags), tool);
    const dir = path.dirname(spec.main);
    const sources = [spec.main, ...spec.extra.filter((f) => !isHeaderFile(f) && langOf(f) && langOf(f) !== 'python')];
    const contents = await Promise.all(sources.map((s) => fsp.readFile(s)));
    const key = sha1(JSON.stringify({ c: spec.compiler, v: tool.version, m: tool.machine, f: flags, d: dir, s: sources.map((s, i) => [path.basename(s), sha1(contents[i])]) })).slice(0, 24);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doBuild(key, spec, lang, flags, tool, sources, contents, t0).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doBuild(key: string, spec: BuildSpec, lang: LangId, flags: string[], tool: ToolInfo, sources: string[], contents: Buffer[], t0: number): Promise<Built> {
    const outDir = path.join(this.opts.buildRoot, key);
    const exe = path.join(outDir, exeName('prog'));
    const metaFile = path.join(outDir, 'meta.json');
    const cached = await readJson<CacheMeta>(metaFile);
    if (cached && (await this.depsFresh(cached.deps)) && (!cached.ok || (await exists(exe)))) {
      void fsp.utimes(metaFile, new Date(), new Date()).catch(() => undefined);
      return { ok: cached.ok, cmd: cached.ok ? [exe] : [], output: cached.output, cached: true, timeMs: Date.now() - t0, pch: cached.pch, lang };
    }
    await mkdirp(outDir);
    const cwd = path.dirname(spec.main);
    const pchArgs = async (src: Buffer): Promise<{ args: string[]; used: boolean }> => {
      if (!this.opts.pchEnabled || lang !== 'cpp') return { args: [], used: false };
      const header = pchCandidate(src.toString('utf8'), this.opts.pchHeaders);
      if (!header) return { args: [], used: false };
      const inc = await this.pch.locate(spec.compiler, flags, header, tool, cwd);
      return inc ? { args: [`-I${inc}`, '-Winvalid-pch'], used: true } : { args: [], used: false };
    };
    const common = ['-fdiagnostics-color=never'];
    let output = '';
    let ok = false;
    let usedPch = false;
    const deps = new Set<string>();
    const tmpExe = `${exe}.tmp${process.pid}`;

    if (sources.length === 1) {
      const pch = await pchArgs(contents[0]);
      usedPch = pch.used;
      const depFile = path.join(outDir, 'deps.d');
      const r = await exec(spec.compiler, [...pch.args, ...flags, ...common, '-MD', '-MF', depFile, '-o', tmpExe, path.relative(cwd, spec.main)], cwd);
      output = r.error ? `failed to run ${spec.compiler}: ${r.error}` : r.out;
      ok = r.code === 0;
      const d = await fsp.readFile(depFile, 'utf8').catch(() => '');
      parseDepFile(d).forEach((x) => deps.add(path.resolve(cwd, x)));
    } else {
      // Compile each translation unit to a cached object, then link.
      const objs: string[] = [];
      ok = true;
      for (let i = 0; i < sources.length && ok; i++) {
        const src = sources[i];
        const okey = sha1(JSON.stringify({ c: spec.compiler, v: tool.version, f: flags, d: cwd, s: sha1(contents[i]), n: path.basename(src) })).slice(0, 24);
        const objDir = path.join(this.opts.buildRoot, 'obj', okey);
        const obj = path.join(objDir, 'unit.o');
        const om = await readJson<CacheMeta>(path.join(objDir, 'meta.json'));
        if (om && om.ok && (await exists(obj)) && (await this.depsFresh(om.deps))) {
          om.deps.forEach(([p]) => deps.add(p));
          objs.push(obj);
          continue;
        }
        await mkdirp(objDir);
        const pch = await pchArgs(contents[i]);
        if (i === 0) usedPch = pch.used;
        const depFile = path.join(objDir, 'deps.d');
        const r = await exec(spec.compiler, [...pch.args, ...flags, ...common, '-MD', '-MF', depFile, '-c', '-o', obj, path.relative(cwd, src)], cwd);
        output += r.error ? `failed to run ${spec.compiler}: ${r.error}\n` : r.out;
        if (r.code !== 0) {
          ok = false;
          break;
        }
        const d = await fsp.readFile(depFile, 'utf8').catch(() => '');
        const ds = parseDepFile(d).map((x) => path.resolve(cwd, x));
        ds.forEach((x) => deps.add(x));
        await atomicWrite(path.join(objDir, 'meta.json'), JSON.stringify({ ok: true, output: '', deps: await this.stamp(ds), pch: pch.used }));
        objs.push(obj);
      }
      if (ok) {
        const r = await exec(spec.compiler, [...flags, ...common, '-o', tmpExe, ...objs], cwd);
        output += r.error ? `failed to run ${spec.compiler}: ${r.error}` : r.out;
        ok = r.code === 0;
      }
    }
    for (const s of [...sources, ...spec.extra]) deps.add(path.resolve(s));
    if (ok) {
      await fsp.rename(tmpExe, exe);
    } else {
      await fsp.rm(tmpExe, { force: true }).catch(() => undefined);
    }
    const meta: CacheMeta = { ok, output: output.trim(), deps: await this.stamp([...deps]), pch: usedPch };
    await atomicWrite(metaFile, JSON.stringify(meta));
    return { ok, cmd: ok ? [exe] : [], output: meta.output, cached: false, timeMs: Date.now() - t0, pch: usedPch, lang };
  }

  private async stamp(files: string[]): Promise<[string, number, number][]> {
    const out: [string, number, number][] = [];
    for (const f of files) {
      if (isSystemPath(f)) continue;
      const st = await statOrNull(f);
      out.push([f, st ? Math.floor(st.mtimeMs) : -1, st ? st.size : -1]);
    }
    return out;
  }

  private async depsFresh(deps: [string, number, number][]): Promise<boolean> {
    const stats = await Promise.all(deps.map(([f]) => statOrNull(f)));
    return deps.every(([, mt, sz], i) => {
      const st = stats[i];
      if (!st) return mt === -1;
      return Math.floor(st.mtimeMs) === mt && st.size === sz;
    });
  }

  /** Deletes old build outputs, keeping the most recently used ones. */
  async prune(keep = 400): Promise<void> {
    const root = this.opts.buildRoot;
    let names: string[];
    try {
      names = (await fsp.readdir(root)).filter((n) => n !== 'obj');
    } catch {
      return;
    }
    if (names.length <= keep) return;
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await statOrNull(path.join(root, n, 'meta.json')))?.mtimeMs ?? 0 })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { n } of withTime.slice(keep)) await fsp.rm(path.join(root, n), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Builds bits/stdc++.h-style precompiled headers per (compiler, flags) in the background. */
class PchManager {
  private state = new Map<string, 'building' | 'ready' | 'bad'>();

  constructor(
    private root: string,
    private log?: (msg: string) => void,
  ) {}

  /** Include dir holding the .gch when ready; otherwise starts building it and returns null. */
  async locate(compiler: string, flags: string[], header: string, tool: ToolInfo, cwd: string): Promise<string | null> {
    const pchFlags = flags.filter((f) => !/^-(MD|MMD|MF|MT|c|o)$/.test(f));
    const key = sha1(JSON.stringify({ compiler, v: tool.version, m: tool.machine, f: pchFlags, h: header })).slice(0, 20);
    const dir = path.join(this.root, key);
    const st = this.state.get(key);
    if (st === 'ready') {
      void fsp.utimes(path.join(dir, 'ok'), new Date(), new Date()).catch(() => undefined);
      return dir;
    }
    if (st === 'building' || st === 'bad') return null;
    if (await exists(path.join(dir, 'ok'))) {
      this.state.set(key, 'ready');
      return dir;
    }
    if (await exists(path.join(dir, 'bad'))) {
      this.state.set(key, 'bad');
      return null;
    }
    this.state.set(key, 'building');
    void this.build(key, dir, compiler, pchFlags, header, cwd);
    return null;
  }

  private async build(key: string, dir: string, compiler: string, flags: string[], header: string, cwd: string): Promise<void> {
    const t0 = Date.now();
    try {
      await mkdirp(path.join(dir, path.dirname(header)));
      const m = await exec(compiler, [...flags, '-x', 'c++', '-M', '-'], cwd, `#include <${header}>\n`, 60000);
      const deps = parseDepFile(m.out);
      const real = deps.find((d) => d.replace(/\\/g, '/').endsWith(header));
      if (m.code !== 0 || !real) throw new Error(`could not locate <${header}>: ${m.out.slice(0, 300)}`);
      const gch = path.join(dir, `${header}.gch`);
      const tmp = `${gch}.tmp${process.pid}`;
      const r = await exec(compiler, [...flags, '-fdiagnostics-color=never', '-x', 'c++-header', real, '-o', tmp], cwd, undefined, 300000);
      if (r.code !== 0) throw new Error(r.out.slice(0, 500));
      await fsp.rename(tmp, gch);
      await atomicWrite(path.join(dir, 'ok'), `${header}\n${flags.join(' ')}\n`);
      this.state.set(key, 'ready');
      this.log?.(`cp2: precompiled <${header}> in ${((Date.now() - t0) / 1000).toFixed(1)}s for: ${flags.join(' ')}`);
      void this.pruneOld();
    } catch (e) {
      this.state.set(key, 'bad');
      await atomicWrite(path.join(dir, 'bad'), String(e)).catch(() => undefined);
      this.log?.(`cp2: precompiled header failed (falling back to normal compiles): ${e}`);
    }
  }

  /** Each .gch is ~200 MB, so keep only the few most recently used. */
  private async pruneOld(keep = 6): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return;
    }
    const list = await Promise.all(names.map(async (n) => ({ n, t: (await statOrNull(path.join(this.root, n, 'ok')))?.mtimeMs ?? 0 })));
    list.sort((a, b) => b.t - a.t);
    for (const { n } of list.slice(keep)) {
      if (this.state.get(n) === 'building') continue;
      this.state.delete(n);
      await fsp.rm(path.join(this.root, n), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
