import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFigmaConfig, writeFigmaConfig } from '../src/figma-config.js';
import { registerFigmaConfigRoutes } from '../src/figma-config-routes.js';

type Handler = (req: any, res: any) => unknown;

function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) { output.status = code; return res; },
    json(body: unknown) { output.body = body; return res; },
  };
  return { output, res };
}

function register(dataDir: string, sameOrigin = true) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    put(route: string, handler: Handler) { handlers.set(`PUT ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
  };
  registerFigmaConfigRoutes(app as never, {
    http: { isLocalSameOrigin: () => sameOrigin, resolvedPortRef: { current: 7456 } },
    paths: { RUNTIME_DATA_DIR: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects') },
  } as never);
  return handlers;
}

describe('figma-config store', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('saves, keeps on empty token, and clears explicitly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-config-'));
    roots.push(root);
    await expect(readFigmaConfig(root)).resolves.toBeNull();
    await expect(writeFigmaConfig(root, { token: '  figd_abc ' })).resolves.toEqual({ token: 'figd_abc' });
    await expect(writeFigmaConfig(root, { token: '' })).resolves.toEqual({ token: 'figd_abc' });
    await expect(writeFigmaConfig(root, {})).resolves.toEqual({ token: 'figd_abc' });
    expect(JSON.parse(await readFile(path.join(root, 'figma-config.json'), 'utf8'))).toEqual({ token: 'figd_abc' });
    await expect(writeFigmaConfig(root, { clear: true })).resolves.toBeNull();
    await expect(readFigmaConfig(root)).resolves.toBeNull();
  });

  it('GET never leaks the token; PUT reports hasToken; same-origin enforced', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-config-'));
    roots.push(root);
    const handlers = register(root);
    const put = response();
    await handlers.get('PUT /api/figma-config')!({ body: { token: 'figd_secret' } }, put.res);
    expect(put.output).toEqual({ status: 200, body: { hasToken: true } });
    const get = response();
    await handlers.get('GET /api/figma-config')!({}, get.res);
    expect(get.output).toEqual({ status: 200, body: { hasToken: true } });
    expect(JSON.stringify(get.output.body)).not.toContain('figd_secret');
    const denied = response();
    await register(root, false).get('GET /api/figma-config')!({}, denied.res);
    expect(denied.output.status).toBe(403);
  });

  it('POST /test uses the incoming token before the saved one; /verify-links reads each file with the saved token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-config-'));
    roots.push(root);
    await writeFigmaConfig(root, { token: 'saved-token' });
    const seenTokens: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seenTokens.push((init?.headers as Record<string, string>)['X-Figma-Token'] ?? '');
      if (url.pathname === '/v1/me') return new Response(JSON.stringify({ handle: 'anh' }), { status: 200 });
      if (url.pathname === '/v1/files/ABC') return new Response(JSON.stringify({ name: 'Kit', document: { children: [] } }), { status: 200 });
      if (url.pathname === '/v1/files/ABC/component_sets') return new Response(JSON.stringify({ meta: { component_sets: [{ node_id: '1:1', name: 'Button' }] } }), { status: 200 });
      if (url.pathname === '/v1/files/ABC/components') return new Response(JSON.stringify({ meta: { components: [] } }), { status: 200 });
      return new Response(JSON.stringify({ status: 404, err: 'Not found' }), { status: 404 });
    }));
    const handlers = register(root);

    const test = response();
    await handlers.get('POST /api/figma-config/test')!({ body: { token: 'typed-token' } }, test.res);
    expect(test.output.body).toEqual({ ok: true, handle: 'anh' });
    expect(seenTokens.at(-1)).toBe('typed-token');

    const verify = response();
    await handlers.get('POST /api/figma-config/verify-links')!({ body: { links: [
      { url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' },
      { url: 'https://www.figma.com/design/ZZZ', fileKey: 'ZZZ' },
      { url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }, // duplicate dropped
    ] } }, verify.res);
    expect(seenTokens.slice(1)).toEqual(['saved-token', 'saved-token', 'saved-token', 'saved-token']);
    expect(verify.output.body).toMatchObject({ hasToken: true, links: [
      { fileKey: 'ABC', ok: true, name: 'Kit', componentCount: 1 },
      { fileKey: 'ZZZ', ok: false },
    ] });
    expect((verify.output.body as any).links).toHaveLength(2);
    expect((verify.output.body as any).links[1].detail).toMatch(/không tìm thấy/i);
  });

  it('POST /test accepts a token whose /v1/me is forbidden (no current_user:read scope)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-config-'));
    roots.push(root);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 403, err: 'Not authorized' }), { status: 403 })));
    const test = response();
    await register(root).get('POST /api/figma-config/test')!({ body: { token: 'file-only-token' } }, test.res);
    expect(test.output.body).toMatchObject({ ok: true });
    expect((test.output.body as any).detail).toMatch(/Token hợp lệ/);
    expect((test.output.body as any).handle).toBeUndefined();
  });

  it('/verify-links without any token answers hasToken=false without calling Figma', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-config-'));
    roots.push(root);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const verify = response();
    await register(root).get('POST /api/figma-config/verify-links')!({ body: { links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }] } }, verify.res);
    expect(verify.output.body).toEqual({ hasToken: false, links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC', ok: false, detail: 'Chưa có token Figma.' }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
