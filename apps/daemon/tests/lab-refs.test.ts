// ds-lab / lab-refs (WP-lab-refs-daemon — .tmp/pipeline/wp-lab-refs-daemon.yaml)
// red-spec: pure module (parseFigmaPageLink/detectConceptsFromPage) +
// fs-boundary module (readLabRefs/writeLabRefs/scanLabRefs).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  conceptPngRel,
  conceptSlug,
  detectConceptsFromPage,
  parseFigmaPageLink,
  readLabRefs,
  scanLabRefs,
  writeLabRefs,
  LAB_REFS_DIR_REL,
  LAB_REFS_FILE_REL,
  type RefsFile,
} from '../src/lab-refs.js';
import { registerFigmaBuildRoutes } from '../src/figma-build-routes.js';

// registerFigmaBuildRoutes imports db.js for OTHER routes in the same file
// (figma-build job, figma-preview) — mock it out so this file doesn't need a
// real SQLite instance (same shape as figma-build.test.ts's mock).
vi.mock('../src/db.js', () => ({
  getProject: (_db: unknown, id: string) => ({ id, name: id, metadata: undefined }),
  getPipelineApp: () => null,
  getFigmaDesignSystemSource: () => null,
  insertConversation: () => undefined,
  upsertMessage: () => undefined,
}));

// ── path constants ───────────────────────────────────────────────────────

describe('path constants', () => {
  it('match the docblock claims', () => {
    expect(LAB_REFS_DIR_REL).toBe('refs');
    expect(LAB_REFS_FILE_REL).toBe('refs/refs.json');
  });
});

// ── parseFigmaPageLink ───────────────────────────────────────────────────

describe('parseFigmaPageLink', () => {
  it('parses a "design" link with node-id, dash-form → colon-form', () => {
    const parsed = parseFigmaPageLink('https://www.figma.com/design/ABC123/My-File?node-id=123-456');
    expect(parsed).toEqual({
      fileKey: 'ABC123',
      nodeId: '123:456',
      url: 'https://www.figma.com/design/ABC123/?node-id=123-456',
    });
  });

  it('parses a "file" link with node-id', () => {
    const parsed = parseFigmaPageLink('https://figma.com/file/XYZ789/Other?node-id=1-2&t=abc');
    expect(parsed).toEqual({
      fileKey: 'XYZ789',
      nodeId: '1:2',
      url: 'https://www.figma.com/design/XYZ789/?node-id=1-2',
    });
  });

  it('missing node-id → null (a page link always carries one)', () => {
    expect(parseFigmaPageLink('https://www.figma.com/design/ABC123/My-File')).toBeNull();
  });

  it('not a Figma link, malformed URL, or blank → null', () => {
    expect(parseFigmaPageLink('https://example.com/design/ABC123?node-id=1-2')).toBeNull();
    expect(parseFigmaPageLink('not a url')).toBeNull();
    expect(parseFigmaPageLink('')).toBeNull();
    expect(parseFigmaPageLink('   ')).toBeNull();
  });

  it('a node-id not shaped like "<num>-<num>" → null', () => {
    expect(parseFigmaPageLink('https://www.figma.com/design/ABC123/File?node-id=abc')).toBeNull();
  });
});

// ── detectConceptsFromPage ───────────────────────────────────────────────

