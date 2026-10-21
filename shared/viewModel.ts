// State the extension sends to the sidebar webview, and messages the webview sends back.

export type CompareMode = 'standard' | 'firstLine' | 'precision' | 'checker';
export type Verdict = 'AC' | 'WA' | 'RE' | 'TLE' | 'OLE' | 'CE' | 'RAN' | 'NOCHECK' | 'ERR' | 'RUNNING' | 'QUEUED' | 'STOPPED';
export type CaseOrigin = 'manual' | 'imported' | 'file';
export type TextField = 'in' | 'ans' | 'out' | 'err' | 'dbg';

export interface ProblemSettingsVM {
  compare: CompareMode;
  precision: number;
  checker: string;
  interactive: boolean;
  judge: string;
  judgeInput: 'stdin' | 'argv';
  compileWith: string[];
  judgeFlags: boolean;
  timeLimitMs?: number;
}

/**
 * A text box's content. `text` is omitted when the webview already has this `rev`, so big
 * cases are only sent once.
 */
export interface TextVM {
  rev: number;
  text?: string;
  size: number;
  /** Only part of the content is shown (open in editor for the rest). */
  truncated: boolean;
  /** Line number of the first line shown (for windows around a difference). */
  startLine: number;
  editable: boolean;
  /** This is the text the webview itself sent (an edit): adopt the rev, don't overwrite the box. */
  echo?: boolean;
  /** The last webview edit (sequence number) the host has applied to this text. */
  seq?: number;
}

export interface DiffMark {
  line: number;
  col: number;
  len: number;
}

export interface TranscriptLine {
  /** in = to the program (judge/you), out = from the program, err = program stderr. */
  k: 'in' | 'out' | 'err';
  t: string;
}

export interface ResultVM {
  verdict: Verdict;
  /** When the result was produced: a new value means a new run finished. */
  at: number;
  /** A passing test shown while stress runs (never folds or unfolds the case). */
  live?: boolean;
  timeMs?: number;
  /** Checker / judge message, exit description, ... */
  detail?: string;
  received?: TextVM;
  stderr?: TextVM;
  /** stderr of the debug-build rerun after a stress hit. */
  debug?: TextVM;
  diffExpected?: DiffMark;
  diffReceived?: DiffMark;
  transcript?: TranscriptLine[];
}

export interface CaseVM {
  key: string;
  origin: CaseOrigin;
  label: string;
  /** File names for text-file cases ("in → ans"). */
  files?: string;
  pinned: boolean;
  /** The stress `in`/`ans` case. */
  stress: boolean;
  input: TextVM;
  /** null: interactive (no expected box). */
  expected: TextVM | null;
  /** Text-file case without a matching answer file (amber box). */
  expectedMissing: boolean;
  expectedHint?: string;
  result?: ResultVM;
}

export interface SlotVM {
  /** `answer`: the optional brute of the generate section. */
  role: 'sus' | 'brute' | 'gen' | 'judge' | 'checker' | 'answer';
  value: string;
  auto: boolean;
  missing: boolean;
  options: string[];
  /** Can be left empty. */
  optional?: boolean;
}

/** The "Generate test case" section: gen (+ an optional brute for the expected output). */
export interface GenSectionVM {
  open: boolean;
  slots: SlotVM[];
  canRun: boolean;
  reason?: string;
  needsSetup: boolean;
  running: boolean;
  status?: StressStatusVM;
  genName?: string;
  /** The solution generated cases go to (the open file, or the folder's sus when a gen / brute is open). */
  targetName?: string;
}

/** A text file in the folder that looks like a test case. */
export interface FileCaseVM {
  name: string;
  /** Matching answer file, or null. */
  expected: string | null;
  shown: boolean;
}

export type SectionMode = 'gen' | 'wa' | 're';

export interface StressStatusVM {
  state: 'running' | 'shrinking' | 'found' | 'clean' | 'stopped' | 'error' | 'compiling';
  text: string;
  detail?: string;
}

