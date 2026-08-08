'use client';

// Percent progress bar, extracted from AppPoolSection's distill-progress UI
// so the same visual (and now the same batched-import progress) shows up
// wherever an App-pool operation reports real x/y progress: AppPoolSection
// (distill), ConfluenceTreeImport (batched self-import), NewAppModal
// (creation-flow import phase).

import styles from './ProgressBar.module.css';

export interface ProgressBarProps {
  /** Full status line, e.g. "Đang chưng cất tài liệu… 3/10 trang (30%)". */
  label: string;
  /** 0-100; values outside that range are clamped. */
  percent: number;
}

export function ProgressBar({ label, percent }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={styles.wrap}>
      <p className={styles.label}>{label}</p>
      <div className={styles.bar} role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <div className={styles.fill} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
