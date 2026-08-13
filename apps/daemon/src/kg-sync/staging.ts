// Vùng chờ duyệt (staging) — dự án/feature khai sinh ở Open Design đi vào
// danh sách chính của Pipeline Studio qua một BƯỚC DUYỆT, không ghi thẳng.
//
// Cơ chế là PREFIX TÊN FOLDER trên media-service, không phải một storage riêng:
// một push cần tạo mới (feature chưa có, hoặc chưa có cả App) đổ file vào folder
// `pending--<slug>--<nonce>` kèm một phiếu `request.json`. Người có quyền
// `projects:approve` bên studio thấy danh sách folder prefix này, và DUYỆT =
// một lần `PATCH /api/v1/folders/:id {name}` — media-service giữ đường dẫn file
// trong TAG (`path:<rel>`) chứ không phải cột, nên rename là lossless: `_v/…`
// và `changelog.json` sống nguyên vẹn, không phải copy byte nào.
//
// Vì sao staged push KHÔNG chạm identity: identity project phải do người
// duyệt tạo với id cuối cùng, tạo AS người submit để identity set họ làm
// owner — đăng ký dưới tên `pending--…` sẽ là rác vĩnh viễn.
//
// Đối chiếu phía studio: ui/pipeline-studio/server/staging.ts (mirror hằng số).

import { randomBytes } from 'node:crypto';
import type { FeatureContextBinding } from '@open-design/contracts';

/** Prefix đánh dấu một media folder là yêu cầu chờ duyệt.
 *  `--` chứ không phải `:` — media-service cấm `/ \ ? * < > | :` trong tên
 *  folder (services/media-service/internal/domain/folder.go ValidateFolderName). */
export const PENDING_PREFIX = 'pending--';

/** Phiếu yêu cầu, ở gốc folder chờ. */
export const STAGING_REQUEST_PATH = 'request.json';

/** Folder biên nhận quyết định duyệt/từ chối, mỗi yêu cầu một file
 *  `<pendingId>.json`. Nằm trong vùng prefix để tự động bị lọc khỏi danh sách
 *  dự án của Open Design; studio loại nó khỏi danh sách chờ bằng tên chính xác.
 *
 *  Vì sao cần biên nhận: duyệt xong folder chờ ĐÃ ĐỔI TÊN, nên nó không còn
 *  dấu vết nào để Open Design (nằm sau NAT, studio không gọi vào được) biết
 *  yêu cầu của mình đã thành id nào. Biên nhận là kênh poll một chiều đó. */
export const DECISIONS_FOLDER = `${PENDING_PREFIX}decisions`;

export function isPending(folderName: string): boolean {
  return folderName.startsWith(PENDING_PREFIX);
}

/** Một folder chờ THỰC SỰ là yêu cầu (không phải folder biên nhận nội bộ). */
export function isPendingRequest(folderName: string): boolean {
  return isPending(folderName) && folderName !== DECISIONS_FOLDER;
}

const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Hậu tố ngẫu nhiên 6 ký tự base36.
 *
 *  BẮT BUỘC, không phải để cho đẹp: thiếu nó, hai người cùng stage một feature
 *  trùng tên sẽ đổ file vào CÙNG một folder và trộn lẫn kết quả của nhau — mất
 *  dữ liệu âm thầm, không có lỗi nào báo. `bytes` cho phép test bơm giá trị
 *  tất định. */
export function pendingNonce(bytes: Uint8Array = randomBytes(6)): string {
  let out = '';
  for (const b of bytes) out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
  return out.slice(0, 6).padEnd(6, '0');
}

/** Tên folder chờ cho một feature.
 *
 *  Tên KHÔNG mã hoá App đích: id cuối cùng được chọn lại lúc duyệt (dedupe với
 *  state thật bên studio), nên tên chờ chỉ cần duy nhất + đọc ra được ý định.
 *  App đích nằm trong request.json. */
export function stagedFolderName(desiredId: string, nonce: string = pendingNonce()): string {
  return `${PENDING_PREFIX}${desiredId}--${nonce}`;
}

/** Tách `pending--<desiredId>--<nonce>` ngược lại. `desiredId` được phép chứa
 *  `--`, nên dấu tách là cụm `--` CUỐI CÙNG. */
export function parsePendingName(folderName: string): { desiredId: string; nonce: string } | null {
  if (!isPendingRequest(folderName)) return null;
  const rest = folderName.slice(PENDING_PREFIX.length);
  const cut = rest.lastIndexOf('--');
  if (cut <= 0) return null;
  const desiredId = rest.slice(0, cut);
  const nonce = rest.slice(cut + 2);
  if (!desiredId || !nonce) return null;
  return { desiredId, nonce };
}

export interface StagingActor {
  id: string;
  email?: string;
  name?: string;
}

export type StagingStatus = 'pending' | 'approved' | 'rejected';

/** App đích của yêu cầu: đã tồn tại trên studio (case 1) hay phải tạo mới
 *  cùng lúc với feature (case 2). */
export type StagingAppTarget =
  | { mode: 'existing'; id: string; name?: string; designSystemId?: string | null }
  | { mode: 'create'; desiredId: string; displayName: string; designSystemId?: string | null };

/** `request.json` — phiếu yêu cầu, ghi ngay sau khi tạo folder chờ và TRƯỚC
 *  khi sync file, để một push đứt giữa đường vẫn để lại thứ đọc được. */
