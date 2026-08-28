// Confluence-backed sync blobs. Raw attachments downloaded from the wiki are
// NOT uploaded to media: the sibling `attachments/_sources.json` ledger is the
// manifest, Push skips their bytes and Pull re-downloads them from Confluence
// pinned to the reviewed attachment version. Pure helpers + one network
// fetcher; no media/project-sync state lives here.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectSyncConfluencePreflight, ProjectSyncConfluenceSource } from '@open-design/contracts';
import {
  CONFLUENCE_SOURCES_FILE,
  confluenceAttachmentDownloadUrl,
  readConfluenceSourcesLedger,
  type ConfluenceSourceItem,
  type ConfluenceSourcesLedger,
} from './confluence-sources.js';

const ATTACHMENTS_DIR = 'attachments';
const PREFLIGHT_TIMEOUT_MS = 12_000;
/** Raw wiki attachments are re-downloaded 4 at a time when a ledger expands. */
export const CONFLUENCE_PULL_CONCURRENCY = 4;
export const CONFLUENCE_CREDS_MISSING = 'Chưa cấu hình PAT Confluence';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** `<…>/attachments/_sources.json` (forward-slash relative path). */
export function isAttachmentsLedgerPath(rel: string): boolean {
  return path.posix.basename(rel) === CONFLUENCE_SOURCES_FILE
    && path.posix.basename(path.posix.dirname(rel)) === ATTACHMENTS_DIR;
}

/** A ledger item name must be one plain path segment: it is joined onto the
 * attachments dir when the group expands, so a remote ledger can never escape it. */
export function isSafeLedgerName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

/** `<…>/attachments/<name>` → `<…>/attachments`; anything else → null. */
export function attachmentDirOf(rel: string): string | null {
  const dir = path.posix.dirname(rel);
  if (path.posix.basename(dir) !== ATTACHMENTS_DIR) return null;
  const name = path.posix.basename(rel);
  if (!name || name === '.' || name === '..' || name.includes('/')) return null;
  return dir;
}

function sourceOf(ledger: Pick<ConfluenceSourcesLedger, 'base'>, item: ConfluenceSourceItem): ProjectSyncConfluenceSource {
  return { base: ledger.base, pageId: item.pageId, spaceKey: item.spaceKey, attachment: item.attachment, attachmentVersion: item.attachmentVersion };
}

/** Wire-level provenance of one ledger item (preflight / legacy per-file pull). */
export function confluenceSourceOf(base: string, item: ConfluenceSourceItem): ProjectSyncConfluenceSource {
  return sourceOf({ base }, item);
}

/** Parse a media-side `attachments/_sources.json` blob; malformed → null. */
export function parseConfluenceLedgerBuffer(content: Buffer): ConfluenceSourcesLedger | null {
  try {
    const parsed = JSON.parse(content.toString('utf8')) as Partial<ConfluenceSourcesLedger> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || typeof parsed.base !== 'string' || !Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((item): item is ConfluenceSourcesLedger['items'][number] => Boolean(item && typeof item === 'object'
        && typeof (item as { name?: unknown }).name === 'string' && typeof (item as { sha256?: unknown }).sha256 === 'string'
        && typeof (item as { pageId?: unknown }).pageId === 'string' && typeof (item as { attachment?: unknown }).attachment === 'string'))
      .map((item) => ({
        ...item,
        size: typeof item.size === 'number' ? item.size : 0,
        spaceKey: typeof item.spaceKey === 'string' ? item.spaceKey : '',
        attachmentVersion: typeof item.attachmentVersion === 'number' && item.attachmentVersion > 0 ? item.attachmentVersion : 0,
        fetchedAt: typeof item.fetchedAt === 'number' ? item.fetchedAt : 0,
      }));
    return { version: 1, base: parsed.base.replace(/\/+$/, ''), items };
  } catch { return null; }
}

/** Local side: a file whose ledger sibling lists it with the SAME sha256 is
 * Confluence-backed. Unlisted / mismatching files fall back to plain bytes. */
