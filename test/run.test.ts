// Integration tests: real g++, real processes.
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Compiler } from '../extension/src/core/compiler';
import { runChecker, runInteractive } from '../extension/src/core/interactive';
import { classifyRun, runProcess } from '../extension/src/core/runner';

const limits = { stackMb: 1024, outputLimitMb: 64 };

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cp2-run-'));
}

describe('compile + run', () => {
  it('compiles once, reuses the cache, and recompiles when a header changes', async () => {
    const dir = await tmpdir();
    const src = path.join(dir, 'a.cpp');
    await fsp.writeFile(path.join(dir, 'h.h'), 'inline int f(){return 41;}\n');
    await fsp.writeFile(src, '#include <cstdio>\n#include "h.h"\nint main(){int x;scanf("%d",&x);printf("%d\\n",x+f());}\n');
    const c = new Compiler({ buildRoot: path.join(dir, 'build'), pchRoot: path.join(dir, 'pch'), pchEnabled: false, pchHeaders: [], stackMb: 1024 });
    const spec = { main: src, extra: [], compiler: 'g++', flags: '-O2' };
    const b1 = await c.build(spec);
    assert.ok(b1.ok, b1.output);
    assert.equal(b1.cached, false);
    const b2 = await c.build(spec);
    assert.equal(b2.cached, true);
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(dir, 'h.h'), 'inline int f(){return 1;}\n');
    const b3 = await c.build(spec);
    assert.equal(b3.cached, false, 'header change triggers rebuild');
    const inFile = path.join(dir, 'in');
    await fsp.writeFile(inFile, '5\n');
    const r = await runProcess({ cmd: b3.cmd, cwd: dir, stdin: { file: inFile }, stdoutFile: path.join(dir, 'out'), timeLimitMs: 5000, limits });
    assert.equal(classifyRun(r), 'OK');
    assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), '6\n');
  });

  it('reports compile errors', async () => {
    const dir = await tmpdir();
    const src = path.join(dir, 'bad.cpp');
    await fsp.writeFile(src, 'int main(){ return x; }\n');
    const c = new Compiler({ buildRoot: path.join(dir, 'build'), pchRoot: path.join(dir, 'pch'), pchEnabled: false, pchHeaders: [], stackMb: 1024 });
    const b = await c.build({ main: src, extra: [], compiler: 'g++', flags: '' });
    assert.equal(b.ok, false);
    assert.match(b.output, /bad\.cpp:1:20: error: .x. was not declared/);
  });

  it('links extra translation units (grader style)', async () => {
    const dir = await tmpdir();
    await fsp.writeFile(path.join(dir, 'lib.h'), 'int solve(int);\n');
    await fsp.writeFile(path.join(dir, 'grader.cpp'), '#include <cstdio>\n#include "lib.h"\nint main(){int x;scanf("%d",&x);printf("%d\\n",solve(x));}\n');
    await fsp.writeFile(path.join(dir, 'sol.cpp'), '#include "lib.h"\nint solve(int x){return x*2;}\n');
    const c = new Compiler({ buildRoot: path.join(dir, 'build'), pchRoot: path.join(dir, 'pch'), pchEnabled: false, pchHeaders: [], stackMb: 1024 });
    const b = await c.build({ main: path.join(dir, 'sol.cpp'), extra: [path.join(dir, 'grader.cpp'), path.join(dir, 'lib.h')], compiler: 'g++', flags: '-O2' });
    assert.ok(b.ok, b.output);
    const r = await runProcess({ cmd: b.cmd, cwd: dir, stdin: { text: '21\n' }, stdoutFile: path.join(dir, 'out'), timeLimitMs: 5000, limits });
    assert.equal(classifyRun(r), 'OK');
    assert.equal(await fsp.readFile(path.join(dir, 'out'), 'utf8'), '42\n');
  });

  it('gives programs a big stack and kills on time limit', async () => {
    const dir = await tmpdir();
    const src = path.join(dir, 'rec.cpp');
    await fsp.writeFile(src, '#include <cstdio>\nint f(int n){volatile char b[64];b[0]=n;return n?1+f(n-1)+b[0]*0:0;}\nint main(){int n;scanf("%d",&n);if(n<0)for(;;);printf("%d\\n",f(n));}\n');
    const c = new Compiler({ buildRoot: path.join(dir, 'build'), pchRoot: path.join(dir, 'pch'), pchEnabled: false, pchHeaders: [], stackMb: 1024 });
    const b = await c.build({ main: src, extra: [], compiler: 'g++', flags: '-O0' });
    assert.ok(b.ok, b.output);
    const deep = await runProcess({ cmd: b.cmd, cwd: dir, stdin: { text: '1000000\n' }, stdoutFile: path.join(dir, 'o1'), timeLimitMs: 10000, limits });
    assert.equal(classifyRun(deep), 'OK', `stderr: ${deep.stderr} signal: ${deep.signal}`);
    const small = await runProcess({ cmd: b.cmd, cwd: dir, stdin: { text: '1000000\n' }, stdoutFile: path.join(dir, 'o2'), timeLimitMs: 10000, limits: { stackMb: 8, outputLimitMb: 64 } });
    assert.equal(classifyRun(small), 'RE');
    const tle = await runProcess({ cmd: b.cmd, cwd: dir, stdin: { text: '-1\n' }, stdoutFile: path.join(dir, 'o3'), timeLimitMs: 300, limits });
    assert.equal(classifyRun(tle), 'TLE');
  });
});

