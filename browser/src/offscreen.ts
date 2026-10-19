// Offscreen document: MV3 service workers have no DOMParser (and can't start pdf.js workers),
// so fetched pages and PDF statements are parsed here.
// The legacy build polyfills newer JS (Uint8Array.toHex etc.) for older Chromium-based browsers.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePage, submissionRows } from './scrape/page';
import { samplesFromPdf } from './scrape/pdf';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'pdf') {
    samplesFromPdf(pdfjs as any, fromBase64(msg.data)).then(
      (tests) => reply({ ok: true, tests }),
      (e) => reply({ ok: false, error: String(e?.message ?? e) }),
    );
    return true;
  }
  try {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    if (msg.type === 'page') reply(analyzePage(doc, msg.url, msg.pick));
    else if (msg.type === 'rows') reply(submissionRows(doc, msg.url));
    else reply(null);
  } catch {
    reply(null);
  }
  return false;
});
