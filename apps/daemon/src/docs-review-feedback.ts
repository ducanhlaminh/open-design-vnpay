import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfirmDocsReviewResponse,
  DocReviewAgentCounts,
  DocReviewAnnotationFileV2,
  DocReviewFeedbackPageMetrics,
  DocReviewOperationCounts,
  DocsReviewAiOutcome,
  DocsReviewEnrichMetrics,
  DocsReviewFeedbackArtifact,
  DocsReviewFeedbackArtifactV2,
  DocsReviewOutputRef,
  DocsReviewStageComment,
  DocsReviewStageId,
  DocsReviewStageMetrics,
  DocsReviewStageReport,
  ScreenPlatformScope,
} from '@open-design/contracts';
import { parseDocReviewAnnotationFile } from '@open-design/contracts';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { getPipelineDef, getWorkflow, isScreenPlatformScope, screenPlatformScopeFor } from './pipelines.js';
import { DOCS_REVIEW_COMMENTS_DIR, readDocsReviewStageComments } from './docs-review-comments.js';

/** `uploadFile` là đủ (test giả lập); MediaClient thật có thêm
 *  `openFolderSession` → mở MỘT session cho cả loạt file (ensureFolder + list
 *  một lần thay vì mỗi file một lần). */
type UploadClient = Pick<MediaClient, 'uploadFile'> & Partial<Pick<MediaClient, 'openFolderSession'>>;
export interface DocsReviewMetricsPage { page: string; annotations: DocReviewAnnotationFileV2 }

/** Giới hạn mỗi file output đưa vào snapshot (spec: bỏ file > 5 MB → `skipped[]`). */
export const DOCS_REVIEW_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

const emptyOps = (): DocReviewOperationCounts => ({ add: 0, edited: 0, delete: 0, total: 0 });
const emptyAgent = (): DocReviewAgentCounts => ({ ...emptyOps(), accepted: 0, editedByUser: 0, dismissed: 0 });
const emptyEnrich = (): DocsReviewEnrichMetrics => ({
  diagrams: { total: 0, accepted: 0, dismissed: 0 },
  compositionTables: { total: 0, accepted: 0, dismissed: 0, editedByUser: 0 },
});

function increment(counts: DocReviewOperationCounts, operation: 'add' | 'edited' | 'delete'): void {
  counts[operation] += 1;
  counts.total += 1;
}

/** Resolve the present state from the append-only user ledger when it exists.
 * `annotations[].status` remains the fast current-state projection for old
 * sidecars, but it must not be the only source of truth: an interrupted write
 * can leave the event persisted before the projection is updated. */
function resolvedStatus(file: DocReviewAnnotationFileV2, annotation: DocReviewAnnotationFileV2['annotations'][number]) {
  let fromEvent: 'active' | 'edited' | 'dismissed' | undefined;
  const events = file.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.annotationId === annotation.id && event.actor === 'user')
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index);
  for (const { event } of events) {
    if (event.type === 'dismiss') fromEvent = 'dismissed';
    else if (event.type === 'restore') fromEvent = 'active';
    else if (event.type === 'edit') fromEvent = 'edited';
  }
  return fromEvent ?? annotation.status ?? 'active';
}

// Sơ đồ luồng (kind 'flow-diagram') do daemon TỰ dựng — origin luôn 'system'
// trên đĩa, nhưng đếm KHÔNG lọc theo origin vì chỉ daemon mới tạo kind này
// (xem docs-review-enrich.ts's replaceDiagramInSlice). Bảng "Cấu thành màn
// hình" agent CHÈN MỚI — kind 'component', rule_id trỏ file kết quả nội bộ
// `comp/…`, và `before` rỗng (chèn thuần, không sửa một bảng đã có).
// (dr-comp đã rút khỏi workflow 2026-08-27 — compositionTables chỉ còn trong
// artifact v1 để studio cũ đọc; report v2 bỏ.)
function isEnrichDiagram(annotation: DocReviewAnnotationFileV2['annotations'][number]): boolean {
  return annotation.kind === 'flow-diagram';
}
function isEnrichCompositionTable(annotation: DocReviewAnnotationFileV2['annotations'][number]): boolean {
  return annotation.kind === 'component'
    && (annotation.rule_id ?? '').startsWith('comp/')
    && !(annotation.before ?? '').trim();
}

