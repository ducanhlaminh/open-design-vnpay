// Phân giải ĐÍCH của một push. Mọi Feature mới được publish trực tiếp vào
// Shared Projects; Pipeline Studio không còn là một approval gate.
//
// Hàm này THUẦN (không I/O): caller nạp `remote` (loadRemoteProjects, có memo)
// rồi truyền vào. Nhờ vậy ba case test được bằng mảng, không cần dựng KGS/media
// — và quan trọng hơn: một quyết định sai ở đây khiến mirror-prune chạy vào
// nhầm đích, nên nó phải là thứ dễ test nhất trong cả luồng.

import type { ApprovedProjectMapping, RemoteProject } from '@open-design/contracts';

import {
  type StagingActor,
  type StagingAppTarget,
  type StagingRequest,
} from './staging.js';

/** @deprecated Approval staging has been removed; retained for API compatibility. */
export class StagingBlockedError extends Error {
  readonly code = 'STAGING_NO_SUBMITTER';
  constructor(message: string) {
    super(message);
    this.name = 'StagingBlockedError';
  }
}

/** Phần `metadata.studioConfig` mà luồng này đọc/ghi. */
export interface StudioConfigView {
  appId?: string;
  appName?: string;
  designSystemId?: string | null;
  /** id thật trên studio, học được sau khi yêu cầu được duyệt. Id local KHÔNG
   *  đổi (xem staging.ts feature.localId), nên đây là cầu nối local → origin. */
  remoteId?: string;
  /** Legacy approval folder from app versions before direct sharing. */
  pendingId?: string;
  approvedMapping?: ApprovedProjectMapping;
}

export function studioConfigOf(metadata: unknown): StudioConfigView {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const sc = (metadata as Record<string, unknown>).studioConfig;
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return {};
  const r = sc as Record<string, unknown>;
  const rawMapping = r.approvedMapping;
  const approvedMapping =
    rawMapping && typeof rawMapping === 'object' && !Array.isArray(rawMapping)
      ? (rawMapping as Record<string, unknown>)
      : null;
  const validMapping = approvedMapping
    && typeof approvedMapping.localProjectId === 'string'
    && typeof approvedMapping.approvedProjectId === 'string'
    && typeof approvedMapping.pendingId === 'string'
    && typeof approvedMapping.decidedAt === 'string';
  return {
    ...(typeof r.appId === 'string' && r.appId ? { appId: r.appId } : {}),
    ...(typeof r.appName === 'string' && r.appName ? { appName: r.appName } : {}),
    ...(typeof r.designSystemId === 'string' ? { designSystemId: r.designSystemId } : {}),
    ...(typeof r.remoteId === 'string' && r.remoteId ? { remoteId: r.remoteId } : {}),
    ...(typeof r.pendingId === 'string' && r.pendingId ? { pendingId: r.pendingId } : {}),
    ...(validMapping
      ? { approvedMapping: approvedMapping as unknown as ApprovedProjectMapping }
      : {}),
  };
}

export interface ResolvePushDestInput {
  projectId: string;
  projectName?: string | undefined;
  metadata?: unknown;
  /** Danh sách dự án từ xa (KGS ⊕ media). */
  remote: readonly RemoteProject[];
  /** Chủ nhân của push (machine user), used to register Shared Projects. */
  submitter: StagingActor | null;
  /** Bơm được để test tất định. */
  nonce?: string;
  now?: string;
  machine?: { host?: string; odVersion?: string };
}

export interface PushDest {
  /** Nơi MỌI thao tác media của push này trỏ tới (sync, mirror-prune, _v/,
   *  changelog). Bằng projectId ở case 3. */
  destId: string;
  staged: boolean;
  case: 1 | 2 | 3;
  targetApp: StagingAppTarget | null;
  /** Legacy approval ticket; newly created pushes never set this field. */
  request?: StagingRequest;
  /** Legacy approval state. */
  reusedPending?: boolean;
}

/** Yêu cầu chờ của dự án này đã được QUYẾT (folder không còn trên store) →
 *  caller phải đọc biên nhận và reconcile trước khi push tiếp, nếu không nó sẽ
 *  dựng lại đúng cái folder chờ vừa được duyệt đi. */
export function pendingResolved(input: {
  metadata?: unknown;
  remote: readonly RemoteProject[];
}): string | null {
  const { pendingId } = studioConfigOf(input.metadata);
  if (!pendingId) return null;
  return input.remote.some((r) => r.projectId === pendingId) ? null : pendingId;
}

export function resolvePushDest(input: ResolvePushDestInput): PushDest {
  const { projectId, remote } = input;
  const sc = studioConfigOf(input.metadata);
  const has = (id: string | undefined): boolean =>
    !!id && remote.some((r) => r.projectId === id);

  // ── case 3: đã có đích thật ────────────────────────────────────────────────
  // `remoteId` (học được sau khi duyệt) thắng; nếu không thì chính id local —
  // dự án pull về từ studio có id local == id origin.
  if (has(sc.remoteId)) {
    return { destId: sc.remoteId!, staged: false, case: 3, targetApp: null };
  }
  if (has(projectId)) {
    return { destId: projectId, staged: false, case: 3, targetApp: null };
  }

  // Feature mới dùng luôn id local làm id shared. `case: 3` giữ compatibility
  // cho DTO cũ: kết quả luôn là một đích thật, không phải `pending--…`.
  return { destId: projectId, staged: false, case: 3, targetApp: null };
}
