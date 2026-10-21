// Reads cp2 settings, falling back to the old `cph.*` settings so nothing needs reconfiguring.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cp2Config, DEFAULT_CONTEST_FOLDERS, DEFAULT_FLAGS, DEFAULT_SUBMIT_LANGUAGES } from '../core/config';

/** Value explicitly set at any level (user, remote, workspace, folder), else undefined. */
function explicit<T>(section: string, key: string, scope?: vscode.Uri): T | undefined {
  const i = vscode.workspace.getConfiguration(section, scope).inspect<T>(key);
  if (!i) return undefined;
  return (i.workspaceFolderLanguageValue ?? i.workspaceFolderValue ?? i.workspaceLanguageValue ?? i.workspaceValue ?? i.globalLanguageValue ?? i.globalValue) as T | undefined;
}

function pick<T>(scope: vscode.Uri | undefined, key: string, legacyKey: string | null, def: T): T {
  const set = (x: unknown) => x !== undefined && x !== null && x !== '';
  const v = explicit<T>('cp2', key, scope);
  if (set(v)) return v as T;
  if (legacyKey) {
    const l = explicit<T>('cph', legacyKey, scope);
    if (set(l)) return l as T;
  }
  const d = vscode.workspace.getConfiguration('cp2', scope).get<T>(key);
  return set(d) ? (d as T) : def;
}

export function readConfig(scope?: vscode.Uri): Cp2Config {
  const editorCfg = vscode.workspace.getConfiguration('editor', { uri: scope, languageId: 'cpp' });
  return {
    cpp: {
      compiler: pick(scope, 'cpp.compiler', 'language.cpp.Command', 'g++'),
      flags: pick(scope, 'cpp.flags', 'language.cpp.Args', DEFAULT_FLAGS.cpp),
      judgeFlags: pick(scope, 'cpp.judgeFlags', null, DEFAULT_FLAGS.cppJudge),
    },
    c: {
      compiler: pick(scope, 'c.compiler', 'language.c.Command', 'gcc'),
      flags: pick(scope, 'c.flags', 'language.c.Args', DEFAULT_FLAGS.c),
      judgeFlags: pick(scope, 'c.judgeFlags', null, DEFAULT_FLAGS.cJudge),
    },
    python: {
      command: pick(scope, 'python.command', 'language.python.Command', process.platform === 'win32' ? 'python' : 'python3'),
      args: pick(scope, 'python.args', 'language.python.Args', ''),
    },
    timeLimitMs: pick(scope, 'timeLimitMs', 'general.timeOut', 3000) || 3000,
    stackMb: pick(scope, 'stackMb', null, 1024),
    outputLimitMb: pick(scope, 'outputLimitMb', null, 256),
    ignoreStderr: pick(scope, 'ignoreStderr', 'general.ignoreSTDERROR', true),
    runConcurrency: pick(scope, 'runConcurrency', null, 4),
    pch: {
      enabled: pick(scope, 'precompiledHeaders.enabled', null, true),
      headers: pick(scope, 'precompiledHeaders.headers', null, ['bits/extc++.h', 'bits/stdc++.h']),
    },
    stress: {
      waFlags: pick(scope, 'stress.waFlags', null, DEFAULT_FLAGS.stressWA),
      reFlags: pick(scope, 'stress.reFlags', null, DEFAULT_FLAGS.stressRE),
      workers: pick(scope, 'stress.workers', null, 8),
      maxIterations: pick(scope, 'stress.maxIterations', null, 10000),
      helperTimeoutMs: pick(scope, 'stress.helperTimeoutMs', null, 10000),
      genTemplate: pick(scope, 'stress.genTemplate', null, 'templates/templategen.cpp'),
      shrinkSeconds: pick(scope, 'stress.shrinkSeconds', null, 0.5),
    },
    helperFlags: pick(scope, 'helperFlags', null, DEFAULT_FLAGS.helper),
    inlineBytes: pick(scope, 'inlineKb', null, 1024) * 1024,
    newFile: {
      snippet: pick(scope, 'newFile.snippet', null, 'tmpcf'),
      language: pick(scope, 'newFile.snippetLanguage', null, 'cpp'),
      extension: pick(scope, 'newFile.extension', null, '.cpp'),
      tabSize: editorCfg.get<number>('tabSize', 4),
      insertSpaces: editorCfg.get<boolean>('insertSpaces', true),
    },
    contestFolders: { ...DEFAULT_CONTEST_FOLDERS, ...pick(scope, 'contest.folders', null, {} as Record<string, string>) },
    submitLanguages: { ...DEFAULT_SUBMIT_LANGUAGES, ...pick(scope, 'submit.languages', null, {} as Record<string, Record<string, string[]>>) },
    cacheDir: pick(scope, 'cacheDir', null, '') || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'cp2'),
  };
}

export function legacySaveLocation(scope?: vscode.Uri): string | undefined {
  const v = explicit<string>('cph', 'general.saveLocation', scope);
  return v ? v : undefined;
}
