import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerOverviewRoutes } from '../src/overview-routes.js';

type Handler = (req: any, res: any) => Promise<unknown> | unknown;
const resources: Array<{ db: Database.Database; root: string }> = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-overview-'));
  const db = openDatabase(root, { dataDir: path.join(root, '.od') });
  const routes = new Map<string, Handler>();
  const local = new Map<string, string[]>();
  registerOverviewRoutes({ get: (url: string, handler: Handler) => routes.set(url, handler) } as any, {
    db,
    paths: { PROJECTS_DIR: path.join(root, 'projects') } as any,
    pipelines: { localOutputs: async (projectId: string) => local.get(projectId) ?? [] } as any,
  });
  resources.push({ db, root });
  return { db, local, routes, root };
}

function response() {
  const result: { status: number; body?: unknown } = { status: 200 };
  return {
    result,
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
}

function seedFeature(db: Database.Database, id: string, appId: string, appName: string) {
  insertProject(db, { id, name: id, createdAt: 1, updatedAt: 1, metadata: { kind: 'pipeline', studioConfig: { appId, appName } } });
}

afterEach(async () => {
  for (const { db, root } of resources.splice(0)) {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});

describe('overview routes', () => {
  it('summary returns app/feature/workflow data and both local file states', async () => {
    const { db, local, routes } = await setup();
    seedFeature(db, 'feature-1', 'app-1', 'App Một');
    seedFeature(db, 'feature-2', 'app-1', 'App Một');
    local.set('feature-1', ['react-ds/docs/output.md']);
    const res = response();
    await routes.get('/api/overview/summary')!({}, res);
    expect(res.result.status).toBe(200);
    expect(res.result.body).toMatchObject({ apps: 1, features: 2 });
    expect((res.result.body as any).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ featureId: 'feature-1', localFiles: true, appId: 'app-1' }),
      expect.objectContaining({ featureId: 'feature-2', localFiles: false, appId: 'app-1' }),
    ]));
  });

  it('summary is idempotent for the overview project', async () => {
    const { db, routes } = await setup();
    const handler = routes.get('/api/overview/summary')!;
    await handler({}, response());
    await handler({}, response());
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get('overview')).toEqual({ count: 1 });
  });

  it('outputs validates projectId and returns local paths', async () => {
    const { db, local, routes } = await setup();
    seedFeature(db, 'feature-1', 'app-1', 'App Một');
    local.set('feature-1', ['a.html', 'react-ds/b.html']);
    const missing = response();
    await routes.get('/api/overview/outputs')!({ query: {} }, missing);
    expect(missing.result.status).toBe(400);
    const found = response();
    await routes.get('/api/overview/outputs')!({ query: { projectId: 'feature-1' } }, found);
    expect(found.result.body).toEqual({ paths: ['a.html', 'react-ds/b.html'] });
  });
});
