// MediaClient — file artifact store backed by media-service (MinIO/S3), the
// hybrid counterpart to KgsClient: GRAPH stays in KGS, FILES move here. Keeps an
// interface compatible with KgsClient's file methods (uploadFile/listFiles/
// downloadFile) so the pipeline file-sync call sites barely change.
//
// Design notes (see docs/guides/media-file-sync-design.md):
//   - Project → one media-service FOLDER (name = projectId).
//   - cwd-relative path + stage are carried as TAGS (`path:<rel>`, `stage:<id>`),
//     NOT the filename, so server-side filename sanitization can't corrupt them.
//   - Upload is NOT idempotent server-side (random storage key + always-Create),
//     so writes go through a CONTENT-HASH SYNC: skip unchanged, replace changed,
//     drop same-path duplicates. Re-push of unchanged files is a no-op.
//   - List defaults to 20 rows → listAllFiles PAGINATES via `total`.
//   - Identity is app-scoped; `X-User-Role: admin` makes List return every
//     owner's files in the app (cross-device visibility, like KGS app-key).
//
// Config (env):
//   MEDIA_URL       default http://localhost:8083
//   MEDIA_APP_ID    default = KGS_APP_ID (fallback design-v3)
//   MEDIA_USER_ID   default od-service   (shared service user)
//   MEDIA_USER_ROLE default admin        (app-wide visibility)

import { createHash } from 'node:crypto';

const PATH_TAG = 'path:';
const STAGE_TAG = 'stage:';
const PAGE_SIZE = 500;

export interface MediaClientConfig {
  baseUrl: string;
  appId: string;
  userId: string;
  role: string;
}

export function mediaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MediaClientConfig {
  return {
    baseUrl: (env.MEDIA_URL || 'http://localhost:8083').replace(/\/+$/, ''),
    appId: env.MEDIA_APP_ID || env.KGS_APP_ID || 'design-v3',
    userId: env.MEDIA_USER_ID || 'od-service',
    role: env.MEDIA_USER_ROLE || 'admin',
  };
}

/** A local file to sync up (content + its pipeline-relative path + owning stage). */
export interface LocalSyncFile {
  path: string;
  stage: string;
  mime: string;
  content: Buffer;
}

/** Normalised view of a media-service file (path/stage decoded from tags). */
export interface MediaFile {
  id: string;
  path: string;
  stage: string;
  checksum: string; // hex sha256 (server prefix `sha256:` stripped)
  name: string;
  mime: string;
  size: number; // bytes (0 when the server omits it)
}

interface RawFile {
  id: string;
  name: string;
  checksum?: string;
  tags?: string[];
  mime_type?: string;
  folder_id?: string | null;
  size?: number;
  size_bytes?: number;
}
interface RawFolder {
  id: string;
  name: string;
  path?: string;
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class MediaClient {
  constructor(private readonly cfg: MediaClientConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-App-ID': this.cfg.appId,
      'X-User-ID': this.cfg.userId,
      'X-User-Role': this.cfg.role,
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl}${path}`;
  }

  private async assertOk(res: Response, label: string): Promise<void> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  // ── folders ────────────────────────────────────────────────────────────────

  /** Resolve (or create) the project's folder id. ListRoot is app-scoped, so a
   *  match means any device's push created it. Caller should cache the result
   *  (e.g. in project.metadata.mediaFolderId) to avoid re-listing each push. */
  async ensureFolder(projectId: string): Promise<string> {
    const existing = await this.findFolderId(projectId);
    if (existing) return existing;
    const res = await fetch(this.url('/api/v1/folders'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: projectId }),
    });
    if (res.ok) {
      const folder = (await res.json()) as RawFolder;
      return folder.id;
    }
    // Lost a create race (or unique-conflict) — re-resolve once.
    const retry = await this.findFolderId(projectId);
    if (retry) return retry;
    await this.assertOk(res, 'createFolder');
    throw new Error(`ensureFolder: could not resolve folder for ${projectId}`);
  }

  private async findFolderId(projectId: string): Promise<string | null> {
    const res = await fetch(this.url('/api/v1/folders'), { headers: this.headers() });
    await this.assertOk(res, 'listFolders');
    const body = (await res.json()) as { folders?: RawFolder[] };
    return (body.folders ?? []).find((f) => f.name === projectId)?.id ?? null;
  }

  /** All folders in the app (one per project; name == projectId). Used by the
   *  remote registry to enumerate media-side projects. */
  async listFolders(): Promise<Array<{ id: string; name: string }>> {
    const res = await fetch(this.url('/api/v1/folders'), { headers: this.headers() });
    await this.assertOk(res, 'listFolders');
    const body = (await res.json()) as { folders?: RawFolder[] };
    return (body.folders ?? []).map((f) => ({ id: f.id, name: f.name }));
  }

  /** Delete the project's folder (cleanup when a project is removed). No-op if absent. */
  async deleteFolder(projectId: string): Promise<void> {
    const id = await this.findFolderId(projectId);
    if (!id) return;
    const res = await fetch(this.url(`/api/v1/folders/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return;
    await this.assertOk(res, 'deleteFolder');
  }

