// Figma REST client for the docs-review Screen → Component stage.
//
// Reads a design-system's component catalogue straight from Figma with a
// Personal Access Token — deterministic, daemon-side, no agent/MCP/desktop
// app in the loop. Three endpoints only:
//   GET /v1/me                       — token check (who owns it)
//   GET /v1/files/:key?depth=1       — file name + the flat `components` /
//                                      `componentSets` metadata maps (these
//                                      maps are complete regardless of depth;
//                                      depth=1 just keeps the page tree tiny)
//   GET /v1/files/:key/nodes?ids=…   — `componentPropertyDefinitions` of each
//                                      set / standalone component (variants,
//                                      booleans, text, instance-swap props)
// plus a best-effort GET /v1/files/:key/components (published components) to
// pick up page names + descriptions when the file is a published library.
//
// Catalogue entry = one COMPONENT_SET (its variants collapsed into a VARIANT
// property) or one standalone COMPONENT. Components marked `remote` (used
// from another library) are NOT part of this file's catalogue — a product
// file pasted by mistake yields 0 entries and `remoteOnly: true` so the UI
// can say "dán link thư viện gốc".

import type { FigmaLinkVerification } from '@open-design/contracts';

import type {
  FigmaCatalogComponent,
  FigmaCatalogFile,
  FigmaCatalogProperty,
  FigmaComponentCatalogSnapshot,
} from './figma-component-catalog.js';
import { FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION } from './figma-component-catalog.js';

export const FIGMA_API_BASE = 'https://api.figma.com';
const REQUEST_TIMEOUT_MS = 30_000;
const NODES_BATCH_SIZE = 40;
const MAX_RATE_LIMIT_RETRIES = 3;

export type FigmaRestErrorKind =
  | 'no_token'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid';

