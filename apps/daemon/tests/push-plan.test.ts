import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getProject } from '../src/db.js';
import { planPush } from '../src/kg-sync/push-plan.js';
import type { MediaClient } from '../src/kg-sync/media-client.js';

function projectDb(metadata: Record<string, unknown>) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT,
      design_system_id TEXT, pending_prompt TEXT, metadata_json TEXT,
      applied_plugin_snapshot_id TEXT, custom_instructions TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  db.prepare(`INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'checkout-local',
    'Checkout',
    null,
    null,
    null,
    JSON.stringify(metadata),
    null,
    null,
    1,
    1,
  );
  return db;
}

describe('planPush direct publishing', () => {
  it('clears a legacy pending id and sends the project directly to Shared Projects', async () => {
    const pendingId = 'pending--checkout-local--abc123';
    const db = projectDb({ studioConfig: { pendingId } });
    const media = {
      listFolders: async () => [],
      listAllFiles: async () => [],
    } as unknown as MediaClient;

    const plan = await planPush({
      db,
      projectId: 'checkout-local',
      media,
      submitter: { id: '65edc73c-56a4-4c48-8651-d7cb07a5e10d' },
    });

    expect(plan).toMatchObject({
      staged: false,
      destId: 'checkout-local',
    });
    expect(getProject(db, 'checkout-local')?.metadata).toMatchObject({
      studioConfig: {},
    });
    db.close();
  });
});
