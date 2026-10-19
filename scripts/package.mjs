// Production build, then:
//   out/cp2.vsix          VS Code extension (runs where your files are)
//   out/cp2-bridge.vsix   VS Code extension (runs where your browser is)
//   out/cp2-browser.zip   unpacked browser extension (Chrome / Brave / Edge)
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { zipSync } from 'fflate';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
run(process.execPath, [join(root, 'scripts/build.mjs'), '--prod']);
mkdirSync(join(root, 'out'), { recursive: true });
const vsce = join(root, 'node_modules/@vscode/vsce/vsce');
for (const [dir, name] of [['extension', 'cp2'], ['bridge', 'cp2-bridge']]) {
  run(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', join(root, 'out', `${name}.vsix`)], join(root, dir));
}
const files = {};
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files[`cp2-browser/${relative(join(root, 'browser/dist'), p).split('\\').join('/')}`] = readFileSync(p);
  }
};
walk(join(root, 'browser/dist'));
writeFileSync(join(root, 'out/cp2-browser.zip'), zipSync(files, { level: 9 }));
console.log('\nout/cp2.vsix, out/cp2-bridge.vsix, out/cp2-browser.zip');
