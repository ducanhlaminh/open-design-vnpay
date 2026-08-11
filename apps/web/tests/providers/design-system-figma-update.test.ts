import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveDesignSystemFigmaUpdate,
  discardDesignSystemCriteriaDraft,
  parseDesignSystemFigmaUpdateState,
  uploadDesignSystemFigmaUpdate,
} from '../../src/providers/design-system-figma-update';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('design system Figma update provider', () => {
  it('keeps legacy responses usable as an approved first version', () => {
    expect(parseDesignSystemFigmaUpdateState({})).toMatchObject({
      schemaVersion: 1,
      lifecycle: 'approved',
      currentVersion: 1,
      candidateVersion: null,
      deleteOldSourceAfterApproval: false,
      criteria: {
        components: { kind: 'components', status: 'missing', count: 0 },
        rules: { kind: 'rules', status: 'missing', count: 0 },
      },
    });
  });

  it('uploads repeated ZIP files and only sends the delete option when selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lifecycle: 'criteria_pending',
      currentVersion: 1,
      candidateVersion: 2,
      deleteOldSourceAfterApproval: true,
      criteria: {
        components: { status: 'stale', count: 4, generatedFromVersion: 1 },
        rules: { status: 'stale', count: 3, generatedFromVersion: 1 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const files = [new File(['a'], 'base.zip'), new File(['b'], 'extra.zip')];

    const result = await uploadDesignSystemFigmaUpdate('user:lib', files, true);

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/design-systems/user%3Alib/figma-update');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.getAll('files')).toHaveLength(2);
    expect(form.get('deleteOldSourceAfterApproval')).toBe('true');
  });

  it('uses explicit discard and stale-confirmation requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lifecycle: 'approved',
      currentVersion: 2,
      criteria: { components: { status: 'current' }, rules: { status: 'current' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await discardDesignSystemCriteriaDraft('ds-1', 'components');
    await approveDesignSystemFigmaUpdate('ds-1', true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/design-systems/ds-1/criteria/components/draft',
      { method: 'DELETE' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/design-systems/ds-1/figma-update/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirmStaleCriteria: true }),
      }),
    );
  });
});
