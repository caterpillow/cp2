# cp2 — Competitive Programming Helper 2

A VS Code extension for running test cases, stress testing and submitting, plus a browser extension that
sends problems from the judge to VS Code. Inspired by [CPH](https://github.com/agrawal-d/cph), and it reads CPH's
`.cph` data.

- **No "create problem" step.** Every C++ / C / Python file you open is a problem. Its test cases live in `.cp2/` at
  the workspace root as plain `.in` / `.ans` files, so very large cases stay fast.
- **Text files are test cases.** `in`, `in3`, `a.in`, `a-in.txt`, `wormin.txt`, … next to your code show up
  automatically, paired with `ans` / `out` / `output` / `expected`. They're read-only in the sidebar: **Keep** copies
  one into an editable case (the stress test's `in` / `ans` too).
- **Sidebar:** cases turn green or red, and after a run the passing ones fold up (like CPH). Drag to reorder, pin to
  the top, first difference highlighted, line numbers, line wrap toggle,
  comparison modes (standard, first line, precision, custom checker), stdio-interactive problems with a judge or a
  chat-style manual run, extra files to compile with (graders, headers), and a "judge flags" mode for tight time limits.
- **Stress testing** (WA and RE) with sus / brute / gen pickers, parallel workers, and a search for a smaller failing test.
- **Fast compiles:** a cache plus automatic precompiled `bits/stdc++.h` / `bits/extc++.h`, about 4× faster.
- **Browser:** `Ctrl+Shift+I` imports the samples of the problem page you used last. **Write Contest** creates
  `a.cpp`, `b.cpp`, … for a whole contest. **Submit** sends your code, and verdicts colour the explorer
  (green / red / grey while judging).

| Site | Import samples | Write contest | Submit + verdicts |
| --- | --- | --- | --- |
| Codeforces (contests, gym, problemset) | ✓ | ✓ | ✓ |
| AtCoder | ✓ | ✓ (also before the start, from the standings) | ✓ |
| DMOJ | ✓ | ✓ | ✓ |
| QOJ | ✓ (HTML or PDF statements) | ✓ | – |
| oj.uz, ORAC | ✓ (from the PDF statement) | – | – |
| A PDF open in a tab (browser viewer or Adobe Acrobat's extension) | ✓ samples only, file not linked | – | – |
| Any other page | ✓ via the toolbar icon (best effort) | – | – |

PDFs and other pages that aren't judge problems are imported **anonymously**: only the samples are copied, and
the file isn't linked to anything, so Submit stays off. A tab showing a PDF becomes the "current problem" when you
switch to it or it finishes loading. For local files (`file:///…`), turn on **Allow access to file URLs** for cp2
on the browser's extensions page. The extension asks for access to all sites so it can download PDFs from wherever
they're hosted. It only does that when you import.

Statements embedded as PDFs (ORAC, QOJ) swallow every scroll and click, so the page can't see them. cp2 counts
clicking into the statement, or moving the pointer into it, as using the page.

PDF statements are read with pdf.js. Samples are found when the statement has the usual "Sample Input 1 / Sample
Output 1" blocks, side by side or one above the other, as in JOI, AIO, ICPC and most olympiad PDFs. IOI-style function-call
examples, grader sessions and scanned PDFs can't be read.

## How it fits together

| Piece | Runs | Job |
| --- | --- | --- |
| **cp2** (`extension/`) | where your files are: local, WSL, SSH or a container | test cases, compiling, running, stress, sidebar |
| **cp2-bridge** (`bridge/`) | where your browser is (VS Code's local side) | listens on `127.0.0.1:27122` for the browser extension and relays to cp2 |
| **browser extension** (`browser/`) | Chrome, Brave or Edge | follows the problem / contest pages you use; scrapes, submits, reads verdicts |

When everything is on one machine (e.g. a Mac), both VS Code extensions simply run side by side.

## Install

You need **Node 20+** to build, plus a C++ compiler.

```sh
git clone git@github.com:caterpillow/cp2.git && cd cp2
npm ci
npm run package        # → out/cp2.vsix, out/cp2-bridge.vsix, out/cp2-browser.zip
```

(Or download those three files from the repository's GitHub Actions run or Releases page.)

### macOS

1. A real GCC (Apple's `g++` is clang and has no `bits/stdc++.h`):

   ```sh
   brew install gcc        # gives g++-15 (or similar: ls /opt/homebrew/bin/g++-*)
   ```

2. Install both extensions:

   ```sh
   code --install-extension out/cp2.vsix
   code --install-extension out/cp2-bridge.vsix
   ```

3. In VS Code settings (JSON):

   ```jsonc
   "cp2.cpp.compiler": "g++-15",
   // If the compiler can't link ASan/UBSan (Homebrew GCC on Apple Silicon usually can't), cp2
   // notices and retries with UBSan in trap mode or without sanitizers. Or just leave them out:
   "cp2.cpp.flags": "-std=gnu++20 -DLOCAL -g",
   ```

   macOS caps the stack at 64 MB (`ulimit -s` hard limit). For very deep recursion, give the main thread a
   bigger stack at link time, e.g. add `-Wl,-stack_size,0x20000000` (512 MB) to `cp2.cpp.flags` /
   `cp2.cpp.judgeFlags`.

4. Browser: open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, **Load unpacked**,
   and pick `browser/dist` (or the unzipped `cp2-browser` folder).

### Windows + WSL

- `cp2.vsix` goes into the WSL side, from a WSL terminal in VS Code: `code --install-extension out/cp2.vsix`.
  If that hangs, run `~/.vscode-server/bin/*/bin/code-server --install-extension out/cp2.vsix` instead.
- `cp2-bridge.vsix` goes into Windows VS Code. Use **Extensions: Install from VSIX…** in a local window, or
  `code.cmd --install-extension cp2-bridge.vsix` from PowerShell.
- Browser: Load unpacked from a Windows folder, e.g. copy `browser/dist` to `C:\Users\you\cp2\browser`.

### Linux / native Windows

Install both `.vsix` files locally. On native Windows with MinGW, cp2 drops ASan automatically (MinGW can't link it),
keeps UBSan in trap mode, and sets the stack size through the linker.

Reload VS Code after installing. The cp2 icon appears in the activity bar.

## Using it

| | |
| --- | --- |
| `Ctrl+Shift+R` | run all test cases (`cp2.runAll`) |
| `Ctrl+Shift+I` | import the samples of the problem page you used last in the browser |
| toolbar icon | send the current page's problem straight into the active file (works on any page or PDF) |
| status bar | the browser's current problem (click to import) and contest (problem letters, ✓/✗, time left) |
| right-click a folder → **cp2: Write Contest Here** | create `a.cpp`, `b.cpp`, … filled with your snippet (`cp2.newFile.snippet`, default `tmpcf`), each linked to its problem |

- **Import** uses the problem you used last in the browser, even if the file is already linked to another one.
  The sidebar tells you when importing will re-link the file.
- **Submit** goes to the problem the file is linked to. It asks first if the last run failed or the file changed since.
- **Stress testing:** the two sections at the bottom of the sidebar. **Set up** turns `x.cpp` into `x/x.cpp`,
  `x/xbrute.cpp` and `x/gen.cpp`. Generated tests go to `in` / `ans`. After a failure, cp2 keeps looking for a
  smaller failing test for as long as the **smaller** slider says (default `cp2.stress.shrinkSeconds`, 0.5 s).
- **Compare modes** live in the ⚙ panel (per file), which floats at the top of the sidebar (Esc closes it). A custom checker is run as `checker <input> <output> <expected>`
  (testlib order), and exit code 0 means accepted.
- **Interactive judges** receive the test case on stdin first, then the conversation (or as `argv[1]`, testlib style).
  Exit 0 = accepted.

## Settings worth knowing

| Setting | Default |
| --- | --- |
| `cp2.cpp.compiler`, `cp2.cpp.flags` | falls back to CPH's `cph.language.cpp.*`, then `g++` / `-std=gnu++20 -DLOCAL -g -fsanitize=address,undefined -fno-sanitize-recover=all` |
| `cp2.cpp.judgeFlags` | `-std=gnu++20 -O2 -DONLINE_JUDGE` |
| `cp2.timeLimitMs` | CPH's `cph.general.timeOut`, then 3000 (imported problems use their own limit) |
| `cp2.stackMb` | 1024 |
| `cp2.stress.workers`, `cp2.stress.maxIterations` | 8, 10000 |
| `cp2.stress.shrinkSeconds` | 0.5 (time spent looking for a smaller failing test; the slider overrides it per folder) |
| `cp2.contest.folders` | `codeforces/${contestId}`, `atcoder/beginner/${hundreds}xx/${number}`, `dmoj/${contestId}`, … |
| `cp2.submit.languages` | regexes choosing the site's language, e.g. GNU G++23 → 20 → 17 |
| `cp2.newFile.snippet` | `tmpcf` (looked up in your VS Code user snippets) |
| `cp2.precompiledHeaders.enabled` | true (about 200 MB per flag set in `~/.cache/cp2/pch`; 6 kept) |

## Data

```
.cp2/cases/<path/to/file.cpp>/problem.json   name, link, settings, order, pins, verdict
.cp2/cases/<path/to/file.cpp>/<id>.in|.ans   stored cases
.cp2/dirs/<folder>/dir.json                  stress pickers and slider
.cp2/index.json                              links to problems, verdicts, contests waiting to start
.cp2/build, .cp2/runs                        compile cache, scratch
```

`.cp2` contains a `.gitignore` with `*`, so it stays out of git and out of VS Code search. CPH's `.cph/*.prob`
files are copied in the first time each file is opened, and never modified.

## Troubleshooting

- **cp2: Show Log** prints compiler commands, precompiled-header builds and bridge events.
- **cp2 bridge: Show Status** says whether the browser is connected. The toolbar icon's tooltip says the same from
  the browser's side.
- After reloading the browser extension, reload open judge tabs (or just click in them).
- Submitting fills in the site's own form in your logged-in browser. If a site redesigns its submit page this can
  break; the error message names the step that failed.

## Development

```sh
npm run watch          # rebuild on change
npm run typecheck
npm test               # unit + integration tests: real g++, fake vscode API, real WebSockets, real pages and PDFs
```

The core (`extension/src/core`) has no VS Code dependency. `test/fakeVscode.ts` drives the VS Code side from Node.
