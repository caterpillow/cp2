// cp2 sidebar UI (vanilla TS + CodeMirror). The extension owns all state; this file renders it
// and sends user actions back.

import type { CaseVM, FromWebview, GenSectionVM, ProblemSettingsVM, ResultVM, SectionMode, SlotVM, StressSectionVM, TextVM, ToWebview, TranscriptLine, Verdict, ViewState } from '../../shared/viewModel';
import { Mark, TextBox } from './editor';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
function send(m: FromWebview): void {
  // Whatever the sidebar asks for next (delete, run, undo, Set up, …) happens after the typing that came before it.
  if (m.type !== 'edit') flushEdits();
  vscode.postMessage(m);
}

// ---------------- tiny DOM helpers ----------------

type Attrs = Record<string, string | number | boolean | undefined | ((e: any) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const icon = (name: string) => h('i', { class: `codicon codicon-${name}` });
function btn(label: string | null, iconName: string | null, onClick: () => void, opts: { title?: string; cls?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { class: `btn ${opts.cls ?? ''} ${label ? '' : 'icon-only'}`, title: opts.title ?? label ?? '', disabled: !!opts.disabled, type: 'button' });
  if (iconName) b.append(icon(iconName));
  if (label) b.append(h('span', { class: 'btn-label' }, label));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!b.disabled) onClick();
  });
  return b;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function debounce(fn: () => void, ms: number) {
  let t: number | undefined;
  const d = () => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => {
      t = undefined;
      fn();
    }, ms);
  };
  d.flush = () => {
    if (t) {
      clearTimeout(t);
      t = undefined;
      fn();
    }
  };
  d.pending = () => t !== undefined;
  return d;
}

// ---------------- persistent UI bits ----------------

const saved: { collapsed?: string[]; wrap?: Record<string, boolean> } = vscode.getState() ?? {};
/** `${file}|${case key}` of collapsed cases (keys like f:in repeat across files). */
const collapsed = new Set<string>(saved.collapsed ?? []);
// Line wrap per kind of box (input, expected, received, stderr, ...): on by default except input.
const wrapPrefs: Record<string, boolean> = saved.wrap ?? {};
const wrapOn = (kind: string) => wrapPrefs[kind] ?? kind !== 'in';
const persist = () => vscode.setState({ collapsed: [...collapsed].slice(-500), wrap: wrapPrefs });
const liveFields = new Set<{ kind: string; applyWrap(): void }>();

// ---------------- text cache (texts are only sent when they change) ----------------

const texts = new Map<string, string>();
/** Numbers every edit sent, across all boxes (the host echoes the last one it applied). */
let editSeq = 0;
/** How the host stores a box's text: with a final newline. */
const withNewline = (t: string) => (t === '' || t.endsWith('\n') ? t : t + '\n');
function textOf(id: string, vm: TextVM): string {
  if (vm.text !== undefined) texts.set(id, vm.text);
  return texts.get(id) ?? '';
}

// ---------------- layout ----------------

const app = document.getElementById('app')!;
const hdr = h('header', { id: 'hdr' });
const scroll = h('div', { id: 'scroll' });
const warnEl = h('div', { id: 'warnings' });
const settingsEl = h('div', { id: 'settings' });
const compileEl = h('div', { id: 'compile' });
const manualEl = h('div', { id: 'manual' });
const casesEl = h('div', { id: 'cases' });
const emptyEl = h('div', { id: 'empty' });
const footer = h('footer', { id: 'stress' });
// The settings panel floats over the top of the case list, so it stays put while the cases scroll.
const main = h('div', { id: 'main' });
const noticeEl = h('div', { id: 'notice', hidden: true });
const filesMenu = h('div', { id: 'files-menu', hidden: true, role: 'menu' });
scroll.append(warnEl, compileEl, manualEl, casesEl, emptyEl);
main.append(scroll, settingsEl, noticeEl);
app.append(hdr, main, footer, filesMenu);

let state: ViewState | null = null;
let currentFile = '';

// ---------------- text field (label + editor) ----------------

interface FieldOpts {
  title: string;
  editable?: boolean;
  placeholder?: string;
  onEdit?: (text: string, seq: number) => void;
  onRun?: () => void;
  onOpen?: () => void;
  onBlockedEdit?: () => void;
  extraButtons?: () => HTMLElement[];
}

class Field {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private info: HTMLElement;
  private btns: HTMLElement;
  private body: HTMLElement;
  box: TextBox | null = null;
  private pending: ReturnType<typeof debounce> | null = null;
  private lastText = '';
  private btnsWrap: boolean | null = null;
  /** Sequence number of this box's last edit sent to the host. */
  private sentSeq = 0;

  readonly kind: string;

  constructor(
    private id: string,
    private opts: FieldOpts,
  ) {
    this.kind = id.split('|').pop() ?? '';
    liveFields.add(this);
    this.info = h('span', { class: 'field-info' });
    this.btns = h('span', { class: 'field-btns' });
    this.head = h('div', { class: 'field-head' }, h('span', { class: 'field-title' }, opts.title), this.info, this.btns);
    this.body = h('div', { class: 'field-body' });
    this.el = h('div', { class: 'field' }, this.head, this.body);
    if (opts.onEdit) {
      this.pending = debounce(() => {
        this.sentSeq = ++editSeq;
        opts.onEdit!(withNewline(this.lastText), this.sentSeq);
      }, 300);
    }
  }

  flush(): void {
    this.pending?.flush();
  }

  update(vm: TextVM, marks: Mark[] = [], scrollTo?: number): void {
    const raw = textOf(this.id, vm);
    const text = raw.replace(/\r?\n$/, '');
    if (!this.box) {
      this.box = new TextBox(this.body, {
        editable: vm.editable && !!this.opts.editable,
        placeholder: this.opts.placeholder,
        wrap: wrapOn(this.kind),
        onRun: this.opts.onRun,
        onBlockedEdit: this.opts.onBlockedEdit,
        onHistory: sendHistory,
        onChange: (t) => {
          this.lastText = t;
          this.pending?.();
        },
      });
    }
    this.box.setEditable(vm.editable && !!this.opts.editable);
    if (this.box.rev !== vm.rev) {
      // Typing not sent yet, or an edit the host hasn't applied: that edit will replace the file anyway, so the
      // box keeps what the user typed rather than showing older text.
      const busy = !!this.pending?.pending() || (vm.seq ?? 0) < this.sentSeq;
      if (this.box.rev === -1) this.box.setContent(text, vm.startLine);
      else if (vm.echo) {
        // Our own edit coming back; only if the box somehow differs (and nothing newer is on the way) adopt it.
        if (!busy && withNewline(this.box.text) !== raw) this.box.setContent(text, vm.startLine);
      } else if (!busy && !(this.box.focused && withNewline(this.box.text) === raw)) this.box.setContent(text, vm.startLine);
      this.box.rev = vm.rev;
    }
    this.box.setMarks(marks);
    if (scrollTo !== undefined) this.box.scrollToLine(scrollTo);
    const parts: string[] = [];
    if (vm.truncated) parts.push(vm.startLine > 1 ? `from line ${vm.startLine} · ${fmtBytes(vm.size)} total` : `first ${fmtBytes(text.length)} of ${fmtBytes(vm.size)}`);
    else if (vm.size > 4096) parts.push(fmtBytes(vm.size));
    this.info.textContent = parts.join(' · ');
    this.renderButtons();
  }