export function aggregateDocsReviewMetrics(pages: readonly DocsReviewMetricsPage[]): {
  agent: DocReviewAgentCounts;
  userChanges: DocReviewOperationCounts;
  pages: DocReviewFeedbackPageMetrics[];
  enrich: DocsReviewEnrichMetrics;
} {
  const totalAgent = emptyAgent();
  const totalUser = emptyOps();
  const totalEnrich = emptyEnrich();
  const pageMetrics = pages.map(({ page, annotations: file }) => {
    const agent = emptyAgent();
    const user = emptyOps();
    const enrich = emptyEnrich();
    for (const annotation of file.annotations) {
      const status = resolvedStatus(file, annotation);
      if (isEnrichDiagram(annotation)) {
        enrich.diagrams.total += 1;
        if (status === 'dismissed') enrich.diagrams.dismissed += 1;
        else enrich.diagrams.accepted += 1;
      } else if (isEnrichCompositionTable(annotation)) {
        enrich.compositionTables.total += 1;
        if (status === 'dismissed') enrich.compositionTables.dismissed += 1;
        else if (status === 'edited') enrich.compositionTables.editedByUser += 1;
        else enrich.compositionTables.accepted += 1;
      }
      if (annotation.origin === 'user') {
        if (status !== 'dismissed') increment(user, annotation.operation);
        continue;
      }
      increment(agent, annotation.operation);
      if (status === 'dismissed') agent.dismissed += 1;
      else if (status === 'edited') {
        agent.editedByUser += 1;
        increment(user, 'edited');
      } else agent.accepted += 1;
    }
    for (const key of ['add', 'edited', 'delete', 'total'] as const) {
      totalAgent[key] += agent[key];
      totalUser[key] += user[key];
    }
    totalAgent.accepted += agent.accepted;
    totalAgent.editedByUser += agent.editedByUser;
    totalAgent.dismissed += agent.dismissed;
    totalEnrich.diagrams.total += enrich.diagrams.total;
    totalEnrich.diagrams.accepted += enrich.diagrams.accepted;
    totalEnrich.diagrams.dismissed += enrich.diagrams.dismissed;
    totalEnrich.compositionTables.total += enrich.compositionTables.total;
    totalEnrich.compositionTables.accepted += enrich.compositionTables.accepted;
    totalEnrich.compositionTables.dismissed += enrich.compositionTables.dismissed;
    totalEnrich.compositionTables.editedByUser += enrich.compositionTables.editedByUser;
    return { page, agent, user, enrich };
  });
  return { agent: totalAgent, userChanges: totalUser, pages: pageMetrics, enrich: totalEnrich };
}

// dr-review clones the ingested tree into `review/docs/` (Confluence, legacy)
// OR `review/docs-feature/` (App docs pool, 08/2026 — see docs-review.ts's
// cloneDocsForReview, which picks the root name from the ingested pages).
// A workflow run only ever populates ONE of the two, but walk both roots so
// this stays correct regardless of which one a given project used; a root
// that does not exist is simply skipped (fs.readdir's `.catch(() => [])`
// below already makes a missing directory a no-op).
async function listSidecarFiles(root: string, suffix: '.changes.json' | '.notes.json'): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(absolute);
    }
  };
  await walk(path.join(root, 'review', 'docs'));
  await walk(path.join(root, 'review', 'docs-feature'));
  return output.sort();
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Đếm `comments[]` hợp lệ (id + text + at) trên một phần tử sidecar — cùng
 *  luật với `parseAnnotationComments` của contracts, để số ở report khớp số
 *  web hiển thị. */
function countItemComments(item: unknown): number {
  if (!item || typeof item !== 'object') return 0;
  const comments = (item as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return 0;
  return comments.filter((c) => c && typeof c === 'object'
    && typeof (c as { id?: unknown }).id === 'string'
    && typeof (c as { text?: unknown }).text === 'string' && ((c as { text: string }).text).trim()
    && typeof (c as { at?: unknown }).at === 'number').length;
}

export interface DocsReviewNotesMetrics { total: number; dismissed: number; user: number }

/** `*.notes.json` = mảng DocNote (docs-review.ts) mà web bồi thêm
 *  `status: 'dismissed'` / `origin: 'user'` / `comments[]` (DocRedlinePreview).
 *  Đọc khoan dung: file hỏng → 0 (không chặn xác nhận vì một note lỗi). */
export function countNotesFile(raw: string): { notes: DocsReviewNotesMetrics; comments: number } {
  const notes: DocsReviewNotesMetrics = { total: 0, dismissed: 0, user: 0 };
  let comments = 0;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { notes, comments }; }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { notes?: unknown }).notes)
      ? (parsed as { notes: unknown[] }).notes
      : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    notes.total += 1;
    if (v.status === 'dismissed') notes.dismissed += 1;
    if (v.origin === 'user') notes.user += 1;
    comments += countItemComments(item);
  }
  return { notes, comments };
}

function countChangesComments(raw: string): number {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 0; }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { annotations?: unknown }).annotations)
      ? (parsed as { annotations: unknown[] }).annotations
      : [];
  return list.reduce<number>((sum, item) => sum + countItemComments(item), 0);
}

