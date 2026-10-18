// Reads the lines around `line` from a (possibly huge) file, for showing a difference that lies
// beyond the start of the file.

import * as fs from 'fs';

export interface TextWindow {
  text: string;
  startLine: number;
  truncated: boolean;
  size: number;
}

export async function readLineWindow(file: string, line: number, before = 60, after = 140, maxBytes = 256 * 1024): Promise<TextWindow | null> {
  let size = 0;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return null;
  }
  const first = Math.max(1, line - before);
  const last = line + after;
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 16 });
    let cur = 1;
    let carry = '';
    const out: string[] = [];
    let bytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve({ text: out.join('\n') + (out.length ? '\n' : ''), startLine: first, truncated: true, size });
    };
    stream.on('data', (chunk: string | Buffer) => {
      const s = carry + chunk.toString('utf8');
      const parts = s.split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) {
        if (cur >= first && cur <= last) {
          out.push(p.replace(/\r$/, ''));
          bytes += p.length;
          if (bytes > maxBytes) return finish();
        }
        cur++;
        if (cur > last) return finish();
      }
    });
    stream.on('end', () => {
      if (carry && cur >= first && cur <= last) out.push(carry);
      finish();
    });
    stream.on('error', () => finish());
  });
}
