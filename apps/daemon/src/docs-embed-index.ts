// `docs-embed-index.ts` — tìm tài liệu docs-review THEO NGỮ NGHĨA, cạnh
// `_sections.md` (V1, cơ học/grep). Đo trên pool thật: grep trả 0 kết quả
// cho 5/15 câu hỏi có từ khoá "khó" (đồng nghĩa/paraphrase); embedding local
// (bge-m3 qua Ollama) trúng 14/15 top-1. Xem wp-docs-review-embed-search.md.
//
// Ràng buộc cứng: tài liệu ngân hàng KHÔNG được rời máy — chỉ gọi Ollama
// local (`OD_EMBED_URL`, mặc định 127.0.0.1:11434). Không SDK cloud nào.
//
// Chunk hybrid THUẦN CƠ HỌC (0 LLM) trên section đã tách sẵn bởi
// `docs-section-index.ts#collectDocsSections` — head chunk (đầu section,
// LUÔN có) + window chunk (cắt theo dòng, chồng lấn) khi section dài. Vector
// L2-normalize sẵn nên cosine = dot product. Cache vector nằm NGOÀI thư mục
// dự án (`<RUNTIME_DATA_DIR>/embed-cache/…`) — project-sync chỉ bỏ qua
// `.odhistory/node_modules/.od-skills/.tmp`, để vector trong project sẽ bị
// đẩy lên media mỗi lần sync.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { collectDocsSections, type DocsSection } from './docs-section-index.js';

/** Ném khi backend Ollama không sẵn sàng (tắt qua `OD_DOCS_EMBED=0`, hoặc
 *  probe `/api/tags` fail) — route gọi `searchDocsEmbed` bắt lỗi này để trả
 *  503. `buildDocsEmbedIndex` KHÔNG ném lỗi này (no-op thay vào đó). */
export class EmbedUnavailableError extends Error {
  constructor(message = 'embedding backend unavailable') {
    super(message);
    this.name = 'EmbedUnavailableError';
  }
}

const WINDOW_CHARS = 1800;
const OVERLAP_CHARS = 250;
const MIN_BODY_CHARS = 120;
const EMBED_BATCH_SIZE = 16;
const EMBED_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_CACHE_MS = 60_000;

function embedBaseUrl(): string {
  return process.env.OD_EMBED_URL ?? 'http://127.0.0.1:11434';
}

function embedModel(): string {
  return process.env.OD_EMBED_MODEL ?? 'bge-m3';
}

// ---------------------------------------------------------------------------
// 1.2 — Chunk hybrid (thuần cơ học, 0 LLM)
// ---------------------------------------------------------------------------

export interface DocsChunk {
  rel: string;
  /** Số dòng THẬT (1-based) của điểm bắt đầu chunk trong file gốc — cái agent
   *  mở. Cho head chunk: dòng heading. Cho window chunk: dòng đầu cửa sổ. */
  line: number;
  crumb: string;
  kind: 'head' | 'window';
  text: string;
}

/** Cắt cửa sổ theo DÒNG (không cắt giữa dòng): mỗi cửa sổ tích luỹ tới
 *  ≥ WINDOW_CHARS ký tự rồi chốt; cửa sổ kế tiếp lùi lại các dòng cuối cho đủ
 *  ~OVERLAP_CHARS. Trả về chỉ số dòng (index vào `bodyLines`), không phải
 *  text — gọi nơi khác build text + tính dòng file thật. */
function computeLineWindows(bodyLines: string[]): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < bodyLines.length) {
    let chars = 0;
    let end = start;
    while (end < bodyLines.length && chars < WINDOW_CHARS) {
      chars += bodyLines[end]!.length + 1; // +1 cho '\n' nối dòng
      end += 1;
    }
    windows.push({ start, end });
    if (end >= bodyLines.length) break;
    // Lùi lại các dòng cuối cửa sổ vừa chốt cho đủ ~OVERLAP_CHARS, làm điểm
    // bắt đầu cửa sổ kế tiếp.
    let overlapChars = 0;
    let next = end;
    while (next > start && overlapChars < OVERLAP_CHARS) {
      next -= 1;
      overlapChars += bodyLines[next]!.length + 1;
    }
    // Đảm bảo luôn tiến (line siêu dài có thể khiến next tụt về == start).
    start = Math.max(next, start + 1);
  }
  return windows;
}

/** head chunk (luôn có) + window chunk (chỉ khi `body.length > WINDOW_CHARS`)
 *  của MỘT section. Deterministic — cùng input luôn ra cùng output. */