export async function readDocsReviewMetricsPages(workflowRoot: string): Promise<{
  pages: DocsReviewMetricsPage[];
  /** sha256 của mọi sidecar (`.changes.json` + `.notes.json`). */
  digest: string;
  notes: DocsReviewNotesMetrics;
  /** Σ `comments[]` trong CẢ HAI sidecar. */
  annotationComments: number;
}> {
  const hash = createHash('sha256');
  const pages: DocsReviewMetricsPage[] = [];
  let annotationComments = 0;
  for (const absolute of await listSidecarFiles(workflowRoot, '.changes.json')) {
    const raw = await fs.readFile(absolute, 'utf8');
    hash.update(toPosix(path.relative(workflowRoot, absolute))).update('\0').update(raw).update('\0');
    const parsed = parseDocReviewAnnotationFile(raw);
    if (!parsed) throw new Error(`Annotation file không hợp lệ: ${path.relative(workflowRoot, absolute)}`);
    annotationComments += countChangesComments(raw);
    // `page` is relative to `review/` (not `review/docs/`) so it stays
    // addressable regardless of which root (`docs` or `docs-feature`)
    // produced it — e.g. `docs/confluence/x.md` or `docs-feature/A/x.md`.
    // `path.relative` returns OS-native separators; normalize to '/' so a
    // Windows run doesn't emit 'docs\\a\\b.md' (the artifact/page id must
    // stay stable across platforms — same reason `localPath` below is
    // normalized).
    const page = toPosix(path.relative(path.join(workflowRoot, 'review'), absolute))
      .replace(/\.changes\.json$/i, '.md');
    pages.push({ page, annotations: parsed });
  }
  if (pages.length === 0) throw new Error('Chưa có output dr-review để xác nhận');
  const notes: DocsReviewNotesMetrics = { total: 0, dismissed: 0, user: 0 };
  for (const absolute of await listSidecarFiles(workflowRoot, '.notes.json')) {
    const raw = await fs.readFile(absolute, 'utf8');
    hash.update(toPosix(path.relative(workflowRoot, absolute))).update('\0').update(raw).update('\0');
    const counted = countNotesFile(raw);
    notes.total += counted.notes.total;
    notes.dismissed += counted.notes.dismissed;
    notes.user += counted.notes.user;
    annotationComments += counted.comments;
  }
  return { pages, digest: hash.digest('hex'), notes, annotationComments };
}

type ReviewIndexPage = {
  page?: unknown;
  doc_path?: unknown;
  review_path?: unknown;
  status?: unknown;
  sections_total?: unknown;
  sections_failed?: unknown;
};

async function readJsonObject(absolute: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absolute, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readJsonValue(absolute: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(absolute, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** `flows/index.json` = mảng FlowIndexEntry (flow-ux/index.ts) — bản rất cũ
 *  bọc `{ flows: [] }`; nhận cả hai. */
function flowEntriesOf(value: unknown): Record<string, unknown>[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).flows)
      ? (value as Record<string, unknown>).flows as unknown[]
      : null;
  return list ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e)) : null;
}

/** Final workflow invariant: a receipt must never be published from a partial
 * run. Earlier stages intentionally retain successful per-unit artifacts for
 * inspection, so their directories can exist while one flow/screen/section
 * failed. This gate checks the daemon-owned indexes instead of inferring
 * completion from "some output exists". */
export async function assertDocsReviewCoverageComplete(workflowRoot: string): Promise<void> {
  const issues: string[] = [];

  const flows = await readJsonValue(path.join(workflowRoot, 'flows', 'index.json'));
  const flowEntries = flowEntriesOf(flows);
  if (!flowEntries || flowEntries.length === 0) {
    issues.push('dr-flow chưa có flow hợp lệ');
  } else {
    const uncovered = flowEntries
      .flatMap((record) => !Array.isArray(record.screens) || record.screens.length === 0
        ? [typeof record.id === 'string' ? record.id : '?']
        : []);
    if (uncovered.length > 0) issues.push(`dr-flow còn flow chưa có màn: ${uncovered.join(', ')}`);
  }

  // WP dr-mockup (2026-08-27): dr-comp rời workflow docs-review → KHÔNG đòi
  // `comp/index.json` / `comp/_inputs.json` nữa. Coverage màn = flows/index.json
  // có màn (kiểm trên) + nếu bước Mockup màn đã chạy (`mockups/index.json` tồn
  // tại) thì MỌI màn của bản đã chọn (flows/index.json[].screens, bỏ màn
  // `removedByProposal`) phải có `mockups/<key>.html`. Chưa chạy dr-mockup →
  // không chặn (flows + review là đủ để xác nhận).
  const mockupIndex = await readJsonObject(path.join(workflowRoot, 'mockups', 'index.json'));
  if (mockupIndex && flowEntries) {
    const expected = flowEntries.flatMap((entry) => {
      const screens = entry.screens;
      return Array.isArray(screens)
        ? screens.flatMap((screen) => {
          if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return [];
          const rec = screen as Record<string, unknown>;
          return typeof rec.key === 'string' && rec.removedByProposal !== true ? [rec.key] : [];
        })
        : [];
    });
    const missingMockups: string[] = [];
    for (const key of [...new Set(expected)]) {
      const ok = await fs.stat(path.join(workflowRoot, 'mockups', `${key}.html`)).then((st) => st.isFile()).catch(() => false);
      if (!ok) missingMockups.push(key);
    }
    if (missingMockups.length > 0) issues.push(`dr-mockup thiếu mockup cho màn: ${missingMockups.join(', ')}`);
  }

  const review = await readJsonObject(path.join(workflowRoot, 'review', 'index.json'));
  const reviewPages = Array.isArray(review?.pages) ? review.pages as ReviewIndexPage[] : null;
  if (!reviewPages || reviewPages.length === 0) {
    issues.push('dr-review chưa có index trang hoàn tất');
  } else {
    const failedPages = reviewPages.filter((page) => page?.status !== 'succeeded');
    const partialPages = reviewPages.filter((page) =>
      typeof page?.sections_failed === 'number' && page.sections_failed > 0,
    );
    const missingOutputs: string[] = [];
    for (const page of reviewPages) {
      if (typeof page?.review_path !== 'string' || !page.review_path.endsWith('.md')) {
        missingOutputs.push(typeof page?.doc_path === 'string' ? page.doc_path : '?');
        continue;
      }
      const changesRel = page.review_path.replace(/\.md$/i, '.changes.json');
      try {
        await fs.access(path.join(workflowRoot, changesRel));
      } catch {
        missingOutputs.push(page.review_path);
      }
    }
    if (failedPages.length > 0) issues.push(`dr-review còn ${failedPages.length} trang lỗi`);
    if (partialPages.length > 0) issues.push(`dr-review còn ${partialPages.length} trang có section lỗi`);
    if (missingOutputs.length > 0) issues.push(`dr-review thiếu output trang: ${missingOutputs.join(', ')}`);
  }

  if (issues.length > 0) {
    throw new Error(`Chưa thể xác nhận Review tài liệu vì coverage chưa đầy đủ: ${issues.join('; ')}.`);
  }
}

