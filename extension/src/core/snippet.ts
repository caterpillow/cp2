// Turns a VS Code snippet body into plain text (the result of inserting it and accepting every
// default), plus the position of $0 so the file can open with the cursor there.

export interface ResolvedSnippet {
  text: string;
  cursor: { line: number; character: number } | null;
}

export interface SnippetOptions {
  vars?: Record<string, string>;
  insertSpaces?: boolean;
  tabSize?: number;
}

type Node = { kind: 'text'; value: string } | { kind: 'tab'; n: number; children: Node[] | null } | { kind: 'choice'; n: number; first: string } | { kind: 'var'; name: string; children: Node[] | null };

class Parser {
  i = 0;
  constructor(private s: string) {}

  parse(stop?: string): Node[] {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ kind: 'text', value: text });
      text = '';
    };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '\\' && this.i + 1 < this.s.length && '$}\\'.includes(this.s[this.i + 1])) {
        text += this.s[this.i + 1];
        this.i += 2;
        continue;
      }
      if (stop && c === stop) break;
      if (c === '$') {
        const node = this.dollar();
        if (node) {
          flush();
          out.push(node);
          continue;
        }
      }
      text += c;
      this.i++;
    }
    flush();
    return out;
  }

  private dollar(): Node | null {
    const s = this.s;
    const start = this.i;
    this.i++;
    let m = /^\d+/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { kind: 'tab', n: Number(m[0]), children: null };
    }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { kind: 'var', name: m[0], children: null };
    }
    if (s[this.i] === '{') {
      this.i++;
      m = /^\d+/.exec(s.slice(this.i));
      if (m) {
        const n = Number(m[0]);
        this.i += m[0].length;
        if (s[this.i] === '}') {
          this.i++;
          return { kind: 'tab', n, children: null };
        }
        if (s[this.i] === ':') {
          this.i++;
          const children = this.parse('}');
          this.i++;
          return { kind: 'tab', n, children };
        }
        if (s[this.i] === '|') {
          const end = s.indexOf('|}', this.i + 1);
          if (end > 0) {
            const opts = s.slice(this.i + 1, end).split(/(?<!\\),/);
            this.i = end + 2;
            return { kind: 'choice', n, first: (opts[0] ?? '').replace(/\\(.)/g, '$1') };
          }
        }
      }
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i));
      if (m) {
        const name = m[0];
        this.i += name.length;
        if (s[this.i] === '}') {
          this.i++;
          return { kind: 'var', name, children: null };
        }
        if (s[this.i] === ':') {
          this.i++;
          const children = this.parse('}');
          this.i++;
          return { kind: 'var', name, children };
        }
        if (s[this.i] === '/') {
          // ${VAR/regex/format/flags}: keep the variable's value.
          let depth = 0;
          while (this.i < s.length) {
            if (s[this.i] === '\\') this.i += 2;
            else if (s[this.i] === '{') depth++, this.i++;
            else if (s[this.i] === '}') {
              if (depth === 0) break;
              depth--;
              this.i++;
            } else this.i++;
          }
          this.i++;
          return { kind: 'var', name, children: null };
        }
      }
    }
    this.i = start;
    return null;
  }
}

export function resolveSnippet(body: string, opts: SnippetOptions = {}): ResolvedSnippet {
  const nodes = new Parser(body).parse();
  const defaults = new Map<number, string>();
  let out = '';
  let cursorAt = -1;
  let firstTabAt = -1;
  const vars = opts.vars ?? {};
  const emit = (ns: Node[]) => {
    for (const n of ns) {
      if (n.kind === 'text') out += n.value;
      else if (n.kind === 'choice') {
        if (firstTabAt < 0) firstTabAt = out.length;
        out += n.first;
      } else if (n.kind === 'tab') {
        if (n.n === 0 && cursorAt < 0) cursorAt = out.length;
        if (n.n !== 0 && firstTabAt < 0) firstTabAt = out.length;
        if (n.children) {
          const before = out.length;
          emit(n.children);
          if (!defaults.has(n.n)) defaults.set(n.n, out.slice(before));
        } else if (defaults.has(n.n)) out += defaults.get(n.n);
      } else {
        const v = vars[n.name];
        if (v !== undefined) out += v;
        else if (n.children) emit(n.children);
      }
    }
  };
  emit(nodes);
  let pos = cursorAt >= 0 ? cursorAt : firstTabAt;

  if (opts.insertSpaces !== false) {
    const unit = ' '.repeat(opts.tabSize ?? 4);
    let rebuilt = '';
    let newPos = pos;
    let idx = 0;
    for (const line of out.split('\n')) {
      const lead = /^\t*/.exec(line)![0].length;
      const conv = unit.repeat(lead) + line.slice(lead);
      if (pos >= 0 && pos >= idx && pos <= idx + line.length) {
        const col = pos - idx;
        const extra = Math.min(col, lead) * (unit.length - 1);
        newPos = rebuilt.length + col + extra;
      }
      rebuilt += conv + '\n';
      idx += line.length + 1;
    }
    out = rebuilt.slice(0, -1);
    pos = newPos;
  }

  let cursor: ResolvedSnippet['cursor'] = null;
  if (pos >= 0) {
    const before = out.slice(0, pos);
    const line = before.split('\n').length - 1;
    cursor = { line, character: pos - (before.lastIndexOf('\n') + 1) };
  }
  if (!out.endsWith('\n')) out += '\n';
  return { text: out, cursor };
}

/** Standard snippet variables for a file being created. */
export function snippetVars(filePath: string, workspaceName = ''): Record<string, string> {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    TM_FILENAME: base,
    TM_FILENAME_BASE: dot > 0 ? base.slice(0, dot) : base,
    TM_FILEPATH: filePath,
    TM_DIRECTORY: filePath.slice(0, filePath.length - base.length - 1),
    TM_SELECTED_TEXT: '',
    TM_CURRENT_LINE: '',
    TM_LINE_INDEX: '0',
    TM_LINE_NUMBER: '1',
    WORKSPACE_NAME: workspaceName,
    CURRENT_YEAR: String(d.getFullYear()),
    CURRENT_YEAR_SHORT: String(d.getFullYear()).slice(2),
    CURRENT_MONTH: p2(d.getMonth() + 1),
    CURRENT_DATE: p2(d.getDate()),
    CURRENT_HOUR: p2(d.getHours()),
    CURRENT_MINUTE: p2(d.getMinutes()),
    CURRENT_SECOND: p2(d.getSeconds()),
    CURRENT_SECONDS_UNIX: String(Math.floor(d.getTime() / 1000)),
    UUID: '',
    RANDOM: String(Math.floor(Math.random() * 1e6)).padStart(6, '0'),
    RANDOM_HEX: Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0'),
    BLOCK_COMMENT_START: '/*',
    BLOCK_COMMENT_END: '*/',
    LINE_COMMENT: '//',
  };
}
