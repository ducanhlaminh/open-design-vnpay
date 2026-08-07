// Phân giải ĐÍCH của một push: ghi thẳng vào dự án thật, hay đổ vào vùng chờ
// duyệt (kg-sync/staging.ts).
//
// Ba case theo thiết kế:
//   case 3 — feature đã có trên studio  → ghi đè origin (hành vi cũ, staged=false)
//   case 1 — App đã có, feature chưa    → chờ duyệt
//   case 2 — chưa có cả hai             → chờ duyệt, duyệt tạo luôn App
//
// Hàm này THUẦN (không I/O): caller nạp `remote` (loadRemoteProjects, có memo)
// rồi truyền vào. Nhờ vậy ba case test được bằng mảng, không cần dựng KGS/media
// — và quan trọng hơn: một quyết định sai ở đây khiến push chờ duyệt xoá file
// của dự án thật (mirror-prune chạy trên destId), nên nó phải là thứ dễ test
// nhất trong cả luồng.

import type { RemoteProject } from '@open-design/contracts';

import {
  type StagingActor,
  type StagingAppTarget,
  type StagingRequest,
  pendingNonce,
  stagedFolderName,
} from './staging.js';

/** Push cần tạo mới nhưng máy chưa đăng nhập → không có ai để làm owner sau
 *  khi duyệt, và không có ai để báo kết quả. Chặn ngay thay vì tạo một yêu cầu
 *  mồ côi. */
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
  /** id thật trên studio, học được sau khi yêu cầu được duyệt. Id local KHÔNG
   *  đổi (xem staging.ts feature.localId), nên đây là cầu nối local → origin. */
  remoteId?: string;
  /** Folder chờ của yêu cầu đang treo, để re-push trúng lại đúng chỗ cũ. */
  pendingId?: string;
}

export function studioConfigOf(metadata: unknown): StudioConfigView {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const sc = (metadata as Record<string, unknown>).studioConfig;
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return {};
  const r = sc as Record<string, unknown>;
  return {
    ...(typeof r.appId === 'string' && r.appId ? { appId: r.appId } : {}),
    ...(typeof r.appName === 'string' && r.appName ? { appName: r.appName } : {}),
    ...(typeof r.remoteId === 'string' && r.remoteId ? { remoteId: r.remoteId } : {}),
    ...(typeof r.pendingId === 'string' && r.pendingId ? { pendingId: r.pendingId } : {}),
  };
}

export interface ResolvePushDestInput {
  projectId: string;
  projectName?: string | undefined;
  metadata?: unknown;
  /** Danh sách dự án từ xa (KGS ⊕ media) — đã lọc folder chờ. */
  remote: readonly RemoteProject[];
  /** Chủ nhân của push (machine user). null = chưa đăng nhập. */
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
  /** Phiếu để ghi lên store — chỉ có khi staged. */
  request?: StagingRequest;
  /** true khi tái dùng folder chờ đã có (re-push), false khi vừa tạo mới. */
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
  const { projectId, remote, submitter } = input;
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

  // ── case 1 / 2: phải qua vùng chờ ─────────────────────────────────────────
  if (!submitter) {
    throw new StagingBlockedError(
      'dự án này chưa có trên Pipeline Studio nên push phải qua bước duyệt — ' +
        'đăng nhập Google trong Open Design rồi push lại (người duyệt cần biết ai là chủ dự án)',
    );
  }

  const displayName = input.projectName?.trim() || projectId;
  const appExists = has(sc.appId);
  const kase: 1 | 2 = appExists ? 1 : 2;
  const targetApp: StagingAppTarget = appExists
    ? { mode: 'existing', id: sc.appId!, ...(sc.appName ? { name: sc.appName } : {}) }
    : {
        mode: 'create',
        desiredId: sc.appId || '',
        displayName: sc.appName || sc.appId || '',
      };

  // Tái dùng folder chờ cũ CHỈ KHI nó còn trên store. Nếu nó biến mất (đã
  // duyệt/từ chối) mà ta vẫn dùng lại tên đó, push này sẽ dựng lại một folder
  // chờ ma cho một dự án đã được duyệt — xem pendingResolved().
  const reuse = has(sc.pendingId);
  const destId = reuse ? sc.pendingId! : stagedFolderName(projectId, input.nonce ?? pendingNonce());

  const request: StagingRequest = {
    schema: 1,
    status: 'pending',
    case: kase,
    submittedAt: input.now ?? new Date().toISOString(),
    submitter,
    feature: { desiredId: projectId, displayName, localId: projectId },
    app: targetApp,
    ...(input.machine ? { machine: input.machine } : {}),
    history: [],
  };

  return { destId, staged: true, case: kase, targetApp, request, reusedPending: reuse };
}
