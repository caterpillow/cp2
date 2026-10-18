import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { StressConfig, StressRun } from '../extension/src/core/stress';

const limits = { stackMb: 256, outputLimitMb: 64 };

async function setup(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp2-stress-'));
  for (const [n, s] of Object.entries(files)) await fsp.writeFile(path.join(dir, n), s);
  return dir;
}

const py = (dir: string, f: string) => ({ cmd: ['python3', path.join(dir, f)], cwd: dir });

function cfg(dir: string, over: Partial<StressConfig>): StressConfig {
  return {
    mode: 'wa',
    dir,
    scratch: path.join(dir, '.scratch'),
    sus: py(dir, 'sus.py'),
    brute: py(dir, 'brute.py'),
    gen: py(dir, 'gen.py'),
    judgeInput: 'stdin',
    compare: 'standard',
    precision: 1e-6,
    workers: 4,
    maxIterations: 2000,
    shrinkMs: 0,
    susTimeLimitMs: 5000,
    helperTimeoutMs: 5000,
    limits,
    publishIntervalMs: 100,
    ...over,
  };
}

// sus forgets about duplicates: it dedups before printing.
const GEN = 'import random,sys\nn=random.randint(1,8)\nprint(n)\nprint(*[random.randint(1,5) for _ in range(n)])\n';
const BRUTE = 'n=int(input());a=sorted(map(int,input().split()));print(*a)\n';
const SUS = 'n=int(input());a=sorted(set(map(int,input().split())));print(*a)\n';

describe('stress', () => {
  it('finds a WA, writes in/ans, and reports the first difference', async () => {
    const dir = await setup({ 'gen.py': GEN, 'brute.py': BRUTE, 'sus.py': SUS });
    const run = new StressRun(cfg(dir, {}));
    const s = await run.start();
    assert.equal(s.state, 'found', s.message);
    assert.equal(s.failure?.verdict, 'WA');
    const input = await fsp.readFile(path.join(dir, 'in'), 'utf8');
    const ans = await fsp.readFile(path.join(dir, 'ans'), 'utf8');
    const nums = input.split('\n')[1].split(' ').map(Number);
    assert.ok(new Set(nums).size < nums.length, 'failing input has duplicates');
    assert.equal(ans.trim(), [...nums].sort((a, b) => a - b).join(' '));
    assert.ok(s.failure?.diff);
  });

  it('keeps searching for a smaller failing input when asked', async () => {
    const dir = await setup({ 'gen.py': GEN, 'brute.py': BRUTE, 'sus.py': SUS });
    const s = await new StressRun(cfg(dir, { shrinkMs: 1500 })).start();
    assert.equal(s.state, 'found');
    const input = await fsp.readFile(path.join(dir, 'in'), 'utf8');
    assert.equal(input.split('\n')[0], '2', `expected the minimal n=2 case, got:\n${input}`);
  });

  it('first-line mode ignores differences after line 1', async () => {
    const dir = await setup({
      'gen.py': 'import random\nprint(random.randint(1,100))\n',
      'brute.py': 'n=int(input());print(n%7);print(1,2)\n',
      'sus.py': 'n=int(input());print(n%7);print(2,1)\n',
    });
    const s = await new StressRun(cfg(dir, { compare: 'firstLine', maxIterations: 60 })).start();
    assert.equal(s.state, 'clean');
    assert.equal(s.iterations, 60);
  });

  it('RE mode catches crashes, and gen failures are blamed on gen', async () => {
    const dir = await setup({
      'gen.py': 'import random\nprint(random.randint(0,20))\n',
      'sus.py': 'n=int(input())\nassert n!=13\nprint(n)\n',
      'badgen.py': 'import sys\nsys.stderr.write("oops\\n");sys.exit(3)\n',
    });
    const s = await new StressRun(cfg(dir, { mode: 're', brute: undefined })).start();
    assert.equal(s.state, 'found');
    assert.equal(s.failure?.verdict, 'RE');
    assert.equal((await fsp.readFile(path.join(dir, 'in'), 'utf8')).trim(), '13');
    const e = await new StressRun(cfg(dir, { mode: 're', brute: undefined, gen: py(dir, 'badgen.py') })).start();
    assert.equal(e.state, 'error');
    assert.match(e.message ?? '', /^gen failed: exit code 3/);
    assert.match(e.detail ?? '', /oops/);
  });

  it('stop() ends a run', async () => {
    const dir = await setup({ 'gen.py': 'print(1)\n', 'brute.py': 'print(input())\n', 'sus.py': 'print(input())\n' });
    const run = new StressRun(cfg(dir, { maxIterations: 0 }));
    const p = run.start();
    await new Promise((r) => setTimeout(r, 400));
    run.stop();
    const s = await p;
    assert.equal(s.state, 'stopped');
    assert.ok(s.iterations > 0);
  });
});
