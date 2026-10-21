// Drives the real extension host code (controller, stress host, integrations) through the fake
// vscode module, with real compiles and processes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Controller } from '../extension/src/host/controller';
import { Integrations } from '../extension/src/host/integrations';
import { StressHost } from '../extension/src/host/stressHost';
import type { ContestInfo, ProblemData } from '../shared/protocol';
import type { ToWebview, ViewState } from '../shared/viewModel';
import { fake, Uri } from './fakeVscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mkws(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp2-host-'));
  for (const [n, s] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, n)), { recursive: true });
    await fsp.writeFile(path.join(dir, n), s);
  }
  return dir;
}

interface Harness {
  c: Controller;
  integ: Integrations;
  posts: ToWebview[];
  state(): Promise<ViewState>;
  waitFor(pred: (s: ViewState) => boolean, ms?: number): Promise<ViewState>;
}

function harness(root: string): Harness {
  fake.workspaceRoots = [root];
  fake.config = {
    'cp2.precompiledHeaders.enabled': false,
    'cp2.cpp.flags': '-std=gnu++17 -O0',
    'cp2.cacheDir': path.join(root, '.cache-cp2'),
    'cp2.timeLimitMs': 3000,
    'cp2.stress.workers': 4,
  };
  const ctx = { subscriptions: [], extensionUri: Uri.file(root), globalStorageUri: Uri.file(path.join(root, '.gs', 'User', 'globalStorage', 'x')) } as any;
  const c = new Controller(ctx);
  c.stress = new StressHost(c);
  const posts: ToWebview[] = [];
  c.poster = { post: (m) => posts.push(m), visible: true, reveal() {} };
  const integ = new Integrations(c, ctx);
  c.extras = integ;
  const state = async (): Promise<ViewState> => {
    // Build directly (a timer-driven render may be in flight); include every text.
    if (c.active) c.sessionIfLoaded(c.active)?.resetSent();
    return (c as any).buildState();
  };
  const waitFor = async (pred: (s: ViewState) => boolean, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await state();
      if (pred(s)) return s;
      if (Date.now() > end) throw new Error(`timeout; last state: ${JSON.stringify(s, (k, v) => (k === 'text' ? undefined : v)).slice(0, 2000)}`);
      await sleep(100);
    }
  };
  return { c, integ, posts, state, waitFor };
}

const DOUBLE = '#include <cstdio>\nint main(){long long n;if(scanf("%lld",&n)!=1)return 0;printf("%lld\\n",n*2);}\n';

