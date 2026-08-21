import { describe, expect, it, vi } from 'vitest';

import {
  buildFigmaComponentCatalog,
  describeFigmaError,
  figmaWhoAmI,
  verifyFigmaLink,
} from '../src/figma-rest.js';

type Route = (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(route: Route) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    expect((init?.headers as Record<string, string>)['X-Figma-Token']).toBe('tok');
    const out = route(url);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const fileA = {
  name: 'Core UI Kit',
  document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', type: 'CANVAS', name: 'Components' }] },
  componentSets: {
    '10:1': { key: 'k1', name: 'Button', description: 'Primary action', remote: false },
    '90:1': { key: 'kr', name: 'Remote Set', remote: true },
  },
  components: {
    '10:2': { key: 'v1', name: 'State=Default', componentSetId: '10:1', remote: false },
    '10:3': { key: 'v2', name: 'State=Disabled', componentSetId: '10:1', remote: false },
    '11:1': { key: 'k2', name: 'Avatar', description: '', remote: false },
    '91:1': { key: 'kr2', name: 'Lib/Icon', remote: true },
  },
};

// Published-library metadata for file A (what /component_sets + /components return).
const publishedSetsA = { meta: { component_sets: [
  { node_id: '10:1', name: 'Button', description: 'Primary action', containing_frame: { pageName: 'Actions' } },
] } };
const publishedComponentsA = { meta: { components: [
  { node_id: '10:2', name: 'State=Default', containing_frame: { pageName: 'Actions', containingStateGroup: { nodeId: '10:1', name: 'Button' } } },
  { node_id: '10:3', name: 'State=Disabled', containing_frame: { pageName: 'Actions', containingStateGroup: { nodeId: '10:1', name: 'Button' } } },
  { node_id: '11:1', name: 'Avatar', description: '', containing_frame: { pageName: 'People' } },
] } };
const emptyPublished = { meta: { component_sets: [], components: [] } };
/** Page-walk shape: /nodes?ids=<pageId> answers with the page node carrying its own maps. */
const pageWalkA = { nodes: { '0:1': { document: { id: '0:1', type: 'CANVAS', name: 'Components' }, componentSets: fileA.componentSets, components: fileA.components } } };

const nodesA = {
  nodes: {
    '10:1': { document: { id: '10:1', type: 'COMPONENT_SET', componentPropertyDefinitions: {
      State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Disabled', 'Default'] },
      'Label#12:0': { type: 'TEXT', defaultValue: 'Continue' },
      'Show icon#12:1': { type: 'BOOLEAN', defaultValue: true },
    } } },
    '11:1': { document: { id: '11:1', type: 'COMPONENT' } },
  },
};

describe('figma-rest', () => {
  it('whoami reads handle/email from /v1/me', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: '1', handle: 'anh', email: 'a@x.vn' } }));
    await expect(figmaWhoAmI('tok', { fetch })).resolves.toEqual({ handle: 'anh', email: 'a@x.vn' });
    expect(calls).toEqual(['/v1/me']);
  });

  it('whoami without current_user:read scope (403, not "Invalid token") is still a valid token', async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Not authorized for scope current_user:read' } }));
    await expect(figmaWhoAmI('tok', { fetch })).resolves.toEqual({ scopeLimited: true });
  });

  it('maps auth/forbidden/not-found/timeout to Vietnamese guidance', async () => {
    const auth = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Invalid token' } }));
    await expect(figmaWhoAmI('tok', { fetch: auth.fetch })).rejects.toMatchObject({ kind: 'auth' });
    const forbidden = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Not allowed' } }));
    const row = await verifyFigmaLink('tok', { url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }, { fetch: forbidden.fetch });
    expect(row).toMatchObject({ ok: false });
    expect(row.detail).toMatch(/File content: Read/);
    const missing = fakeFetch(() => ({ status: 404, body: { status: 404, err: 'Not found' } }));
    const gone = await verifyFigmaLink('tok', { url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }, { fetch: missing.fetch });
    expect(gone.detail).toMatch(/không tìm thấy/i);
    expect(describeFigmaError(new Error('boom'))).toBe('boom');
  });

  it('retries on 429 honouring Retry-After before giving up', async () => {
    let hits = 0;
    const sleeps: number[] = [];
    const { fetch } = fakeFetch(() => {
      hits++;
      return hits < 3 ? { status: 429, body: {}, headers: { 'retry-after': '1' } } : { body: { handle: 'ok' } };
    });
    await expect(figmaWhoAmI('tok', { fetch, sleep: async (ms) => { sleeps.push(ms); } })).resolves.toEqual({ handle: 'ok' });
    expect(hits).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('verifyFigmaLink counts published sets + stand-alone components (variants collapse into their set)', async () => {
    const own = fakeFetch((url) => (url.pathname === '/v1/files/A' ? { body: fileA }
      : url.pathname === '/v1/files/A/component_sets' ? { body: publishedSetsA }
        : url.pathname === '/v1/files/A/components' ? { body: publishedComponentsA }
          : { status: 404, body: {} }));
    await expect(verifyFigmaLink('tok', { url: 'https://www.figma.com/design/A', fileKey: 'A' }, { fetch: own.fetch }))
      .resolves.toEqual({ fileKey: 'A', url: 'https://www.figma.com/design/A', ok: true, name: 'Core UI Kit', componentCount: 2 });
    expect(own.calls).toEqual(['/v1/files/A?depth=1', '/v1/files/A/component_sets', '/v1/files/A/components']);
  });

  it('unpublished file → walks every page via /nodes?ids=<pageId>; consumer-only file is flagged remote-only', async () => {
    const walk = fakeFetch((url) => (url.pathname === '/v1/files/A' ? { body: fileA }
      : url.pathname.endsWith('/component_sets') || url.pathname.endsWith('/components') ? { body: emptyPublished }
        : url.pathname === '/v1/files/A/nodes' ? { body: pageWalkA }
          : { status: 404, body: {} }));
    await expect(verifyFigmaLink('tok', { url: 'https://www.figma.com/design/A', fileKey: 'A' }, { fetch: walk.fetch }))
      .resolves.toMatchObject({ ok: true, name: 'Core UI Kit', componentCount: 2 });
    expect(walk.calls).toEqual(['/v1/files/A?depth=1', '/v1/files/A/component_sets', '/v1/files/A/components', '/v1/files/A/nodes?ids=0%3A1']);

    const remoteOnly = fakeFetch((url) => (url.pathname === '/v1/files/B'
      ? { body: { name: 'Checkout screens', document: { children: [{ id: '0:1', name: 'Screens' }] } } }
      : url.pathname.endsWith('/component_sets') || url.pathname.endsWith('/components') ? { body: emptyPublished }
        : url.pathname === '/v1/files/B/nodes' ? { body: { nodes: { '0:1': { components: { '1:1': { name: 'Lib/Button', remote: true } }, componentSets: {} } } } }
          : { status: 404, body: {} }));
    const row = await verifyFigmaLink('tok', { url: 'https://www.figma.com/design/B', fileKey: 'B' }, { fetch: remoteOnly.fetch });
    expect(row).toMatchObject({ ok: false, remoteOnly: true, componentCount: 0, name: 'Checkout screens' });
    expect(row.detail).toMatch(/thư viện gốc/);
  });

  it('falls back to page-walk when published endpoints reject a file_content-only token', async () => {
    const scoped = fakeFetch((url) => (url.pathname === '/v1/files/A' ? { body: fileA }
      : url.pathname === '/v1/files/A/component_sets'
        ? { status: 403, body: { status: 403, err: 'Not authorized for scope library_content:read' } }
        : url.pathname === '/v1/files/A/nodes' ? { body: pageWalkA }
          : { status: 404, body: {} }));
    await expect(verifyFigmaLink('tok', { url: 'https://www.figma.com/design/A', fileKey: 'A' }, { fetch: scoped.fetch }))
      .resolves.toMatchObject({ ok: true, name: 'Core UI Kit', componentCount: 2 });
    expect(scoped.calls).toEqual([
      '/v1/files/A?depth=1',
      '/v1/files/A/component_sets',
      '/v1/files/A/nodes?ids=0%3A1',
    ]);
  });

  it('aborts an in-flight REST request and emits no later progress', async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    let requestAborted = false;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        requestAborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })) as unknown as typeof globalThis.fetch;
    const reading = buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A', fileKey: 'A' }],
      signal: controller.signal,
      deps: { fetch },
      onProgress: (item) => progress.push(item.phase),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error('catalogue timed out'));
    await expect(reading).rejects.toThrow(/catalogue timed out/);
    expect(requestAborted).toBe(true);
    expect(progress).toEqual(['summary']);
  });

  it('keeps the caller abort linked while consuming a stalled response body', async () => {
    const controller = new AbortController();
    let bodyAborted = false;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: () => new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          bodyAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    } as unknown as Response)) as unknown as typeof globalThis.fetch;
    const reading = buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A', fileKey: 'A' }],
      signal: controller.signal,
      deps: { fetch },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    // Let fetch resolve and figmaGet enter response.json() before aborting.
    await Promise.resolve();
    controller.abort(new Error('body timed out'));
    await expect(reading).rejects.toThrow(/body timed out/);
    expect(bodyAborted).toBe(true);
  });

  it('removes external abort listeners after a completed retry sleep', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let hits = 0;
    const { fetch } = fakeFetch(() => (++hits === 1
      ? { status: 429, body: {}, headers: { 'retry-after': '1' } }
      : { body: { handle: 'ok' } }));
    await expect(figmaWhoAmI('tok', {
      fetch,
      signal: controller.signal,
      sleep: async () => undefined,
    })).resolves.toEqual({ handle: 'ok' });
    expect(add).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });

  it('builds a frozen snapshot: properties per entry, variants collapsed, page names best-effort, progress in order', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/files/A') return { body: fileA };
      if (url.pathname === '/v1/files/A/component_sets') return { body: publishedSetsA };
      if (url.pathname === '/v1/files/A/components') return { body: publishedComponentsA };
      if (url.pathname === '/v1/files/A/nodes') {
        expect(url.searchParams.get('ids')).toBe('10:1,11:1');
        return { body: nodesA };
      }
      return { status: 404, body: {} };
    });
    const progress: string[] = [];
    const snapshot = await buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A/Core', fileKey: 'A' }],
      onProgress: (p) => progress.push(`${p.phase}:${p.index}/${p.total}`),
      deps: { fetch, now: () => new Date('2026-08-16T00:00:00.000Z') },
    });
    expect(progress).toEqual(['summary:1/1', 'properties:1/1', 'done:1/1']);
    expect(calls).toEqual(['/v1/files/A?depth=1', '/v1/files/A/component_sets', '/v1/files/A/components', '/v1/files/A/nodes?ids=10%3A1%2C11%3A1&depth=1']);
    expect(snapshot.generatedAt).toBe('2026-08-16T00:00:00.000Z');
    expect(snapshot.files).toHaveLength(1);
    const [file] = snapshot.files;
    expect(file).toMatchObject({ fileKey: 'A', name: 'Core UI Kit', url: 'https://www.figma.com/design/A/Core' });
    expect(file!.components).toEqual([
      { nodeId: '10:1', name: 'Button', description: 'Primary action', page: 'Actions', properties: [
        { name: 'State', type: 'VARIANT', values: ['Default', 'Disabled'] },
        { name: 'Label', type: 'TEXT', values: ['Continue'] },
        { name: 'Show icon', type: 'BOOLEAN', values: [] },
      ],
      // WP25a: publishedComponentsA's two variants (10:2/10:3) declare
      // `containing_frame.containingStateGroup.nodeId: '10:1'` — they attach
      // here as `variants` (no `key` in this fixture, so each variant entry
      // omits it too — additive, doesn't disturb anything else in this test).
      variants: [
        { nodeId: '10:2', name: 'State=Default' },
        { nodeId: '10:3', name: 'State=Disabled' },
      ] },
      { nodeId: '11:1', name: 'Avatar', page: 'People', properties: [] },
    ]);
  });

  it('fails the whole read on the first unreadable file, naming it', async () => {
    const { fetch } = fakeFetch((url) => (url.pathname === '/v1/files/A'
      ? { body: fileA }
      : url.pathname === '/v1/files/A/component_sets' ? { body: publishedSetsA }
        : url.pathname === '/v1/files/A/components' ? { body: publishedComponentsA }
          : url.pathname === '/v1/files/A/nodes' ? { body: nodesA }
            : { status: 403, body: { err: 'Not allowed' } }));
    await expect(buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A', fileKey: 'A' }, { url: 'https://www.figma.com/design/B', fileKey: 'B' }],
      deps: { fetch },
    })).rejects.toThrow(/File 2\/2 \(B\): .*File content: Read/);
  });

  // ── WP25a: catalog carries `key` (needed to import a component cross-file
  // for "Dựng trong Figma") + per-set `variants` (a set itself can't be
  // imported by key — only its individual COMPONENT variants can). A payload
  // that carries no `key` (every test above) must keep producing the EXACT
  // same shape as before — proven above; this only covers the NEW, additive
  // behaviour when the payload does carry keys. ──
  it('carries key on standalone/set entries and variants (with their own key) on a set — additive, does not disturb key-less payloads', async () => {
    const setsWithKey = { meta: { component_sets: [
      { node_id: '10:1', key: 'set-key', name: 'Button', description: 'Primary action', containing_frame: { pageName: 'Actions' } },
    ] } };
    const componentsWithKey = { meta: { components: [
      { node_id: '10:2', key: 'variant-key-default', name: 'State=Default', containing_frame: { pageName: 'Actions', containingStateGroup: { nodeId: '10:1', name: 'Button' } } },
      { node_id: '10:3', key: 'variant-key-disabled', name: 'State=Disabled', containing_frame: { pageName: 'Actions', containingStateGroup: { nodeId: '10:1', name: 'Button' } } },
      { node_id: '11:1', key: 'avatar-key', name: 'Avatar', description: '', containing_frame: { pageName: 'People' } },
    ] } };
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === '/v1/files/A') return { body: fileA };
      if (url.pathname === '/v1/files/A/component_sets') return { body: setsWithKey };
      if (url.pathname === '/v1/files/A/components') return { body: componentsWithKey };
      if (url.pathname === '/v1/files/A/nodes') return { body: nodesA };
      return { status: 404, body: {} };
    });
    const snapshot = await buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A/Core', fileKey: 'A' }],
      deps: { fetch },
    });
    const [file] = snapshot.files;
    expect(file!.components).toEqual([
      { nodeId: '10:1', name: 'Button', description: 'Primary action', page: 'Actions', key: 'set-key', properties: [
        { name: 'State', type: 'VARIANT', values: ['Default', 'Disabled'] },
        { name: 'Label', type: 'TEXT', values: ['Continue'] },
        { name: 'Show icon', type: 'BOOLEAN', values: [] },
      ], variants: [
        { nodeId: '10:2', key: 'variant-key-default', name: 'State=Default' },
        { nodeId: '10:3', key: 'variant-key-disabled', name: 'State=Disabled' },
      ] },
      { nodeId: '11:1', name: 'Avatar', page: 'People', key: 'avatar-key', properties: [] },
    ]);
  });
});
