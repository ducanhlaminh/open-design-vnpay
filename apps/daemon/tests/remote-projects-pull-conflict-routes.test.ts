// HTTP surface for conflict-aware pull: POST /api/kg/pull-plan + /api/kg/pull-apply.
//
// Drives the real express routes (registerRemoteProjectsRoutes) over a live
// socket with a faked `pipelines.pullConflict` dep, so the test pins the wire
// contract — input validation, the `{ ok, data }` envelope, and the
// PLAN_EXPIRED → 409 mapping — without booting the whole daemon or a
// media-service. The classify/resolve/TOCTOU logic itself is covered by
// pull-conflict.test.ts.

import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERR_PLAN_EXPIRED, type PullApplyResult, type PullPlan } from '@open-design/contracts';

import { registerRemoteProjectsRoutes } from '../src/remote-projects-routes.js';

const PLAN: PullPlan = {
  projectId: 'XPOS',
  planId: 'plan_test',
  summary: { new: 1, unchanged: 2, conflicts: 1 },
  new: [{ path: 'ux/new.json', stage: 'ux-spec', remoteChecksum: 'aaa' }],
  conflicts: [
    {
      path: 'ux/diff.json',
      stage: 'ux-spec',
      kind: 'text',
      local: { checksum: 'l1', size: 10, mtime: 1, preview: 'local' },
      remote: { checksum: 'r1', size: 12, preview: 'remote', fileId: 'fid' },
    },
  ],
};

// Records the args the route forwarded so we can assert wiring, and lets each
// test choose the apply outcome (success vs PLAN_EXPIRED throw).
const calls: { plan: string[]; apply: unknown[] } = { plan: [], apply: [] };
let applyImpl: () => Promise<PullApplyResult>;

function buildApp() {
  const app = express();
  app.use(express.json());
  const sendApiError = (res: express.Response, status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } });
  registerRemoteProjectsRoutes(app, {
    db: {} as never,
    http: { sendApiError } as never,
    projectStore: {
      // Any id except UNKNOWN resolves to a project.
      getProject: (_db: unknown, id: string) => (id === 'UNKNOWN' ? null : { id, name: id }),
      insertProject: () => {},
    } as never,
    pipelines: {
      pullConflict: {
        plan: async (projectId: string) => {
          calls.plan.push(projectId);
          return PLAN;
        },
        apply: async (
          projectId: string,
          planId: string,
          resolutions: Record<string, string>,
          onConflictDefault: string,
        ) => {
          calls.apply.push({ projectId, planId, resolutions, onConflictDefault });
          return applyImpl();
        },
      },
    } as never,
  });
  return app;
}

let baseUrl: string;
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/kg/pull-plan', () => {
  it('returns the plan in an { ok, data } envelope', async () => {
    const res = await post('/api/kg/pull-plan', { projectId: 'XPOS' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.planId).toBe('plan_test');
    expect(body.data.summary).toEqual({ new: 1, unchanged: 2, conflicts: 1 });
    expect(calls.plan).toContain('XPOS');
  });

  it('400 when projectId is missing', async () => {
    const res = await post('/api/kg/pull-plan', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('BAD_REQUEST');
  });

  it('404 when the project does not exist', async () => {
    const res = await post('/api/kg/pull-plan', { projectId: 'UNKNOWN' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('POST /api/kg/pull-apply', () => {
  it('forwards resolutions + default and returns the apply result', async () => {
    applyImpl = async () => ({ downloaded: 2, keptLocal: 1, unchangedSkipped: 2, stale: [] });
    const res = await post('/api/kg/pull-apply', {
      projectId: 'XPOS',
      planId: 'plan_test',
      resolutions: { 'ux/diff.json': 'remote' },
      onConflictDefault: 'remote',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.downloaded).toBe(2);
    expect(calls.apply.at(-1)).toEqual({
      projectId: 'XPOS',
      planId: 'plan_test',
      resolutions: { 'ux/diff.json': 'remote' },
      onConflictDefault: 'remote',
    });
  });

  it('defaults onConflictDefault to local when omitted/invalid', async () => {
    applyImpl = async () => ({ downloaded: 0, keptLocal: 1, unchangedSkipped: 0, stale: [] });
    await post('/api/kg/pull-apply', { projectId: 'XPOS', planId: 'plan_test' });
    expect((calls.apply.at(-1) as { onConflictDefault: string }).onConflictDefault).toBe('local');
  });

  it('maps the ERR_PLAN_EXPIRED throw to HTTP 409', async () => {
    applyImpl = async () => {
      const err = new Error('plan expired') as Error & { code?: string };
      err.code = ERR_PLAN_EXPIRED;
      throw err;
    };
    const res = await post('/api/kg/pull-apply', { projectId: 'XPOS', planId: 'stale' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe(ERR_PLAN_EXPIRED);
  });

  it('400 when planId is missing', async () => {
    const res = await post('/api/kg/pull-apply', { projectId: 'XPOS' });
    expect(res.status).toBe(400);
  });
});
