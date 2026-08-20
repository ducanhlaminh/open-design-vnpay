'use client';

// AppImportBanner — WP22b. Modal Tạo App không còn chờ import (đóng ngay sau
// start-job — xem NewAppModal.tsx); người dùng theo dõi tiến độ ở đây thay,
// mount tại đầu màn App (PipelinesFeaturesView) và trên cây pool
// (AppPoolSection). Tự ẩn khi `useAppImportJob` không có job nào của appId
// (chưa từng chạy import, hoặc job đã bị dismiss).

import { useEffect, useRef, useState } from 'react';

import { useAppImportJob } from '../../providers/app-import-jobs';
import { ProgressBar } from './ProgressBar';
import styles from './AppImportBanner.module.css';

export interface AppImportBannerProps {
  appId: string;
  /** Gọi ĐÚNG MỘT LẦN khi job chuyển từ 'running' sang một trạng thái kết
   *  thúc trong khi banner đang mở (để caller refetch pool). KHÔNG gọi khi
   *  banner mount và job đã kết thúc sẵn — caller đã tự fetch dữ liệu mới
   *  nhất lúc mount, refetch thêm ở đây là thừa. */
  onFinished?: () => void;
}

export function AppImportBanner({ appId, onFinished }: AppImportBannerProps) {
  const { job, cancel, dismiss } = useAppImportJob(appId);
  const wasRunningRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (job?.status === 'running') {
      wasRunningRef.current = true;
      return;
    }
    if (wasRunningRef.current && job) {
      wasRunningRef.current = false;
      onFinished?.();
    }
  }, [job, onFinished]);

  if (!job) return null;

  const percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  if (job.status === 'running') {
    return (
      <div className={styles.banner} data-testid="app-import-banner">
        <ProgressBar label={`Đang nhập tài liệu ${job.done}/${job.total} (${percent}%)`} percent={percent} />
        <button
          type="button"
          className={styles.stopButton}
          data-testid="app-import-banner-stop"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            void cancel().finally(() => setCancelling(false));
          }}
        >
          Dừng
        </button>
      </div>
    );
  }

  if (job.status === 'succeeded') {
    return (
      <div className={styles.banner} data-testid="app-import-banner">
        <p className={styles.message}>
          Đã nhập xong {job.imported + job.updated} trang ({job.imported} mới, {job.updated} cập nhật).
        </p>
        <button type="button" className={styles.dismissButton} data-testid="app-import-banner-dismiss" onClick={dismiss} aria-label="Đóng">
          Đóng
        </button>
      </div>
    );
  }

  if (job.status === 'failed') {
    return (
      <div className={styles.banner} data-testid="app-import-banner">
        <p className={styles.error}>
          {job.error ?? 'Nhập tài liệu thất bại.'} — đã vào {job.done}/{job.total} trang.
        </p>
        <button type="button" className={styles.dismissButton} data-testid="app-import-banner-dismiss" onClick={dismiss} aria-label="Đóng">
          Đóng
        </button>
      </div>
    );
  }

  // cancelled
  return (
    <div className={styles.banner} data-testid="app-import-banner">
      <p className={styles.message}>Đã dừng — đã vào {job.done}/{job.total} trang.</p>
      <button type="button" className={styles.dismissButton} data-testid="app-import-banner-dismiss" onClick={dismiss} aria-label="Đóng">
        Đóng
      </button>
    </div>
  );
}