  /** Delete every file in a project's folder, then the (now empty) folder itself.
   *  Files are deleted explicitly first so the result is correct regardless of
   *  whether the server cascade-deletes on folder removal. Returns how many files
   *  were removed; folderRemoved=false when the project has no media folder. */
  async deleteProjectFiles(projectId: string): Promise<{ filesDeleted: number; folderRemoved: boolean }> {
    const folderId = await this.findFolderId(projectId);
    if (!folderId) return { filesDeleted: 0, folderRemoved: false };
    const files = await this.listAllFiles(folderId);
    for (const f of files) await this.deleteFile(f.id);
    const res = await fetch(this.url(`/api/v1/folders/${encodeURIComponent(folderId)}`), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status !== 404) await this.assertOk(res, 'deleteFolder');
    return { filesDeleted: files.length, folderRemoved: true };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** All files in a folder, fully paginated (List defaults to 20 rows). */
  async listAllFiles(folderId: string): Promise<MediaFile[]> {
    const out: MediaFile[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const res = await fetch(
        this.url(`/api/v1/files?folder_id=${encodeURIComponent(folderId)}&limit=${PAGE_SIZE}&offset=${offset}`),
        { headers: this.headers() },
      );
      await this.assertOk(res, 'listFiles');
      const body = (await res.json()) as { items?: RawFile[]; total?: number };
      const items = body.items ?? [];
      for (const f of items) out.push(this.toMediaFile(f));
      if (items.length < PAGE_SIZE || out.length >= (body.total ?? out.length)) break;
    }
    return out;
  }

  private toMediaFile(f: RawFile): MediaFile {
    const tags = f.tags ?? [];
    const pathTag = tags.find((t) => t.startsWith(PATH_TAG));
    const stageTag = tags.find((t) => t.startsWith(STAGE_TAG));
    return {
      id: f.id,
      path: pathTag ? pathTag.slice(PATH_TAG.length) : f.name,
      stage: stageTag ? stageTag.slice(STAGE_TAG.length) : '',
      checksum: (f.checksum ?? '').replace(/^sha256:/, ''),
      name: f.name,
      mime: f.mime_type ?? '',
      size: f.size ?? f.size_bytes ?? 0,
    };
  }

  /** KgsClient-compatible: list a project's files as `{path, stage, ...}` rows
   *  (consumed by pull + deriveStateFromKgsFiles, which reads `stage`). */
  async listFiles(projectId: string): Promise<Array<Record<string, unknown>>> {
    const folderId = await this.ensureFolder(projectId);
    const files = await this.listAllFiles(folderId);
    return files.map((f) => ({ path: f.path, stage: f.stage, checksum: f.checksum, id: f.id, mime: f.mime }));
  }

  async downloadFile(projectId: string, filePath: string): Promise<Buffer> {
    const folderId = await this.ensureFolder(projectId);
    const files = await this.listAllFiles(folderId);
    const match = files.find((f) => f.path === filePath);
    if (!match) throw new Error(`downloadFile: not found ${projectId}/${filePath}`);
    const res = await fetch(this.url(`/api/v1/files/${encodeURIComponent(match.id)}/download`), {
      headers: this.headers(),
    });
    await this.assertOk(res, 'downloadFile');
    return Buffer.from(await res.arrayBuffer());
  }

  // ── writes ───────────────────────────────────────────────────────────────

  private async deleteFile(id: string): Promise<void> {
    const res = await fetch(this.url(`/api/v1/files/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return;
    await this.assertOk(res, 'deleteFile');
  }

  private async uploadOne(
    folderId: string,
    filePath: string,
    stage: string,
    mime: string,
    content: Buffer,
  ): Promise<void> {
    const fd = new FormData();
    const base = filePath.split('/').pop() || filePath;
    fd.append('file', new Blob([content], { type: mime || 'application/octet-stream' }), base);
    fd.append('folder_id', folderId);
    const tags = [`${PATH_TAG}${filePath}`, ...(stage ? [`${STAGE_TAG}${stage}`] : [])];
    fd.append('tags', JSON.stringify(tags));
    // No Content-Type header: fetch sets the multipart boundary itself.
    const res = await fetch(this.url('/api/v1/files'), {
      method: 'POST',
      headers: this.headers(),
      body: fd,
    });
    await this.assertOk(res, 'uploadFile');
  }

  /** KgsClient-compatible single-file upload (content-hash dedup against any
   *  same-path copies). Prefer syncProjectFiles for batches — it lists once. */
  async uploadFile(
    projectId: string,
    stage: string,
    filePath: string,
    mime: string,
    content: Buffer,
  ): Promise<void> {
    const folderId = await this.ensureFolder(projectId);
    const remote = (await this.listAllFiles(folderId)).filter((f) => f.path === filePath);
    const sum = sha256hex(content);
    const keep = remote.find((f) => f.checksum === sum);
    if (keep) {
      for (const dup of remote) if (dup.id !== keep.id) await this.deleteFile(dup.id);
      return;
    }
    for (const dup of remote) await this.deleteFile(dup.id);
    await this.uploadOne(folderId, filePath, stage, mime, content);
  }

  /** Optimal batch sync (rsync/content-hash): one list, then per file
   *  skip-unchanged / replace-changed / add-new and drop same-path duplicates.
   *  Idempotent — re-running with the same inputs uploads nothing. */
  async syncProjectFiles(
    projectId: string,
    files: LocalSyncFile[],
  ): Promise<{ uploaded: number; skipped: number; deleted: number }> {
    const folderId = await this.ensureFolder(projectId);
    const remote = await this.listAllFiles(folderId);
    const byPath = new Map<string, MediaFile[]>();
    for (const f of remote) {
      const arr = byPath.get(f.path) ?? [];
      arr.push(f);
      byPath.set(f.path, arr);
    }
    let uploaded = 0;
    let skipped = 0;
    let deleted = 0;
    for (const lf of files) {
      const sum = sha256hex(lf.content);
      const existing = byPath.get(lf.path) ?? [];
      const keep = existing.find((f) => f.checksum === sum);
      if (keep) {
        skipped += 1;
        for (const dup of existing) {
          if (dup.id !== keep.id) {
            await this.deleteFile(dup.id);
            deleted += 1;
          }
        }
      } else {
        for (const dup of existing) {
          await this.deleteFile(dup.id);
          deleted += 1;
        }
        await this.uploadOne(folderId, lf.path, lf.stage, lf.mime, lf.content);
        uploaded += 1;
      }
    }
    return { uploaded, skipped, deleted };
  }
}
