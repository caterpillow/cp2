// Offscreen document: MV3 service workers have no DOMParser, so fetched pages are parsed here.
import { analyzePage, submissionRows } from './scrape/page';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  try {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    if (msg.type === 'page') reply(analyzePage(doc, msg.url, msg.pick));
    else if (msg.type === 'rows') reply(submissionRows(doc, msg.url));
    else reply(null);
  } catch (e) {
    reply(null);
  }
  return false;
});
