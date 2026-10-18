import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isSourceFile } from './core/lang';
import { Controller } from './host/controller';
import { Integrations } from './host/integrations';
import { Sidebar } from './host/sidebar';
import { StressHost } from './host/stressHost';

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const c = new Controller(context);
  controller = c;
  c.stress = new StressHost(c);
  const sidebar = new Sidebar(context, c);
  c.poster = sidebar;
  const integrations = new Integrations(c, context);
  c.extras = integrations;
  context.subscriptions.push(c, integrations, vscode.window.registerWebviewViewProvider(Sidebar.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }));

  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          c.log(`${id} failed: ${(e as Error).stack ?? e}`);
          void vscode.window.showErrorMessage(`cp2: ${(e as Error).message ?? e}`);
        }
      }),
    );
  const activeOrWarn = (): string | null => {
    if (!c.active) void vscode.window.showInformationMessage('cp2: open a C++, C or Python file first');
    return c.active;
  };
  reg('cp2.runAll', () => c.runAll());
  reg('cp2.addCase', () => c.onMessage({ type: 'addCase' }));
  reg('cp2.stop', () => c.stop());
  reg('cp2.import', () => {
    const f = activeOrWarn();
    return f && integrations.doImport(f);
  });
  reg('cp2.submit', () => {
    const f = activeOrWarn();
    return f && integrations.doSubmit(f);
  });
  for (const [cmd, type, mode] of [
    ['cp2.stressSetupWA', 'stressSetup', 'wa'],
    ['cp2.stressSetupRE', 'stressSetup', 're'],
    ['cp2.runWAStress', 'stressRun', 'wa'],
    ['cp2.runREStress', 'stressRun', 're'],
  ] as const) {
    reg(cmd, () => {
      const f = activeOrWarn();
      return f && c.stress.onMessage(f, { type, mode });
    });
  }
  reg('cp2.writeContest', (uri?: vscode.Uri) => integrations.writeContest(uri, false));
  reg('cp2.writeContestHere', (uri?: vscode.Uri) => integrations.writeContest(uri, true));
  reg('cp2.showLog', () => c.output.show(true));
  reg('cp2.clearBuildCache', async () => {
    for (const s of c.locator.allStores()) await fsp.rm(s.buildRoot, { recursive: true, force: true });
    await fsp.rm(path.join(c.cfg().cacheDir, 'pch'), { recursive: true, force: true });
    void vscode.window.showInformationMessage('cp2: build cache cleared');
  });

  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file' && isSourceFile(ed.document.uri.fsPath)) void c.setActive(ed.document.uri.fsPath, ed);
}

export function deactivate(): void {
  controller?.stress?.stopAll();
}
