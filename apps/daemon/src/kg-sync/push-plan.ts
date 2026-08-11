// Lập kế hoạch cho một push trực tiếp vào Shared Projects. Một push-all đi qua
// N dự án nhưng chỉ cần một ảnh chụp remote registry, nên danh sách được memo
// ngắn (~30s).

import type Database from 'better-sqlite3';
import type { RemoteProject } from '@open-design/contracts';

import { getProject, updateProject } from '../db.js';
import type { KgsClient } from './kgs-client.js';
import type { MediaClient } from './media-client.js';
import { loadRemoteProjects } from './remote-registry.js';
import { type PushDest, resolvePushDest, studioConfigOf } from './push-dest.js';
import type { StagingActor } from './staging.js';

type SqliteDb = Database.Database;

const REMOTE_TTL_MS = 30_000;
let remoteCache: { at: number; rows: RemoteProject[] } | null = null;

/** Vứt ảnh chụp registry — gọi sau khi một thao tác vừa đổi state từ xa. */
export function invalidateRemoteCache(): void {
  remoteCache = null;
}

async function remoteProjects(
  kgs: KgsClient,
  media: MediaClient,
  fresh: boolean,
): Promise<RemoteProject[]> {
  if (!fresh && remoteCache && Date.now() - remoteCache.at < REMOTE_TTL_MS) return remoteCache.rows;
  const rows = await loadRemoteProjects(kgs, media);
  remoteCache = { at: Date.now(), rows };
  return rows;
}

export interface PlanPushInput {
  db: SqliteDb;
  projectId: string;
  kgs: KgsClient;
  media: MediaClient;
  submitter: StagingActor | null;
}

export interface PushPlan extends PushDest {
  /** @deprecated Approval staging has been removed. */
  reconciled?: {
    pendingId: string;
    status: 'approved' | 'rejected';
    finalId?: string;
    finalAppId?: string;
    reason?: string;
    decidedAt?: string;
  };
}

/**
 * Đích của push này. Feature mới publish thẳng sang Shared Projects; các
 * `pendingId` từ bản cũ được bỏ qua để lần push tiếp theo tự chuyển sang đích
 * Shared Project thật.
 */
export async function planPush(input: PlanPushInput): Promise<PushPlan> {
  const { db, projectId, kgs, media, submitter } = input;
  const project = getProject(db, projectId) as
    | { id: string; name?: string; metadata?: Record<string, unknown> | null }
    | null;
  const metadata = project?.metadata ?? null;

  const remote = await remoteProjects(kgs, media, false);
  const initialStudio = studioConfigOf(metadata);
  if (project && initialStudio.pendingId) {
    const nextStudio: Record<string, unknown> = { ...initialStudio };
    delete nextStudio.pendingId;
    updateProject(db, projectId, {
      metadata: { ...(metadata ?? {}), studioConfig: nextStudio },
    });
  }

  const currentMeta = () =>
    (getProject(db, projectId) as { metadata?: unknown } | null)?.metadata ?? metadata;

  const dest = resolvePushDest({
    projectId,
    projectName: project?.name,
    metadata: currentMeta(),
    remote,
    submitter,
  });

  return dest;
}

/** Ghi nhớ folder chờ vừa dùng để lần push sau trúng lại đúng chỗ (không tạo
 *  thêm folder chờ thứ hai cho cùng một dự án). */
export function rememberPendingId(db: SqliteDb, projectId: string, pendingId: string): void {
  const project = getProject(db, projectId) as { metadata?: Record<string, unknown> | null } | null;
  if (!project) return;
  const metadata = project.metadata ?? {};
  const sc = studioConfigOf(metadata);
  if (sc.pendingId === pendingId) return;
  updateProject(db, projectId, {
    metadata: { ...metadata, studioConfig: { ...sc, pendingId } },
  });
  invalidateRemoteCache();
}
