// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDesignSystemSyncStatus,
  listRemoteDesignSystems,
  planPullDesignSystem,
  publishDesignSystem,
  pullDesignSystem,
} from '../../src/providers/design-system-sync';

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('design-system-sync provider', () => {
  it('uses the locked remote list and status endpoints and accepts data wrappers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { items: [], total: 0 } }))
      .mockResolvedValueOnce(response({ data: { localDesignSystemId: 'ds 1', canPush: false } }));
    vi.stubGlobal('fetch', fetchMock);

    const list = await listRemoteDesignSystems('kế toán');
    const status = await fetchDesignSystemSyncStatus('ds 1');

    expect(list).toEqual({ ok: true, value: { items: [], total: 0 } });
    expect(status.ok && status.value.localDesignSystemId).toBe('ds 1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/design-systems/sync/remote?q=k%E1%BA%BF+to%C3%A1n');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/design-systems/ds%201/sync/status');
  });

  it('sends exact push, pull-plan and pull request bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ status: 'error', message: 'x' }))
      .mockResolvedValueOnce(response({ localDesignSystemId: 'local', conflict: false }))
      .mockResolvedValueOnce(response({ status: 'kept_local', localDesignSystemId: 'local', remoteDesignSystemId: 'remote', bindingsChanged: false, contextCreated: false }));
    vi.stubGlobal('fetch', fetchMock);

    await publishDesignSystem('local', { expectedRemoteDigest: 'sha256:old' });
    await planPullDesignSystem({ remoteDesignSystemId: 'remote', version: 'v2' });
    await pullDesignSystem({
      remoteDesignSystemId: 'remote',
      version: 'v2',
      localDesignSystemId: 'local',
      expectedLocalDigest: 'sha256:local',
      resolution: 'keep_local',
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/design-systems/local/sync/push',
      '/api/design-systems/sync/pull/plan',
      '/api/design-systems/sync/pull',
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ expectedRemoteDigest: 'sha256:old' });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ remoteDesignSystemId: 'remote', version: 'v2' });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      remoteDesignSystemId: 'remote',
      version: 'v2',
      localDesignSystemId: 'local',
      expectedLocalDigest: 'sha256:local',
      resolution: 'keep_local',
    });
  });

  it('returns a readable transport error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { message: 'Kho chung chưa cấu hình' } }, { status: 503 })));
    expect(await listRemoteDesignSystems()).toEqual({
      ok: false,
      error: { message: 'Kho chung chưa cấu hình', status: 503 },
    });
  });

  it('preserves typed conflict outcomes returned with HTTP 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ok: false,
      data: {
        status: 'conflict',
        localDesignSystemId: 'local',
        remoteDesignSystemId: 'remote',
        localDigest: 'sha256:local',
        remoteDigest: 'sha256:remote',
      },
    }, { status: 409 })));

    const result = await publishDesignSystem('local', {});
    expect(result.ok && result.value.status).toBe('conflict');
  });
});
