import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { samplesFromPdf } from '../browser/src/scrape/pdf';

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
