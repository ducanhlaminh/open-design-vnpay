// Unsupported screen-format observations → Pipeline Studio.
//
// Screen recovery needs the original document bytes, not a lossy outline, so
// each observation is first frozen as a self-contained local bundle and then
// uploaded through MediaClient. The outbox is deliberately separate from
// pipeline error reports: observations may be informational and have their
// own retention/opt-out policy. Upload is always fail-soft.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';

export const SCREEN_FORMAT_REPORTS_FOLDER = '__od-screen-format-reports';
export const SCREEN_FORMAT_REPORTS_OUTBOX_DIR = 'screen-format-reports/outbox';
export const SCREEN_FORMAT_REPORT_MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const SCREEN_FORMAT_REPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SCREEN_FORMAT_REPORT_MAX_ATTACHMENTS = 50;

const FLUSH_DELAY_MS = 30_000;

export type ScreenFormatFileStatus = 'included' | 'omitted';
export type ScreenFormatOmittedReason =
  | 'missing'
  | 'outside-project'
  | 'remote-reference'
  | 'file-size-cap'
  | 'bundle-size-cap'
  | 'attachment-count-cap'
  | 'invalid-source';

export interface ScreenFormatManifestFile {
  source: string;
  remotePath?: string;
  mime?: string;
  size?: number;
  checksum?: string;
  status: ScreenFormatFileStatus;
  omittedReason?: ScreenFormatOmittedReason;
  referencedBy?: string[];
}

export interface ScreenFormatObservationManifest {
  schemaVersion: 1;
  observationId: string;
  createdAt: number;
  severity: 'info' | 'error';
  containsFullDocument: boolean;
  fingerprint: string;
  project: { id: string; name?: string; workflowId: string; stageId: string };
  app: { version: string; channel: string; packaged: boolean };
  installationId: string;
  scannerTrace: unknown;
  recovery: { accepted: unknown[]; rejected: unknown[] };
  limits: { bundleBytes: number; fileBytes: number; attachments: number };
  totals: { includedBytes: number; documents: number; attachments: number; omittedAttachments: number };
  documents: ScreenFormatManifestFile[];
  attachments: ScreenFormatManifestFile[];
}

export interface ScreenFormatObservationInput {
  projectId: string;
  projectName?: string;
  workflowId: string;
  stageId: string;
  severity: 'info' | 'error';
  app: { version: string; channel: string; packaged: boolean };
  installationId: string;
  scannerTrace: unknown;
  recovery: { accepted: unknown[]; rejected: unknown[] };
  /** Absolute workflow/project root that contains every source path. */
  projectRoot: string;
  /** Project-root-relative Markdown paths. */
  sources: string[];
}

export interface ScreenFormatReporterOptions {
  dataDir: string;
  client?: Pick<MediaClient, 'uploadFile'>;
  now?: () => number;
  id?: () => string;
  log?: (message: string) => void;
  limits?: Partial<{ bundleBytes: number; fileBytes: number; attachments: number }>;
}

export interface ScreenFormatReporter {
  /** Allocate an id synchronously; bundle/upload continues in the background. */
  report(input: ScreenFormatObservationInput): string;
  /** Retry observations left by this or an earlier daemon process. */
  flushOutbox(): Promise<{ sent: number; left: number }>;
  /** Wait for current background work (primarily for tests/shutdown). */
  idle(): Promise<void>;
}

interface FingerprintInput {
  scannerTrace: unknown;
  documents: Array<{ source: string; checksum: string }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeScreenFormatFingerprint(input: FingerprintInput): string {
  const normalized = {
    scannerTrace: input.scannerTrace,
    documents: [...input.documents].sort((a, b) => a.source.localeCompare(b.source)),
  };
  return createHash('sha1').update(canonicalJson(normalized)).digest('hex').slice(0, 12);
}

function checksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function cleanInstallationId(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]/g, '') || 'unknown-install';
}

function posix(value: string): string {
  return value.split(path.sep).join('/');
}

function safeRelative(root: string, absolute: string): string | null {
  const rel = path.relative(root, absolute);
  if (!rel || rel === '.') return null;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return posix(rel);
}

function mimeOf(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.md': return 'text/markdown';
    case '.mmd': return 'text/plain';
    case '.drawio': return 'application/xml';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function markdownReferences(markdown: string): string[] {
  const refs: string[] = [];
  // Markdown inline image/link. Titles after the URL are intentionally not
  // captured. Reference-style definitions cover Confluence exports too.
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) {
    const value = match[1] ?? match[2];
    if (value) refs.push(value);
  }
  for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm)) {
    const value = match[1] ?? match[2];
    if (value) refs.push(value);
  }
  for (const match of markdown.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1];
    if (value) refs.push(value);
  }
  return refs;
}