export async function resolveLocalConfluenceSources(
  root: string,
  files: Array<{ rel: string; checksum: string }>,
): Promise<Map<string, ProjectSyncConfluenceSource>> {
  const byDir = new Map<string, Array<{ rel: string; checksum: string }>>();
  for (const file of files) {
    const dir = attachmentDirOf(file.rel);
    if (!dir) continue;
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const out = new Map<string, ProjectSyncConfluenceSource>();
  for (const [dir, list] of byDir) {
    const ledger = await readConfluenceSourcesLedger(path.join(root, ...dir.split('/')));
    if (!ledger || !ledger.base) continue;
    const byName = new Map(ledger.items.map((item) => [item.name, item]));
    for (const file of list) {
      const item = byName.get(path.posix.basename(file.rel));
      if (item && item.sha256 === file.checksum) out.set(file.rel, sourceOf(ledger, item));
    }
  }
  return out;
}

/** Origin side: every ledger item without a real media file becomes a
 * synthetic origin entry, so the diff works exactly as if the bytes were there. */
export function synthesizeOriginConfluenceEntries(
  ledgers: Array<{ dirRel: string; ledger: ConfluenceSourcesLedger }>,
  present: Set<string>,
): Array<{ rel: string; checksum: string; size: number; confluence: ProjectSyncConfluenceSource }> {
  const out: Array<{ rel: string; checksum: string; size: number; confluence: ProjectSyncConfluenceSource }> = [];
  const seen = new Set<string>();
  for (const { dirRel, ledger } of ledgers) {
    if (!ledger.base) continue;
    for (const item of ledger.items) {
      const rel = dirRel ? `${dirRel}/${item.name}` : item.name;
      if (present.has(rel) || seen.has(rel)) continue;
      seen.add(rel);
      out.push({ rel, checksum: item.sha256, size: item.size, confluence: sourceOf(ledger, item) });
    }
  }
  return out;
}

/** A file seen by the lazy directory walk: metadata first, bytes on demand. */
export interface LazyLocalFile {
  rel: string;
  size: number;
  mtimeMs: number;
  read(): Promise<Buffer>;
}

export interface LocalLedgerGroup {
  files: number;
  bytes: number;
  /** Ledger items whose local file matched (name + size + mtime/sha). */
  items: ConfluenceSourceItem[];
}

/** Local side, one entry per ledger: `<dir>/attachments/<name>` MATCHES its
 * sibling `_sources.json` item when the name and size agree and either the
 * file predates the ledger (mtime) or — only then reading the bytes — its
 * sha256 equals the recorded one. Matched files get no plan entry at all. */
export async function groupLocalLedgers(
  root: string,
  files: readonly LazyLocalFile[],
): Promise<{ matched: Set<string>; groups: Map<string, LocalLedgerGroup> }> {
  const byDir = new Map<string, LazyLocalFile[]>();
  for (const file of files) {
    const dir = attachmentDirOf(file.rel);
    if (!dir || path.posix.basename(file.rel) === CONFLUENCE_SOURCES_FILE) continue;
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const matched = new Set<string>();
  const groups = new Map<string, LocalLedgerGroup>();
  for (const [dir, list] of byDir) {
    const absDir = path.join(root, ...dir.split('/'));
    const ledger = await readConfluenceSourcesLedger(absDir);
    if (!ledger || !ledger.base) continue;
    const ledgerStat = await fs.stat(path.join(absDir, CONFLUENCE_SOURCES_FILE)).catch(() => null);
    const ledgerMtime = ledgerStat?.mtimeMs ?? 0;
    const byName = new Map(ledger.items.map((item) => [item.name, item]));
    const group: LocalLedgerGroup = { files: 0, bytes: 0, items: [] };
    for (const file of list) {
      const item = byName.get(path.posix.basename(file.rel));
      if (!item || item.size !== file.size) continue;
      let ok = file.mtimeMs <= ledgerMtime;
      if (!ok) {
        const content = await file.read().catch(() => null);
        ok = Boolean(content) && sha256(content!) === item.sha256;
      }
      if (!ok) continue;
      matched.add(file.rel);
      group.files += 1;
      group.bytes += item.size;
      group.items.push(item);
    }
    if (group.files > 0) groups.set(`${dir}/${CONFLUENCE_SOURCES_FILE}`, group);
  }
  return { matched, groups };
}

export interface OriginLedgerGroup {
  base: string;
  files: number;
  bytes: number;
  /** Items absent (or size-mismatched) on the local side; 0 when not computed. */
  missing: number;
  items: ConfluenceSourceItem[];
}

/** Origin side, one entry per ledger: every item WITHOUT a real media file is
 * part of the group. `local` = null skips the missing computation (push);
 * `{ root: null }` means there is no local folder at all (everything missing). */
export async function groupOriginLedgers(
  ledgers: Array<{ dirRel: string; ledger: ConfluenceSourcesLedger }>,
  present: Set<string>,
  local: { root: string | null } | null,
): Promise<Map<string, OriginLedgerGroup>> {
  const out = new Map<string, OriginLedgerGroup>();
  for (const { dirRel, ledger } of ledgers) {
    if (!ledger.base) continue;
    const group: OriginLedgerGroup = { base: ledger.base, files: 0, bytes: 0, missing: 0, items: [] };
    for (const item of ledger.items) {
      if (!isSafeLedgerName(item.name)) continue;
      const rel = dirRel ? `${dirRel}/${item.name}` : item.name;
      if (present.has(rel)) continue;
      group.files += 1;
      group.bytes += item.size;
      group.items.push(item);
      if (!local) continue;
      if (!local.root) { group.missing += 1; continue; }
      const stat = await fs.stat(path.join(local.root, ...rel.split('/'))).catch(() => null);
      if (!stat?.isFile() || stat.size !== item.size) group.missing += 1;
    }
    out.set(dirRel ? `${dirRel}/${CONFLUENCE_SOURCES_FILE}` : CONFLUENCE_SOURCES_FILE, group);
  }
  return out;
}

export type LedgerItemOutcome = 'fetched' | 'skipped' | 'drifted' | 'missing';

export interface ExpandLedgerGroupResult {
  /** Files written (ok + drifted). */
  fetched: number;
  /** Files already present with the recorded size — nothing downloaded. */
  skipped: number;
  drifted: Array<{ path: string; reason: string }>;
  missing: Array<{ path: string; reason: string }>;
}

/** Materialize every ledger item into `targetDir` (APPLY time): a file that
 * already exists with the recorded size is skipped, anything else is fetched
 * from the wiki (pinned → latest), CONFLUENCE_PULL_CONCURRENCY at a time.
 * `missing` items write nothing. Report paths are `<relDir>/<name>`. */
export async function expandLedgerGroup(
  creds: { base: string; token: string } | null,
  ledger: Pick<ConfluenceSourcesLedger, 'base' | 'items'>,
  targetDir: string,
  opts: { relDir: string; onItem?: (name: string, outcome: LedgerItemOutcome) => void; signal?: AbortSignal },
): Promise<ExpandLedgerGroupResult> {
  const result: ExpandLedgerGroupResult = { fetched: 0, skipped: 0, drifted: [], missing: [] };
  const relOf = (name: string) => (opts.relDir ? `${opts.relDir}/${name}` : name);
  await mapLimit(ledger.items, CONFLUENCE_PULL_CONCURRENCY, async (item) => {
    let outcome: LedgerItemOutcome;
    if (!isSafeLedgerName(item.name)) {
      result.missing.push({ path: relOf(item.name), reason: 'Tên file trong ledger không hợp lệ' });
      opts.onItem?.(item.name, 'missing');
      return;
    }
    const target = path.join(targetDir, item.name);
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isFile() && stat.size === item.size) {
      result.skipped += 1;
      outcome = 'skipped';
    } else if (!creds) {
      result.missing.push({ path: relOf(item.name), reason: CONFLUENCE_CREDS_MISSING });
      outcome = 'missing';
    } else {
      const source = sourceOf(ledger, item);
      const fetched = await fetchConfluenceBlob(creds, source, item.sha256, opts.signal);
      if (fetched.kind === 'missing') {
        result.missing.push({ path: relOf(item.name), reason: fetched.reason });
        outcome = 'missing';
      } else {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(target, fetched.bytes);
        result.fetched += 1;
        if (fetched.kind === 'drifted') {
          result.drifted.push({ path: relOf(item.name), reason: `sha256 khác bản pin v${source.attachmentVersion || '?'} — đã ghi bản mới nhất trên wiki` });
          outcome = 'drifted';
        } else outcome = 'fetched';
      }
    }
    opts.onItem?.(item.name, outcome);
  });
  return result;
}

export type ConfluenceBlobOutcome = { kind: 'ok' | 'drifted'; bytes: Buffer } | { kind: 'missing'; reason: string };

async function getBlob(url: string, token: string, signal?: AbortSignal): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: '*/*' }, redirect: 'follow', ...(signal ? { signal } : {}) });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'network error' };
  }
}

