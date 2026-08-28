// DocsReviewConfirmModal — bước chặn trước "Xác nhận hoàn tất" của workflow
// docs-review (wp-docs-review-confirm-v2, Executor J3). Liệt kê các bước
// (tên · trạng thái · số bình luận) và bắt tick "Tôi đã xem hết kết quả các
// bước" rồi mới POST `/docs-review/confirm` (body y như trước: sourceRunId
// của dr-review nếu có). Sau 201 modal chuyển sang trạng thái "đã gửi" với nút
// "Mở báo cáo" — điều hướng NỘI BỘ tới `/feedback/docs-review/<projectId>/
// <confirmationId>` (route do EntryShell/router xử lý; ở đây chỉ pushState +
// popstate như FeedbackHub đẩy `/feedback?project=`).
import { useState } from 'react';
import type { ConfirmDocsReviewRequest, ConfirmDocsReviewResponse } from '@open-design/contracts';
import { PlModal } from '../pipelines/PlModal';

export interface DocsReviewConfirmStage {
  id: string;
  name: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Chưa chạy',
  queued: 'Đang chờ',
  running: 'Đang chạy',
  succeeded: 'Hoàn thành',
  failed: 'Lỗi',
  canceled: 'Đã hủy',
};

export function docsReviewReportPath(projectId: string, confirmationId: string): string {
  return `/feedback/docs-review/${encodeURIComponent(projectId)}/${encodeURIComponent(confirmationId)}`;
}

export function DocsReviewConfirmModal({
  projectId,
  stages,
  commentCounts,
  sourceRunId,
  onClose,
  onConfirmed,
}: {
  projectId: string;
  stages: DocsReviewConfirmStage[];
  commentCounts: Record<string, number>;
  sourceRunId?: string;
  onClose: () => void;
  /** Gọi sau 201 — cha hiện toast + tải lại trạng thái. Modal vẫn mở để
   *  người dùng bấm "Mở báo cáo" hoặc "Đóng". */
  onConfirmed: (body: ConfirmDocsReviewResponse) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmDocsReviewResponse | null>(null);

  async function confirm() {
    if (!checked || busy || result) return;
    setBusy(true);
    setError(null);
    try {
      const request: ConfirmDocsReviewRequest = { ...(sourceRunId ? { sourceRunId } : {}) };
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs-review/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<ConfirmDocsReviewResponse> & { error?: string };
      if (!response.ok) throw new Error(body.error || `confirm failed: ${response.status}`);
      const ok = body as ConfirmDocsReviewResponse;
      setResult(ok);
      onConfirmed(ok);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể xác nhận hoàn tất.');
    } finally {
      setBusy(false);
    }
  }

  function openReport() {
    const confirmationId = result?.artifact?.confirmationId;
    if (!confirmationId) return;
    window.history.pushState(null, '', docsReviewReportPath(projectId, confirmationId));
    window.dispatchEvent(new PopStateEvent('popstate'));
    onClose();
  }

  const totalComments = stages.reduce((sum, s) => sum + (commentCounts[s.id] ?? 0), 0);

  return (
    <PlModal
      title={result ? 'Đã xác nhận hoàn tất' : 'Xác nhận hoàn tất Review tài liệu'}
      icon="check"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        result ? (
          <>
            <button type="button" className="pl-btn" onClick={onClose} data-testid="docs-review-confirm-close">
              Đóng
            </button>
            {result.artifact?.confirmationId ? (
              <button type="button" className="pl-btn pl-btn--primary" onClick={openReport} data-testid="docs-review-open-report">
                Mở báo cáo
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
              Huỷ
            </button>
            <button
              type="button"
              className="pl-btn pl-btn--primary"
              data-testid="docs-review-confirm-submit"
              disabled={!checked || busy}
              onClick={() => void confirm()}
              title={checked ? 'Gửi toàn bộ kết quả 5 bước + bình luận lên studio' : 'Tick "Tôi đã xem hết kết quả các bước" trước'}
            >
              {busy ? 'Đang xác nhận…' : 'Xác nhận hoàn tất'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="pl-docs-confirm" data-testid="docs-review-confirm-done">
          <p>
            Đã gửi kết quả review lên studio
            {result.artifact?.summary ? ` — ${result.artifact.summary.agentProposals} đề xuất của agent, ${result.artifact.summary.humanEdits} chỉnh sửa, ${result.artifact.summary.comments} bình luận.` : '.'}
          </p>
          {result.artifact?.confirmationId ? (
            <p className="pl-docs-confirm__hint">
              Mã xác nhận: <code>{result.artifact.confirmationId}</code>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="pl-docs-confirm">
          <p className="pl-docs-confirm__hint">
            Xác nhận sẽ gửi TOÀN BỘ kết quả các bước (output, bình luận, số liệu) lên Pipeline Studio làm
            báo cáo. Kiểm tra lại từng bước trước khi gửi.
          </p>
          <ul className="pl-docs-confirm__stages" data-testid="docs-review-confirm-stages">
            {stages.map((s) => {
              const n = commentCounts[s.id] ?? 0;
              return (
                <li key={s.id} className="pl-docs-confirm__stage" data-stage-id={s.id}>
                  <span className="pl-docs-confirm__name">{s.name}</span>
                  <span className={`pl-status pl-status--${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  <span className="pl-docs-confirm__comments" title={n > 0 ? `${n} bình luận` : 'Chưa có bình luận'}>
                    <span aria-hidden="true">💬</span> {n}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pl-docs-confirm__hint">
            Tổng {totalComments} bình luận cấp bước sẽ được gửi kèm.
          </p>
          <label className="pl-runall-toggle">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(ev) => setChecked(ev.target.checked)}
              data-testid="docs-review-confirm-ack"
            />
            <span className="pl-runall-toggle__body">
              <span className="pl-runall-toggle__title">Tôi đã xem hết kết quả các bước</span>
              <span className="pl-runall-toggle__desc">
                Bắt buộc — đề xuất của agent chưa xem sẽ được tính là "giữ nguyên" trong báo cáo.
              </span>
            </span>
          </label>
          {error ? <p className="pl-modal-error" role="alert">{error}</p> : null}
        </div>
      )}
    </PlModal>
  );
}