  private renderButtons(): void {
    const on = wrapOn(this.kind);
    if (this.btnsWrap === on && !this.opts.extraButtons) return;
    this.btnsWrap = on;
    this.btns.replaceChildren(
      ...(this.opts.extraButtons?.() ?? []),
      btn(null, 'word-wrap', () => this.toggleWrap(), { title: on ? 'Line wrap is on (for every box of this kind)' : 'Line wrap is off (for every box of this kind)', cls: `tiny ${on ? 'active' : ''}` }),
      ...(this.opts.onOpen ? [btn(null, 'go-to-file', this.opts.onOpen, { title: 'Open in editor', cls: 'tiny' })] : []),
      btn(null, 'copy', () => void navigator.clipboard.writeText(this.box?.text ?? ''), { title: 'Copy', cls: 'tiny' }),
    );
  }

  private toggleWrap(): void {
    wrapPrefs[this.kind] = !wrapOn(this.kind);
    persist();
    for (const f of liveFields) if (f.kind === this.kind) f.applyWrap();
  }

  applyWrap(): void {
    this.box?.setWrap(wrapOn(this.kind));
    this.renderButtons();
  }

  setClass(cls: string, on: boolean): void {
    this.el.classList.toggle(cls, on);
  }

  focus(): void {
    this.box?.focus();
  }

  destroy(): void {
    this.pending?.flush();
    this.box?.destroy();
    liveFields.delete(this);
  }
}

// ---------------- verdicts ----------------

const VERDICTS: Record<Verdict, [string, string]> = {
  AC: ['AC', 'ok'],
  WA: ['WA', 'bad'],
  RE: ['RE', 'bad'],
  TLE: ['TLE', 'warn'],
  OLE: ['OLE', 'warn'],
  CE: ['CE', 'bad'],
  RAN: ['ran', 'neutral'],
  NOCHECK: ['no checker', 'warn'],
  ERR: ['error', 'bad'],
  RUNNING: ['running', 'run'],
  QUEUED: ['queued', 'neutral'],
  STOPPED: ['stopped', 'neutral'],
};

/** Card colour per verdict. */
const OUTCOME: Partial<Record<Verdict, 'pass' | 'fail' | 'warn'>> = { AC: 'pass', WA: 'fail', RE: 'fail', TLE: 'fail', OLE: 'fail', CE: 'fail', ERR: 'fail', NOCHECK: 'warn' };

// ---------------- transcript (interactive) ----------------

function transcriptView(lines: TranscriptLine[], el: HTMLElement): void {
  let inN = 0;
  let outN = 0;
  const rows: HTMLElement[] = [];
  for (const l of lines) {
    if (l.k === 'err') continue;
    const n = l.k === 'in' ? ++inN : ++outN;
    rows.push(h('div', { class: `t-line t-${l.k}` }, h('span', { class: 't-no' }, String(n)), h('span', { class: 't-text' }, l.t || ' ')));
  }
  el.replaceChildren(...rows);
}

function interleaved(lines: TranscriptLine[]): { text: string; marks: Mark[] } {
  const marks: Mark[] = [];
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(l.t);
    if (l.k !== 'err') marks.push({ line: i + 1, cls: l.k === 'in' ? 'il-in' : 'il-out' });
  });
  return { text: out.join('\n'), marks };
}

// ---------------- case cards ----------------

class Card {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private label: HTMLElement;
  private badge: HTMLElement;
  private time: HTMLElement;
  private actions: HTMLElement;
  private input: Field;
  private expected: Field;
  private received: Field | null = null;
  private stderr: Field | null = null;
  private debug: Field | null = null;
  private detail: HTMLElement;
  private transcript: HTMLElement;
  private interleave: Field | null = null;
  vm!: CaseVM;
  /** File the card last showed (cards are reused across files) and the time of its last result. */
  private file = '';
  private lastAt?: number;
  private actionsSig = '';

