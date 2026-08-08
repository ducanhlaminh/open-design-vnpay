'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './AppPoolSection.module.css';

type DistillState = 'fetched' | 'stale' | 'distilling' | 'distilled';

interface PoolPage {
  pageId: string;
  path: string;
  title: string;
  branch: string;
  contentHash: string;
  fetchedAt: number;
  distill: {
    state: DistillState;
    distilledHash: string | null;
  };
}

interface PoolResponse {
  pages: PoolPage[];
  distill: {
    clean: boolean;
    pending: number;
    running: boolean;
    progress?: { done: number; total: number };
  };
  overviewExists: boolean;
}

interface AppPoolSectionProps {
  appId: string;
}

const STATE_LABELS: Record<DistillState, string> = {
  fetched: 'Đã tải',
  stale: 'Cần chưng cất lại',
  distilling: 'Đang chưng cất',
  distilled: 'Đã chưng cất',
};

function poolUrl(appId: string): string {
  return `/api/pipelines/apps/${encodeURIComponent(appId)}/pool`;
}

export function AppPoolSection({ appId }: AppPoolSectionProps) {
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPool = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(poolUrl(appId));
      if (!response.ok) throw new Error(`Không thể tải tài liệu App (${response.status}).`);
      const nextPool = (await response.json()) as PoolResponse;
      setPool(nextPool);
      setError(null);
      setDistilling(nextPool.distill.running);
    } catch (cause) {
      if (!background || pool === null) {
        setError(cause instanceof Error ? cause.message : 'Không thể tải tài liệu App.');
      }
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    setPool(null);
    void loadPool();
  }, [appId, loadPool]);

  useEffect(() => {
    if (!distilling) return undefined;
    const interval = window.setInterval(() => void loadPool(true), 3000);
    return () => window.clearInterval(interval);
  }, [distilling, loadPool]);

  const groups = useMemo(() => {
    const grouped = new Map<string, PoolPage[]>();
    for (const page of pool?.pages ?? []) {
      const branch = page.path.split('/')[0] || 'Tài liệu gốc';
      const pages = grouped.get(branch) ?? [];
      pages.push(page);
      grouped.set(branch, pages);
    }
    return [...grouped.entries()];
  }, [pool]);

  const startDistill = async () => {
    setError(null);
    try {
      const response = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/distill`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Không thể chưng cất tài liệu (${response.status}).`);
      }
      setDistilling(true);
      await loadPool(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể chưng cất tài liệu.');
    }
  };

  if (loading) return <section className={styles.section}><p className={styles.muted}>Đang tải tài liệu App…</p></section>;
  if (error && !pool) return <section className={styles.section}><p className={styles.error}>{error}</p><button className={styles.secondaryButton} onClick={() => void loadPool()}>Thử lại</button></section>;
  if (!pool || pool.pages.length === 0) return <section className={styles.section}><div className={styles.header}><div><h2 className={styles.heading}>Tài liệu App</h2><p className={styles.muted}>Chưa có tài liệu trong pool.</p></div></div>{error ? <p className={styles.error}>{error}</p> : null}</section>;

  const progress = pool.distill.progress;
  const isRunning = distilling || pool.distill.running;

  return (
    <section className={styles.section} aria-label="Tài liệu App">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Tài liệu App</h2>
          <p className={styles.muted}>{pool.pages.length} trang{refreshing ? ' · đang cập nhật…' : ''}</p>
        </div>
        <button className={styles.primaryButton} onClick={() => void startDistill()} disabled={isRunning || pool.distill.pending === 0}>
          Chưng cất tài liệu
          {pool.distill.pending > 0 ? <span className={styles.count}>{pool.distill.pending}</span> : null}
        </button>
      </div>
      {isRunning && progress ? <p className={styles.progress}>Tiến độ: {progress.done}/{progress.total}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.tree}>
        {groups.map(([branch, pages]) => (
          <div className={styles.group} key={branch}>
            <h3 className={styles.groupTitle}>{branch}</h3>
            <div className={styles.pages}>
              {pages.map((page) => (
                <div className={styles.page} key={page.pageId}>
                  <div className={styles.pageCopy}><strong className={styles.pageTitle}>{page.title}</strong><span className={styles.path}>{page.path}</span></div>
                  <span className={`${styles.badge} ${styles[page.distill.state]}`}>{STATE_LABELS[page.distill.state]}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
