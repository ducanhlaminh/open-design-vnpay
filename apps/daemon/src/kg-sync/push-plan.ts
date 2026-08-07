// Lập KẾ HOẠCH cho một push: gọi remote registry, reconcile kết quả duyệt của
// lần push trước, rồi phân giải đích qua resolvePushDest (thuần).
//
// Một push-all đi qua N dự án nhưng chỉ cần MỘT ảnh chụp registry, nên danh
// sách remote được memo ngắn (~30s). Bù lại rủi ro cache cũ: nhánh nào định đi
// vào vùng chờ đều ép làm mới trước, vì dùng ảnh cũ ở đúng chỗ đó sẽ dựng lại
// một folder chờ cho dự án vừa được duyệt xong.

import type Database from 'better-sqlite3';
import type { RemoteProject } from '@open-design/contracts';

import { getProject, updateProject } from '../db.js';
import type { KgsClient } from './kgs-client.js';
import type { MediaClient } from './media-client.js';
import { loadRemoteProjects } from './remote-registry.js';
import {
  type PushDest,
  pendingResolved,
  resolvePushDest,
  studioConfigOf,
} from './push-dest.js';
import { readStagingDecision, readStagingRequest } from './staging-store.js';
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
  /** Yêu cầu chờ của lần push trước vừa được quyết trong lúc ta không nhìn. */
  reconciled?: { pendingId: string; status: 'approved' | 'rejected'; finalId?: string; reason?: string };
}

/**
 * Đích của push này, sau khi đã học kết quả duyệt còn treo.
 *
 * Reconcile-back GIỮ NGUYÊN id local: id đó vừa là PRIMARY KEY có 5 bảng con
 * tham chiếu ON DELETE CASCADE (không ON UPDATE), vừa là tên thư mục cwd, nên
 * đổi nó là một transaction viết tay 6 bảng — sai một nhịp là mồ côi cả thư
 * mục làm việc. Thay vào đó ta ghi `studioConfig.remoteId` và từ đó mọi push đi
 * nhánh case 3 lên id thật.
 */
export async function planPush(input: PlanPushInput): Promise<PushPlan> {
  const { db, projectId, kgs, media, submitter } = input;
  const project = getProject(db, projectId) as
    | { id: string; name?: string; metadata?: Record<string, unknown> | null }
    | null;
  const metadata = project?.metadata ?? null;

  let remote = await remoteProjects(kgs, media, false);
  let reconciled: PushPlan['reconciled'];

  const gonePending = pendingResolved({ metadata, remote });
  if (gonePending) {
    // Folder chờ biến mất khỏi ảnh chụp: hoặc nó vừa được quyết, hoặc ảnh chụp
    // đã cũ. Làm mới trước khi kết luận — kết luận nhầm nghĩa là mất liên kết
    // giữa dự án local và bản gốc trên studio.
    remote = await remoteProjects(kgs, media, true);
    if (pendingResolved({ metadata, remote })) {
      const decision = await readStagingDecision(media, gonePending);
      const sc = studioConfigOf(metadata);
      const nextSc: Record<string, unknown> = { ...sc };
      delete nextSc.pendingId;
      if (decision?.status === 'approved' && decision.finalId) {
        nextSc.remoteId = decision.finalId;
        if (decision.finalAppId) nextSc.appId = decision.finalAppId;
      }
      if (project) {
        updateProject(db, projectId, {
          metadata: { ...(metadata ?? {}), studioConfig: nextSc },
        });
      }
      reconciled = decision
        ? {
            pendingId: gonePending,
            status: decision.status,
            ...(decision.finalId ? { finalId: decision.finalId } : {}),
            ...(decision.reason ? { reason: decision.reason } : {}),
          }
        : // Không có biên nhận: folder bị xoá tay hoặc media tạm lỗi. Bỏ
          // pendingId để lần push sau tạo yêu cầu mới thay vì bơm file vào một
          // folder không còn tồn tại.
          { pendingId: gonePending, status: 'rejected', reason: 'folder chờ không còn trên store' };
    }
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

  // Sắp TẠO MỚI một folder chờ dựa trên ảnh chụp có thể đã cũ. Đây là chỗ duy
  // nhất cache 30s có thể gây hại thật (tạo yêu cầu trùng cho một dự án vừa
  // được duyệt), nên đường này luôn xác minh lại trên dữ liệu tươi.
  let final = dest;
  if (dest.staged && !dest.reusedPending) {
    const fresh = await remoteProjects(kgs, media, true);
    final = resolvePushDest({
      projectId,
      projectName: project?.name,
      metadata: currentMeta(),
      remote: fresh,
      submitter,
    });
  }

  // Đẩy lại vào một folder chờ đã có: phiếu cũ là nguồn duy nhất cho lịch sử
  // và cho kết quả TỪ CHỐI.
  //
  // Từ chối KHÔNG xoá folder (công của người submit nằm trong đó, và lý do chỉ
  // có ích khi nằm cạnh artifact), nên `pendingResolved` ở trên — vốn dựa vào
  // việc folder biến mất — không bao giờ thấy nó. Đây là chỗ duy nhất một lần
  // từ chối quay được về máy đã push.
  if (final.staged && final.reusedPending && final.request) {
    const prev = await readStagingRequest(media, final.destId);
    if (prev) {
      if (prev.status === 'rejected' && !reconciled) {
        reconciled = {
          pendingId: final.destId,
          status: 'rejected',
          ...(prev.reason ? { reason: prev.reason } : {}),
        };
      }
      // Push lại sau khi bị từ chối = "tôi sửa rồi, xem lại giúp": đưa phiếu về
      // `pending` (resolvePushDest đã đặt sẵn) nhưng giữ lịch sử để người duyệt
      // thấy đây là lần thứ mấy.
      final.request.history = [
        ...prev.history,
        ...(prev.status === 'rejected' && prev.decidedAt
          ? [{ at: prev.decidedAt, event: 'rejected', ...(prev.reason ? { note: prev.reason } : {}) }]
          : []),
      ];
      final.request.submittedAt = prev.submittedAt || final.request.submittedAt;
    }
  }
  if (final.staged && final.request) {
    final.request.history.push({ at: new Date().toISOString(), event: 'pushed' });
  }

  return { ...final, ...(reconciled ? { reconciled } : {}) };
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
