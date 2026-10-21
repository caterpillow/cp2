// Undo / redo for the sidebar, per source file: typing in a case, and changes to the case list (add, delete, Keep,
// Gen case, reorder, pin, show / hide text files).

import type { ListState } from '../core/store';

/** Typing pauses shorter than this continue the same undo step... */
const MERGE_PAUSE_MS = 1000;
/** ...until the step is this old, so one Ctrl+Z never takes back more than a few seconds of typing. */
const MERGE_SPAN_MS = 3000;
const MAX_ENTRIES = 200;
/** Typing steps keep whole texts: cap what they hold per file. */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

let nextId = 1;

export type HistoryEntry = { id: number; label: string } & (
  | { kind: 'text'; caseId: string; field: 'in' | 'ans'; before: string; after: string; started: number; at: number }
  | {
      kind: 'list';
      /** Only the fields that changed. */
      before: Partial<Omit<ListState, 'shownFiles'>>;
      after: Partial<Omit<ListState, 'shownFiles'>>;
      /** Text-file cases shown / hidden by this step. */
      shown: { added: string[]; removed: string[] };
    }
);

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type NewEntry = WithoutId<HistoryEntry>;

/** What a list change did, or null when nothing changed. */
export function diffListState(label: string, a: ListState, b: ListState): NewEntry | null {
  const before: Partial<ListState> = {};
  const after: Partial<ListState> = {};
  for (const k of ['cases', 'order', 'pinned'] as const) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    (before as Record<string, unknown>)[k] = a[k];
    (after as Record<string, unknown>)[k] = b[k];
  }
  const added = b.shownFiles.filter((n) => !a.shownFiles.includes(n));
  const removed = a.shownFiles.filter((n) => !b.shownFiles.includes(n));
  if (!Object.keys(before).length && !added.length && !removed.length) return null;
  return { kind: 'list', label, before, after, shown: { added, removed } };
}

const textBytes = (e: HistoryEntry) => (e.kind === 'text' ? e.before.length + e.after.length : 0);

export class History {
  private undos: HistoryEntry[] = [];
  private redos: HistoryEntry[] = [];
  /** The step typing may still merge into (closed by any other step, undo or redo). */
  private open: HistoryEntry | null = null;

  push(e: NewEntry): HistoryEntry {
    const entry = { ...e, id: nextId++ } as HistoryEntry;
    this.undos.push(entry);
    this.redos = [];
    this.open = entry.kind === 'text' ? entry : null;
    this.trim();
    return entry;
  }

  /** Typing: continues the latest step when it's the same box, picks up where it left off, and is recent. */
  pushText(e: Omit<Extract<HistoryEntry, { kind: 'text' }>, 'id' | 'started'>): HistoryEntry {
    const top = this.open;
    if (
      top?.kind === 'text' &&
      top === this.undos[this.undos.length - 1] &&
      top.caseId === e.caseId &&
      top.field === e.field &&
      top.after === e.before &&
      e.at - top.at < MERGE_PAUSE_MS &&
      e.at - top.started < MERGE_SPAN_MS
    ) {
      top.after = e.after;
      top.at = e.at;
      this.redos = [];
      this.trim();
      return top;
    }
    return this.push({ ...e, started: e.at });
  }

  /** Drops the oldest steps beyond the limits. */
  private trim(): void {
    let bytes = this.undos.reduce((n, e) => n + textBytes(e), 0);
    while (this.undos.length > 1 && (this.undos.length > MAX_ENTRIES || bytes > MAX_TEXT_BYTES)) bytes -= textBytes(this.undos.shift()!);
  }

  peek(dir: 'undo' | 'redo'): HistoryEntry | undefined {
    const s = dir === 'undo' ? this.undos : this.redos;
    return s[s.length - 1];
  }

  /** Takes the next step to undo / redo; give it back with `restore` if it can't be applied. */
  take(dir: 'undo' | 'redo'): HistoryEntry | undefined {
    this.open = null;
    return (dir === 'undo' ? this.undos : this.redos).pop();
  }

  restore(dir: 'undo' | 'redo', e: HistoryEntry): void {
    (dir === 'undo' ? this.undos : this.redos).push(e);
  }

  /** `e` was undone (it can be redone) or redone (it can be undone again). */
  applied(dir: 'undo' | 'redo', e: HistoryEntry): void {
    (dir === 'undo' ? this.redos : this.undos).push(e);
  }

  clear(): void {
    this.undos = [];
    this.redos = [];
    this.open = null;
  }

  /**
   * After a change made outside the history (an import replaces the samples): rewrite every step's copy of the list so
   * it applies to the new one, drop typing steps for cases that are gone, and steps that no longer change anything.
   */
  rebase(list: (st: Partial<Omit<ListState, 'shownFiles'>>) => Partial<Omit<ListState, 'shownFiles'>>, caseGone: (id: string) => boolean): void {
    for (const stack of [this.undos, this.redos]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const e = stack[i];
        if (e.kind === 'text') {
          if (caseGone(e.caseId)) stack.splice(i, 1);
          continue;
        }
        e.before = list(e.before);
        e.after = list(e.after);
        if (JSON.stringify(e.before) === JSON.stringify(e.after) && !e.shown.added.length && !e.shown.removed.length) stack.splice(i, 1);
      }
    }
    this.open = null;
  }
}