describe('controller', () => {
  let root: string;
  let h: Harness;
  before(async () => {
    root = await mkws({ 'p/a.cpp': DOUBLE, 'p/in': '5\n', 'p/ans': '10\n', 'p/in2': '1\n' });
    const file = path.join(root, 'p/a.cpp');
    const hash = createHash('md5').update(file).digest('hex');
    await fsp.mkdir(path.join(root, 'p/.cph'));
    await fsp.writeFile(path.join(root, 'p/.cph', `.a.cpp_${hash}.prob`), JSON.stringify({ name: 'Local: a', tests: [{ id: 1, input: '2', output: '4' }, { id: 2, input: '3', output: '7' }], local: true }));
    h = harness(root);
  });
  after(() => {
    h.c.dispose();
    h.integ.dispose();
  });

  it('loads legacy cases and text-file cases', async () => {
    await h.c.setActive(path.join(root, 'p/a.cpp'));
    const s = await h.state();
    assert.equal(s.file?.name, 'a.cpp');
    assert.deepEqual(
      s.cases.map((c) => [c.origin, c.label]),
      [
        ['manual', 'Case 1'],
        ['manual', 'Case 2'],
        ['file', 'in'],
        ['file', 'in2'],
      ],
    );
    assert.equal(s.cases[0].input.text, '2');
    assert.equal(s.cases[3].expectedMissing, true);
    assert.ok(fs.existsSync(path.join(root, '.cp2/cases/p/a.cpp/problem.json')), 'migrated into .cp2');
  });

  it('runs all cases with verdicts and diffs', async () => {
    await h.c.runAll();
    const s = await h.waitFor((x) => !x.running && x.cases.every((c) => c.result && !['QUEUED', 'RUNNING'].includes(c.result.verdict)));
    assert.deepEqual(
      s.cases.map((c) => c.result!.verdict),
      ['AC', 'WA', 'AC', 'RAN'],
    );
    const wa = s.cases[1].result!;
    assert.deepEqual(wa.diffExpected, { line: 1, col: 0, len: 1 });
    assert.equal(s.compile.state, 'ok');
  });

  it('re-judges when the expected output is edited', async () => {
    const s0 = await h.state();
    await h.c.onMessage({ type: 'edit', key: s0.cases[1].key, field: 'ans', text: '6\n', file: path.join(root, 'p/a.cpp') });
    const s = await h.state();
    assert.equal(s.cases[1].result?.verdict, 'AC');
  });

  it('typing into a missing answer box creates the answer file', async () => {
    await h.c.onMessage({ type: 'edit', key: 'f:in2', field: 'ans', text: '2\n', file: path.join(root, 'p/a.cpp') });
    assert.equal(await fsp.readFile(path.join(root, 'p/ans2'), 'utf8'), '2\n');
    const s = await h.state();
    const c = s.cases.find((x) => x.key === 'f:in2')!;
    assert.equal(c.expectedMissing, false);
    assert.equal(c.result?.verdict, 'AC');
  });

  it('pins, reorders, keeps and hides', async () => {
    await h.c.onMessage({ type: 'pin', key: 'f:in', pinned: true });
    let s = await h.state();
    assert.equal(s.cases[0].key, 'f:in');
    assert.equal(s.cases[0].pinned, true);
    const keys = s.cases.map((c) => c.key);
    await h.c.onMessage({ type: 'reorder', keys: [keys[0], keys[2], keys[1], keys[3]] });
    s = await h.state();
    assert.deepEqual(
      s.cases.map((c) => c.key),
      [keys[0], keys[2], keys[1], keys[3]],
    );
    await h.c.onMessage({ type: 'keep', key: 'f:in' });
    s = await h.state();
    const kept = s.cases.find((c) => c.origin === 'manual' && c.input.text === undefined ? false : c.input.text === '5\n');
    assert.ok(kept, 'kept copy of the in case is a manual case');
    await h.c.onMessage({ type: 'hideCase', key: 'f:in2' });
    s = await h.state();
    assert.ok(!s.cases.some((c) => c.key === 'f:in2'));
  });

  it('first-line comparison mode applies to normal runs', async () => {
    await fsp.writeFile(path.join(root, 'p/in3'), '4\n');
    await fsp.writeFile(path.join(root, 'p/ans3'), '8\nignored\n');
    fake.touch(path.join(root, 'p/in3'), 'create');
    await sleep(150);
    await h.c.onMessage({ type: 'setting', patch: { compare: 'firstLine' } });
    await h.c.runAll();
    const s = await h.waitFor((x) => !x.running && x.cases.find((c) => c.key === 'f:in3')?.result?.verdict === 'AC');
    assert.ok(s.cases.find((c) => c.key === 'f:in3'));
    await h.c.onMessage({ type: 'setting', patch: { compare: 'standard' } });
    const s2 = await h.state();
    assert.equal(s2.cases.find((c) => c.key === 'f:in3')?.result?.verdict, 'WA', 're-judged without rerunning');
  });

  it('shows compile errors without running', async () => {
    await fsp.writeFile(path.join(root, 'p/a.cpp'), 'int main( { }\n');
    await h.c.runAll();
    const s = await h.waitFor((x) => !x.running && x.compile.state === 'error');
    assert.match(s.compile.output ?? '', /a\.cpp:1/);
    await fsp.writeFile(path.join(root, 'p/a.cpp'), DOUBLE);
  });
});

