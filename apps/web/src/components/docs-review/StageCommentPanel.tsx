// StageCommentPanel — bình luận CẤP BƯỚC của workflow docs-review (wp-docs-
// review-confirm-v2, Executor J). Một cột phải gập được cắm vào từng viewer
// kết quả (MarkdownViewer trang docs, FlowUxReviewPreview, MockupsPreview,
// DocRedlinePreview) — người duyệt ghi nhận xét cho cả bước hoặc neo vào MỘT
// mục (màn / luồng / trang) qua `target`.
//
// Dữ liệu sống ở daemon (`docs-review/comments/<stageId>.json`, ngoài outputs
// nên re-run không xoá) qua 3 route:
//   GET    /api/projects/:id/docs-review/comments/:stageId            → { stageId, comments }
//   POST   /api/projects/:id/docs-review/comments/:stageId { text, target? } → 201 { comment }
//   DELETE /api/projects/:id/docs-review/comments/:stageId/:commentId → 204
// Không optimistic: POST/DELETE xong thì tải lại danh sách — `by`/`at`/`id`
// do daemon quyết, web không đoán trước.
//
// KHÔNG thay bình luận per-annotation của DocRedlinePreview (field `comments`
// trong sidecar .changes.json/.notes.json) — hai tầng khác nhau: annotation là
// hội thoại trên MỘT chỗ sửa, panel này là nhận xét cho cả trang/bước.
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type {
  CreateDocsReviewStageCommentRequest,
  CreateDocsReviewStageCommentResponse,
  DocsReviewStageComment,
  DocsReviewStageCommentsResponse,
  DocsReviewStageId,
} from '@open-design/contracts';
import styles from './StageCommentPanel.module.css';

export type StageCommentTarget = NonNullable<DocsReviewStageComment['target']>;

/** 5 bước của docs-review có bình luận cấp bước — cùng thứ tự workflow. */
export const DOCS_REVIEW_STAGE_IDS: readonly DocsReviewStageId[] = ['dr-docs', 'dr-flow', 'dr-flow-improve', 'dr-mockup', 'dr-review'];

export function isDocsReviewStageId(id: string): id is DocsReviewStageId {
  return (DOCS_REVIEW_STAGE_IDS as readonly string[]).includes(id);
}

/** Trang tài liệu của bước dr-docs: `docs-review/docs/**.md` (ingest thường)
 *  hoặc `docs-review/docs-feature/**.md` (dự án App-pool). `docs-app/` (pool
 *  chung của App) và `review/docs*` (trang redline của dr-review) KHÔNG thuộc
 *  đây. */
export function isDocsReviewDocsPage(name: string): boolean {
  return /^docs-review\/(docs|docs-feature)\/.+\.md$/i.test(name);
}

