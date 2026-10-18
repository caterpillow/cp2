// Reads user snippets from the VS Code installation the bridge runs in (the machine you sit at),
// so files created on a remote (WSL / SSH) still get your local snippet.

import * as fsp from 'fs/promises';
import { parse } from 'jsonc-parser';
import * as path from 'path';

interface SnippetDef {
  prefix?: string | string[];
  body?: string | string[];
  scope?: string;
}

async function readJsonc(file: string): Promise<Record<string, SnippetDef> | null> {
  try {
    return parse(await fsp.readFile(file, 'utf8'), [], { allowTrailingComma: true, disallowComments: false }) as Record<string, SnippetDef>;
  } catch {
    return null;
  }
}

function matches(key: string, def: SnippetDef, name: string): boolean {
  if (key === name) return true;
  const p = def.prefix;
  return Array.isArray(p) ? p.includes(name) : p === name;
}

/** `userDir` is the VS Code "User" folder (or a profile folder) containing `snippets/`. */
export async function findSnippet(userDirs: string[], language: string, name: string): Promise<string | null> {
  for (const userDir of userDirs) {
    const dir = path.join(userDir, 'snippets');
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    const ordered = [`${language}.json`, ...files.filter((f) => f.endsWith('.code-snippets'))];
    for (const f of ordered) {
      if (!files.includes(f)) continue;
      const json = await readJsonc(path.join(dir, f));
      if (!json) continue;
      for (const [key, def] of Object.entries(json)) {
        if (!def || typeof def !== 'object' || !def.body) continue;
        if (f.endsWith('.code-snippets') && def.scope && !def.scope.split(',').map((s) => s.trim()).includes(language)) continue;
        if (matches(key, def, name)) return Array.isArray(def.body) ? def.body.join('\n') : def.body;
      }
    }
  }
  return null;
}