/** Pinned version first; when its bytes no longer match, the latest version
 * is accepted as `drifted` so a Pull still yields a usable file. */
export async function fetchConfluenceBlob(
  creds: { base: string; token: string },
  src: ProjectSyncConfluenceSource,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<ConfluenceBlobOutcome> {
  const base = creds.base.replace(/\/+$/, '');
  const pinned = await getBlob(confluenceAttachmentDownloadUrl(base, src, true), creds.token, signal);
  if (pinned.ok && sha256(pinned.bytes) === expectedSha256) return { kind: 'ok', bytes: pinned.bytes };
  const latest = src.attachmentVersion > 0
    ? await getBlob(confluenceAttachmentDownloadUrl(base, src, false), creds.token, signal)
    : pinned;
  if (!latest.ok) return { kind: 'missing', reason: latest.reason };
  if (sha256(latest.bytes) === expectedSha256) return { kind: 'ok', bytes: latest.bytes };
  return { kind: 'drifted', bytes: latest.bytes };
}

/** Bounded-concurrency map preserving input order. Rejections propagate. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const normalizeBase = (value: string | null | undefined): string => (value ?? '').trim().replace(/\/+$/, '').toLowerCase();

async function getStatus(url: string, token: string): Promise<{ status: number; body?: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'follow', signal: controller.signal });
    const body = res.ok ? await res.json().catch(() => undefined) : undefined;
    if (!res.ok) await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Can THIS machine re-download the plan's Confluence files? Checks the PAT,
 * the base host, and one sample page per space (permission is a 404 on DC). */
export async function confluencePreflight(
  creds: { base: string; token: string } | null,
  sources: ProjectSyncConfluenceSource[],
  sizes: number[],
): Promise<ProjectSyncConfluencePreflight> {
  const required = sources.length > 0;
  const bytes = sizes.reduce((total, size) => total + (Number.isFinite(size) ? size : 0), 0);
  const base = required ? sources[0]!.base || null : null;
  const credsBase = creds?.base ?? null;
  if (!required) {
    return { required: false, files: 0, bytes: 0, base, credsBase, baseMatches: true, token: creds ? 'ok' : 'missing', spaces: [], ok: true };
  }
  const baseMatches = Boolean(base && credsBase) && normalizeBase(base) === normalizeBase(credsBase);
  let token: ProjectSyncConfluencePreflight['token'] = 'missing';
  let displayName: string | undefined;
  if (creds) {
    const probe = await getStatus(`${creds.base.replace(/\/+$/, '')}/rest/api/user/current`, creds.token);
    if (!probe) token = 'unreachable';
    else if (probe.status === 200) {
      token = 'ok';
      const body = probe.body as { displayName?: unknown; username?: unknown } | undefined;
      const name = typeof body?.displayName === 'string' ? body.displayName : typeof body?.username === 'string' ? body.username : '';
      if (name) displayName = name;
    } else if (probe.status === 401 || probe.status === 403) token = 'invalid';
    else token = 'unreachable';
  }
  const grouped = new Map<string, { samplePageId: string; files: number }>();
  for (const src of sources) {
    const key = src.spaceKey || '(unknown)';
    const group = grouped.get(key);
    if (group) group.files += 1;
    else grouped.set(key, { samplePageId: src.pageId, files: 1 });
  }
  const spaces: ProjectSyncConfluencePreflight['spaces'] = [];
  for (const [key, group] of grouped) {
    let ok = false;
    let status: number | null = null;
    if (creds && token === 'ok') {
      const probe = await getStatus(`${creds.base.replace(/\/+$/, '')}/rest/api/content/${encodeURIComponent(group.samplePageId)}`, creds.token);
      status = probe?.status ?? null;
      ok = probe?.status === 200;
    }
    spaces.push({ key, samplePageId: group.samplePageId, ok, status, files: group.files });
  }
  return {
    required: true,
    files: sources.length,
    bytes,
    base,
    credsBase,
    baseMatches,
    token,
    ...(displayName ? { displayName } : {}),
    spaces,
    ok: baseMatches && token === 'ok' && spaces.every((space) => space.ok),
  };
}
