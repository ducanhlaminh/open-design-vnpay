// Remote registry: enumerate projects on the remote media-service store. Kept
// here (no express, structural client interface) so it unit-tests against a
// fake without booting the daemon. The HTTP routes are thin wrappers that
// construct the real MediaClient and call loadRemoteProjects.
//
// (Prior to the KGS removal this also merged a separate KGS-graph workspace
// listing; that half is gone — every row now comes from media-service alone.)
//
// See docs/guides/media-file-sync-design.md and the pull-conflict spec.

import type { ProjectLifecycle, RemoteProject } from '@open-design/contracts';

import { isPending } from './staging.js';

// ── structural source (MediaClient satisfies this) ───────────────────────────
export interface FolderSource {
  listFolders(): Promise<Array<{ id: string; name: string }>>;
  listAllFiles(folderId: string): Promise<Array<unknown>>;
  /** Read-only: implementations must return an error for an absent project or
   *  artifact and must never create a folder while resolving this file. */
  downloadFile?(projectId: string, filePath: string): Promise<Uint8Array>;
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

/** Build the project list from the media rows, sorted by id. */
export function mergeRemoteProjects(media: MediaRow[]): RemoteProject[] {
  const byId = new Map<string, RemoteProject>();
  for (const m of media) {
    byId.set(m.projectId, {
      projectId: m.projectId,
      name: m.projectId,
      inMedia: true,
      files: m.files,
      isApp: m.projectId.startsWith(APP_PREFIX),
      visibility: m.visibility ?? 'visible',
      ...(m.hiddenAt ? { hiddenAt: m.hiddenAt } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** Enumerate the registry from the media store (best-effort: an unreachable
 *  store yields an empty list rather than throwing). */
export async function loadRemoteProjects(media: FolderSource): Promise<RemoteProject[]> {
  // `pending--…` folders are approval requests, not projects. Open Design
  // lists EVERY media folder — without this filter a request awaiting
  // approval would show up as a pullable project on every machine in the app.
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

  return mergeRemoteProjects(mediaRows);
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
