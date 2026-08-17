// WP1 (2026-08 web-first hold) red-spec: 3 stage sinh code UI-Spec
// (`ui-html`/`ui-react`/`ui-react-ds`, xem `HELD_STAGE_IDS` trong
// pipelines.ts) không được spawn được từ route nào — output cũ giữ nguyên
// mọi hành vi khác (registry, attribution, syncExclude — canh riêng trong
// tests/pipelines.test.ts).
//
// Gọi thẳng handler mà registerPipelineRoutes đăng ký (fake express app ghi
// lại handler theo "METHOD path", như tests/pipeline-run-all-lean-gate.test.ts)
// trên một DB SQLite tạm, nên không cần bind socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { countWorkflowProgress, registerPipelineRoutes } from '../src/pipeline-routes.js';
import { WORKFLOWS } from '../src/pipelines.js';

// Registry trung tâm không cần mạng trong test này.
vi.mock('../src/kg-sync/remote-registry.js', () => ({
  loadRemoteProjects: async () => [],
}));

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (routePath: string, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    patch: record('PATCH'),
    use: () => {},
    handlers,
  };
}

function makeRes() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

describe('Stage held (2026-08 web-first hold) — không route nào spawn được ui-html/ui-react/ui-react-ds', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;
  let runPipeline: ReturnType<typeof vi.fn>;
  let runWorkflowAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-stage-held-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    runPipeline = vi.fn(async () => ({ completion: Promise.resolve(), runId: 'run-1' }));
    runWorkflowAll = vi.fn(async (_projectId: string, opts: { stageIds?: string[]; terminal?: string }) => ({
      workflowId: 'docs-to-ui',
      projectId: _projectId,
      stages: opts.stageIds ?? [],
    }));
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [], runPipeline, runWorkflowAll },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertKgsProject(id: string) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline' },
      createdAt: now,
      updatedAt: now,
    });
  }

  async function postRun(pipelineId: string, projectId: string) {
    const handler = handlers.get('POST /api/pipelines/:id/run');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ params: { id: pipelineId }, body: { projectId }, query: {} }, res);
    return out;
  }

  async function postRunAll(body: Record<string, unknown>) {
    const handler = handlers.get('POST /api/pipelines/run-all');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body, query: {} }, res);
    return out;
  }

  it.each(['ui-html', 'ui-react', 'ui-react-ds'])(
    'POST /api/pipelines/%s/run → 503 STAGE_HELD, KHÔNG gọi runPipeline',
    async (pipelineId) => {
      insertKgsProject('PRJ_RUN_HELD');
      const out = await postRun(pipelineId, 'PRJ_RUN_HELD');
      expect(out.status).toBe(503);
      expect(out.body?.code).toBe('STAGE_HELD');
      expect(runPipeline).not.toHaveBeenCalled();
    },
  );

  it('POST /api/pipelines/run-all — KHÔNG chỉ định terminal/stageIds → không lỗi, runWorkflowAll vẫn được gọi (daemon tự loại held khỏi kế hoạch)', async () => {
    insertKgsProject('PRJ_RUN_ALL_DEFAULT');
    const out = await postRunAll({
      projectId: 'PRJ_RUN_ALL_DEFAULT',
      confluencePages: [{ id: '1', url: 'https://wiki/x' }],
    });
    expect(out.status).not.toBe(400);
    expect(out.status).toBe(202);
    expect(runWorkflowAll).toHaveBeenCalledTimes(1);
    // Không field terminal nào lọt vào opts khi request không gửi.
    const opts = runWorkflowAll.mock.calls[0]![1];
    expect(opts.terminal).toBeUndefined();
  });

  it.each(['ui-html', 'ui-react', 'ui-react-ds', 'both'])(
    'POST /api/pipelines/run-all — terminal=%s (tường minh) → 400 STAGE_HELD, KHÔNG gọi runWorkflowAll',
    async (terminal) => {
      insertKgsProject('PRJ_RUN_ALL_TERMINAL');
      const out = await postRunAll({
        projectId: 'PRJ_RUN_ALL_TERMINAL',
        terminal,
        confluencePages: [{ id: '1', url: 'https://wiki/x' }],
      });
      expect(out.status).toBe(400);
      expect(out.body?.code).toBe('STAGE_HELD');
      expect(runWorkflowAll).not.toHaveBeenCalled();
    },
  );

  it.each(['docs-review', 'docs-to-prd'])(
    'POST /api/pipelines/run-all — workflowId=%s + terminal=ui-html (cấu hình lưu/mặc định của web) → KHÔNG 400: workflow không có bước terminal nên field này vô nghĩa, runWorkflowAll vẫn được gọi',
    async (workflowId) => {
      insertKgsProject(`PRJ_RUN_ALL_${workflowId}`);
      const out = await postRunAll({
        projectId: `PRJ_RUN_ALL_${workflowId}`,
        workflowId,
        terminal: 'ui-html',
        confluencePages: [{ id: '1', url: 'https://wiki/x' }],
      });
      expect(out.body?.code).not.toBe('STAGE_HELD');
      expect(out.status).toBe(202);
      expect(runWorkflowAll).toHaveBeenCalledTimes(1);
    },
  );

  it('POST /api/pipelines/run-all — stageIds tường minh chứa một held id → 400 STAGE_HELD, KHÔNG gọi runWorkflowAll', async () => {
    insertKgsProject('PRJ_RUN_ALL_STAGEIDS');
    const out = await postRunAll({
      projectId: 'PRJ_RUN_ALL_STAGEIDS',
      stageIds: ['docs', 'docs-map', 'ux', 'ui-react'],
      confluencePages: [{ id: '1', url: 'https://wiki/x' }],
    });
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('STAGE_HELD');
    expect(runWorkflowAll).not.toHaveBeenCalled();
  });

  it('POST /api/pipelines/run-all — stageIds tường minh KHÔNG chứa held id → không lỗi (chỉ upstream, terminal đã hold)', async () => {
    insertKgsProject('PRJ_RUN_ALL_UPSTREAM_ONLY');
    const out = await postRunAll({
      projectId: 'PRJ_RUN_ALL_UPSTREAM_ONLY',
      stageIds: ['docs', 'docs-map', 'ux'],
      confluencePages: [{ id: '1', url: 'https://wiki/x' }],
    });
    expect(out.status).not.toBe(400);
    expect(out.status).toBe(202);
    expect(runWorkflowAll).toHaveBeenCalledTimes(1);
  });
});

