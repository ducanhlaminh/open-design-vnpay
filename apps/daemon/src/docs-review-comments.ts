// Bình luận CẤP BƯỚC của workflow docs-review (wp-docs-review-confirm-v2,
// 2026-08-28): một file JSON mỗi stage tại
// `<workflowRoot>/comments/<stageId>.json` (= DocsReviewStageCommentsFile).
//
// Vì sao đặt ở `comments/` — NGOÀI `outputs` của mọi stage (pipelines.ts):
// re-run một stage / run-all clear-on-launch xoá theo `def.outputs` qua
// `relClearedByRegen`/`relClearedByRunAllLaunch` (stagesForOutput) — thư mục
// này không khớp pattern nào nên sống sót, giống `screens-overrides.json` và
// `selection.json` (bất biến WP14). KHÔNG ghi `.odhistory` (như comment
// redline của dr-review). Ghi atomic tmp+rename để một lần ghi đứt nửa chừng
// không để lại file JSON hỏng.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DocsReviewStageComment,
  DocsReviewStageCommentsFile,
  DocsReviewStageId,
} from '@open-design/contracts';
import { getWorkflow } from './pipelines.js';

export const DOCS_REVIEW_COMMENTS_DIR = 'comments';
export const DOCS_REVIEW_COMMENT_MAX_LENGTH = 4000;

/** Lỗi có mã HTTP để route trả đúng 400/404 mà không phải đoán từ message. */
export class DocsReviewCommentError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = 'DocsReviewCommentError';
  }
}

/** Các stage nhận comment = ĐÚNG `pipelineIds` của workflow docs-review
 *  (không hard-code — thêm/bớt stage thì registry là nguồn duy nhất). */
export function docsReviewStageIds(): DocsReviewStageId[] {
  return [...(getWorkflow('docs-review')?.pipelineIds ?? [])] as DocsReviewStageId[];
}

export function isDocsReviewStageId(value: unknown): value is DocsReviewStageId {
  return typeof value === 'string' && docsReviewStageIds().includes(value as DocsReviewStageId);
}

export function docsReviewCommentsPath(workflowRoot: string, stageId: DocsReviewStageId): string {
  return path.join(workflowRoot, DOCS_REVIEW_COMMENTS_DIR, `${stageId}.json`);
}

function parseTarget(raw: unknown): DocsReviewStageComment['target'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.kind !== 'screen' && v.kind !== 'flow' && v.kind !== 'page') return undefined;
  if (typeof v.key !== 'string' || !v.key.trim()) return undefined;
  return {
    kind: v.kind,
    key: v.key,
    ...(typeof v.label === 'string' && v.label.trim() ? { label: v.label } : {}),
  };
}

/** Đọc KHOAN DUNG: file thiếu / JSON hỏng / entry sai shape → bỏ riêng entry
 *  đó, không làm hỏng cả stage. `stageId` của entry luôn ép về stage của file
 *  (tên file là nguồn sự thật, không tin field bên trong). */
export function parseDocsReviewStageCommentsFile(raw: string, stageId: DocsReviewStageId): DocsReviewStageComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { comments?: unknown }).comments)
      ? (parsed as { comments: unknown[] }).comments
      : [];
  const out: DocsReviewStageComment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id.trim()) continue;
    if (typeof v.text !== 'string' || !v.text.trim()) continue;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
    const target = parseTarget(v.target);
    out.push({
      id: v.id,
      stageId,
      text: v.text,
      by: typeof v.by === 'string' && v.by.trim() ? v.by : 'unknown',
      at: v.at,
      ...(target ? { target } : {}),
    });
  }
  return out;
}

export async function readDocsReviewStageComments(workflowRoot: string, stageId: DocsReviewStageId): Promise<DocsReviewStageComment[]> {
  const raw = await fs.readFile(docsReviewCommentsPath(workflowRoot, stageId), 'utf8').catch(() => null);
  return raw == null ? [] : parseDocsReviewStageCommentsFile(raw, stageId);
}

/** Toàn bộ comment của workflow, theo thứ tự stage của registry. Stage không
 *  có file → mảng rỗng (luôn đủ key để report v2 không thiếu stage). */
export async function readAllDocsReviewStageComments(workflowRoot: string): Promise<Record<DocsReviewStageId, DocsReviewStageComment[]>> {
  const out = {} as Record<DocsReviewStageId, DocsReviewStageComment[]>;
  for (const stageId of docsReviewStageIds()) out[stageId] = await readDocsReviewStageComments(workflowRoot, stageId);
  return out;
}

async function writeDocsReviewStageComments(workflowRoot: string, stageId: DocsReviewStageId, comments: DocsReviewStageComment[]): Promise<void> {
  const target = docsReviewCommentsPath(workflowRoot, stageId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const doc: DocsReviewStageCommentsFile = { schemaVersion: 1, comments };
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => null);
    throw error;
  }
}

export async function addDocsReviewStageComment(
  workflowRoot: string,
  stageId: string,
  input: { text: unknown; target?: unknown; by: string; now?: number; id?: string },
): Promise<DocsReviewStageComment> {
  if (!isDocsReviewStageId(stageId)) throw new DocsReviewCommentError(404, `Bước "${stageId}" không thuộc workflow docs-review`);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new DocsReviewCommentError(400, 'text là bắt buộc (không được rỗng)');
  if (text.length > DOCS_REVIEW_COMMENT_MAX_LENGTH) {
    throw new DocsReviewCommentError(400, `text quá dài (${text.length} > ${DOCS_REVIEW_COMMENT_MAX_LENGTH} ký tự)`);
  }
  if (input.target !== undefined && input.target !== null && !parseTarget(input.target)) {
    throw new DocsReviewCommentError(400, 'target phải có kind ∈ screen|flow|page và key không rỗng');
  }
  const target = parseTarget(input.target);
  const comment: DocsReviewStageComment = {
    id: input.id ?? randomUUID(),
    stageId,
    text,
    by: input.by.trim() || 'unknown',
    at: input.now ?? Date.now(),
    ...(target ? { target } : {}),
  };
  const existing = await readDocsReviewStageComments(workflowRoot, stageId);
  await writeDocsReviewStageComments(workflowRoot, stageId, [...existing, comment]);
  return comment;
}

/** `true` khi đã xoá; `false` khi không có comment đó (route → 404). */
export async function deleteDocsReviewStageComment(workflowRoot: string, stageId: string, commentId: string): Promise<boolean> {
  if (!isDocsReviewStageId(stageId)) throw new DocsReviewCommentError(404, `Bước "${stageId}" không thuộc workflow docs-review`);
  const existing = await readDocsReviewStageComments(workflowRoot, stageId);
  const next = existing.filter((c) => c.id !== commentId);
  if (next.length === existing.length) return false;
  await writeDocsReviewStageComments(workflowRoot, stageId, next);
  return true;
}
