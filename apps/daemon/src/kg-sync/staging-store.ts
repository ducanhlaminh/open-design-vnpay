// I/O của vùng chờ duyệt trên media-service. Tách khỏi staging.ts để module
// hằng-số/parse kia ở lại THUẦN (studio mirror nó, và ba case của push-dest
// test được không cần store).

import type { MediaClient } from './media-client.js';
import {
  DECISIONS_FOLDER,
  STAGING_REQUEST_PATH,
  type StagingDecision,
  type StagingRequest,
  decisionPath,
  parseStagingRequest,
} from './staging.js';

const JSON_MIME = 'application/json';
/** Stage tag của metadata vùng chờ — không phải output của pipeline nào. */
const STAGING_STAGE = 'staging';

function toBuf(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Ghi phiếu yêu cầu vào gốc folder chờ. Gọi TRƯỚC khi sync file: một push đứt
 *  giữa đường vẫn phải để lại thứ người duyệt đọc được. */
export async function writeStagingRequest(
  media: MediaClient,
  destId: string,
  request: StagingRequest,
): Promise<void> {
  await media.uploadFile(destId, STAGING_STAGE, STAGING_REQUEST_PATH, JSON_MIME, toBuf(request));
}

export async function readStagingRequest(
  media: MediaClient,
  destId: string,
): Promise<StagingRequest | null> {
  try {
    const buf = await media.downloadFile(destId, STAGING_REQUEST_PATH);
    return parseStagingRequest(JSON.parse(buf.toString('utf8')));
  } catch {
    return null;
  }
}

/** Biên nhận quyết định — kênh một chiều studio → Open Design (od nằm sau NAT,
 *  studio không gọi ngược vào được). Không tạo folder khi chưa có biên nhận nào. */
export async function readStagingDecision(
  media: MediaClient,
  pendingId: string,
): Promise<StagingDecision | null> {
  try {
    if (!(await media.findFolderId(DECISIONS_FOLDER))) return null;
    const buf = await media.downloadFile(DECISIONS_FOLDER, decisionPath(pendingId));
    const raw = JSON.parse(buf.toString('utf8')) as StagingDecision;
    if (!raw || (raw.status !== 'approved' && raw.status !== 'rejected')) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writeStagingDecision(
  media: MediaClient,
  decision: StagingDecision,
): Promise<void> {
  await media.uploadFile(
    DECISIONS_FOLDER,
    STAGING_STAGE,
    decisionPath(decision.pendingId),
    JSON_MIME,
    toBuf(decision),
  );
}
