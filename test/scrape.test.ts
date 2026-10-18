import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { analyzePage } from '../browser/src/scrape/page';
import { parseAcSubmissions, parseCfSubmissions } from '../browser/src/scrape/verdicts';
import { parseTimeLimit, parseMemoryLimit } from '../browser/src/scrape/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseHTML } = require('linkedom');

const fx = (n: string) => fs.readFileSync(path.join(process.env.CP2_ROOT ?? process.cwd(), 'test/fixtures', n), 'utf8');
const doc = (html: string): Document => parseHTML(html).document;

describe('codeforces scraper', () => {
  it('reads samples split into per-line divs', () => {
    const info = analyzePage(doc(fx('cf_problem_2000A.html')), 'https://codeforces.com/contest/2000/problem/A');
    assert.equal(info.kind, 'problem');
    const p = info.problem!;
    assert.equal(p.name, 'A. Primary Task');
    assert.equal(p.timeLimitMs, 1000);
    assert.equal(p.memoryLimitMb, 256);
    assert.equal(p.interactive, false);
    assert.equal(p.tests.length, 1);
    assert.equal(p.tests[0].input, '7\n100\n1010\n101\n105\n2033\n1019\n1002\n');
    assert.equal(p.tests[0].output, 'NO\nYES\nNO\nYES\nNO\nYES\nNO\n');
  });

  it('flags interactive problems', () => {
    const p = analyzePage(doc(fx('cf_problem_1807E_interactive.html')), 'https://codeforces.com/contest/1807/problem/E').problem!;
    assert.equal(p.interactive, true);
  });

  it('handles problemset urls', () => {
    const p = analyzePage(doc(fx('cf_problemset_1850H.html')), 'https://codeforces.com/problemset/problem/1850/H').problem!;
    assert.equal(p.ref.contestId, '1850');
    assert.equal(p.ref.taskId, 'H');
    assert.ok(p.tests.length >= 1);
    assert.ok(p.tests[0].input.length > 0);
  });

  it('reads the contest dashboard', () => {
    const info = analyzePage(doc(fx('cf_contest_2000.html')), 'https://codeforces.com/contest/2000');
    assert.equal(info.kind, 'contest');
    const c = info.contest!;
    assert.equal(c.name, 'Codeforces Round 966 (Div. 3)');
    assert.deepEqual(
      c.tasks!.map((t) => t.index),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    );
    assert.equal(c.tasks![0].name, 'Primary Task');
    assert.equal(c.tasks![0].timeLimitMs, 1000);
    assert.equal(c.tasks![0].url, 'https://codeforces.com/contest/2000/problem/A');
  });

  it('picks a problem on the all-problems page', () => {
    const info = analyzePage(doc(fx('cf_problems_2000.html')), 'https://codeforces.com/contest/2000/problems', { index: 'C' });
    assert.equal(info.kind, 'problems');
    assert.equal(info.problem?.ref.taskId, 'C');
    assert.match(info.problem!.name, /^C\./);
    assert.ok(info.problem!.tests.length >= 1);
    assert.equal(info.contest?.tasks?.length, 8);
  });
});

