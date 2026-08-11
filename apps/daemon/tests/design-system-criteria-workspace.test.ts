import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CriteriaGenerationJob } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isCriteriaGenerationJobActive,
  readCriteriaGenerationDocument,
  registerDesignSystemCriteriaWorkspaceRoutes,
} from '../src/design-system-criteria-workspace.js';

type Handler = (req: any, res: any) => unknown;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  const record = (method: string) => (route: string, handler: Handler) => handlers.set(`${method} ${route}`, handler);
  return { get: record('GET'), post: record('POST'), handlers };
}

function fakeRes() {
  const out: { status: number; body?: any } = { status: 200 };
  const res: any = {
    status(value: number) { out.status = value; return res; },
    json(value: unknown) { out.body = value; return res; },
  };
  return { out, res };
}

function job(status: CriteriaGenerationJob['status'] = 'running'): CriteriaGenerationJob {
  return {
    id: 'job-1', designSystemId: 'user:payments', kind: 'components', status,
    message: 'Đang sinh', error: null, steps: [],
    createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
    workspace: { projectId: 'project-1', conversationId: 'conversation-1', runId: 'run-1' }, notes: [],
  };
}

describe('Design System criteria workspace API', () => {
  let root: string;
  let liveDsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-ds-criteria-workspace-'));
    liveDsDir = path.join(root, 'payments');
    const candidate = path.join(liveDsDir, '.figma-update', 'candidate');
    await mkdir(path.join(candidate, 'criteria'), { recursive: true });
    await writeFile(path.join(candidate, 'criteria', 'components.md'), '# Components\n\n### `#button` Button\n');
    await writeFile(path.join(candidate, 'criteria', 'components.md.next'), '# Components\n\n### `#button-new` New Button\n');
    await writeFile(path.join(liveDsDir, '.figma-update', 'state.json'), JSON.stringify({
      schemaVersion: 1,
      designSystemId: 'user:payments',
      lifecycle: 'criteria_pending',
      currentVersion: 1,
      currentFigmaDigest: 'sha256:old',
      candidateVersion: 2,
      candidateFigmaDigest: 'sha256:new',
      candidateCreatedAt: '2026-08-11T00:00:00.000Z',
      deleteOldSourceAfterApproval: false,
      approvedAt: null,
      contextVersioning: 'not_started',
      contextVersioningError: null,
      criteria: {
        components: {
          kind: 'components', status: 'stale', hasApprovedFile: true, hasDraft: true,
          approvedContent: null, draftContent: null, count: 1,
          generatedFromVersion: 1, generatedFromFigmaDigest: 'sha256:old', generatedAt: null,
        },
        rules: {
          kind: 'rules', status: 'missing', hasApprovedFile: false, hasDraft: false,
          approvedContent: null, draftContent: null, count: 0,
          generatedFromVersion: null, generatedFromFigmaDigest: null, generatedAt: null,
        },
      },
    }));
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns current and draft independently from the candidate workdir', async () => {
    const result = await readCriteriaGenerationDocument({
      liveDsDir, designSystemId: 'user:payments', kind: 'components', job: job(),
    });
    expect(result).toMatchObject({
      kind: 'components',
      current: { count: 1, status: 'stale' },
      draft: { count: 1, status: 'draft' },
      job: { workspace: { projectId: 'project-1', conversationId: 'conversation-1', runId: 'run-1' } },
    });
    expect(result.current?.content).toContain('Button');
    expect(result.draft?.content).toContain('New Button');
  });

  it('registers symmetric read/start routes and preserves the reused signal', async () => {
    const app = fakeApp();
    const startJob = vi.fn(async () => ({ job: job(), reused: true }));
    registerDesignSystemCriteriaWorkspaceRoutes(app as any, {
      resolveDesignSystemDir: async () => liveDsDir,
      getJob: () => job(),
      startJob,
    });
    const start = app.handlers.get('POST /api/design-systems/:id/criteria/:kind/generate');
    const startResponse = fakeRes();
    await start!({ params: { id: 'user:payments', kind: 'components' } }, startResponse.res);
    expect(startResponse.out).toMatchObject({ status: 202, body: { reused: true, job: { kind: 'components' } } });
    expect(startJob).toHaveBeenCalledWith('user:payments', 'components');

    const read = app.handlers.get('GET /api/design-systems/:id/criteria/:kind');
    const readResponse = fakeRes();
    await read!({ params: { id: 'user:payments', kind: 'rules' } }, readResponse.res);
    expect(readResponse.out).toMatchObject({ status: 200, body: { kind: 'rules', current: null, draft: null } });
  });

  it('rejects unknown kinds and treats only queued/running jobs as active', async () => {
    expect(isCriteriaGenerationJobActive(job('queued'))).toBe(true);
    expect(isCriteriaGenerationJobActive(job('running'))).toBe(true);
    expect(isCriteriaGenerationJobActive(job('succeeded'))).toBe(false);
    expect(isCriteriaGenerationJobActive(job('failed'))).toBe(false);

    const app = fakeApp();
    registerDesignSystemCriteriaWorkspaceRoutes(app as any, {
      resolveDesignSystemDir: async () => liveDsDir,
      getJob: () => null,
      startJob: async () => ({ job: job(), reused: false }),
    });
    const read = app.handlers.get('GET /api/design-systems/:id/criteria/:kind');
    const response = fakeRes();
    await read!({ params: { id: 'user:payments', kind: 'other' } }, response.res);
    expect(response.out).toMatchObject({ status: 400 });
  });
});

