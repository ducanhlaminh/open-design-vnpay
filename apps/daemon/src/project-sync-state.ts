import type { ProjectSyncScope } from '@open-design/contracts';
import type { ProjectSyncBaselineView, ProjectSyncDigestPair } from './project-sync-status.js';

type SqlValue = string | number | null;
type StatementLike = { get: (...args: SqlValue[]) => unknown; run: (...args: SqlValue[]) => unknown };
type Row = { origin_id: string; origin_app_id: string; local_digest: string; origin_digest: string; last_synced_at: string; incomplete: number };
export interface ProjectSyncBaselineIdentity { originId: string; originAppId?: string | null }
type StoredBaseline = ProjectSyncBaselineView & ProjectSyncBaselineIdentity;

const keyOf = (scope: ProjectSyncScope) => `${scope.kind}:${scope.appId ?? ''}:${scope.projectId}`;

/** SQLite-backed in production, with a small in-memory fallback for isolated
 * route tests whose mocked database intentionally has no SQL surface. */
export class ProjectSyncStateStore {
  private readonly memory = new Map<string, StoredBaseline>();
  constructor(private readonly db: object) {}

  private prepare(sql: string): StatementLike | null {
    const candidate = (this.db as { prepare?: (query: string) => unknown }).prepare;
    return candidate ? candidate.call(this.db, sql) as StatementLike : null;
  }

  get(scope: ProjectSyncScope, identity?: ProjectSyncBaselineIdentity): ProjectSyncBaselineView | null {
    const statement = this.prepare(`SELECT origin_id, origin_app_id, local_digest, origin_digest, last_synced_at, incomplete
      FROM project_sync_baselines WHERE scope_kind = ? AND project_id = ? AND app_id = ?`);
    if (!statement) {
      const value = this.memory.get(keyOf(scope));
      return value && (!identity || (value.originId === identity.originId && (value.originAppId ?? '') === (identity.originAppId ?? ''))) ? value : null;
    }
    const row = statement.get(scope.kind, scope.projectId, scope.appId ?? '') as Row | undefined;
    if (!row || (identity && (row.origin_id !== identity.originId || row.origin_app_id !== (identity.originAppId ?? '')))) return null;
    return { localDigest: row.local_digest, originDigest: row.origin_digest, lastSyncedAt: row.last_synced_at, incomplete: Boolean(row.incomplete) };
  }

  recordClean(scope: ProjectSyncScope, identity: ProjectSyncBaselineIdentity, pair: ProjectSyncDigestPair, contextVersion: string | null = null): ProjectSyncBaselineView {
    const value = { ...pair, lastSyncedAt: new Date().toISOString(), incomplete: false };
    this.write(scope, identity, value, contextVersion);
    return value;
  }

  markIncomplete(scope: ProjectSyncScope, identity: ProjectSyncBaselineIdentity, pair?: ProjectSyncDigestPair, contextVersion: string | null = null): ProjectSyncBaselineView {
    const previous = this.get(scope, identity);
    const value = {
      localDigest: pair?.localDigest ?? previous?.localDigest ?? '',
      originDigest: pair?.originDigest ?? previous?.originDigest ?? '',
      lastSyncedAt: previous?.lastSyncedAt ?? new Date().toISOString(),
      incomplete: true,
    };
    this.write(scope, identity, value, contextVersion);
    return value;
  }

  private write(scope: ProjectSyncScope, identity: ProjectSyncBaselineIdentity, value: ProjectSyncBaselineView, contextVersion: string | null): void {
    this.memory.set(keyOf(scope), { ...value, ...identity });
    const statement = this.prepare(`INSERT INTO project_sync_baselines
      (schema_version, scope_kind, project_id, app_id, origin_id, origin_app_id, local_digest, origin_digest, context_version, last_synced_at, incomplete)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_kind, project_id, app_id) DO UPDATE SET
        schema_version=excluded.schema_version, origin_id=excluded.origin_id, origin_app_id=excluded.origin_app_id,
        local_digest=excluded.local_digest, origin_digest=excluded.origin_digest,
        context_version=excluded.context_version, last_synced_at=excluded.last_synced_at,
        incomplete=excluded.incomplete`);
    if (!statement) return;
    statement.run(scope.kind, scope.projectId, scope.appId ?? '', identity.originId, identity.originAppId ?? '', value.localDigest, value.originDigest, contextVersion, value.lastSyncedAt, value.incomplete ? 1 : 0);
  }
}