describe('interactive', () => {
  it('runs against a judge and records the conversation', async () => {
    const root = await mkws({
      'q/sol.py': 'lo,hi=1,100\nwhile lo<hi:\n  m=(lo+hi)//2\n  print("?",m,flush=True)\n  r=input()\n  if r=="=": lo=hi=m\n  elif r=="<": hi=m-1\n  else: lo=m+1\nprint("!",lo,flush=True)\n',
      'q/judge.py': 'import sys\ns=int(sys.stdin.readline())\nfor _ in range(40):\n  q=sys.stdin.readline().split()\n  if q[0]=="!": sys.exit(0 if int(q[1])==s else 1)\n  x=int(q[1]); print("<" if s<x else (">" if s>x else "="), flush=True)\nsys.exit(3)\n',
      'q/in': '37\n',
    });
    const h = harness(root);
    const file = path.join(root, 'q/sol.py');
    await h.c.setActive(file);
    await h.c.onMessage({ type: 'setting', patch: { interactive: true, judge: 'judge.py' } });
    let s = await h.state();
    assert.equal(s.manual.visible, true);
    assert.equal(s.cases[0].expected, null, 'no expected box for interactive');
    await h.c.runAll();
    s = await h.waitFor((x) => !x.running && x.cases[0]?.result?.verdict !== 'QUEUED' && x.cases[0]?.result?.verdict !== 'RUNNING');
    assert.equal(s.cases[0].result?.verdict, 'AC', s.cases[0].result?.detail);
    assert.ok(s.cases[0].result?.transcript?.some((l) => l.k === 'out' && l.t.startsWith('!')));
    h.c.dispose();
    h.integ.dispose();
  });
});

describe('stress', () => {
  it('sets up x/x.cpp + brute + gen, then finds a failing test', async () => {
    const SUS = '#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;std::vector<int>a(n);for(auto&x:a)std::cin>>x;std::cout<<*std::max_element(a.begin(),a.begin()+std::min(n,3))<<"\\n";}\n';
    const root = await mkws({ 'cf/x.cpp': SUS, 'cf/templates-not-here': '' });
    await fsp.copyFile('/bin/true', path.join(root, 'cf/x'));
    await fsp.chmod(path.join(root, 'cf/x'), 0o755);
    const h = harness(root);
    const file = path.join(root, 'cf/x.cpp');
    await h.c.setActive(file);
    let s = await h.state();
    assert.equal(s.stress.wa.canRun, false);
    assert.equal(s.stress.wa.needsSetup, true);
    await h.c.stress.onMessage(file, { type: 'stressSetup', mode: 'wa' });
    const moved = path.join(root, 'cf/x/x.cpp');
    assert.ok(fs.existsSync(moved), 'moved into x/');
    assert.ok(fs.statSync(path.join(root, 'cf/x')).isDirectory(), 'old executable replaced by the folder');
    assert.ok(fs.existsSync(path.join(root, 'cf/x/xbrute.cpp')));
    assert.ok(fs.existsSync(path.join(root, 'cf/x/gen.cpp')));
    assert.equal(h.c.active, moved);
    // brute: correct max; gen: random arrays
    await fsp.writeFile(path.join(root, 'cf/x/xbrute.cpp'), '#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;std::vector<int>a(n);for(auto&x:a)std::cin>>x;std::cout<<*std::max_element(a.begin(),a.end())<<"\\n";}\n');
    await fsp.writeFile(path.join(root, 'cf/x/gen.py'), 'import random\nn=random.randint(1,6)\nprint(n)\nprint(*[random.randint(1,9) for _ in range(n)])\n');
    await fsp.rm(path.join(root, 'cf/x/gen.cpp'));
    h.c.dirs.invalidate(path.join(root, 'cf/x'));
    s = await h.state();
    const wa = s.stress.wa;
    assert.deepEqual(
      wa.slots.map((x) => [x.role, x.value]),
      [
        ['sus', 'x.cpp'],
        ['brute', 'xbrute.cpp'],
        ['gen', 'gen.py'],
      ],
    );
    assert.equal(wa.canRun, true, wa.reason);
    await h.c.stress.onMessage(moved, { type: 'stressShrink', mode: 'wa', index: 3 });
    await h.c.stress.onMessage(moved, { type: 'stressRun', mode: 'wa' });
    s = await h.waitFor((x) => x.stress.wa.status?.state === 'found' || x.stress.wa.status?.state === 'error', 60000);
    assert.equal(s.stress.wa.status?.state, 'found', s.stress.wa.status?.text + ' ' + (s.stress.wa.status?.detail ?? ''));
    const input = await fsp.readFile(path.join(root, 'cf/x/in'), 'utf8');
    assert.equal(Number(input.split('\n')[0]), 4, `shrinking should find n=4, got\n${input}`);
    s = await h.waitFor((x) => !!x.cases.find((c) => c.key === 'f:in')?.result?.debug, 30000);
    const inCase = s.cases.find((c) => c.key === 'f:in')!;
    assert.equal(inCase.result?.verdict, 'WA');
    assert.equal(inCase.stress, true);
    assert.ok(inCase.result?.diffReceived);
    h.c.dispose();
    h.integ.dispose();
  });
});