function cleanSegment(value: string): string {
  const clean = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean || clean === '.' || clean === '..') throw new Error('Identifier không hợp lệ');
  return clean;
}

// ─── v2: output walk + metrics từng bước ────────────────────────────────────

interface WalkedFile { rel: string; absolute: string; size: number }

/** Có nên bỏ qua một segment đường dẫn trong snapshot: `_*` (file tạm/nội bộ
 *  của daemon: `_inputs.json`, `_seeds/`, `_assets/`, `_screen-recovery.json`,
 *  `review/_*.json`…) và `.*` (`.tmp`, `.odhistory`). `_manifest.json` (pool
 *  App docs) là ngoại lệ được spec nêu đích danh cho dr-docs. */
function isInternalSegment(segment: string): boolean {
  return segment.startsWith('.') || (segment.startsWith('_') && segment !== '_manifest.json');
}

/** Thư mục ở gốc workflowRoot KHÔNG phải output của stage nào (daemon-owned):
 *  comment cấp bước + biên nhận xác nhận. */
const NON_OUTPUT_ROOT_DIRS: ReadonlySet<string> = new Set([DOCS_REVIEW_COMMENTS_DIR, 'confirmation']);

async function walkWorkflowFiles(workflowRoot: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const walk = async (dir: string, relDir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (isInternalSegment(entry.name)) continue;
      if (!relDir && NON_OUTPUT_ROOT_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, rel);
      else if (entry.isFile()) {
        const st = await fs.stat(absolute).catch(() => null);
        if (st) out.push({ rel, absolute, size: st.size });
      }
    }
  };
  await walk(workflowRoot, '');
  // So sánh byte (không localeCompare): thứ tự output phải ổn định giữa máy/locale.
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Điểm khớp của một pattern `def.outputs` (pipelines.ts) với một path —
 *  cùng ngữ nghĩa `outputMatches` bên đó, nhưng trả ĐIỂM thay vì boolean để
 *  chọn stage KHỚP SÁT NHẤT: `flows/SCREEN-FLOW/patch.json` khớp cả
 *  `flows/` (dr-flow) lẫn path đúng tên (dr-flow-improve) — file phải về
 *  dr-flow-improve, không phải stage đứng trước. */
function matchScore(rel: string, pattern: string): number {
  if (pattern.endsWith('/')) {
    return rel === pattern.slice(0, -1) || rel.startsWith(pattern) ? 1 + pattern.length / 1000 : 0;
  }
  if (pattern.startsWith('*') || pattern.startsWith('-')) {
    return rel.endsWith(pattern.slice(1)) || rel.endsWith(pattern) ? 2 : 0;
  }
  return rel === pattern ? 3 : rel.endsWith('/' + pattern) ? 2.5 : 0;
}

function stageIdForOutput(rel: string, stages: ReadonlyArray<{ id: DocsReviewStageId; outputs: readonly string[] }>): DocsReviewStageId | null {
  let best: { id: DocsReviewStageId; score: number } | null = null;
  for (const stage of stages) {
    for (const pattern of stage.outputs) {
      const score = matchScore(rel, pattern);
      if (score > 0 && (!best || score > best.score)) best = { id: stage.id, score };
    }
  }
  return best?.id ?? null;
}

/** dr-docs: chỉ `.md` + `_manifest.json` (spec) — attachments (ảnh, drawio
 *  gốc…) không vào snapshot. */
function isDocsOutput(rel: string): boolean {
  return /\.md$/i.test(rel) || rel.endsWith('/_manifest.json');
}

function mimeForPath(rel: string): string {
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'json': return 'application/json';
    case 'md': return 'text/markdown';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'js': return 'text/javascript';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'drawio': case 'xml': return 'application/xml';
    case 'mmd': case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

async function listFlowDirs(workflowRoot: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(workflowRoot, 'flows'), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !isInternalSegment(e.name)).map((e) => e.name).sort();
}

