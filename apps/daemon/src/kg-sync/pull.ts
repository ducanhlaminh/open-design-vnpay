// Pull a remote KGS project (app_id = design-v3) into the local SQLite mirror.
//
// In design-v3 a "project" IS a DP_UI_WORKSPACE node (kind=project) — there is no
// flat project_id property on the entities. So a project is the subgraph reachable
// from its workspace: workspace -OWNS_SCREEN/OWNS_COMPOSITION/OWNS_THEME/OWNS_TOKEN/
// OWNS_MODE-> … and onward through CONTAINS/COMPOSES/RENDERS_AS/USES_TOKEN/… down to
// token values. We resolve the workspace, then BFS its outgoing-edge closure.
//
// project id mapping: the CLI/route id ("xpos") maps to the workspace whose
// projectId property (or `ws-project-<ID>` entity id) matches case-insensitively.
//
// Locally authored/edited rows are protected by the repo (provenance != 'pulled').
// See docs/sync-design-v3-spec-plan.md (Phase B).

import type Database from 'better-sqlite3';
import type { KgPullResult } from '@open-design/contracts';
import { KgsClient, type KgsClientConfig, type KgsEntity } from './kgs-client.js';
import { KgSyncRepo, edgeIdFor } from './persistence.js';

type SqliteDb = Database.Database;

// Resolve the workspace node that represents this project. Matches either the
// projectId property or the conventional `ws-project-<ID>` entity id, both
// case-insensitively (route id "xpos" ↔ workspace "XPOS" / "ws-project-XPOS").
function findWorkspace(entities: KgsEntity[], projectId: string): KgsEntity | undefined {
  const up = projectId.toUpperCase();
  const byEntityId = `WS-PROJECT-${up}`;
  return entities.find((e) => {
    if (e.entityType !== 'DP_UI_WORKSPACE') return false;
    const pid = String((e.properties as Record<string, unknown>).projectId ?? '').toUpperCase();
    return pid === up || e.entityId.toUpperCase() === byEntityId;
  });
}

export async function pullProject(
  db: SqliteDb,
  projectId: string,
  cfg: KgsClientConfig,
  now: number,
  logId: string,
): Promise<KgPullResult> {
  const client = new KgsClient(cfg);
  const repo = new KgSyncRepo(db);
  repo.startLog(logId, projectId, 'pull', now);

  const errors: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let skippedNodes = 0;
  let skippedEdges = 0;

  // 1. Load the whole app graph once (nodes + edges), index it.
  const allNodes = await client.queryEntities([], {});
  const nodeById = new Map<string, KgsEntity>();
  for (const n of allNodes) nodeById.set(n.entityId, n);

  const allEdges = await client.allEdges();
  const adjacency = new Map<string, { toId: string; relType: string; props: Record<string, unknown> }[]>();
  for (const e of allEdges) {
    const list = adjacency.get(e.fromEntityId) ?? [];
    list.push({ toId: e.toEntityId, relType: e.relationType, props: e.properties ?? {} });
    adjacency.set(e.fromEntityId, list);
  }

  // 2. Resolve the project's workspace anchor.
  const workspace = findWorkspace(allNodes, projectId);
  if (!workspace) {
    repo.finishLog(logId, 'error', 0, 0, { error: `no DP_UI_WORKSPACE for project '${projectId}'` }, now);
    return { projectId, nodes: 0, edges: 0, skippedLocalNodes: 0, skippedLocalEdges: 0, status: 'partial', errors: [`no workspace for project '${projectId}'`] };
  }

  // 3. BFS the outgoing-edge closure from the workspace.
  const reachableNodes = new Set<string>([workspace.entityId]);
  type PendingEdge = { fromId: string; toId: string; relType: string; props: Record<string, unknown> };
  const edgesById = new Map<string, PendingEdge>();
  const queue: string[] = [workspace.entityId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const edge of adjacency.get(id) ?? []) {
      const eid = edgeIdFor(id, edge.relType, edge.toId);
      if (!edgesById.has(eid)) edgesById.set(eid, { fromId: id, toId: edge.toId, relType: edge.relType, props: edge.props });
      if (!reachableNodes.has(edge.toId)) {
        reachableNodes.add(edge.toId);
        if (nodeById.has(edge.toId)) queue.push(edge.toId);
      }
    }
  }

  // 4. Replace the project's mirror in one transaction: KGS overrides all local
  //    state, so wipe first then reinsert the freshly pulled subgraph. The wipe
  //    discards unpushed local work — push before re-pulling to keep it.
  let wiped = { nodes: 0, edges: 0 };
  const write = db.transaction(() => {
    wiped = repo.wipeProject(projectId);
    for (const id of reachableNodes) {
      const n = nodeById.get(id);
      if (!n) continue; // edge endpoint with no node row (dangling ref) — skip
      const labels = n.entityType ? [n.entityType] : [];
      const res = repo.upsertPulledNode({ projectId, entityId: n.entityId, labels, props: n.properties ?? {} }, now);
      if (res === 'skipped-local') skippedNodes++;
      else nodeCount++;
    }
    for (const [edgeId, pe] of edgesById) {
      const res = repo.upsertPulledEdge({ projectId, edgeId, fromId: pe.fromId, toId: pe.toId, relType: pe.relType, props: pe.props }, now);
      if (res === 'skipped-local') skippedEdges++;
      else edgeCount++;
    }
  });
  write();

  const status: 'ok' | 'partial' = errors.length > 0 ? 'partial' : 'ok';
  repo.finishLog(logId, status, nodeCount, edgeCount, { wiped, skippedNodes, skippedEdges, workspace: workspace.entityId, errors }, now);

  return { projectId, nodes: nodeCount, edges: edgeCount, skippedLocalNodes: skippedNodes, skippedLocalEdges: skippedEdges, status, errors };
}
