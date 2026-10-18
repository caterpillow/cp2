// Bundles test/*.test.ts with esbuild and runs them with node's built-in test runner.
//   node scripts/test.mjs [filter]
import * as esbuild from 'esbuild';
import { spawnSync } from 'child_process';
import { readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] ?? '';
const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts') && f.includes(filter));
const out = join(root, 'out/test');
rmSync(out, { recursive: true, force: true });
await esbuild.build({
  entryPoints: files.map((f) => join(root, 'test', f)),
  outdir: out,
  bundle: true,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node18',
  sourcemap: 'inline',
  external: ['linkedom', 'bufferutil', 'utf-8-validate'],
  alias: { vscode: join(root, 'test/fakeVscode.ts') },
  logLevel: 'warning',
  outExtension: { '.js': '.cjs' },
});
const r = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-force-exit', '--test-timeout=120000', '--test-reporter=spec', ...files.map((f) => join(out, f.replace(/\.ts$/, '.cjs')))], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, CP2_ROOT: root },
});
process.exit(r.status ?? 1);
