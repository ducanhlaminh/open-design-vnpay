// @vitest-environment node

import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  expectLinuxRemovedStatus,
  expectPathInside,
  linuxUserHome,
  pathExists,
} from '../lib/linux-helpers.js';

const execFileAsync = promisify(execFile);
const e2eRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(e2eRoot);
const toolsPackDir = resolveFromWorkspace(process.env.OD_PACKAGED_E2E_TOOLS_PACK_DIR ?? '.tmp/tools-pack');
const namespace = process.env.OD_PACKAGED_E2E_NAMESPACE ?? 'ci-pr-linux';
const toolsPackBin = join(workspaceRoot, 'tools', 'pack', 'bin', 'tools-pack.mjs');
const shouldRunLinuxHeadlessSmoke =
  process.platform === 'linux' && process.env.OD_PACKAGED_E2E_LINUX_HEADLESS === '1';
const linuxHeadlessDescribe = shouldRunLinuxHeadlessSmoke ? describe : describe.skip;

// WP5 (web-first migration): this spec used to also run a
// `linuxAppImageDescribe` block gated on OD_PACKAGED_E2E_LINUX_APPIMAGE=1
// that installed/started the electron-builder-built AppImage and inspected
// it with `--expr`/`--path` (EVAL/SCREENSHOT sidecar IPC). `apps/desktop`,
// electron-builder, and the EVAL/SCREENSHOT verbs are all gone —
// `tools-pack linux install/start` can no longer produce a running AppImage
// desktop process at all — so that block (and its now-inapplicable
// LinuxAppImage*/HealthEvalValue helper types and waitForHealthyAppImageDesktop
// /assertLogPathsAndContent/fileSizeBytes helpers) was removed. Only the
// headless lifecycle smoke — the one WP6 depends on — stays.

const runtimeNamespaceRoot = join(toolsPackDir, 'runtime', 'linux', 'namespaces', namespace);
const userHome = linuxUserHome();

type LinuxHeadlessInstallResult = {
  launcherPath: string;
  namespace: string;
};

type LinuxHeadlessStartResult = {
  launcherPath: string;
  logPath: string;
  namespace: string;
  pid: number;
  status: {
    namespace: string;
    pid: number;
    startedAt: string;
    url: string;
    version: 1;
  };
};

type LinuxInspectResult = {
  status: {
    pid?: number;
    state?: string;
    url?: string | null;
  } | null;
};

type LinuxStopResult = {
  namespace: string;
  remainingPids: number[];
  status: string;
};

type LinuxHeadlessUninstallResult = {
  launcherPath: string;
  namespace: string;
  removed: string;
  stop: LinuxStopResult;
};

type LinuxCleanupResult = {
  skipped: boolean;
};

type LogsResult = {
  logs: Record<string, { lines: string[]; logPath: string }>;
  namespace: string;
};

linuxHeadlessDescribe('packaged linux headless runtime smoke', () => {
  let installed = false;
  let started = false;

  test('installs, starts, inspects status, logs, stops, uninstalls, and cleans up headless runtime', async () => {
    let passed = false;
    try {
      const install = await runToolsPackJson<LinuxHeadlessInstallResult>('install', ['--headless']);
      installed = true;
      expect(install.namespace).toBe(namespace);
      expectPathInside(install.launcherPath, join(userHome, '.local', 'bin'));
      expect(await pathExists(install.launcherPath)).toBe(true);

      const start = await runToolsPackJson<LinuxHeadlessStartResult>('start', ['--headless']);
      started = true;
      expect(start.namespace).toBe(namespace);
      expect(start.pid).toBeGreaterThan(0);
      expect(start.status.namespace).toBe(namespace);
      expect(start.status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
      expectPathInside(start.logPath, join(runtimeNamespaceRoot, 'logs', 'desktop'));

      const inspect = await runToolsPackJson<LinuxInspectResult>('inspect', ['--headless']);
      expect(inspect.status?.state).toBe('running');
      expect(inspect.status?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);

      const logs = await runToolsPackJson<LogsResult>('logs');
      expect(logs.namespace).toBe(namespace);
      const desktopLog = logs.logs.desktop;
      if (desktopLog == null) {
        throw new Error('expected desktop log entry');
      }
      expectPathInside(desktopLog.logPath, join(runtimeNamespaceRoot, 'logs', 'desktop'));
      expect(desktopLog.lines.join('\n')).toContain('Open Design is running');

      const stop = await runToolsPackJson<LinuxStopResult>('stop', ['--headless']);
      started = false;
      expect(stop.namespace).toBe(namespace);
      expect(stop.status).not.toBe('partial');
      expect(stop.remainingPids).toEqual([]);

      const uninstall = await runToolsPackJson<LinuxHeadlessUninstallResult>('uninstall', ['--headless']);
      installed = false;
      expect(uninstall.namespace).toBe(namespace);
      expectLinuxRemovedStatus('headless launcher', uninstall.removed);
      expect(await pathExists(install.launcherPath)).toBe(false);

      const cleanup = await runToolsPackJson<LinuxCleanupResult>('cleanup', ['--headless']);
      expect(cleanup.skipped).toBe(false);
      passed = true;
    } finally {
      if (!passed) {
        await printPackagedLogs().catch((error: unknown) => {
          console.error('failed to read packaged linux logs after failure', error);
        });
      }
      if (started || installed) {
        await runToolsPackJson<LinuxHeadlessUninstallResult>('uninstall', ['--headless']).catch((error: unknown) => {
          console.error('failed to uninstall packaged linux headless runtime during cleanup', error);
        });
        started = false;
        installed = false;
      }
    }
  }, 180_000);
});

async function runToolsPackJson<T>(action: string, extraArgs: string[] = []): Promise<T> {
  const args = [
    toolsPackBin,
    'linux',
    action,
    '--dir',
    toolsPackDir,
    '--namespace',
    namespace,
    '--json',
    ...extraArgs,
  ];
  const result = await execFileAsync(process.execPath, args, {
    cwd: workspaceRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  }).catch((error: unknown) => {
    if (isExecError(error)) {
      throw new Error(
        [
          `tools-pack linux ${action} failed`,
          `message:\n${error.message}`,
          `stdout:\n${error.stdout}`,
          `stderr:\n${error.stderr}`,
        ].join('\n'),
      );
    }
    throw error;
  });

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`tools-pack linux ${action} did not print JSON: ${String(error)}\n${result.stdout}`);
  }
}

async function printPackagedLogs(): Promise<void> {
  const result = await runToolsPackJson<LogsResult>('logs');
  for (const [app, entry] of Object.entries(result.logs)) {
    console.error(`[${app}] ${entry.logPath}`);
    console.error(entry.lines.join('\n') || '(no log lines)');
  }
}

function resolveFromWorkspace(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath);
}

type ExecError = Error & {
  stderr?: string;
  stdout?: string;
};

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ('stderr' in error || 'stdout' in error);
}