export interface StagingRequest {
  schema: 1 | 2;
  status: StagingStatus;
  /** 1 = App đã có, chỉ thiếu feature. 2 = chưa có cả hai. */
  case: 1 | 2;
  submittedAt: string;
  submitter: StagingActor;
  feature: {
    desiredId: string;
    displayName: string;
    /** Id của project bên Open Design. Là thứ làm reconcile-back khả thi:
     *  id local KHÔNG đổi được (PK + 5 FK ON DELETE CASCADE không kèm
     *  ON UPDATE, và id cũng là tên thư mục cwd), nên máy local học id cuối
     *  cùng bằng cách lưu `remoteId` chứ không tự đổi tên mình. */
    localId: string;
    /** Immutable App Context selected by the Feature. Studio rewrites only
     * appId when approval renames the App; version/digest stay unchanged. */
    appContextBinding?: FeatureContextBinding;
  };
  app: StagingAppTarget;
  machine?: { host?: string; odVersion?: string };
  /** Human-review summary. Added in schema 2; legacy readers may ignore it. */
  publish?: { stages: string[]; outputTypes: string[] };
  /** App-owned files are carried beside this feature only while it waits for
   * approval. Studio moves them into the App folder before it renames the
   * feature folder, so a feature never ends up containing App documents. */
  appPublish?: { files: number; includesDocsPool: boolean };
  history: Array<{ at: string; event: string; note?: string }>;
  /** Chỉ có sau khi quyết. */
  finalId?: string;
  finalAppId?: string;
  decidedAt?: string;
  decidedBy?: StagingActor | null;
  reason?: string;
}

/** Biên nhận đọc bởi Open Design để học kết quả (xem DECISIONS_FOLDER). */
export interface StagingDecision {
  /** Missing means the legacy v1 receipt. New writers emit 2. */
  schema?: 1 | 2;
  pendingId: string;
  status: 'approved' | 'rejected';
  /** id cuối cùng trên studio (chỉ khi approved). */
  finalId?: string;
  finalAppId?: string;
  localId?: string;
  reason?: string;
  decidedAt: string;
  decidedBy?: StagingActor | null;
}

export function decisionPath(pendingId: string): string {
  return `${pendingId}.json`;
}

/** Parse phòng thủ: phiếu là JSON do máy khác ghi, một field lệch không được
 *  làm hỏng cả danh sách chờ. Trả null khi không đủ nhận dạng. */
export function parseStagingRequest(raw: unknown): StagingRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const feature = r.feature;
  if (!feature || typeof feature.desiredId !== 'string' || !feature.desiredId) return null;
  const submitter = r.submitter;
  if (!submitter || typeof submitter.id !== 'string' || !submitter.id) return null;
  const status: StagingStatus =
    r.status === 'approved' || r.status === 'rejected' ? r.status : 'pending';
  const app: StagingAppTarget =
    r.app?.mode === 'create'
      ? {
          mode: 'create',
          desiredId: String(r.app.desiredId ?? ''),
          displayName: String(r.app.displayName ?? r.app.desiredId ?? ''),
          ...(typeof r.app.designSystemId === 'string' ? { designSystemId: r.app.designSystemId } : {}),
        }
      : { mode: 'existing', id: String(r.app?.id ?? ''), ...(r.app?.name ? { name: String(r.app.name) } : {}), ...(typeof r.app?.designSystemId === 'string' ? { designSystemId: r.app.designSystemId } : {}) };
  return {
    schema: r.schema === 2 ? 2 : 1,
    status,
    case: r.case === 1 ? 1 : 2,
    submittedAt: typeof r.submittedAt === 'string' ? r.submittedAt : '',
    submitter: {
      id: submitter.id,
      ...(submitter.email ? { email: String(submitter.email) } : {}),
      ...(submitter.name ? { name: String(submitter.name) } : {}),
    },
    feature: {
      desiredId: feature.desiredId,
      displayName: typeof feature.displayName === 'string' && feature.displayName ? feature.displayName : feature.desiredId,
      localId: typeof feature.localId === 'string' ? feature.localId : feature.desiredId,
      ...(feature.appContextBinding && typeof feature.appContextBinding === 'object'
        ? { appContextBinding: feature.appContextBinding as FeatureContextBinding }
        : {}),
    },
    app,
    ...(r.machine && typeof r.machine === 'object' ? { machine: r.machine } : {}),
    ...(r.publish && typeof r.publish === 'object'
      ? {
          publish: {
            stages: Array.isArray(r.publish.stages)
              ? r.publish.stages.filter((x: unknown): x is string => typeof x === 'string')
              : [],
            outputTypes: Array.isArray(r.publish.outputTypes)
              ? r.publish.outputTypes.filter((x: unknown): x is string => typeof x === 'string')
              : [],
          },
        }
      : {}),
    ...(r.appPublish && typeof r.appPublish === 'object'
      ? { appPublish: { files: typeof r.appPublish.files === 'number' ? r.appPublish.files : 0, includesDocsPool: r.appPublish.includesDocsPool === true } }
      : {}),
    history: Array.isArray(r.history)
      ? r.history.filter((h: any) => h && typeof h.at === 'string' && typeof h.event === 'string')
      : [],
    ...(typeof r.finalId === 'string' ? { finalId: r.finalId } : {}),
    ...(typeof r.finalAppId === 'string' ? { finalAppId: r.finalAppId } : {}),
    ...(typeof r.decidedAt === 'string' ? { decidedAt: r.decidedAt } : {}),
    ...(r.decidedBy && typeof r.decidedBy === 'object' ? { decidedBy: r.decidedBy } : {}),
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
  };
}
