// `docs-tracing.ts` — nhật ký truy vấn `/api/docs/search` cho docs-review
// (WP: Truy vết tra cứu — Câu hỏi / Trả lời / Dẫn chứng). Lấp lỗ hổng: đo
// thật lúc 15:17 agent hỏi 8 câu, mở đọc 3 tài liệu chỉ tìm ra nhờ search —
// nhưng `screens.json` không ghi một dòng nguồn nào. Người review không có
// cách nào biết agent đã hỏi gì / căn cứ vào đâu.
//
// Hai file NGOÀI outputs của stage (daemon-owned, giống `comments/`,
// `confirmation/` — sống sót re-run clear, không đẩy lên project-sync khi
// còn thử nghiệm — xem WALK_SKIP_DIRS trong project-sync-routes.ts):
//   `<workflowRoot>/tracing/<stageId>.json`          — daemon tự ghi (Gói A)
//   `<workflowRoot>/tracing/<stageId>.answers.json`  — agent tự khai (Gói C)

import fs from 'node:fs';
import path from 'node:path';

/** Tối đa số truy vấn giữ lại cho MỖI stage — một run "hỏi loạn" (agent lặp
 *  vòng lặp/bug) không được phép làm phình nhật ký vô hạn. */
const MAX_QUERIES_PER_STAGE = 200;

export interface DocsTracingResultRef {
  path: string;
  line: number;
  crumb: string;
  score: number;
  scope: 'feature' | 'app';
}

export interface DocsTracingQueryEntry {
  at: string;
  query: string;
  scope: 'feature' | 'app' | 'both';
  limit: number;
  results: DocsTracingResultRef[];
}

export interface DocsTracingQueryLog {
  stageId: string;
  runId: string;
  startedAt: string;
  queries: DocsTracingQueryEntry[];
  truncated?: boolean;
}

export interface DocsTracingAnswerEntry {
  question: string;
  answer: string;
  citations: string[];
  usedFor?: string;
}

export interface DocsTracingAnswersFile {
  answers: DocsTracingAnswerEntry[];
}

/** stageId + workflowRoot cho MỘT run đang chạy — điền tại đúng chỗ kickoff
 *  docs-review đã có (server.ts, xem docblock `runTracingRegistry` phía
 *  dưới), để route `/api/docs/search` (chỉ có `grant.runId`) tra ra nơi ghi.
 *  Trong-tiến-trình: đủ vì mọi request tool đều qua daemon đang chạy. */
export interface DocsTracingRunInfo {
  workflowRoot: string;
  stageId: string;
}

/** Registry runId → {workflowRoot, stageId}, trong-tiến-trình (không persist
 *  — daemon restart giữa chừng một run là ca hiếm, mất nhật ký truy vấn
 *  KHÔNG mất dữ liệu, chỉ mất khả năng truy vết; chấp nhận được).
 *
 *  Không có timer TTL: mỗi run gọi `clear(runId)` ngay khi `design.runs.wait`
 *  trả về (cả nhánh single-run trong `runPipeline` lẫn từng page-run trong
 *  `runDocsReviewFanout`) — xem 2 điểm gọi trong server.ts. Một runId không
 *  bao giờ được tái sử dụng (design.runs.create luôn cấp UUID mới) nên
 *  `set()` ghi đè là vô hại kể cả khi `clear()` bị bỏ lỡ ở một nhánh lỗi nào
 *  đó (leak nhỏ, không tăng theo thời gian chạy dài — chỉ theo số run). */
class RunTracingRegistry {
  readonly #byRunId = new Map<string, DocsTracingRunInfo>();

  set(runId: string, info: DocsTracingRunInfo): void {
    this.#byRunId.set(runId, info);
  }

  get(runId: string): DocsTracingRunInfo | null {
    return this.#byRunId.get(runId) ?? null;
  }

  clear(runId: string): void {
    this.#byRunId.delete(runId);
  }

  /** Test-only: số entry đang giữ. */
  size(): number {
    return this.#byRunId.size;
  }
}

export const runTracingRegistry = new RunTracingRegistry();

function tracingDir(workflowRoot: string): string {
  return path.join(workflowRoot, 'tracing');
}

function queryLogPath(workflowRoot: string, stageId: string): string {
  return path.join(tracingDir(workflowRoot), `${stageId}.json`);
}

function answersPath(workflowRoot: string, stageId: string): string {
  return path.join(tracingDir(workflowRoot), `${stageId}.answers.json`);
}

