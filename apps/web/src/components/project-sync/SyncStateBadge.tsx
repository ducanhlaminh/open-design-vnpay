import type { ProjectSyncChange } from '@open-design/contracts';

import styles from './ProjectSyncPreview.module.css';

export const PROJECT_SYNC_STATE_COPY: Record<ProjectSyncChange, string> = {
  new: 'Tạo mới',
  unchanged: 'Không thay đổi',
  changed: 'Có thay đổi',
  deleted: 'Đã xóa',
};

export function SyncStateBadge({ state }: { state: ProjectSyncChange }) {
  return <span className={styles.stateBadge} data-state={state}>{PROJECT_SYNC_STATE_COPY[state]}</span>;
}