describe('detectConceptsFromPage', () => {
  it('node not CANVAS → ok:false, detail "link không phải page"', () => {
    const result = detectConceptsFromPage({ id: '1:1', type: 'FRAME', name: 'Not a page' });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('link không phải page');
    expect(result.candidates).toEqual([]);
  });

  it('top-level FRAME/COMPONENT/COMPONENT_SET/INSTANCE are concepts; a SECTION contributes its direct frame children; a hidden node and an unrelated type are excluded', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'Concepts',
      children: [
        { id: '1:1', type: 'FRAME', name: 'Màn A', absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 } },
        { id: '1:2', type: 'FRAME', name: 'Ẩn', visible: false },
        { id: '1:3', type: 'TEXT', name: 'Ghi chú' },
        {
          id: '1:4',
          type: 'SECTION',
          name: 'Nhóm',
          children: [
            { id: '1:5', type: 'FRAME', name: 'Màn B' },
            { id: '1:6', type: 'COMPONENT', name: 'Comp con' },
            { id: '1:7', type: 'FRAME', name: 'Ẩn trong section', visible: false },
            { id: '1:8', type: 'TEXT', name: 'Không phải concept' },
          ],
        },
        { id: '1:9', type: 'COMPONENT_SET', name: 'Set C' },
        { id: '1:10', type: 'INSTANCE', name: 'Instance D' },
      ],
    };
    const result = detectConceptsFromPage(pageDoc);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.candidates.map((c) => c.nodeId)).toEqual(['1:1', '1:5', '1:6', '1:9', '1:10']);
    expect(result.candidates[0]).toEqual({ nodeId: '1:1', name: 'Màn A', width: 390, height: 844 });
  });

  it('a hidden SECTION excludes all of its children too', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'P',
      children: [{ id: '1:4', type: 'SECTION', name: 'Nhóm ẩn', visible: false, children: [{ id: '1:5', type: 'FRAME', name: 'X' }] }],
    };
    expect(detectConceptsFromPage(pageDoc).candidates).toEqual([]);
  });

  it('caps at 40 concepts/page with a warning naming the page and the real count', () => {
    const children = Array.from({ length: 45 }, (_, i) => ({ id: `1:${i}`, type: 'FRAME', name: `Màn ${i}` }));
    const pageDoc = { id: '0:1', type: 'CANVAS', name: 'Trang lớn', children };
    const result = detectConceptsFromPage(pageDoc);
    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBe(40);
    expect(result.candidates.map((c) => c.nodeId)).toEqual(children.slice(0, 40).map((c) => c.id));
    expect(result.warning).toBe('trang Trang lớn có 45 frame, chỉ lấy 40 đầu');
  });

  it('exactly 40 concepts → no warning', () => {
    const children = Array.from({ length: 40 }, (_, i) => ({ id: `1:${i}`, type: 'FRAME', name: `Màn ${i}` }));
    const result = detectConceptsFromPage({ id: '0:1', type: 'CANVAS', name: 'P', children });
    expect(result.warning).toBeUndefined();
    expect(result.candidates.length).toBe(40);
  });

  it('a top-level node missing "id" or "name" is skipped, not crashed on', () => {
    const pageDoc = {
      id: '0:1',
      type: 'CANVAS',
      name: 'P',
      children: [{ type: 'FRAME' }, { id: '1:1', type: 'FRAME' }, { id: '1:2', type: 'FRAME', name: 'OK' }],
    };
    expect(detectConceptsFromPage(pageDoc).candidates).toEqual([{ nodeId: '1:2', name: 'OK' }]);
  });
});

// ── conceptSlug / conceptPngRel ──────────────────────────────────────────

describe('conceptSlug / conceptPngRel', () => {
  it('builds a stable "refs/<fileKey>-<nodeId>.png" path, replacing ":" with "-"', () => {
    expect(conceptSlug('ABC123', '1:2')).toBe('ABC123-1-2');
    expect(conceptPngRel('ABC123', '1:2')).toBe('refs/ABC123-1-2.png');
  });
});

// ── readLabRefs / writeLabRefs ───────────────────────────────────────────

describe('readLabRefs / writeLabRefs', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('missing refs.json → default empty registry, no scannedAt field', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    const refs = await readLabRefs(root);
    expect(refs).toEqual({ schema_version: 1, pages: [], concepts: [] });
    expect('scannedAt' in refs).toBe(false);
  });

  it('corrupted JSON, or valid JSON missing pages/concepts arrays → same default (fail-soft, never throws)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    await mkdir(path.join(root, 'refs'), { recursive: true });
    await writeFile(path.join(root, 'refs', 'refs.json'), '{not json', 'utf8');
    expect(await readLabRefs(root)).toEqual({ schema_version: 1, pages: [], concepts: [] });

    await writeFile(path.join(root, 'refs', 'refs.json'), JSON.stringify({ schema_version: 1 }), 'utf8');
    expect(await readLabRefs(root)).toEqual({ schema_version: 1, pages: [], concepts: [] });
  });

  it('round-trips a written registry, including scannedAt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-'));
    roots.push(root);
    const refs: RefsFile = {
      schema_version: 1,
      scannedAt: '2026-08-24T00:00:00.000Z',
      pages: [{ url: 'https://www.figma.com/design/F/?node-id=1-2', fileKey: 'F', nodeId: '1:2', ok: true, name: 'Trang' }],
      concepts: [{ id: 'F:1:2', fileKey: 'F', nodeId: '1:2', name: 'Màn A', png: 'refs/F-1-2.png' }],
    };
    await writeLabRefs(root, refs);
    expect(await readLabRefs(root)).toEqual(refs);
    const onDisk = JSON.parse(await readFile(path.join(root, 'refs', 'refs.json'), 'utf8'));
    expect(onDisk).toEqual(refs);
  });
});

// ── scanLabRefs ──────────────────────────────────────────────────────────

