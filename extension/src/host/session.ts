// Per-file runtime state: last results, compile state, cached texts for the sidebar.

import type { DiffInfo } from '../core/compare';
import { formatBytes, readHead } from '../core/fsutil';
import type { ManualSession } from '../core/interactive';
import { Problem } from '../core/store';
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
  private texts = new Map<string, TextEntry>();
  private sent = new Map<string, number>();

  constructor(public problem: Problem) {}

  get file(): string {
    return this.problem.file;
  }

  /** Forget what the webview has (it reloaded or switched files). */
  resetSent(): void {
    this.sent.clear();
  }

  invalidateText(id: string): void {
    this.texts.delete(id);
  }

  invalidateFile(file: string): void {
    for (const [k, v] of this.texts) if (v.file === file) this.texts.delete(k);
  }

  invalidatePrefix(prefix: string): void {
    for (const k of [...this.texts.keys()]) if (k.startsWith(prefix)) this.texts.delete(k);
  }

  /** The webview already shows `text` (the user typed it). */
  setTextFromWebview(id: string, text: string, file?: string): void {
    const rev = nextRev();
    this.texts.set(id, { rev, text, size: Buffer.byteLength(text), truncated: false, startLine: 1, file });
    this.sent.set(id, rev);
  }

  /** Text box backed by a file (optionally windowed around a line of interest). */
  async fileText(id: string, file: string | null, inlineBytes: number, editable: boolean, focusLine?: number): Promise<TextVM> {
    let e = this.texts.get(id);
    if (e && focusLine && e.truncated && (focusLine < e.startLine || focusLine > e.startLine + countLines(e.text) - 1)) e = undefined;
    if (!e) {
      if (!file) e = { rev: nextRev(), text: '', size: 0, truncated: false, startLine: 1 };
      else {
        const h = await readHead(file, inlineBytes);
        if (!h) e = { rev: nextRev(), text: '', size: 0, truncated: false, startLine: 1, file };
        else if (h.binary) e = { rev: nextRev(), text: `(binary file, ${formatBytes(h.size)})`, size: h.size, truncated: true, startLine: 1, file };
        else {
          e = { rev: nextRev(), text: h.text, size: h.size, truncated: h.truncated, startLine: 1, file };
          if (h.truncated && focusLine && focusLine > countLines(h.text) - 5) {
            const w = await readLineWindow(file, focusLine);
            if (w) e = { rev: nextRev(), text: w.text, size: h.size, truncated: true, startLine: w.startLine, file, centre: focusLine };
          }
        }
      }
      this.texts.set(id, e);
    }
    return this.toVM(id, e, editable && !e.truncated);
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
    if (this.sent.get(id) !== e.rev) {
      vm.text = e.text;
      this.sent.set(id, e.rev);
    }
    return vm;
  }
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