describe('integrations', () => {
  const problem = (index: string, tests: { input: string; output: string }[]): ProblemData => ({ ref: { site: 'codeforces', contestId: '2261', taskId: index, index, url: `https://codeforces.com/contest/2261/problem/${index}`, cfKind: 'contest' }, name: `${index}. Thing`, timeLimitMs: 2000, memoryLimitMb: 256, interactive: false, tests, scrapedAt: Date.now() });
  const contest = (tasks: boolean): ContestInfo => ({ ref: { site: 'codeforces', contestId: '2261', url: 'https://codeforces.com/contest/2261', cfKind: 'contest' }, name: 'Codeforces Round X', tasks: tasks ? [{ index: 'A', taskId: 'A', name: 'Alpha', url: 'https://codeforces.com/contest/2261/problem/A', timeLimitMs: 1000 }, { index: 'B1', taskId: 'B1', name: 'Beta', url: 'https://codeforces.com/contest/2261/problem/B1' }] : null, endTime: Date.now() + 3600e3, seenAt: Date.now() });
  const submitted: any[] = [];
  let focusTask = 'A';

  it('imports, writes contests from the snippet, auto-imports on visit, submits and colours verdicts', async () => {
    const root = await mkws({ 'old/z.cpp': DOUBLE });
    fake.commands.set('cp2bridge._state', () => ({ connected: true, leader: true, focus: { problem: problem('A', [{ input: '1\n', output: '2\n' }]), contest: contest(true) } }));
    fake.commands.set('cp2bridge._request', async (op: string, args: any) => {
      if (op === 'scrape') return problem(args?.ref?.taskId ?? focusTask, [{ input: '1\n', output: '2\n' }, { input: '2\n', output: '4\n' }]);
      if (op === 'submit') {
        submitted.push(args);
        return { ok: true, message: 'In queue' };
      }
      if (op === 'tasks') return null;
      throw new Error(op);
    });
    fake.commands.set('cp2bridge._snippet', () => 'int main() {\n\t$0\n}');
    const h = harness(root);
    await sleep(50);
    const z = path.join(root, 'old/z.cpp');
    await h.c.setActive(z);
    let s = await h.state();
    assert.match(s.importBtn.label, /^Import · 2261 A/);
    await h.integ.doImport(z);
    s = await h.state();
    assert.equal(s.cases.filter((c) => c.origin === 'imported').length, 2);
    assert.equal(s.problem?.timeLimitMs, 2000);
    assert.equal(s.submitBtn.enabled, true);
    assert.match(fake.statusBar['cp2.problem'] ?? '', /2261 A/);
    assert.match(s.importBtn.label, /^Re-import · 2261 A/);

    // the browser moves on to B1: the button follows it and says it will re-link the file
    focusTask = 'B1';
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'focus', focus: { problem: problem('B1', [{ input: '7\n', output: '14\n' }]), contest: contest(true) } });
    s = await h.state();
    assert.match(s.importBtn.label, /^Import · 2261 B1/);
    assert.match(s.importBtn.note ?? '', /Linked to 2261 A.*2261 B1 instead/);
    await h.integ.doImport(z);
    s = await h.state();
    assert.match(s.importBtn.label, /^Re-import · 2261 B1/);
    const zidx = (await h.c.indexFor(await h.c.storeFor(z))).data;
    assert.equal(zidx.bindings['codeforces:2261:A'], undefined, 'old link removed');
    assert.equal(zidx.bindings['codeforces:2261:B1'], 'old/z.cpp');
    // a plain PDF: samples only, and the file is unlinked
    const pdfFocus = { ref: { site: 'web', contestId: '', taskId: 'file:///tmp/camp.pdf', url: 'file:///tmp/camp.pdf' }, name: 'camp.pdf', tests: [{ input: '9\n', output: '18\n' }], pdfUrl: 'file:///tmp/camp.pdf', anonymous: true, scrapedAt: Date.now() };
    fake.commands.set('cp2bridge._request', async (op: string, args: any) => (op === 'scrape' && !args?.ref ? pdfFocus : null));
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'focus', focus: { problem: pdfFocus, contest: contest(true) } });
    s = await h.state();
    assert.equal(s.importBtn.label, 'Import · camp.pdf');
    assert.match(s.importBtn.note ?? '', /unlinks/);
    assert.match(fake.statusBar['cp2.problem'] ?? '', /camp\.pdf/);
    await h.integ.doImport(z);
    s = await h.state();
    assert.equal(s.submitBtn.enabled, false, 'no longer linked');
    assert.deepEqual(
      s.cases.filter((c) => c.origin === 'imported').map((c) => c.input.text),
      ['9\n'],
    );
    fake.commands.set('cp2bridge._request', async (op: string, args: any) => {
      if (op === 'scrape') return problem(args?.ref?.taskId ?? focusTask, [{ input: '1\n', output: '2\n' }, { input: '2\n', output: '4\n' }]);
      if (op === 'submit') {
        submitted.push(args);
        return { ok: true, message: 'In queue' };
      }
      return null;
    });

    // back to A for the rest of the test
    focusTask = 'A';
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'focus', focus: { problem: problem('A', [{ input: '1\n', output: '2\n' }]), contest: contest(true) } });
    await h.integ.doImport(z);

    // Write contest into a folder
    const folder = path.join(root, 'codeforces/2261');
    await h.integ.writeContest(Uri.file(folder) as any, true);
    const a = path.join(folder, 'a.cpp');
    const b1 = path.join(folder, 'b1.cpp');
    assert.equal(await fsp.readFile(a, 'utf8'), 'int main() {\n    \n}\n');
    assert.ok(fs.existsSync(b1));
    const pa = await h.c.getProblem(a);
    assert.deepEqual(pa.meta.snippetCursor, { line: 1, character: 4 });
    assert.equal(pa.meta.binding?.taskId, 'A');
    assert.equal(pa.meta.settings.timeLimitMs, 1000);

    // visiting B1's tab imports its samples once
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'visit', problem: problem('B1', [{ input: '7\n', output: '14\n' }]) });
    const pb = await h.c.getProblem(b1);
    assert.equal(pb.meta.cases.filter((c) => c.origin === 'imported').length, 1);
    assert.equal(pb.meta.autoImported, true);

    // submit: never run -> asks; answer "Submit anyway"
    fake.warningAnswer = 'Submit anyway';
    await h.c.setActive(b1);
    await h.integ.doSubmit(b1);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].ref.taskId, 'B1');
    assert.match(submitted[0].languagePatterns[0], /G/);
    assert.ok(fake.messages.some((m) => m.kind === 'warning' && /Submit b1\.cpp/.test(m.text)));
    let deco = fake.decorationProviders[fake.decorationProviders.length - 1].provideFileDecoration(Uri.file(b1));
    assert.equal(deco.color.id.startsWith('cp2.verdict.judging'), true);

    // verdict arrives
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'verdict', update: { ref: problem('B1', []).ref, status: 'accepted', text: 'Accepted', short: 'AC', at: Date.now(), final: true } });
    deco = fake.decorationProviders[fake.decorationProviders.length - 1].provideFileDecoration(Uri.file(b1));
    assert.equal(deco.color.id, 'cp2.verdict.accepted');
    await sleep(50);
    assert.match(fake.statusText, /CF 2261 · A B1✓/);
    // later rejection keeps it green (accepted earlier)
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'verdict', update: { ref: problem('B1', []).ref, status: 'rejected', text: 'Wrong answer on test 2', short: 'WA', at: Date.now(), final: true } });
    deco = fake.decorationProviders[fake.decorationProviders.length - 1].provideFileDecoration(Uri.file(b1));
    assert.equal(deco.color.id, 'cp2.verdict.accepted');
    h.c.dispose();
    h.integ.dispose();
  });

  it('writes a contest that has not started once its task list appears', async () => {
    const root = await mkws({ 'x.cpp': DOUBLE });
    fake.commands.set('cp2bridge._state', () => ({ connected: true, leader: true, focus: { problem: null, contest: contest(false) } }));
    fake.quickPick = (items) => items[0];
    const h = harness(root);
    await sleep(50);
    const folder = path.join(root, 'cf/2261');
    await h.integ.writeContest(Uri.file(folder) as any, true);
    assert.ok(!fs.existsSync(path.join(folder, 'a.cpp')));
    const idx = JSON.parse(await fsp.readFile(path.join(root, '.cp2/index.json'), 'utf8'));
    assert.equal(idx.pendingContests.length, 1);
    await fake.commands.get('cp2._bridgeEvent')!({ type: 'focus', focus: { problem: null, contest: contest(true) } });
    assert.ok(fs.existsSync(path.join(folder, 'a.cpp')));
    assert.ok(fs.existsSync(path.join(folder, 'b1.cpp')));
    h.c.dispose();
    h.integ.dispose();
  });
});