async function fileExists(absolute: string): Promise<boolean> {
  return fs.stat(absolute).then((st) => st.isFile()).catch(() => false);
}

async function drFlowMetrics(workflowRoot: string, fallbackPlatform: ScreenPlatformScope | null): Promise<Extract<DocsReviewStageMetrics, { kind: 'dr-flow' }>> {
  const entries = flowEntriesOf(await readJsonValue(path.join(workflowRoot, 'flows', 'index.json'))) ?? [];
  const screens = entries.reduce<number>((sum, entry) => {
    const list = Array.isArray(entry.screens) ? entry.screens : [];
    return sum + list.filter((s) => !(s && typeof s === 'object' && (s as { removedByProposal?: unknown }).removedByProposal === true)).length;
  }, 0);
  const inputs = await readJsonObject(path.join(workflowRoot, 'flows', '_inputs.json'));
  const platform = isScreenPlatformScope(inputs?.screenPlatform) ? inputs.screenPlatform : fallbackPlatform;
  let drawioEdited = false;
  for (const id of await listFlowDirs(workflowRoot)) {
    if (await fileExists(path.join(workflowRoot, 'flows', id, 'as-is.edited.json'))) { drawioEdited = true; break; }
  }
  const overrides = { add: 0, rename: 0, remove: 0 };
  const overridesDoc = await readJsonObject(path.join(workflowRoot, 'screens-overrides.json'));
  for (const item of Array.isArray(overridesDoc?.overrides) ? overridesDoc.overrides : []) {
    const action = item && typeof item === 'object' ? (item as { action?: unknown }).action : undefined;
    if (action === 'add' || action === 'rename' || action === 'remove') overrides[action] += 1;
  }
  return { kind: 'dr-flow', flows: entries.length, screens, platform, drawioEdited, overrides };
}

const IMPROVE_FILES = ['selection.json', 'patch.json', 'ux-review.json', 'screens.improved.json', 'proposed.edited.json', 'proposed.drawio'] as const;

async function drFlowImproveMetrics(workflowRoot: string): Promise<Extract<DocsReviewStageMetrics, { kind: 'dr-flow-improve' }>> {
  const flows: Extract<DocsReviewStageMetrics, { kind: 'dr-flow-improve' }>['flows'] = [];
  for (const flowId of await listFlowDirs(workflowRoot)) {
    const dir = path.join(workflowRoot, 'flows', flowId);
    let any = false;
    for (const f of IMPROVE_FILES) if (await fileExists(path.join(dir, f))) { any = true; break; }
    if (!any) continue;
    const selection = await readJsonObject(path.join(dir, 'selection.json'));
    const variant = selection?.variant === 'improved' ? 'improved' : 'original';
    const source: 'user' | 'run-all' | 'default' = !selection || (selection.variant !== 'improved' && selection.variant !== 'original')
      ? 'default'
      : selection.source === 'run-all' ? 'run-all' : 'user';
    const patch = await readJsonValue(path.join(dir, 'patch.json'));
    const patchOps = Array.isArray(patch)
      ? patch.length
      : patch && typeof patch === 'object' && Array.isArray((patch as { ops?: unknown }).ops) ? (patch as { ops: unknown[] }).ops.length : 0;
    const review = await readJsonObject(path.join(dir, 'ux-review.json'));
    const findings = Array.isArray(review?.findings) ? review.findings.length : 0;
    const improved = await readJsonObject(path.join(dir, 'screens.improved.json'));
    const improvedScreens = (Array.isArray(improved?.screens) ? improved.screens : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s));
    flows.push({
      flowId,
      variant,
      source,
      patchOps,
      findings,
      proposedScreens: improvedScreens.filter((s) => s.provenance === 'proposed').length,
      removedScreens: improvedScreens.filter((s) => s.removedByProposal === true).length,
      proposedEdited: await fileExists(path.join(dir, 'proposed.edited.json')),
    });
  }
  return { kind: 'dr-flow-improve', flows };
}

async function drMockupMetrics(workflowRoot: string): Promise<Extract<DocsReviewStageMetrics, { kind: 'dr-mockup' }>> {
  const index = await readJsonObject(path.join(workflowRoot, 'mockups', 'index.json'));
  return {
    kind: 'dr-mockup',
    screens: Array.isArray(index?.screens) ? index.screens.length : 0,
    variant: typeof index?.variant === 'string' && index.variant ? index.variant : null,
  };
}

async function drDocsMetrics(outputs: readonly DocsReviewOutputRef[]): Promise<Extract<DocsReviewStageMetrics, { kind: 'dr-docs' }>> {
  return { kind: 'dr-docs', pages: outputs.filter((o) => /\.md$/i.test(o.path)).length };
}

