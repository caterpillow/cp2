// Production build + .vsix packages for cp2 and cp2-bridge, and a zip-free copy of the browser extension.
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
run(process.execPath, [join(root, 'scripts/build.mjs'), '--prod']);
const vsce = join(root, 'node_modules/@vscode/vsce/vsce');
for (const d of ['extension', 'bridge']) {
  run(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', join(root, 'out', `${d === 'extension' ? 'cp2' : 'cp2-bridge'}.vsix`)], join(root, d));
}
console.log('packages in out/, browser extension in browser/dist');