function fakeRestFetch(routes: {
  nodes?: (url: URL) => { status?: number; body?: unknown };
  images?: (url: URL) => { status?: number; body?: unknown };
  png?: (url: URL) => { status?: number; body?: Buffer };
}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === 'api.figma.com') {
      if (url.pathname.includes('/nodes')) {
        const out = routes.nodes?.(url) ?? { body: { nodes: {} } };
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.startsWith('/v1/images/')) {
        const out = routes.images?.(url) ?? { body: { images: {} } };
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
    }
    // PNG "S3" download.
    const out = routes.png?.(url) ?? { body: Buffer.from('fake-png') };
    return new Response(out.body ?? Buffer.from('fake-png'), { status: out.status ?? 200 });
  };
}

describe('scanLabRefs', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('an invalid link (no node-id) → page row ok:false, no throw, nothing else affected', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const fetchImpl = fakeRestFetch({});
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/File', fileKey: '', nodeId: '', ok: false, detail: expect.stringContaining('Link không hợp lệ') },
    ]);
    expect(refs.concepts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a page REST 403 → page row ok:false, detail via describeFigmaError, does not throw', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ status: 403, body: { status: 403, err: 'Not authorized' } }),
    });
    const { refs } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.pages).toEqual([
      { url: 'https://www.figma.com/design/ABC/?node-id=1-2', fileKey: 'ABC', nodeId: '1:2', ok: false, detail: expect.any(String) },
    ]);
    expect(refs.pages[0]!.detail).toContain('quyền');
  });

  it('a valid page with concepts: downloads PNGs to refs/<slug>.png, writes refs.json, and one concept whose image 404s keeps the concept with an empty png + a warning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    const pageDoc = {
      id: '1:2',
      type: 'CANVAS',
      name: 'Trang concept',
      children: [
        { id: '1:3', type: 'FRAME', name: 'Màn A' },
        { id: '1:4', type: 'FRAME', name: 'Màn B' },
      ],
    };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: () => ({ body: { images: { '1:3': 'https://s3.example.com/a.png', '1:4': null } } }),
      png: () => ({ body: Buffer.from('PNGDATA') }),
    });
    const { refs, warnings } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/ABC/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch, now: () => new Date('2026-08-24T00:00:00.000Z') },
    });
    expect(refs.pages).toEqual([{ url: 'https://www.figma.com/design/ABC/?node-id=1-2', fileKey: 'ABC', nodeId: '1:2', ok: true, name: 'Trang concept' }]);
    expect(refs.concepts).toEqual([
      { id: 'ABC:1:3', fileKey: 'ABC', nodeId: '1:3', name: 'Màn A', png: 'refs/ABC-1-3.png' },
      { id: 'ABC:1:4', fileKey: 'ABC', nodeId: '1:4', name: 'Màn B', png: '' },
    ]);
    expect(warnings.some((w) => w.includes('Màn B'))).toBe(true);
    const written = await readFile(path.join(root, 'refs', 'ABC-1-3.png'));
    expect(written.toString()).toBe('PNGDATA');
    expect(refs.scannedAt).toBe('2026-08-24T00:00:00.000Z');
    // refs.json persisted on disk, matching the returned value.
    const onDisk = JSON.parse(await readFile(path.join(root, 'refs', 'refs.json'), 'utf8'));
    expect(onDisk).toEqual(refs);
  });

  it('re-scanning overwrites refs.json entirely and deletes a stale PNG no longer in the new concept list', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    await mkdir(path.join(root, 'refs'), { recursive: true });
    await writeFile(path.join(root, 'refs', 'STALE-9-9.png'), 'old', 'utf8');
    await writeFile(
      path.join(root, 'refs', 'refs.json'),
      JSON.stringify({ schema_version: 1, pages: [{ url: 'old', fileKey: 'OLD', nodeId: '9:9', ok: true }], concepts: [{ id: 'OLD:9:9', fileKey: 'OLD', nodeId: '9:9', name: 'Cũ', png: 'refs/STALE-9-9.png' }] }),
      'utf8',
    );
    const pageDoc = { id: '1:2', type: 'CANVAS', name: 'Trang mới', children: [{ id: '1:3', type: 'FRAME', name: 'Màn mới' }] };
    const fetchImpl = fakeRestFetch({
      nodes: () => ({ body: { nodes: { '1:2': { document: pageDoc } } } }),
      images: () => ({ body: { images: { '1:3': 'https://s3.example.com/a.png' } } }),
    });
    const { refs } = await scanLabRefs({
      labCwd: root,
      links: ['https://www.figma.com/design/NEW/File?node-id=1-2'],
      token: 'tok',
      deps: { fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(refs.concepts.map((c) => c.id)).toEqual(['NEW:1:3']);
    await expect(readFile(path.join(root, 'refs', 'STALE-9-9.png'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'refs', 'NEW-1-3.png'))).toBeTruthy();
  });

  it('never throws even when every single link is bad', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ds-lab-refs-scan-'));
    roots.push(root);
    await expect(
      scanLabRefs({ labCwd: root, links: ['not a link', ''], token: 'tok', deps: { fetch: fakeRestFetch({}) as unknown as typeof fetch } }),
    ).resolves.toBeDefined();
  });
});

