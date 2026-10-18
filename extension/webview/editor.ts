// A small CodeMirror editor used for every text box: line numbers, auto height up to a limit,
// first-difference highlighting and per-line classes (stderr interleaving).

import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, drawSelection, EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

export interface Mark {
  line: number; // 1-based, in file numbering
  col?: number;
  len?: number;
  cls: string;
  /** Whole line (default) or only the [col, col+len) span plus a line tint. */
  span?: boolean;
}

export interface BoxOptions {
  editable: boolean;
  placeholder?: string;
  onChange?: (text: string) => void;
  onRun?: () => void;
  className?: string;
}

const setMarks = StateEffect.define<DecorationSet>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  '&': {
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    backgroundColor: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent))',
    borderRadius: '2px',
  },
  '&.cm-focused': { outline: '1px solid var(--vscode-focusBorder)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family, monospace)', lineHeight: '1.4', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)', padding: '2px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none', paddingRight: '2px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2ch', padding: '0 4px 0 6px', fontSize: '0.92em' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)', fontStyle: 'italic' },
});

export class TextBox {
  readonly view: EditorView;
  private startLine = 1;
  private suppress = false;
  private readonlyC = new Compartment();
  private gutterC = new Compartment();
  rev = -1;

  constructor(
    parent: HTMLElement,
    private opts: BoxOptions,
  ) {
    const runKeys = keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          this.opts.onRun?.();
          return true;
        },
      },
    ]);
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          this.gutterC.of(this.gutter()),
          drawSelection(),
          history(),
          runKeys,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          this.readonlyC.of(this.ro(opts.editable)),
          opts.placeholder ? cmPlaceholder(opts.placeholder) : [],
          marksField,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.suppress) this.opts.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    if (opts.className) this.view.dom.classList.add(opts.className);
  }

  private gutter() {
    const start = this.startLine;
    return lineNumbers({ formatNumber: (n) => String(n + start - 1) });
  }

  private ro(editable: boolean) {
    return [EditorState.readOnly.of(!editable), EditorView.editable.of(true)];
  }

  setContent(text: string, startLine = 1): void {
    if (startLine !== this.startLine) {
      this.startLine = startLine;
      this.view.dispatch({ effects: this.gutterC.reconfigure(this.gutter()) });
    }
    const cur = this.view.state.doc.toString();
    if (cur === text) return;
    this.suppress = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    } finally {
      this.suppress = false;
    }
  }

  setEditable(editable: boolean): void {
    if (editable === this.opts.editable) return;
    this.opts.editable = editable;
    this.view.dispatch({ effects: this.readonlyC.reconfigure(this.ro(editable)) });
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  get focused(): boolean {
    return this.view.hasFocus;
  }

  focus(): void {
    this.view.focus();
  }

  /** Line/span highlights; lines are in file numbering (offset by startLine). */
  setMarks(marks: Mark[]): void {
    const doc = this.view.state.doc;
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    for (const m of marks) {
      const ln = m.line - this.startLine + 1;
      if (ln < 1 || ln > doc.lines) continue;
      const line = doc.line(ln);
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: m.cls }) });
      if (m.span) {
        const from = Math.min(line.to, line.from + (m.col ?? 0));
        const to = Math.min(line.to, from + Math.max(1, m.len ?? 1));
        if (to > from) ranges.push({ from, to, deco: Decoration.mark({ class: `${m.cls}-span` }) });
      }
    }
    ranges.sort((a, b) => a.from - b.from || (a.to === a.from ? -1 : 1));
    const b = new RangeSetBuilder<Decoration>();
    for (const r of ranges) b.add(r.from, r.to, r.deco);
    this.view.dispatch({ effects: setMarks.of(b.finish()) });
  }

  scrollToLine(line: number): void {
    const ln = line - this.startLine + 1;
    const doc = this.view.state.doc;
    if (ln < 1 || ln > doc.lines) return;
    this.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(ln).from, { y: 'center' }) });
  }

  destroy(): void {
    this.view.destroy();
  }
}
