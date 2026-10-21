import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { compareStrings, numbersClose } from '../extension/src/core/compare';
import { matchFileCases } from '../extension/src/core/fileCases';
import { splitArgs } from '../extension/src/core/fsutil';
import { findLegacyProb, readLegacyProb } from '../extension/src/core/legacy';
import { resolveSnippet } from '../extension/src/core/snippet';
import { displayOrder, loadDirMeta, Problem, saveDirMeta, shrinkIndex, Store, StoreLocator, storedKey } from '../extension/src/core/store';
import { parseContestUrl, parseProblemUrl, problemKey, submitPageUrl } from '../shared/problemId';
import { createHash } from 'node:crypto';

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cp2-test-'));
}

describe('file case matching', () => {
  const pairs = (names: string[]) => Object.fromEntries(matchFileCases(names).map((m) => [m.input, m.expected]));

  it('matches the documented patterns', () => {
    const r = pairs(['in', 'ans', 'in3', 'out3', 'a.in', 'a.out', 'b.in', 'b.ans', 'b.out', 'x-in.txt', 'x-out.txt', 'y_in2.txt', 'input.txt', 'output.txt', '1.in', '1.out', 'gen.cpp', 'a.cpp']);
    assert.equal(r['in'], 'ans');
    assert.equal(r['in3'], 'out3');
    assert.equal(r['a.in'], 'a.out');
    assert.equal(r['b.in'], 'b.ans', '.ans preferred over .out');
    assert.equal(r['x-in.txt'], 'x-out.txt');
    assert.equal(r['y_in2.txt'], null);
    assert.equal(r['input.txt'], 'output.txt');
    assert.equal(r['1.in'], '1.out');
    assert.ok(!('gen.cpp' in r));
    assert.ok(!('ans' in r) && !('out3' in r));
  });

  it('only trusts glued AIO names when backed by a source or out file', () => {
    assert.deepEqual(pairs(['wormin.txt', 'wormout.txt']), { 'wormin.txt': 'wormout.txt' });
    assert.deepEqual(pairs(['wormin.txt', 'worm.cpp']), { 'wormin.txt': null });
    assert.deepEqual(pairs(['main.txt', 'login.txt']), {});
  });

  it('suggests an answer file name', () => {
    const m = matchFileCases(['in2', 'sample-in.txt']);
    assert.equal(m.find((x) => x.input === 'in2')?.expectedCandidate, 'ans2');
    assert.equal(m.find((x) => x.input === 'sample-in.txt')?.expectedCandidate, 'sample-ans.txt');
  });
});

describe('snippet resolution', () => {
  it('handles placeholders, choices, escapes and the cursor', () => {
    const r = resolveSnippet('int ${1:x} = $1;\\$ ${2|a,b|}\n\tfoo($0);', { insertSpaces: true, tabSize: 4 });
    assert.equal(r.text, 'int x = x;$ a\n    foo();\n');
    assert.deepEqual(r.cursor, { line: 1, character: 8 });
  });
  it('resolves variables', () => {
    const r = resolveSnippet('// ${TM_FILENAME_BASE} ${UNKNOWN:dflt}', { vars: { TM_FILENAME_BASE: 'a' } });
    assert.equal(r.text, '// a dflt\n');
  });
  it('matches tmpcf-style bodies', () => {
    const r = resolveSnippet('struct Solver {\n \n\tvoid sovle() {\n\t\t$0\n\t}\n};', { insertSpaces: true, tabSize: 4 });
    assert.equal(r.text, 'struct Solver {\n \n    void sovle() {\n        \n    }\n};\n');
    assert.deepEqual(r.cursor, { line: 3, character: 8 });
  });
});

describe('comparison', () => {
  it('standard ignores trailing spaces and blank lines like CPH', () => {
    assert.ok(compareStrings('1 2\n3\n', '1 2   \n3\n\n\n', 'standard').pass);
    assert.ok(compareStrings('\n\n1', '1', 'standard').pass);
    assert.ok(!compareStrings('1\n\n2', '1\n2', 'standard').pass);
  });
  it('reports the first difference', () => {
    const r = compareStrings('a\nb c\nd', 'a\nb x\nd', 'standard');
    assert.equal(r.pass, false);
    assert.deepEqual(r.diff, { expectedLine: 2, receivedLine: 2, expectedCol: 2, receivedCol: 2, expectedLen: 1, receivedLen: 1 });
    const missing = compareStrings('1\n2\n3', '1\n2', 'standard');
    assert.equal(missing.pass, false);
    assert.equal(missing.diff?.expectedLine, 3);
    assert.equal(missing.diff?.receivedLine, 3);
  });
  it('firstLine only checks line 1', () => {
    assert.ok(compareStrings('3\n1 2\n', '3\n2 1\n', 'firstLine').pass);
    assert.ok(!compareStrings('3\n1 2\n', '4\n1 2\n', 'firstLine').pass);
  });
  it('precision accepts 1e-6 absolute or relative error', () => {
    assert.ok(numbersClose('1000000', '1000000.5', 1e-6));
    assert.ok(numbersClose('0.1', '0.1000005', 1e-6));
    assert.ok(!numbersClose('0.1', '0.100002', 1e-6));
    assert.ok(compareStrings('YES 0.333333', 'YES   0.3333333333\n', 'precision').pass);
    const r = compareStrings('1.5 2.5', '1.5 2.6', 'precision');
    assert.equal(r.pass, false);
    assert.equal(r.diff?.receivedCol, 4);
  });
});