export function chunkSection(section: DocsSection): DocsChunk[] {
  const prefix = `${section.rel} | ${section.crumb}\n`;
  const chunks: DocsChunk[] = [
    {
      rel: section.rel,
      line: section.line,
      crumb: section.crumb,
      kind: 'head',
      text: prefix + section.body.slice(0, WINDOW_CHARS),
    },
  ];
  if (section.body.length <= WINDOW_CHARS) return chunks;

  const bodyLines = section.body.split('\n');
  // `section.line` là dòng heading; body bắt đầu ngay dòng kế tiếp trong file
  // gốc (khớp cách `docs-section-index.ts` cắt body).
  const firstBodyFileLine = section.line + 1;
  const windows = computeLineWindows(bodyLines);

  windows.forEach((w, idx) => {
    const windowText = bodyLines.slice(w.start, w.end).join('\n');
    // Cửa sổ ĐUÔI (cuối cùng) quá ngắn thì bỏ — phần đầu/giữa luôn giữ.
    const isTail = idx === windows.length - 1;
    if (isTail && windowText.length < MIN_BODY_CHARS) return;
    chunks.push({
      rel: section.rel,
      line: firstBodyFileLine + w.start,
      crumb: section.crumb,
      kind: 'window',
      text: prefix + windowText,
    });
  });
  return chunks;
}

// ---------------------------------------------------------------------------
// 1.3 — Embedding qua Ollama
// ---------------------------------------------------------------------------

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${embedBaseUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel(), input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new EmbedUnavailableError(`Ollama /api/embed trả HTTP ${res.status}`);
  const body = (await res.json()) as OllamaEmbedResponse;
  if (!Array.isArray(body.embeddings)) throw new EmbedUnavailableError('Ollama /api/embed thiếu trường embeddings');
  return body.embeddings;
}

/** Chuẩn hoá L2 NGAY khi nhận vector — để cosine similarity về đúng dot
 *  product khi tìm kiếm (không phải tính lại norm mỗi lần search). */
function l2Normalize(vec: number[]): Float32Array {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i]! / norm;
  return out;
}

/** Embed tuần tự theo batch `EMBED_BATCH_SIZE` — Ollama xử lý tuần tự phía
 *  server, bắn song song chỉ làm rối log chứ không nhanh hơn. */
async function embedAllNormalized(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    for (const vec of embeddings) out.push(l2Normalize(vec));
  }
  return out;
}

let probeCache: { ok: boolean; atMs: number } | null = null;

/** `GET /api/tags` (timeout 2s) → model đúng tên có mặt không. Cache 60s
 *  trong process. `OD_DOCS_EMBED=0` tắt hẳn — trả false luôn, KHÔNG gọi
 *  mạng (không kể cả `/api/tags`). */
export async function probeEmbedBackend(nowMs: number = Date.now()): Promise<boolean> {
  if (process.env.OD_DOCS_EMBED === '0') return false;
  if (probeCache && nowMs - probeCache.atMs < PROBE_CACHE_MS) return probeCache.ok;
  const ok = await probeOnce().catch(() => false);
  probeCache = { ok, atMs: nowMs };
  return ok;
}

/** Test-only: xoá cache 60s của `probeEmbedBackend` — không có cách nào khác
 *  buộc probe gọi lại `/api/tags` ngay trong cùng tiến trình khi test đổi
 *  `OD_DOCS_EMBED`/mock fetch giữa hai case. Không dùng ở đường chạy thật. */
export function resetDocsEmbedProbeCacheForTests(): void {
  probeCache = null;
}

