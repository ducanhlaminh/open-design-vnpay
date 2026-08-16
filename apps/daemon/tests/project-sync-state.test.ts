import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { ProjectSyncStateStore } from '../src/project-sync-state.js';

describe('ProjectSyncStateStore', () => {
  it('does not reuse a baseline after the origin mapping changes', () => {
    const store = new ProjectSyncStateStore({});
    const scope = { kind: 'feature' as const, projectId: 'local-feature', appId: 'local-app' };
    store.recordClean(scope, { originId: 'origin-a', originAppId: 'origin-app' }, { localDigest: 'local', originDigest: 'origin' });
    expect(store.get(scope, { originId: 'origin-a', originAppId: 'origin-app' })).toMatchObject({ incomplete: false });
    expect(store.get(scope, { originId: 'origin-b', originAppId: 'origin-app' })).toBeNull();
  });

  it('marks only the matching mapped scope incomplete', () => {
    const store = new ProjectSyncStateStore({});
    const scope = { kind: 'feature' as const, projectId: 'local-feature', appId: 'local-app' };
    store.markIncomplete(scope, { originId: 'origin-a', originAppId: 'origin-app' });
    expect(store.get(scope, { originId: 'origin-a', originAppId: 'origin-app' })).toMatchObject({ incomplete: true });
  });

  it('keeps App baseline identity independent from child Feature parent ids', () => {
    const store = new ProjectSyncStateStore({});
    const appScope = { kind: 'app' as const, projectId: 'local-app' };
    store.recordClean(appScope, { originId: 'origin-app', originAppId: null }, { localDigest: 'local', originDigest: 'origin' });
    expect(store.get(appScope, { originId: 'origin-app', originAppId: null })).toMatchObject({ incomplete: false });
    expect(store.get(appScope, { originId: 'origin-app', originAppId: 'origin-app' })).toBeNull();
  });

  it('persists an additive SQLite baseline across reopen and rejects a changed mapping', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-sync-state-sqlite-'));
    const dataDir = path.join(root, 'data');
    const scope = { kind: 'feature' as const, projectId: 'local-feature', appId: 'local-app' };
    try {
      let db = openDatabase(root, { dataDir });
      new ProjectSyncStateStore(db).recordClean(
        scope,
        { originId: 'origin-feature', originAppId: 'origin-app' },
        { localDigest: 'local-digest', originDigest: 'origin-digest' },
        'v2',
      );
      closeDatabase();

      db = openDatabase(root, { dataDir });
      const reopened = new ProjectSyncStateStore(db);
      expect(reopened.get(scope, { originId: 'origin-feature', originAppId: 'origin-app' })).toMatchObject({
        localDigest: 'local-digest', originDigest: 'origin-digest', incomplete: false,
      });
      expect(reopened.get(scope, { originId: 'different-origin', originAppId: 'origin-app' })).toBeNull();
    } finally {
      closeDatabase();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