describe('urls', () => {
  it('parses problem urls to the same key', () => {
    const a = parseProblemUrl('https://codeforces.com/contest/2261/problem/D2')!;
    const b = parseProblemUrl('https://codeforces.com/problemset/problem/2261/d2')!;
    assert.equal(problemKey(a), problemKey(b));
    assert.equal(submitPageUrl(a), 'https://codeforces.com/contest/2261/submit/D2');
    const g = parseProblemUrl('https://codeforces.com/gym/102787/problem/A')!;
    assert.equal(g.cfKind, 'gym');
    const ac = parseProblemUrl('https://atcoder.jp/contests/abc400/tasks/abc400_c?lang=en')!;
    assert.equal(ac.taskId, 'abc400_c');
    assert.equal(parseProblemUrl('https://codeforces.com/contest/2261'), null);
    assert.equal(parseContestUrl('https://codeforces.com/contest/2261')?.contestId, '2261');
    assert.equal(parseContestUrl('https://atcoder.jp/contests/abc400/standings')?.contestId, 'abc400');
  });
});

describe('store', () => {
  it('problems saved before 0.3 keep only their pinned text files shown', async () => {
    const base = await tmpdir();
    const file = path.join(base, 'a.cpp');
    await fsp.writeFile(file, '');
    const store = new Store(base);
    await fsp.mkdir(store.problemDir(file), { recursive: true });
    await fsp.writeFile(path.join(store.problemDir(file), 'problem.json'), JSON.stringify({ version: 1, settings: {}, cases: [], order: ['f:in', 'f:in2'], pinned: ['f:in2'], hiddenFiles: ['in3'] }));
    const p = await Problem.load(file, store);
    assert.deepEqual(p.meta.shownFiles, ['in2']);
    assert.equal('hiddenFiles' in p.meta, false);
  });

  it('sweeps old trash across the whole store once', async () => {
    const base = await tmpdir();
    const store = new Store(base);
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const files: string[] = [];
    for (const rel of ['cases/a/x.cpp/.trash/1.in', 'cases/a/b/y.cpp/.trash/2.ans', 'cases/z.cpp/.trash/3.in']) {
      const f = path.join(store.root, ...rel.split('/'));
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, 'x');
      files.push(f);
    }
    for (const f of files.slice(0, 2)) await fsp.utimes(f, old, old);
    await store.sweepTrash();
    assert.deepEqual(
      files.map((f) => fs.existsSync(f)),
      [false, false, true],
    );
    assert.equal(fs.existsSync(path.join(store.root, 'cases/a/x.cpp/.trash')), false, 'empty trash folders go too');
  });

  it('deleted and replaced cases go to the trash, come back with their files, and old trash is cleared', async () => {
    const base = await tmpdir();
    const file = path.join(base, 'a.cpp');
    await fsp.writeFile(file, '');
    const store = new Store(base);
    const p = await Problem.load(file, store);
    const c = await p.addCase('manual', 'in1', 'ans1');
    const before = p.listState();
    await p.deleteCase(c.id);
    assert.equal(fs.existsSync(p.caseFile(c.id, 'in')), false);
    assert.equal(fs.existsSync(path.join(p.dir, '.trash', `${c.id}.in`)), true);
    const after = p.listState();
    await p.applyListState({ cases: before.cases, order: before.order });
    assert.equal(await p.readCaseText(c.id, 'in'), 'in1');
    assert.equal(await p.readCaseText(c.id, 'ans'), 'ans1');
    await p.applyListState({ cases: after.cases, order: after.order });
    assert.equal(p.meta.cases.length, 0);
    await p.replaceImported([{ input: 's', output: 't' }]);
    const old = p.meta.cases[0].id;
    await p.replaceImported([{ input: 'u', output: 'v' }]);
    assert.ok(fs.existsSync(path.join(p.dir, '.trash', `${old}.in`)), 'replaced samples are trashed too');
    // Trash older than a day goes when the problem is next loaded.
    const long = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await fsp.utimes(path.join(p.dir, '.trash', `${c.id}.in`), long, long);
    await p.flush();
    await Problem.load(file, store);
    for (let i = 0; i < 50 && fs.existsSync(path.join(p.dir, '.trash', `${c.id}.in`)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(path.join(p.dir, '.trash', `${c.id}.in`)), false);
    assert.equal(fs.existsSync(path.join(p.dir, '.trash', `${old}.in`)), true);
  });

  it('folder stress settings: old saved 0 means the slider was never moved', async () => {
    const base = await tmpdir();
    const store = new Store(base);
    const dir = path.join(base, 'x');
    await fsp.mkdir(path.dirname(store.dirMetaFile(dir)), { recursive: true });
    await fsp.writeFile(store.dirMetaFile(dir), JSON.stringify({ version: 1, wa: { sus: 'x.cpp' }, re: {}, shrink: { wa: 0, re: 4 }, open: { wa: true, re: false } }));
    const m = await loadDirMeta(store, dir);
    assert.deepEqual({ ...m.shrink }, { re: 4 });
    assert.equal(m.wa.sus, 'x.cpp');
    m.shrink.wa = 0;
    await saveDirMeta(store, dir, m);
    assert.deepEqual((await loadDirMeta(store, dir)).shrink, { wa: 0, re: 4 }, 'a 0 chosen now is kept');
    assert.deepEqual([0, 0.5, 0.7, 3, 100].map(shrinkIndex), [0, 2, 2, 4, 6]);
  });

  it('stores cases, keeps the imported block in place and carries pins by sample', async () => {
    const base = await tmpdir();
    const file = path.join(base, 'x', 'a.cpp');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '');
    const store = new Store(base);
    const p = await Problem.load(file, store);
    assert.equal(p.isMaterialized, false);
    const m1 = await p.addCase('manual', '1\n', '2\n');
    await p.replaceImported([{ input: 'i1', output: 'o1' }, { input: 'i2', output: 'o2' }]);
    let order = displayOrder(p.meta, ['f:in']).map((x) => x.key);
    const imp = p.meta.cases.filter((c) => c.origin === 'imported');
    assert.deepEqual(order, [storedKey(imp[0].id), storedKey(imp[1].id), storedKey(m1.id), 'f:in']);
    p.setPinned(storedKey(imp[1].id), true);
    p.setPinned('f:in', true);
    await p.replaceImported([{ input: 'j1', output: 'p1' }, { input: 'j2', output: 'p2' }, { input: 'j3', output: 'p3' }]);
    const imp2 = p.meta.cases.filter((c) => c.origin === 'imported');
    assert.equal(imp2.length, 3);
    order = displayOrder(p.meta, ['f:in']).map((x) => x.key);
    assert.deepEqual(order.slice(0, 2), [storedKey(imp2[1].id), 'f:in'], 'pins carried over by sample number');
    assert.equal(await p.readCaseText(imp2[2].id, 'in'), 'j3');
    await p.flush();
    const again = await Problem.load(file, store);
    assert.equal(again.meta.cases.length, 4);
    assert.equal(await fsp.readFile(path.join(base, '.cp2', '.gitignore'), 'utf8').then((s) => s.includes('*')), true);
  });

  it('finds the nearest .cp2', async () => {
    const base = await tmpdir();
    await fsp.mkdir(path.join(base, '.cp2'));
    await fsp.mkdir(path.join(base, 'a', 'b'), { recursive: true });
    const loc = new StoreLocator(() => [path.join(base, 'a')]);
    const s = await loc.storeFor(path.join(base, 'a', 'b', 'x.cpp'));
    assert.equal(s.base, base);
  });

  it('imports legacy CPH cases', async () => {
    const base = await tmpdir();
    const file = path.join(base, 'p.cpp');
    await fsp.writeFile(file, '');
    const hash = createHash('md5').update(file).digest('hex');
    await fsp.mkdir(path.join(base, '.cph'));
    const prob = path.join(base, '.cph', `.p.cpp_${hash}.prob`);
    await fsp.writeFile(prob, JSON.stringify({ name: 'Local: p', tests: [{ id: 1, input: '1 2', output: '3' }], local: true, srcPath: file }));
    assert.equal(await findLegacyProb(file), prob);
    assert.equal((await readLegacyProb(prob))?.tests[0].output, '3');
    const p = await Problem.load(file, new Store(base));
    assert.equal(p.meta.cases.length, 1);
    assert.equal(await p.readCaseText(p.meta.cases[0].id, 'in'), '1 2');
    // moved folder: hash no longer matches but the name does
    const moved = path.join(base, 'moved');
    await fsp.mkdir(moved);
    await fsp.rename(path.join(base, '.cph'), path.join(moved, '.cph'));
    assert.equal(await findLegacyProb(path.join(moved, 'p.cpp')), path.join(moved, '.cph', `.p.cpp_${hash}.prob`));
  });

  it('splits flags like a shell', () => {
    assert.deepEqual(splitArgs(`-O2 -DX="a b" '-Dy=1'  -g`), ['-O2', '-DX=a b', '-Dy=1', '-g']);
  });
});
