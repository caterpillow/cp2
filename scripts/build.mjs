// Builds all three pieces: the cp2 VS Code extension (+ its webview), cp2-bridge, and the
// browser extension.  `node scripts/build.mjs [--watch] [--prod]`
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

const common = {
  bundle: true,
  sourcemap: prod ? false : 'linked',
  minify: prod,
  logLevel: 'info',
  legalComments: 'none',
};

const targets = [
  {
    ...common,
    entryPoints: [join(root, 'extension/src/extension.ts')],
    outfile: join(root, 'extension/dist/extension.js'),
    platform: 'node',
    mainFields: ['module', 'main'],
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: [join(root, 'extension/webview/main.ts')],
    outfile: join(root, 'extension/dist/webview.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  {
    ...common,
    entryPoints: [join(root, 'extension/webview/styles.css')],
    outfile: join(root, 'extension/dist/webview.css'),
  },
  {
    ...common,
    entryPoints: [join(root, 'bridge/src/extension.ts')],
    outfile: join(root, 'bridge/dist/extension.js'),
    platform: 'node',
    mainFields: ['module', 'main'],
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
  },
  {
    ...common,
    entryPoints: {
      background: join(root, 'browser/src/background.ts'),
      content: join(root, 'browser/src/content.ts'),
      offscreen: join(root, 'browser/src/offscreen.ts'),
    },
    outdir: join(root, 'browser/dist'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome110',
    sourcemap: false,
  },
];

function copyStatic() {
  mkdirSync(join(root, 'browser/dist'), { recursive: true });
  cpSync(join(root, 'browser/static'), join(root, 'browser/dist'), { recursive: true });
  mkdirSync(join(root, 'extension/dist'), { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) cpSync(join(root, 'node_modules/@vscode/codicons/dist', f), join(root, 'extension/dist', f));
}

if (!watch) {
  rmSync(join(root, 'browser/dist'), { recursive: true, force: true });
}
copyStatic();

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
