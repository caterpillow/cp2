import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function isDir(p: string): Promise<boolean> {
  return (await statOrNull(p))?.isDirectory() ?? false;
}

export async function isFile(p: string): Promise<boolean> {
  return (await statOrNull(p))?.isFile() ?? false;
}

export async function mkdirp(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

let tmpCounter = 0;

/** Writes via a temp file + rename so readers never see half-written data. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await mkdirp(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpCounter++).toString(36)}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  const t = await readText(file);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export interface Head {
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** Reads at most `maxBytes` from the start of a file (cut back to a line boundary when truncated). */
export async function readHead(file: string, maxBytes: number): Promise<Head | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const n = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const { bytesRead } = await fh.read(buf, off, n - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    let slice = buf.subarray(0, off);
    const truncated = st.size > off;
    if (truncated) {
      const nl = slice.lastIndexOf(10);
      if (nl > 0) slice = slice.subarray(0, nl + 1);
    }
    return { text: slice.toString('utf8'), size: st.size, truncated, binary: isProbablyBinary(slice) };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function sha1(data: string | Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export async function sha1File(file: string): Promise<string> {
  return sha1(await fsp.readFile(file));
}

export function randomId(len = 8): string {
  return crypto.randomBytes(len).toString('base64url').replace(/[-_]/g, '').slice(0, len).toLowerCase().padEnd(len, '0');
}

export async function copyFileP(src: string, dst: string): Promise<void> {
  await mkdirp(path.dirname(dst));
  await fsp.copyFile(src, dst);
}

/** Moves a file or directory, falling back to copy+delete across filesystems. */
export async function movePath(src: string, dst: string): Promise<void> {
  await mkdirp(path.dirname(dst));
  try {
    await fsp.rename(src, dst);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fsp.cp(src, dst, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/** True for regular files that look like compiled programs (exec bit, ELF or PE header). */
export async function isExecutableFile(p: string): Promise<boolean> {
  const st = await statOrNull(p);
  if (!st?.isFile()) return false;
  if (process.platform !== 'win32' && st.mode & 0o111) return true;
  try {
    const fh = await fsp.open(p, 'r');
    const b = Buffer.alloc(4);
    await fh.read(b, 0, 4, 0);
    await fh.close();
    return (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) || (b[0] === 0x4d && b[1] === 0x5a);
  } catch {
    return false;
  }
}

/** Natural sort ("in2" < "in10"). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Splits a flags string like a shell would (handles quotes, no expansion). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void } {
  let t: NodeJS.Timeout | undefined;
  let last: A | undefined;
  const d = (...a: A) => {
    last = a;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...(last as A));
    }, ms);
  };
  d.flush = () => {
    if (t) {
      clearTimeout(t);
      t = undefined;
      fn(...(last as A));
    }
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return d;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
