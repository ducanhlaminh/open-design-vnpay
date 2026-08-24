'use client';

import type { KeyboardEvent } from 'react';
import styles from './DocRedlineNavigation.module.css';

export type DocRedlineNavigationMode = 'changes' | 'notes';

export interface DocRedlineNavigationProps {
  mode: DocRedlineNavigationMode;
  /** Vị trí 1-based; null khi chưa chọn item. */
  current: number | null;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
}

export function DocRedlineNavigation({
  mode,
  current,
  total,
  onPrevious,
  onNext,
  className,
}: DocRedlineNavigationProps) {
  const noun = mode === 'changes' ? 'Thay đổi' : 'Nhận xét';
  const disabled = total <= 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onPrevious();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onNext();
    }
  };

  return (
    <nav
      className={[styles.root, className].filter(Boolean).join(' ')}
      aria-label={`Điều hướng ${noun.toLocaleLowerCase('vi')}`}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <span className={styles.legend} aria-label={`Chú giải ${noun.toLocaleLowerCase('vi')}`}>
        {mode === 'changes' ? '1…N' : 'N1…Nk'}
      </span>
      <span className={styles.position} aria-live="polite" aria-atomic="true">
        {current == null ? '—' : current} / {total}
      </span>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onPrevious} disabled={disabled} aria-label={`${noun} trước`}>
          <span aria-hidden="true">←</span>
          <span>Trước</span>
        </button>
        <button type="button" className={styles.button} onClick={onNext} disabled={disabled} aria-label={`${noun} sau`}>
          <span>Sau</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </nav>
  );
}
