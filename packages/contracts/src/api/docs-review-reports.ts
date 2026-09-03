// Báo cáo tổng hợp docs-review (wp-docs-review-confirm-v2, Executor K).
// Daemon gom mọi bản xác nhận `docs-review-feedback/<install>/<confirmId>.json`
// (v1, nhãn `legacy`) và `.../<confirmId>/report.json` (v2) từ media store
// rồi phục vụ cho trang "Phản hồi" (`/feedback`) của open-design web:
//   GET /api/pipelines/docs-review/reports                          → DocsReviewReportsResponse
//   GET /api/pipelines/docs-review/reports/:projectId/:confirmationId → DocsReviewReportDetailResponse
//   GET .../reports/:projectId/:confirmationId/output?path=          → stream file output của bước
import type { ScreenPlatformScope } from './pipelines.js';
import type { DocsReviewAiOutcome, DocsReviewFeedbackArtifactV2, DocsReviewRevocation } from './docs-review-feedback.js';

/** Số của MỘT bản xác nhận (v1 chỉ có phần dr-review nên `comments` = 0). */
export interface DocsReviewReportSummary {
  agentProposals: number;
  humanEdits: number;
  comments: number;
  aiOutcome: DocsReviewAiOutcome;
}

export interface DocsReviewReportsSummary extends DocsReviewReportSummary {
  /** Số App phân biệt (không tính rổ "Chưa gắn App"). */
  apps: number;
  /** Số tính năng (= số projectId có ít nhất một bản xác nhận). */
  features: number;
  /** Tổng lượt xác nhận, kể cả các bản cũ của cùng tính năng. */
  confirmations: number;
}

export interface DocsReviewReportAppRow {
  /** `null` = tính năng chưa gắn App (UI hiện "Chưa gắn App"). */
  appId: string | null;
  appName: string;
  features: number;
  confirmations: number;
  aiOutcome: DocsReviewAiOutcome;
}

/** Bản xác nhận MỚI NHẤT của một tính năng (các bản cũ nằm ở detail "Lịch sử"). */
export interface DocsReviewCompletedRow {
  projectId: string;
  feature: { id: string; name: string };
  app: { id: string; name: string } | null;
  screenPlatform: ScreenPlatformScope | null;
  confirmedAt: number;
  user: string;
  confirmationId: string;
  installationId: string;
  summary: DocsReviewReportSummary;
  /** v1 (`<confirmId>.json`): chỉ có số đếm dr-review, không có chi tiết. */
  legacy: boolean;
  /** Có marker thu hồi. Trong thực tế `completed[]` đã LOẠI bản mới nhất bị
   *  thu hồi (feature coi như chưa hoàn tất) nên field này thường vắng —
   *  giữ trong shape để reader không phải đoán khi quy ước lọc đổi. */
  revoked?: DocsReviewRevocation;
}

export interface DocsReviewSkippedFile {
  projectId: string;
  path: string;
  reason: string;
}

export interface DocsReviewReportsResponse {
  /** false = media store chưa cấu hình / không kết nối được → mảng rỗng. */
  storeReachable: boolean;
  summary: DocsReviewReportsSummary;
  byApp: DocsReviewReportAppRow[];
  completed: DocsReviewCompletedRow[];
  /** File đọc được nhưng không parse thành bản xác nhận hợp lệ. */
  skippedFiles: DocsReviewSkippedFile[];
}

export interface DocsReviewReportHistoryEntry {
  confirmationId: string;
  confirmedAt: number;
  user: string;
  legacy: boolean;
  /** Bản này đã bị thu hồi (marker `revoked.json` trên media). */
  revoked?: DocsReviewRevocation;
}

export interface DocsReviewReportDetailResponse {
  report: DocsReviewFeedbackArtifactV2;
  /** Mọi bản xác nhận của cùng projectId, mới nhất trước. */
  history: DocsReviewReportHistoryEntry[];
  /** Bản đang xem đã bị thu hồi — snapshot vẫn xem được (audit). */
  revoked?: DocsReviewRevocation;
}

// ── Snapshot project id (chỉ đọc) ───────────────────────────────────────────
// Trang chi tiết báo cáo (`/feedback/docs-review/:projectId/:confirmationId`)
// dựng lại đúng Quick result của từng bước bằng CÙNG các viewer của pipeline
// (FileViewer → FlowUxReviewPreview / MockupsPreview / DocRedlinePreview…).
// Các viewer đó đọc file qua `/api/projects/:id/raw/<name>` + comment qua
// `/api/projects/:id/docs-review/comments/:stageId`, nên daemon phục vụ một
// "dự án ảo" chỉ đọc có id dạng `drsnap.<confirmationId>.<projectId>` — file
// lấy từ snapshot output của bản xác nhận trên media, comment từ report.json,
// mọi request ghi → 405. Id hợp lệ theo `isSafeId` (chữ/số/`.`/`_`/`-`):
// confirmationId là hex nên không chứa `.`, projectId là phần còn lại.
export const DOCS_REVIEW_SNAPSHOT_PROJECT_PREFIX = 'drsnap.';

export function docsReviewSnapshotProjectId(projectId: string, confirmationId: string): string {
  return `${DOCS_REVIEW_SNAPSHOT_PROJECT_PREFIX}${confirmationId}.${projectId}`;
}

export function parseDocsReviewSnapshotProjectId(id: string): { projectId: string; confirmationId: string } | null {
  if (!id.startsWith(DOCS_REVIEW_SNAPSHOT_PROJECT_PREFIX)) return null;
  const rest = id.slice(DOCS_REVIEW_SNAPSHOT_PROJECT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  const confirmationId = rest.slice(0, dot);
  const projectId = rest.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(confirmationId)) return null;
  return { projectId, confirmationId };
}

export function isDocsReviewSnapshotProjectId(id: string): boolean {
  return parseDocsReviewSnapshotProjectId(id) !== null;
}
