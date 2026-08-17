/**
 * Coverage for the Claude Code (Local CLI) login probe.
 *
 * Claude Code has no non-interactive `claude auth status`, so the probe
 * reads the same local state the CLI itself consults: the OAuth blob at
 * `<configDir>/.credentials.json`, a scripted `apiKeyHelper` in
 * `<configDir>/settings.json`, and — on macOS, where the CLI keeps the
 * blob out of the filesystem — the "Claude Code-credentials" Keychain
 * item.
 *
 * The load-bearing invariant is that an unanswerable probe degrades to
 * `unknown`, never to `missing`: a red "chưa đăng nhập" badge on a
 * machine that IS logged in sends the user off to re-run `/login` for
 * nothing, which is worse than admitting we could not tell.
 */
import { describe, expect, it } from 'vitest';

import {
  extractClaudeAccountEmail,
  logoutHostClaude,
  logoutHostCodex,
  probeClaudeAuthStatus,
} from '../../src/runtimes/auth.js';

const HOME = '/home/tester';
const enoent = (): never => {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

/** Linux/Windows defaults: no Keychain, files under ~/.claude. */
function linuxIO(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    homedir: () => HOME,
    readFile: async (filePath: string): Promise<string> => {
      const found = files[filePath];
      return found === undefined ? enoent() : found;
    },
    ...extra,
  };
}

