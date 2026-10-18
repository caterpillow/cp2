// Cached folder listings with file watchers, so new / changed / deleted text files show up as
// test cases immediately.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileCaseMatch, matchFileCases } from '../core/fileCases';

export interface DirListing {
  dir: string;
  /** Regular files only. */
  files: string[];
  matches: FileCaseMatch[];
}

export interface DirChange {
  dir: string;
  /** Names that changed (content or existence). */
  names: Set<string>;
  /** Files appeared or disappeared (listing changed). */
  structural: boolean;
}

export class DirIndex implements vscode.Disposable {
  private listings = new Map<string, Promise<DirListing>>();
  private watchers = new Map<string, vscode.FileSystemWatcher>();
  private lru: string[] = [];
  private emitter = new vscode.EventEmitter<DirChange>();
  readonly onDidChange = this.emitter.event;
  private pending = new Map<string, DirChange>();
  private flushTimer: NodeJS.Timeout | undefined;
  /** Writes we made ourselves (sidebar edits) don't need to bounce back. */
  private ownWrites = new Map<string, number>();

  get(dir: string): Promise<DirListing> {
    this.touch(dir);
    let l = this.listings.get(dir);
    if (!l) {
      l = this.read(dir);
      this.listings.set(dir, l);
    }
    return l;
  }

  noteOwnWrite(file: string): void {
    this.ownWrites.set(file, Date.now());
  }

  private async read(dir: string): Promise<DirListing> {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      /* missing folder */
    }
    const files = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
    return { dir, files, matches: matchFileCases(files) };
  }

  private touch(dir: string): void {
    this.lru = [dir, ...this.lru.filter((d) => d !== dir)];
    if (!this.watchers.has(dir)) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
      w.onDidCreate((u) => this.queue(dir, u, true));
      w.onDidDelete((u) => this.queue(dir, u, true));
      w.onDidChange((u) => this.queue(dir, u, false));
      this.watchers.set(dir, w);
    }
    while (this.lru.length > 24) {
      const old = this.lru.pop()!;
      this.watchers.get(old)?.dispose();
      this.watchers.delete(old);
      this.listings.delete(old);
    }
  }

  private queue(dir: string, uri: vscode.Uri, structural: boolean): void {
    const name = path.basename(uri.fsPath);
    if (!structural) {
      const own = this.ownWrites.get(uri.fsPath);
      if (own && Date.now() - own < 1500) return;
    }
    if (structural) this.listings.delete(dir);
    const c = this.pending.get(dir) ?? { dir, names: new Set<string>(), structural: false };
    c.names.add(name);
    c.structural ||= structural;
    this.pending.set(dir, c);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const all = [...this.pending.values()];
        this.pending.clear();
        for (const ch of all) this.emitter.fire(ch);
      }, 60);
    }
  }

  /** Forget a listing (after we created/removed files ourselves). */
  invalidate(dir: string): void {
    this.listings.delete(dir);
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.emitter.dispose();
  }
}
