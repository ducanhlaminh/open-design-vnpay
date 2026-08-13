import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));

describe('sandbox CLI', () => {
  it('prints runtimeStatuses from od sandbox status --json', async () => {
    const server = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        enabled: true,
        runtimes: ['claude', 'codex'],
        skills: ['*'],
        timeoutMinutes: 30,
        dockerOk: true,
        image: 'od-agent-sandbox:test',
        imageOk: true,
        claudeVersion: '1.0.0',
        authVolumeOk: true,
        authLoggedIn: true,
        runtimeStatuses: [
          {
            id: 'claude',
            version: '1.0.0',
            imageAvailable: true,
            authVolume: 'od-claude-auth',
            authVolumeAvailable: true,
            authStatus: 'logged-in',
            loginMethod: 'interactive',
          },
          {
            id: 'codex',
            version: '0.142.0',
            imageAvailable: true,
            authVolume: 'od-codex-auth',
            authVolumeAvailable: true,
            authStatus: 'missing',
            loginMethod: 'device',
          },
        ],
        activeContainers: [],
        builderDir: '/tmp/builder',
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server failed to bind');
      const base = `http://127.0.0.1:${address.port}`;
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'sandbox', 'status', '--json', '--daemon-url', base],
        {
          cwd: daemonRoot,
        },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.runtimeStatuses).toHaveLength(2);
      expect(parsed.runtimeStatuses[1]).toMatchObject({ id: 'codex', loginMethod: 'device' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('routes codex login/logout through the new daemon endpoints', async () => {
    const state = {
      loginStarts: 0,
      polls: 0,
      logoutCalls: 0,
    };
    const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/sandbox/status') {
        res.end(JSON.stringify({
          enabled: true,
          runtimes: ['claude', 'codex'],
          skills: ['*'],
          timeoutMinutes: 30,
          dockerOk: true,
          image: 'od-agent-sandbox:test',
          imageOk: true,
          claudeVersion: '1.0.0',
          authVolumeOk: true,
          authLoggedIn: true,
          runtimeStatuses: [
            {
              id: 'claude',
              version: '1.0.0',
              imageAvailable: true,
              authVolume: 'od-claude-auth',
              authVolumeAvailable: true,
              authStatus: 'logged-in',
              loginMethod: 'interactive',
            },
            {
              id: 'codex',
              version: '0.142.0',
              imageAvailable: true,
              authVolume: 'od-codex-auth',
              authVolumeAvailable: true,
              authStatus: 'missing',
              loginMethod: 'device',
            },
          ],
          activeContainers: [],
          builderDir: '/tmp/builder',
        }));
        return;
      }
      if (url.pathname === '/api/sandbox/codex-login' && req.method === 'POST') {
        state.loginStarts += 1;
        res.end(JSON.stringify({
          phase: 'starting',
          url: 'https://auth.openai.com/codex/device',
          code: 'ABCD-1234',
          expiresAt: null,
          error: null,
        }));
        return;
      }
      if (url.pathname === '/api/sandbox/codex-login' && req.method === 'GET') {
        state.polls += 1;
        res.end(JSON.stringify(
          state.polls < 2
            ? {
                phase: 'awaiting-user',
                url: 'https://auth.openai.com/codex/device',
                code: 'ABCD-1234',
                expiresAt: null,
                error: null,
              }
            : {
                phase: 'done',
                url: 'https://auth.openai.com/codex/device',
                code: 'ABCD-1234',
                expiresAt: null,
                error: null,
              },
        ));
        return;
      }
      if (url.pathname === '/api/sandbox/codex-logout' && req.method === 'POST') {
        state.logoutCalls += 1;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server failed to bind');
      const base = `http://127.0.0.1:${address.port}`;
      const login = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'sandbox', 'login', '--runtime', 'codex', '--daemon-url', base],
        { cwd: daemonRoot },
      );
      expect(login.stdout).toContain('Codex device login complete.');
      expect(state.loginStarts).toBe(1);
      expect(state.polls).toBeGreaterThanOrEqual(1);

      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'sandbox', 'logout', '--yes', '--runtime', 'codex', '--daemon-url', base],
        { cwd: daemonRoot },
      );
      expect(state.logoutCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // WP4 (web-first migration): Docker-only sandbox subcommands refuse to
  // touch `docker` at all while the daemon reports host mode (`enabled:
  // false`), instead of failing into a confusing Docker error.
  it('refuses Docker-only subcommands with a clear message when the daemon is in host mode', async () => {
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/sandbox/status') {
        res.end(JSON.stringify({
          enabled: false,
          mode: 'host',
          runtimes: ['claude', 'codex'],
          skills: ['*'],
          timeoutMinutes: 30,
          dockerOk: false,
          image: 'od-agent-sandbox:test',
          imageOk: false,
          claudeVersion: null,
          authVolumeOk: false,
          authLoggedIn: null,
          runtimeStatuses: [],
          activeContainers: [],
          builderDir: '/tmp/builder',
          hostClaude: { available: true, authStatus: 'ok' },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server failed to bind');
      const base = `http://127.0.0.1:${address.port}`;
      await expect(
        execFileAsync(
          process.execPath,
          ['--import', 'tsx', cliEntry, 'sandbox', 'login', '--daemon-url', base],
          { cwd: daemonRoot },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('chỉ dùng cho Docker sandbox'),
      });

      await expect(
        execFileAsync(
          process.execPath,
          ['--import', 'tsx', cliEntry, 'sandbox', 'ps', '--daemon-url', base],
          { cwd: daemonRoot },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('chỉ dùng cho Docker sandbox'),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
