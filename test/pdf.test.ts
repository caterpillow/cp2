import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { analyzePdfPages, pdfPages, samplesFromPdf } from '../browser/src/scrape/pdf';
import { samplesInSelection } from '../shared/pdfSelect';

(Promise as any).withResolvers ??= function () {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

const fx = (n: string) => new Uint8Array(fs.readFileSync(path.join(process.env.CP2_ROOT ?? process.cwd(), 'test/fixtures', n)));
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs' as string) as Promise<any>;

describe('pdf samples', () => {
  it('oj.uz (JOI, side by side)', async () => {
    const t = await samplesFromPdf(await pdfjs(), fx('ojuz_jail.pdf'));
    assert.ok(t.length >= 2, `found ${t.length}`);
    assert.equal(t[0].input, '1\n8\n1 2\n2 3\n3 4\n4 5\n5 6\n6 7\n7 8\n2\n3 4\n4 8\n');
    assert.equal(t[0].output, 'Yes\n');
  });
  it('ORAC (AIO, side by side)', async () => {
    const t = await samplesFromPdf(await pdfjs(), fx('orac2_1.pdf'));
    assert.deepEqual(t, [{ input: '2 3\n7 6 7\n6 8 9\n', output: '5\n' }]);
  });
  it('stacked headings', async () => {
    const t = await samplesFromPdf(await pdfjs(), fx('stacked_statement.pdf'));
    assert.equal(t.length, 1);
    assert.equal(t[0].input, '130 340 5\n10 50\n130 130\n70 170\n0 180\n60 260\n');
    assert.equal(t[0].output, '1\n');
  });
  it('IOI function-call examples give nothing', async () => {
    assert.deepEqual(await samplesFromPdf(await pdfjs(), fx('ioi_carpet.pdf')), []);
  });
});

describe('pdf selections', () => {
  it('a contest PDF: only the samples in the selected region', async () => {
    const lib = await pdfjs();
    // Three problems in one PDF: AIO (1 sample), a stacked statement (1), JOI (several).
    const parts = [await pdfPages(lib, fx('orac2_1.pdf')), await pdfPages(lib, fx('stacked_statement.pdf')), await pdfPages(lib, fx('ojuz_jail.pdf'))];
    const { tests, index } = analyzePdfPages(parts.flat());
    const joi = tests.length - 2;
    assert.ok(joi >= 2, `JOI samples: ${joi}`);
    assert.equal(index.spans.length, tests.length);
    // What a viewer copies: the page's text in content order, with its own line breaks.
    const copied = (pages: { items: { str: string }[] }[]) => pages.flatMap((p) => p.items.map((i) => i.str)).join('\n');

    assert.deepEqual(samplesInSelection(index, copied(parts[1])), [1], 'the middle problem');
    assert.deepEqual(samplesInSelection(index, copied(parts[0])), [0], 'the first problem');
    const joiText = copied(parts[2]);
    assert.deepEqual(
      samplesInSelection(index, joiText),
      tests.slice(2).map((_, i) => i + 2),
      'all of the last problem',
    );
    // Rough: from the middle of a word in the second problem's statement to partway into the third.
    const mid = copied(parts[1]);
    const rough = mid.slice(Math.floor(mid.length / 3) + 3) + '\n' + joiText.slice(0, 40);
    assert.deepEqual(samplesInSelection(index, rough), [1]);
    // Only prose, no sample: from this PDF, but nothing to keep.
    assert.deepEqual(samplesInSelection(index, mid.slice(0, 120)), []);
    assert.equal(samplesInSelection(index, ''), null, 'nothing selected');
    assert.equal(samplesInSelection(index, 'int main() { return 0; } // unrelated clipboard'), null, 'not from this PDF');
  });
});

describe('pdf selections in the viewer\'s own text', () => {
  it("Chromium's viewer copies side-by-side samples in its own order: rough selections still pick the right one", async () => {
    const { tests, index } = analyzePdfPages(await pdfPages(await pdfjs(), fx('ojuz_jail.pdf')));
    // What getSelectedText returned for the whole document in Chrome (test/fixtures/ojuz_jail.viewer.txt).
    const viewer = new TextDecoder().decode(fx('ojuz_jail.viewer.txt'));
    assert.equal(tests.length, 3);
    assert.deepEqual(samplesInSelection(index, viewer), [0, 1, 2]);
    const heads = [...viewer.matchAll(/Sample Input \d+/g)].map((m) => m.index!);
    heads.forEach((h, k) => {
      const rough = viewer.slice(Math.max(0, h - 7), k + 1 < heads.length ? heads[k + 1] - 5 : viewer.length);
      assert.deepEqual(samplesInSelection(index, rough), [k], `around sample ${k + 1}`);
    });
  });
});