  constructor(readonly key: string) {
    const grip = h('span', { class: 'grip', title: 'Drag to reorder' }, icon('gripper'));
    const chev = h('span', { class: 'chev', title: 'Collapse / expand' }, icon('chevron-down'));
    this.label = h('span', { class: 'case-label' });
    this.badge = h('span', { class: 'badge' });
    this.time = h('span', { class: 'time' });
    this.actions = h('span', { class: 'case-actions' });
    this.head = h('div', { class: 'case-head' }, grip, chev, this.label, this.badge, this.time, this.actions);
    this.input = new Field(`${key}|in`, {
      title: 'Input',
      editable: true,
      placeholder: 'input',
      onEdit: (t, seq) => send({ type: 'edit', key, field: 'in', text: t, file: currentFile, seq }),
      onRun: () => send({ type: 'runCase', key }),
      onOpen: () => send({ type: 'open', key, field: 'in' }),
      onBlockedEdit: () => this.nudgeKeep(),
    });
    this.expected = new Field(`${key}|ans`, {
      title: 'Expected',
      editable: true,
      placeholder: 'expected output',
      onEdit: (t, seq) => send({ type: 'edit', key, field: 'ans', text: t, file: currentFile, seq }),
      onRun: () => send({ type: 'runCase', key }),
      onOpen: () => send({ type: 'open', key, field: 'ans' }),
      onBlockedEdit: () => this.nudgeKeep(),
    });
    this.detail = h('div', { class: 'detail' });
    this.transcript = h('div', { class: 'transcript' });
    this.body = h('div', { class: 'case-body' }, this.input.el, this.expected.el, this.detail, this.transcript);
    this.el = h('div', { class: 'case', 'data-key': key }, this.head, this.body);
    grip.addEventListener('pointerdown', () => (this.el.draggable = true));
    this.el.addEventListener('dragend', () => (this.el.draggable = false));
    this.el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', key);
      this.el.classList.add('dragging');
      dragKey = key;
    });
    this.el.addEventListener('dragend', () => {
      this.el.classList.remove('dragging');
      dragKey = null;
      clearDropMarks();
    });
    // Anywhere on the bar folds / unfolds, except the drag handle and the buttons.
    this.head.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.grip, button, a, input, select')) return;
      this.setCollapsed(!collapsed.has(this.ck));
    });
  }

  private get ck(): string {
    return `${this.file}|${this.key}`;
  }

  setCollapsed(on: boolean): void {
    if (on === collapsed.has(this.ck)) return;
    if (on) collapsed.add(this.ck);
    else collapsed.delete(this.ck);
    persist();
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    this.el.classList.toggle('collapsed', collapsed.has(this.ck));
  }

  /** Like CPH: a finished run folds up passing cases and opens failing ones. */
  private autoCollapse(r: ResultVM | undefined, sameFile: boolean): void {
    const fresh = sameFile && !!r && !r.live && r.at !== this.lastAt;
    this.lastAt = r?.at;
    if (!fresh) return;
    const o = OUTCOME[r!.verdict];
    // Not while typing in this case (Ctrl+Enter runs it).
    if (o === 'pass' && !this.el.contains(document.activeElement)) this.setCollapsed(true);
    else if (o === 'fail' || o === 'warn' || r!.verdict === 'RAN') this.setCollapsed(false);
  }

  /** Someone typed into a read-only text-file case: point at Keep. */
  private nudgeKeep(): void {
    const keep = this.actions.querySelector<HTMLElement>('.keep');
    if (!keep) return;
    keep.classList.remove('nudge');
    void keep.offsetWidth; // restart the animation
    keep.classList.add('nudge');
  }

  flush(): void {
    this.input.flush();
    this.expected.flush();
  }

  update(vm: CaseVM): void {
    this.vm = vm;
    const k = vm.key;
    const sameFile = this.file === currentFile;
    this.file = currentFile;
    const outcome = vm.result && OUTCOME[vm.result.verdict];
    this.el.className = `case origin-${vm.origin}${vm.pinned ? ' pinned' : ''}${vm.stress ? ' stress' : ''}${outcome ? ` vd-${outcome}` : ''}`;
    this.autoCollapse(vm.result, sameFile);
    this.applyCollapsed();
    this.label.replaceChildren(vm.pinned ? icon('pinned') : '', h('span', {}, vm.label), vm.files && vm.files !== vm.label ? h('span', { class: 'files' }, vm.files.slice(vm.label.length)) : '', vm.stress ? h('span', { class: 'tag' }, 'stress') : '');
    const r = vm.result;
    if (r) {
      const [txt, cls] = VERDICTS[r.verdict];
      this.badge.className = `badge v-${cls}`;
      this.badge.replaceChildren(r.verdict === 'RUNNING' ? icon('loading codicon-modifier-spin') : '', txt);
      this.time.textContent = r.timeMs !== undefined ? `${r.timeMs} ms` : '';
    } else {
      this.badge.className = 'badge';
      this.badge.textContent = '';
      this.time.textContent = '';
    }
    // Only rebuilt when they change: swapping a button between mousedown and mouseup loses the click.
    const actionsSig = JSON.stringify([vm.origin, vm.pinned, !!(r?.diffExpected && r.received)]);
    if (actionsSig !== this.actionsSig) {
      this.actionsSig = actionsSig;
      this.actions.replaceChildren(
      ...[
        vm.origin === 'file' ? btn('Keep', 'save', () => send({ type: 'keep', key: k }), { title: 'Text-file cases are read-only. Keep copies this one into an editable case.', cls: 'tiny text keep' }) : null,
        r?.diffExpected && r.received ? btn(null, 'diff', () => send({ type: 'diff', key: k }), { title: 'Open expected vs received in a diff editor', cls: 'tiny' }) : null,
        btn(null, vm.pinned ? 'pinned' : 'pin', () => send({ type: 'pin', key: k, pinned: !vm.pinned }), { title: vm.pinned ? 'Unpin' : 'Pin to top', cls: 'tiny' }),
        btn(null, 'play', () => send({ type: 'runCase', key: k }), { title: 'Run this case (Ctrl+Enter in a box)', cls: 'tiny' }),
        vm.origin === 'file'
          ? btn(null, 'eye-closed', () => send({ type: 'hideCase', key: k }), { title: 'Hide this file case for this file', cls: 'tiny' })
          : btn(null, 'trash', () => send({ type: 'deleteCase', key: k }), { title: 'Delete case', cls: 'tiny' }),
      ].filter((x): x is HTMLButtonElement => !!x),
      );
    }

    // input / expected
    this.input.update(vm.input);
    this.input.setClass('locked', vm.origin === 'file');
    this.expected.setClass('locked', vm.origin === 'file');
    if (vm.expected) {
      this.expected.el.hidden = false;
      const marks: Mark[] = r?.diffExpected ? [{ line: r.diffExpected.line, col: r.diffExpected.col, len: r.diffExpected.len, cls: 'diff', span: true }] : [];
      this.expected.update(vm.expected, marks);
      this.expected.setClass('missing', vm.expectedMissing);
      this.expected.el.title = vm.expectedHint ?? '';
    } else this.expected.el.hidden = true;

    this.updateResult(r);
  }

  private updateResult(r: ResultVM | undefined): void {
    const k = this.key;
    // received
    if (r?.received) {
      if (!this.received) {
        this.received = new Field(`${k}|out`, { title: 'Received', onOpen: () => send({ type: 'open', key: k, field: 'out' }) });
        this.detail.before(this.received.el);
      }
      const marks: Mark[] = r.diffReceived ? [{ line: r.diffReceived.line, col: r.diffReceived.col, len: r.diffReceived.len, cls: 'diff', span: true }] : [];
      this.received.update(r.received, marks);
      this.received.el.hidden = !!r.transcript;
    } else if (this.received) {
      this.received.destroy();
      this.received.el.remove();
      this.received = null;
    }
    // stderr (plain, or interleaved with the conversation for interactive runs)
    if (r?.transcript) {
      transcriptView(r.transcript, this.transcript);
      this.transcript.hidden = false;
      if (!this.interleave) {
        this.interleave = new Field(`${k}|il`, { title: 'stderr (with conversation)' });
        this.transcript.after(this.interleave.el);
      }
      const il = interleaved(r.transcript);
      this.interleave.update({ rev: hashText(il.text), text: il.text, size: il.text.length, truncated: false, startLine: 1, editable: false }, il.marks);
    } else {
      this.transcript.hidden = true;
      if (this.interleave) {
        this.interleave.destroy();
        this.interleave.el.remove();
        this.interleave = null;
      }
    }
    if (r?.stderr && !r.transcript) {
      if (!this.stderr) {
        this.stderr = new Field(`${k}|err`, { title: 'stderr', onOpen: () => send({ type: 'open', key: k, field: 'err' }) });
        this.detail.after(this.stderr.el);
      }
      this.stderr.update(r.stderr);
    } else if (this.stderr) {
      this.stderr.destroy();
      this.stderr.el.remove();
      this.stderr = null;
    }
    if (r?.debug) {
      if (!this.debug) {
        this.debug = new Field(`${k}|dbg`, { title: 'stderr — debug build rerun', onOpen: () => send({ type: 'open', key: k, field: 'dbg' }) });
        this.body.append(this.debug.el);
      }
      this.debug.update(r.debug);
    } else if (this.debug) {
      this.debug.destroy();
      this.debug.el.remove();
      this.debug = null;
    }
    this.detail.textContent = r?.detail ?? '';
    this.detail.hidden = !r?.detail;
    this.detail.className = `detail ${r ? `v-${VERDICTS[r.verdict][1]}` : ''}`;
  }

  focusInput(): void {
    this.setCollapsed(false);
    this.input.focus();
  }

  destroy(): void {
    for (const f of [this.input, this.expected, this.received, this.stderr, this.debug, this.interleave]) f?.destroy();
    this.el.remove();
  }
}

function hashText(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x;
}