describe('countWorkflowProgress — mẫu số bỏ 3 stage held (9 → 6 cho docs-to-ui)', () => {
  it('docs-to-ui: total = 6 (không đếm ui-html/ui-react/ui-react-ds), done/running chỉ tính trên 6 đó', () => {
    const wf = WORKFLOWS.find((w) => w.id === 'docs-to-ui')!;
    expect(wf.pipelineIds.length).toBe(9);
    const state = {
      docs: { status: 'succeeded' as const },
      'docs-map': { status: 'succeeded' as const },
      // Một held stage "succeeded" từ trước lúc hold (output cũ) không được
      // đếm vào done/total — nó không còn nằm trong mẫu số nữa.
      'ui-html': { status: 'succeeded' as const },
    };
    // Ghim mode 'full' tường minh (runAllConfig.lean: false): không để state
    // shape ở trên (ui-html succeeded mà cj/ux-research/ux-review chưa chạy)
    // tự SUY RA 'lean' qua resolveRunMode's inference heuristic — bài test
    // này canh riêng phần held, không phải phần suy luận mode.
    const project = { metadata: { runAllConfig: { lean: false } } };
    const { done, total, running } = countWorkflowProgress(project, state, wf.pipelineIds);
    expect(total).toBe(6);
    expect(done).toBe(2);
    expect(running).toBe(0);
  });
});