// ── HTTP routes: GET/PUT /api/projects/:projectId/ds-lab/lab-refs ─────────

type Handler = (req: any, res: any) => unknown;

function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = { status(code: number) { output.status = code; return res; }, json(body: unknown) { output.body = body; return res; } };
  return { output, res };
}

function register(dataDir: string) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
    put(route: string, handler: Handler) { handlers.set(`PUT ${route}`, handler); },
  };
  registerFigmaBuildRoutes(app as never, {
    db: { prepare: () => ({ run: () => undefined }) },
    http: { isLocalSameOrigin: () => true, resolvedPortRef: { current: 7456 } },
    paths: { RUNTIME_DATA_DIR: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects') },
    design: { runs: { create: () => ({ id: 'run-1' }), start: () => undefined, wait: async () => ({ status: 'succeeded' }) } },
    chat: { startChatRun: () => undefined },
    agents: {},
  } as never);
  return handlers;
}

describe('ds-lab/lab-refs routes', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('GET before any PUT → default empty registry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('GET /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' } }, r.res);
    expect(r.output.status).toBe(200);
    expect(r.output.body).toEqual({ schema_version: 1, pages: [], concepts: [] });
  });

  it('PUT with no links → 400 INVALID_INPUT (flat error shape)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' }, body: { links: [] } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error).toBe('INVALID_INPUT');
  });

  it('PUT with more than 10 links → 400 INVALID_INPUT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    const links = Array.from({ length: 11 }, (_, i) => `https://www.figma.com/design/F/File?node-id=${i}-1`);
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' }, body: { links } }, r.res);
    expect(r.output.status).toBe(400);
    expect((r.output.body as any).error).toBe('INVALID_INPUT');
  });

  it('PUT without a configured Figma token → 400 FIGMA_TOKEN_REQUIRED (flat error shape per spec)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    const handlers = register(root);
    const r = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!(
      { params: { projectId: 'proj-1' }, body: { links: ['https://www.figma.com/design/F/File?node-id=1-2'] } },
      r.res,
    );
    expect(r.output.status).toBe(400);
    expect(r.output.body).toEqual({ error: 'FIGMA_TOKEN_REQUIRED', detail: 'Chưa cấu hình Figma token trong Cài đặt → Figma.' });
  });

  it('PUT with a token configured scans, persists refs.json, and a subsequent GET returns it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-lab-refs-route-'));
    roots.push(root);
    await writeFile(path.join(root, 'figma-config.json'), JSON.stringify({ token: 'secret-tok' }), 'utf8');
    const pageDoc = { id: '1:2', type: 'CANVAS', name: 'Trang', children: [{ id: '1:3', type: 'FRAME', name: 'Màn A' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.figma.com' && url.pathname.includes('/nodes')) {
          return new Response(JSON.stringify({ nodes: { '1:2': { document: pageDoc } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.hostname === 'api.figma.com' && url.pathname.startsWith('/v1/images/')) {
          return new Response(JSON.stringify({ images: { '1:3': 'https://s3.example.com/a.png' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(Buffer.from('PNGDATA'), { status: 200 });
      }),
    );
    const handlers = register(root);
    const put = response();
    await handlers.get('PUT /api/projects/:projectId/ds-lab/lab-refs')!(
      { params: { projectId: 'proj-1' }, body: { links: ['https://www.figma.com/design/F/File?node-id=1-2'] } },
      put.res,
    );
    expect(put.output.status).toBe(200);
    const body = put.output.body as { refs: RefsFile; warnings: string[] };
    expect(body.refs.concepts).toEqual([{ id: 'F:1:3', fileKey: 'F', nodeId: '1:3', name: 'Màn A', png: 'refs/F-1-3.png' }]);
    // Never leak the token into the response.
    expect(JSON.stringify(body)).not.toContain('secret-tok');

    const get = response();
    await handlers.get('GET /api/projects/:projectId/ds-lab/lab-refs')!({ params: { projectId: 'proj-1' } }, get.res);
    expect((get.output.body as RefsFile).concepts).toEqual(body.refs.concepts);
  });
});