const cards = new Map<string, Card>();
let dragKey: string | null = null;

function clearDropMarks(): void {
  for (const c of cards.values()) c.el.classList.remove('drop-before', 'drop-after');
}

function dropTarget(y: number): { key: string; after: boolean } | null {
  const list = state?.cases ?? [];
  let best: { key: string; after: boolean } | null = null;
  for (const c of list) {
    const card = cards.get(c.key);
    if (!card) continue;
    const r = card.el.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { key: c.key, after: false };
    best = { key: c.key, after: true };
  }
  return best;
}

casesEl.addEventListener('dragover', (e) => {
  if (!dragKey) return;
  e.preventDefault();
  clearDropMarks();
  const t = dropTarget(e.clientY);
  if (t && t.key !== dragKey) cards.get(t.key)?.el.classList.add(t.after ? 'drop-after' : 'drop-before');
});
casesEl.addEventListener('drop', (e) => {
  if (!dragKey || !state) return;
  e.preventDefault();
  const t = dropTarget(e.clientY);
  clearDropMarks();
  if (!t || t.key === dragKey) return;
  const keys = state.cases.map((c) => c.key).filter((k) => k !== dragKey);
  let i = keys.indexOf(t.key);
  if (t.after) i++;
  keys.splice(i, 0, dragKey);
  // Move the DOM node right away so it doesn't jump back until the next state arrives.
  const moving = cards.get(dragKey);
  const anchor = cards.get(t.key);
  if (moving && anchor) (t.after ? anchor.el.after(moving.el) : anchor.el.before(moving.el));
  send({ type: 'reorder', keys });
});

function renderCases(s: ViewState): void {
  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  let lastPinned = -1;
  s.cases.forEach((c, i) => {
    if (c.pinned) lastPinned = i;
  });
  s.cases.forEach((vm, i) => {
    seen.add(vm.key);
    let card = cards.get(vm.key);
    if (!card) {
      card = new Card(vm.key);
      cards.set(vm.key, card);
    }
    card.update(vm);
    card.el.classList.toggle('pin-sep', i === lastPinned && i < s.cases.length - 1);
    const want = prev ? prev.nextSibling : casesEl.firstChild;
    if (want !== card.el) casesEl.insertBefore(card.el, want);
    prev = card.el;
  });
  for (const [k, c] of cards) {
    if (!seen.has(k)) {
      c.destroy();
      cards.delete(k);
    }
  }
  casesEl.querySelector('.no-cases')?.remove();
  if (!s.cases.length && s.file) {
    const n = s.fileCases.length;
    casesEl.append(
      h(
        'div',
        { class: 'no-cases' },
        'No test cases yet. ',
        h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), send({ type: 'addCase' })) }, 'Add one'),
        s.importBtn.enabled ? ' or import the samples (Ctrl+Shift+I).' : '.',
        n ? h('div', {}, `${n} text file${n === 1 ? '' : 's'} here look${n === 1 ? 's' : ''} like a test: `, h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), setFilesMenu(true)) }, 'choose from Files'), '.') : '',
      ),
    );
  }
}

// ---------------- header ----------------

let headerSig = '';
function renderHeader(s: ViewState): void {
  // Runs re-render often; rebuilding the header each time would eat clicks on Stop.
  const g = s.stress.gen;
  const sig = JSON.stringify([s.file, s.problem && { ...s.problem, dirFiles: 0, compileCandidates: 0 }, s.running, s.importBtn, s.submitBtn, s.ui.settingsOpen, g.canRun, g.running, g.genName, g.targetName, g.reason]);
  if (sig === headerSig) return updateFilesButton(s);
  headerSig = sig;
  if (!s.file || !s.problem) {
    hdr.replaceChildren(h('div', { class: 'title-row' }, h('span', { class: 'muted' }, 'cp2')));
    return;
  }
  const p = s.problem;
  const title = h('div', { class: 'title-row' }, h('span', { class: 'file', title: s.file.rel }, s.file.name));
  if (p.url) title.append(h('a', { class: 'problem', href: '#', title: p.url, onclick: (e: Event) => (e.preventDefault(), send({ type: 'openUrl', url: p.url! })) }, p.title));
  else if (p.title !== s.file.name) title.append(h('span', { class: 'problem' }, p.title));
  title.append(h('span', { class: 'tl', title: 'Time limit' }, `${p.timeLimitMs >= 1000 ? `${+(p.timeLimitMs / 1000).toFixed(2)} s` : `${p.timeLimitMs} ms`}`));
  if (p.settings.judgeFlags) title.append(h('span', { class: 'tag', title: 'Compiled with judge flags (-O2, no sanitizers)' }, 'judge flags'));
  if (p.settings.interactive) title.append(h('span', { class: 'tag' }, 'interactive'));
  title.append(btn(null, 'gear', () => send({ type: 'toggleSettings', open: !s.ui.settingsOpen }), { title: 'Problem settings', cls: `tiny gear ${s.ui.settingsOpen ? 'active' : ''}` }));
  const row1 = h(
    'div',
    { class: 'btn-row' },
    s.running ? btn('Stop', 'debug-stop', () => send({ type: 'stop' }), { cls: 'danger' }) : btn('Run all', 'play', () => send({ type: 'runAll' }), { title: 'Run all test cases (Ctrl+Shift+R)', cls: 'primary' }),
    btn('Case', 'add', () => send({ type: 'addCase' }), { title: 'Add a test case' }),
    btn('Gen case', g.running ? 'loading codicon-modifier-spin' : 'sparkle', () => send({ type: 'genCase' }), {
      title: g.canRun ? `Add a test case to ${g.targetName} generated by ${g.genName} (a random seed is passed as argv[1])` : g.genName ? `Can't generate: ${g.reason ?? ''}` : 'Link a generator under "Generate test case" at the bottom (Set up makes gen.cpp)',
      disabled: !g.canRun || g.running,
    }),
    filesButton(),
  );
  const row2 = h(
    'div',
    { class: 'btn-row' },
    btn(s.importBtn.label, 'cloud-download', () => send({ type: 'import' }), { title: s.importBtn.title || 'Import samples (Ctrl+Shift+I)', disabled: !s.importBtn.enabled, cls: 'grow' }),
    btn(s.submitBtn.label, 'cloud-upload', () => send({ type: 'submit' }), { title: s.submitBtn.title, disabled: !s.submitBtn.enabled, cls: 'grow' }),
  );
  hdr.replaceChildren(title, row1, row2);
  updateFilesButton(s);
  if (s.importBtn.note) hdr.append(h('div', { class: 'import-note' }, icon('info'), ' ', s.importBtn.note));
  if (p.verdict) {
    const v = p.verdict;
    const chip = h('div', { class: `verdict-line vs-${v.status}`, title: v.url ?? '' }, h('span', { class: 'dot' }), v.text);
    if (v.url) chip.addEventListener('click', () => send({ type: 'openUrl', url: v.url! }));
    hdr.append(chip);
  }
}

// ---------------- Files menu (text-file cases) ----------------

let filesMenuOpen = false;
let filesMenuSig = '';

