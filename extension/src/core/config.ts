// Plain configuration consumed by the core. The VS Code layer fills it from settings
// (falling back to the old `cph.*` settings), so the core never touches the vscode API.

export interface LangConfig {
  compiler: string;
  /** Flags for normal (debug) runs. */
  flags: string;
  /** Flags used when the problem's "judge flags" box is ticked. */
  judgeFlags: string;
}

export interface Cp2Config {
  cpp: LangConfig;
  c: LangConfig;
  python: { command: string; args: string };
  /** Default time limit when the problem has none (ms). */
  timeLimitMs: number;
  stackMb: number;
  outputLimitMb: number;
  ignoreStderr: boolean;
  runConcurrency: number;
  pch: { enabled: boolean; headers: string[] };
  stress: {
    waFlags: string;
    reFlags: string;
    workers: number;
    maxIterations: number;
    helperTimeoutMs: number;
    genTemplate: string;
  };
  /** Flags for checkers and judges. */
  helperFlags: string;
  /** Largest case text sent to the sidebar in full. */
  inlineBytes: number;
  newFile: { snippet: string; language: string; extension: string; tabSize: number; insertSpaces: boolean };
  contestFolders: Record<string, string>;
  submitLanguages: Record<string, Record<string, string[]>>;
  /** Where precompiled headers live (shared by all workspaces). */
  cacheDir: string;
}

export const DEFAULT_FLAGS = {
  cpp: '-std=gnu++20 -DLOCAL -g -fsanitize=address,undefined -fno-sanitize-recover=all',
  cppJudge: '-std=gnu++20 -O2 -DONLINE_JUDGE',
  c: '-std=gnu11 -DLOCAL -g -fsanitize=address,undefined -fno-sanitize-recover=all',
  cJudge: '-std=gnu11 -O2 -DONLINE_JUDGE',
  stressWA: '-std=gnu++20 -O2',
  stressRE: '-std=gnu++20 -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -D_GLIBCXX_ASSERTIONS',
  helper: '-std=gnu++20 -O2',
};

export const DEFAULT_CONTEST_FOLDERS: Record<string, string> = {
  codeforces: 'codeforces/${contestId}',
  'atcoder.abc': 'atcoder/beginner/${hundreds}xx/${number}',
  'atcoder.arc': 'atcoder/regular/${number}',
  'atcoder.agc': 'atcoder/grand/${number}',
  'atcoder.ahc': 'atcoder/heuristic/${number}',
  atcoder: 'atcoder/${contestId}',
  dmoj: 'dmoj/${contestId}',
  qoj: 'qoj/${contestId}',
};

export const DEFAULT_SUBMIT_LANGUAGES: Record<string, Record<string, string[]>> = {
  codeforces: {
    cpp: ['G\\+\\+ ?23', 'G\\+\\+ ?20', 'G\\+\\+ ?17', 'G\\+\\+'],
    c: ['GCC C11', 'C11', '\\bC\\b'],
    python: ['PyPy 3', 'Python 3'],
  },
  atcoder: {
    cpp: ['C\\+\\+ ?23.*(GCC|gcc)', 'C\\+\\+ ?20.*(GCC|gcc)', 'C\\+\\+.*(GCC|gcc)', 'C\\+\\+'],
    c: ['^C ?\\(?.*(GCC|gcc)', '^C\\b'],
    python: ['PyPy', 'Python'],
  },
  dmoj: {
    cpp: ['C\\+\\+ ?23', 'C\\+\\+ ?20', 'C\\+\\+ ?17', 'C\\+\\+'],
    c: ['^C ?1[178]', '^C\\b'],
    python: ['PyPy ?3', 'Python ?3'],
  },
};
