// Báo cáo tổng hợp docs-review (wp-docs-review-confirm-v2, Executor K).
// Daemon gom mọi bản xác nhận `docs-review-feedback/<install>/<confirmId>.json`
// (v1, nhãn `legacy`) và `.../<confirmId>/report.json` (v2) từ media store
// rồi phục vụ cho trang "Phản hồi" (`/feedback`) của open-design web:
//   GET /api/pipelines/docs-review/reports                          → DocsReviewReportsResponse
//   GET /api/pipelines/docs-review/reports/:projectId/:confirmationId → DocsReviewReportDetailResponse
//   GET .../reports/:projectId/:confirmationId/output?path=          → stream file output của bước
import type { ScreenPlatformScope } from './pipelines.js';
import type { DocsReviewAiOutcome, DocsReviewFeedbackArtifactV2 } from './docs-review-feedback.js';

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
}

export interface DocsReviewReportDetailResponse {
  report: DocsReviewFeedbackArtifactV2;
  /** Mọi bản xác nhận của cùng projectId, mới nhất trước. */
  history: DocsReviewReportHistoryEntry[];
}