/** Ghi atomic (tmp + rename) — cùng khuôn với docs-section-index.ts /
 *  docs-embed-index.ts. */
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, target);
}

async function readJsonTolerant<T>(target: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(target, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    // Thiếu file (chưa hỏi câu nào / chưa khai trả lời) hoặc JSON hỏng (ghi
    // dở khi crash) — cùng một xử lý: coi như không có, KHÔNG làm sập route.
    return null;
  }
}

// Đo thật: route được gọi fire-and-forget (không await ở docs-embed-routes.ts
// — không được làm chậm response tìm kiếm), nên 2 truy vấn liên tiếp của
// cùng một run/stage (agent hỏi dồn dập, có lượt cách nhau <50ms) có thể
// CHỒNG LẤN đọc-sửa-ghi trên CÙNG file: request 2 đọc file TRƯỚC KHI request
// 1 ghi xong → request 2 ghi đè, mất câu của request 1 (mất update kinh
// điển). Hàng đợi theo `target` path tuần tự hoá MỌI lượt ghi/xoá vào CÙNG
// file — mỗi lượt chỉ bắt đầu sau khi lượt trước xong — mà KHÔNG buộc route
// phải `await` (route vẫn trả response ngay). Bắt được bằng harness thật (3
// truy vấn liên tiếp, request 2-3 chỉ 30-50ms) TRƯỚC khi thêm hàng đợi này —
// không phải suy đoán.
const writeQueueByTarget = new Map<string, Promise<void>>();

function enqueueWrite(target: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueueByTarget.get(target) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeQueueByTarget.set(target, next);
  // Dọn entry khi đây là lượt CUỐI đang xếp hàng cho target này — tránh Map
  // phình theo số lượt ghi của một run dài (tránh leak, không ảnh hưởng thứ
  // tự vì mỗi lượt mới luôn chain từ giá trị ĐANG có trong map lúc nó gọi).
  void next.finally(() => {
    if (writeQueueByTarget.get(target) === next) writeQueueByTarget.delete(target);
  });
  return next;
}

/** Xoá nhật ký truy vấn CŨ khi kickoff lại một stage — mỗi lần chạy là một
 *  nhật ký mới (đúng luật re-run của docs-review: agent regenerate thay vì
 *  thấy leftover). Đi qua CÙNG hàng đợi với `recordDocsTracingQuery`: một
 *  request `/api/docs/search` mồ côi của lượt chạy TRƯỚC (fire-and-forget,
 *  chưa kịp ghi xong khi stage mới kickoff) không được phép ghi ĐÈ LÊN sau
 *  khi đã xoá — xoá phải là thao tác CUỐI trong hàng đợi tại thời điểm gọi.
 *  KHÔNG xoá `<stageId>.answers.json` ở đây: file đó do agent của LƯỢT CHẠY
 *  MỚI ghi lại toàn bộ (ghi đè, không append) nên tự nhiên hết hạn cùng lúc.
 *  Best-effort: lỗi (quyền, đĩa) không được chặn kickoff. */
export async function clearDocsTracingLog(workflowRoot: string, stageId: string): Promise<void> {
  const target = queryLogPath(workflowRoot, stageId);
  await enqueueWrite(target, () => fs.promises.rm(target, { force: true }).catch(() => {}));
}

/** Ghi một lượt truy vấn — gọi từ `POST /api/docs/search` mỗi khi phục vụ
 *  200. Best-effort TUYỆT ĐỐI: never throws, never rejects — một lỗi ghi
 *  nhật ký không được phép làm hỏng response tìm kiếm thật của agent. */
export async function recordDocsTracingQuery(opts: {
  runId: string;
  query: string;
  scope: 'feature' | 'app' | 'both';
  limit: number;
  results: DocsTracingResultRef[];
}): Promise<void> {
  const info = runTracingRegistry.get(opts.runId);
  // Run không đăng ký (chat thường gọi cùng route, hoặc kickoff chưa kịp
  // set trước request đầu tiên) → không biết ghi vào đâu, bỏ qua im lặng.
  if (!info) return;
  const target = queryLogPath(info.workflowRoot, info.stageId);
  await enqueueWrite(target, async () => {
    try {
      const existing = await readJsonTolerant<DocsTracingQueryLog>(target);
      const now = new Date().toISOString();
      const log: DocsTracingQueryLog = existing ?? {
        stageId: info.stageId,
        runId: opts.runId,
        startedAt: now,
        queries: [],
      };
      if (log.queries.length >= MAX_QUERIES_PER_STAGE) {
        log.truncated = true;
        await writeJsonAtomic(target, log).catch(() => {});
        return;
      }
      log.queries.push({
        at: now,
        query: opts.query,
        scope: opts.scope,
        limit: opts.limit,
        results: opts.results,
      });
      await writeJsonAtomic(target, log);
    } catch (error) {
      console.warn('[docs-tracing] ghi nhật ký truy vấn thất bại (bỏ qua):', error);
    }
  });
}

