// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectSyncPlanExpiredError,
  applyProjectSync,
  getProjectSyncStatus,
  listProjectSyncOrigins,
  planProjectSync,
} from '../../src/providers/project-sync';

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('project-sync provider', () => {
  it('uses scoped status/origin endpoints and unwraps their contract responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { results: [{ scope: { kind: 'feature', projectId: 'f-1', appId: 'a-1' }, state: 'new', mappingValid: false, features: [], summary: { created: 1, unchanged: 0, changed: 0, deleted: 0 }, entries: [] }] } }))
      .mockResolvedValueOnce(response({ data: { origins: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await getProjectSyncStatus({ kind: 'feature', projectId: 'f-1', appId: 'a-1' });
    expect(await listProjectSyncOrigins({ kind: 'feature', projectId: 'f-1', appId: 'a-1' })).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/project-sync/status');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ scopes: [{ kind: 'feature', projectId: 'f-1', appId: 'a-1' }] });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/project-sync/origins?kind=feature&appId=a-1');
  });

  it('sends plan/apply bodies unchanged and recognizes PLAN_EXPIRED', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { planId: 'p1', direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, origin: { mode: 'existing', originId: 'o1' }, features: [], entries: [], summary: { created: 0, unchanged: 1, changed: 0, deleted: 0 } } }))
      .mockResolvedValueOnce(response({ error: { code: 'PLAN_EXPIRED' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await planProjectSync({ direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, includeDeleted: true });
    await expect(applyProjectSync({ planId: 'p1', resolutions: { 'x.md': 'skip' } })).rejects.toBeInstanceOf(ProjectSyncPlanExpiredError);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ direction: 'pull', scope: { kind: 'feature', projectId: 'f1' }, includeDeleted: true });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ planId: 'p1', resolutions: { 'x.md': 'skip' } });
  });
});
