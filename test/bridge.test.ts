import assert from 'node:assert/strict';
import * as net from 'node:net';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { Bridge } from '../bridge/src/extension';
import type { BridgeEvent } from '../shared/protocol';
import { Uri } from './fakeVscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = { appendLine: () => undefined };
const ctx = { subscriptions: [], globalStorageUri: Uri.file('/tmp/cp2-test-gs/User/globalStorage/x') } as any;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

class FakeBrowser {
  ws!: WebSocket;
  got: any[] = [];
  constructor(
    private port: number,
    private origin = 'chrome-extension://abcdef',
  ) {}
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/`, { origin: this.origin });
      this.ws.on('open', () => {
        this.send({ type: 'hello', role: 'browser', version: 1 });
        resolve();
      });
      this.ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        this.got.push(m);
        if (m.type === 'request') {
          if (m.op === 'scrape') this.send({ type: 'response', id: m.id, ok: true, result: { name: 'A. X', from: 'browser' } });
          else this.send({ type: 'response', id: m.id, ok: false, error: 'nope' });
        }
      });
      this.ws.on('error', reject);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

describe('bridge', () => {
  it('relays between the browser and VS Code windows', async () => {
    const port = await freePort();
    const evA: BridgeEvent[] = [];
    const evB: BridgeEvent[] = [];
    const a = new Bridge(ctx, log, (e) => evA.push(e), port);
    await a.start();
    assert.equal(a.isLeader, true);
    const b = new Bridge(ctx, log, (e) => evB.push(e), port);
    await b.start();
    await sleep(200);
    assert.equal(b.isLeader, false, 'second window becomes a peer');

    const br = new FakeBrowser(port);
    await br.open();
    await sleep(100);
    assert.ok(evA.some((e) => e.type === 'connection' && e.connected));
    assert.ok(evB.some((e) => e.type === 'connection' && e.connected));

    // focus updates reach both windows
    br.send({ type: 'focus', focus: { problem: null, contest: { ref: { site: 'atcoder', contestId: 'abc400', url: '' }, name: 'ABC400', tasks: null, seenAt: 1 } } });
    await sleep(100);
    assert.ok(evA.some((e) => e.type === 'focus'));
    assert.ok(evB.some((e) => e.type === 'focus'));
    assert.equal(b.state().focus.contest?.name, 'ABC400');

    // requests from either window reach the browser
    assert.deepEqual(await a.request('scrape', {}), { name: 'A. X', from: 'browser' });
    assert.deepEqual(await b.request('scrape', {}), { name: 'A. X', from: 'browser' });
    await assert.rejects(b.request('tasks', { site: 'atcoder', contestId: 'x' }), /nope/);

    // icon imports go to the window focused last
    b.onWindowFocus(true);
    await sleep(50);
    br.send({ type: 'icon', requestId: 'r1', problem: null, error: 'x' });
    await sleep(100);
    assert.ok(evB.some((e) => e.type === 'icon' && e.requestId === 'r1'));
    assert.ok(!evA.some((e) => e.type === 'icon'));
    b.ack('r1', true, 'imported into a.cpp');
    await sleep(100);
    assert.ok(br.got.some((m) => m.type === 'ack' && m.requestId === 'r1' && m.ok && /a\.cpp/.test(m.message)));

    // web pages can't connect
    const evil = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: 'https://evil.example' });
    const closed = await new Promise<number>((r) => evil.on('close', (code) => r(code)));
    assert.equal(closed, 1008);

    // leader window closes: the peer takes over
    br.close();
    a.dispose();
    await sleep(1500);
    assert.equal(b.isLeader, true, 'peer became leader');
    const br2 = new FakeBrowser(port);
    await br2.open();
    await sleep(100);
    assert.deepEqual(await b.request('scrape', {}), { name: 'A. X', from: 'browser' });
    br2.close();
    b.dispose();
  });
});