export interface DocsReviewReportInput {
  projectId: string;
  workflowRoot: string;
  installationId: string;
  user: string;
  channel: 'dev' | 'packaged';
  confirmationId: string;
  confirmedAt: number;
  feature: { id: string; name: string };
  app?: { id: string; name: string } | null;
  screenPlatform?: ScreenPlatformScope | null;
  /** `lastRunId` từng stage (project pipeline state). */
  runIds?: Readonly<Record<string, string | undefined>>;
  sourceRunId?: string;
  maxOutputBytes?: number;
}

export interface DocsReviewReportFile { path: string; absolute: string; size: number; mediaPath: string; stageId: DocsReviewStageId }

export interface DocsReviewReport {
  artifact: DocsReviewFeedbackArtifactV2;
  /** Bản v1 y như cũ — studio chưa nâng vẫn đọc (TODO: bỏ khi K ship). */
  v1: DocsReviewFeedbackArtifact;
  /** File output cần upload kèm (đã lọc size); chưa upload gì. */
  files: DocsReviewReportFile[];
  /** Tiền tố media của lần xác nhận này: `docs-review-feedback/<install>/<confirmId>`. */
  mediaDir: string;
}

function emptyMetricsFor(stageId: DocsReviewStageId): DocsReviewStageMetrics {
  switch (stageId) {
    case 'dr-docs': return { kind: 'dr-docs', pages: 0 };
    case 'dr-flow': return { kind: 'dr-flow', flows: 0, screens: 0, platform: null, drawioEdited: false, overrides: { add: 0, rename: 0, remove: 0 } };
    case 'dr-flow-improve': return { kind: 'dr-flow-improve', flows: [] };
    case 'dr-mockup': return { kind: 'dr-mockup', screens: 0, variant: null };
    case 'dr-review': return { kind: 'dr-review', agent: emptyAgent(), userChanges: emptyOps(), notes: { total: 0, dismissed: 0, user: 0 }, annotationComments: 0, pages: [], enrich: { diagrams: { total: 0, accepted: 0, dismissed: 0 } } };
  }
}

/** Dựng report v2 THUẦN từ đĩa (không upload, không ghi gì) — tách riêng để
 *  route tổng hợp (docs-review-reports.ts) và test dùng lại. Gọi SAU gate
 *  coverage; `confirmationId` do caller quyết (digest hoặc id người dùng đưa). */
