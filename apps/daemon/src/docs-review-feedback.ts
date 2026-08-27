import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfirmDocsReviewResponse,
  DocReviewAgentCounts,
  DocReviewAnnotationFileV2,
  DocReviewFeedbackPageMetrics,
  DocReviewOperationCounts,
  DocsReviewEnrichMetrics,
  DocsReviewFeedbackArtifact,
} from '@open-design/contracts';
import { parseDocReviewAnnotationFile } from '@open-design/contracts';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';

type UploadClient = Pick<MediaClient, 'uploadFile'>;
export interface DocsReviewMetricsPage { page: string; annotations: DocReviewAnnotationFileV2 }

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
async function listChangeFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.changes.json')) output.push(absolute);
    }
  };
  await walk(path.join(root, 'review', 'docs'));
  await walk(path.join(root, 'review', 'docs-feature'));
  return output.sort();
}

export async function readDocsReviewMetricsPages(workflowRoot: string): Promise<{
  pages: DocsReviewMetricsPage[];
  digest: string;
}> {
  const hash = createHash('sha256');
  const pages: DocsReviewMetricsPage[] = [];
  for (const absolute of await listChangeFiles(workflowRoot)) {
    const raw = await fs.readFile(absolute, 'utf8');
    hash.update(path.relative(workflowRoot, absolute)).update('\0').update(raw).update('\0');
    const parsed = parseDocReviewAnnotationFile(raw);
    if (!parsed) throw new Error(`Annotation file không hợp lệ: ${path.relative(workflowRoot, absolute)}`);
    // `page` is relative to `review/` (not `review/docs/`) so it stays
    // addressable regardless of which root (`docs` or `docs-feature`)
    // produced it — e.g. `docs/confluence/x.md` or `docs-feature/A/x.md`.
    // `path.relative` returns OS-native separators; normalize to '/' so a
    // Windows run doesn't emit 'docs\\a\\b.md' (the artifact/page id must
    // stay stable across platforms — same reason `localPath` below is
    // normalized).
    const page = path.relative(path.join(workflowRoot, 'review'), absolute)
      .split(path.sep).join('/')
      .replace(/\.changes\.json$/i, '.md');
    pages.push({ page, annotations: parsed });
  }
  if (pages.length === 0) throw new Error('Chưa có output dr-review để xác nhận');
  return { pages, digest: hash.digest('hex') };
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

/** Final workflow invariant: a receipt must never be published from a partial
 * run. Earlier stages intentionally retain successful per-unit artifacts for
 * inspection, so their directories can exist while one flow/screen/section
 * failed. This gate checks the daemon-owned indexes instead of inferring
 * completion from "some output exists". */
export async function assertDocsReviewCoverageComplete(workflowRoot: string): Promise<void> {
  const issues: string[] = [];

  const flows = await readJsonValue(path.join(workflowRoot, 'flows', 'index.json'));
  const flowEntries = Array.isArray(flows)
    ? flows
    : flows && typeof flows === 'object' && !Array.isArray(flows) && Array.isArray((flows as Record<string, unknown>).flows)
      ? (flows as Record<string, unknown>).flows as unknown[]
      : null;
  if (!flowEntries || flowEntries.length === 0) {
    issues.push('dr-flow chưa có flow hợp lệ');
  } else {
    const uncovered = flowEntries
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['?'];
        const record = entry as Record<string, unknown>;
        return !Array.isArray(record.screens) || record.screens.length === 0
          ? [typeof record.id === 'string' ? record.id : '?']
          : [];
      });
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
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const screens = (entry as Record<string, unknown>).screens;
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
}): Promise<ConfirmDocsReviewResponse> {
  await assertDocsReviewCoverageComplete(input.workflowRoot);
  const { pages, digest } = await readDocsReviewMetricsPages(input.workflowRoot);
  const metrics = aggregateDocsReviewMetrics(pages);
  const confirmationId = cleanSegment(input.confirmationId || digest.slice(0, 24));
  const installationId = cleanSegment(input.installationId);
  const artifact: DocsReviewFeedbackArtifact = {
    schemaVersion: 1,
    confirmationId,
    projectId: input.projectId,
    workflowId: 'docs-review',
    installationId,
    user: input.user,
    channel: input.channel,
    confirmedAt: input.now ?? Date.now(),
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    ...metrics,
  };
  const content = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const mediaPath = `docs-review-feedback/${installationId}/${confirmationId}.json`;
  const client = input.client ?? new MediaClient(mediaConfigFromEnv());
  await client.uploadFile(input.projectId, `docs-review-feedback/${installationId}`, mediaPath, 'application/json', content);
  const localDir = path.join(input.workflowRoot, 'confirmation');
  await fs.mkdir(localDir, { recursive: true });
  const localAbsolute = path.join(localDir, `${confirmationId}.json`);
  await fs.writeFile(localAbsolute, content);
  return { ok: true, artifact, mediaPath, localPath: path.relative(input.workflowRoot, localAbsolute).split(path.sep).join('/') };
}
