'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppPoolPage, AppPoolResponse } from '@open-design/contracts';

import { Icon } from '../Icon';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { fetchProjectFileText } from '../../providers/registry';
import { AppPoolTree } from './AppPoolTree';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ConfluenceTreeImport } from './ConfluenceTreeImport';
import { DistillModal } from './DistillModal';
import styles from './AppPoolSection.module.css';

/** Trang pool mở đầu bằng frontmatter YAML (`--- title/page_id/url/source ---`)
 *  do bộ fetch ghi vào. Renderer markdown không hiểu khối đó nên nó đổ ra
 *  thành một đoạn văn thô ngay đầu preview — bóc ra, chỉ giữ `url` để dựng
 *  link "Mở trên Confluence" ở đầu pane. */
function splitFrontmatter(text: string): { body: string; url: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text, url: null };
  const url = /^url:\s*(\S+)\s*$/m.exec(match[1] ?? '')?.[1] ?? null;
  return { body: text.slice(match[0].length), url };
}

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
  const [distillModalOpen, setDistillModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<AppPoolPage | null>(null);
  // Preview pane (cột phải của layout 2 cột): trang đang xem — click tên
  // trang trong tree, hoặc nút "Xem tổng quan" (path đặc biệt _overview.md).
  const [preview, setPreview] = useState<{ path: string; title: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPool = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(poolUrl(appId));
      if (!response.ok) throw new Error(`Không thể tải tài liệu App (${response.status}).`);
      const nextPool = (await response.json()) as AppPoolResponse;
      setPool(nextPool);
      setError(null);
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
    setPreview(null);
    setPreviewHtml(null);
    setPreviewError(null);
    void loadPool();
  }, [appId, loadPool]);

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

  const openPreviewPath = (path: string, title: string) => {
    setPreview({ path, title });
    setPreviewHtml(null);
    setPreviewError(null);
    setPreviewUrl(null);
    setPreviewLoading(true);
    void (async () => {
      try {
        const text = await fetchProjectFileText(appId, `docs/${path}`);
        if (text === null) throw new Error(`Không đọc được ${path}.`);
        const { body, url } = splitFrontmatter(text);
        setPreviewUrl(url);
        setPreviewHtml(renderMarkdownToSafeHtml(body));
      } catch (cause) {
        setPreviewError(cause instanceof Error ? cause.message : `Không đọc được ${path}.`);
      } finally {
        setPreviewLoading(false);
      }
    })();
  };

  if (loading) return <section className={styles.section}><p className={styles.muted}>Đang tải tài liệu App…</p></section>;
  if (error && !pool) return <section className={styles.section}><p className={styles.error}>{error}</p><button className={styles.secondaryButton} onClick={() => void loadPool()}>Thử lại</button></section>;
  if (!pool) return null;

  const isRunning = pool.distill.running;
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
            <button type="button" className={styles.secondaryButton} onClick={() => openPreviewPath('_overview.md', 'Tổng quan tài liệu (_overview.md)')}>
              <Icon name="eye" size={13} />
              Xem tổng quan
            </button>
          ) : null}
          {pool.pages.length > 0 && !hideDistill ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => setDistillModalOpen(true)}
              disabled={isRunning || pool.distill.pending === 0}
            >
              Chưng cất tài liệu
              {pool.distill.pending > 0 ? <span className={styles.count}>{pool.distill.pending}</span> : null}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}

      {pool.pages.length > 0 ? (() => {
        // 2 cột: trái = tree tách "Docs chính" / "Docs liên quan" (cờ related
        // gắn lúc import qua "Quét tài liệu liên quan"; pool cũ chưa có cờ →
        // tất cả là docs chính), phải = preview nội dung trang đang chọn.
        const mainPages = pool.pages.filter((page) => page.related !== true);
        const relatedPages = pool.pages.filter((page) => page.related === true);
        const leafActions = (page: AppPoolPage) => (
          <button
            type="button"
            className={styles.deleteButton}
            onClick={() => setDeleting(page)}
            aria-label={`Xóa trang ${page.title}`}
            title="Xóa trang"
          >
            <Icon name="trash" size={13} />
          </button>
        );
        const openPage = (page: AppPoolPage) => openPreviewPath(page.path, page.title);
        return (
          <div className={styles.split}>
            <div className={styles.treePane}>
              <div className={styles.groupHead}>
                <Icon name="folder-filled" size={13} />
                <span className={styles.groupTitle}>Docs chính</span>
                <span className={styles.groupCount}>{mainPages.length}</span>
              </div>
              {mainPages.length > 0 ? (
                <AppPoolTree pages={mainPages} renderLeafActions={leafActions} onOpenPage={openPage} activePath={preview?.path} />
              ) : (
                <p className={styles.groupEmpty}>Chưa có docs chính.</p>
              )}
              {relatedPages.length > 0 ? (
                <>
                  <div className={`${styles.groupHead} ${styles.groupHeadRelated}`}>
                    <Icon name="link" size={13} />
                    <span className={styles.groupTitle}>Docs liên quan</span>
                    <span className={styles.groupCount}>{relatedPages.length}</span>
                  </div>
                  <AppPoolTree pages={relatedPages} renderLeafActions={leafActions} onOpenPage={openPage} activePath={preview?.path} />
                </>
              ) : null}
            </div>
            <div className={styles.previewPane}>
              {preview ? (
                <>
                  <div className={styles.previewHead}>
                    <div className={styles.previewTitleWrap}>
                      <span className={styles.previewTitle}>{preview.title}</span>
                      <span className={styles.previewPath} title={preview.path}>{preview.path}</span>
                    </div>
                    <div className={styles.previewActions}>
                      {previewUrl ? (
                        <a
                          className={styles.previewLink}
                          href={previewUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Mở trang gốc trên Confluence"
                        >
                          <Icon name="external-link" size={13} />
                          Confluence
                        </a>
                      ) : null}
                      <button type="button" className={styles.previewClose} onClick={() => setPreview(null)} aria-label="Đóng preview">
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  </div>
                  <div className={styles.previewScroll}>
                    {previewLoading ? <p className={styles.muted}>Đang tải…</p> : null}
                    {previewError ? <p className={styles.error}>{previewError}</p> : null}
                    {previewHtml ? (
                      // eslint-disable-next-line react/no-danger -- renderMarkdownToSafeHtml escapes raw HTML by contract.
                      <div className={`${styles.previewBody} markdown-rendered`} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                    ) : null}
                  </div>
                </>
              ) : (
                <div className={styles.previewEmpty}>
                  <Icon name="file" size={22} />
                  <p className={styles.previewHint}>Bấm tên một trang bên trái để đọc nội dung tại chỗ.</p>
                </div>
              )}
            </div>
          </div>
        );
      })() : null}

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
      {distillModalOpen && !hideDistill ? (
        <DistillModal
          appId={appId}
          onClose={() => {
            setDistillModalOpen(false);
            void loadPool(true);
          }}
          onFinished={() => void loadPool(true)}
        />
      ) : null}
    </section>
  );
}