describe('large cases', () => {
  it('runs a 12 MB case without pushing it through the sidebar', async () => {
    const SUM = '#include <cstdio>\nint main(){long long s=0,x;while(scanf("%lld",&x)==1)s+=x;printf("%lld\\n",s);}\n';
    const root = await mkws({ 'big/s.cpp': SUM });
    const nums: string[] = [];
    let total = 0;
    for (let i = 0; i < 3_000_000; i++) {
      nums.push(String(i % 1000));
      total += i % 1000;
    }
    await fsp.writeFile(path.join(root, 'big/in'), nums.join('\n') + '\n');
    await fsp.writeFile(path.join(root, 'big/ans'), `${total}\n`);
    const h = harness(root);
    fake.config['cp2.cpp.flags'] = '-O2';
    await h.c.setActive(path.join(root, 'big/s.cpp'));
    const t0 = Date.now();
    await h.c.runAll();
    const s = await h.waitFor((x) => !x.running && x.cases[0]?.result?.verdict === 'AC', 30000);
    const elapsed = Date.now() - t0;
    const c = s.cases[0];
    assert.ok(c.input.size > 10_000_000, `size ${c.input.size}`);
    assert.equal(c.input.truncated, true);
    assert.ok((c.input.text ?? '').length <= 1024 * 1024, 'only a preview is sent');
    const t1 = Date.now();
    await h.state();
    const rerender = Date.now() - t1;
    console.log(`    12 MB case: run+judge ${elapsed} ms, re-render ${rerender} ms`);
    assert.ok(rerender < 200, `re-render took ${rerender} ms`);
    h.c.dispose();
    h.integ.dispose();
  });
});
