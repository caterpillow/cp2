// cp2 sidebar UI (vanilla TS + CodeMirror). The extension owns all state; this file renders it
// and sends user actions back.

import type { CaseVM, FromWebview, ProblemSettingsVM, ResultVM, SlotVM, StressSectionVM, TextVM, ToWebview, TranscriptLine, Verdict, ViewState } from '../../shared/viewModel';
import { Mark, TextBox } from './editor';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

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
  return d;
}

// ---------------- persistent UI bits ----------------

const saved: { collapsed?: string[]; wrap?: Record<string, boolean> } = vscode.getState() ?? {};
const collapsed = new Set<string>(saved.collapsed ?? []);
// Line wrap per kind of box (input, expected, received, stderr, ...): on by default except input.
const wrapPrefs: Record<string, boolean> = saved.wrap ?? {};
const wrapOn = (kind: string) => wrapPrefs[kind] ?? kind !== 'in';
const persist = () => vscode.setState({ collapsed: [...collapsed].slice(-500), wrap: wrapPrefs });
const liveFields = new Set<{ kind: string; applyWrap(): void }>();

// ---------------- text cache (texts are only sent when they change) ----------------

const texts = new Map<string, string>();
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
scroll.append(warnEl, settingsEl, compileEl, manualEl, casesEl, emptyEl);
app.append(hdr, scroll, footer);

let state: ViewState | null = null;
let currentFile = '';

// ---------------- text field (label + editor) ----------------

interface FieldOpts {
  title: string;
  editable?: boolean;
  placeholder?: string;
  onEdit?: (text: string) => void;
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
      this.pending = debounce(() => opts.onEdit!(this.lastText === '' || this.lastText.endsWith('\n') ? this.lastText : this.lastText + '\n'), 300);
    }
  }

  flush(): void {
    this.pending?.flush();
  }

  update(vm: TextVM, marks: Mark[] = [], scrollTo?: number): void {
    const raw = textOf(this.id, vm);
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!this.box) {
      this.box = new TextBox(this.body, {
        editable: vm.editable && !!this.opts.editable,
        placeholder: this.opts.placeholder,
        wrap: wrapOn(this.kind),
        onRun: this.opts.onRun,
        onBlockedEdit: this.opts.onBlockedEdit,
        onChange: (t) => {
          this.lastText = t;
          this.pending?.();
        },
      });
    }
    this.box.setEditable(vm.editable && !!this.opts.editable);
    if (this.box.rev !== vm.rev) {
      if (!(this.box.focused && this.box.text === text)) this.box.setContent(text, vm.startLine);
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

  constructor(readonly key: string) {
    const grip = h('span', { class: 'grip', title: 'Drag to reorder' }, icon('gripper'));
    this.label = h('span', { class: 'case-label' });
    this.badge = h('span', { class: 'badge' });
    this.time = h('span', { class: 'time' });
    this.actions = h('span', { class: 'case-actions' });
    this.head = h('div', { class: 'case-head' }, grip, this.label, this.badge, this.time, this.actions);
    this.input = new Field(`${key}|in`, {
      title: 'Input',
      editable: true,
      placeholder: 'input',
      onEdit: (t) => send({ type: 'edit', key, field: 'in', text: t, file: currentFile }),
      onRun: () => send({ type: 'runCase', key }),
      onOpen: () => send({ type: 'open', key, field: 'in' }),
      onBlockedEdit: () => this.nudgeKeep(),
    });
    this.expected = new Field(`${key}|ans`, {
      title: 'Expected',
      editable: true,
      placeholder: 'expected output',
      onEdit: (t) => send({ type: 'edit', key, field: 'ans', text: t, file: currentFile }),
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
    this.label.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      persist();
      this.applyCollapsed();
    });
  }

  private applyCollapsed(): void {
    this.el.classList.toggle('collapsed', collapsed.has(this.key));
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
    this.el.className = `case origin-${vm.origin}${vm.pinned ? ' pinned' : ''}${vm.stress ? ' stress' : ''}`;
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
    this.el.classList.remove('collapsed');
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
    casesEl.append(h('div', { class: 'no-cases' }, 'No test cases yet. ', h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), send({ type: 'addCase' })) }, 'Add one'), s.importBtn.enabled ? ' or import the samples (Ctrl+Shift+I).' : '.'));
  }
}

// ---------------- header ----------------

