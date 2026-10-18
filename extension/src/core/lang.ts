import * as path from 'path';

export type LangId = 'cpp' | 'c' | 'python';

const EXT: Record<string, LangId> = {
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.c': 'c',
  '.py': 'python',
};

export const HEADER_EXTS = new Set(['.h', '.hpp', '.hh', '.hxx', '.h++', '.inl']);

export function langOf(file: string): LangId | null {
  return EXT[path.extname(file).toLowerCase()] ?? null;
}

export function isSourceFile(file: string): boolean {
  return langOf(file) !== null;
}

export function isHeaderFile(file: string): boolean {
  return HEADER_EXTS.has(path.extname(file).toLowerCase());
}

/** Files that can be ticked under "compile with": other C/C++ sources and headers. */
export function isCompileWithCandidate(file: string): boolean {
  const l = langOf(file);
  return l === 'cpp' || l === 'c' || isHeaderFile(file);
}

export function stemOf(file: string): string {
  const b = path.basename(file);
  const e = path.extname(b);
  return e ? b.slice(0, -e.length) : b;
}

export function needsCompile(lang: LangId): boolean {
  return lang !== 'python';
}
