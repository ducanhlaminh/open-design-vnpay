// Remote registry: enumerate projects across the two remote stores (KGS graph +
// media-service files) and merge them by projectId. The merge + loader are kept
// here (no express, structural client interfaces) so they unit-test against fakes
// without booting the daemon. The HTTP routes in kg-sync-routes.ts are thin
// wrappers that construct the real KgsClient/MediaClient and call loadRemoteProjects.
//
// See docs/guides/media-file-sync-design.md and the pull-conflict spec.

import type { RemoteProject } from '@open-design/contracts';

// ── workspace → projectId ────────────────────────────────────────────────────
// Derive a pull-able project id from a DP_UI_WORKSPACE entity: prefer the
// explicit projectId property, else the conventional `ws-project-<ID>` entity id.
// Returns null for non-project workspaces (e.g. shared `ws-catalog-*`).
export function projectIdFromWorkspace(ws: {
  entityId?: string;
  properties?: Record<string, unknown>;
}): string | null {
  const pid = ws.properties?.projectId;
  if (typeof pid === 'string' && pid.trim()) return pid.trim();
  const m = /^ws-project-(.+)$/i.exec(ws.entityId ?? '');
  return m && m[1] ? m[1] : null;
}

// ── structural sources (KgsClient / MediaClient satisfy these) ───────────────
export interface WorkspaceSource {
  queryEntities(
    labels: string[],
    propertyEq: Record<string, string>,
  ): Promise<Array<{ entityId?: string; name?: string; properties?: Record<string, unknown> }>>;
}

export interface FolderSource {
  listFolders(): Promise<Array<{ id: string; name: string }>>;
  listAllFiles(folderId: string): Promise<Array<unknown>>;
}

interface KgsRow {
  projectId: string;
  name: string;
}
interface MediaRow {
  projectId: string;
  files: number;
}

/** Merge the two remote sources into one project list, keyed by projectId and
 *  sorted by id. A project present in only one store still appears, with the
 *  matching `inKgs`/`inMedia` flag false. */
export function mergeRemoteProjects(kgs: KgsRow[], media: MediaRow[]): RemoteProject[] {
  const byId = new Map<string, RemoteProject>();
  for (const k of kgs) {
    byId.set(k.projectId, {
      projectId: k.projectId,
      name: k.name || k.projectId,
      inKgs: true,
      inMedia: false,
      files: 0,
    });
  }
  for (const m of media) {
    const existing = byId.get(m.projectId);
    if (existing) {
      existing.inMedia = true;
      existing.files = m.files;
    } else {
      byId.set(m.projectId, {
        projectId: m.projectId,
        name: m.projectId,
        inKgs: false,
        inMedia: true,
        files: m.files,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** Query both stores (best-effort per store — one being down still lists the
 *  other) and return the merged registry. */
export async function loadRemoteProjects(kgs: WorkspaceSource, media: FolderSource): Promise<RemoteProject[]> {
  const workspaces = await kgs.queryEntities(['DP_UI_WORKSPACE'], {}).catch(() => []);
  const kgsRows: KgsRow[] = [];
  for (const ws of workspaces) {
    const projectId = projectIdFromWorkspace(ws);
    if (!projectId) continue;
    const name = typeof ws.properties?.name === 'string' && ws.properties.name ? ws.properties.name : (ws.name ?? projectId);
    kgsRows.push({ projectId, name });
  }

  const folders = await media.listFolders().catch(() => []);
  const mediaRows: MediaRow[] = await Promise.all(
    folders.map(async (f) => ({
      projectId: f.name,
      files: (await media.listAllFiles(f.id).catch(() => [])).length,
    })),
  );

  return mergeRemoteProjects(kgsRows, mediaRows);
}