describe('probeClaudeAuthStatus', () => {
  it('reports ok when the credentials file carries an access token', async () => {
    const io = linuxIO({
      [`${HOME}/.claude/.credentials.json`]:
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r"}}',
    });
    expect(await probeClaudeAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports missing when no credential state exists at all', async () => {
    const result = await probeClaudeAuthStatus({}, linuxIO({}));
    expect(result.status).toBe('missing');
    expect(result.message).toMatch(/\/login/);
  });

  it('treats a hollow credentials file (aborted login) as missing', async () => {
    // An interrupted `/login` writes the file before the code exchange
    // completes, so a mere existence/size test would call it a login.
    const io = linuxIO({
      [`${HOME}/.claude/.credentials.json`]: '{"claudeAiOauth":{"accessToken":""}}',
    });
    expect((await probeClaudeAuthStatus({}, io)).status).toBe('missing');
  });

  it('honours CLAUDE_CONFIG_DIR over the default ~/.claude', async () => {
    const io = linuxIO({
      '/profiles/work/.credentials.json': '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}',
      // The default profile is logged OUT — picking it would flip the verdict.
      [`${HOME}/.claude/.credentials.json`]: '{}',
    });
    expect(await probeClaudeAuthStatus({ CLAUDE_CONFIG_DIR: '/profiles/work' }, io)).toEqual({
      status: 'ok',
    });
  });

  it('counts a scripted apiKeyHelper as logged in', async () => {
    const io = linuxIO({
      [`${HOME}/.claude/settings.json`]: '{"apiKeyHelper":"/usr/local/bin/anthropic-key.sh"}',
    });
    expect(await probeClaudeAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('counts an explicit API key / Bedrock / Vertex route as logged in', async () => {
    const io = linuxIO({});
    for (const env of [
      { ANTHROPIC_API_KEY: 'sk-ant-api-x', ANTHROPIC_BASE_URL: 'https://proxy.internal' },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { CLAUDE_CODE_USE_VERTEX: '1' },
    ]) {
      expect(await probeClaudeAuthStatus(env, io)).toEqual({ status: 'ok' });
    }
  });

  it('reads the macOS Keychain when no credentials file is on disk', async () => {
    const io = linuxIO({}, {
      platform: 'darwin' as NodeJS.Platform,
      keychainHasCredentials: async () => true,
    });
    expect(await probeClaudeAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports missing on macOS when the Keychain item is absent', async () => {
    const io = linuxIO({}, {
      platform: 'darwin' as NodeJS.Platform,
      keychainHasCredentials: async () => false,
    });
    expect((await probeClaudeAuthStatus({}, io)).status).toBe('missing');
  });

  it('attaches the oauth account email when ~/.claude.json carries one', async () => {
    const io = linuxIO({
      [`${HOME}/.claude/.credentials.json`]:
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r"}}',
      [`${HOME}/.claude.json`]: '{"oauthAccount":{"emailAddress":"test@example.com"}}',
    });
    expect(await probeClaudeAuthStatus({}, io)).toEqual({
      status: 'ok',
      account: { email: 'test@example.com' },
    });
  });

  it('stays status ok with account undefined when ~/.claude.json is missing or malformed', async () => {
    // No ~/.claude.json on disk at all.
    const missingFile = linuxIO({
      [`${HOME}/.claude/.credentials.json`]:
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc"}}',
    });
    expect(await probeClaudeAuthStatus({}, missingFile)).toEqual({ status: 'ok' });

    // ~/.claude.json present but not valid JSON.
    const malformedJson = linuxIO({
      [`${HOME}/.claude/.credentials.json`]:
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc"}}',
      [`${HOME}/.claude.json`]: '{not valid json',
    });
    expect(await probeClaudeAuthStatus({}, malformedJson)).toEqual({ status: 'ok' });

    // ~/.claude.json present and valid JSON, but no oauthAccount.emailAddress.
    const noEmail = linuxIO({
      [`${HOME}/.claude/.credentials.json`]:
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc"}}',
      [`${HOME}/.claude.json`]: '{"oauthAccount":{}}',
    });
    expect(await probeClaudeAuthStatus({}, noEmail)).toEqual({ status: 'ok' });
  });

  it('degrades to unknown — not missing — when the probe cannot answer', async () => {
    // Unreadable config dir (EACCES) and a broken `security` binary are
    // both "we could not tell", and must not render as "chưa đăng nhập".
    const eacces = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const unreadable = await probeClaudeAuthStatus({}, {
      platform: 'linux',
      homedir: () => HOME,
      readFile: async () => eacces(),
    });
    expect(unreadable.status).toBe('unknown');

    const keychainBroken = await probeClaudeAuthStatus({}, {
      platform: 'darwin',
      homedir: () => HOME,
      readFile: async () => enoent(),
      keychainHasCredentials: async () => {
        throw new Error('spawn security ENOENT');
      },
    });
    expect(keychainBroken.status).toBe('unknown');
  });
});

describe('logoutHostClaude', () => {
  it('deletes the credentials file (Linux/Windows path)', async () => {
    const deleted: string[] = [];
    const result = await logoutHostClaude({}, {
      platform: 'linux',
      homedir: () => HOME,
      unlink: async (filePath) => {
        deleted.push(filePath);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(deleted).toEqual([`${HOME}/.claude/.credentials.json`]);
  });

  it('honours CLAUDE_CONFIG_DIR and tolerates an already-absent file', async () => {
    const deleted: string[] = [];
    const result = await logoutHostClaude({ CLAUDE_CONFIG_DIR: '/profiles/work' }, {
      platform: 'linux',
      homedir: () => HOME,
      unlink: async (filePath) => {
        deleted.push(filePath);
        enoent(); // already logged out — must still report ok
      },
    });
    expect(result).toEqual({ ok: true });
    expect(deleted).toEqual(['/profiles/work/.credentials.json']);
  });

  it('also clears the macOS Keychain item', async () => {
    let keychainCleared = false;
    const result = await logoutHostClaude({}, {
      platform: 'darwin',
      homedir: () => HOME,
      unlink: async () => enoent(),
      keychainDeleteCredentials: async () => {
        keychainCleared = true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(keychainCleared).toBe(true);
  });

  it('refuses env-routed auth — nothing local to log out of', async () => {
    for (const env of [
      { ANTHROPIC_API_KEY: 'sk-ant-api-x' },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { CLAUDE_CODE_USE_VERTEX: '1' },
    ]) {
      const result = await logoutHostClaude(env, {
        platform: 'linux',
        homedir: () => HOME,
        unlink: async () => {
          throw new Error('must not touch files for env auth');
        },
      });
      expect(result.ok).toBe(false);
    }
  });

  it('surfaces real deletion failures instead of a false "đã đăng xuất"', async () => {
    const eacces = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    await expect(
      logoutHostClaude({}, {
        platform: 'linux',
        homedir: () => HOME,
        unlink: async () => eacces(),
      }),
    ).rejects.toThrow('EACCES');
  });
});

describe('logoutHostCodex', () => {
  it('delegates credential removal to the official codex logout command', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await logoutHostCodex('/tools/codex', { PATH: '/usr/bin' }, {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '' };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ command: '/tools/codex', args: ['logout'] }]);
  });

  it('refuses environment-routed auth because there is no CLI session to remove', async () => {
    const result = await logoutHostCodex('/tools/codex', {
      OPENAI_BASE_URL: 'https://gateway.example',
      OPENAI_API_KEY: 'test-key',
    }, {
      run: async () => {
        throw new Error('must not run codex logout for env auth');
      },
    });
    expect(result.ok).toBe(false);
  });

  it('surfaces CLI logout failures instead of reporting a false success', async () => {
    await expect(logoutHostCodex('/tools/codex', {}, {
      run: async () => {
        throw new Error('credential store unavailable');
      },
    })).rejects.toThrow('credential store unavailable');
  });
});

describe('extractClaudeAccountEmail', () => {
  it('returns oauthAccount.emailAddress from a realistic ~/.claude.json', () => {
    const raw = JSON.stringify({
      oauthAccount: { emailAddress: 'test@example.com', accountUuid: 'abc-123' },
      other: 'ignored',
    });
    expect(extractClaudeAccountEmail(raw)).toBe('test@example.com');
  });

  it('returns undefined — never throws — for malformed JSON', () => {
    expect(extractClaudeAccountEmail('{not valid json')).toBeUndefined();
  });

  it('returns undefined when oauthAccount or emailAddress is absent', () => {
    expect(extractClaudeAccountEmail('{}')).toBeUndefined();
    expect(extractClaudeAccountEmail('{"oauthAccount":{}}')).toBeUndefined();
    expect(extractClaudeAccountEmail('{"oauthAccount":{"emailAddress":""}}')).toBeUndefined();
    expect(extractClaudeAccountEmail('{"oauthAccount":{"emailAddress":123}}')).toBeUndefined();
  });
});
