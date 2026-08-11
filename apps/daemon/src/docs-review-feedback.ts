import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfirmDocsReviewResponse,
  DocReviewAgentCounts,
  DocReviewAnnotationFileV2,
  DocReviewFeedbackPageMetrics,
  DocReviewOperationCounts,
  DocsReviewFeedbackArtifact,
} from '@open-design/contracts';
import { parseDocReviewAnnotationFile } from '@open-design/contracts';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';

type UploadClient = Pick<MediaClient, 'uploadFile'>;
export interface DocsReviewMetricsPage { page: string; annotations: DocReviewAnnotationFileV2 }

const emptyOps = (): DocReviewOperationCounts => ({ add: 0, edited: 0, delete: 0, total: 0 });
const emptyAgent = (): DocReviewAgentCounts => ({ ...emptyOps(), accepted: 0, editedByUser: 0, dismissed: 0 });

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

export function aggregateDocsReviewMetrics(pages: readonly DocsReviewMetricsPage[]): {
  agent: DocReviewAgentCounts;
  userChanges: DocReviewOperationCounts;
  pages: DocReviewFeedbackPageMetrics[];
} {
  const totalAgent = emptyAgent();
  const totalUser = emptyOps();
  const pageMetrics = pages.map(({ page, annotations: file }) => {
    const agent = emptyAgent();
    const user = emptyOps();
    for (const annotation of file.annotations) {
      const status = resolvedStatus(file, annotation);
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
    return { page, agent, user };
  });
  return { agent: totalAgent, userChanges: totalUser, pages: pageMetrics };
}

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
    pages.push({ page: path.relative(path.join(workflowRoot, 'review', 'docs'), absolute).replace(/\.changes\.json$/i, '.md'), annotations: parsed });
  }
  if (pages.length === 0) throw new Error('Chưa có output dr-review để xác nhận');
  return { pages, digest: hash.digest('hex') };
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
