import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCodexDeviceLoginOutput,
  resolveHostClaudeStatus,
  resolveSandboxFallbackRuntimeId,
  sandboxModeFromCfg,
  sandboxRuntimeIsGated,
  SANDBOX_MODE_HOST_MESSAGE,
} from '../src/sandbox-routes.js';

describe('sandbox runtime resolver', () => {
  it('treats Claude and Codex as gated when the sandbox owns the runtime', () => {
    const cfg = { enabled: true, runtimes: ['claude', 'codex'], skills: ['*'] };
    expect(sandboxRuntimeIsGated(cfg, 'claude')).toBe(true);
    expect(sandboxRuntimeIsGated(cfg, 'codex')).toBe(true);
    expect(resolveSandboxFallbackRuntimeId(cfg)).toBe('claude');
  });

  it('falls back to Codex when Claude is not gated but Codex is', () => {
    const cfg = { enabled: true, runtimes: ['codex'], skills: ['*'] };
    expect(sandboxRuntimeIsGated(cfg, 'claude')).toBe(false);
    expect(sandboxRuntimeIsGated(cfg, 'codex')).toBe(true);
    expect(resolveSandboxFallbackRuntimeId(cfg)).toBe('codex');
  });

  it('respects the skills gate before claiming the sandbox owns anything', () => {
    const cfg = { enabled: true, runtimes: ['claude', 'codex'], skills: ['ui-react'] };
    expect(sandboxRuntimeIsGated(cfg, 'claude')).toBe(false);
    expect(resolveSandboxFallbackRuntimeId(cfg)).toBeNull();
  });
});

describe('sandboxModeFromCfg', () => {
  it('is "host" when disabled and "sandbox" when enabled (WP4 default is host)', () => {
    expect(sandboxModeFromCfg({ enabled: false })).toBe('host');
    expect(sandboxModeFromCfg({ enabled: true })).toBe('sandbox');
  });
});

describe('SANDBOX_MODE_HOST_MESSAGE', () => {
  it('is a non-empty human message the 409 guard can reuse verbatim', () => {
    expect(SANDBOX_MODE_HOST_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('resolveHostClaudeStatus', () => {
  const originalPath = process.env.PATH;
  const originalAgentHome = process.env.OD_AGENT_HOME;

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAgentHome === undefined) delete process.env.OD_AGENT_HOME;
    else process.env.OD_AGENT_HOME = originalAgentHome;
  });

  it('reports unavailable (no Docker touched) when claude does not resolve on PATH', async () => {
    // Clearing PATH alone is not enough: resolveAgentLaunch → executables.ts
    // ALSO scans well-known user toolchain dirs (~/.claude/local, ~/.local/bin,
    // Homebrew, …), so on a dev machine that actually has Claude Code
    // installed it still resolves the absolute binary. Pointing OD_AGENT_HOME
    // at a fresh EMPTY dir scopes that scan there (executables.ts uses an
    // empty env + skips system bins under the override) → nothing found,
    // regardless of what is installed on the host. Same pattern as
    // connection-test.test.ts's "agent CLI is missing" case.
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-sandbox-status-empty-path-'));
    process.env.PATH = '';
    process.env.OD_AGENT_HOME = emptyDir;
    const status = await resolveHostClaudeStatus();
    expect(status.available).toBe(false);
    expect(['ok', 'missing', 'unknown']).toContain(status.authStatus);
  });
});

describe('Codex device login output parser', () => {
  it('strips terminal colors and returns the real URL and variable-length device code', () => {
    const output = [
      'Welcome to Codex [v\u001b[90m0.146.0\u001b[0m]',
      "\u001b[90mOpenAI's command-line coding agent\u001b[0m",
      '1. Open this link in your browser',
      '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
      '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
      '   \u001b[94mJMHR-MJT7V\u001b[0m',
    ].join('\n');

    expect(parseCodexDeviceLoginOutput(output)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'JMHR-MJT7V',
    });
  });

  it('does not treat ANSI color fragments or product names as a code', () => {
    expect(parseCodexDeviceLoginOutput('\u001b[90mOpenAI\u001b[0m')).toEqual({
      verificationUrl: null,
      userCode: null,
    });
  });
});
