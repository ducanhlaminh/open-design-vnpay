'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppPoolPage, AppPoolResponse } from '@open-design/contracts';

import { ProgressBar } from './ProgressBar';
import styles from './DistillModal.module.css';

interface DistillModalProps {
  appId: string;
  onClose: () => void;
  onFinished?: () => void;
}

type BranchStatus = 'clean' | 'running' | 'waiting' | 'error';

export interface BranchSummary {
  name: string;
  pages: AppPoolPage[];
  status: BranchStatus;
}

function poolUrl(appId: string): string {
  return `/api/pipelines/apps/${encodeURIComponent(appId)}/pool`;
}

function distillUrl(appId: string): string {
  return `/api/pipelines/apps/${encodeURIComponent(appId)}/distill`;
}

/** Pool còn việc cho job distill: trang chưa chưng cất, HOẶC mọi nhánh sạch
 *  nhưng thiếu `_overview.md` (reduce từng fail) — daemon nhận POST ở cả hai
 *  ca (reduce-only run). */
export function needsDistill(pool: AppPoolResponse): boolean {
  return pool.distill.pending > 0 || (!pool.overviewExists && pool.pages.length > 0);
}

function isPageClean(page: AppPoolPage): boolean {
  return page.distill.state === 'distilled' && page.distill.distilledHash === page.contentHash;
}

export function branchSummaries(pages: AppPoolPage[]): BranchSummary[] {
  const grouped = new Map<string, AppPoolPage[]>();
  for (const page of pages) {
    const branch = page.branch || 'Khác';
    const branchPages = grouped.get(branch) ?? [];
    branchPages.push(page);
    grouped.set(branch, branchPages);
  }

  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, branchPages]) => {
    const clean = branchPages.every(isPageClean);
    const active = branchPages.some((page) => page.distill.state === 'distilling');
    return {
      name,
      pages: branchPages,
      status: clean ? 'clean' : active ? 'running' : 'waiting',
    };
  });
}

function statusLabel(status: BranchStatus, running: boolean): string {
  if (status === 'clean') return 'Đã chưng cất';
  if (status === 'running') return 'Đang chưng cất';
  return running ? 'Chờ' : 'Lỗi';
}

export function DistillModal({ appId, onClose, onFinished }: DistillModalProps) {
  const [pool, setPool] = useState<AppPoolResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [autoStarted, setAutoStarted] = useState(false);
  const observedRunRef = useRef(false);
  const finishedRef = useRef(false);

  const startDistill = useCallback(async () => {
    setStarting(true);
    setLoadError(null);
    try {
      const response = await fetch(distillUrl(appId), { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Không thể chưng cất tài liệu (${response.status}).`);
      }
      observedRunRef.current = true;
      setAutoStarted(true);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Không thể chưng cất tài liệu.');
    } finally {
      setStarting(false);
    }
  }, [appId]);

  const loadPool = useCallback(async (): Promise<AppPoolResponse | null> => {
    try {
      const response = await fetch(poolUrl(appId));
      if (!response.ok) throw new Error(`Không thể tải tài liệu App (${response.status}).`);
      const nextPool = (await response.json()) as AppPoolResponse;
      setPool(nextPool);
      setLoadError(null);
      if (nextPool.distill.running) observedRunRef.current = true;
      if (!nextPool.distill.running && needsDistill(nextPool) && !observedRunRef.current) {
        await startDistill();
      }
      return nextPool;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Không thể tải tài liệu App.');
      return null;
    }
  }, [appId, startDistill]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      if (cancelled) return;
      const nextPool = await loadPool();
      if (cancelled) return;
      if (nextPool?.distill.running) timer = window.setTimeout(poll, 1500);
    };

    // The first request is intentionally separate from the state-driven poll:
    // it decides whether this modal should auto-start a pending pool.
    void (async () => {
      const firstPool = await loadPool();
      if (!cancelled && firstPool && (firstPool.distill.running || needsDistill(firstPool))) {
        timer = window.setTimeout(poll, 1500);
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [appId, loadPool, startDistill]);

  const branches = useMemo(() => branchSummaries(pool?.pages ?? []), [pool?.pages]);
  const allBranchesClean = branches.length > 0 && branches.every((branch) => branch.status === 'clean');
  const running = pool?.distill.running ?? false;
  const progress = pool?.distill.progress;
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const displayRunning = running || (autoStarted && !progress?.error && !allBranchesClean);
  const overviewStatus = allBranchesClean && !running && pool?.overviewExists
    ? 'Xong'
    : allBranchesClean && running
      ? 'Đang'
      : !running && !allBranchesClean
        ? 'Bỏ qua/Lỗi'
        : 'Chờ';
  const canRetry = !running && pool !== null && needsDistill(pool);

  useEffect(() => {
    if (!pool || running || !allBranchesClean || !observedRunRef.current || finishedRef.current) return;
    finishedRef.current = true;
    onFinished?.();
  }, [allBranchesClean, onFinished, pool, running]);

  return (
    <div className={styles.overlay} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="distill-modal-title">
        <header className={styles.header}>
          <div>
            <h2 id="distill-modal-title" className={styles.title}>Chưng cất tài liệu App</h2>
            <p className={styles.subtitle}>{pool ? `${pool.pages.length} trang / ${branches.length} nhánh` : 'Đang tải trạng thái…'}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Đóng">×</button>
        </header>

        {progress ? (
          <ProgressBar
            label={`Đang chưng cất… ${progress.done}/${progress.total} phần`}
            percent={percent}
          />
        ) : null}
        {loadError ? <p className={styles.error}>{loadError}</p> : null}
        {progress?.error ? (
          <div className={styles.errorBanner} role="alert">
            <p className={styles.errorText}>{progress.error}</p>
            {canRetry ? <button type="button" className={styles.secondaryButton} onClick={() => void startDistill()} disabled={starting}>Thử lại</button> : null}
          </div>
        ) : null}
        {pool && !needsDistill(pool) && !running ? <p className={styles.ready}>Pool đã chưng cất đủ</p> : null}

        <div className={styles.list}>
          {branches.map((branch) => (
            <div className={styles.row} key={branch.name}>
              <div className={styles.rowName}>
                <strong>{branch.name}</strong>
                <span>{branch.pages.length} trang</span>
              </div>
              <span className={`${styles.badge} ${styles[branch.status]}`}>
                {branch.status === 'running' ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {statusLabel(branch.status, displayRunning)}
              </span>
            </div>
          ))}
          {pool ? (
            <div className={styles.row}>
              <div className={styles.rowName}><strong>Tổng hợp _overview.md</strong></div>
              <span className={`${styles.badge} ${styles.overviewBadge}`}>{overviewStatus}</span>
            </div>
          ) : null}
        </div>

        <footer className={styles.footer}>
          <p className={styles.note}>Đóng cửa sổ không dừng tiến trình.</p>
          {pool && !running && !needsDistill(pool) ? <button type="button" className={styles.secondaryButton} onClick={onClose}>Đóng</button> : null}
        </footer>
      </section>
    </div>
  );
}