export interface StressSectionVM {
  open: boolean;
  slots: SlotVM[];
  shrink: number;
  canRun: boolean;
  reason?: string;
  needsSetup: boolean;
  running: boolean;
  /** Section can't be used here at all (e.g. WA stress on an interactive problem). */
  disabled?: string;
  status?: StressStatusVM;
  /** WA: comparison mode of the sus file (same setting as its ⚙ panel). */
  compare?: { mode: CompareMode; precision: number };
  /** Name of the sus file whose settings `compare` edits. */
  susName?: string;
}

export interface ViewState {
  file: { name: string; rel: string; path: string; lang: string } | null;
  problem: {
    title: string;
    url?: string;
    shortId?: string;
    timeLimitMs: number;
    settings: ProblemSettingsVM;
    /** Source files in the folder (for checker / judge pickers). */
    dirFiles: string[];
    /** Files that can be ticked under "compile with". */
    compileCandidates: string[];
    checkerExists: boolean;
    judgeExists: boolean;
    verdict?: { status: 'judging' | 'accepted' | 'rejected' | 'partial'; text: string; url?: string };
  } | null;
  compile: { state: 'idle' | 'compiling' | 'ok' | 'error'; output?: string; judgeFlags: boolean; pch?: boolean };
  cases: CaseVM[];
  running: boolean;
  importBtn: { label: string; title: string; enabled: boolean; note?: string };
  submitBtn: { label: string; title: string; enabled: boolean };
  stress: { gen: GenSectionVM; wa: StressSectionVM; re: StressSectionVM };
  /** Every text-file case in the folder (Files menu). */
  fileCases: FileCaseVM[];
  manual: { visible: boolean; running: boolean; exit?: string };
  ui: { settingsOpen: boolean };
  warnings: string[];
  bridgeConnected: boolean;
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'manual'; events: TranscriptLine[]; reset: boolean }
  /** Scroll a case into view; `focus` puts the cursor in its input, `expand` unfolds it. */
  | { type: 'reveal'; key: string; focus?: boolean; expand?: boolean }
  /** A short message at the bottom of the sidebar, optionally with an Undo / Redo link. */
  | { type: 'notice'; text: string; action?: 'undo' | 'redo'; id?: number };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'runAll' }
  | { type: 'runCase'; key: string }
  | { type: 'stop' }
  | { type: 'addCase' }
  | { type: 'deleteCase'; key: string }
  | { type: 'hideCase'; key: string }
  /** `seq` numbers every edit the webview sends (one counter for the whole sidebar). */
  | { type: 'edit'; key: string; field: 'in' | 'ans'; text: string; file: string; seq?: number }
  | { type: 'pin'; key: string; pinned: boolean }
  | { type: 'reorder'; keys: string[] }
  | { type: 'keep'; key: string }
  | { type: 'open'; key: string; field: TextField }
  | { type: 'diff'; key: string }
  | { type: 'import' }
  | { type: 'submit' }
  | { type: 'setting'; patch: Partial<ProblemSettingsVM> }
  | { type: 'toggleSettings'; open: boolean }
  | { type: 'stressPick'; mode: SectionMode; role: SlotVM['role']; value: string }
  | { type: 'stressRun'; mode: 'wa' | 're' }
  | { type: 'stressStop'; mode: 'wa' | 're' }
  | { type: 'stressSetup'; mode: SectionMode }
  | { type: 'stressShrink'; mode: 'wa' | 're'; index: number }
  | { type: 'stressOpen'; mode: SectionMode; open: boolean }
  | { type: 'stressSetting'; mode: 'wa' | 're'; patch: Partial<ProblemSettingsVM> }
  | { type: 'manualStart' }
  | { type: 'manualSend'; text: string }
  | { type: 'manualEof' }
  | { type: 'manualStop' }
  | { type: 'openUrl'; url: string }
  | { type: 'openFile'; name: string }
  | { type: 'showFiles'; names: string[]; show: boolean }
  | { type: 'genCase' }
  /** `id`: from a notice's button — only that step (if it's still the next one). */
  | { type: 'undo'; file: string; id?: number }
  | { type: 'redo'; file: string; id?: number };