describe('atcoder scraper', () => {
  it('reads English samples and limits', () => {
    const p = analyzePage(doc(fx('atcoder_task_abc400_c.html')), 'https://atcoder.jp/contests/abc400/tasks/abc400_c?lang=en').problem!;
    assert.equal(p.name, 'C - 2^a b^2');
    assert.equal(p.ref.index, 'C');
    assert.equal(p.timeLimitMs, 2000);
    assert.equal(p.memoryLimitMb, 1024);
    assert.equal(p.tests.length, 3);
    assert.deepEqual(p.tests[0], { input: '20\n', output: '5\n' });
    assert.deepEqual(p.tests[2], { input: '1234567890\n', output: '42413\n' });
  });

  it('reads the task list with times', () => {
    const c = analyzePage(doc(fx('atcoder_tasks_abc400.html')), 'https://atcoder.jp/contests/abc400/tasks').contest!;
    assert.equal(c.name, 'AtCoder Beginner Contest 400');
    assert.equal(c.tasks?.[0].index, 'A');
    assert.equal(c.tasks?.[0].taskId, 'abc400_a');
    assert.equal(c.tasks?.[1].name, 'Sum of Geometric Series');
    assert.equal(c.tasks?.[0].timeLimitMs, 2000);
    assert.equal(c.endTime! - c.startTime!, 100 * 60 * 1000);
  });

  it('top page has no task list but has times', () => {
    const c = analyzePage(doc(fx('atcoder_top_abc400.html')), 'https://atcoder.jp/contests/abc400').contest!;
    assert.equal(c.tasks, null);
    assert.ok(c.startTime && c.endTime);
  });

  it('reads task links from standings', () => {
    const html = `<html><body><table><thead><tr><th>Rank</th><th><a href="/contests/abc480/tasks/abc480_a">A</a></th><th><a href="/contests/abc480/tasks/abc480_b">B</a></th><th><a href="/contests/abc480/tasks/abc480_h">Ex</a></th></tr></thead></table></body></html>`;
    const c = analyzePage(doc(html), 'https://atcoder.jp/contests/abc480/standings').contest!;
    assert.deepEqual(
      c.tasks!.map((t) => [t.index, t.taskId]),
      [
        ['A', 'abc480_a'],
        ['B', 'abc480_b'],
        ['Ex', 'abc480_h'],
      ],
    );
  });
});

describe('verdict parsing', () => {
  it('codeforces rows', () => {
    const html = `<table class="status-frame-datatable"><tr data-submission-id="111"><td><a href="/contest/2261/problem/D2">D2 - X</a></td><td class="status-cell status-verdict-cell" waiting="false"><span class="submissionVerdictWrapper"><span class="verdict-rejected">Wrong answer on test <span class="verdict-format-judged">3</span></span></span></td></tr>
      <tr data-submission-id="110"><td><a href="/contest/2261/problem/C">C</a></td><td class="status-cell status-verdict-cell" waiting="true">Running on test 4</td></tr>
      <tr data-submission-id="109"><td><a href="/contest/2261/problem/B">B</a></td><td class="status-cell status-verdict-cell"><span class="verdict-accepted">Pretests passed</span></td></tr></table>`;
    const rows = parseCfSubmissions(doc(`<html><body>${html}</body></html>`));
    assert.deepEqual(
      rows.map((r) => [r.taskId, r.status, r.short, r.final, r.text]),
      [
        ['D2', 'rejected', 'WA', true, 'Wrong answer on test 3'],
        ['C', 'judging', '', false, 'Running on test 4'],
        ['B', 'accepted', 'AC', true, 'Pretests passed'],
      ],
    );
  });

  it('atcoder rows', () => {
    const html = `<table><tbody><tr><td><a href="/contests/abc400/tasks/abc400_c">C</a></td><td class="text-center"><span class="label label-warning">WA</span></td><td><a href="/contests/abc400/submissions/555">Detail</a></td></tr>
      <tr><td><a href="/contests/abc400/tasks/abc400_d">D</a></td><td class="waiting-judge"><span class="label label-default">3/18</span></td><td><a href="/contests/abc400/submissions/556">Detail</a></td></tr></tbody></table>`;
    const rows = parseAcSubmissions(doc(`<html><body>${html}</body></html>`));
    assert.deepEqual(
      rows.map((r) => [r.taskId, r.status, r.short, r.final]),
      [
        ['abc400_c', 'rejected', 'WA', true],
        ['abc400_d', 'judging', '', false],
      ],
    );
  });

  it('parses limits', () => {
    assert.equal(parseTimeLimit('time limit per test2 seconds'), 2000);
    assert.equal(parseTimeLimit('1.5 s'), 1500);
    assert.equal(parseMemoryLimit('memory limit per test256 megabytes'), 256);
    assert.equal(parseMemoryLimit('1024 MiB'), 1024);
  });
});
