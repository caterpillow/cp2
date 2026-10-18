// cp2-bridge: runs in the *local* extension host (the machine with the browser), even when the
// workspace is in WSL / SSH / a container. It owns ws://127.0.0.1:27122 for the browser
// extension and relays to cp2 through VS Code commands, which work across extension hosts.
//
// With several VS Code windows, the first one to bind the port is the leader; the others connect
// to it as peers. Icon-click imports go to the window that was focused last.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeEvent, BridgeState, BridgeToBrowser, BrowserRequest, BrowserToBridge, CMD_BRIDGE_ACK, CMD_BRIDGE_EVENT, CMD_BRIDGE_REQUEST, CMD_BRIDGE_SNIPPET, CMD_BRIDGE_STATE, DEFAULT_BRIDGE_PORT, FocusState } from '../../shared/protocol';
import { findSnippet } from './snippets';

type PeerToLeader =
  | { type: 'peerHello'; token: string; windowId: string; lastFocus: number }
  | { type: 'peerFocus'; lastFocus: number }
  | { type: 'peerRequest'; id: string; op: BrowserRequest['op']; args: unknown }
  | { type: 'peerAck'; requestId: string; ok: boolean; message: string };

type LeaderToPeer = { type: 'event'; ev: BridgeEvent } | { type: 'peerResponse'; id: string; ok: boolean; result?: unknown; error?: string };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const rid = () => crypto.randomBytes(8).toString('hex');

function tokenFile(): string {
  return path.join(os.homedir(), '.cp2-bridge', 'token');
}

