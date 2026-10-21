// Offscreen document: MV3 service workers have no DOMParser (and can't start pdf.js workers),
// so fetched pages and PDF statements are parsed here.
// The legacy build polyfills newer JS (Uint8Array.toHex etc.) for older Chromium-based browsers.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePage, submissionRows } from './scrape/page';
import { analyzePdf } from './scrape/pdf';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

/** XHR (unlike fetch) can read file:// URLs once "Allow access to file URLs" is on for cp2. */
function load(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.withCredentials = true;
    x.onload = () => {
      if ((x.status === 200 || (x.status === 0 && x.response)) && x.response) resolve(new Uint8Array(x.response));
      else reject(new Error(`couldn't download the PDF (HTTP ${x.status})`));
    };
    x.onerror = () =>
      reject(new Error(url.startsWith('file:') ? 'cp2 may not read local files yet: turn on "Allow access to file URLs" for cp2 on the browser\'s extensions page' : "couldn't download the PDF"));
    x.send();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'pdf') {
    load(msg.url)
      .then((data) => analyzePdf(pdfjs as any, data))
      .then(
        ({ tests, index }) => reply({ ok: true, tests, index }),
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
