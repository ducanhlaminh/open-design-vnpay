import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindFeatureContext, transferSelectedAppContexts } from '../../../src/components/pipelines/context-sync-api';

afterEach(() => vi.unstubAllGlobals());

describe('App Context API wiring', () => {
  it('nâng binding gửi đủ App, version và digest', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { featureId: 'qr', binding: { schemaVersion: 1, appId: 'pay', contextVersion: 'v3', contentDigest: 'sha256:v3', boundAt: 'now' } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await bindFeatureContext({ featureId: 'qr', appId: 'pay', contextVersion: 'v3', contentDigest: 'sha256:v3' });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/qr/context-binding', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ appId: 'pay', contextVersion: 'v3', contentDigest: 'sha256:v3' }),
    }));
  });

  it('Pull giữ bản local thì không gọi endpoint ghi Context', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await transferSelectedAppContexts('pull', {
      appIds: ['pay'],
      projectIds: [],
      contextConflictResolutions: { pay: 'keep_local' },
    });
    expect(result).toEqual([{ status: 'kept_local', appId: 'pay' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Push App-only gọi đúng endpoint versioned độc lập với Feature output', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { status: 'pending_approval', appId: 'pay', requestId: 'pending-pay', manifest: {} },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await transferSelectedAppContexts('push', { appIds: ['pay'], projectIds: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/pipelines/apps/pay/context/push', expect.objectContaining({ method: 'POST' }));
  });

  it('đẩy version Feature đã khóa trước và Context hiện tại sau cùng', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { status: 'published', appId: 'pay', manifest: {} },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await transferSelectedAppContexts('push', {
      appIds: ['pay'],
      projectIds: ['qr'],
      contextVersions: { pay: ['v2', 'v3'] },
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { contextVersion: 'v2' },
      { contextVersion: 'v3' },
    ]);
  });
});
