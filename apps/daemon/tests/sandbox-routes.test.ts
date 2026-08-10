import { describe, expect, it } from 'vitest';
import { resolveSandboxFallbackRuntimeId, sandboxRuntimeIsGated } from '../src/sandbox-routes.js';

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