function filesButton(): HTMLButtonElement {
  const b = btn('Files', 'files', () => setFilesMenu(!filesMenuOpen), { cls: 'files-btn' });
  b.append(icon('chevron-down'));
  return b;
}

/** Label, enabled state and the open look change in place (rebuilding the header would eat clicks). */
function updateFilesButton(s: ViewState): void {
  const b = hdr.querySelector<HTMLButtonElement>('.files-btn');
  if (!b) return;
  const all = s.fileCases;
  const label = all.length ? `Files ${all.filter((f) => f.shown).length}/${all.length}` : 'Files';
  const text = b.querySelector('.btn-label');
  if (text && text.textContent !== label) text.textContent = label;
  b.disabled = !all.length;
  b.title = all.length ? 'Text files here that look like test cases: choose which ones to show' : 'No text files here that look like test cases (in, in2, a.in, a-in.txt, …)';
  b.classList.toggle('active', filesMenuOpen);
}

function setFilesMenu(open: boolean): void {
  if (open === filesMenuOpen) return;
  filesMenuOpen = open;
  if (!state) return;
  updateFilesButton(state);
  renderFilesMenu(state);
  if (open) filesMenu.querySelector<HTMLElement>('.fm-row')?.focus();
}

function renderFilesMenu(s: ViewState): void {
  if (filesMenuOpen && (!s.file || !s.fileCases.length)) setFilesMenu(false);
  if (!filesMenuOpen) {
    filesMenu.hidden = true;
    filesMenuSig = '';
    return;
  }
  const sig = JSON.stringify(s.fileCases);
  if (sig !== filesMenuSig) {
    filesMenuSig = sig;
    // Rows are rebuilt; keep the keyboard on the one that had it.
    const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.fm-row')?.dataset.name;
    const show = (names: string[], on: boolean) => names.length && send({ type: 'showFiles', names, show: on });
    const hidden = s.fileCases.filter((f) => !f.shown).map((f) => f.name);
    const shown = s.fileCases.filter((f) => f.shown).map((f) => f.name);
    const link = (label: string, names: string[], on: boolean) => {
      const a = h('a', { href: '#', class: names.length ? '' : 'off' }, label);
      a.addEventListener('click', (e) => (e.preventDefault(), show(names, on)));
      return a;
    };
    const rows = s.fileCases.map((f) => {
      const row = h(
        'div',
        { class: `fm-row ${f.shown ? 'on' : ''}`, 'data-name': f.name, role: 'menuitemcheckbox', 'aria-checked': String(f.shown), tabindex: 0, title: f.shown ? 'Shown as a test case: click to hide' : 'Click to show as a test case' },
        h('span', { class: 'fm-check' }, f.shown ? icon('check') : ''),
        h('span', { class: 'fm-name' }, f.name),
        h('span', { class: `fm-ans ${f.expected ? '' : 'none'}` }, f.expected ? `→ ${f.expected}` : 'no answer'),
      );
      row.addEventListener('click', () => send({ type: 'showFiles', names: [f.name], show: !f.shown }));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          ((e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null)?.focus();
        }
      });
      return row;
    });
    filesMenu.replaceChildren(
      h('div', { class: 'fm-head' }, h('span', { class: 'fm-title' }, 'Text files here'), link('show all', hidden, true), link('hide all', shown, false)),
      h('div', { class: 'fm-list' }, ...rows),
      h('div', { class: 'fm-foot' }, 'Shown files run with Run all. They are read-only: Keep makes an editable copy.'),
    );
    if (focused) [...filesMenu.querySelectorAll<HTMLElement>('.fm-row')].find((r) => r.dataset.name === focused)?.focus();
  }
  // Under the button, kept inside the sidebar.
  const b = hdr.querySelector<HTMLElement>('.files-btn');
  const ar = app.getBoundingClientRect();
  const w = Math.min(320, ar.width - 12);
  filesMenu.style.width = `${w}px`;
  if (b) {
    const r = b.getBoundingClientRect();
    filesMenu.style.top = `${r.bottom - ar.top + 3}px`;
    filesMenu.style.left = `${Math.max(6, Math.min(r.right - ar.left - w, ar.width - w - 6))}px`;
  }
  filesMenu.hidden = false;
}

document.addEventListener('mousedown', (e) => {
  const t = e.target as Element;
  if (filesMenuOpen && !filesMenu.contains(t) && !t.closest?.('.files-btn')) setFilesMenu(false);
});

// ---------------- notices (undo / redo feedback) ----------------

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** `id`: the history step the Undo / Redo button stands for (the host ignores it if newer steps came after). */
function showNotice(text: string, action?: 'undo' | 'redo', id?: number): void {
  const parts: (HTMLElement | string)[] = [h('span', { class: 'notice-text' }, text)];
  if (action) parts.push(btn(action === 'undo' ? 'Undo' : 'Redo', action === 'undo' ? 'discard' : 'redo', () => ((noticeEl.hidden = true), sendHistory(action, id)), { cls: 'tiny text', title: action === 'undo' ? 'Ctrl+Z' : 'Ctrl+R / Ctrl+Y' }));
  parts.push(btn(null, 'close', () => (noticeEl.hidden = true), { cls: 'tiny', title: 'Dismiss' }));
  noticeEl.replaceChildren(...parts);
  noticeEl.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (noticeEl.hidden = true), action ? 6000 : 2500);
}

// Edit > Undo / Redo (and keys we didn't catch) arrive as document.execCommand('undo') from VS Code's webview host,
// which doesn't fire beforeinput, so CodeMirror would do a native undo: route those to the sidebar's history instead.
const nativeExec = document.execCommand.bind(document);
document.execCommand = ((command: string, ui?: boolean, value?: string) => {
  if ((command === 'undo' || command === 'redo') && !isTextInput(document.activeElement)) {
    sendHistory(command);
    return true;
  }
  return nativeExec(command, ui, value);
}) as typeof document.execCommand;

function isTextInput(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement) return true;
  return t instanceof HTMLInputElement && ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(t.type);
}

/** Sends typing that is still waiting for its pause (before runs, undo, VS Code shortcuts). */
function flushEdits(): void {
  for (const c of cards.values()) c.flush();
}

function sendHistory(dir: 'undo' | 'redo', id?: number): void {
  if (!state?.file) return;
  // send() flushes typing that hasn't been sent yet: it's part of what gets undone.
  send({ type: dir, file: currentFile, id });
}

// Capture phase on window: runs before CodeMirror's keymaps and before VS Code's own listener (which forwards keys to
// the workbench in the bubble phase), so Ctrl+R doesn't open "Open Recent" and Ctrl+Z doesn't also undo through VS Code.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.isComposing || e.altKey || !(e.ctrlKey || e.metaKey)) return;
    // Letters by their meaning; on non-Latin layouts (Ctrl+Я) by the key's position, like VS Code does.
    const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : ({ 90: 'z', 89: 'y', 82: 'r' } as Record<number, string>)[e.keyCode] ?? '';
    const dir = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : (k === 'y' || k === 'r') && !e.shiftKey ? 'redo' : null;
    if (!dir || !state?.file) {
      // Possibly a VS Code shortcut (Ctrl+Shift+R runs everything): let it see the latest typing.
      flushEdits();
      return;
    }
    // Plain text inputs (time limit, the manual-run box) keep their own Ctrl+Z / Ctrl+Y.
    if (k !== 'r' && isTextInput(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) sendHistory(dir);
  },
  true,
);