function referencePath(raw: string): { path: string | null; reason?: ScreenFormatOmittedReason } {
  const trimmed = raw.trim();
  if (/^(?:https?:|data:|mailto:|#|\/\/)/i.test(trimmed)) return { path: null, reason: 'remote-reference' };
  if (/^[a-z]:[\\/]/i.test(trimmed)) return { path: null, reason: 'outside-project' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  const withoutSuffix = decoded.split('#', 1)[0]!.split('?', 1)[0]!;
  return withoutSuffix ? { path: withoutSuffix } : { path: null, reason: 'remote-reference' };
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

const enabled = (): boolean => process.env.OD_SCREEN_FORMAT_REPORTS !== '0';

export function createScreenFormatReporter(options: ScreenFormatReporterOptions): ScreenFormatReporter {
  const outboxDir = path.join(options.dataDir, SCREEN_FORMAT_REPORTS_OUTBOX_DIR);
  const now = options.now ?? Date.now;
  const makeId = options.id ?? (() => randomBytes(6).toString('hex'));
  const log = options.log ?? ((message: string) => console.warn(message));
  const limits = {
    bundleBytes: options.limits?.bundleBytes ?? SCREEN_FORMAT_REPORT_MAX_BUNDLE_BYTES,
    fileBytes: options.limits?.fileBytes ?? SCREEN_FORMAT_REPORT_MAX_FILE_BYTES,
    attachments: options.limits?.attachments ?? SCREEN_FORMAT_REPORT_MAX_ATTACHMENTS,
  };
  let client: Pick<MediaClient, 'uploadFile'> | null = options.client ?? null;
  const clientOf = () => (client ??= new MediaClient(mediaConfigFromEnv()));
  const inflight = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>): void => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  };

  async function buildBundle(input: ScreenFormatObservationInput, observationId: string): Promise<void> {
    const createdAt = now();
    const bundleName = `${createdAt}-${observationId}`;
    const bundleDir = path.join(outboxDir, bundleName);
    const buildingDir = path.join(outboxDir, `.tmp-${bundleName}`);
    await fs.promises.rm(buildingDir, { recursive: true, force: true });
    await fs.promises.mkdir(buildingDir, { recursive: true });
    const root = path.resolve(input.projectRoot);
    const realRoot = await fs.promises.realpath(root).catch(() => root);
    const documents: ScreenFormatManifestFile[] = [];
    const documentContents = new Map<string, Buffer>();
    let includedBytes = 0;

    for (const sourceValue of [...new Set(input.sources)]) {
      const absolute = path.resolve(root, sourceValue);
      const source = safeRelative(root, absolute);
      if (!source || !source.toLowerCase().endsWith('.md')) {
        documents.push({ source: posix(sourceValue), status: 'omitted', omittedReason: 'invalid-source' });
        continue;
      }
      if (!(await exists(absolute))) {
        documents.push({ source, status: 'omitted', omittedReason: 'missing' });
        continue;
      }
      const realAbsolute = await fs.promises.realpath(absolute).catch(() => absolute);
      if (!safeRelative(realRoot, realAbsolute)) {
        documents.push({ source, status: 'omitted', omittedReason: 'outside-project' });
        continue;
      }
      const content = await fs.promises.readFile(absolute);
      const remotePath = `documents/${source}`;
      documents.push({ source, remotePath, mime: 'text/markdown', size: content.length, checksum: checksum(content), status: 'included' });
      documentContents.set(source, content);
      includedBytes += content.length;
      const frozen = path.join(buildingDir, remotePath);
      await fs.promises.mkdir(path.dirname(frozen), { recursive: true });
      // Buffer write is deliberate: CRLF, Unicode and all other source bytes
      // must reach Pipeline Studio without decode/re-encode normalization.
      await fs.promises.writeFile(frozen, content);
    }

    type Ref = { raw: string; referencedBy: Set<string> };
    const references = new Map<string, Ref>();
    const immediate: ScreenFormatManifestFile[] = [];
    for (const [source, content] of documentContents) {
      for (const raw of markdownReferences(content.toString('utf8'))) {
        const parsed = referencePath(raw);
        if (!parsed.path) {
          immediate.push({ source: raw, status: 'omitted', omittedReason: parsed.reason ?? 'remote-reference', referencedBy: [source] });
          continue;
        }
        const absolute = path.resolve(path.dirname(path.join(root, source)), parsed.path);
        const rel = safeRelative(root, absolute);
        if (!rel) {
          immediate.push({ source: raw, status: 'omitted', omittedReason: 'outside-project', referencedBy: [source] });
          continue;
        }
        const existing = references.get(rel) ?? { raw: rel, referencedBy: new Set<string>() };
        existing.referencedBy.add(source);
        references.set(rel, existing);
      }
    }

    const attachments: ScreenFormatManifestFile[] = [...immediate];
    let attachmentOrdinal = 0;
    for (const [source, ref] of references) {
      attachmentOrdinal += 1;
      const referencedBy = [...ref.referencedBy].sort();
      if (attachmentOrdinal > limits.attachments) {
        attachments.push({ source, status: 'omitted', omittedReason: 'attachment-count-cap', referencedBy });
        continue;
      }
      const absolute = path.join(root, source);
      if (!(await exists(absolute))) {
        attachments.push({ source, status: 'omitted', omittedReason: 'missing', referencedBy });
        continue;
      }
      const realAbsolute = await fs.promises.realpath(absolute).catch(() => absolute);
      if (!safeRelative(realRoot, realAbsolute)) {
        attachments.push({ source, status: 'omitted', omittedReason: 'outside-project', referencedBy });
        continue;
      }
      const stat = await fs.promises.stat(absolute);
      if (stat.size > limits.fileBytes) {
        attachments.push({ source, status: 'omitted', omittedReason: 'file-size-cap', size: stat.size, referencedBy });
        continue;
      }
      if (includedBytes + stat.size > limits.bundleBytes) {
        attachments.push({ source, status: 'omitted', omittedReason: 'bundle-size-cap', size: stat.size, referencedBy });
        continue;
      }
      const content = await fs.promises.readFile(absolute);
      const remotePath = `attachments/${source}`;
      const mime = mimeOf(source);
      attachments.push({ source, remotePath, mime, size: content.length, checksum: checksum(content), status: 'included', referencedBy });
      includedBytes += content.length;
      const frozen = path.join(buildingDir, remotePath);
      await fs.promises.mkdir(path.dirname(frozen), { recursive: true });
      await fs.promises.writeFile(frozen, content);
    }

    const includedDocuments = documents.filter((doc) => doc.status === 'included' && doc.checksum);
    const fingerprint = computeScreenFormatFingerprint({
      scannerTrace: input.scannerTrace,
      documents: includedDocuments.map((doc) => ({ source: doc.source, checksum: doc.checksum! })),
    });
    const manifest: ScreenFormatObservationManifest = {
      schemaVersion: 1,
      observationId,
      createdAt,
      severity: input.severity,
      containsFullDocument: documents.length > 0 && includedDocuments.length === documents.length,
      fingerprint,
      project: {
        id: input.projectId,
        ...(input.projectName ? { name: input.projectName } : {}),
        workflowId: input.workflowId,
        stageId: input.stageId,
      },
      app: input.app,
      installationId: input.installationId,
      scannerTrace: input.scannerTrace,
      recovery: input.recovery,
      limits,
      totals: {
        includedBytes,
        documents: includedDocuments.length,
        attachments: attachments.filter((attachment) => attachment.status === 'included').length,
        omittedAttachments: attachments.filter((attachment) => attachment.status === 'omitted').length,
      },
      documents,
      attachments,
    };
    await fs.promises.writeFile(path.join(buildingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    // Publish the bundle to the outbox atomically so startup/manual flush can
    // never observe a half-written manifest or truncated source document.
    await fs.promises.rename(buildingDir, bundleDir);
  }

  async function uploadBundle(bundleDir: string): Promise<void> {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(bundleDir, 'manifest.json'), 'utf8')) as ScreenFormatObservationManifest;
    const prefix = `observations/${cleanInstallationId(manifest.installationId)}/${manifest.observationId}/`;
    for (const entry of [...manifest.documents, ...manifest.attachments]) {
      if (entry.status !== 'included' || !entry.remotePath || !entry.mime) continue;
      const content = await fs.promises.readFile(path.join(bundleDir, entry.remotePath));
      await clientOf().uploadFile(SCREEN_FORMAT_REPORTS_FOLDER, 'observations', `${prefix}${entry.remotePath}`, entry.mime, content);
    }
    await clientOf().uploadFile(
      SCREEN_FORMAT_REPORTS_FOLDER,
      'observations',
      `${prefix}manifest.json`,
      'application/json',
      await fs.promises.readFile(path.join(bundleDir, 'manifest.json')),
    );
  }

  let flushPromise: Promise<{ sent: number; left: number }> | null = null;
  async function doFlush(): Promise<{ sent: number; left: number }> {
    if (!enabled()) return { sent: 0, left: 0 };
    const names = (await fs.promises.readdir(outboxDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
      .map((entry) => entry.name)
      .sort();
    let sent = 0;
    for (const name of names) {
      const bundleDir = path.join(outboxDir, name);
      try {
        await uploadBundle(bundleDir);
        await fs.promises.rm(bundleDir, { recursive: true, force: true });
        sent += 1;
      } catch (error) {
        log(`[screen-format-reports] outbox flush stopped at ${name}: ${(error as Error)?.message ?? error}`);
        return { sent, left: names.length - sent };
      }
    }
    return { sent, left: 0 };
  }

  function flushOutbox(): Promise<{ sent: number; left: number }> {
    if (flushPromise) return flushPromise;
    flushPromise = doFlush().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  function report(input: ScreenFormatObservationInput): string {
    const observationId = makeId();
    if (!enabled()) return observationId;
    track(
      (async () => {
        await buildBundle(input, observationId);
        const result = await flushOutbox();
        log(`[screen-format-reports] observation #${observationId} (${result.sent} sent, ${result.left} queued)`);
      })().catch((error) => {
        log(`[screen-format-reports] could not bundle observation #${observationId}: ${(error as Error)?.message ?? error}`);
      }),
    );
    return observationId;
  }

  if (enabled()) {
    const timer = setTimeout(() => {
      track(flushOutbox().catch(() => ({ sent: 0, left: 0 })));
    }, FLUSH_DELAY_MS);
    timer.unref();
  }

  return {
    report,
    flushOutbox,
    idle: async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
