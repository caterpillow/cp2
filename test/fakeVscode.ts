// A small stand-in for the `vscode` module so the extension host code can be driven from node
// tests. Only what cp2 uses is implemented; behaviour is controllable through `fake`.

import * as fs from 'node:fs';
import * as path from 'node:path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private ls: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.ls.push(l);
    return { dispose: () => (this.ls = this.ls.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of [...this.ls]) l(e);
  }
  dispose() {
    this.ls = [];
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}
  static file(p: string) {
    return new Uri('file', path.resolve(p));
  }
  static parse(s: string) {
    return new Uri(s.split(':')[0], s);
  }
  static joinPath(u: Uri, ...parts: string[]) {
    return Uri.file(path.join(u.fsPath, ...parts));
  }
  toString() {
    return this.scheme === 'file' ? `file://${this.fsPath}` : this.fsPath;
  }
  get path() {
    return this.fsPath;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Selection {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {}
}
export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
export class RelativePattern {
  constructor(
    readonly base: Uri | string,
    readonly pattern: string,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class FileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {}
}
export class MarkdownString {
  constructor(readonly value = '') {}
}
export class WorkspaceEdit {
  renames: { from: Uri; to: Uri }[] = [];
  renameFile(from: Uri, to: Uri) {
    this.renames.push({ from, to });
  }
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

// ---------------- controllable state ----------------

export const fake = {
  workspaceRoots: [] as string[],
  config: {} as Record<string, unknown>,
  messages: [] as { kind: string; text: string; items?: string[] }[],
  quickPick: (items: any[]) => items[0] as any,
  warningAnswer: undefined as string | undefined,
  commands: new Map<string, (...a: any[]) => any>(),
  executed: [] as { id: string; args: any[] }[],
  opened: [] as string[],
  watchers: [] as { dir: string; create: EventEmitter<Uri>; change: EventEmitter<Uri>; del: EventEmitter<Uri> }[],
  statusText: '',
  statusBar: {} as Record<string, string>,
  decorationProviders: [] as any[],
  activeEditor: undefined as any,
  reset() {
    this.messages = [];
    this.executed = [];
    this.opened = [];
  },
  /** Simulates a file change seen by VS Code's watcher. */
  touch(file: string, kind: 'create' | 'change' | 'delete') {
    for (const w of this.watchers) if (w.dir === path.dirname(file)) (kind === 'create' ? w.create : kind === 'change' ? w.change : w.del).fire(Uri.file(file));
  },
};

const onRename = new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>();
const onEditor = new EventEmitter<any>();

function cfgGet(section: string, key: string) {
  return fake.config[`${section}.${key}`];
}

export const workspace = {
  get workspaceFolders() {
    return fake.workspaceRoots.map((r, i) => ({ uri: Uri.file(r), name: path.basename(r), index: i }));
  },
  name: 'test',
  textDocuments: [] as any[],
  getConfiguration(section: string) {
    return {
      get<T>(key: string, def?: T): T | undefined {
        const v = cfgGet(section, key);
        return (v === undefined ? def : v) as T | undefined;
      },
      inspect<T>(key: string) {
        const v = cfgGet(section, key) as T | undefined;
        return { key, globalValue: v };
      },
    };
  },
  onDidChangeConfiguration: () => ({ dispose() {} }),
  onDidSaveTextDocument: () => ({ dispose() {} }),
  onDidRenameFiles: onRename.event,
  createFileSystemWatcher(p: RelativePattern) {
    const w = { dir: typeof p.base === 'string' ? p.base : p.base.fsPath, create: new EventEmitter<Uri>(), change: new EventEmitter<Uri>(), del: new EventEmitter<Uri>() };
    fake.watchers.push(w);
    return { onDidCreate: w.create.event, onDidChange: w.change.event, onDidDelete: w.del.event, dispose() {} };
  },
  async applyEdit(e: WorkspaceEdit) {
    for (const r of e.renames) {
      fs.mkdirSync(path.dirname(r.to.fsPath), { recursive: true });
      fs.renameSync(r.from.fsPath, r.to.fsPath);
    }
    setTimeout(() => onRename.fire({ files: e.renames.map((r) => ({ oldUri: r.from, newUri: r.to })) }), 5);
    return true;
  },
  asRelativePath(p: string) {
    const root = fake.workspaceRoots[0];
    return root ? path.relative(root, p).split(path.sep).join('/') : p;
  },
};

function msg(kind: string) {
  return async (text: string, ...rest: any[]) => {
    const items = rest.filter((x) => typeof x === 'string');
    fake.messages.push({ kind, text, items });
    return kind === 'warning' ? fake.warningAnswer : undefined;
  };
}

export const window = {
  createOutputChannel: () => ({ appendLine: (s: string) => process.env.CP2_TEST_LOG && console.log(s), show() {}, dispose() {} }),
  onDidChangeActiveTextEditor: onEditor.event,
  onDidChangeWindowState: () => ({ dispose() {} }),
  state: { focused: true },
  get activeTextEditor() {
    return fake.activeEditor;
  },
  showInformationMessage: msg('info'),
  showWarningMessage: msg('warning'),
  showErrorMessage: msg('error'),
  setStatusBarMessage: (t: string) => {
    fake.messages.push({ kind: 'status', text: t });
    return { dispose() {} };
  },
  async showTextDocument(u: Uri) {
    fake.opened.push(u.fsPath);
    return { document: { uri: u, lineCount: 1000 }, selection: undefined, revealRange() {} };
  },
  async showQuickPick(items: any[]) {
    return fake.quickPick(items);
  },
  async showOpenDialog() {
    return undefined;
  },
  async withProgress(_o: unknown, fn: () => Promise<unknown>) {
    return fn();
  },
  createStatusBarItem: (id?: string) => ({
    set text(t: string) {
      fake.statusBar[id ?? ''] = t;
      if (id === 'cp2.contest') fake.statusText = t;
    },
    get text() {
      return fake.statusBar[id ?? ''] ?? '';
    },
    tooltip: undefined as unknown,
    command: undefined as unknown,
    name: '',
    show() {},
    hide() {},
    dispose() {},
  }),
  registerFileDecorationProvider(p: any) {
    fake.decorationProviders.push(p);
    return { dispose() {} };
  },
  registerWebviewViewProvider: () => ({ dispose() {} }),
};

export const commands = {
  registerCommand(id: string, fn: (...a: any[]) => any) {
    fake.commands.set(id, fn);
    return { dispose: () => fake.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: any[]) {
    fake.executed.push({ id, args });
    const fn = fake.commands.get(id);
    if (!fn) {
      if (id === 'setContext' || id === 'vscode.diff') return undefined;
      throw new Error(`command '${id}' not found`);
    }
    return fn(...args);
  },
};

export const clipboardState = { text: '' };
export const env = { openExternal: async () => true, clipboard: { readText: async () => clipboardState.text, writeText: async (t: string) => void (clipboardState.text = t) } };
