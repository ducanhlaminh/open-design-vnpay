import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SELF_UPDATE_OVERALL_TIMEOUT_MS,
  followHostUpdate,
  isSuccessfulUpdateNoop,
} from '../src/self-update-follow.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('followHostUpdate', () => {
  it('leaves margin beyond the bounded Windows download retry budget', () => {
    const windowsDownloadBudgetMs = 3 * 3 * 60_000;
    expect(DEFAULT_SELF_UPDATE_OVERALL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      windowsDownloadBudgetMs + 5 * 60_000,
    );
  });

  it('tolerates restart connection failures and verifies the target version after reconnect', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({
        operationId: 'op-1', targetVersion: '1.2.3', state: 'healthy', currentVersion: '1.2.3',
      }));

    const result = await followHostUpdate({
      base: 'http://127.0.0.1:1', operationId: 'op-1', targetVersion: '1.2.3',
      fetchImpl, pollMs: 0, sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns the durable installer error and does not keep polling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      operationId: 'op-1', targetVersion: '1.2.3', state: 'failed', currentVersion: '1.2.2',
      lastError: { message: 'checksum mismatch', at: '2026-08-17T00:00:00.000Z' },
    }));
    const result = await followHostUpdate({
      base: 'http://127.0.0.1:1', operationId: 'op-1', targetVersion: '1.2.3',
      fetchImpl, pollMs: 0, sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: false, error: 'checksum mismatch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns success with an explicit restart requirement', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      operationId: 'op-1', targetVersion: '1.2.3', state: 'restart-required', currentVersion: '1.2.2',
    }));
    const result = await followHostUpdate({
      base: 'http://127.0.0.1:1', operationId: 'op-1', targetVersion: '1.2.3',
      fetchImpl, pollMs: 0, sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, restartRequired: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deduplicates unchanged progress reports', async () => {
    const progress = {
      operationId: 'op-1', targetVersion: '1.2.3', state: 'installing', currentVersion: '1.2.2',
      phase: { step: 3, totalSteps: 6, label: 'Install' },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse({ ...progress, state: 'healthy', currentVersion: '1.2.3' }));
    const onProgress = vi.fn();
    const result = await followHostUpdate({
      base: 'http://127.0.0.1:1', operationId: 'op-1', targetVersion: '1.2.3',
      fetchImpl, onProgress, pollMs: 0, sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('rejects a healthy response when the running version is not the target', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      operationId: 'op-1', targetVersion: '1.2.3', state: 'healthy', currentVersion: '1.2.2',
    }));
    const result = await followHostUpdate({
      base: 'http://127.0.0.1:1', operationId: 'op-1', targetVersion: '1.2.3',
      fetchImpl, pollMs: 0, sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('expected 1.2.3');
  });
});

describe('isSuccessfulUpdateNoop', () => {
  it('accepts only an explicit up-to-date no-op', () => {
    expect(isSuccessfulUpdateNoop({ started: false, reason: 'up-to-date' })).toBe(true);
    expect(isSuccessfulUpdateNoop({ started: false, reason: 'runs-active' })).toBe(false);
    expect(isSuccessfulUpdateNoop({ started: false, reason: 'already-in-progress' })).toBe(false);
    expect(isSuccessfulUpdateNoop({ started: true, reason: 'up-to-date' })).toBe(false);
  });
});
