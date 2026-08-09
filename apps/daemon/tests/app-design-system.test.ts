import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  getPipelineApp,
  insertPipelineApp,
  listPipelineApps,
  openDatabase,
  setPipelineAppDesignSystem,
  upsertPipelineAppName,
} from '../src/db.js';

let dbDir: string;
beforeEach(() => { dbDir = mkdtempSync(path.join(tmpdir(), 'od-app-ds-')); });
afterEach(() => { closeDatabase(); rmSync(dbDir, { recursive: true, force: true }); });
function testDb() { return openDatabase('unused', { dataDir: dbDir }); }

describe('pipeline App design system', () => {
  it('creates a row when setting a DS on an App without one', () => {
    const db = testDb();
    setPipelineAppDesignSystem(db, { id: 'app-1', designSystemId: 'ds-1', createdAt: 1 });
    expect(getPipelineApp(db, 'app-1')).toMatchObject({ id: 'app-1', designSystemId: 'ds-1' });
  });

  it('clears the DS while preserving the name', () => {
    const db = testDb();
    insertPipelineApp(db, { id: 'app-1', name: 'Original', designSystemId: 'ds-1', createdAt: 1 });
    setPipelineAppDesignSystem(db, { id: 'app-1', designSystemId: null, createdAt: 2 });
    expect(getPipelineApp(db, 'app-1')).toMatchObject({ name: 'Original', designSystemId: null });
  });

  it('renaming does not overwrite the DS', () => {
    const db = testDb();
    insertPipelineApp(db, { id: 'app-1', name: 'Original', designSystemId: 'ds-1', createdAt: 1 });
    upsertPipelineAppName(db, { id: 'app-1', name: 'Renamed', createdAt: 2 });
    expect(getPipelineApp(db, 'app-1')).toMatchObject({ name: 'Renamed', designSystemId: 'ds-1' });
  });

  it('lists and gets designSystemId', () => {
    const db = testDb();
    insertPipelineApp(db, { id: 'app-1', name: 'App', designSystemId: 'ds-1', createdAt: 1 });
    expect(listPipelineApps(db)[0]).toMatchObject({ designSystemId: 'ds-1' });
    expect(getPipelineApp(db, 'app-1')).toMatchObject({ designSystemId: 'ds-1' });
  });

  it('migrates the old pipeline_apps schema without losing data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-app-ds-migration-'));
    try {
      const old = new Database(path.join(dir, 'app.sqlite'));
      old.exec(`CREATE TABLE pipeline_apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      old.prepare('INSERT INTO pipeline_apps (id, name, created_at) VALUES (?, ?, ?)').run('old-app', 'Old', 7);
      old.close();
      const db = openDatabase('unused', { dataDir: dir });
      expect(db.prepare('PRAGMA table_info(pipeline_apps)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'design_system_id' }),
      ]));
      expect(getPipelineApp(db, 'old-app')).toMatchObject({ name: 'Old', designSystemId: null });
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
