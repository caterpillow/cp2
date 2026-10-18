// The cp2 sidebar webview. Never takes focus away from the editor: it is only revealed with
// preserveFocus.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from '../../../shared/viewModel';
import type { Controller, Poster } from './controller';

export class Sidebar implements vscode.WebviewViewProvider, Poster {
  static readonly viewId = 'cp2.view';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly controller: Controller,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      this.controller.onMessage(m).catch((e) => this.controller.log(`message ${m.type} failed: ${(e as Error).stack ?? e}`));
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  reveal(): void {
    if (this.view && !this.view.visible) this.view.show(true);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f)).toString();
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `font-src ${webview.cspSource}`, `img-src ${webview.cspSource} data:`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
<title>cp2</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}
