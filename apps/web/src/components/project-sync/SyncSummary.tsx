import type { ProjectSyncSummary } from '@open-design/contracts';

import { SyncStateBadge } from './SyncStateBadge';
import styles from './ProjectSyncPreview.module.css';

export function SyncSummary({ summary, label = 'Tổng quan thay đổi' }: { summary: ProjectSyncSummary; label?: string }) {
  return (
    <section className={styles.summary} aria-label={label}>
      <span className={styles.summaryLabel}>{label}</span>
      <div className={styles.summaryItems}>
        <span><SyncStateBadge state="new" /><b>{summary.created}</b></span>
        <span><SyncStateBadge state="unchanged" /><b>{summary.unchanged}</b></span>
        <span><SyncStateBadge state="changed" /><b>{summary.changed}</b></span>
        <span><SyncStateBadge state="deleted" /><b>{summary.deleted}</b></span>
      </div>
    </section>
  );
}
