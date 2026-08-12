// ── Hộp thoại xác nhận xóa (dùng chung App / Feature) ────────────────────────
// Không có trường nhập nào: người gọi truyền sẵn tiêu đề + đoạn giải thích
// PHẠM VI xóa. Phần "xóa cái gì, KHÔNG xóa cái gì" là thông tin quan trọng
// nhất ở đây — cả App lẫn Feature đều không chạm tới dữ liệu trên Pipeline
// Studio, và người dùng phải đọc được điều đó TRƯỚC khi bấm.
//
// Lỗi từ server hiện nguyên văn ngay trong hộp thoại và KHÔNG đóng nó, để
// người dùng còn đọc được lý do và thử lại. Bản remote không thuộc phạm vi của
// thao tác này; caller phải mô tả rõ đây là xóa dữ liệu trên máy.

import { useState } from 'react';

import {
  DangerButton,
  FormError,
  FormText,
  FormWarning,
  PipelineFormModal,
  QuietButton,
} from './PipelineFormModal';

export function ConfirmDeleteModal({
  title,
  body,
  warning,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  warning?: string | null;
  confirmLabel: string;
  /** Ném lỗi để hiện thông báo và giữ hộp thoại mở. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PipelineFormModal
      title={title}
      icon="trash"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <QuietButton onClick={onClose} disabled={busy}>
            Hủy
          </QuietButton>
          <DangerButton icon="trash" busy={busy} onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Đang xóa…' : confirmLabel}
          </DangerButton>
        </>
      }
    >
      <FormText>{body}</FormText>
      {warning ? <FormWarning>{warning}</FormWarning> : null}
      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
