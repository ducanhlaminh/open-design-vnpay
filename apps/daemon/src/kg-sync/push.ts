// Push locally-authored KG rows back to the central KGS (app_id = design-v3).
//
// Outbox-safe ordering (KGS's UpsertEdge silently no-ops on a MATCH miss, and
// CreateNode does NOT upsert): push ALL nodes first, read-back-verify each, then
// push edges only between verified endpoints. We never trust an outbox "DONE".
//
// Scope: this sends provenance 'local' / 'local-edited' rows. New locally-
// authored content ('local') round-trips cleanly. Editing a *pulled* node and
// re-pushing ('local-edited') is best-effort only — KGS CreateNode can't update
// an existing node in place, so such edits may 409 (no-op) until KGS grows an
// upsert. Those are reported in `caveats` rather than silently "succeeding".
//
// See docs/sync-design-v3-spec-plan.md (Phase C).

import type Database from 'better-sqlite3';
import type { KgPushResult } from '@open-design/contracts';
import { KgsClient, type KgsClientConfig } from './kgs-client.js';
import { KgSyncRepo, type KgNode } from './persistence.js';

type SqliteDb = Database.Database;

// The app-level id a node is matched by in KGS (props.id), falling back to the
// stored entityId. Edges reference endpoints by this same id.
function nodeKey(n: KgNode): string {
  const pid = (n.props as Record<string, unknown>).id;
  return typeof pid === 'string' && pid ? pid : n.entityId;
}

export async function pushProject(
  db: SqliteDb,
  projectId: string,
  cfg: KgsClientConfig,
  now: number,
  logId: string,
  /** Approved remote id. Local rows/logs remain keyed by projectId. */
  remoteProjectId: string = projectId,
): Promise<KgPushResult> {
  const client = new KgsClient(cfg);
  const repo = new KgSyncRepo(db);
  repo.startLog(logId, projectId, 'push', now);

  const errors: string[] = [];
  const caveats: string[] = [];
  let nodesPushed = 0;
  let edgesPushed = 0;

  const localNodes = repo.localNodes(projectId);
  const localEdges = repo.localEdges(projectId);

  // ── 1. Nodes first, then verify each landed (don't trust outbox). ──────────
  const verified = new Set<string>();
  for (const n of localNodes) {
    const label = n.labels[0];
    if (!label) {
      errors.push(`node ${n.entityId}: missing label, cannot push`);
      continue;
    }
    const key = nodeKey(n);
    const props = { ...n.props, id: key, app_id: cfg.appId, project_id: remoteProjectId };
    try {
      const res = await client.createNode(label, props);
      if (res === 'exists' && n.provenance === 'local-edited') {
        caveats.push(`node ${key}: already exists in KGS — edit not applied (CreateNode has no upsert)`);
      }
      // Read-back verify before allowing its edges through.
      if (await client.nodeExists(key)) {
        verified.add(key);
        repo.markNodePushed(projectId, n.entityId, now);
        nodesPushed++;
      } else {
        errors.push(`node ${key}: not found after createNode (outbox drop?)`);
      }
    } catch (err) {
      errors.push(`node ${key}: ${(err as Error).message}`);
    }
  }

  // ── 2. Edges only between verified endpoints. ──────────────────────────────
  for (const e of localEdges) {
    if (!verified.has(e.fromId) || !verified.has(e.toId)) {
      // Endpoint may already be a pulled/long-lived node in KGS; verify it too.
      const fromOk = verified.has(e.fromId) || (await client.nodeExists(e.fromId));
      const toOk = verified.has(e.toId) || (await client.nodeExists(e.toId));
      if (!fromOk || !toOk) {
        errors.push(`edge ${e.relType} ${e.fromId}->${e.toId}: endpoint missing in KGS, skipped`);
        continue;
      }
    }
    try {
      await client.createEdge(e.fromId, e.toId, e.relType, {
        ...e.props,
        app_id: cfg.appId,
        project_id: remoteProjectId,
      });
      repo.markEdgePushed(projectId, e.edgeId, now);
      edgesPushed++;
    } catch (err) {
      errors.push(`edge ${e.relType} ${e.fromId}->${e.toId}: ${(err as Error).message}`);
    }
  }

  const status: 'ok' | 'partial' = errors.length > 0 ? 'partial' : 'ok';
  repo.finishLog(logId, status, nodesPushed, edgesPushed, { errors, caveats }, now);

  return { projectId, nodesPushed, edgesPushed, status, errors, caveats };
}