export class FigmaRestError extends Error {
  readonly kind: FigmaRestErrorKind;
  readonly status?: number;
  constructor(kind: FigmaRestErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'FigmaRestError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** Vietnamese, user-facing wording for every failure the client can raise. */
export function describeFigmaError(err: unknown): string {
  if (err instanceof FigmaRestError) {
    switch (err.kind) {
      case 'no_token': return 'Chưa có token Figma. Dán Personal Access Token trong Thông tin dự án.';
      case 'auth': return 'Token Figma không hợp lệ hoặc đã bị thu hồi. Tạo token mới trong Figma → Settings → Security.';
      case 'forbidden': return 'Token này không đọc được file: kiểm tra token có scope “File content: Read” và tài khoản tạo token được chia sẻ file (quyền xem là đủ).';
      case 'not_found': return 'Không tìm thấy file Figma — link sai hoặc file đã bị xóa.';
      case 'rate_limited': return 'Figma đang giới hạn tần suất truy cập. Đợi một phút rồi thử lại.';
      case 'timeout': return 'Figma phản hồi quá lâu. Thử lại sau.';
      case 'network': return `Không kết nối được tới Figma: ${err.message}`;
      case 'invalid': return `Figma trả về dữ liệu không như mong đợi: ${err.message}`;
      default: return `Figma trả về lỗi HTTP ${err.status ?? '?'}.`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export interface FigmaRestDeps {
  fetch?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Cancels the complete catalogue operation, including retries/page walks. */
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Figma operation aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function abortableSleep(ms: number, deps: FigmaRestDeps): Promise<void> {
  const sleep = deps.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const signal = deps.signal;
  throwIfAborted(signal);
  if (!signal) return sleep(ms);
  let onAbort: () => void = () => undefined;
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

async function figmaGet(pathname: string, token: string, deps: FigmaRestDeps): Promise<unknown> {
  if (!token) throw new FigmaRestError('no_token', 'missing token');
  const doFetch = deps.fetch ?? fetch;
  const url = `${deps.baseUrl ?? FIGMA_API_BASE}${pathname}`;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(deps.signal);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(deps.signal?.reason);
    deps.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    let retryDelayMs: number | null = null;
    try {
      const res = await doFetch(url, { headers: { 'X-Figma-Token': token }, signal: controller.signal });
      throwIfAborted(deps.signal);
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        retryDelayMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1), 20_000);
      } else if (res.status === 401 || res.status === 403) {
        // Figma answers 403 both for a bad token and for a file the token's
        // owner cannot see; the body distinguishes ("Invalid token").
        const body = await res.text().catch(() => '');
        throwIfAborted(deps.signal);
        const invalidToken = res.status === 401 || (/invalid token/i.test(body));
        throw new FigmaRestError(invalidToken ? 'auth' : 'forbidden', body.slice(0, 200), res.status);
      } else if (res.status === 404) {
        throw new FigmaRestError('not_found', 'not found', 404);
      } else if (res.status === 429) {
        throw new FigmaRestError('rate_limited', 'rate limited', 429);
      } else if (!res.ok) {
        throw new FigmaRestError('http', `HTTP ${res.status}`, res.status);
      } else {
        try {
          const body = await res.json();
          throwIfAborted(deps.signal);
          return body;
        } catch (err) {
          if (deps.signal?.aborted) throw abortReason(deps.signal);
          if (timedOut) throw new FigmaRestError('timeout', 'timeout');
          if (err instanceof FigmaRestError) throw err;
          throw new FigmaRestError('invalid', err instanceof Error ? err.message : 'invalid JSON');
        }
      }
    } catch (err) {
      if (err instanceof FigmaRestError) throw err;
      if (deps.signal?.aborted) throw abortReason(deps.signal);
      if (timedOut || controller.signal.aborted) throw new FigmaRestError('timeout', 'timeout');
      throw new FigmaRestError('network', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', abortFromCaller);
    }
    if (retryDelayMs !== null) {
      await abortableSleep(retryDelayMs, deps);
      continue;
    }
  }
}

/** `GET /v1/me` needs the `current_user:read` scope, which the token guide
 *  deliberately does NOT ask for (only "File content: Read"). A 403 that is
 *  not "Invalid token" therefore means Figma authenticated the token but the
 *  scope is missing — the token is still fine for reading files, so report
 *  it as valid without handle/email instead of failing the save. */
export async function figmaWhoAmI(token: string, deps: FigmaRestDeps = {}): Promise<{ handle?: string; email?: string; scopeLimited?: boolean }> {
  let me: Record<string, unknown> | null;
  try {
    me = record(await figmaGet('/v1/me', token, deps));
  } catch (err) {
    if (err instanceof FigmaRestError && err.kind === 'forbidden') return { scopeLimited: true };
    throw err;
  }
  const handle = cleanText(me?.handle, 200);
  const email = cleanText(me?.email, 200);
  return { ...(handle ? { handle } : {}), ...(email ? { email } : {}) };
}

interface FileSummary {
  name: string;
  /** Catalogue entries owned by this file, in Figma's order. */
  entries: Array<{ nodeId: string; name: string; description?: string; page?: string; kind: 'set' | 'component' }>;
  /** Components the file only USES from other libraries (page-walk only). */
  remoteCount: number;
  /** 'published' = library endpoints; 'pages' = walked every page (unpublished file). */
  source: 'published' | 'pages';
}

function pushEntry(
  entries: FileSummary['entries'],
  seen: Set<string>,
  entry: { nodeId: string; name: unknown; description?: unknown; page?: unknown; kind: 'set' | 'component' },
): void {
  const name = cleanText(entry.name, 300);
  if (!name || seen.has(entry.nodeId)) return;
  seen.add(entry.nodeId);
  const description = cleanText(entry.description, 2_000);
  const page = cleanText(entry.page, 300);
  entries.push({
    nodeId: entry.nodeId,
    name,
    ...(description ? { description } : {}),
    ...(page ? { page } : {}),
    kind: entry.kind,
  });
}

/** Published library metadata: `/component_sets` (one row per set) +
 *  `/components` (every published component incl. variants; a variant carries
 *  `containing_frame.containingStateGroup` → its set, so only stand-alone
 *  components become entries). Cheap and file-wide, but EMPTY for a file
 *  whose components were never published. */
async function fetchPublishedEntries(token: string, fileKey: string, deps: FigmaRestDeps): Promise<FileSummary['entries']> {
  const base = `/v1/files/${encodeURIComponent(fileKey)}`;
  const entries: FileSummary['entries'] = [];
  const seen = new Set<string>();
  const sets = record(await figmaGet(`${base}/component_sets`, token, deps));
  for (const raw of Array.isArray(record(sets?.meta)?.component_sets) ? (record(sets?.meta)?.component_sets as unknown[]) : []) {
    const item = record(raw);
    const nodeId = cleanText(item?.node_id, 100);
    if (!nodeId) continue;
    pushEntry(entries, seen, { nodeId, name: item?.name, description: item?.description, page: record(item?.containing_frame)?.pageName, kind: 'set' });
  }
  const components = record(await figmaGet(`${base}/components`, token, deps));
  for (const raw of Array.isArray(record(components?.meta)?.components) ? (record(components?.meta)?.components as unknown[]) : []) {
    const item = record(raw);
    const nodeId = cleanText(item?.node_id, 100);
    if (!nodeId) continue;
    const frame = record(item?.containing_frame);
    if (record(frame?.containingStateGroup)) continue; // variant → covered by its set
    pushEntry(entries, seen, { nodeId, name: item?.name, description: item?.description, page: frame?.pageName, kind: 'component' });
  }
  return entries;
}

/** Fallback for unpublished files: `GET /v1/files/:key?depth=N` only lists
 *  the components INSIDE the returned subtree (depth=1 → none, since
 *  components sit under pages/sections), so walk the file page by page with
 *  `/nodes?ids=<pageId>` and merge each page's `componentSets`/`components`
 *  maps. Sequential on purpose (per-token rate limit). */
async function walkPagesForEntries(
  token: string,
  fileKey: string,
  pages: Array<{ id: string; name: string }>,
  deps: FigmaRestDeps,
): Promise<{ entries: FileSummary['entries']; remoteCount: number }> {
  const entries: FileSummary['entries'] = [];
  const seen = new Set<string>();
  const remote = new Set<string>();
  for (const page of pages) {
    const body = record(await figmaGet(
      `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(page.id)}`,
      token,
      deps,
    ));
    const node = record(record(body?.nodes)?.[page.id]);
    for (const [nodeId, raw] of Object.entries(record(node?.componentSets) ?? {})) {
      const set = record(raw);
      if (!set) continue;
      if (set.remote === true) { remote.add(nodeId); continue; }
      pushEntry(entries, seen, { nodeId, name: set.name, description: set.description, page: page.name, kind: 'set' });
    }
    for (const [nodeId, raw] of Object.entries(record(node?.components) ?? {})) {
      const component = record(raw);
      if (!component) continue;
      if (component.remote === true) { remote.add(nodeId); continue; }
      if (typeof component.componentSetId === 'string' && component.componentSetId) continue;
      pushEntry(entries, seen, { nodeId, name: component.name, description: component.description, page: page.name, kind: 'component' });
    }
  }
  return { entries, remoteCount: remote.size };
}

async function fetchFileSummary(token: string, fileKey: string, deps: FigmaRestDeps): Promise<FileSummary> {
  const file = record(await figmaGet(`/v1/files/${encodeURIComponent(fileKey)}?depth=1`, token, deps));
  if (!file) throw new FigmaRestError('invalid', 'file payload is not an object');
  const name = cleanText(file.name, 300) || fileKey;
  let published: FileSummary['entries'] = [];
  try {
    published = await fetchPublishedEntries(token, fileKey, deps);
  } catch (err) {
    // Published-library endpoints need library_content:read. The token guide
    // intentionally asks only for file_content:read, so fall back after the
    // base file request has already proved that this file is readable.
    if (!(err instanceof FigmaRestError) || err.kind !== 'forbidden') throw err;
  }
  if (published.length > 0) return { name, entries: published, remoteCount: 0, source: 'published' };
  const children = record(file.document)?.children;
  const pages = (Array.isArray(children) ? children : [])
    .map((raw) => record(raw))
    .filter((page): page is Record<string, unknown> => Boolean(page && typeof page.id === 'string'))
    .map((page) => ({ id: page.id as string, name: cleanText(page.name, 300) }));
  const walked = await walkPagesForEntries(token, fileKey, pages, deps);
  return { name, entries: walked.entries, remoteCount: walked.remoteCount, source: 'pages' };
}

function propertiesOf(node: Record<string, unknown> | null): FigmaCatalogProperty[] {
  const defs = record(node?.componentPropertyDefinitions);
  if (!defs) return [];
  const out: FigmaCatalogProperty[] = [];
  for (const [rawName, rawDef] of Object.entries(defs)) {
    const def = record(rawDef);
    if (!def) continue;
    // Non-variant property names carry a `#node:id` suffix in the API.
    const name = cleanText(rawName.replace(/#\d+:\d+$/, ''), 200);
    const type = cleanText(def.type, 50) || 'UNKNOWN';
    if (!name) continue;
    let values: string[] = [];
    if (Array.isArray(def.variantOptions)) {
      values = [...new Set(def.variantOptions.map((v) => cleanText(v, 200)).filter(Boolean))].slice(0, 100);
    } else if (type === 'TEXT' && typeof def.defaultValue === 'string' && def.defaultValue.trim()) {
      values = [cleanText(def.defaultValue, 200)];
    }
    out.push({ name, type, values });
  }
  return out;
}

async function fetchProperties(
  token: string,
  fileKey: string,
  nodeIds: string[],
  deps: FigmaRestDeps,
): Promise<Map<string, FigmaCatalogProperty[]>> {
  const result = new Map<string, FigmaCatalogProperty[]>();
  for (let start = 0; start < nodeIds.length; start += NODES_BATCH_SIZE) {
    const batch = nodeIds.slice(start, start + NODES_BATCH_SIZE);
    const body = record(await figmaGet(
      `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(batch.join(','))}&depth=1`,
      token,
      deps,
    ));
    const nodes = record(body?.nodes) ?? {};
    for (const nodeId of batch) {
      const document = record(record(nodes[nodeId])?.document);
      result.set(nodeId, propertiesOf(document));
    }
  }
  return result;
}

/** One link → verification row for the App form ("Kiểm tra link"). Never
 *  throws: every failure is a `{ ok: false, detail }` row. */
export async function verifyFigmaLink(
  token: string,
  link: { url: string; fileKey: string },
  deps: FigmaRestDeps = {},
): Promise<FigmaLinkVerification> {
  try {
    const summary = await fetchFileSummary(token, link.fileKey, deps);
    const remoteOnly = summary.entries.length === 0 && summary.remoteCount > 0;
    return {
      fileKey: link.fileKey,
      url: link.url,
      ok: summary.entries.length > 0,
      name: summary.name,
      componentCount: summary.entries.length,
      ...(remoteOnly ? { remoteOnly: true } : {}),
      ...(summary.entries.length === 0
        ? { detail: remoteOnly
          ? `File này không định nghĩa component riêng (chỉ dùng ${summary.remoteCount} component từ thư viện khác). Hãy dán link file thư viện gốc.`
          : 'File này không có component nào.' }
        : {}),
    };
  } catch (err) {
    return { fileKey: link.fileKey, url: link.url, ok: false, detail: describeFigmaError(err) };
  }
}

export interface FigmaCatalogProgress {
  /** 1-based index of the file being read. */
  index: number;
  total: number;
  fileKey: string;
  name?: string;
  phase: 'summary' | 'properties' | 'done';
}

/** Read every configured file in order and freeze one snapshot. Throws a
 *  FigmaRestError-derived Error naming the file on the first failure — the
 *  caller keeps the previous catalogue in that case (fail-safe contract of
 *  the dr-comp preparation phase). */
export async function buildFigmaComponentCatalog(options: {
  token: string;
  links: Array<{ url: string; fileKey: string }>;
  onProgress?: (progress: FigmaCatalogProgress) => void;
  deps?: FigmaRestDeps;
  signal?: AbortSignal;
}): Promise<FigmaComponentCatalogSnapshot> {
  const deps: FigmaRestDeps = { ...(options.deps ?? {}), ...(options.signal ? { signal: options.signal } : {}) };
  const files: FigmaCatalogFile[] = [];
  const total = options.links.length;
  const reportProgress = (progress: FigmaCatalogProgress) => {
    throwIfAborted(deps.signal);
    options.onProgress?.(progress);
  };
  for (const [i, link] of options.links.entries()) {
    throwIfAborted(deps.signal);
    const index = i + 1;
    reportProgress({ index, total, fileKey: link.fileKey, phase: 'summary' });
    let summary: FileSummary;
    try {
      summary = await fetchFileSummary(options.token, link.fileKey, deps);
    } catch (err) {
      throw new Error(`File ${index}/${total} (${link.fileKey}): ${describeFigmaError(err)}`);
    }
    if (summary.entries.length === 0) {
      throw new Error(summary.remoteCount > 0
        ? `File ${index}/${total} “${summary.name}” không định nghĩa component riêng (chỉ dùng component từ thư viện khác). Hãy dán link file thư viện gốc.`
        : `File ${index}/${total} “${summary.name}” không có component nào.`);
    }
    reportProgress({ index, total, fileKey: link.fileKey, name: summary.name, phase: 'properties' });
    let properties: Map<string, FigmaCatalogProperty[]>;
    try {
      properties = await fetchProperties(options.token, link.fileKey, summary.entries.map((entry) => entry.nodeId), deps);
    } catch (err) {
      throw new Error(`File ${index}/${total} “${summary.name}”: ${describeFigmaError(err)}`);
    }
    const components: FigmaCatalogComponent[] = summary.entries.map((entry) => ({
      nodeId: entry.nodeId,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.page ? { page: entry.page } : {}),
      properties: properties.get(entry.nodeId) ?? [],
    }));
    files.push({ fileKey: link.fileKey, name: summary.name, url: link.url, components });
    reportProgress({ index, total, fileKey: link.fileKey, name: summary.name, phase: 'done' });
  }
  throwIfAborted(deps.signal);
  return {
    schemaVersion: FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    files,
  };
}
