// SQLite persistence for the design-v3 KG mirror.
//
// open-design-vnpay is both a consumer and a producer of the central KGS graph
// (app_id = design-v3). A remote project is *pulled* into these tables to be
// worked on locally, then locally-authored/edited rows are *pushed* back. The
// on-disk `.od/projects/<id>/` folder still owns the user's actual files; this
// mirror tracks the graph nodes/edges and their sync provenance.
//
// provenance:
//   'pulled'       — materialized from KGS; pull may refresh it, push ignores it
//   'local'        — created locally, never pushed yet
//   'local-edited' — pulled then edited locally; push sends it, conflict-checked
//
// See docs/sync-design-v3-spec-plan.md (Phase B/C).

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

type SqliteDb = Database.Database;
type JsonObject = Record<string, unknown>;

export type Provenance = 'pulled' | 'local' | 'local-edited';

export interface KgNode {
  projectId: string;
  entityId: string;
  labels: string[];
  props: JsonObject;
  provenance: Provenance;
  baseHash: string | null;
  updatedAt: number;
  pulledAt: number | null;
}

export interface KgEdge {
  projectId: string;
  edgeId: string;
  fromId: string;
  toId: string;
  relType: string;
  props: JsonObject;
  provenance: Provenance;
  baseHash: string | null;
  updatedAt: number;
}

export type SyncDirection = 'pull' | 'push';
export type SyncStatus = 'running' | 'ok' | 'partial' | 'error';

// Stable hash of a property bag — used as base_hash to detect "KGS changed since
// pull" and as a synthetic edge id when KGS doesn't supply one.
export function hashProps(props: unknown): string {
  return createHash('sha256').update(JSON.stringify(props ?? {})).digest('hex').slice(0, 16);
}

// Deterministic edge id when KGS omits one: hash(from|rel|to).
export function edgeIdFor(fromId: string, relType: string, toId: string): string {
  return createHash('sha256').update(`${fromId}|${relType}|${toId}`).digest('hex').slice(0, 24);
}

