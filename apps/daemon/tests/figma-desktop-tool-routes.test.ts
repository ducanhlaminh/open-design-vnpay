import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerFigmaDesktopToolRoutes,
  normalizeNodeId,
  type FigmaDesktopLike,
  type FigmaDesktopScope,
} from '../src/figma-desktop-tool-routes.js';
import type { ToolTokenGrant } from '../src/tool-tokens.js';

type Handler = (req: any, res: any) => unknown;

function response() {
  const output: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) { output.status = code; return res; },
    json(body: unknown) { output.body = body; return res; },
  };
  return { output, res };
}

function grant(overrides: Partial<ToolTokenGrant> = {}): ToolTokenGrant {
  return {
    token: 'token',
    runId: 'run-1',
    projectId: 'project-1',
    allowedEndpoints: [],
    allowedOperations: [],
    issuedAt: new Date(0).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
    ...overrides,
  };
}

function fakeDesktop(overrides: Partial<FigmaDesktopLike> = {}): FigmaDesktopLike {
  return {
    probe: async () => ({ ok: true }),
    callTool: async () => ({ text: 'ok', images: [] }),
    activeFileTitle: async () => null,
    ensureActiveFile: async () => 'switched',
    ...overrides,
  };
}

function register(options: {
  desktop: FigmaDesktopLike;
  resolveScope: (projectId: string) => Promise<FigmaDesktopScope | null>;
  sameOrigin?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  denyAuth?: boolean;
}) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(route: string, handler: Handler) { handlers.set(`GET ${route}`, handler); },
    post(route: string, handler: Handler) { handlers.set(`POST ${route}`, handler); },
  };
  registerFigmaDesktopToolRoutes(app as never, {
    auth: {
      authorizeToolRequest: (_req: any, res: any, operation: string) => {
        if (options.denyAuth) {
          res.status(401).json({ error: { code: 'TOOL_TOKEN_INVALID', message: 'invalid token', details: { operation } } });
          return null;
        }
        return grant();
      },
    },
    http: {
      sendApiError: (res: any, status: number, code: string, message: string, extras: Record<string, unknown> = {}) => {
        res.status(status).json({ error: { code, message, ...extras } });
      },
      isLocalSameOrigin: () => options.sameOrigin ?? true,
      resolvedPortRef: { current: 7456 },
    },
    figma: {
      desktop: options.desktop,
      resolveScope: options.resolveScope,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  } as never);
  return handlers;
}

function call(handler: Handler, body: Record<string, unknown>) {
  const { output, res } = response();
  const req = { body, path: '/api/tools/figma/design-context', get: () => undefined };
  const promise = Promise.resolve(handler(req, res));
  return { promise, output };
}

async function auditLines(cwd: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path.join(cwd, '.figma-catalog', 'desktop-audit.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') return [];
    throw error;
  }
}