// ---------------- settings ----------------

function select(options: [string, string][], value: string, onChange: (v: string) => void, title = ''): HTMLSelectElement {
  const sel = h('select', { title });
  for (const [v, label] of options) sel.append(h('option', { value: v, selected: v === value }, label));
  if (!options.some(([v]) => v === value)) sel.append(h('option', { value, selected: true }, value));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function setting(patch: Partial<ProblemSettingsVM>): void {
  send({ type: 'setting', patch });
}

let settingsSig = '';
function renderSettings(s: ViewState): void {
  if (!s.problem || !s.file || !s.ui.settingsOpen) {
    settingsEl.replaceChildren();
    settingsEl.hidden = true;
    settingsSig = '';
    return;
  }
  settingsEl.hidden = false;
  const p = s.problem;
  const st = p.settings;
  // Rebuilding on every render (runs update the state a lot) would eat half-typed values.
  const sig = JSON.stringify([s.file.path, st, p.dirFiles, p.compileCandidates, p.checkerExists, p.judgeExists, p.timeLimitMs]);
  if (sig === settingsSig) return;
  settingsSig = sig;
  const fileOpts = (cur: string): [string, string][] => {
    const set = new Set([...p.dirFiles, cur]);
    return [...set].sort().map((f) => [f, f]);
  };
  const compareRow = h(
    'div',
    { class: 'row' },
    h('label', {}, 'Compare'),
    select(
      [
        ['standard', 'standard'],
        ['firstLine', 'first line'],
        ['precision', 'precision'],
        ['checker', 'custom checker'],
      ],
      st.compare,
      (v) => setting({ compare: v as ProblemSettingsVM['compare'] }),
    ),
  );
  if (st.compare === 'precision') {
    const inp = h('input', { type: 'text', value: String(st.precision), size: 6, title: 'Absolute or relative error' });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (v > 0) setting({ precision: v });
    });
    compareRow.append(h('span', { class: 'muted' }, 'ε'), inp);
  }
  if (st.compare === 'checker') {
    compareRow.append(select(fileOpts(st.checker), st.checker, (v) => setting({ checker: v }), 'checker <input> <output> <expected>; exit 0 = accepted'));
    if (!p.checkerExists) compareRow.append(h('span', { class: 'hint warn' }, 'not created yet'));
  }
  const typeRow = h(
    'div',
    { class: 'row' },
    h('label', {}, 'Type'),
    select(
      [
        ['normal', 'normal'],
        ['interactive', 'stdio interactive'],
      ],
      st.interactive ? 'interactive' : 'normal',
      (v) => setting({ interactive: v === 'interactive' }),
    ),
  );
  if (st.interactive) {
    typeRow.append(
      select(fileOpts(st.judge), st.judge, (v) => setting({ judge: v }), 'Judge: exit 0 = accepted, anything else (or a timeout) = rejected'),
      select(
        [
          ['stdin', 'test on stdin'],
          ['argv', 'test as argv[1]'],
        ],
        st.judgeInput,
        (v) => setting({ judgeInput: v as 'stdin' | 'argv' }),
        'How the judge receives the test case',
      ),
    );
    if (!p.judgeExists) typeRow.append(h('span', { class: 'hint warn' }, `${st.judge} not created yet`));
  }
  const cw = h('div', { class: 'chips' });
  if (!p.compileCandidates.length) cw.append(h('span', { class: 'muted' }, 'no other .cpp / .h files in this folder'));
  for (const f of p.compileCandidates) {
    const on = st.compileWith.includes(f);
    const chip = h('label', { class: `chip ${on ? 'on' : ''}` }, h('input', { type: 'checkbox', checked: on }), f);
    chip.querySelector('input')!.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      setting({ compileWith: checked ? [...st.compileWith, f] : st.compileWith.filter((x) => x !== f) });
    });
    cw.append(chip);
  }
  const tl = h('input', { type: 'number', min: 1, step: 100, value: st.timeLimitMs ?? '', placeholder: String(p.timeLimitMs), size: 7 });
  tl.addEventListener('change', () => setting({ timeLimitMs: tl.value ? Number(tl.value) : 0 }));
  const jf = h('input', { type: 'checkbox', checked: st.judgeFlags });
  jf.addEventListener('change', () => setting({ judgeFlags: jf.checked }));
  settingsEl.replaceChildren(
    h('div', { class: 'settings-head' }, icon('gear'), h('span', { class: 'settings-title' }, 'Settings'), h('span', { class: 'settings-file', title: s.file.rel }, s.file.name), btn(null, 'close', closeSettings, { title: 'Close (Esc)', cls: 'tiny' })),
    h(
      'div',
      { class: 'settings-body' },
      compareRow,
      typeRow,
      h('div', { class: 'row top' }, h('label', {}, 'Compile with'), cw),
      h('div', { class: 'row' }, h('label', {}, 'Time limit'), tl, h('span', { class: 'muted' }, 'ms')),
      h('div', { class: 'row' }, h('label', {}, ''), h('label', { class: 'check', title: 'Compile with judge-like flags (-O2, no sanitizers) to check tight time limits' }, jf, 'Judge flags (‑O2, no sanitizers)')),
    ),
  );
}

function closeSettings(): void {
  if (state?.ui.settingsOpen) send({ type: 'toggleSettings', open: false });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (filesMenuOpen) {
    setFilesMenu(false);
    hdr.querySelector<HTMLElement>('.files-btn')?.focus();
  } else if (!settingsEl.hidden) closeSettings();
});

// ---------------- compile box & warnings ----------------

let compileField: Field | null = null;
function renderCompile(s: ViewState): void {
  const c = s.compile;
  if (c.state === 'compiling') {
    compileEl.replaceChildren(h('div', { class: 'compiling' }, icon('loading codicon-modifier-spin'), ` Compiling${c.judgeFlags ? ' (judge flags)' : ''}…`));
    compileField = null;
  } else if (c.state === 'error') {
    if (!compileField || !compileEl.contains(compileField.el)) {
      compileField = new Field('compile|ce', { title: 'Compile error' });
      compileEl.replaceChildren(compileField.el);
    }
    const out = c.output || '(no output)';
    compileField.update({ rev: hashText(out), text: out, size: out.length, truncated: false, startLine: 1, editable: false });
    compileField.setClass('error', true);
  } else {
    compileEl.replaceChildren();
    compileField = null;
  }
}

function renderWarnings(s: ViewState): void {
  warnEl.replaceChildren(...s.warnings.map((w) => h('div', { class: 'warning' }, icon('warning'), ' ', w)));
}

// ---------------- manual run (interactive) ----------------