export async function buildDocsReviewReport(input: DocsReviewReportInput): Promise<DocsReviewReport> {
  const workflow = getWorkflow('docs-review');
  if (!workflow) throw new Error('Workflow docs-review không tồn tại trong registry');
  const stageDefs = workflow.pipelineIds.map((id) => {
    const def = getPipelineDef(id);
    return { id: id as DocsReviewStageId, name: def?.name ?? id, outputs: def?.outputs ?? [] };
  });
  const installationId = cleanSegment(input.installationId);
  const confirmationId = cleanSegment(input.confirmationId);
  const mediaDir = `docs-review-feedback/${installationId}/${confirmationId}`;
  const maxBytes = input.maxOutputBytes ?? DOCS_REVIEW_OUTPUT_MAX_BYTES;

  const outputsByStage = new Map<DocsReviewStageId, DocsReviewOutputRef[]>();
  const skippedByStage = new Map<DocsReviewStageId, Array<{ path: string; reason: string }>>();
  const files: DocsReviewReportFile[] = [];
  for (const file of await walkWorkflowFiles(input.workflowRoot)) {
    const stageId = stageIdForOutput(file.rel, stageDefs);
    if (!stageId) continue;
    if (stageId === 'dr-docs' && !isDocsOutput(file.rel)) continue;
    if (file.size > maxBytes) {
      const list = skippedByStage.get(stageId) ?? [];
      list.push({ path: file.rel, reason: `quá ${Math.round(maxBytes / 1024 / 1024)} MB (${file.size} bytes)` });
      skippedByStage.set(stageId, list);
      continue;
    }
    const ref: DocsReviewOutputRef = { path: file.rel, size: file.size, mediaPath: `${mediaDir}/outputs/${file.rel}` };
    const list = outputsByStage.get(stageId) ?? [];
    list.push(ref);
    outputsByStage.set(stageId, list);
    files.push({ ...ref, absolute: file.absolute, stageId });
  }

  const reviewPages = await readDocsReviewMetricsPages(input.workflowRoot);
  const aggregate = aggregateDocsReviewMetrics(reviewPages.pages);
  const screenPlatform = input.screenPlatform ?? null;

  const stages: DocsReviewStageReport[] = [];
  let stageComments = 0;
  for (const stage of stageDefs) {
    const outputs = outputsByStage.get(stage.id) ?? [];
    const comments: DocsReviewStageComment[] = await readDocsReviewStageComments(input.workflowRoot, stage.id);
    stageComments += comments.length;
    let metrics: DocsReviewStageMetrics;
    switch (stage.id) {
      case 'dr-docs': metrics = await drDocsMetrics(outputs); break;
      case 'dr-flow': metrics = await drFlowMetrics(input.workflowRoot, screenPlatform); break;
      case 'dr-flow-improve': metrics = await drFlowImproveMetrics(input.workflowRoot); break;
      case 'dr-mockup': metrics = await drMockupMetrics(input.workflowRoot); break;
      case 'dr-review':
        metrics = {
          kind: 'dr-review',
          agent: aggregate.agent,
          userChanges: aggregate.userChanges,
          notes: reviewPages.notes,
          annotationComments: reviewPages.annotationComments,
          pages: aggregate.pages.map(({ page, agent, user, enrich }) => ({
            page, agent, user, ...(enrich ? { enrich: { diagrams: enrich.diagrams, compositionTables: enrich.compositionTables } } : {}),
          })),
          enrich: { diagrams: aggregate.enrich.diagrams },
        };
        break;
      default: metrics = emptyMetricsFor(stage.id);
    }
    const skipped = skippedByStage.get(stage.id);
    const runId = input.runIds?.[stage.id];
    stages.push({
      stageId: stage.id,
      name: stage.name,
      ...(runId ? { runId } : {}),
      status: 'succeeded',
      outputs,
      ...(skipped && skipped.length ? { skipped } : {}),
      comments,
      metrics,
    });
  }

  // summary — định nghĩa trong spec (wp-docs-review-confirm-v2 § Contracts).
  const flowMetrics = stages.find((s) => s.metrics.kind === 'dr-flow')?.metrics as Extract<DocsReviewStageMetrics, { kind: 'dr-flow' }> | undefined;
  const improveFlows = (stages.find((s) => s.metrics.kind === 'dr-flow-improve')?.metrics as Extract<DocsReviewStageMetrics, { kind: 'dr-flow-improve' }> | undefined)?.flows ?? [];
  const sumPatchOps = improveFlows.reduce((n, f) => n + f.patchOps, 0);
  const sumProposedScreens = improveFlows.reduce((n, f) => n + f.proposedScreens, 0);
  const sumProposedEdited = improveFlows.filter((f) => f.proposedEdited).length;
  const overridesTotal = flowMetrics ? flowMetrics.overrides.add + flowMetrics.overrides.rename + flowMetrics.overrides.remove : 0;
  const proposals = aggregate.agent.total + sumPatchOps + sumProposedScreens;
  const edited = aggregate.agent.editedByUser + sumProposedEdited;
  const dismissed = aggregate.agent.dismissed
    + improveFlows.filter((f) => f.variant === 'original' && f.source === 'user').reduce((n, f) => n + f.patchOps, 0)
    + (flowMetrics?.overrides.remove ?? 0);
  const aiOutcome: DocsReviewAiOutcome = { proposals, accepted: Math.max(0, proposals - edited - dismissed), edited, dismissed };
  const summary = {
    agentProposals: proposals,
    humanEdits: aggregate.userChanges.total + aggregate.agent.editedByUser + reviewPages.notes.user
      + (flowMetrics?.drawioEdited ? 1 : 0) + overridesTotal + sumProposedEdited,
    comments: stageComments + reviewPages.annotationComments,
    aiOutcome,
  };

  const artifact: DocsReviewFeedbackArtifactV2 = {
    schemaVersion: 2,
    confirmationId,
    projectId: input.projectId,
    workflowId: 'docs-review',
    installationId,
    user: input.user,
    channel: input.channel,
    confirmedAt: input.confirmedAt,
    app: input.app ?? null,
    feature: input.feature,
    screenPlatform,
    stages,
    summary,
    agent: aggregate.agent,
    userChanges: aggregate.userChanges,
    pages: aggregate.pages,
  };
  const v1: DocsReviewFeedbackArtifact = {
    schemaVersion: 1,
    confirmationId,
    projectId: input.projectId,
    workflowId: 'docs-review',
    installationId,
    user: input.user,
    channel: input.channel,
    confirmedAt: input.confirmedAt,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    agent: aggregate.agent,
    userChanges: aggregate.userChanges,
    pages: aggregate.pages,
    enrich: aggregate.enrich,
  };
  return { artifact, v1, files, mediaDir };
}

/** `confirmationId` mặc định = digest của MỌI thứ người dùng có thể đổi sau
 *  khi các stage xanh: sidecar dr-review, comment cấp bước, selection.json
 *  từng flow, screens-overrides.json và các index.json — sửa một comment rồi
 *  xác nhận lại = confirmation MỚI (studio lấy mới nhất theo confirmedAt). */
