import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  validateComponentRecovery,
  validateFlowRecovery,
  validateReviewRecovery,
} from '../src/pipeline-recovery.js';
import { closeDatabase, insertProject, openDatabase, setProjectPipelineStatus } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'od-pipeline-recovery-'));
});
afterEach(async () => fs.rm(cwd, { recursive: true, force: true }));

describe('multi-turn pipeline recovery finalizers', () => {
  it('rebuilds flows/index.json and refuses an uncovered flow until chat adds a screen mapping', async () => {
    const dir = path.join(cwd, 'flows', 'login');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'as-is.mmd'), 'flowchart TD\n  A[Đăng nhập] --> B[Trang chủ]\n');
    await fs.writeFile(path.join(dir, 'screens.json'), JSON.stringify({ title: 'Đăng nhập', source: 'docs-feature/login.md' }));
    expect((await validateFlowRecovery(cwd)).ok).toBe(false);

    await fs.writeFile(path.join(dir, 'screens.json'), JSON.stringify({
      title: 'Đăng nhập',
      source: 'docs-feature/login.md',
      cells: { A: 'LOGIN' },
      names: { LOGIN: 'Màn hình đăng nhập' },
    }));
    const recovered = await validateFlowRecovery(cwd);
    expect(recovered.ok).toBe(true);
    expect(recovered.repaired).toEqual(['login']);
  });

  it('rebuilds comp/index.json from validated screen + wireframe files, not from a hand-edited index', async () => {
    const key = 'LOGIN';
    const inputs = {
      schema_version: '2.0',
      generatedAt: new Date().toISOString(),
      ds: { components: false, catalog: false, rules: false, examples: false, figmaCatalog: false },
      screens: [{
        key,
        name: 'Đăng nhập',
        order: 0,
        flowId: 'login',
        flowTitle: 'Đăng nhập',
        source: 'docs-feature/login.md',
        steps: [],
        navOut: [],
        navIn: [],
        findings: [],
        platformHint: 'web',
      }],
    };
    await fs.mkdir(path.join(cwd, 'recovery', 'dr-comp'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'recovery', 'dr-comp', 'inputs.json'), JSON.stringify(inputs));
    expect((await validateComponentRecovery(cwd)).ok).toBe(false);

    await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
    await fs.mkdir(path.join(cwd, 'wireframes'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'comp', `${key}.screen.json`), JSON.stringify({
      schema_version: '2.0',
      key,
      name: 'Đăng nhập',
      flowId: 'login',
      platform: 'web',
      source: 'docs-feature/login.md',
      elements: [{ id: 'form', label: 'Form đăng nhập', role: 'form', ds: null, confidence: 'high', provenance: 'text', why: 'Không có DS' }],
      nav: [],
    }));
    await fs.writeFile(
      path.join(cwd, 'wireframes', `${key}.html`),
      '<!doctype html><html><head><style>.x{display:block}</style></head><body data-screen="LOGIN" data-layout="web"><main data-el="form">Form đăng nhập</main></body></html>',
    );
    await fs.mkdir(path.join(cwd, 'flows'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'flows', 'index.json'), JSON.stringify([{
      id: 'login',
      title: 'Đăng nhập',
      source: 'docs-feature/login.md',
      kind: 'mermaid',
      screens: [{ key, name: 'Đăng nhập' }],
      files: { flowchart: 'flows/login.flowchart.json' },
    }]));
    await fs.writeFile(path.join(cwd, 'flows', 'login.flowchart.json'), JSON.stringify({
      id: 'login',
      title: 'Đăng nhập',
      source: 'docs-feature/login.md',
      nodes: [{ id: 'login', type: 'start', label: 'Đăng nhập', screen: key }],
      edges: [],
    }));
    const recovered = await validateComponentRecovery(cwd);
    expect(recovered.ok).toBe(true);
    const index = JSON.parse(await fs.readFile(path.join(cwd, 'comp', 'index.json'), 'utf8'));
    expect(index.screens.map((screen: { key: string }) => screen.key)).toEqual([key]);
    expect(index.failed).toEqual([]);

    // Topology recovery is a deterministic re-check: retain the two valid
    // per-screen outputs, block while DETAIL is unreachable, then pass as soon
    // as evidenced topology is repaired. No component agent fan-out is needed.
    const detail = 'DETAIL';
    const detailInput = {
      ...inputs.screens[0],
      key: detail,
      name: 'Chi tiết',
      order: 1,
    };
    await fs.writeFile(path.join(cwd, 'comp', '_inputs.json'), JSON.stringify({ ...inputs, screens: [...inputs.screens, detailInput] }));
    await fs.writeFile(path.join(cwd, 'comp', `${detail}.screen.json`), JSON.stringify({
      schema_version: '2.0',
      key: detail,
      name: 'Chi tiết',
      flowId: 'login',
      platform: 'web',
      source: 'docs-feature/login.md',
      elements: [{ id: 'detail', label: 'Chi tiết', role: 'content', ds: null, confidence: 'high', provenance: 'text', why: 'Không có DS' }],
      nav: [],
    }));
    await fs.writeFile(
      path.join(cwd, 'wireframes', `${detail}.html`),
      '<!doctype html><html><head><style>.x{display:block}</style></head><body data-screen="DETAIL" data-layout="web"><main data-el="detail">Chi tiết</main></body></html>',
    );
    await fs.writeFile(path.join(cwd, 'flows', 'login.flowchart.json'), JSON.stringify({
      id: 'login',
      title: 'Đăng nhập',
      source: 'docs-feature/login.md',
      nodes: [
        { id: 'login', type: 'start', label: 'Đăng nhập', screen: key },
        { id: 'detail', type: 'action', label: 'Chi tiết', screen: detail },
      ],
      edges: [],
    }));
    const topologyBlocked = await validateComponentRecovery(cwd);
    expect(topologyBlocked.ok).toBe(false);
    expect(topologyBlocked.issues.join('\n')).toContain(detail);
    expect(topologyBlocked.needsHelp).toEqual(expect.arrayContaining([expect.objectContaining({ key: detail })]));
    await expect(fs.access(path.join(cwd, 'recovery', 'dr-comp', 'inputs.json'))).resolves.toBeUndefined();

    await fs.writeFile(path.join(cwd, 'flows', 'login.flowchart.json'), JSON.stringify({
      id: 'login',
      title: 'Đăng nhập',
      source: 'docs-feature/login.md',
      nodes: [
        { id: 'login', type: 'start', label: 'Đăng nhập', screen: key },
        { id: 'detail', type: 'action', label: 'Chi tiết', screen: detail },
      ],
      edges: [{ from: 'login', to: 'detail' }],
    }));
    const topologyRecovered = await validateComponentRecovery(cwd);
    expect(topologyRecovered.ok).toBe(true);
    expect(topologyRecovered.issues).toEqual([]);
    await expect(fs.access(path.join(cwd, 'recovery', 'dr-comp', 'inputs.json'))).rejects.toThrow();
  });

  it('rebuilds review/index.json only when every source page has a valid canonical review output', async () => {
    await fs.mkdir(path.join(cwd, 'docs-feature'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'docs-feature', 'login.md'), '# Đăng nhập\n\nNội dung.\n');
    expect((await validateReviewRecovery(cwd)).ok).toBe(false);

    const reviewDir = path.join(cwd, 'review', 'docs-feature');
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(path.join(reviewDir, 'login.md'), '# Đăng nhập\n\nNội dung.\n');
    await fs.writeFile(path.join(reviewDir, 'login.changes.json'), '[]');
    await fs.writeFile(path.join(reviewDir, 'login.notes.json'), '[]');
    const recovered = await validateReviewRecovery(cwd);
    expect(recovered.ok).toBe(true);
    const index = JSON.parse(await fs.readFile(path.join(cwd, 'review', 'index.json'), 'utf8'));
    expect(index.pages[0].status).toBe('succeeded');
  });
});

