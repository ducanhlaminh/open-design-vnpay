// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePipelineNav } from '../../../src/components/pipelines/usePipelineNav';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('usePipelineNav · App list', () => {
  it('giữ designSystemId + docsReviewComponentSource từ /api/pipelines/apps lên NavApp (tab DS cần để biết App dùng Link Figma)', async () => {
    const source = { mode: 'figma-links', links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }] };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/pipelines/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      if (url.endsWith('/api/pipelines/apps')) return new Response(JSON.stringify({ apps: [{ id: 'adw', name: 'ádw', designSystemId: null, docsReviewComponentSource: source, origin: 'local' }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const { result } = renderHook(() => usePipelineNav());
    await act(async () => { await result.current.reload(); });
    const app = result.current.appById('adw');
    expect(app?.docsReviewComponentSource).toEqual(source);
    expect(app?.designSystemId).toBeNull();
  });
});
