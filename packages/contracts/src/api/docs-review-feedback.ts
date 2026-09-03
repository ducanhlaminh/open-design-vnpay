import type { ScreenPlatformScope } from './pipelines.js';

export type DocReviewChangeOperation = 'add' | 'edited' | 'delete';
/** `'system'` = daemon-generated change (currently only the flow-diagram
 *  replacement written by dr-review's enrich step, see docs-review.ts's
 *  `DocChange.origin`) — kept distinct from `'agent'` (LLM review) so
 *  aggregate metrics (see docs-review-feedback.ts's `DocsReviewEnrichMetrics`)
 *  can count it without conflating the two sources. */
export type DocReviewAnnotationOrigin = 'agent' | 'user' | 'system';
export type DocReviewAnnotationStatus = 'active' | 'edited' | 'dismissed';

/** Bình luận của người dùng gắn vào một change/note trong sidecar
 *  (`.changes.json` / `.notes.json`). Trước 0.8.164 chỉ web biết shape này;
 *  parser giữ nguyên để dr-confirm v2 gửi được lên studio. */
export interface DocAnnotationComment {
  id: string;
  text: string;
  at: number;
  by?: string;
}

export interface DocReviewAnnotation {
  id: string;
  origin: DocReviewAnnotationOrigin;
  operation: DocReviewChangeOperation;
  before?: string;
  quote?: string;
  anchor?: string;
  initialBefore?: string;
  initialQuote?: string;
  status?: DocReviewAnnotationStatus;
  kind?: string;
  severity?: string;
  rule_id?: string;
  reason?: string;
  comments?: DocAnnotationComment[];
}

export interface DocReviewAnnotationEvent {
  id: string;
  annotationId: string;
  type: 'create' | 'edit' | 'dismiss' | 'restore';
  actor: DocReviewAnnotationOrigin;
  at: number;
  before?: string;
  quote?: string;
  anchor?: string;
}

export interface DocReviewAnnotationFileV2 {
  schemaVersion: 2;
  annotations: DocReviewAnnotation[];
  events: DocReviewAnnotationEvent[];
}

export interface DocReviewOperationCounts {
  add: number;
  edited: number;
  delete: number;
  total: number;
}

export interface DocReviewAgentCounts extends DocReviewOperationCounts {
  accepted: number;
  editedByUser: number;
  dismissed: number;
}

/** Counts for the two daemon-driven "enrich" surfaces (dr-review's WP2 —
 *  see docs-review-enrich.ts): the flow-diagram replacement and the
 *  "Cấu thành màn hình" composition table insertion. Separate from
 *  {@link DocReviewAgentCounts} because those two surfaces have their own
 *  accept/dismiss/edit semantics a reader cares about independently of the
 *  generic agent-change tally (see docs-review-feedback.ts's
 *  `aggregateDocsReviewMetrics`). Optional on both the artifact and each
 *  page so older readers/writers that predate this field keep working. */
export interface DocsReviewEnrichMetrics {
  diagrams: { total: number; accepted: number; dismissed: number };
  compositionTables: { total: number; accepted: number; dismissed: number; editedByUser: number };
}

export interface DocReviewFeedbackPageMetrics {
  page: string;
  agent: DocReviewAgentCounts;
  user: DocReviewOperationCounts;
  enrich?: DocsReviewEnrichMetrics;
}

export interface DocsReviewFeedbackArtifact {
  schemaVersion: 1;
  confirmationId: string;
  projectId: string;
  workflowId: 'docs-review';
  installationId: string;
  user: string;
  channel: 'dev' | 'packaged';
  confirmedAt: number;
  sourceRunId?: string;
  agent: DocReviewAgentCounts;
  userChanges: DocReviewOperationCounts;
  pages: DocReviewFeedbackPageMetrics[];
  enrich?: DocsReviewEnrichMetrics;
}

export interface ConfirmDocsReviewRequest {
  confirmationId?: string;
  sourceRunId?: string;
}

// ─── dr-confirm v2 (2026-08-28, wp-docs-review-confirm-v2) ──────────────────
// Xác nhận hoàn tất gửi TOÀN BỘ kết quả 5 bước (output + comment + metrics)
// thay vì chỉ số đếm dr-review. Studio "Phản hồi" đọc `report.json` này.

export type DocsReviewStageId = 'dr-docs' | 'dr-flow' | 'dr-flow-improve' | 'dr-mockup' | 'dr-review';

/** Comment cấp bước, file `docs-review/comments/<stageId>.json` (ngoài outputs
 *  → sống sót re-run). `target` tuỳ chọn neo vào màn / flow / trang. */