let manualLines: TranscriptLine[] = [];
const transcriptEl = h('div', { class: 'transcript manual-transcript' });
const manualInput = h('textarea', { class: 'manual-input', rows: 1, placeholder: 'type input · Enter to send · Shift+Enter for a new line' });
let manualErr: Field | null = null;
let manualRendered = 0;
manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send({ type: 'manualSend', text: manualInput.value });
    manualInput.value = '';
    manualInput.rows = 1;
  }
});
manualInput.addEventListener('input', () => {
  manualInput.rows = Math.min(6, manualInput.value.split('\n').length);
});

function renderManual(s: ViewState): void {
  if (!s.manual.visible) {
    manualEl.hidden = true;
    return;
  }
  manualEl.hidden = false;
  const head = h(
    'div',
    { class: 'manual-head' },
    h('span', { class: 'section-title' }, 'Manual run'),
    s.manual.running ? btn('Stop', 'debug-stop', () => send({ type: 'manualStop' }), { cls: 'tiny text' }) : btn('Start', 'play', () => send({ type: 'manualStart' }), { cls: 'tiny text', title: 'Start the program and type its input yourself' }),
    btn('EOF', null, () => send({ type: 'manualEof' }), { cls: 'tiny text', disabled: !s.manual.running, title: 'Close the program’s stdin' }),
    h('span', { class: 'muted manual-exit' }, s.manual.running ? 'running' : (s.manual.exit ?? '')),
  );
  if (!manualErr) manualErr = new Field('manual|err', { title: 'stderr (with conversation)' });
  manualInput.disabled = !s.manual.running;
  if (!manualEl.firstChild) manualEl.append(head, transcriptEl, manualInput, manualErr.el);
  else manualEl.firstChild.replaceWith(head);
  drawManual();
}

function drawManual(): void {
  if (manualRendered > manualLines.length) manualRendered = 0;
  if (manualRendered === 0) transcriptView(manualLines, transcriptEl);
  else {
    let inN = manualLines.slice(0, manualRendered).filter((l) => l.k === 'in').length;
    let outN = manualLines.slice(0, manualRendered).filter((l) => l.k === 'out').length;
    for (const l of manualLines.slice(manualRendered)) {
      if (l.k === 'err') continue;
      const n = l.k === 'in' ? ++inN : ++outN;
      transcriptEl.append(h('div', { class: `t-line t-${l.k}` }, h('span', { class: 't-no' }, String(n)), h('span', { class: 't-text' }, l.t || ' ')));
    }
  }
  manualRendered = manualLines.length;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  if (manualErr) {
    const il = interleaved(manualLines);
    manualErr.update({ rev: hashText(il.text) ^ manualLines.length, text: il.text, size: il.text.length, truncated: false, startLine: 1, editable: false }, il.marks, manualLines.length || undefined);
  }
}

// ---------------- stress footer ----------------

const SHRINK = ['0', '0.2 s', '0.5 s', '1 s', '2 s', '5 s', '10 s'];
const stressEls: Record<SectionMode, HTMLDetailsElement> = { gen: h('details', { class: 'stress-sec gen-sec' }), wa: h('details', { class: 'stress-sec' }), re: h('details', { class: 'stress-sec' }) };
footer.append(stressEls.gen, stressEls.wa, stressEls.re);
for (const mode of ['gen', 'wa', 're'] as const) {
  stressEls[mode].addEventListener('toggle', () => {
    const open = stressEls[mode].open;
    if (state && state.stress[mode].open !== open) send({ type: 'stressOpen', mode, open });
  });
}
let shrinkDragging = false;
/** Structure each section was last built for, and the texts that change in place while it runs. */
const stressSig: Record<SectionMode, string> = { gen: '', wa: '', re: '' };
const stressLive: Record<'wa' | 're', { chip: HTMLElement | null; status: HTMLElement | null }> = { wa: { chip: null, status: null }, re: { chip: null, status: null } };

function renderStress(s: ViewState): void {
  footer.hidden = !s.file;
  renderGenSection(s.stress.gen);
  for (const mode of ['wa', 're'] as const) {
    const sec = s.stress[mode];
    const el = stressEls[mode];
    if (el.open !== sec.open) el.open = sec.open;
    // A run reports progress several times a second. Rebuilding then would swap Stop out from under
    // the mouse (the click never lands) and close open dropdowns, so only the status texts change.
    const sig = JSON.stringify({ ...sec, open: 0, status: sec.status && { ...sec.status, text: 0 } });
    if (sig === stressSig[mode]) {
      const live = stressLive[mode];
      if (sec.status && live.chip) live.chip.textContent = shortStatus(sec);
      if (sec.status && live.status) live.status.textContent = sec.status.text;
      continue;
    }
    if (shrinkDragging && el.contains(document.activeElement)) continue;
    stressSig[mode] = sig;
    const chipText = sec.status ? h('span', {}, shortStatus(sec)) : null;
    let statusEl: HTMLElement | null = null;
    const runBtn = sec.running
      ? btn(null, 'debug-stop', () => send({ type: 'stressStop', mode }), { title: 'Stop', cls: 'tiny danger' })
      : btn(null, 'play', () => send({ type: 'stressRun', mode }), { title: sec.canRun ? 'Run' : (sec.disabled ?? sec.reason ?? ''), cls: 'tiny', disabled: !sec.canRun });
    const summary = h(
      'summary',
      {},
      icon('chevron-right'),
      h('span', { class: 'sec-title' }, mode === 'wa' ? 'Run WA stress' : 'Run RE stress'),
      sec.status ? h('span', { class: `chip st-${sec.status.state}` }, sec.status.state === 'running' || sec.status.state === 'compiling' || sec.status.state === 'shrinking' ? icon('loading codicon-modifier-spin') : '', ' ', chipText!) : !sec.canRun && !sec.disabled ? h('span', { class: 'chip st-missing' }, 'not linked') : '',
      runBtn,
    );
    const body = h('div', { class: 'sec-body' });
    if (sec.disabled) body.append(h('div', { class: 'muted' }, sec.disabled));
    else {
      for (const slot of sec.slots) body.append(slotRow(mode, slot));
      if (sec.compare) body.append(compareRow(mode, sec));
      const range = h('input', { type: 'range', min: 0, max: 6, step: 1, value: sec.shrink });
      const lbl = h('span', { class: 'shrink-val' }, SHRINK[sec.shrink]);
      range.addEventListener('input', () => {
        shrinkDragging = true;
        lbl.textContent = SHRINK[Number(range.value)];
      });
      range.addEventListener('change', () => {
        shrinkDragging = false;
        send({ type: 'stressShrink', mode, index: Number(range.value) });
      });
      body.append(h('div', { class: 'row', title: 'After the first failure, keep looking this long for a smaller failing input' }, h('label', {}, 'smaller'), range, lbl));
      const actions = h('div', { class: 'row actions' });
      if (sec.needsSetup) actions.append(btn('Set up', 'wand', () => send({ type: 'stressSetup', mode }), { title: mode === 'wa' ? 'Move this file into its own folder and create a brute and gen.cpp' : 'Move this file into its own folder and create gen.cpp', cls: 'tiny text' }));
      actions.append(
        sec.running
          ? btn('Stop', 'debug-stop', () => send({ type: 'stressStop', mode }), { cls: 'tiny text danger' })
          : btn(mode === 'wa' ? 'Run WA stress' : 'Run RE stress', 'play', () => send({ type: 'stressRun', mode }), { cls: 'tiny text primary', disabled: !sec.canRun, title: sec.canRun ? '' : (sec.reason ?? '') }),
      );
      body.append(actions);
      if (sec.status) {
        statusEl = h('div', { class: `stress-status st-${sec.status.state}` }, sec.status.text);
        body.append(statusEl);
        if (sec.status.detail) body.append(h('pre', { class: 'stress-detail' }, sec.status.detail));
      }
    }
    el.replaceChildren(summary, body);
    stressLive[mode] = { chip: chipText, status: statusEl };
  }
}

