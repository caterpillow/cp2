# cp2 — Competitive Programming Helper 2

Three pieces:

| Piece | Runs where | What it does |
| --- | --- | --- |
| `extension/` — **cp2** | next to your files (WSL / SSH / local) | test cases, compiling, running, stress, sidebar, import/submit logic |
| `bridge/` — **cp2-bridge** | on the machine with the browser (VS Code's local extension host) | owns `ws://127.0.0.1:27122` for the browser extension, relays to cp2 through VS Code commands |
| `browser/` — browser extension (MV3, Brave/Chrome/Edge) | in the browser | tracks the last problem/contest page you touched, scrapes samples, submits, follows verdicts |

## Build / test / package

```sh
npm install
npm run typecheck
npm test                 # unit + integration tests (real g++, fake vscode, real WebSockets)
npm run package          # out/cp2.vsix, out/cp2-bridge.vsix, browser/dist
```

## Install

```sh
# cp2 into the WSL VS Code server
~/.vscode-server/bin/<commit>/bin/code-server --install-extension out/cp2.vsix --force
# cp2-bridge into Windows VS Code (PowerShell)
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" --install-extension cp2-bridge.vsix --force
```

Browser: `brave://extensions` → Developer mode → **Load unpacked** → `browser/dist` (copied to `C:\Users\skyla\cp2\browser`).
Reload the folder there after rebuilding.

## Data

`.cp2/` at the workspace root (it ignores itself in git):

```
.cp2/cases/<path/to/file.cpp>/problem.json      name, link, settings, order, pins
.cp2/cases/<path/to/file.cpp>/<id>.in|.ans      stored cases
.cp2/dirs/<folder>/dir.json                     stress pickers / slider
.cp2/index.json                                 problem links, verdicts, pending contests
.cp2/build, .cp2/runs                           compile cache, scratch
~/.cache/cp2/pch                                precompiled headers (~200 MB per flag set, 6 kept)
```

Old CPH data (`.cph/.<file>_<md5>.prob`) is copied in the first time a file is opened and never modified.