function readToken(): string {
  const f = tokenFile();
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  } catch {
    /* create below */
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export class Bridge implements vscode.Disposable {
  private role: 'leader' | 'peer' | 'starting' = 'starting';
  private readonly windowId = rid();
  private lastFocus = vscode.window.state.focused ? Date.now() : 0;
  private connected = false;
  private focus: FocusState = { problem: null, contest: null };
  private token = readToken();
  private disposed = false;
  // leader
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private browsers: WebSocket[] = [];
  private peers = new Map<WebSocket, { windowId: string; lastFocus: number }>();
  private browserPending = new Map<string, Pending>();
  private iconRoutes = new Map<string, WebSocket | null>();
  private pingTimer: NodeJS.Timeout | null = null;
  // peer
  private leader: WebSocket | null = null;
  private leaderPending = new Map<string, Pending>();
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private ctx: vscode.ExtensionContext,
    private log: { appendLine(s: string): void },
    /** Delivers an event to cp2 in this window (overridable for tests). */
    private deliver: (ev: BridgeEvent) => void = (ev) => void vscode.commands.executeCommand(CMD_BRIDGE_EVENT, ev).then(undefined, () => undefined),
    private portOverride?: number,
  ) {}

  private port(): number {
    return this.portOverride ?? vscode.workspace.getConfiguration('cp2bridge').get<number>('port', DEFAULT_BRIDGE_PORT);
  }

  get isLeader(): boolean {
    return this.role === 'leader';
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.role = 'starting';
    try {
      await this.listen(this.port());
      this.role = 'leader';
      this.log.appendLine(`leader on 127.0.0.1:${this.port()}`);
      this.pingTimer = setInterval(() => this.browsers.forEach((b) => this.sendTo(b, { type: 'ping' })), 20000);
    } catch (e: any) {
      if (e?.code === 'EADDRINUSE') this.connectPeer();
      else {
        this.log.appendLine(`could not listen: ${e}`);
        this.later(5000);
      }
    }
  }

  private later(ms: number): void {
    if (this.retry || this.disposed) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, ms);
  }

  // ---------------- leader ----------------

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('cp2-bridge\n');
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
        this.wss.on('connection', (sock, req) => this.onConnection(sock, req));
        resolve();
      });
    });
  }

  private onConnection(sock: WebSocket, req: http.IncomingMessage): void {
    const origin = req.headers.origin ?? '';
    if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
      this.browsers.push(sock);
      sock.on('message', (data) => {
        try {
          this.onBrowser(sock, JSON.parse(String(data)) as BrowserToBridge);
        } catch (e) {
          this.log.appendLine(`bad browser message: ${e}`);
        }
      });
      sock.on('close', () => {
        this.browsers = this.browsers.filter((b) => b !== sock);
        if (!this.browsers.length) this.broadcast({ type: 'connection', connected: false });
      });
      sock.on('error', () => undefined);
      return;
    }
    if (origin) {
      // A web page trying to talk to us.
      sock.close(1008, 'forbidden');
      return;
    }
    const t = setTimeout(() => sock.close(1008, 'no hello'), 3000);
    sock.once('message', (data) => {
      clearTimeout(t);
      let m: PeerToLeader;
      try {
        m = JSON.parse(String(data));
      } catch {
        sock.close();
        return;
      }
      if (m.type !== 'peerHello' || m.token !== this.token) {
        sock.close(1008, 'bad token');
        return;
      }
      this.peers.set(sock, { windowId: m.windowId, lastFocus: m.lastFocus });
      this.sendTo(sock, { type: 'event', ev: { type: 'connection', connected: this.browsers.length > 0 } });
      this.sendTo(sock, { type: 'event', ev: { type: 'focus', focus: this.focus } });
      sock.on('message', (d) => {
        try {
          this.onPeer(sock, JSON.parse(String(d)) as PeerToLeader);
        } catch {
          /* ignore */
        }
      });
      sock.on('close', () => this.peers.delete(sock));
    });
    sock.on('error', () => undefined);
  }

  private sendTo(sock: WebSocket, m: BridgeToBrowser | LeaderToPeer | PeerToLeader): void {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
  }

  private onBrowser(sock: WebSocket, m: BrowserToBridge): void {
    switch (m.type) {
      case 'hello':
        this.browsers = [...this.browsers.filter((b) => b !== sock), sock];
        this.broadcast({ type: 'connection', connected: true });
        break;
      case 'focus':
        this.focus = m.focus;
        this.broadcast({ type: 'focus', focus: m.focus });
        break;
      case 'visit':
        this.broadcast({ type: 'visit', problem: m.problem });
        break;
      case 'verdict':
        this.broadcast({ type: 'verdict', update: m.update });
        break;
      case 'icon': {
        // Deliver to the most recently focused window only.
        let target: WebSocket | null = null;
        let best = this.lastFocus;
        for (const [p, info] of this.peers) {
          if (info.lastFocus > best) {
            best = info.lastFocus;
            target = p;
          }
        }
        this.iconRoutes.set(m.requestId, target);
        const ev: BridgeEvent = { type: 'icon', requestId: m.requestId, problem: m.problem, error: m.error };
        if (target) this.sendTo(target, { type: 'event', ev });
        else this.deliverLocal(ev);
        break;
      }
      case 'response': {
        const p = this.browserPending.get(m.id);
        if (!p) break;
        this.browserPending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? 'request failed'));
        break;
      }
      case 'pong':
        break;
    }
  }

  private onPeer(sock: WebSocket, m: PeerToLeader): void {
    const info = this.peers.get(sock);
    if (!info) return;
    if (m.type === 'peerFocus') info.lastFocus = m.lastFocus;
    else if (m.type === 'peerAck') this.ackBrowser(m.requestId, m.ok, m.message);
    else if (m.type === 'peerRequest') {
      this.requestBrowser(m.op, m.args).then(
        (result) => this.sendTo(sock, { type: 'peerResponse', id: m.id, ok: true, result }),
        (e: Error) => this.sendTo(sock, { type: 'peerResponse', id: m.id, ok: false, error: e.message }),
      );
    }
  }

  private broadcast(ev: BridgeEvent): void {
    this.deliverLocal(ev);
    for (const p of this.peers.keys()) this.sendTo(p, { type: 'event', ev });
  }

  private requestBrowser(op: BrowserRequest['op'], args: unknown): Promise<unknown> {
    const b = this.browsers[this.browsers.length - 1];
    if (!b) return Promise.reject(new Error('the browser extension is not connected'));
    const id = rid();
    const timeout = op === 'submit' ? 240000 : 40000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.browserPending.delete(id);
        reject(new Error(`the browser did not answer (${op})`));
      }, timeout);
      this.browserPending.set(id, { resolve, reject, timer });
      this.sendTo(b, { type: 'request', id, op, args } as BridgeToBrowser);
    });
  }

  private ackBrowser(requestId: string, ok: boolean, message: string): void {
    this.iconRoutes.delete(requestId);
    for (const b of this.browsers) this.sendTo(b, { type: 'ack', requestId, ok, message });
  }

  // ---------------- peer ----------------

  private connectPeer(): void {
    const sock = new WebSocket(`ws://127.0.0.1:${this.port()}/`);
    this.leader = sock;
    sock.on('open', () => {
      this.role = 'peer';
      this.log.appendLine('connected to the leader window');
      this.sendTo(sock, { type: 'peerHello', token: this.token, windowId: this.windowId, lastFocus: this.lastFocus });
    });
    sock.on('message', (data) => {
      let m: LeaderToPeer;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.type === 'event') this.deliverLocal(m.ev);
      else if (m.type === 'peerResponse') {
        const p = this.leaderPending.get(m.id);
        if (!p) return;
        this.leaderPending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? 'request failed'));
      }
    });
    sock.on('close', () => {
      if (this.leader !== sock) return;
      this.leader = null;
      for (const p of this.leaderPending.values()) p.reject(new Error('the bridge leader window closed'));
      this.leaderPending.clear();
      if (this.connected) this.deliverLocal({ type: 'connection', connected: false });
      // Whoever binds the port first becomes the next leader.
      this.later(150 + Math.random() * 600);
    });
    sock.on('error', () => undefined);
  }

  // ---------------- local window ----------------

  private deliverLocal(ev: BridgeEvent): void {
    if (ev.type === 'connection') this.connected = ev.connected;
    if (ev.type === 'focus') {
      this.focus = ev.focus;
      this.connected = true;
    }
    this.deliver(ev);
  }

  onWindowFocus(focused: boolean): void {
    if (!focused) return;
    this.lastFocus = Date.now();
    if (this.role === 'peer' && this.leader) this.sendTo(this.leader, { type: 'peerFocus', lastFocus: this.lastFocus });
  }

  request(op: BrowserRequest['op'], args: unknown): Promise<unknown> {
    if (this.role === 'leader') return this.requestBrowser(op, args);
    const leader = this.leader;
    if (!leader || leader.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cp2-bridge is still starting, try again'));
    const id = rid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.leaderPending.delete(id);
          reject(new Error(`the browser did not answer (${op})`));
        },
        op === 'submit' ? 250000 : 45000,
      );
      this.leaderPending.set(id, { resolve, reject, timer });
      this.sendTo(leader, { type: 'peerRequest', id, op, args });
    });
  }

  ack(requestId: string, ok: boolean, message: string): void {
    if (this.role === 'leader') this.ackBrowser(requestId, ok, message);
    else if (this.leader) this.sendTo(this.leader, { type: 'peerAck', requestId, ok, message });
  }

  state(): BridgeState {
    return { connected: this.role === 'leader' ? this.browsers.length > 0 : this.connected, focus: this.focus, leader: this.role === 'leader' };
  }

  async snippet(language: string, name: string): Promise<string | null> {
    const own = path.resolve(this.ctx.globalStorageUri.fsPath, '..', '..');
    const dirs = [own];
    const m = own.match(/^(.*[\\/]User)[\\/]profiles[\\/][^\\/]+$/);
    if (m) dirs.push(m[1]);
    return findSnippet(dirs, language, name);
  }

  describe(): string {
    const who = this.role === 'leader' ? `owns 127.0.0.1:${this.port()}` : this.role === 'peer' ? 'relaying through another VS Code window' : 'starting';
    const br = this.state().connected ? 'browser connected' : 'browser NOT connected';
    return `cp2-bridge: ${who}; ${br}${this.role === 'leader' ? `; ${this.peers.size} other window(s)` : ''}`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const p of [...this.browserPending.values(), ...this.leaderPending.values()]) {
      clearTimeout(p.timer);
      p.reject(new Error('cp2-bridge stopped'));
    }
    this.leader?.close();
    // ws doesn't close existing connections on close(): drop them so peers notice and take over.
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    this.server?.closeAllConnections?.();
    this.server?.close();
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('cp2 bridge');
  const bridge = new Bridge(ctx, log);
  ctx.subscriptions.push(
    log,
    bridge,
    vscode.window.onDidChangeWindowState((s) => bridge.onWindowFocus(s.focused)),
    vscode.commands.registerCommand(CMD_BRIDGE_REQUEST, (op: BrowserRequest['op'], args: unknown) => bridge.request(op, args)),
    vscode.commands.registerCommand(CMD_BRIDGE_STATE, () => bridge.state()),
    vscode.commands.registerCommand(CMD_BRIDGE_ACK, (requestId: string, ok: boolean, message: string) => bridge.ack(requestId, ok, message)),
    vscode.commands.registerCommand(CMD_BRIDGE_SNIPPET, (language: string, name: string) => bridge.snippet(language, name)),
    vscode.commands.registerCommand('cp2bridge.status', () => vscode.window.showInformationMessage(bridge.describe())),
  );
  void bridge.start();
}

export function deactivate(): void {
  /* disposables handle it */
}