export function migrateKgSync(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_nodes (
      project_id   TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      labels_json  TEXT NOT NULL,
      props_json   TEXT NOT NULL,
      provenance   TEXT NOT NULL DEFAULT 'pulled',
      base_hash    TEXT,
      updated_at   INTEGER NOT NULL,
      pulled_at    INTEGER,
      PRIMARY KEY (project_id, entity_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_kg_nodes_provenance
      ON kg_nodes(project_id, provenance);

    CREATE TABLE IF NOT EXISTS kg_edges (
      project_id   TEXT NOT NULL,
      edge_id      TEXT NOT NULL,
      from_id      TEXT NOT NULL,
      to_id        TEXT NOT NULL,
      rel_type     TEXT NOT NULL,
      props_json   TEXT,
      provenance   TEXT NOT NULL DEFAULT 'pulled',
      base_hash    TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, edge_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_kg_edges_from
      ON kg_edges(project_id, from_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_provenance
      ON kg_edges(project_id, provenance);

    CREATE TABLE IF NOT EXISTS kg_sync_logs (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      direction    TEXT NOT NULL,
      status       TEXT NOT NULL,
      node_count   INTEGER NOT NULL DEFAULT 0,
      edge_count   INTEGER NOT NULL DEFAULT 0,
      detail_json  TEXT,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_kg_sync_logs_project
      ON kg_sync_logs(project_id, started_at DESC);
  `);
}

// KgSyncRepo wraps the mirror tables. All writes are synchronous (better-sqlite3).
export class KgSyncRepo {
  constructor(private readonly db: SqliteDb) {}

  // Upsert a node pulled from KGS. Never clobbers a row the user is still holding
  // locally ('local' / 'local-edited') — those are protected until pushed.
  upsertPulledNode(n: Omit<KgNode, 'provenance' | 'baseHash' | 'updatedAt' | 'pulledAt'>, now: number): 'inserted' | 'refreshed' | 'skipped-local' {
    const existing = this.db
      .prepare(`SELECT provenance FROM kg_nodes WHERE project_id=? AND entity_id=?`)
      .get(n.projectId, n.entityId) as { provenance: Provenance } | undefined;
    if (existing && existing.provenance !== 'pulled') return 'skipped-local';
    const hash = hashProps(n.props);
    this.db
      .prepare(
        `INSERT INTO kg_nodes (project_id, entity_id, labels_json, props_json, provenance, base_hash, updated_at, pulled_at)
         VALUES (@project_id, @entity_id, @labels_json, @props_json, 'pulled', @base_hash, @now, @now)
         ON CONFLICT(project_id, entity_id) DO UPDATE SET
           labels_json=excluded.labels_json, props_json=excluded.props_json,
           provenance='pulled', base_hash=excluded.base_hash,
           updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`,
      )
      .run({
        project_id: n.projectId,
        entity_id: n.entityId,
        labels_json: JSON.stringify(n.labels),
        props_json: JSON.stringify(n.props),
        base_hash: hash,
        now,
      });
    return existing ? 'refreshed' : 'inserted';
  }

  upsertPulledEdge(e: Omit<KgEdge, 'provenance' | 'baseHash' | 'updatedAt'>, now: number): 'inserted' | 'refreshed' | 'skipped-local' {
    const existing = this.db
      .prepare(`SELECT provenance FROM kg_edges WHERE project_id=? AND edge_id=?`)
      .get(e.projectId, e.edgeId) as { provenance: Provenance } | undefined;
    if (existing && existing.provenance !== 'pulled') return 'skipped-local';
    this.db
      .prepare(
        `INSERT INTO kg_edges (project_id, edge_id, from_id, to_id, rel_type, props_json, provenance, base_hash, updated_at)
         VALUES (@project_id, @edge_id, @from_id, @to_id, @rel_type, @props_json, 'pulled', @base_hash, @now)
         ON CONFLICT(project_id, edge_id) DO UPDATE SET
           from_id=excluded.from_id, to_id=excluded.to_id, rel_type=excluded.rel_type,
           props_json=excluded.props_json, provenance='pulled',
           base_hash=excluded.base_hash, updated_at=excluded.updated_at`,
      )
      .run({
        project_id: e.projectId,
        edge_id: e.edgeId,
        from_id: e.fromId,
        to_id: e.toId,
        rel_type: e.relType,
        props_json: JSON.stringify(e.props),
        base_hash: hashProps(e.props),
        now,
      });
    return existing ? 'refreshed' : 'inserted';
  }

  // Rows authored/edited locally that push must send.
  localNodes(projectId: string): KgNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM kg_nodes WHERE project_id=? AND provenance IN ('local','local-edited')`,
      )
      .all(projectId) as Record<string, any>[];
    return rows.map(rowToNode);
  }

  localEdges(projectId: string): KgEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM kg_edges WHERE project_id=? AND provenance IN ('local','local-edited')`,
      )
      .all(projectId) as Record<string, any>[];
    return rows.map(rowToEdge);
  }

  // After a successful push, a local row becomes a clean pulled baseline.
  markNodePushed(projectId: string, entityId: string, now: number): void {
    const row = this.db
      .prepare(`SELECT props_json FROM kg_nodes WHERE project_id=? AND entity_id=?`)
      .get(projectId, entityId) as { props_json: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        `UPDATE kg_nodes SET provenance='pulled', base_hash=?, updated_at=? WHERE project_id=? AND entity_id=?`,
      )
      .run(hashProps(JSON.parse(row.props_json)), now, projectId, entityId);
  }

  markEdgePushed(projectId: string, edgeId: string, now: number): void {
    const row = this.db
      .prepare(`SELECT props_json FROM kg_edges WHERE project_id=? AND edge_id=?`)
      .get(projectId, edgeId) as { props_json: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        `UPDATE kg_edges SET provenance='pulled', base_hash=?, updated_at=? WHERE project_id=? AND edge_id=?`,
      )
      .run(hashProps(JSON.parse(row.props_json ?? '{}')), now, projectId, edgeId);
  }

  // Wipe a project's entire mirror (nodes + edges) so a pull can replace it
  // wholesale — KGS is the source of truth and overrides all local state. This
  // also discards locally-authored/edited rows that were not yet pushed, so push
  // before re-pulling if you want to keep local work. Call inside the pull
  // transaction so the wipe+reinsert is atomic.
  wipeProject(projectId: string): { nodes: number; edges: number } {
    const nodes = this.db.prepare(`DELETE FROM kg_nodes WHERE project_id=?`).run(projectId).changes;
    const edges = this.db.prepare(`DELETE FROM kg_edges WHERE project_id=?`).run(projectId).changes;
    return { nodes, edges };
  }

  counts(projectId: string): { nodes: number; edges: number; localNodes: number; localEdges: number } {
    const n = this.db.prepare(`SELECT COUNT(*) c FROM kg_nodes WHERE project_id=?`).get(projectId) as { c: number };
    const e = this.db.prepare(`SELECT COUNT(*) c FROM kg_edges WHERE project_id=?`).get(projectId) as { c: number };
    const ln = this.db
      .prepare(`SELECT COUNT(*) c FROM kg_nodes WHERE project_id=? AND provenance IN ('local','local-edited')`)
      .get(projectId) as { c: number };
    const le = this.db
      .prepare(`SELECT COUNT(*) c FROM kg_edges WHERE project_id=? AND provenance IN ('local','local-edited')`)
      .get(projectId) as { c: number };
    return { nodes: n.c, edges: e.c, localNodes: ln.c, localEdges: le.c };
  }

  startLog(id: string, projectId: string, direction: SyncDirection, now: number): void {
    this.db
      .prepare(
        `INSERT INTO kg_sync_logs (id, project_id, direction, status, started_at) VALUES (?,?,?,'running',?)`,
      )
      .run(id, projectId, direction, now);
  }

  finishLog(id: string, status: SyncStatus, nodeCount: number, edgeCount: number, detail: unknown, now: number): void {
    this.db
      .prepare(
        `UPDATE kg_sync_logs SET status=?, node_count=?, edge_count=?, detail_json=?, finished_at=? WHERE id=?`,
      )
      .run(status, nodeCount, edgeCount, JSON.stringify(detail ?? {}), now, id);
  }
}

function rowToNode(r: Record<string, any>): KgNode {
  return {
    projectId: r.project_id,
    entityId: r.entity_id,
    labels: safeParse(r.labels_json, []),
    props: safeParse(r.props_json, {}),
    provenance: r.provenance,
    baseHash: r.base_hash ?? null,
    updatedAt: r.updated_at,
    pulledAt: r.pulled_at ?? null,
  };
}

function rowToEdge(r: Record<string, any>): KgEdge {
  return {
    projectId: r.project_id,
    edgeId: r.edge_id,
    fromId: r.from_id,
    toId: r.to_id,
    relType: r.rel_type,
    props: safeParse(r.props_json, {}),
    provenance: r.provenance,
    baseHash: r.base_hash ?? null,
    updatedAt: r.updated_at,
  };
}

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
