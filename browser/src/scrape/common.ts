// Helpers shared by the site scrapers. They only use the DOM API, so they run in content
// scripts, in the offscreen document (for fetched pages) and in tests (linkedom).

/** Text of a sample <pre>, handling Codeforces' per-line <div>s and <br>s. */
export function preText(pre: Element): string {
  const lines = pre.querySelectorAll('.test-example-line');
  let text: string;
  if (lines.length) {
    text = Array.from(lines)
      .map((l) => l.textContent ?? '')
      .join('\n');
  } else {
    const clone = pre.cloneNode(true) as Element;
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    text = clone.textContent ?? '';
  }
  text = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return text ? text + '\n' : '';
}

export function cleanText(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** "2 seconds", "1 second", "2 sec", "1.5 s", "2000 ms" -> ms */
export function parseTimeLimit(text: string): number | undefined {
  const m = text.match(/([\d.]+)\s*(ms|milliseconds?|s|sec|secs|seconds?)\b/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  return Math.round(/^ms|^milli/i.test(m[2]) ? v : v * 1000);
}

/** "256 megabytes", "1024 MiB", "256 MB", "1 GB" -> MB */
export function parseMemoryLimit(text: string): number | undefined {
  const m = text.match(/([\d.]+)\s*(KiB|KB|K|MiB|MB|M|megabytes?|GiB|GB|G|gigabytes?)\b/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith('k')) return Math.round(v / 1024);
  if (u.startsWith('g')) return Math.round(v * 1024);
  return Math.round(v);
}

/** Value cells under header cells like "Time limit" / "Memory limit" (oj.uz, ORAC). */
export function headerTable(doc: Document | Element): Map<string, string> {
  const out = new Map<string, string>();
  doc.querySelectorAll('table').forEach((t) => {
    const rows = Array.from(t.querySelectorAll('tr'));
    for (let i = 0; i + 1 < rows.length; i++) {
      const heads = Array.from(rows[i].querySelectorAll('th')).map((c) => cleanText(c).toLowerCase());
      if (!heads.length) continue;
      const vals = Array.from(rows[i + 1].querySelectorAll('td')).map((c) => cleanText(c));
      heads.forEach((h, k) => {
        if (vals[k] !== undefined && !out.has(h)) out.set(h, vals[k]);
      });
    }
  });
  return out;
}

/** Absolute URL of a PDF statement embedded in the page (iframe / embed / object / pdf.js viewer). */
export function embeddedPdf(doc: Document, base: string): string | undefined {
  for (const el of Array.from(doc.querySelectorAll('iframe[src], embed[src], object[data]'))) {
    const raw = el.getAttribute('src') ?? el.getAttribute('data') ?? '';
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    const file = url.searchParams.get('file');
    if (file) {
      try {
        return new URL(file, url).href;
      } catch {
        /* fall through */
      }
    }
    if (/\.pdf($|[?#])/i.test(url.pathname + url.search) || /type=statement/.test(url.search) || /statement/i.test(url.pathname)) return url.href;
  }
  return undefined;
}
