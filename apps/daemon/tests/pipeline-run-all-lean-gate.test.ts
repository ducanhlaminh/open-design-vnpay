// HTTP surface của bug: `POST /api/pipelines/run-all` gate `stageIds` theo mode
// CỦA LẦN CHẠY TRƯỚC (`project.metadata.runAllConfig.lean` đã lưu) thay vì mode
// của CHÍNH request này. Trên một project chưa từng chạy (chưa có config lưu),
// bật "luồng tiết kiệm" (lean: true) rồi tick đúng tập bước lean của
// `docs-to-ui` (bỏ cj/ux-research/ux-review) bị 400 vì gate rơi về `full` —
// `ux` bị đòi `ux-research` dù lean cố tình bỏ bước đó.
//
// Gọi thẳng handler mà registerPipelineRoutes đăng ký (fake express app ghi
// lại handler theo "METHOD path", như tests/pipeline-run-config-route.test.ts)
// trên một DB SQLite tạm, nên không cần bind socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

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

describe('POST /api/pipelines/run-all — gate theo mode của CHÍNH request (lean/full)', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;
  let runWorkflowAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-run-all-lean-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    runWorkflowAll = vi.fn(async (_projectId: string, opts: { stageIds?: string[] }) => ({
      stages: opts.stageIds ?? [],
    }));
    registerPipelineRoutes(app as any, {
      db,
      pipelines: { localOutputs: async () => [], runWorkflowAll },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function postRunAll(body: Record<string, unknown>) {
    const handler = handlers.get('POST /api/pipelines/run-all');
    expect(handler, 'route should be registered').toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body, query: {} }, res);
    return out;
  }

  function insertKgsProject(id: string) {
    const now = Date.now();
    // Không mang `runAllConfig` — mô phỏng đúng "project chưa từng chạy".
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

  // Tập bước lean của docs-to-ui = WORKFLOWS[0].pipelineIds bỏ cj/ux-research/
  // ux-review (khớp `selectRunStages(UI_IDS, { lean: true })` trong
  // pipelines.test.ts). KHÔNG còn 3 terminal ui-html/ui-react/ui-react-ds:
  // đang HOLD (2026-08 web-first, HELD_STAGE_IDS trong pipelines.ts) — tick
  // tường minh hoặc gửi `terminal` tường minh cho một trong ba id đó nay 400
  // (`STAGE_HELD`), điều test NÀY không canh (đã có test riêng ở
  // pipeline-status-selection... không, xem test held riêng trong
  // pipelines.test.ts + pipeline-routes qua route trực tiếp bên dưới file
  // này). Bỏ hẳn `terminal` khỏi payload: daemon tự loại stage held khỏi kế
  // hoạch mà không lỗi (`selectRunStages`), nên gate-theo-mode vẫn được canh
  // đúng ý bài test mà không chạm STAGE_HELD.
  const leanStageIds = ['docs', 'docs-map', 'ux'];

  it('lean: true trên project CHƯA TỪNG CHẠY + tập bước lean → không 400', async () => {
    insertKgsProject('PRJ_LEAN');

    const out = await postRunAll({
      projectId: 'PRJ_LEAN',
      lean: true,
      stageIds: leanStageIds,
      platform: 'mobile',
      confluencePages: [{ id: '1', url: 'https://wiki/x' }],
    });

    expect(out.status).not.toBe(400);
    expect(out.status).toBe(202);
    expect(runWorkflowAll).toHaveBeenCalledTimes(1);
  });

  // Follow-up (bản sửa TRƯỚC ở test này chốt 400): gate theo `mode` vẫn khoá
  // nhầm khi `stageIds` là lựa chọn tường minh nhưng KHÔNG khớp `lean` đã lưu —
  // ca thật: `runAllConfig.lean === false` nhưng `stageIds` lại đúng bằng tập
  // lean (project cũ lưu lệch / UI ghi thiếu field). `validateRunStageSelection`
  // nay gate theo LỰA CHỌN THẬT (`explicitSelection: true`, xem pipelines.ts:
  // `explicitSelectionDependsOn`) chứ không theo `mode`/toggle `lean` nữa: một
  // bước `skippedInLeanRun` không được tick và chưa `succeeded` luôn được thay
  // bằng chính phụ thuộc của nó, bất kể mode là gì — nên tick đúng tập bước
  // lean không còn 400 dù request không hề gửi `lean`.
  it('cùng tập bước lean, KHÔNG bật lean (mặc định full) trên project chưa từng chạy → KHÔNG còn 400 (gate theo lựa chọn thật)', async () => {
    insertKgsProject('PRJ_FULL');

    const out = await postRunAll({
      projectId: 'PRJ_FULL',
      stageIds: leanStageIds,
      platform: 'mobile',
      confluencePages: [{ id: '1', url: 'https://wiki/x' }],
    });

    expect(out.status).not.toBe(400);
    expect(out.status).toBe(202);
    expect(runWorkflowAll).toHaveBeenCalledTimes(1);
  });
});