// ---------------------------------------------------------------------------
// Đọc + ghép cho card UI (Gói B) — `GET /api/projects/:id/docs-review/tracing`
// ---------------------------------------------------------------------------

/** Chuẩn hoá câu hỏi để ghép: trim + gộp khoảng trắng liên tiếp — agent chép
 *  lại câu hỏi vào answers.json có thể lệch một khoảng trắng thừa/thiếu so
 *  với chuỗi daemon đã ghi nguyên văn. */
function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

export interface DocsTracingItem {
  question: string;
  answer: string | null;
  usedFor?: string;
  citations: string[];
  results: DocsTracingResultRef[];
  /** Answer khai trong answers.json nhưng KHÔNG khớp câu hỏi nào trong nhật
   *  ký truy vấn — vẫn trả về (không bỏ, agent có thể đã diễn đạt lại) nhưng
   *  đánh dấu để UI/người đọc biết đây là mục lệch. */
  orphan?: boolean;
}

export interface DocsTracingStagePayload {
  stageId: string;
  startedAt: string;
  truncated?: boolean;
  items: DocsTracingItem[];
}

/** Ghép nhật ký truy vấn (A) với answers agent khai (C) theo `question` đã
 *  chuẩn hoá. Câu hỏi có log mà không có answer → `answer: null` (UI hiện
 *  "agent chưa ghi trả lời"). Answer thừa không khớp câu nào → nối cuối,
 *  `orphan: true`. */
export function mergeDocsTracingPayload(
  log: DocsTracingQueryLog,
  answersFile: DocsTracingAnswersFile | null,
): DocsTracingItem[] {
  const answers = answersFile?.answers ?? [];
  const answerByQuestion = new Map<string, DocsTracingAnswerEntry>();
  for (const a of answers) {
    if (typeof a?.question !== 'string') continue;
    // Answer trùng câu hỏi (agent ghi lặp) — giữ bản CUỐI (ghi đè), agent
    // thường sửa lại kết luận khi đọc thêm nguồn.
    answerByQuestion.set(normalizeQuestion(a.question), a);
  }
  const matched = new Set<string>();
  const items: DocsTracingItem[] = log.queries.map((q) => {
    const key = normalizeQuestion(q.query);
    const a = answerByQuestion.get(key);
    if (a) matched.add(key);
    return {
      question: q.query,
      answer: a?.answer ?? null,
      ...(a?.usedFor ? { usedFor: a.usedFor } : {}),
      citations: a?.citations ?? [],
      results: q.results,
    };
  });
  for (const a of answers) {
    if (typeof a?.question !== 'string') continue;
    const key = normalizeQuestion(a.question);
    if (matched.has(key)) continue;
    items.push({
      question: a.question,
      answer: a.answer ?? null,
      ...(a.usedFor ? { usedFor: a.usedFor } : {}),
      citations: Array.isArray(a.citations) ? a.citations : [],
      results: [],
      orphan: true,
    });
  }
  return items;
}

/** Liệt kê MỌI stage đã có nhật ký dưới `<workflowRoot>/tracing/`, ghép A+C,
 *  sắp theo `startedAt` (bước chạy trước lên trước). Thư mục thiếu (chưa
 *  stage nào từng gọi search) → mảng rỗng, KHÔNG lỗi. */
export async function listDocsTracingStages(workflowRoot: string): Promise<DocsTracingStagePayload[]> {
  const dir = tracingDir(workflowRoot);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const stageIds = names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.answers.json'))
    .map((n) => n.slice(0, -'.json'.length));
  const out: DocsTracingStagePayload[] = [];
  for (const stageId of stageIds) {
    const log = await readJsonTolerant<DocsTracingQueryLog>(queryLogPath(workflowRoot, stageId));
    if (!log) continue;
    const answersFile = await readJsonTolerant<DocsTracingAnswersFile>(answersPath(workflowRoot, stageId));
    out.push({
      stageId,
      startedAt: log.startedAt,
      ...(log.truncated ? { truncated: true } : {}),
      items: mergeDocsTracingPayload(log, answersFile),
    });
  }
  out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return out;
}
