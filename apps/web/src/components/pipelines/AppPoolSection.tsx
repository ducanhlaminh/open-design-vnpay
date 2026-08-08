'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppPoolPage, AppPoolResponse } from '@open-design/contracts';

import { Icon } from '../Icon';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { fetchProjectFileText } from '../../providers/registry';
import { AppPoolTree } from './AppPoolTree';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ConfluenceTreeImport } from './ConfluenceTreeImport';
import styles from './AppPoolSection.module.css';

function poolUrl(appId: string): string {
  return `/api/pipelines/apps/${encodeURIComponent(appId)}/pool`;
}

interface AppPoolSectionProps {
  appId: string;
  /** Suppresses the "Nhập tài liệu từ Confluence" toggle + picker — the
   *  NewAppModal post-create screen already has its OWN picker (the
   *  pre-create form) and doesn't want a second import entry point right
   *  under the just-shown result; additional imports still belong in the
   *  Sửa App screen, which renders this section with the default (visible). */
  hideImport?: boolean;
}

export function AppPoolSection({ appId, hideImport }: AppPoolSectionProps) {
  const [pool, setPool] = useState<AppPoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<AppPoolPage | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewHtml, setOverviewHtml] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const loadPool = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(poolUrl(appId));
      if (!response.ok) throw new Error(`Không thể tải tài liệu App (${response.status}).`);
      const nextPool = (await response.json()) as AppPoolResponse;
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
    setOverviewOpen(false);
    setOverviewHtml(null);
    void loadPool();
  }, [appId, loadPool]);

  useEffect(() => {
    if (!distilling) return undefined;
    const interval = window.setInterval(() => void loadPool(true), 3000);
    return () => window.clearInterval(interval);
  }, [distilling, loadPool]);

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

  const deletePage = async (page: AppPoolPage) => {
    const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/pool/pages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageIds: [page.pageId] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || `Xóa trang thất bại (${res.status}).`);
    await loadPool(true);
  };

  const openOverview = () => {
    setOverviewOpen((open) => !open);
    if (overviewOpen || overviewHtml !== null) return;
    setOverviewLoading(true);
    setOverviewError(null);
    void (async () => {
      try {
        const text = await fetchProjectFileText(appId, 'docs/_overview.md');
        if (text === null) throw new Error('Không đọc được _overview.md.');
        setOverviewHtml(renderMarkdownToSafeHtml(text));
      } catch (cause) {
        setOverviewError(cause instanceof Error ? cause.message : 'Không đọc được _overview.md.');
      } finally {
        setOverviewLoading(false);
      }
    })();
  };

  if (loading) return <section className={styles.section}><p className={styles.muted}>Đang tải tài liệu App…</p></section>;
  if (error && !pool) return <section className={styles.section}><p className={styles.error}>{error}</p><button className={styles.secondaryButton} onClick={() => void loadPool()}>Thử lại</button></section>;
  if (!pool) return null;

  const progress = pool.distill.progress;
  const isRunning = distilling || pool.distill.running;

  return (
    <section className={styles.section} aria-label="Tài liệu App">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Tài liệu App</h2>
          <p className={styles.muted}>
            {pool.pages.length > 0 ? `${pool.pages.length} trang` : 'Chưa có tài liệu trong pool.'}
            {refreshing ? ' · đang cập nhật…' : ''}
          </p>
        </div>
        <div className={styles.headerActions}>
          {pool.overviewExists ? (
            <button type="button" className={styles.secondaryButton} onClick={openOverview}>
              <Icon name="eye" size={13} />
              {overviewOpen ? 'Ẩn tổng quan' : 'Xem tổng quan'}
            </button>
          ) : null}
          {pool.pages.length > 0 ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void startDistill()}
              disabled={isRunning || pool.distill.pending === 0}
            >
              Chưng cất tài liệu
              {pool.distill.pending > 0 ? <span className={styles.count}>{pool.distill.pending}</span> : null}
            </button>
          ) : null}
        </div>
      </div>
      {isRunning && progress ? <p className={styles.progress}>Tiến độ: {progress.done}/{progress.total}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {overviewOpen ? (
        <div className={styles.overviewPanel}>
          {overviewLoading ? (
            <p className={styles.muted}>Đang tải _overview.md…</p>
          ) : overviewError ? (
            <p className={styles.error}>{overviewError}</p>
          ) : overviewHtml ? (
            // eslint-disable-next-line react/no-danger -- renderMarkdownToSafeHtml escapes raw HTML by contract.
            <div className={`${styles.overviewBody} markdown-rendered`} dangerouslySetInnerHTML={{ __html: overviewHtml }} />
          ) : null}
        </div>
      ) : null}

      {pool.pages.length > 0 ? (
        <AppPoolTree
          pages={pool.pages}
          renderLeafActions={(page) => (
            <button
              type="button"
              className={styles.deleteButton}
              onClick={() => setDeleting(page)}
              aria-label={`Xóa trang ${page.title}`}
              title="Xóa trang"
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        />
      ) : null}

      {!hideImport ? (
        <div className={styles.importSection}>
          <button type="button" className={styles.linkButton} onClick={() => setImportOpen((open) => !open)}>
            <Icon name="import" size={13} />
            {importOpen ? 'Ẩn nhập tài liệu' : 'Nhập tài liệu từ Confluence'}
          </button>
          {importOpen ? (
            <ConfluenceTreeImport
              appId={appId}
              onImported={() => {
                setImportOpen(false);
                void loadPool(true);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {deleting ? (
        <ConfirmDeleteModal
          title={`Xóa trang "${deleting.title}"?`}
          body="Xóa khỏi pool tài liệu App trên máy này. Chưng cất trước đó (nếu có) có thể lệch cho tới lần chưng cất lại kế tiếp."
          confirmLabel="Xóa trang"
          onClose={() => setDeleting(null)}
          onConfirm={() => deletePage(deleting)}
        />
      ) : null}
    </section>
  );
}