describe('checkers and judges', () => {
  it('runs a custom checker with testlib argument order', async () => {
    const dir = await tmpdir();
    const chk = path.join(dir, 'chk.py');
    await fsp.writeFile(chk, 'import sys\ni,o,a=[open(p).read().split() for p in sys.argv[1:4]]\nok=sorted(o)==sorted(a)\nsys.stderr.write("ok" if ok else "wrong answer: not a permutation")\nsys.exit(0 if ok else 1)\n');
    for (const [n, s] of [['in', '3'], ['out', '3 1 2'], ['ans', '1 2 3'], ['bad', '1 1 2']]) await fsp.writeFile(path.join(dir, n), s);
    const ok = await runChecker(['python3', chk], dir, path.join(dir, 'in'), path.join(dir, 'out'), path.join(dir, 'ans'), limits);
    assert.equal(ok.pass, true);
    const bad = await runChecker(['python3', chk], dir, path.join(dir, 'in'), path.join(dir, 'bad'), path.join(dir, 'ans'), limits);
    assert.equal(bad.pass, false);
    assert.match(bad.message, /not a permutation/);
  });

  it('wires a judge to a program and records the transcript', async () => {
    const dir = await tmpdir();
    // Judge reads the secret from its stdin first, then answers "<", ">" or "=".
    await fsp.writeFile(path.join(dir, 'judge.py'), 'import sys\ns=int(sys.stdin.readline())\nfor _ in range(40):\n  q=sys.stdin.readline().split()\n  if not q: sys.exit(2)\n  if q[0]=="!": sys.exit(0 if int(q[1])==s else 1)\n  x=int(q[1]); print("<" if s<x else (">" if s>x else "="), flush=True)\nsys.exit(3)\n');
    await fsp.writeFile(path.join(dir, 'sol.py'), 'import sys\nlo,hi=1,100\nwhile lo<hi:\n  m=(lo+hi)//2\n  print("?",m,flush=True)\n  r=input()\n  if r=="=": lo=hi=m\n  elif r=="<": hi=m-1\n  else: lo=m+1\nprint("!",lo,flush=True)\nsys.stderr.write("done\\n")\n');
    await fsp.writeFile(path.join(dir, 'test'), '37');
    const res = await runInteractive({ program: ['python3', path.join(dir, 'sol.py')], judge: ['python3', path.join(dir, 'judge.py')], cwd: dir, testFile: path.join(dir, 'test'), judgeInput: 'stdin', timeLimitMs: 5000, limits });
    assert.equal(res.verdict, 'AC', res.message);
    assert.ok(res.events.some((e) => e.kind === 'out' && e.text.startsWith('?')));
    assert.ok(res.events.some((e) => e.kind === 'in' && /[<>=]/.test(e.text)));
    assert.ok(res.events.some((e) => e.kind === 'err' && e.text === 'done'));
    await fsp.writeFile(path.join(dir, 'test'), '200');
    const wa = await runInteractive({ program: ['python3', path.join(dir, 'sol.py')], judge: ['python3', path.join(dir, 'judge.py')], cwd: dir, testFile: path.join(dir, 'test'), judgeInput: 'stdin', timeLimitMs: 5000, limits });
    assert.equal(wa.verdict, 'WA');
  });
});