async function probeOnce(): Promise<boolean> {
  const model = embedModel();
  const res = await fetch(`${embedBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as OllamaTagsResponse;
  const names = (body.models ?? [])
    .flatMap((m) => [m.name, m.model])
    .filter((v): v is string => typeof v === 'string');
  return names.some((n) => n === model || n.startsWith(`${model}:`));
}

// ---------------------------------------------------------------------------
// 1.4 — Cache vector (NGOÀI thư mục dự án)
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  rel: string;
  line: number;
  crumb: string;
  kind: 'head' | 'window';
}

interface CacheMeta {
  model: string;
  dim: number;
  rootDir: string;
  entries: CacheEntry[];
}

function cacheDirFor(rootDir: string, runtimeDataDir: string): string {
  const rootAbs = path.resolve(rootDir);
  const hash = createHash('sha256').update(rootAbs).digest('hex').slice(0, 16);
  return path.join(runtimeDataDir, 'embed-cache', hash);
}

/** `key = sha256(text).slice(0,16)` — dùng để nhận diện chunk không đổi giữa
 *  hai lần build (incremental: tái dùng vector cũ, chỉ embed chunk mới). */
function chunkKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function readCache(dir: string): Promise<{ meta: CacheMeta; vectors: Float32Array } | null> {
  try {
    const metaRaw = await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw) as CacheMeta;
    const vecRaw = await fs.promises.readFile(path.join(dir, 'vectors.bin'));
    if (vecRaw.byteLength % 4 !== 0) return null;
    const vectors = new Float32Array(vecRaw.buffer, vecRaw.byteOffset, vecRaw.byteLength / 4);
    if (meta.dim <= 0 || vectors.length !== meta.entries.length * meta.dim) return null;
    return { meta, vectors };
  } catch {
    return null;
  }
}

/** Ghi atomic (tmp + rename) cả `meta.json` lẫn `vectors.bin`. */
async function writeCacheAtomic(dir: string, meta: CacheMeta, vectors: Float32Array): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const metaTmp = path.join(dir, `.meta.json.tmp-${suffix}`);
  const vecTmp = path.join(dir, `.vectors.bin.tmp-${suffix}`);
  await fs.promises.writeFile(metaTmp, JSON.stringify(meta), 'utf8');
  await fs.promises.writeFile(vecTmp, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  await fs.promises.rename(metaTmp, path.join(dir, 'meta.json'));
  await fs.promises.rename(vecTmp, path.join(dir, 'vectors.bin'));
}

// ---------------------------------------------------------------------------
// 1.5 — API của module
// ---------------------------------------------------------------------------

export interface BuildDocsEmbedIndexResult {
  chunks: number;
  embedded: number;
  reused: number;
  ms: number;
}

/** Build/refresh cache vector cho `rootDir` (`docs-feature/` hoặc
 *  `docs-app/`). No-op (trả `{chunks:0,...}`, không ném lỗi) khi `rootDir`
 *  không tồn tại hoặc backend Ollama không sẵn sàng. Incremental: chunk có
 *  `key` (sha256 nội dung) trùng cache cũ → tái dùng vector; đổi
 *  `OD_EMBED_MODEL` → bỏ cache, build lại toàn bộ. */
/** Build đang chạy dở, theo thư mục cache. Kickoff bắn build nền và ngay sau
 *  đó agent gọi search (search tự build lazy khi thiếu cache) — không có chốt
 *  này thì cùng một root bị embed hai lần (~3 phút CPU phí) và hai bên cùng
 *  ghi đè cache. Chỉ trong-tiến-trình: đủ vì mọi lối vào đều qua daemon. */
const inflightBuilds = new Map<string, Promise<BuildDocsEmbedIndexResult>>();

export function buildDocsEmbedIndex(
  rootDir: string,
  opts: { runtimeDataDir: string },
): Promise<BuildDocsEmbedIndexResult> {
  const key = cacheDirFor(rootDir, opts.runtimeDataDir);
  const running = inflightBuilds.get(key);
  if (running) return running;
  const started = buildDocsEmbedIndexUncoordinated(rootDir, opts).finally(() => {
    inflightBuilds.delete(key);
  });
  inflightBuilds.set(key, started);
  return started;
}

async function buildDocsEmbedIndexUncoordinated(
  rootDir: string,
  opts: { runtimeDataDir: string },
): Promise<BuildDocsEmbedIndexResult> {
  const startedAtMs = Date.now();
  const exists = await fs.promises.stat(rootDir).then((s) => s.isDirectory(), () => false);
  if (!exists) return { chunks: 0, embedded: 0, reused: 0, ms: Date.now() - startedAtMs };

  const available = await probeEmbedBackend();
  if (!available) return { chunks: 0, embedded: 0, reused: 0, ms: Date.now() - startedAtMs };

  const sections = await collectDocsSections(rootDir);
  const chunks = sections.flatMap(chunkSection);
  if (chunks.length === 0) return { chunks: 0, embedded: 0, reused: 0, ms: Date.now() - startedAtMs };

  const model = embedModel();
  const dir = cacheDirFor(rootDir, opts.runtimeDataDir);
  const existingCache = await readCache(dir);
  // Đổi model → cache cũ không tin được nữa, coi như không có (build lại
  // toàn bộ chunk). Cùng cơ chế phủ luôn trường hợp đổi `dim` (dim của
  // Ollama là hàm của tên model — đổi model là đường duy nhất đổi dim).
  const canReuse = existingCache !== null && existingCache.meta.model === model;
  const oldByKey = new Map<string, number>();
  if (canReuse) existingCache!.meta.entries.forEach((e, i) => oldByKey.set(e.key, i));

  const keys = chunks.map((c) => chunkKey(c.text));
  const toEmbedIdx: number[] = [];
  keys.forEach((key, i) => {
    if (!oldByKey.has(key)) toEmbedIdx.push(i);
  });

  let dim = canReuse ? existingCache!.meta.dim : 0;
  const newVectorByChunkIdx = new Map<number, Float32Array>();
  if (toEmbedIdx.length > 0) {
    const texts = toEmbedIdx.map((i) => chunks[i]!.text);
    const vectors = await embedAllNormalized(texts);
    dim = vectors[0]?.length ?? dim;
    toEmbedIdx.forEach((chunkIdx, i) => newVectorByChunkIdx.set(chunkIdx, vectors[i]!));
  }

  const entries: CacheEntry[] = [];
  const fullVectors = new Float32Array(chunks.length * dim);
  let embedded = 0;
  let reused = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const key = keys[i]!;
    entries.push({ key, rel: chunk.rel, line: chunk.line, crumb: chunk.crumb, kind: chunk.kind });
    const reusedIdx = oldByKey.get(key);
    if (reusedIdx !== undefined) {
      fullVectors.set(existingCache!.vectors.subarray(reusedIdx * dim, reusedIdx * dim + dim), i * dim);
      reused += 1;
    } else {
      const fresh = newVectorByChunkIdx.get(i)!;
      fullVectors.set(fresh, i * dim);
      embedded += 1;
    }
  }

  await writeCacheAtomic(dir, { model, dim, rootDir: path.resolve(rootDir), entries }, fullVectors);
  return { chunks: chunks.length, embedded, reused, ms: Date.now() - startedAtMs };
}

export interface DocsSearchHit {
  rel: string;
  line: number;
  crumb: string;
  score: number;
  kind: 'head' | 'window';
  root: string;
}

/** Embed `query`, cosine (= dot product, vector đã L2-normalize) với mọi
 *  vector của mọi `root`. Dedupe: cùng `rel` + cùng `Math.floor(line/40)` (mỗi
 *  root riêng — không gộp feature với app) chỉ giữ điểm cao nhất. Cache của
 *  một root thiếu (hoặc lệch model) → tự build trước (lazy). Ném
 *  `EmbedUnavailableError` khi backend không sẵn sàng. */
export async function searchDocsEmbed(
  roots: string[],
  query: string,
  opts: { runtimeDataDir: string; limit?: number },
): Promise<DocsSearchHit[]> {
  const limit = opts.limit ?? 8;
  const available = await probeEmbedBackend();
  if (!available) throw new EmbedUnavailableError();

  const model = embedModel();
  const caches: Array<{ root: string; meta: CacheMeta; vectors: Float32Array }> = [];
  for (const root of roots) {
    const dir = cacheDirFor(root, opts.runtimeDataDir);
    let cached = await readCache(dir);
    if (!cached || cached.meta.model !== model) {
      await buildDocsEmbedIndex(root, { runtimeDataDir: opts.runtimeDataDir });
      cached = await readCache(dir);
    }
    if (cached) caches.push({ root, meta: cached.meta, vectors: cached.vectors });
  }
  if (caches.length === 0) return [];

  const [queryVecRaw] = await embedBatch([query]);
  if (!queryVecRaw) throw new EmbedUnavailableError('Ollama không trả embedding cho câu truy vấn');
  const queryVec = l2Normalize(queryVecRaw);

  const allHits: DocsSearchHit[] = [];
  for (const { root, meta, vectors } of caches) {
    const dim = meta.dim;
    for (let i = 0; i < meta.entries.length; i += 1) {
      const entry = meta.entries[i]!;
      const offset = i * dim;
      let dot = 0;
      for (let d = 0; d < dim; d += 1) dot += vectors[offset + d]! * queryVec[d]!;
      allHits.push({ rel: entry.rel, line: entry.line, crumb: entry.crumb, score: dot, kind: entry.kind, root });
    }
  }

  const bestByBucket = new Map<string, DocsSearchHit>();
  for (const hit of allHits) {
    const bucketKey = `${hit.root}::${hit.rel}::${Math.floor(hit.line / 40)}`;
    const existing = bestByBucket.get(bucketKey);
    if (!existing || hit.score > existing.score) bestByBucket.set(bucketKey, hit);
  }
  return [...bestByBucket.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
