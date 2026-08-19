export type DocReviewChangeOperation = 'add' | 'edited' | 'delete';
/** `'system'` = daemon-generated change (currently only the flow-diagram
 *  replacement written by dr-review's enrich step, see docs-review.ts's
 *  `DocChange.origin`) — kept distinct from `'agent'` (LLM review) so
 *  aggregate metrics (see docs-review-feedback.ts's `DocsReviewEnrichMetrics`)
 *  can count it without conflating the two sources. */
export type DocReviewAnnotationOrigin = 'agent' | 'user' | 'system';
export type DocReviewAnnotationStatus = 'active' | 'edited' | 'dismissed';

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

export interface ConfirmDocsReviewResponse {
  ok: true;
  artifact: DocsReviewFeedbackArtifact;
  mediaPath: string;
  localPath: string;
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
