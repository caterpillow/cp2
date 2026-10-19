# cp2 — Competitive Programming Helper 2

A take on CPH without the clicking:

* Every C++/C/Python file is a problem as soon as you open it. Test cases live in `.cp2/` at the workspace root
  (plain `.in`/`.ans` files, so huge cases stay fast). Old `.cph` data is imported automatically and left untouched.
* Text files next to your code (`in`, `in3`, `a.in`, `a-in.txt`, `wormin.txt`, …) are test cases too, paired with
  `ans` / `out` / `output` / `expected` files.
* Pin and drag-reorder cases; first differences are highlighted; comparison modes (standard, first line, precision,
  custom checker); stdio-interactive problems with a judge or a manual chat-style run.
* WA / RE stress testing (brute, gen, sus pickers at the bottom of the sidebar), with a smaller-failing-test search.
* `Ctrl+Shift+R` runs everything, `Ctrl+Shift+I` imports the samples of the problem page you last touched in the
  browser (needs the cp2 browser extension and **cp2 bridge**): Codeforces, AtCoder, DMOJ, QOJ, oj.uz, ORAC, and any
  other page or PDF via the toolbar icon. Write whole contests, submit (Codeforces, AtCoder, DMOJ), and see verdicts
  as explorer colours.
