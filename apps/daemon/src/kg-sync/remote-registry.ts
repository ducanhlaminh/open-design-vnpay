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
  /** Đường nhanh: tải theo id đã có từ listAllFiles. `downloadFile(name, path)`
   *  của MediaClient mở session mới = listFolders + listAllFiles LẠI cho mỗi
   *  file — với kho remote đó là 2 round-trip thừa nhân số folder (nguyên nhân
   *  /api/project-sync/origins chậm/timeout). Có id + hàm này thì dùng luôn. */
  downloadById?(id: string): Promise<Uint8Array>;
}

interface MediaRow {
  projectId: string;
  name: string;
  files: number;
  isApp: boolean;
  visibility?: ProjectLifecycle['visibility'];
  hiddenAt?: string;
  /** Feature: appId đọc từ project.json gốc folder (App: luôn undefined). */
  appId?: string | null;
  /** Feature không đọc/parse được project.json → không xác minh được App cha. */
  parentLookupFailed?: boolean;
}

/** Root-level project config file. Carries the human display name a user
 *  typed when publishing — the folder id (`app--bidv--fe206e0a`) is only
 *  ever a fallback, never what should show up in a picker. */
const PROJECT_CONFIG_PATH = 'project.json';

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

function fileIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id ? row.id : null;
}

/** Root-level control file `uploadProjectFiles` (server.ts) unconditionally
 *  writes into an App's own media folder whenever a Feature carrying
 *  `studioConfig.appId` is pushed — the one reliable, already-live signal
 *  that a folder is an App container rather than a Feature. No pipeline
 *  stage output pattern ever produces a root-level file with this name. */
export const APP_MARKER_PATH = 'app.json';

/** Build the project list from the media rows, sorted by id. */
export function mergeRemoteProjects(media: MediaRow[]): RemoteProject[] {
  const byId = new Map<string, RemoteProject>();
  for (const m of media) {
    byId.set(m.projectId, {
      projectId: m.projectId,
      name: m.name,
      inMedia: true,
      files: m.files,
      isApp: m.isApp,
      visibility: m.visibility ?? 'visible',
      ...(m.hiddenAt ? { hiddenAt: m.hiddenAt } : {}),
      ...(m.appId !== undefined ? { appId: m.appId } : {}),
      ...(m.parentLookupFailed ? { parentLookupFailed: true } : {}),
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
      const byPath = new Map<string, unknown>();
      for (const file of files) {
        const filePath = filePathOf(file);
        if (filePath != null && !byPath.has(filePath)) byPath.set(filePath, file);
      }
      // Đọc 1 file gốc folder, MỖI PATH TỐI ĐA 1 LẦN (cache parse) — ưu tiên
      // downloadById từ danh sách vừa list; downloadFile chỉ còn là fallback
      // cho source không có id (fake test cũ).
      const parsedByPath = new Map<string, Record<string, unknown> | null>();
      const readRootJson = async (filePath: string): Promise<Record<string, unknown> | null> => {
        if (parsedByPath.has(filePath)) return parsedByPath.get(filePath)!;
        let parsed: Record<string, unknown> | null = null;
        const row = byPath.get(filePath);
        if (row) {
          try {
            const id = fileIdOf(row);
            const content = id && media.downloadById
              ? await media.downloadById(id)
              : media.downloadFile
                ? await media.downloadFile(f.name, filePath)
                : null;
            if (content) {
              const value = JSON.parse(Buffer.from(content).toString('utf8')) as unknown;
              parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
            }
          } catch {
            parsed = null;
          }
        }
        parsedByPath.set(filePath, parsed);
        return parsed;
      };
      let lifecycle: ProjectLifecycle | null = null;
      if (byPath.has(PROJECT_LIFECYCLE_PATH)) {
        const raw = await readRootJson(PROJECT_LIFECYCLE_PATH);
        if (raw) {
          lifecycle = parseProjectLifecycle(raw, f.name);
          if (!lifecycle) console.warn(`[remote-registry] ignoring invalid lifecycle metadata for ${f.name}`);
        } else {
          console.warn(`[remote-registry] cannot read lifecycle metadata for ${f.name}`);
        }
      }
      const isApp = byPath.has(APP_MARKER_PATH);
      // Open Design publishes App metadata as app.json; project.json is the
      // legacy/Pipeline Studio shape (same precedence server.ts uses to
      // resolve an App's name when mirroring a pulled Feature's parent App).
      let name = f.name;
      for (const source of isApp ? [APP_MARKER_PATH, PROJECT_CONFIG_PATH] : [PROJECT_CONFIG_PATH]) {
        const config = await readRootJson(source);
        if (config && typeof config.name === 'string' && config.name.trim()) { name = config.name; break; }
        // Best-effort: file thiếu/hỏng/không tên → thử source kế / giữ folder id.
      }
      // Feature: App cha nằm ngay trong project.json vừa đọc cho tên — trước
      // đây project-sync-routes tải LẠI project.json cho từng feature (mỗi lần
      // một session listFolders+listAllFiles) chỉ để lấy appId này.
      let appId: string | null = null;
      let parentLookupFailed = false;
      if (!isApp) {
        const config = await readRootJson(PROJECT_CONFIG_PATH);
        appId = config && typeof config.appId === 'string' ? config.appId : null;
        parentLookupFailed = config == null;
      }
      return {
        projectId: f.name,
        name,
        ...(isApp ? {} : { appId, ...(parentLookupFailed ? { parentLookupFailed: true } : {}) }),
        // Studio metadata is a registry control artifact, not a project file
        // that users can Pull or count as an available output.
        files: files.filter((file) => filePathOf(file) !== PROJECT_LIFECYCLE_PATH).length,
        isApp,
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
