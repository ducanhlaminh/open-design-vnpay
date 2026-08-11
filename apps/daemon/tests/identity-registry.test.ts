import { afterEach, describe, expect, it, vi } from 'vitest';

import { memberProjectAccess, pullScopeFor } from '../src/kg-sync/identity-registry.js';

const originalIdentityUrl = process.env.IDENTITY_URL;

afterEach(() => {
  if (originalIdentityUrl === undefined) delete process.env.IDENTITY_URL;
  else process.env.IDENTITY_URL = originalIdentityUrl;
  vi.unstubAllGlobals();
});

describe('identity-scoped project discovery', () => {
  it('blocks discovery while preview-identity is not configured', async () => {
    delete process.env.IDENTITY_URL;
    await expect(pullScopeFor(null)).resolves.toMatchObject({
      all: false,
      reason: expect.stringContaining('preview-identity'),
    });
  });

  it('fails closed without ever sending google:<sub> to a UUID endpoint', async () => {
    process.env.IDENTITY_URL = 'http://identity.test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(pullScopeFor('google:123')).resolves.toMatchObject({ all: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists only memberships for a canonical identity UUID', async () => {
    process.env.IDENTITY_URL = 'http://identity.test';
    const userId = '65edc73c-56a4-4c48-8651-d7cb07a5e10d';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/admin/roles')) {
        return new Response(JSON.stringify({ roles: [] }), { status: 200 });
      }
      if (url.includes('/api/v1/projects?')) {
        expect((init?.headers as Record<string, string>)['x-user-id']).toBe(userId);
        return new Response(JSON.stringify({
          projects: [
            { id: 'identity-project-id', name: 'Checkout', role: 'editor', metadata: { kgsProjectId: 'checkout' } },
          ],
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));

    const scope = await pullScopeFor(userId);
    expect(scope.all).toBe(false);
    expect([...scope.ids]).toEqual(['checkout']);
  });

  it('keeps the actual role returned by identity instead of fabricating admin', async () => {
    process.env.IDENTITY_URL = 'http://identity.roles.test';
    const userId = 'b5e6c9de-0b8d-4d62-bb0e-57a4c2b37ae9';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      projects: [
        { id: 'p1', name: 'Owned', role: 'owner', metadata: { kgsProjectId: 'owned' } },
        { id: 'p2', name: 'Shared', role: 'viewer', metadata: { kgsProjectId: 'shared' } },
      ],
    }), { status: 200 })));

    const roles = await memberProjectAccess(userId);
    expect(roles?.get('owned')).toBe('owner');
    expect(roles?.get('shared')).toBe('viewer');
  });
});
