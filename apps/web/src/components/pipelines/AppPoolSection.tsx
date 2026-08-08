'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppPoolPage, AppPoolResponse } from '@open-design/contracts';

import { Icon } from '../Icon';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { fetchProjectFileText } from '../../providers/registry';
import { AppPoolTree } from './AppPoolTree';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ConfluenceTreeImport } from './ConfluenceTreeImport';
import { ProgressBar } from './ProgressBar';
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
  /** Ẩn nút "Chưng cất tài liệu" (+ banner thử lại) — màn "App đã tạo" chỉ
   *  xác nhận NẠP tài liệu; chưng cất thuộc bước 1 workflow. Màn Sửa App vẫn
   *  hiện nút (đường pre-warm tùy chọn). */
  hideDistill?: boolean;
}

export function AppPoolSection({ appId, hideImport, hideDistill }: AppPoolSectionProps) {
  const [pool, setPool] = useState<AppPoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [distilling, setDistilling] = useState(false);
  // `startDistill` returns as soon as the daemon REGISTERS the job (before it
  // finishes) — `running` only observed via polling. `runDistillJob` reverts
  // a failed branch's pages rather than leaving them `distilling`, so a
  // running→not-running transition that still leaves pages pending is the
  // client-visible signature of a failed run (the daemon doesn't forward the
  // job's own error message on this endpoint). `wasRunningRef` gates this so
  // a brand-new, never-distilled pool isn't mistaken for a failed one.
  const wasRunningRef = useRef(false);
  const [distillFailed, setDistillFailed] = useState(false);
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
    wasRunningRef.current = false;
    setDistillFailed(false);
    void loadPool();
  }, [appId, loadPool]);

  useEffect(() => {
    if (!distilling) return undefined;
    const interval = window.setInterval(() => void loadPool(true), 3000);
    return () => window.clearInterval(interval);
  }, [distilling, loadPool]);

  // See `wasRunningRef`'s docblock — this is the running→not-running-but-
  // still-pending transition that reads as "the distill job failed".
  useEffect(() => {
    if (!pool) return;
    const runningNow = pool.distill.running;
    if (runningNow) {
      wasRunningRef.current = true;
      setDistillFailed(false);
    } else if (wasRunningRef.current) {
      wasRunningRef.current = false;
      if (!pool.distill.clean && pool.distill.pending > 0) setDistillFailed(true);
    }
  }, [pool]);

  const startDistill = async () => {
    setError(null);
    setDistillFailed(false);
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
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const ready = pool.pages.length > 0 && !isRunning && pool.distill.clean;

  return (
    <section className={styles.section} aria-label="Tài liệu App">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Tài liệu App</h2>
          <p className={styles.muted}>
            {pool.pages.length === 0
              ? 'Chưa có tài liệu trong pool.'
              : ready
                ? `Pool sẵn sàng (${pool.pages.length} trang đã chưng cất)`
                : `${pool.pages.length} trang`}
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
          {pool.pages.length > 0 && !hideDistill ? (
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
      {isRunning && progress ? (
        <ProgressBar
          label={`Đang chưng cất tài liệu… ${progress.done}/${progress.total} trang (${percent}%)`}
          percent={percent}
        />
      ) : null}
      {distillFailed && !hideDistill ? (
        <div className={styles.distillFailBanner}>
          <p className={styles.error}>
            Chưng cất chưa xong hết — còn {pool.distill.pending} trang. Bấm thử lại hoặc dùng nút "Chưng cất tài liệu" ở trên.
          </p>
          <button type="button" className={styles.secondaryButton} onClick={() => void startDistill()}>
            Thử lại
          </button>
        </div>
      ) : null}
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
              onPartialImport={() => void loadPool(true)}
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
