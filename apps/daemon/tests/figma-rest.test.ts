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

  it('maps auth/forbidden/not-found/timeout to Vietnamese guidance', async () => {
    const auth = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Invalid token' } }));
    await expect(figmaWhoAmI('tok', { fetch: auth.fetch })).rejects.toMatchObject({ kind: 'auth' });
    const forbidden = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Not allowed' } }));
    const row = await verifyFigmaLink('tok', { url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }, { fetch: forbidden.fetch });
    expect(row).toMatchObject({ ok: false });
    expect(row.detail).toMatch(/không có quyền/i);
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

  it('verifyFigmaLink counts sets + standalone components owned by the file and flags remote-only files', async () => {
    const own = fakeFetch(() => ({ body: fileA }));
    await expect(verifyFigmaLink('tok', { url: 'https://www.figma.com/design/A', fileKey: 'A' }, { fetch: own.fetch }))
      .resolves.toEqual({ fileKey: 'A', url: 'https://www.figma.com/design/A', ok: true, name: 'Core UI Kit', componentCount: 2 });
    expect(own.calls).toEqual(['/v1/files/A?depth=1']);

    const remoteOnly = fakeFetch(() => ({ body: { name: 'Checkout screens', components: { '1:1': { name: 'Lib/Button', remote: true } }, componentSets: {} } }));
    const row = await verifyFigmaLink('tok', { url: 'https://www.figma.com/design/B', fileKey: 'B' }, { fetch: remoteOnly.fetch });
    expect(row).toMatchObject({ ok: false, remoteOnly: true, componentCount: 0, name: 'Checkout screens' });
    expect(row.detail).toMatch(/thư viện gốc/);
  });

  it('builds a frozen snapshot: properties per entry, variants collapsed, page names best-effort, progress in order', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/files/A') return { body: fileA };
      if (url.pathname === '/v1/files/A/nodes') {
        expect(url.searchParams.get('ids')).toBe('10:1,11:1');
        return { body: nodesA };
      }
      if (url.pathname === '/v1/files/A/components') {
        return { body: { meta: { components: [{ node_id: '10:2', containing_frame: { pageName: 'Actions' } }, { node_id: '11:1', containing_frame: { pageName: 'People' } }] } } };
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
    expect(calls).toEqual(['/v1/files/A?depth=1', '/v1/files/A/nodes?ids=10%3A1%2C11%3A1&depth=1', '/v1/files/A/components']);
    expect(snapshot.generatedAt).toBe('2026-08-16T00:00:00.000Z');
    expect(snapshot.files).toHaveLength(1);
    const [file] = snapshot.files;
    expect(file).toMatchObject({ fileKey: 'A', name: 'Core UI Kit', url: 'https://www.figma.com/design/A/Core' });
    expect(file!.components).toEqual([
      { nodeId: '10:1', name: 'Button', description: 'Primary action', properties: [
        { name: 'State', type: 'VARIANT', values: ['Default', 'Disabled'] },
        { name: 'Label', type: 'TEXT', values: ['Continue'] },
        { name: 'Show icon', type: 'BOOLEAN', values: [] },
      ] },
      { nodeId: '11:1', name: 'Avatar', page: 'People', properties: [] },
    ]);
  });

  it('fails the whole read on the first unreadable file, naming it', async () => {
    const { fetch } = fakeFetch((url) => (url.pathname === '/v1/files/A'
      ? { body: fileA }
      : url.pathname === '/v1/files/A/nodes' ? { body: nodesA }
        : url.pathname === '/v1/files/A/components' ? { status: 403, body: {} }
          : { status: 403, body: { err: 'Not allowed' } }));
    await expect(buildFigmaComponentCatalog({
      token: 'tok',
      links: [{ url: 'https://www.figma.com/design/A', fileKey: 'A' }, { url: 'https://www.figma.com/design/B', fileKey: 'B' }],
      deps: { fetch },
    })).rejects.toThrow(/File 2\/2 \(B\): .*không có quyền/i);
  });
});
