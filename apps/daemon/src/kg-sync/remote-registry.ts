// Remote registry: enumerate projects across the two remote stores (KGS graph +
// media-service files) and merge them by projectId. The merge + loader are kept
// here (no express, structural client interfaces) so they unit-test against fakes
// without booting the daemon. The HTTP routes in kg-sync-routes.ts are thin
// wrappers that construct the real KgsClient/MediaClient and call loadRemoteProjects.
//
// See docs/guides/media-file-sync-design.md and the pull-conflict spec.

import type { ProjectLifecycle, RemoteProject } from '@open-design/contracts';

import { isPending } from './staging.js';

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
  /** Read-only: implementations must return an error for an absent project or
   *  artifact and must never create a folder while resolving this file. */
  downloadFile?(projectId: string, filePath: string): Promise<Uint8Array>;
}

interface KgsRow {
  projectId: string;
  name: string;
}
interface MediaRow {
  projectId: string;
  files: number;
  visibility?: ProjectLifecycle['visibility'];
  hiddenAt?: string;
}

/** Pipeline Studio owns this sidecar. Keeping it outside project.json lets
 *  Studio hide/restore a project without mutating Open Design publish data. */
export const PROJECT_LIFECYCLE_PATH = '_studio/project-lifecycle.json';

export function parseProjectLifecycle(value: unknown, expectedProjectId: string): ProjectLifecycle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1) return null;
  if (row.visibility !== 'visible' && row.visibility !== 'hidden') return null;
  if (typeof row.projectId !== 'string' || row.projectId !== expectedProjectId) return null;
  return {
    schemaVersion: 1,
    projectId: row.projectId,
    visibility: row.visibility,
    ...(typeof row.hiddenAt === 'string' ? { hiddenAt: row.hiddenAt } : {}),
    ...(typeof row.hiddenBy === 'string' ? { hiddenBy: row.hiddenBy } : {}),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
  };
}

function filePathOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.path === 'string' ? row.path : null;
}

/** Media-folder id prefix marking a folder as an App container (matches
 *  pipeline-studio's server/apps.ts APP_PREFIX) — a grouping + shared
 *  UX-charter layer above features, never a pipeline target itself. */
export const APP_PREFIX = 'app--';

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
      isApp: k.projectId.startsWith(APP_PREFIX),
      visibility: 'visible',
    });
  }
  for (const m of media) {
    const existing = byId.get(m.projectId);
    if (existing) {
      existing.inMedia = true;
      existing.files = m.files;
      existing.visibility = m.visibility ?? 'visible';
      if (m.hiddenAt) existing.hiddenAt = m.hiddenAt;
      else delete existing.hiddenAt;
    } else {
      byId.set(m.projectId, {
        projectId: m.projectId,
        name: m.projectId,
        inKgs: false,
        inMedia: true,
        files: m.files,
        isApp: m.projectId.startsWith(APP_PREFIX),
        visibility: m.visibility ?? 'visible',
        ...(m.hiddenAt ? { hiddenAt: m.hiddenAt } : {}),
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

  // `pending--…` folders are approval requests, not projects. Studio hides them
  // for free (it enumerates KGS workspaces, and a staged push writes no
  // workspace node) but Open Design lists EVERY media folder — without this
  // filter a request awaiting approval would show up as a pullable project on
  // every machine in the app.
  const folders = (await media.listFolders().catch(() => [])).filter((f) => !isPending(f.name));
  const mediaRows: MediaRow[] = await Promise.all(
    folders.map(async (f) => {
      const files = await media.listAllFiles(f.id).catch(() => []);
      let lifecycle: ProjectLifecycle | null = null;
      if (media.downloadFile && files.some((file) => filePathOf(file) === PROJECT_LIFECYCLE_PATH)) {
        try {
          const content = await media.downloadFile(f.name, PROJECT_LIFECYCLE_PATH);
          lifecycle = parseProjectLifecycle(JSON.parse(Buffer.from(content).toString('utf8')), f.name);
          if (!lifecycle) console.warn(`[remote-registry] ignoring invalid lifecycle metadata for ${f.name}`);
        } catch (err) {
          console.warn(`[remote-registry] cannot read lifecycle metadata for ${f.name}: ${(err as Error).message}`);
        }
      }
      return {
        projectId: f.name,
        // Studio metadata is a registry control artifact, not a project file
        // that users can Pull or count as an available output.
        files: files.filter((file) => filePathOf(file) !== PROJECT_LIFECYCLE_PATH).length,
        visibility: lifecycle?.visibility ?? 'visible',
        ...(lifecycle?.hiddenAt ? { hiddenAt: lifecycle.hiddenAt } : {}),
      };
    }),
  );

  return mergeRemoteProjects(kgsRows, mediaRows);
}

/** Whether a single project is visible under the given pull scope. Membership
 *  cascades App → Feature: pipeline-studio's own App detail page shows every
 *  feature linked to an app once you can see the app, with no separate
 *  per-feature membership check (server/apps.ts `PUT /api/projects/:id/app`
 *  just requires projects:manage, not membership on the feature itself) — a
 *  feature whose parent app you're a member/owner of must be visible here
 *  too, or it's invisible in Open Design while showing up fine in the studio.
 *  `appId` must already be resolved (see resolveAppId) before calling this. */
export function isProjectVisible(
  projectId: string,
  appId: string | null | undefined,
  scope: { all: boolean; ids: ReadonlySet<string> },
): boolean {
  if (scope.all) return true;
  return scope.ids.has(projectId) || (appId != null && scope.ids.has(appId));
}

/** Which of `data`'s projects the given pull scope makes visible — see
 *  isProjectVisible. Each project's `appId` must already be resolved. */
export function filterVisibleProjects(
  data: RemoteProject[],
  scope: { all: boolean; ids: ReadonlySet<string> },
): RemoteProject[] {
  return data.filter((p) => isProjectVisible(p.projectId, p.appId, scope));
}

/** Remove soft-deleted rows from Pull discovery. Hidden state cascades from an
 *  App container to every Feature linked to it. */
export function filterLifecycleVisibleProjects(data: RemoteProject[]): RemoteProject[] {
  const hiddenIds = new Set(data.filter((p) => p.visibility === 'hidden').map((p) => p.projectId));
  return data.filter((p) => p.visibility !== 'hidden' && !(p.appId && hiddenIds.has(p.appId)));
}

export function isLifecycleHidden(
  data: readonly RemoteProject[],
  projectId: string,
  appId?: string | null,
): boolean {
  const hiddenIds = new Set(data.filter((p) => p.visibility === 'hidden').map((p) => p.projectId));
  return hiddenIds.has(projectId) || Boolean(appId && hiddenIds.has(appId));
}
