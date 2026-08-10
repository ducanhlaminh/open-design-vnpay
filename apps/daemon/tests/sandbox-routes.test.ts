import { describe, expect, it } from 'vitest';
import {
  parseCodexDeviceLoginOutput,
  resolveSandboxFallbackRuntimeId,
  sandboxRuntimeIsGated,
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
