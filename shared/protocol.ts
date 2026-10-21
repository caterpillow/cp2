import type { PdfIndex } from './pdfSelect';
// Messages exchanged between the browser extension, cp2-bridge (runs next to the browser)
// and cp2 (runs next to your files). Bridge <-> cp2 travels over VS Code commands, so
// everything here must be plain JSON.

import type { ContestRef, ProblemRef, Site } from './problemId';

export const DEFAULT_BRIDGE_PORT = 27122;
export const PROTOCOL_VERSION = 1;

export interface SampleTest {
  input: string;
  output: string;
}

export interface ProblemData {
  ref: ProblemRef;
  /** Display name, e.g. "D2. Restricted Sorting (Hard)" or "C - 2^a b^2". */
  name: string;
  timeLimitMs?: number;
  memoryLimitMb?: number;
  interactive?: boolean;
  tests: SampleTest[];
  /** The statement is a PDF: samples are extracted from it when importing. */
  pdfUrl?: string;
  /** File I/O problems (AIO style): the names the judge reads / writes. */
  ioFiles?: { input: string; output: string };
  /** Why no samples were found (shown in VS Code). */
  note?: string;
  /**
   * Not a judge problem (a plain PDF or some other page): only the samples are imported, the file
   * isn't linked to anything.
   */
  anonymous?: boolean;
  /** PDF statements: where each sample is in the text, to keep only those in a selection. */
  pdfIndex?: PdfIndex;
  /**
   * What's selected in the PDF viewer when importing. `known: false`: the viewer couldn't be asked (a local file, or
   * another extension's viewer), so VS Code may look at the clipboard instead.
   */
  pdfSelection?: { known: boolean; text: string };
  scrapedAt: number;
}

export interface ContestTask {
  index: string;
  taskId: string;
  name?: string;
  url: string;
  timeLimitMs?: number;
  memoryLimitMb?: number;
}

export interface ContestInfo {
  ref: ContestRef;
  name: string;
  /** null when the task list is not visible yet (contest not started). */
  tasks: ContestTask[] | null;
  startTime?: number;
  endTime?: number;
  seenAt: number;
}

export type VerdictStatus = 'judging' | 'accepted' | 'rejected' | 'partial';

export interface VerdictUpdate {
  ref: ProblemRef;
  submissionId?: string;
  status: VerdictStatus;
  /** Site text, e.g. "Wrong answer on test 3", "Running on test 12", "AC". */
  text: string;
  /** Two-letter badge: AC WA TL ML RE CE PE OL IL ... */
  short?: string;
  url?: string;
  at: number;
  final: boolean;
}

/** What the browser currently considers "most recent". */
export interface FocusState {
  problem: ProblemData | null;
  contest: ContestInfo | null;
}

// ---------------- browser -> bridge ----------------

export type BrowserToBridge =
  | { type: 'hello'; role: 'browser'; version: number; agent?: string }
  | { type: 'focus'; focus: FocusState }
  /** First interaction with a problem page since it loaded (drives auto-import of contest files). */
  | { type: 'visit'; problem: ProblemData }
  /** Toolbar icon clicked on a problem page: import into the active file of the last-focused window. */
  | { type: 'icon'; requestId: string; problem: ProblemData | null; error?: string }
  | { type: 'verdict'; update: VerdictUpdate }
  | { type: 'response'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'pong' };

// ---------------- bridge -> browser ----------------

export type BrowserRequest =
  | { op: 'scrape'; args: { ref?: ProblemRef } }
  | { op: 'tasks'; args: { site: Site; contestId: string } }
  | { op: 'submit'; args: SubmitArgs };

export interface SubmitArgs {
  ref: ProblemRef;
  code: string;
  fileName: string;
  /** Regexes (as strings) matched against the site's language names, in priority order. */
  languagePatterns: string[];
}

export interface SubmitResult {
  ok: boolean;
  message?: string;
}

export type BridgeToBrowser =
  | ({ type: 'request'; id: string } & BrowserRequest)
  | { type: 'ack'; requestId: string; ok: boolean; message: string }
  | { type: 'ping' };

// ---------------- bridge -> cp2 (via the `cp2._bridgeEvent` command) ----------------

export type BridgeEvent =
  | { type: 'connection'; connected: boolean }
  | { type: 'focus'; focus: FocusState }
  | { type: 'visit'; problem: ProblemData }
  | { type: 'icon'; requestId: string; problem: ProblemData | null; error?: string }
  | { type: 'verdict'; update: VerdictUpdate };

export interface BridgeState {
  connected: boolean;
  focus: FocusState;
  leader: boolean;
}

export const CMD_BRIDGE_EVENT = 'cp2._bridgeEvent';
export const CMD_BRIDGE_REQUEST = 'cp2bridge._request';
export const CMD_BRIDGE_STATE = 'cp2bridge._state';
export const CMD_BRIDGE_ACK = 'cp2bridge._ack';
export const CMD_BRIDGE_SNIPPET = 'cp2bridge._snippet';
