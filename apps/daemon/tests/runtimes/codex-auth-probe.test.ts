/**
 * Coverage for the Codex CLI login probe.
 *
 * Codex has no non-interactive online status check exposed as a stable API
 * either, so the probe reads the same local state the CLI itself consults:
 * `<CODEX_HOME or ~/.codex>/auth.json`, which carries either an OAuth
 * `tokens.access_token` or a bare `OPENAI_API_KEY` fallback field.
 *
 * Same load-bearing invariant as the Claude probe: an unanswerable probe
 * degrades to `unknown`, never to `missing` — a false "chưa đăng nhập" is
 * worse than admitting we could not tell.
 */
import { describe, expect, it } from 'vitest';

import { probeCodexAuthStatus } from '../../src/runtimes/auth.js';

const HOME = '/home/tester';
const enoent = (): never => {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

function linuxIO(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    homedir: () => HOME,
    readFile: async (filePath: string): Promise<string> => {
      const found = files[filePath];
      return found === undefined ? enoent() : found;
    },
    ...extra,
  };
}

describe('probeCodexAuthStatus', () => {
  it('reports ok when auth.json carries an OAuth access token', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"tokens":{"access_token":"oat-abc","refresh_token":"r"}}',
    });
    expect(await probeCodexAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports ok when auth.json carries a bare OPENAI_API_KEY fallback', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"OPENAI_API_KEY":"sk-proj-abc"}',
    });
    expect(await probeCodexAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports missing when no credential state exists at all', async () => {
    const result = await probeCodexAuthStatus({}, linuxIO({}));
    expect(result.status).toBe('missing');
    expect(result.message).toMatch(/codex login/);
  });

  it('treats a hollow auth.json (aborted login) as missing', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"tokens":{"access_token":""}}',
    });
    expect((await probeCodexAuthStatus({}, io)).status).toBe('missing');
  });

  it('honours CODEX_HOME over the default ~/.codex', async () => {
    const io = linuxIO({
      '/profiles/work/auth.json': '{"tokens":{"access_token":"oat-x"}}',
      // The default profile is logged OUT — picking it would flip the verdict.
      [`${HOME}/.codex/auth.json`]: '{}',
    });
    expect(await probeCodexAuthStatus({ CODEX_HOME: '/profiles/work' }, io)).toEqual({
      status: 'ok',
    });
  });

  it('counts an explicit OPENAI_API_KEY env var as logged in', async () => {
    const io = linuxIO({});
    expect(await probeCodexAuthStatus({ OPENAI_API_KEY: 'sk-proj-x' }, io)).toEqual({
      status: 'ok',
    });
  });

  it('degrades to unknown — not missing — when the probe cannot answer', async () => {
    const eacces = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const unreadable = await probeCodexAuthStatus({}, {
      homedir: () => HOME,
      readFile: async () => eacces(),
    });
    expect(unreadable.status).toBe('unknown');
  });
});