export async function computeDocsReviewConfirmationDigest(workflowRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const rels: string[] = [];
  for (const abs of await listSidecarFiles(workflowRoot, '.changes.json')) rels.push(toPosix(path.relative(workflowRoot, abs)));
  for (const abs of await listSidecarFiles(workflowRoot, '.notes.json')) rels.push(toPosix(path.relative(workflowRoot, abs)));
  const commentsDir = path.join(workflowRoot, DOCS_REVIEW_COMMENTS_DIR);
  for (const entry of await fs.readdir(commentsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.json')) rels.push(`${DOCS_REVIEW_COMMENTS_DIR}/${entry.name}`);
  }
  for (const id of await listFlowDirs(workflowRoot)) rels.push(`flows/${id}/selection.json`);
  rels.push('screens-overrides.json', 'flows/index.json', 'mockups/index.json', 'review/index.json');
  for (const rel of [...new Set(rels)].sort()) {
    const raw = await fs.readFile(path.join(workflowRoot, rel), 'utf8').catch(() => null);
    if (raw == null) continue;
    hash.update(rel).update('\0').update(raw).update('\0');
  }
  return hash.digest('hex');
}

/** App / feature / nền tảng / runId từng bước — từ project row + pipeline
 *  state (server.ts's dr-confirm branch). Tách ra để test được không cần DB. */
export function docsReviewConfirmContextOf(
  project: { id: string; name: string; metadata?: Record<string, unknown> | null } | null | undefined,
  pipelineState: Readonly<Record<string, { lastRunId?: string } | undefined>> | null | undefined,
): Pick<DocsReviewReportInput, 'feature' | 'app' | 'screenPlatform' | 'runIds'> {
  const sc = project?.metadata?.studioConfig;
  const scRec = sc && typeof sc === 'object' && !Array.isArray(sc) ? sc as Record<string, unknown> : {};
  const appId = typeof scRec.appId === 'string' ? scRec.appId.trim() : '';
  const appName = typeof scRec.appName === 'string' ? scRec.appName.trim() : '';
  const runIds: Record<string, string> = {};
  for (const id of getWorkflow('docs-review')?.pipelineIds ?? []) {
    const runId = pipelineState?.[id]?.lastRunId;
    if (typeof runId === 'string' && runId) runIds[id] = runId;
  }
  return {
    feature: { id: project?.id ?? '', name: project?.name ?? project?.id ?? '' },
    app: appId ? { id: appId, name: appName || appId } : null,
    screenPlatform: screenPlatformScopeFor(project) ?? null,
    runIds,
  };
}

async function runParallel<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  });
  await Promise.all(workers);
}

export async function confirmDocsReview(input: {
  projectId: string;
  workflowRoot: string;
  installationId: string;
  user: string;
  channel: 'dev' | 'packaged';
  confirmationId?: string;
  sourceRunId?: string;
  now?: number;
  client?: UploadClient;
  feature?: { id: string; name: string };
  app?: { id: string; name: string } | null;
  screenPlatform?: ScreenPlatformScope | null;
  runIds?: Readonly<Record<string, string | undefined>>;
  maxOutputBytes?: number;
}): Promise<ConfirmDocsReviewResponse> {
  await assertDocsReviewCoverageComplete(input.workflowRoot);
  const digest = await computeDocsReviewConfirmationDigest(input.workflowRoot);
  const confirmationId = cleanSegment(input.confirmationId || digest.slice(0, 24));
  const report = await buildDocsReviewReport({
    projectId: input.projectId,
    workflowRoot: input.workflowRoot,
    installationId: input.installationId,
    user: input.user,
    channel: input.channel,
    confirmationId,
    confirmedAt: input.now ?? Date.now(),
    feature: input.feature ?? { id: input.projectId, name: input.projectId },
    app: input.app ?? null,
    screenPlatform: input.screenPlatform ?? null,
    ...(input.runIds ? { runIds: input.runIds } : {}),
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    ...(input.maxOutputBytes != null ? { maxOutputBytes: input.maxOutputBytes } : {}),
  });
  const { artifact, v1, files, mediaDir } = report;
  const installationId = artifact.installationId;
  const reportContent = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const v1Content = Buffer.from(`${JSON.stringify(v1, null, 2)}\n`, 'utf8');
  const reportMediaPath = `${mediaDir}/report.json`;
  // TODO(K ship): bỏ file v1 `docs-review-feedback/<install>/<confirmId>.json`
  // khi studio đọc report.json v2.
  const v1MediaPath = `docs-review-feedback/${installationId}/${confirmationId}.json`;
  const v1Stage = `docs-review-feedback/${installationId}`;

  const client = input.client ?? new MediaClient(mediaConfigFromEnv());
  const session = typeof client.openFolderSession === 'function'
    ? await client.openFolderSession(input.projectId, { create: true })
    : null;
  const upload = (filePath: string, stage: string, mime: string, content: Buffer) =>
    session ? session.upload(filePath, stage, mime, content) : client.uploadFile(input.projectId, stage, filePath, mime, content);

  // Output trước (song song 4), report + v1 sau: report chỉ có mặt khi mọi
  // output nó tham chiếu đã lên. Upload lỗi → không receipt (retry giữ path).
  await runParallel(files, UPLOAD_CONCURRENCY, async (file) => {
    await upload(file.mediaPath, mediaDir, mimeForPath(file.path), await fs.readFile(file.absolute));
  });
  await upload(reportMediaPath, mediaDir, 'application/json', reportContent);
  await upload(v1MediaPath, v1Stage, 'application/json', v1Content);

  const localDir = path.join(input.workflowRoot, 'confirmation');
  await fs.mkdir(localDir, { recursive: true });
  const localAbsolute = path.join(localDir, `${confirmationId}.json`);
  await fs.writeFile(localAbsolute, reportContent);
  return {
    ok: true,
    artifact,
    mediaPath: reportMediaPath,
    localPath: toPosix(path.relative(input.workflowRoot, localAbsolute)),
  };
}