export interface DocsReviewStageComment {
  id: string;
  stageId: DocsReviewStageId;
  text: string;
  by: string;
  at: number;
  target?: { kind: 'screen' | 'flow' | 'page'; key: string; label?: string };
}
export interface DocsReviewStageCommentsFile { schemaVersion: 1; comments: DocsReviewStageComment[] }

/** `GET /api/projects/:id/docs-review/comments/:stageId` */
export interface DocsReviewStageCommentsResponse { stageId: DocsReviewStageId; comments: DocsReviewStageComment[] }
/** `POST /api/projects/:id/docs-review/comments/:stageId` */
export interface CreateDocsReviewStageCommentRequest {
  text: string;
  target?: DocsReviewStageComment['target'];
}
export interface CreateDocsReviewStageCommentResponse { comment: DocsReviewStageComment }

/** Một file output của bước, đã upload kèm report (`mediaPath` trong cùng
 *  folder media của project: `docs-review-feedback/<install>/<confirmId>/outputs/<path>`). */
export interface DocsReviewOutputRef { path: string; size: number; mediaPath: string }

export type DocsReviewFlowVariant = 'original' | 'improved';
export type DocsReviewFlowSelectionSource = 'user' | 'run-all' | 'default';

export type DocsReviewStageMetrics =
  | { kind: 'dr-docs'; pages: number }
  | {
      kind: 'dr-flow';
      flows: number;
      screens: number;
      platform: ScreenPlatformScope | null;
      drawioEdited: boolean;
      overrides: { add: number; rename: number; remove: number };
    }
  | {
      kind: 'dr-flow-improve';
      flows: Array<{
        flowId: string;
        variant: DocsReviewFlowVariant;
        source: DocsReviewFlowSelectionSource;
        patchOps: number;
        findings: number;
        proposedScreens: number;
        removedScreens: number;
        proposedEdited: boolean;
      }>;
    }
  | { kind: 'dr-mockup'; screens: number; variant: string | null }
  | {
      kind: 'dr-review';
      agent: DocReviewAgentCounts;
      userChanges: DocReviewOperationCounts;
      notes: { total: number; dismissed: number; user: number };
      annotationComments: number;
      pages: DocReviewFeedbackPageMetrics[];
      enrich: { diagrams: DocsReviewEnrichMetrics['diagrams'] };
    };

export interface DocsReviewStageReport {
  stageId: DocsReviewStageId;
  name: string;
  runId?: string;
  status: 'succeeded';
  outputs: DocsReviewOutputRef[];
  /** File bị bỏ khỏi snapshot (quá 5 MB / attachments) — để studio nói rõ. */
  skipped?: Array<{ path: string; reason: string }>;
  comments: DocsReviewStageComment[];
  metrics: DocsReviewStageMetrics;
}

/** Kết cục đề xuất của AI dưới tay người: giữ / sửa / bỏ. Định nghĩa gộp
 *  (dr-review annotation + dr-flow-improve gói + overrides remove) — xem spec. */
export interface DocsReviewAiOutcome { proposals: number; accepted: number; edited: number; dismissed: number }

export interface DocsReviewFeedbackArtifactV2 {
  schemaVersion: 2;
  confirmationId: string;
  projectId: string;
  workflowId: 'docs-review';
  installationId: string;
  user: string;
  channel: 'dev' | 'packaged';
  confirmedAt: number;
  app: { id: string; name: string } | null;
  feature: { id: string; name: string };
  screenPlatform: ScreenPlatformScope | null;
  stages: DocsReviewStageReport[];
  summary: { agentProposals: number; humanEdits: number; comments: number; aiOutcome: DocsReviewAiOutcome };
  /** Giữ để studio cũ (parser v1) và trang `/analytics/docs-review` hiện tại
   *  vẫn đọc được: đúng các số của dr-review như artifact v1. */
  agent: DocReviewAgentCounts;
  userChanges: DocReviewOperationCounts;
  pages: DocReviewFeedbackPageMetrics[];
}

export interface ConfirmDocsReviewResponse {
  ok: true;
  artifact: DocsReviewFeedbackArtifactV2;
  mediaPath: string;
  localPath: string;
  /** `<OD_STUDIO_URL>/analytics/docs-review/<projectId>/<confirmationId>` khi env có. */
  studioUrl?: string;
}

// ─── Thu hồi xác nhận (wp-docs-review-confirm-revoke) ───────────────────────
// Marker append-only cạnh bản xác nhận (media `…/<confirmId>/revoked.json` +
// `…/<confirmId>.revoked.json`, local `confirmation/<confirmId>.revoked.json`)
// — KHÔNG xóa report cũ (giữ audit). Confirm lại cùng digest sẽ gỡ marker.