function renderHeader(s: ViewState): void {
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
  );
  const row2 = h(
    'div',
    { class: 'btn-row' },
    btn(s.importBtn.label, 'cloud-download', () => send({ type: 'import' }), { title: s.importBtn.title || 'Import samples (Ctrl+Shift+I)', disabled: !s.importBtn.enabled, cls: 'grow' }),
    btn(s.submitBtn.label, 'cloud-upload', () => send({ type: 'submit' }), { title: s.submitBtn.title, disabled: !s.submitBtn.enabled, cls: 'grow' }),
  );
  hdr.replaceChildren(title, row1, row2);
  if (s.importBtn.note) hdr.append(h('div', { class: 'import-note' }, icon('info'), ' ', s.importBtn.note));
  if (p.verdict) {
    const v = p.verdict;
    const chip = h('div', { class: `verdict-line vs-${v.status}`, title: v.url ?? '' }, h('span', { class: 'dot' }), v.text);
    if (v.url) chip.addEventListener('click', () => send({ type: 'openUrl', url: v.url! }));
    hdr.append(chip);
  }
}

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

function renderSettings(s: ViewState): void {
  if (!s.problem || !s.ui.settingsOpen) {
    settingsEl.replaceChildren();
    settingsEl.hidden = true;
    return;
  }
  settingsEl.hidden = false;
  const p = s.problem;
  const st = p.settings;
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
    compareRow,
    typeRow,
    h('div', { class: 'row top' }, h('label', {}, 'Compile with'), cw),
    h('div', { class: 'row' }, h('label', {}, 'Time limit'), tl, h('span', { class: 'muted' }, 'ms')),
    h('div', { class: 'row' }, h('label', {}, ''), h('label', { class: 'check', title: 'Compile with judge-like flags (-O2, no sanitizers) to check tight time limits' }, jf, 'Judge flags (‑O2, no sanitizers)')),
  );
}

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
const stressEls: Record<'wa' | 're', HTMLDetailsElement> = { wa: h('details', { class: 'stress-sec' }), re: h('details', { class: 'stress-sec' }) };
footer.append(stressEls.wa, stressEls.re);
for (const mode of ['wa', 're'] as const) {
  stressEls[mode].addEventListener('toggle', () => {
    const open = stressEls[mode].open;
    if (state && state.stress[mode].open !== open) send({ type: 'stressOpen', mode, open });
  });
}
let shrinkDragging = false;

function renderStress(s: ViewState): void {
  footer.hidden = !s.file;
  for (const mode of ['wa', 're'] as const) {
    const sec = s.stress[mode];
    const el = stressEls[mode];
    if (el.open !== sec.open) el.open = sec.open;
    const runBtn = sec.running
      ? btn(null, 'debug-stop', () => send({ type: 'stressStop', mode }), { title: 'Stop', cls: 'tiny danger' })
      : btn(null, 'play', () => send({ type: 'stressRun', mode }), { title: sec.canRun ? 'Run' : (sec.disabled ?? sec.reason ?? ''), cls: 'tiny', disabled: !sec.canRun });
    const summary = h(
      'summary',
      {},
      icon('chevron-right'),
      h('span', { class: 'sec-title' }, mode === 'wa' ? 'Run WA stress' : 'Run RE stress'),
      sec.status ? h('span', { class: `chip st-${sec.status.state}` }, sec.status.state === 'running' || sec.status.state === 'compiling' || sec.status.state === 'shrinking' ? icon('loading codicon-modifier-spin') : '', ' ', shortStatus(sec)) : !sec.canRun && !sec.disabled ? h('span', { class: 'chip st-missing' }, 'not linked') : '',
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
        body.append(h('div', { class: `stress-status st-${sec.status.state}` }, sec.status.text));
        if (sec.status.detail) body.append(h('pre', { class: 'stress-detail' }, sec.status.detail));
      }
    }
    if (shrinkDragging && el.contains(document.activeElement)) continue;
    el.replaceChildren(summary, body);
  }
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

function slotRow(mode: 'wa' | 're', slot: SlotVM): HTMLElement {
  const opts: [string, string][] = [['', '—']];
  for (const f of slot.options) opts.push([f, f]);
  const sel = select(opts, slot.value, (v) => send({ type: 'stressPick', mode, role: slot.role, value: v }));
  sel.classList.toggle('auto', slot.auto && !!slot.value);
  sel.classList.toggle('missing', slot.missing);
  const row = h('div', { class: 'row' }, h('label', {}, slot.role), sel);
  if (slot.missing && slot.value && (slot.role === 'checker' || slot.role === 'judge')) row.append(h('span', { class: 'hint warn' }, 'not created yet'));
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
  if (currentFile && s.file?.path !== currentFile) for (const c of cards.values()) c.flush();
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
    const c = cards.get(m.key);
    if (c) {
      c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      c.el.classList.add('flash');
      setTimeout(() => c.el.classList.remove('flash'), 900);
      if (m.key.startsWith('s:')) c.focusInput();
    }
  }
});

window.addEventListener('blur', () => {
  for (const c of cards.values()) c.flush();
});

send({ type: 'ready' });