/** "Generate test case": gen (+ optional answer brute), Set up, Gen case. */
function renderGenSection(sec: GenSectionVM): void {
  const el = stressEls.gen;
  if (el.open !== sec.open) el.open = sec.open;
  const sig = JSON.stringify(sec);
  if (sig === stressSig.gen) return;
  stressSig.gen = sig;
  const st = sec.status;
  const busy = st?.state === 'compiling' || st?.state === 'running';
  const chip = st ? h('span', { class: `chip st-${st.state}` }, busy ? icon('loading codicon-modifier-spin') : '', ' ', st.state === 'compiling' ? 'compiling' : st.state === 'running' ? 'generating' : st.state === 'error' ? 'error' : 'added') : !sec.canRun ? h('span', { class: 'chip st-missing' }, 'not linked') : '';
  const genBtn = (text: boolean) =>
    btn(text ? 'Gen case' : null, sec.running ? 'loading codicon-modifier-spin' : 'sparkle', () => send({ type: 'genCase' }), {
      title: sec.canRun ? 'Add a test case generated by the gen (a random seed is passed as argv[1])' : (sec.reason ?? ''),
      disabled: !sec.canRun || sec.running,
      cls: text ? 'tiny text primary' : 'tiny',
    });
  const summary = h('summary', {}, icon('chevron-right'), h('span', { class: 'sec-title' }, 'Generate test case'), chip, genBtn(false));
  const body = h('div', { class: 'sec-body' });
  for (const slot of sec.slots) body.append(slotRow('gen', slot));
  const actions = h('div', { class: 'row actions' });
  if (sec.needsSetup) actions.append(btn('Set up', 'wand', () => send({ type: 'stressSetup', mode: 'gen' }), { title: 'Move this file into its own folder and create gen.cpp', cls: 'tiny text' }));
  actions.append(genBtn(true));
  body.append(actions);
  if (st) {
    body.append(h('div', { class: `stress-status st-${st.state}` }, st.text));
    if (st.detail) body.append(h('pre', { class: 'stress-detail' }, st.detail));
  }
  el.replaceChildren(summary, body);
}

function shortStatus(sec: StressSectionVM): string {
  const st = sec.status!;
  if (st.state === 'running') return st.text.split(' · ')[0];
  if (st.state === 'found') return st.text.split(' (')[0].split(' — ')[0];
  if (st.state === 'clean') return 'clean';
  if (st.state === 'shrinking') return 'shrinking';
  if (st.state === 'compiling') return 'compiling';
  if (st.state === 'stopped') return 'stopped';
  return 'error';
}

function slotRow(mode: SectionMode, slot: SlotVM): HTMLElement {
  const opts: [string, string][] = [['', slot.optional ? '(none)' : '—']];
  for (const f of slot.options) opts.push([f, f]);
  const sel = select(opts, slot.value, (v) => send({ type: 'stressPick', mode, role: slot.role, value: v }));
  sel.classList.toggle('auto', slot.auto && !!slot.value);
  sel.classList.toggle('missing', slot.missing);
  const row = h('div', { class: 'row' }, h('label', {}, slot.role), sel);
  if (slot.role === 'answer') row.title = 'Optional: a brute whose output on the generated input becomes the expected output';
  if (slot.missing && slot.value && (slot.role === 'checker' || slot.role === 'judge' || slot.role === 'answer')) row.append(h('span', { class: 'hint warn' }, 'not found'));
  else if (slot.auto && slot.value) row.append(h('span', { class: 'hint' }, 'auto'));
  return row;
}

function compareRow(mode: 'wa' | 're', sec: StressSectionVM): HTMLElement {
  const c = sec.compare!;
  const row = h(
    'div',
    { class: 'row', title: `Comparison mode of ${sec.susName ?? 'sus'} (same as its ⚙ settings)` },
    h('label', {}, 'compare'),
    select(
      [
        ['standard', 'standard'],
        ['firstLine', 'first line'],
        ['precision', 'precision'],
        ['checker', 'custom checker'],
      ],
      c.mode,
      (v) => send({ type: 'stressSetting', mode, patch: { compare: v as ProblemSettingsVM['compare'] } }),
    ),
  );
  if (c.mode === 'precision') row.append(h('span', { class: 'muted' }, `ε ${c.precision}`));
  return row;
}

// ---------------- main render ----------------

function render(s: ViewState): void {
  if (currentFile && s.file?.path !== currentFile) {
    for (const c of cards.values()) c.flush();
    filesMenuOpen = false;
    noticeEl.hidden = true; // its Undo was about the other file
    pendingReveal = null;
  }
  currentFile = s.file?.path ?? '';
  state = s;
  document.body.classList.toggle('no-file', !s.file);
  emptyEl.hidden = !!s.file;
  if (!s.file) emptyEl.replaceChildren(h('div', { class: 'muted' }, 'Open a C++, C or Python file to start.'));
  renderHeader(s);
  renderWarnings(s);
  renderSettings(s);
  renderCompile(s);
  renderManual(s);
  renderCases(s);
  renderStress(s);
  renderFilesMenu(s);
  applyReveal();
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'state') render(m.state);
  else if (m.type === 'manual') {
    if (m.reset) {
      manualLines = [];
      manualRendered = 0;
    }
    manualLines.push(...m.events);
    if (state?.manual.visible) drawManual();
  } else if (m.type === 'reveal') {
    // The state with the new card may still be on its way: try again after the next renders.
    pendingReveal = { m, until: Date.now() + 3000 };
    applyReveal();
  } else if (m.type === 'notice') {
    showNotice(m.text, m.action, m.id);
  }
});

let pendingReveal: { m: Extract<ToWebview, { type: 'reveal' }>; until: number } | null = null;
function applyReveal(): void {
  if (!pendingReveal) return;
  const { m, until } = pendingReveal;
  const c = cards.get(m.key);
  if (!c) {
    if (Date.now() > until) pendingReveal = null;
    return;
  }
  pendingReveal = null;
  if (m.expand || m.focus) c.setCollapsed(false);
  c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  c.el.classList.add('flash');
  setTimeout(() => c.el.classList.remove('flash'), 900);
  if (m.focus) c.focusInput();
}

window.addEventListener('blur', () => {
  setFilesMenu(false);
  for (const c of cards.values()) c.flush();
});

send({ type: 'ready' });
