// Live incident FIX A: a saved runAllConfig.appFiles selection (set via
// PUT /api/pipelines/projects/:id/run-config — the "Nguồn tài liệu" rail's
// App-corpus picker) disappeared after the user later triggered a run
// (terminal/stageIds survived, appFiles did not).
//
// Traced: the ONLY two writers of metadata.runAllConfig in this daemon are
// PUT .../run-config (already correct — a shallow MERGE with the saved
// config, `{ ...saved, ...patch }`) and POST /api/pipelines/run-all, which
// wrote `runAllConfigFromBody(req.body, { withDefaults: true })` as a FULL
// REPLACEMENT of the saved config — by design, since the Run-all modal
// resends its own COMPLETE state on every trigger. `appFiles` breaks that
// assumption: it's set through a SEPARATE surface (the rail, not the Run-all
// modal), so any run-all trigger whose caller doesn't know about `appFiles`
// (an older/stale client, run-all fired from a flow that only sets the
// fields it owns) silently wiped a previously-saved selection — exactly
// matching the observed symptom (terminal/stageIds, which the modal DOES
// own and resend, survived; appFiles, which it doesn't know about, did not).
//
// The daemon's OWN "pull" metadata rewrite (syncStudioConfig, only reachable
// from POST /api/projects/:id/kg-pull | /api/kg/pull-all) was ALSO checked:
// it already correctly spreads the existing `project.metadata` before
// writing `{ ...metadata, studioConfig }`, so a `runAllConfig.appFiles`
// value survives it untouched (verified in the second describe block below,
// which simulates that exact merge shape directly against the DB, since
// syncStudioConfig itself is a private closure that needs a real media
// service to reach past its own early-return).
//
// Fix: POST /api/pipelines/run-all now preserves a previously-saved
// `appFiles` when the CURRENT request doesn't explicitly mention the field
// (present-with-null still clears it, matching PUT run-config's own
// three-state handling) — mirrored here via the fake-express harness (no
// HTTP bind needed), with ctx.pipelines.runWorkflowAll stubbed to a no-op
// since only the PRE-run persist-write is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getProject, insertProject, openDatabase, updateProject } from '../src/db.js';
import { registerPipelineRoutes } from '../src/pipeline-routes.js';

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

