import { useEffect, useId, useRef, useState } from 'react';
import type {
  ProjectSyncChange,
  ProjectSyncScopeStatus,
  ProjectSyncStatusReason,
  ProjectSyncUserStatus,
} from '@open-design/contracts';

import { Icon, type IconName } from '../Icon';
import styles from './SyncStatusBadge.module.css';

interface StatusPresentation {
  label: string;
  description: string;
  icon: IconName;
}

export const PROJECT_SYNC_STATUS_COPY: Record<ProjectSyncUserStatus, StatusPresentation> = {
  up_to_date: {
    label: 'Đã cập nhật',
    description: 'Bản trên máy và bản trong kho chung đang giống nhau.',
    icon: 'check',
  },
  update_available: {
    label: 'Có bản mới',
    description: 'Kho chung có nội dung mới. Chọn “Cập nhật” để lấy về máy.',
    icon: 'download',
  },
  not_shared: {
    label: 'Chưa chia sẻ',
    description: 'Nội dung này mới chỉ có trên máy. Chọn “Chia sẻ” để lưu vào kho chung.',
    icon: 'upload',
  },
  needs_review: {
    label: 'Cần kiểm tra',
    description: 'Bản trên máy và kho chung đều đã thay đổi. Hãy xem lại trước khi tiếp tục.',
    icon: 'help-circle',
  },
  incomplete: {
    label: 'Cập nhật chưa xong',
    description: 'Một số nội dung chưa được tải về đầy đủ. Chọn “Thử lại” để hoàn tất.',
    icon: 'refresh',
  },
  unavailable: {
    label: 'Chưa kiểm tra được',
    description: 'Hiện chưa thể kiểm tra kho chung. Nội dung trên máy vẫn dùng được.',
    icon: 'info',
  },
  origin_missing: {
    label: 'Không còn trên kho',
    description: 'Bản đã liên kết không còn trong kho chung. Nội dung trên máy vẫn được giữ nguyên.',
    icon: 'eye-off',
  },
};

export interface SyncStatusBadgeProps {
  status: ProjectSyncUserStatus;
  /** Kept on the element for diagnostics without exposing technical copy to users. */
  reason?: ProjectSyncStatusReason;
  /** Allows the containing App/Feature button to reference the tooltip. */
  tooltipId?: string;
}

type StatusLike = Pick<ProjectSyncScopeStatus, 'mappingValid' | 'origin' | 'error'> & {
  status?: ProjectSyncUserStatus;
  reason?: ProjectSyncStatusReason;
  state?: ProjectSyncChange;
};

/** One-release compatibility for a daemon that still returns the old `state`.
 * Even there, file-level `deleted` is deliberately presented as review—not as
 * a deleted App/Feature. */
export function projectSyncUserStatusOf(value: StatusLike): ProjectSyncUserStatus {
  if (value.status && value.status in PROJECT_SYNC_STATUS_COPY) return value.status;
  if (value.reason === 'origin_missing_or_hidden' || value.origin?.visibility === 'hidden') return 'origin_missing';
  if (value.error) return 'unavailable';
  if (!value.mappingValid || value.state === 'new') return 'not_shared';
  if (value.state === 'unchanged') return 'up_to_date';
  return 'needs_review';
}

/**
 * Human-facing App/Feature status. This is intentionally separate from
 * SyncStateBadge: new/changed/deleted describe individual files in a preview,
 * never the health of a whole App or Feature.
 */
export function SyncStatusBadge({ status, reason, tooltipId: tooltipIdProp }: SyncStatusBadgeProps) {
  const generatedTooltipId = useId();
  const tooltipId = tooltipIdProp ?? generatedTooltipId;
  const [touchOpen, setTouchOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const copy = PROJECT_SYNC_STATUS_COPY[status];

  useEffect(() => {
    if (!touchOpen) return undefined;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setTouchOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTouchOpen(false);
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [touchOpen]);

  return (
    <span
      ref={rootRef}
      className={styles.root}
      data-status={status}
      data-reason={reason}
      data-touch-open={touchOpen ? 'true' : undefined}
      onClick={(event) => event.stopPropagation()}
      onPointerUp={(event) => {
        if (event.pointerType === 'touch') setTouchOpen((open) => !open);
      }}
    >
      <span className={styles.badge}>
        <Icon name={copy.icon} size={11} strokeWidth={2} />
        {copy.label}
      </span>
      <span id={tooltipId} role="tooltip" className={styles.tooltip}>
        {copy.description}
      </span>
    </span>
  );
}