describe('pipeline recovery route', () => {
  it('rejects validation without a workspace and delegates an active workspace to the daemon finalizer', async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-pipeline-recovery-route-'));
    const db = openDatabase(dbDir, { dataDir: dbDir });
    insertProject(db, {
      id: 'P1', name: 'P1', skillId: null, designSystemId: null, pendingPrompt: null,
      metadata: { kind: 'pipeline' }, createdAt: 1, updatedAt: 1,
    });
    const validateRecovery = async () => ({ ok: true, issues: [], repaired: ['login'] });
    const handlers = new Map<string, (req: any, res: any) => unknown>();
    const app = {
      get: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`GET ${route}`, handler),
      post: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`POST ${route}`, handler),
      put: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PUT ${route}`, handler),
      patch: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`PATCH ${route}`, handler),
      delete: (route: string, handler: (req: any, res: any) => unknown) => handlers.set(`DELETE ${route}`, handler),
      use: () => {},
    };
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { validateRecovery, localOutputs: async () => [] },
      paths: { PROJECTS_DIR: dbDir, RUNTIME_DATA_DIR: dbDir },
    } as any);
    const handler = handlers.get('POST /api/pipelines/:id/recovery/validate')!;
    const invoke = async () => {
      const out: { status: number; body?: unknown } = { status: 200 };
      const res = {
        status(code: number) { out.status = code; return res; },
        json(body: unknown) { out.body = body; return res; },
      };
      await handler({ params: { id: 'dr-flow' }, body: { projectId: 'P1' } }, res);
      return out;
    };
    try {
      expect((await invoke()).status).toBe(409);
      setProjectPipelineStatus(db, 'P1', 'dr-flow', {
        status: 'failed',
        recovery: {
          schemaVersion: 1, kind: 'flow', state: 'needs-assistance', updatedAt: 1,
          units: [{ id: 'login', title: 'Login', conversationId: 'c1', errors: ['missing'] }],
        },
      });
      const recovered = await invoke();
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual({ ok: true, issues: [], repaired: ['login'] });
    } finally {
      closeDatabase();
      await fs.rm(dbDir, { recursive: true, force: true });
    }
  });
});