describe('figma desktop tool routes', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function freshCwd(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'od-figma-desktop-routes-'));
    roots.push(root);
    return root;
  }

  describe('GET /api/figma-desktop/status', () => {
    it('available:true payload shape', async () => {
      const desktop = fakeDesktop({
        probe: async () => ({ ok: true }),
        activeFileTitle: async () => '[Lib v1.0] Design Kit',
      });
      const handlers = register({ desktop, resolveScope: async () => null, platform: 'darwin' });
      const { output, res } = response();
      await handlers.get('GET /api/figma-desktop/status')!({}, res);
      expect(output).toEqual({
        status: 200,
        body: {
          available: true,
          activeFileTitle: '[Lib v1.0] Design Kit',
          canSwitch: true,
          platform: 'darwin',
        },
      });
    });

    it('available:false payload includes detail', async () => {
      const desktop = fakeDesktop({ probe: async () => ({ ok: false, detail: 'Figma Desktop không chạy.' }) });
      const handlers = register({ desktop, resolveScope: async () => null, platform: 'darwin' });
      const { output, res } = response();
      await handlers.get('GET /api/figma-desktop/status')!({}, res);
      expect(output.status).toBe(200);
      expect(output.body).toMatchObject({ available: false, detail: 'Figma Desktop không chạy.', canSwitch: true });
    });

    it('rejects cross-origin requests with 403', async () => {
      const desktop = fakeDesktop();
      const handlers = register({ desktop, resolveScope: async () => null, sameOrigin: false });
      const { output, res } = response();
      await handlers.get('GET /api/figma-desktop/status')!({}, res);
      expect(output.status).toBe(403);
    });
  });

  describe('POST /api/tools/figma/design-context', () => {
    it('calls ensureActiveFile with the matching scope entry then get_design_context, and audits ok:true', async () => {
      const cwd = await freshCwd();
      const ensureActiveFileCalls: unknown[] = [];
      const callToolCalls: unknown[] = [];
      const desktop = fakeDesktop({
        ensureActiveFile: async (expect) => {
          ensureActiveFileCalls.push(expect);
          return 'switched';
        },
        callTool: async (name, args) => {
          callToolCalls.push({ name, args });
          return { text: '<div>hello component</div>', images: [] };
        },
      });
      const scope: FigmaDesktopScope = {
        cwd,
        files: [{ fileKey: 'DCFILE01', name: 'Design Kit', probeNodeId: '5:5' }],
      };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;

      const { promise, output } = call(handler, { fileKey: 'DCFILE01', nodeId: '10-1' });
      await promise;

      expect(output.status).toBe(200);
      expect(output.body).toEqual({
        ok: true,
        tool: 'design-context',
        fileKey: 'DCFILE01',
        nodeId: '10:1',
        switched: 'switched',
        cached: false,
        text: '<div>hello component</div>',
      });
      expect(ensureActiveFileCalls).toEqual([{ fileKey: 'DCFILE01', name: 'Design Kit', probeNodeId: '5:5' }]);
      expect(callToolCalls).toEqual([{ name: 'get_design_context', args: { nodeId: '10:1', clientLanguages: 'unknown', clientFrameworks: 'unknown' } }]);

      const lines = await auditLines(cwd);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ ok: true, fileKey: 'DCFILE01', nodeId: '10:1', tool: 'design-context', cached: false });
    });

    it('second call with the same key hits the cache without calling desktop again', async () => {
      const cwd = await freshCwd();
      let ensureActiveFileCallCount = 0;
      let callToolCallCount = 0;
      const desktop = fakeDesktop({
        ensureActiveFile: async () => {
          ensureActiveFileCallCount += 1;
          return 'switched';
        },
        callTool: async () => {
          callToolCallCount += 1;
          return { text: 'cache-me', images: [] };
        },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'CACHEFILE' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;

      const first = call(handler, { fileKey: 'CACHEFILE', nodeId: '20:2' });
      await first.promise;
      expect(first.output.body).toMatchObject({ cached: false, switched: 'switched' });

      const second = call(handler, { fileKey: 'CACHEFILE', nodeId: '20:2' });
      await second.promise;
      expect(second.output.body).toEqual({
        ok: true,
        tool: 'design-context',
        fileKey: 'CACHEFILE',
        nodeId: '20:2',
        switched: 'already',
        cached: true,
        text: 'cache-me',
      });

      expect(ensureActiveFileCallCount).toBe(1);
      expect(callToolCallCount).toBe(1);

      const lines = await auditLines(cwd);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ ok: true, cached: true });
    });

    it('denies a fileKey outside the resolved scope, does not call desktop, and audits ok:false', async () => {
      const cwd = await freshCwd();
      let desktopCalled = false;
      const desktop = fakeDesktop({
        ensureActiveFile: async () => { desktopCalled = true; return 'switched'; },
        callTool: async () => { desktopCalled = true; return { text: '', images: [] }; },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'ALLOWEDKEY' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;

      const { promise, output } = call(handler, { fileKey: 'DENIEDKEY', nodeId: '10:1' });
      await promise;

      expect(output.status).toBe(403);
      expect((output.body as any).error.code).toBe('FIGMA_FILE_DENIED');
      expect(desktopCalled).toBe(false);

      const lines = await auditLines(cwd);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ ok: false });
      expect((lines[0]!.error as any).code).toBe('FIGMA_FILE_DENIED');
    });

    it('404s when the project has no figma scope configured', async () => {
      const handlers = register({ desktop: fakeDesktop(), resolveScope: async () => null });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;
      const { promise, output } = call(handler, { fileKey: 'ANYKEY01', nodeId: '10:1' });
      await promise;
      expect(output.status).toBe(404);
      expect((output.body as any).error.code).toBe('FIGMA_SCOPE_NOT_FOUND');
    });

    it('400s on an invalid nodeId', async () => {
      const scope: FigmaDesktopScope = { cwd: await freshCwd(), files: [{ fileKey: 'ANYKEY01' }] };
      const handlers = register({ desktop: fakeDesktop(), resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;
      const { promise, output } = call(handler, { fileKey: 'ANYKEY01', nodeId: 'abc' });
      await promise;
      expect(output.status).toBe(400);
      expect((output.body as any).error.code).toBe('INVALID_INPUT');
    });

    it('returns early with nothing written when authorizeToolRequest denies the request', async () => {
      const cwd = await freshCwd();
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'ANYKEY01' }] };
      const handlers = register({ desktop: fakeDesktop(), resolveScope: async () => scope, denyAuth: true });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;
      const { promise, output } = call(handler, { fileKey: 'ANYKEY01', nodeId: '10:1' });
      await promise;
      expect(output.status).toBe(401);
      const lines = await auditLines(cwd);
      expect(lines).toHaveLength(0);
    });

    it('maps a desktop "unavailable" error to 503', async () => {
      const cwd = await freshCwd();
      const desktop = fakeDesktop({
        ensureActiveFile: async () => { throw { kind: 'unavailable', message: 'Figma Desktop không chạy.' }; },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'UNAVAILKY' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;
      const { promise, output } = call(handler, { fileKey: 'UNAVAILKY', nodeId: '10:1' });
      await promise;
      expect(output.status).toBe(503);
      expect((output.body as any).error.code).toBe('FIGMA_DESKTOP_UNAVAILABLE');
      const lines = await auditLines(cwd);
      expect(lines[0]).toMatchObject({ ok: false, error: { code: 'FIGMA_DESKTOP_UNAVAILABLE' } });
    });

    it('maps a desktop "switch_timeout" error to 504', async () => {
      const cwd = await freshCwd();
      const desktop = fakeDesktop({
        ensureActiveFile: async () => { throw { kind: 'switch_timeout', message: 'timed out switching file' }; },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'TIMEOUTKY' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;
      const { promise, output } = call(handler, { fileKey: 'TIMEOUTKY', nodeId: '10:1' });
      await promise;
      expect(output.status).toBe(504);
      expect((output.body as any).error.code).toBe('FIGMA_SWITCH_TIMEOUT');
    });
  });

  describe('POST /api/tools/figma/screenshot', () => {
    it('writes the screenshot to .figma-catalog/shots/<fileKey>/<nodeId>.png and caches by file existence', async () => {
      const cwd = await freshCwd();
      const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
      let callToolCallCount = 0;
      const desktop = fakeDesktop({
        callTool: async () => {
          callToolCallCount += 1;
          return { text: '', images: [{ mimeType: 'image/png', data: pngBase64 }] };
        },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'SHOTKEY01' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/screenshot')!;

      const first = call(handler, { fileKey: 'SHOTKEY01', nodeId: '10:1' });
      await first.promise;
      expect(first.output.status).toBe(200);
      expect(first.output.body).toMatchObject({
        ok: true,
        tool: 'screenshot',
        fileKey: 'SHOTKEY01',
        nodeId: '10:1',
        cached: false,
        path: '.figma-catalog/shots/SHOTKEY01/10-1.png',
        mimeType: 'image/png',
      });
      const writtenBytes = await readFile(path.join(cwd, '.figma-catalog/shots/SHOTKEY01/10-1.png'));
      expect(writtenBytes.equals(Buffer.from(pngBase64, 'base64'))).toBe(true);

      const second = call(handler, { fileKey: 'SHOTKEY01', nodeId: '10:1' });
      await second.promise;
      expect(second.output.body).toMatchObject({ cached: true, switched: 'already', path: '.figma-catalog/shots/SHOTKEY01/10-1.png' });
      expect(callToolCallCount).toBe(1);
    });
  });

  describe('mutex', () => {
    it('serializes two concurrent calls so the second ensureActiveFile only starts after the first finishes', async () => {
      const cwd = await freshCwd();
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const desktop = fakeDesktop({
        ensureActiveFile: async (expectFile) => {
          order.push(`ensure:${expectFile.fileKey}`);
          if (expectFile.fileKey === 'MUTEXFILEA') {
            await firstGate;
          }
          return 'switched';
        },
        callTool: async () => {
          order.push('callTool');
          return { text: 'ok', images: [] };
        },
      });
      const scope: FigmaDesktopScope = { cwd, files: [{ fileKey: 'MUTEXFILEA' }, { fileKey: 'MUTEXFILEB' }] };
      const handlers = register({ desktop, resolveScope: async () => scope });
      const handler = handlers.get('POST /api/tools/figma/design-context')!;

      const first = call(handler, { fileKey: 'MUTEXFILEA', nodeId: '1:1' });
      // Let call 1's handler run up through entering the mutex-protected task.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = call(handler, { fileKey: 'MUTEXFILEB', nodeId: '2:2' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Call 2 must not have started its ensureActiveFile yet — call 1 is
      // still blocked on firstGate inside the mutex.
      expect(order).toEqual(['ensure:MUTEXFILEA']);

      releaseFirst();
      await Promise.all([first.promise, second.promise]);

      expect(order).toEqual(['ensure:MUTEXFILEA', 'callTool', 'ensure:MUTEXFILEB', 'callTool']);
    });
  });

  describe('normalizeNodeId', () => {
    it('normalizes and validates node ids', () => {
      expect(normalizeNodeId('10-1')).toBe('10:1');
      expect(normalizeNodeId('10:1')).toBe('10:1');
      expect(normalizeNodeId('I10:1;20:2')).toBe('I10:1;20:2');
      expect(normalizeNodeId('x')).toBeNull();
      expect(normalizeNodeId('')).toBeNull();
    });
  });
});
