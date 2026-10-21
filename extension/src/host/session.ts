// Per-file runtime state: last results, compile state, cached texts for the sidebar.

import type { DiffInfo } from '../core/compare';
import { formatBytes, readHead } from '../core/fsutil';
import type { ManualSession } from '../core/interactive';
import { Problem } from '../core/store';
import { History } from './history';
import { readLineWindow } from '../core/textWindow';
import type { TextVM, TranscriptLine, Verdict } from '../../../shared/viewModel';

export interface CaseResult {
  verdict: Verdict;
  timeMs?: number;
  detail?: string;
  /** File holding the program's output. */
  outFile?: string;
  stderr?: string;
  debugStderr?: string;
  diff?: DiffInfo;
  transcript?: TranscriptLine[];
  at: number;
  /** A passing test shown while stress runs (never folds or unfolds the case). */
  live?: boolean;
}

export interface CompileState {
  state: 'idle' | 'compiling' | 'ok' | 'error';
  output?: string;
  judgeFlags: boolean;
  pch?: boolean;
}

let revCounter = 1;
export const nextRev = () => ++revCounter;

interface TextEntry {
  rev: number;
  text: string;
  size: number;
  truncated: boolean;
  startLine: number;
  /** Source file and the line the window was centred on (to know when to re-read). */
  file?: string;
  centre?: number;
  /** Typed in the webview (see setTextFromWebview). */
  echo?: boolean;
  /** Invalidated: re-read before use (kept to compare with the new read). */
  stale?: boolean;
}

export class Session {
  results = new Map<string, CaseResult>();
  compile: CompileState = { state: 'idle', judgeFlags: false };
  running = false;
  abort: AbortController | null = null;
  manual: ManualSession | null = null;
  manualEvents: TranscriptLine[] = [];
  manualExit: string | undefined;
  /** For the pre-submit check. */
  lastRun: { at: number; sourceMtime: number; failed: boolean; anyRun: boolean } | null = null;
  /** Undo / redo for this file's cases. */
  readonly history = new History();
  private texts = new Map<string, TextEntry>();
  private sent = new Map<string, number>();
  /** Bumped whenever a text is invalidated or replaced, so a read that raced with that isn't cached. */
  private gens = new Map<string, number>();
  /** Last webview edit (its sequence number) applied to each text. */
  private seqs = new Map<string, number>();

  constructor(public problem: Problem) {}

  get file(): string {
    return this.problem.file;
  }

  /** Forget what the webview has (it reloaded or switched files). */
  resetSent(): void {
    this.sent.clear();
  }

  /** The webview reloaded: its edit numbers start over. */
  resetSeqs(): void {
    this.seqs.clear();
  }

  private bump(id: string): void {
    this.gens.set(id, (this.gens.get(id) ?? 0) + 1);
  }

  invalidateText(id: string): void {
    const e = this.texts.get(id);
    if (e) e.stale = true;
    this.bump(id);
  }

  invalidateFile(file: string): void {
    for (const [k, v] of this.texts) {
      if (v.file !== file) continue;
      v.stale = true;
      this.bump(k);
    }
  }

  invalidatePrefix(prefix: string): void {
    for (const [k, v] of this.texts) {
      if (!k.startsWith(prefix)) continue;
      v.stale = true;
      this.bump(k);
    }
  }

  /** A webview edit that changed nothing still counts as applied. */
  noteSeq(id: string, seq: number | undefined): void {
    if (seq) this.seqs.set(id, Math.max(seq, this.seqs.get(id) ?? 0));
  }

  /**
   * The webview already shows `text` (the user typed it). The text still goes back once, flagged as an echo: the
   * webview caches it without touching the box, which may already hold newer keystrokes.
   */
  setTextFromWebview(id: string, text: string, file?: string, seq?: number): void {
    this.texts.set(id, { rev: nextRev(), text, size: Buffer.byteLength(text), truncated: false, startLine: 1, file, echo: true });
    this.bump(id);
    this.noteSeq(id, seq);
  }

  /** Text box backed by a file (optionally windowed around a line of interest). */
  async fileText(id: string, file: string | null, inlineBytes: number, editable: boolean, focusLine?: number): Promise<TextVM> {
    for (let attempt = 0; ; attempt++) {
      const prev = this.texts.get(id);
      let e = prev;
      if (e && (e.stale || (e.file ?? null) !== file)) e = undefined;
      if (e && focusLine && e.truncated && (focusLine < e.startLine || focusLine > e.startLine + countLines(e.text) - 1)) e = undefined;
      if (e) return this.toVM(id, e, editable && !e.truncated);
      const gen = this.gens.get(id) ?? 0;
      const read = await readEntry(file, inlineBytes, focusLine);
      // Written or invalidated while we were reading: this read may already be out of date.
      if ((this.gens.get(id) ?? 0) !== gen && attempt < 3) continue;
      // Unchanged content keeps its rev, so the webview doesn't replace a box the user may be typing in.
      const same = prev && (prev.file ?? null) === (read.file ?? null) && prev.text === read.text && prev.startLine === read.startLine && prev.truncated === read.truncated;
      e = same ? { ...read, rev: prev.rev, echo: prev.echo } : { ...read, rev: nextRev() };
      this.texts.set(id, e);
      return this.toVM(id, e, editable && !e.truncated);
    }
  }

  /** Text box backed by an in-memory string (stderr). */
  memText(id: string, text: string, inlineBytes: number): TextVM {
    let e = this.texts.get(id);
    if (!e || e.text !== text.slice(0, inlineBytes)) {
      e = { rev: nextRev(), text: text.slice(0, inlineBytes), size: Buffer.byteLength(text), truncated: text.length > inlineBytes, startLine: 1 };
      this.texts.set(id, e);
    }
    return this.toVM(id, e, false);
  }

  private toVM(id: string, e: TextEntry, editable: boolean): TextVM {
    const vm: TextVM = { rev: e.rev, size: e.size, truncated: e.truncated, startLine: e.startLine, editable };
    if (e.echo) vm.echo = true;
    const seq = this.seqs.get(id);
    if (seq) vm.seq = seq;
    if (this.sent.get(id) !== e.rev) {
      vm.text = e.text;
      this.sent.set(id, e.rev);
    }
    return vm;
  }
}

async function readEntry(file: string | null, inlineBytes: number, focusLine?: number): Promise<Omit<TextEntry, 'rev'>> {
  if (!file) return { text: '', size: 0, truncated: false, startLine: 1 };
  const h = await readHead(file, inlineBytes);
  if (!h) return { text: '', size: 0, truncated: false, startLine: 1, file };
  if (h.binary) return { text: `(binary file, ${formatBytes(h.size)})`, size: h.size, truncated: true, startLine: 1, file };
  if (h.truncated && focusLine && focusLine > countLines(h.text) - 5) {
    const w = await readLineWindow(file, focusLine);
    if (w) return { text: w.text, size: h.size, truncated: true, startLine: w.startLine, file, centre: focusLine };
  }
  return { text: h.text, size: h.size, truncated: h.truncated, startLine: 1, file };
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
