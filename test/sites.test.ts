import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { genericSamples } from '../browser/src/scrape/generic';
import { analyzePage } from '../browser/src/scrape/page';
import { parseDmojSubmissions } from '../browser/src/scrape/verdicts';
import { parseContestUrl, parseProblemUrl, problemKey, shortProblemId } from '../shared/problemId';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseHTML } = require('linkedom');

const fx = (n: string) => fs.readFileSync(path.join(process.env.CP2_ROOT ?? process.cwd(), 'test/fixtures', n), 'utf8');
const doc = (html: string): Document => parseHTML(html).document;

describe('more judges', () => {
  it('parses urls of the new sites', () => {
    assert.equal(parseProblemUrl('https://dmoj.ca/problem/ccc22s1')?.taskId, 'ccc22s1');
    assert.equal(problemKey(parseProblemUrl('https://qoj.ac/contest/1/problem/5')!), problemKey(parseProblemUrl('https://qoj.ac/problem/5')!));
    assert.equal(parseProblemUrl('https://oj.uz/problem/view/JOI22_jail')?.taskId, 'JOI22_jail');
    assert.equal(parseProblemUrl('https://orac2.info/problem/1/')?.url, 'https://orac2.info/problem/1/');
    assert.equal(parseContestUrl('https://dmoj.ca/contest/ccc22s')?.contestId, 'ccc22s');
    assert.equal(shortProblemId(parseProblemUrl('https://dmoj.ca/problem/ccc22s1')!), 'DMOJ ccc22s1');
  });

  it('DMOJ problem: limits and "Output for Sample Input" samples', () => {
    const p = analyzePage(doc(fx('dmoj_problem_synthetic.html')), 'https://dmoj.ca/problem/ccc22s1').problem!;
    assert.equal(p.name, "CCC '22 S1 - Good Fours and Good Fives");
    assert.equal(p.timeLimitMs, 2000);
    assert.equal(p.memoryLimitMb, 1024);
    assert.deepEqual(p.tests, [
      { input: '14\n', output: '1\n' },
      { input: '40\n', output: '3\n' },
    ]);
  });

  it('oj.uz and ORAC: PDF statement, limits, file io', () => {
    const o = analyzePage(doc(fx('ojuz_problem.html')), 'https://oj.uz/problem/view/JOI22_jail').problem!;
    assert.equal(o.name, 'Jail');
    assert.equal(o.timeLimitMs, 5000);
    assert.equal(o.memoryLimitMb, 1024);
    assert.match(o.pdfUrl ?? '', /^https:\/\/static\.oj\.uz\/.*statement_en\.pdf$/);
    const r = analyzePage(doc(fx('orac2_problem.html')), 'https://orac2.info/problem/1/').problem!;
    assert.equal(r.name, 'The Terrifying Canary-Bird');
    assert.equal(r.timeLimitMs, 1000);
    assert.equal(r.pdfUrl, 'https://orac2.info/problem/1/statement.pdf');
    assert.deepEqual(r.ioFiles, { input: 'birdin.txt', output: 'birdout.txt' });
  });

  it('QOJ: limits and PDF statements', () => {
    const q = analyzePage(doc(fx('qoj_problem_1.html')), 'https://qoj.ac/problem/1').problem!;
    assert.equal(q.timeLimitMs, 1000);
    assert.equal(q.memoryLimitMb, 2048);
    const q7 = analyzePage(doc(fx('qoj_problem_7.html')), 'https://qoj.ac/problem/7').problem!;
    assert.equal(q7.pdfUrl, 'https://qoj.ac/download.php?type=statement&id=7');
  });

  it('generic samples: CSES style, numbered, tables, CJK', () => {
    const cses = genericSamples(doc('<div><h1>Example</h1><p>Input:</p><pre>3\n1 2 3</pre><p>Output:</p><pre>6</pre></div>').querySelector('div'));
    assert.deepEqual(cses, [{ input: '3\n1 2 3\n', output: '6\n' }]);
    const prose = genericSamples(doc('<div><h2>Input</h2><p>The first line of input contains an integer n, the number of things that will follow in the input below.</p><pre>not a sample</pre></div>').querySelector('div'));
    assert.deepEqual(prose, []);
    const numbered = genericSamples(doc('<div><h3>Sample Input 2</h3><pre>b</pre><h3>Sample Output 2</h3><pre>B</pre><h3>Sample Input 1</h3><pre>a</pre><h3>Sample Output 1</h3><pre>A</pre></div>').querySelector('div'));
    assert.deepEqual(numbered, [{ input: 'b\n', output: 'B\n' }, { input: 'a\n', output: 'A\n' }]);
    const kattis = genericSamples(doc('<div><table class="sample"><tr><th>Sample Input 1</th><th>Sample Output 1</th></tr><tr><td><pre>1 2</pre></td><td><pre>3</pre></td></tr></table></div>').querySelector('div'));
    assert.deepEqual(kattis, [{ input: '1 2\n', output: '3\n' }]);
    const cjk = genericSamples(doc('<div><h3>样例输入 1</h3><pre>5</pre><h3>样例输出 1</h3><pre>25</pre></div>').querySelector('div'));
    assert.deepEqual(cjk, [{ input: '5\n', output: '25\n' }]);
  });

  it('DMOJ verdict rows', () => {
    const rows = parseDmojSubmissions(doc(`<div class="submission-row" id="555"><div class="sub-result WA"><div class="score">30 / 100</div><div class="state"><span title="Wrong Answer" class="status">WA</span> | <span class="language">C++20</span></div></div><div class="sub-main"><div class="sub-info"><div class="name"><a href="/problem/ccc22s1">X</a></div></div></div></div>
      <div class="submission-row" id="556"><div class="sub-result G"><div class="score"><i class="fa fa-spinner"></i></div><div class="state"><span title="Grading" class="status">G</span></div></div></div>`));
    assert.equal(rows[0].submissionId, '555');
    assert.equal(rows[0].taskId, 'ccc22s1');
    assert.equal(rows[0].status, 'partial');
    assert.equal(rows[0].final, true);
    assert.equal(rows[0].text, 'Wrong Answer (30/100)');
    assert.equal(rows[1].status, 'judging');
  });
});