export function stageCommentsUrl(projectId: string, stageId: DocsReviewStageId, commentId?: string): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/docs-review/comments/${encodeURIComponent(stageId)}`;
  return commentId ? `${base}/${encodeURIComponent(commentId)}` : base;
}

/** Đọc danh sách bình luận của một bước. Ném lỗi khi daemon trả không-OK;
 *  body thiếu `comments` (route chưa có / stub) → mảng rỗng. */
export async function fetchStageComments(projectId: string, stageId: DocsReviewStageId): Promise<DocsReviewStageComment[]> {
  const response = await fetch(stageCommentsUrl(projectId, stageId));
  if (!response.ok) throw new Error(`Không tải được bình luận (${response.status})`);
  const body = (await response.json().catch(() => null)) as Partial<DocsReviewStageCommentsResponse> | null;
  return Array.isArray(body?.comments) ? body.comments : [];
}

/** Số bình luận mỗi bước (badge trên stepper + modal xác nhận). Bước nào lỗi
 *  → 0, không làm hỏng các bước khác. */
export async function fetchDocsReviewCommentCounts(projectId: string): Promise<Record<DocsReviewStageId, number>> {
  const entries = await Promise.all(
    DOCS_REVIEW_STAGE_IDS.map(async (stageId) => {
      try {
        return [stageId, (await fetchStageComments(projectId, stageId)).length] as const;
      } catch {
        return [stageId, 0] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<DocsReviewStageId, number>;
}

function sameTarget(a: StageCommentTarget | undefined, b: StageCommentTarget): boolean {
  return !!a && a.kind === b.kind && a.key === b.key;
}

function formatAt(at: number): string {
  try {
    return new Date(at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  } catch {
    return String(at);
  }
}

const TARGET_KIND_LABEL: Record<StageCommentTarget['kind'], string> = { screen: 'Màn', flow: 'Luồng', page: 'Trang' };

export function StageCommentPanel({
  projectId,
  stageId,
  target,
  collapsedByDefault = false,
}: {
  projectId: string;
  stageId: DocsReviewStageId;
  /** Mục đang xem (màn / luồng / trang). Có → bình luận mới neo vào mục này và
   *  danh sách mặc định lọc theo mục (toggle "Chỉ mục này / Tất cả bước"). */
  target?: StageCommentTarget;
  collapsedByDefault?: boolean;
}) {
  const [comments, setComments] = useState<DocsReviewStageComment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const [scope, setScope] = useState<'target' | 'all'>('target');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await fetchStageComments(projectId, stageId);
      setComments(next);
      setLoadError(null);
    } catch (cause) {
      setComments((prev) => prev ?? []);
      setLoadError(cause instanceof Error ? cause.message : 'Không tải được bình luận');
    }
  }, [projectId, stageId]);

  useEffect(() => {
    let cancelled = false;
    setComments(null);
    setLoadError(null);
    setConfirmDeleteId(null);
    void (async () => {
      try {
        const next = await fetchStageComments(projectId, stageId);
        if (!cancelled) { setComments(next); setLoadError(null); }
      } catch (cause) {
        if (!cancelled) {
          setComments([]);
          setLoadError(cause instanceof Error ? cause.message : 'Không tải được bình luận');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, stageId]);

  // Đổi mục đang xem (bấm màn khác trong rail) → quay về lọc theo mục mới.
  useEffect(() => { setScope('target'); setConfirmDeleteId(null); }, [target?.kind, target?.key]);

  const filterByTarget = !!target && scope === 'target';
  const all = comments ?? [];
  const visible = filterByTarget ? all.filter((c) => sameTarget(c.target, target)) : all;
  const attachTarget = filterByTarget ? target : undefined;

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const body: CreateDocsReviewStageCommentRequest = { text: trimmed, ...(attachTarget ? { target: attachTarget } : {}) };
      const response = await fetch(stageCommentsUrl(projectId, stageId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Không gửi được bình luận (${response.status})`);
      }
      // Response 201 `{ comment }` chỉ để xác nhận — danh sách lấy lại từ GET.
      void (response.json().catch(() => null) as Promise<CreateDocsReviewStageCommentResponse | null>);
      setText('');
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Không gửi được bình luận');
    } finally {
      setBusy(false);
    }
  }

  async function remove(commentId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(stageCommentsUrl(projectId, stageId, commentId), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Không xoá được bình luận (${response.status})`);
      }
      setConfirmDeleteId(null);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Không xoá được bình luận');
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void submit();
    }
  }

  const count = visible.length;
  const dataAttrs = {
    'data-testid': 'stage-comment-panel',
    'data-stage-id': stageId,
    ...(target ? { 'data-target-kind': target.kind, 'data-target-key': target.key } : {}),
  };

  if (collapsed) {
    return (
      <aside className={`${styles.panel} ${styles.panelCollapsed}`} aria-label="Bình luận bước" {...dataAttrs} data-collapsed="true">
        <button
          type="button"
          className={styles.toggle}
          aria-label={`Hiện bình luận (${count})`}
          title="Hiện bình luận"
          onClick={() => setCollapsed(false)}
        >
          <span aria-hidden="true">💬</span>
          <span className={styles.toggleCount}>{count}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Bình luận bước" {...dataAttrs} data-collapsed="false">
      <div className={styles.head}>
        <span className={styles.title}>Bình luận ({count})</span>
        <button
          type="button"
          className={styles.toggle}
          aria-label="Ẩn bình luận"
          title="Ẩn bình luận"
          onClick={() => setCollapsed(true)}
        >
          ]
        </button>
      </div>
      {target ? (
        <div className={styles.scopeBar} role="group" aria-label="Phạm vi bình luận">
          <button
            type="button"
            className={`${styles.scopeBtn} ${scope === 'target' ? styles.scopeBtnActive : ''}`}
            aria-pressed={scope === 'target'}
            onClick={() => setScope('target')}
            title={`Chỉ bình luận neo vào ${TARGET_KIND_LABEL[target.kind].toLowerCase()} "${target.label ?? target.key}"`}
          >
            Chỉ mục này
          </button>
          <button
            type="button"
            className={`${styles.scopeBtn} ${scope === 'all' ? styles.scopeBtnActive : ''}`}
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
            title="Mọi bình luận của bước, kể cả bình luận neo vào mục khác"
          >
            Tất cả bước
          </button>
        </div>
      ) : null}
      <div className={styles.body}>
        {comments === null ? (
          <p className={styles.muted}>Đang tải…</p>
        ) : loadError ? (
          <p className={styles.error} role="alert">{loadError}</p>
        ) : visible.length === 0 ? (
          <p className={styles.muted}>
            {filterByTarget ? 'Chưa có bình luận cho mục này.' : 'Chưa có bình luận cho bước này.'}
          </p>
        ) : (
          <ul className={styles.list}>
            {visible.map((c) => (
              <li key={c.id} className={styles.item} data-testid="stage-comment-item">
                <div className={styles.meta}>
                  <span className={styles.by}>{c.by || 'Ẩn danh'}</span>
                  <span className={styles.dot} aria-hidden="true">·</span>
                  <span className={styles.at}>{formatAt(c.at)}</span>
                  {c.target && !filterByTarget ? (
                    <span className={styles.chip} title={`${TARGET_KIND_LABEL[c.target.kind]}: ${c.target.key}`}>
                      {c.target.label ?? c.target.key}
                    </span>
                  ) : null}
                  {confirmDeleteId === c.id ? (
                    <span className={styles.confirm}>
                      <span>Xoá?</span>
                      <button type="button" className={styles.confirmYes} disabled={busy} onClick={() => void remove(c.id)}>
                        Xoá
                      </button>
                      <button type="button" className={styles.confirmNo} disabled={busy} onClick={() => setConfirmDeleteId(null)}>
                        Huỷ
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.delete}
                      aria-label="Xoá bình luận"
                      title="Xoá bình luận"
                      disabled={busy}
                      onClick={() => setConfirmDeleteId(c.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
                <p className={styles.text}>{c.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.composer}>
        <textarea
          className={styles.input}
          aria-label="Bình luận mới cho bước"
          placeholder={attachTarget ? `Bình luận về ${TARGET_KIND_LABEL[attachTarget.kind].toLowerCase()} "${attachTarget.label ?? attachTarget.key}"…` : 'Bình luận cho cả bước…'}
          value={text}
          disabled={busy}
          rows={3}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <div className={styles.composerRow}>
          <span className={styles.hint}>Cmd/Ctrl+Enter để gửi</span>
          <button
            type="button"
            className={styles.send}
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Đang gửi…' : 'Gửi'}
          </button>
        </div>
        {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      </div>
    </aside>
  );
}