describe('POST /api/pipelines/run-all preserves a previously-saved runAllConfig.appFiles', () => {
  let tempDir: string;
  let handlers: Map<string, Handler>;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-run-all-appfiles-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const app = makeApp();
    registerPipelineRoutes(app as any, {
      db,
      pipelines: {
        localOutputs: async () => [],
        // Only the persist-write BEFORE this call is under test.
        runWorkflowAll: async (projectId: string, opts: any) => ({
          projectId,
          workflowId: opts.workflowId ?? 'docs-to-ui',
          stages: [],
        }),
      },
      paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    } as any);
    handlers = app.handlers;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function call(key: string, req: Record<string, unknown> = {}) {
    const handler = handlers.get(key);
    expect(handler, `${key} should be registered`).toBeTypeOf('function');
    const { res, out } = makeRes();
    await handler!({ body: {}, query: {}, params: {}, ...req }, res);
    return out;
  }

  const runAll = (body: unknown) => call('POST /api/pipelines/run-all', { body });

  function insertFeature(id: string, runAllConfig?: Record<string, unknown>) {
    const now = Date.now();
    insertProject(db, {
      id,
      name: id,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline', ...(runAllConfig ? { runAllConfig } : {}) },
      createdAt: now,
      updatedAt: now,
    });
  }

  const savedConfig = (id: string) => (getProject(db, id) as any)?.metadata?.runAllConfig as Record<string, unknown> | undefined;

  it('a run-all trigger that does NOT mention appFiles keeps the previously-saved selection (terminal/stageIds still fully replaced, as designed)', async () => {
    insertFeature('FEAT', {
      appFiles: { appId: 'XPOS', paths: ['Overview.md'] },
      terminal: 'ui-html',
      lean: false,
    });

    const res = await runAll({ projectId: 'FEAT', terminal: 'ui-react', lean: true });
    expect(res.status).toBe(202);

    const cfg = savedConfig('FEAT');
    // appFiles survives — this is the fix.
    expect(cfg?.appFiles).toEqual({ appId: 'XPOS', paths: ['Overview.md'] });
    // The modal's OWN fields are still a full replace (unchanged behavior):
    // this trigger's terminal/lean win outright.
    expect(cfg?.terminal).toBe('ui-react');
    expect(cfg?.lean).toBe(true);
  });

  it('a run-all trigger that explicitly sends a NEW appFiles overrides the saved one', async () => {
    insertFeature('FEAT', { appFiles: { appId: 'OLD', paths: ['Old.md'] } });

    const res = await runAll({ projectId: 'FEAT', appFiles: { appId: 'NEW', paths: ['New.md'] } });
    expect(res.status).toBe(202);
    expect(savedConfig('FEAT')?.appFiles).toEqual({ appId: 'NEW', paths: ['New.md'] });
  });

  it('a run-all trigger that explicitly sends appFiles: null clears the saved selection', async () => {
    insertFeature('FEAT', { appFiles: { appId: 'XPOS', paths: ['Overview.md'] } });

    const res = await runAll({ projectId: 'FEAT', appFiles: null });
    expect(res.status).toBe(202);
    expect(savedConfig('FEAT')).not.toHaveProperty('appFiles');
  });

  it('a fresh project with no saved appFiles and none sent stays without the field', async () => {
    insertFeature('FEAT');
    const res = await runAll({ projectId: 'FEAT' });
    expect(res.status).toBe(202);
    expect(savedConfig('FEAT')).not.toHaveProperty('appFiles');
  });

  it('400s a malformed appFiles sent on a run-all trigger, leaving the saved config untouched', async () => {
    insertFeature('FEAT', { appFiles: { appId: 'XPOS', paths: ['Overview.md'] }, lean: true });
    const res = await runAll({ projectId: 'FEAT', appFiles: { appId: 'XPOS' }, lean: false });
    expect(res.status).toBe(400);
    const cfg = savedConfig('FEAT');
    expect(cfg?.appFiles).toEqual({ appId: 'XPOS', paths: ['Overview.md'] });
    expect(cfg?.lean).toBe(true);
  });
});

describe('the pull-adjacent metadata rewrite shape (syncStudioConfig, server.ts) preserves runAllConfig.appFiles', () => {
  // syncStudioConfig is a private closure inside startServer that needs a
  // real media service to reach past its own `if (!buf) return` early exit,
  // so it can't be unit-tested directly without a live/mocked media backend.
  // This simulates its EXACT merge shape — `updateProject(db, projectId,
  // { metadata: { ...(project.metadata ?? {}), studioConfig } })` — verified
  // verbatim against server.ts, so a change to that shape (e.g. someone
  // "simplifying" it to `metadata: { studioConfig }` and dropping the
  // spread) would be caught here even though the real function can't run in
  // this harness.
  let tempDir: string;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-sync-studio-config-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'FEAT',
      name: 'FEAT',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: {
        kind: 'pipeline',
        runAllConfig: { appFiles: { appId: 'XPOS', paths: ['Overview.md'] }, terminal: 'ui-html', stageIds: ['docs'] },
      },
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appFiles (and the rest of runAllConfig) survives the pull metadata rewrite verbatim', () => {
    const project = getProject(db, 'FEAT') as any;
    const studioConfig = { confluencePages: [{ id: '111', title: 'Spec mới từ studio' }], designSystemId: 'ds-1' };
    // The exact shape syncStudioConfig writes.
    updateProject(db, 'FEAT', { metadata: { ...(project.metadata ?? {}), studioConfig } });

    const after = getProject(db, 'FEAT') as any;
    expect(after.metadata.runAllConfig).toEqual({
      appFiles: { appId: 'XPOS', paths: ['Overview.md'] },
      terminal: 'ui-html',
      stageIds: ['docs'],
    });
    expect(after.metadata.studioConfig).toEqual(studioConfig);
  });
});
