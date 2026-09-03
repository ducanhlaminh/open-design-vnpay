// DocsReviewConfirmStatus — chip trạng thái "Đã xác nhận hoàn tất" + nút
// "Thu hồi xác nhận" cạnh nút "Xác nhận hoàn tất" của workflow docs-review
// (wp-docs-review-confirm-revoke). Nguồn: GET /docs-review/confirm/state
// (biên nhận local); thu hồi = POST /docs-review/confirm/revoke — marker
// append-only, báo cáo cũ vẫn giữ trên trang Phản hồi (audit), người dùng bổ
// sung bình luận rồi bấm "Xác nhận hoàn tất" lại như thường.
import { useEffect, useState } from 'react';
import type { DocsReviewConfirmationState, RevokeDocsReviewConfirmationResponse } from '@open-design/contracts';
import styles from './DocsReviewConfirmStatus.module.css';

export const DOCS_REVIEW_REVOKE_CONFIRM_MESSAGE =
  'Thu hồi bản xác nhận hoàn tất? Tính năng sẽ trở lại trạng thái chưa hoàn tất trên trang Phản hồi; bạn có thể bình luận thêm rồi xác nhận lại.';

function formatDateTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('vi-VN') : '—';
}

export function DocsReviewConfirmStatus({
  projectId,
  reloadToken = 0,
  onRevoked,
  onRevokeError,
}: {
  projectId: string;
  /** Cha tăng số này (vd. sau khi xác nhận thành công) → chip tự tải lại. */
  reloadToken?: number;
  /** Gọi sau khi POST revoke thành công — cha hiện toast/refresh thêm nếu cần. */
  onRevoked?: (body: RevokeDocsReviewConfirmationResponse) => void;
  onRevokeError?: (message: string) => void;
}) {
  const [latest, setLatest] = useState<DocsReviewConfirmationState['latest']>(null);
  const [gen, setGen] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setLatest(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/confirm/state`);
        if (!res.ok) throw new Error(`state failed: ${res.status}`);
        const body = (await res.json()) as Partial<DocsReviewConfirmationState>;
        if (!cancelled) setLatest(body.latest ?? null);
      } catch {
        // Chip là tiện ích trạng thái — lỗi thì ẩn, không chặn màn Pipelines.
        if (!cancelled) setLatest(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken, gen]);

  async function revoke() {
    if (busy || !latest || latest.revoked) return;
    if (!window.confirm(DOCS_REVIEW_REVOKE_CONFIRM_MESSAGE)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/confirm/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<RevokeDocsReviewConfirmationResponse> & { error?: string };
      if (!res.ok || body.ok !== true) throw new Error(body.error || `revoke failed: ${res.status}`);
      setGen((n) => n + 1);
      onRevoked?.(body as RevokeDocsReviewConfirmationResponse);
    } catch (cause) {
      onRevokeError?.(cause instanceof Error ? cause.message : 'Không thể thu hồi xác nhận.');
    } finally {
      setBusy(false);
    }
  }

  if (!latest) return null;
  if (latest.revoked) {
    return (
      <span
        className={styles.chip}
        data-state="revoked"
        data-testid="pipeline-docs-review-confirm-state"
        title={`Mã xác nhận: ${latest.confirmationId}${latest.revoked.user ? ` · thu hồi bởi ${latest.revoked.user}` : ''}`}
      >
        Đã thu hồi xác nhận · {formatDateTime(latest.revoked.revokedAt)}
      </span>
    );
  }
  return (
    <span className={styles.wrap}>
      <span
        className={styles.chip}
        data-state="confirmed"
        data-testid="pipeline-docs-review-confirm-state"
        title={`Mã xác nhận: ${latest.confirmationId}`}
      >
        Đã xác nhận hoàn tất · {formatDateTime(latest.confirmedAt)}
      </span>
      <button
        type="button"
        className="pl-btn"
        data-testid="pipeline-docs-review-revoke"
        disabled={busy}
        onClick={() => void revoke()}
        title="Thu hồi để bổ sung bình luận rồi xác nhận lại — báo cáo đã gửi vẫn giữ trên trang Phản hồi (audit)"
      >
        {busy ? 'Đang thu hồi…' : 'Thu hồi xác nhận'}
      </button>
    </span>
  );
}