export interface DocsReviewRevocation {
  revokedAt: number;
  user: string;
  reason?: string;
}

/** `POST /api/projects/:id/docs-review/confirm/revoke` — `confirmationId` bỏ
 *  trống = thu hồi bản local MỚI NHẤT theo `confirmedAt`. */
export interface RevokeDocsReviewConfirmationRequest {
  confirmationId?: string;
  reason?: string;
}

export interface RevokeDocsReviewConfirmationResponse {
  ok: true;
  confirmationId: string;
  revokedAt: number;
}

/** `GET /api/projects/:id/docs-review/confirm/state` — trạng thái xác nhận
 *  của dự án (đọc biên nhận local `confirmation/`), cho chip ở màn Pipelines. */
export interface DocsReviewConfirmationState {
  latest: { confirmationId: string; confirmedAt: number; revoked?: DocsReviewRevocation } | null;
}

function parseAnnotationComments(raw: unknown[]): DocAnnotationComment[] {
  const out: DocAnnotationComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id.trim() || typeof v.text !== 'string' || !v.text.trim()) continue;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
    out.push({ id: v.id, text: v.text, at: v.at, ...(typeof v.by === 'string' && v.by.trim() ? { by: v.by } : {}) });
  }
  return out;
}

function operationOf(value: { before?: string; quote?: string }): DocReviewChangeOperation {
  return value.before && value.quote ? 'edited' : value.quote ? 'add' : 'delete';
}

/** Browser/daemon-shared tolerant reader. Legacy agent arrays are normalized
 * without rewriting them; new writers should serialize the v2 envelope. */
export function parseDocReviewAnnotationFile(raw: string): DocReviewAnnotationFileV2 | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const legacy = Array.isArray(parsed);
  const source: unknown[] | null = legacy
    ? parsed as unknown[]
    : parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion === 2
      && Array.isArray((parsed as { annotations?: unknown }).annotations)
      ? (parsed as { annotations: unknown[] }).annotations
      : null;
  if (!source) return null;
  const annotations: DocReviewAnnotation[] = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id.trim()) continue;
    const before = typeof value.before === 'string' && value.before ? value.before : undefined;
    const quote = typeof value.quote === 'string' && value.quote ? value.quote : undefined;
    if (!before && !quote) continue;
    const origin: DocReviewAnnotationOrigin =
      value.origin === 'user' ? 'user' : value.origin === 'system' ? 'system' : 'agent';
    const operation = value.operation === 'add' || value.operation === 'edited' || value.operation === 'delete'
      ? value.operation : operationOf({ ...(before ? { before } : {}), ...(quote ? { quote } : {}) });
    annotations.push({
      id: value.id,
      origin,
      operation,
      ...(before ? { before } : {}),
      ...(quote ? { quote } : {}),
      ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}),
      ...(typeof value.initialBefore === 'string' ? { initialBefore: value.initialBefore } : before ? { initialBefore: before } : {}),
      ...(typeof value.initialQuote === 'string' ? { initialQuote: value.initialQuote } : quote ? { initialQuote: quote } : {}),
      ...(value.status === 'dismissed' ? { status: 'dismissed' as const } : value.status === 'edited' ? { status: 'edited' as const } : {}),
      ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
      ...(typeof value.severity === 'string' ? { severity: value.severity } : {}),
      ...(typeof value.rule_id === 'string' ? { rule_id: value.rule_id } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(Array.isArray(value.comments) && value.comments.length ? { comments: parseAnnotationComments(value.comments) } : {}),
    });
  }
  const rawEvents = !legacy && Array.isArray((parsed as { events?: unknown }).events)
    ? (parsed as { events: unknown[] }).events
    : [];
  // The event ledger is deliberately tolerant of a partially-written entry,
  // but never lets unvalidated JSON masquerade as a typed event.  The current
  // annotation remains readable when one historical event is malformed.
  const events: DocReviewAnnotationEvent[] = [];
  for (const item of rawEvents) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== 'string' || !value.id.trim()
      || typeof value.annotationId !== 'string' || !value.annotationId.trim()
      || (value.type !== 'create' && value.type !== 'edit' && value.type !== 'dismiss' && value.type !== 'restore')
      || (value.actor !== 'agent' && value.actor !== 'user')
      || typeof value.at !== 'number' || !Number.isFinite(value.at)
    ) continue;
    events.push({
      id: value.id,
      annotationId: value.annotationId,
      type: value.type,
      actor: value.actor,
      at: value.at,
      ...(typeof value.before === 'string' ? { before: value.before } : {}),
      ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
      ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}),
    });
  }
  return { schemaVersion: 2, annotations, events };
}

export function serializeDocReviewAnnotationFile(value: DocReviewAnnotationFileV2): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
