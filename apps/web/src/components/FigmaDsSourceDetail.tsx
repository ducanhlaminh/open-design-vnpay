// WP21b — trang detail nguồn Figma tại `/design-systems/figma/:sourceId`.
// Thay cho markdown dump cũ (criteria/components.md render thô): component
// browser có cấu trúc (search/filter/phân trang) + nút "Sinh mô tả (N thiếu)"
// với panel tiến độ per-component. Đây là nơi CHÍNH của mọi thao tác trên
// một nguồn Figma dùng chung — panel rút gọn trong tab DS của App
// (AppDesignSystemPanel's SharedFigmaCatalogPanel) chỉ còn coverage + link
// sang đây.
//
// API theo .tmp/pipeline/wp21-contract.md — WP21a dựng daemon song song theo
// ĐÚNG nguyên văn contract đó; type mở rộng (items/remainingAfterCap/
// lastGuideRun/FigmaDesignSystemComponentItem) khai báo cục bộ trong
// providers/figma-design-systems.ts (marker "WP21c hợp nhất sang
// @open-design/contracts"), KHÔNG import từ @open-design/contracts vì
// contracts chưa có các type này lúc hai WP chạy song song.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { Icon } from './Icon';
import {
  fetchFigmaDesignSystemComponents,
  fetchFigmaDesignSystemDetail,
  fetchFigmaDesignSystemTokens,
  generateFigmaDesignSystemGuide,
  refreshFigmaDesignSystem,
  useFigmaGuideJob,
  type FigmaDesignSystemComponentItem,
  type GetFigmaDesignSystemSourceResponseV2,
} from '../providers/figma-design-systems';
import styles from './FigmaDsSourceDetail.module.css';

/** 564 comp render phẳng có thể nặng; phân trang đơn giản thay vì kéo thêm
 *  lib virtual-scroll (must_not cấm dependency mới). */
const PAGE_SIZE = 60;

interface Props {
  sourceId: string;
  onBack: () => void;
}

// Chữ khác với 4 đếm tổng ("Hàng đợi/Đang sinh/Thành công/Lỗi") CỐ Ý — badge
// per-item nằm bên trong khối nhóm-theo-page, dùng chữ riêng để không trùng
// text với đếm tổng (tránh query 2 nơi ra cùng một chuỗi khi test).
const ITEM_STATUS_LABEL: Record<string, string> = {
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  succeeded: 'Hoàn tất',
  failed: 'Thất bại',
  skipped: 'Bỏ qua',
};

// WP21-fix điểm 5 (review WP21a): sentinel nội bộ cho nhóm "item không có
// page" — KHÔNG THỂ trùng một tên page Figma thật (Figma không cho tên page
// bắt đầu bằng khoảng trắng), nên page thật tên "Khác" vẫn tạo nhóm RIÊNG
// khỏi nhóm "không page". Nhãn hiển thị của cả hai vẫn đều là "Khác" — chỉ
// KEY nội bộ (dùng để nhóm/React key/trạng thái xổ-đóng) khác nhau.
const NO_PAGE_GROUP_KEY = '  __khong-co-trang__';

// `noUncheckedIndexedAccess` coi property access trên type index-signature
// (CSS module) là `string | undefined` — ?? '' để giữ type `string` gọn ở
// nơi dùng (JSX className vẫn nhận undefined bình thường, nhưng Record này
// khai rõ `string` cho dễ đọc chỗ tra cứu theo status).
const ITEM_STATUS_BADGE_CLASS: Record<string, string> = {
  queued: styles.itemBadgeQueued ?? '',
  running: styles.itemBadgeRunning ?? '',
  succeeded: styles.itemBadgeSucceeded ?? '',
  failed: styles.itemBadgeFailed ?? '',
  skipped: styles.itemBadgeSkipped ?? '',
};

function sourceBadge(source: FigmaDesignSystemComponentItem['descriptionSource']): { label: string; className: string } {
  if (source === 'figma') return { label: 'Figma', className: styles.sourceBadgeFigma ?? '' };
  if (source === 'ai') return { label: 'AI', className: styles.sourceBadgeAi ?? '' };
  return { label: 'Thiếu', className: styles.sourceBadgeNone ?? '' };
}

export function FigmaDsSourceDetail({ sourceId, onBack }: Props) {
  const [detail, setDetail] = useState<GetFigmaDesignSystemSourceResponseV2 | null | undefined>(undefined);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [components, setComponents] = useState<FigmaDesignSystemComponentItem[] | null | undefined>(undefined);
  const [componentsError, setComponentsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [pageFilter, setPageFilter] = useState('all');
  const [missingOnly, setMissingOnly] = useState(false);
  // Contract mục 6c — filter chip "Tên rác (N)" lọc theo needsRename, độc
  // lập với job (tính thẳng từ components API, hiện cả khi chưa chạy job).
  const [needsRenameOnly, setNeedsRenameOnly] = useState(false);
  const [needsRenameExpanded, setNeedsRenameExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [expandedAnchor, setExpandedAnchor] = useState<string | null>(null);
  const [lastRunExpanded, setLastRunExpanded] = useState(false);
  // WP-ds-tokens UI: tab "Tokens" render tokens.md de-facto (0.8.96). Lazy —
  // chỉ fetch lần đầu chuyển tab (undefined = chưa tải/đang tải, null = nguồn
  // chưa sinh tokens — 404, KHÔNG phải lỗi vì mining chạy NỀN sau Làm mới).
  const [view, setView] = useState<'components' | 'tokens'>('components');
  const [tokens, setTokens] = useState<{ markdown: string; generatedAt: string } | null | undefined>(undefined);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);

  // WP23b — re-attach: hook khuôn useAppImportJob, tự hỏi
  // /api/figma-guide-jobs/active lúc mount để hiện panel tiến độ ngay cả khi
  // người dùng chưa bấm nút "Sinh mô tả" ở lượt vào trang này.
  const { job, adopt: adoptJob } = useFigmaGuideJob(sourceId);
  const [jobError, setJobError] = useState<string | null>(null);
  // Nhóm nào đang "xổ" (mở) trong panel tiến độ theo-page. Nhóm nào ĐANG có
  // item lỗi tự mở ngay (người dùng cần thấy lý do lỗi mà không phải bấm) —
  // effect bên dưới hợp (union) thêm page lỗi mỗi lần items cập nhật, không
  // đè lựa chọn đóng/mở người dùng đã tự bấm cho nhóm khác.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Job vừa refetch-once cho lượt xong gần nhất — tránh gọi lại loadComponents
  // /loadDetail nhiều lần khi hook tiếp tục poll xung quanh trạng thái terminal.
  const refetchedJobIdRef = useRef<string | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await fetchFigmaDesignSystemDetail(sourceId));
      setDetailError(null);
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : String(error));
    }
  }, [sourceId]);

  const loadComponents = useCallback(async () => {
    try {
      setComponents(await fetchFigmaDesignSystemComponents(sourceId));
      setComponentsError(null);
    } catch (error) {
      setComponents(null);
      setComponentsError(error instanceof Error ? error.message : String(error));
    }
  }, [sourceId]);

  const loadTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      setTokens(await fetchFigmaDesignSystemTokens(sourceId));
      setTokensError(null);
    } catch (error) {
      setTokens(undefined);
      setTokensError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokensLoading(false);
    }
  }, [sourceId]);

  // Lần đầu mở tab Tokens mới fetch; các lần sau giữ cache trong state, nút
  // "Tải lại" cho trường hợp mining nền vừa chạy xong sau Làm mới.
  useEffect(() => {
    if (view === 'tokens' && tokens === undefined && !tokensLoading && !tokensError) void loadTokens();
  }, [view, tokens, tokensLoading, tokensError, loadTokens]);

  useEffect(() => {
    setDetail(undefined);
    setComponents(undefined);
    setJobError(null);
    setPage(1);
    setView('components');
    setTokens(undefined);
    setTokensError(null);
    refetchedJobIdRef.current = null;
    void loadDetail();
    void loadComponents();
  }, [sourceId, loadDetail, loadComponents]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Trang detail tái dùng client refresh sẵn có (WP19/WP20) — cùng
      // request daemon dùng để "Chạy lại" ở FigmaDesignSystemsSection, chỉ
      // khác điểm gọi.
      await refreshFigmaDesignSystem(sourceId);
      await Promise.all([loadDetail(), loadComponents()]);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [sourceId, loadDetail, loadComponents]);

  const startGeneration = useCallback(async () => {
    setJobError(null);
    setExpandedGroups(new Set());
    const result = await generateFigmaDesignSystemGuide(sourceId);
    if (!result.ok) {
      setJobError(result.error);
      return;
    }
    adoptJob(result.job);
  }, [sourceId, adoptJob]);

  // Job xong (qua hook re-attach hoặc qua startGeneration) → refetch
  // components + coverage (badge Thiếu → AI tại chỗ) ĐÚNG MỘT LẦN, KHÔNG đụng
  // lại Figma (job không đụng gì tới catalog, chỉ ghi guide).
  useEffect(() => {
    if (!job || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    if (refetchedJobIdRef.current === job.id) return;
    refetchedJobIdRef.current = job.id;
    void loadComponents();
    void loadDetail();
  }, [sourceId, job?.id, job?.status, loadComponents, loadDetail]);

  const pageOptions = useMemo(() => {
    if (!components) return [];
    const set = new Set<string>();
    for (const item of components) if (item.page) set.add(item.page);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
  }, [components]);

  const missingCount = detail?.coverage?.missing
    ?? components?.filter((item) => item.descriptionSource === 'none').length
    ?? 0;

  // Contract mục 6c — tính thẳng từ components API, hiện cả khi chưa chạy
  // job sinh mô tả nào.
  const needsRenameItems = useMemo(
    () => components?.filter((item) => item.needsRename) ?? [],
    [components],
  );
  const needsRenameCount = needsRenameItems.length;

  const filtered = useMemo(() => {
    if (!components) return [];
    const term = search.trim().toLowerCase();
    return components.filter((item) => {
      if (term && !item.name.toLowerCase().includes(term)) return false;
      if (pageFilter !== 'all' && item.page !== pageFilter) return false;
      if (missingOnly && item.descriptionSource !== 'none') return false;
      if (needsRenameOnly && !item.needsRename) return false;
      return true;
    });
  }, [components, search, pageFilter, missingOnly, needsRenameOnly]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE),
    [filtered, clampedPage],
  );

  const jobRunning = job != null && (job.status === 'queued' || job.status === 'running');
  const jobItems = job?.items;
  const jobCounts = jobItems
    ? {
        queued: jobItems.filter((item) => item.status === 'queued').length,
        running: jobItems.filter((item) => item.status === 'running').length,
        succeeded: jobItems.filter((item) => item.status === 'succeeded').length,
        failed: jobItems.filter((item) => item.status === 'failed').length,
        // Contract mục 3/6b — comp needsRename bị đánh 'skipped' ngay khi job
        // start (không gửi agent, không tính vào failed); panel đếm riêng.
        skipped: jobItems.filter((item) => item.status === 'skipped').length,
      }
    : null;
  const jobTotal = jobItems?.length ?? 0;
  // Contract mục 6b — "progress done gồm succeeded+failed+skipped".
  const jobDone = jobCounts ? jobCounts.succeeded + jobCounts.failed + jobCounts.skipped : 0;

  // Contract mục 2 (bổ sung 2026-08-20): daemon fan-out theo NHÓM TRANG Figma
  // — panel tiến độ nhóm items theo `page` (item không có page → nhóm "Khác")
  // thay vì liệt kê phẳng, để khớp cách engine chạy thật (mỗi nhóm 1 trang,
  // song song có giới hạn). WP21-fix điểm 5: nhóm theo `key` nội bộ
  // (NO_PAGE_GROUP_KEY cho item không page, page thật cho phần còn lại) —
  // `label` hiển thị mới là "Khác"/tên page, để một page THẬT tên "Khác"
  // không bị gộp chung nhóm với item không có page.
  const jobGroups = useMemo(() => {
    if (!jobItems) return null;
    const order: string[] = [];
    const byKey = new Map<string, typeof jobItems>();
    for (const item of jobItems) {
      const key = item.page ?? NO_PAGE_GROUP_KEY;
      if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
      byKey.get(key)!.push(item);
    }
    return order.map((key) => {
      const items = byKey.get(key)!;
      const label = key === NO_PAGE_GROUP_KEY ? 'Khác' : key;
      const done = items.filter((item) => item.status === 'succeeded' || item.status === 'failed' || item.status === 'skipped').length;
      const hasFailed = items.some((item) => item.status === 'failed');
      const hasRunning = items.some((item) => item.status === 'running');
      const allDone = done === items.length;
      const statusLabel = allDone ? (hasFailed ? 'có lỗi' : 'xong') : hasRunning ? 'đang sinh' : 'chờ';
      return { key, label, items, done, total: items.length, statusLabel, hasFailed };
    });
  }, [jobItems]);

  // Tự mở nhóm có item lỗi ngay khi biết — người dùng thấy lý do lỗi mà
  // không cần bấm xổ thêm. Hợp (union) vào lựa chọn hiện có, không đè nhóm
  // người dùng đã tự đóng/mở tay cho nhóm khác.
  useEffect(() => {
    if (!jobGroups) return;
    const failedKeys = jobGroups.filter((group) => group.hasFailed).map((group) => group.key);
    if (failedKeys.length === 0) return;
    setExpandedGroups((current) => {
      const next = new Set(current);
      let changed = false;
      for (const key of failedKeys) {
        if (!next.has(key)) { next.add(key); changed = true; }
      }
      return changed ? next : current;
    });
  }, [jobGroups]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className={styles.page} data-testid="figma-ds-detail">
      <div className={styles.backRow}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          <Icon name="arrow-left" size={13} />
          Design system
        </button>
      </div>

      {detail === undefined ? <p className={styles.meta}>Đang tải…</p> : null}
      {detail === null ? <p className={styles.errorText} role="alert">{detailError ?? 'Không tìm thấy nguồn Figma này.'}</p> : null}
      {/* WP21-fix điểm 4 (review WP21a): refresh() lỗi trong lúc `detail` VẪN
       *  còn dữ liệu cũ (không phải lần tải đầu) trước đây bị nuốt im lặng —
       *  banner ở trên chỉ render khi `detail === null`. Hiện banner NGAY
       *  TRÊN header, tách khỏi nhánh `detail === null`, để lỗi refresh luôn
       *  nhìn thấy được dù trang vẫn hiện dữ liệu cũ. */}
      {detail && detailError ? <p className={styles.errorText} role="alert">{detailError}</p> : null}

      {detail ? (
        <>
          <header className={styles.header}>
            <div className={styles.headerCopy}>
              <h1 className={styles.heading}>{detail.source.name}</h1>
              <p className={styles.meta}>
                {`${detail.source.catalog?.componentCount ?? 0} component · ${detail.source.catalog?.fileCount ?? detail.source.links.length} file · Cập nhật ${new Date(detail.source.updatedAt).toLocaleString('vi-VN')}`}
              </p>
              <ul className={styles.linkList}>
                {detail.source.links.map((link) => (
                  <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>
                ))}
              </ul>
              {detail.coverage ? (
                <p className={styles.meta}>
                  {`${detail.coverage.described}/${detail.coverage.total} component có mô tả · ${detail.coverage.fromGuide} từ AI · ${detail.coverage.missing} thiếu`}
                </p>
              ) : null}
              {detail.imageCache ? (
                <p className={styles.meta}>
                  {`Ảnh comp: ${detail.imageCache.cached}/${detail.imageCache.total}`}
                  {detail.imageCache.running ? ' · đang tải…' : ''}
                </p>
              ) : null}
              {detail.lastGuideRun ? (
                <div>
                  <button
                    type="button"
                    className={styles.lastRun}
                    onClick={() => setLastRunExpanded((current) => !current)}
                  >
                    {`Lượt sinh gần nhất: ${detail.lastGuideRun.generated} ✓ · ${detail.lastGuideRun.failed} ✗`}
                  </button>
                  {lastRunExpanded ? (
                    <ul className={styles.lastRunFailures}>
                      {detail.lastGuideRun.failures.map((failure) => (
                        <li key={failure.anchor}>
                          <strong>{failure.name}</strong>
                          <span>{failure.reason}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className={styles.headerActions}>
              <button type="button" className={styles.refreshButton} disabled={refreshing} onClick={() => { void refresh(); }}>
                <Icon name="refresh" size={13} />
                {refreshing ? 'Đang làm mới…' : 'Làm mới'}
              </button>
            </div>
          </header>

          {needsRenameCount > 0 ? (
            <div className={styles.needsRenameBlock} data-testid="figma-ds-detail-needs-rename">
              <button
                type="button"
                className={styles.needsRenameToggle}
                onClick={() => setNeedsRenameExpanded((current) => !current)}
              >
                <Icon name={needsRenameExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                {`Cần đặt lại tên trong Figma (${needsRenameCount})`}
              </button>
              {needsRenameExpanded ? (
                <ul className={styles.needsRenameList}>
                  {needsRenameItems.map((item) => (
                    <li key={item.anchor}>
                      <strong>{item.name}</strong>
                      {item.page ? <span>{item.page}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* WP-ds-tokens UI: 2 tab — danh mục component (mặc định) và tokens
              de-facto. Chữ thuần (trang này không dùng i18n dict). */}
          <div className={styles.viewTabs} role="tablist" aria-label="Nội dung nguồn Figma">
            <button
              type="button"
              role="tab"
              data-testid="figma-ds-detail-tab-components"
              aria-selected={view === 'components'}
              className={`${styles.viewTab} ${view === 'components' ? styles.viewTabActive : ''}`}
              onClick={() => setView('components')}
            >
              Thành phần
            </button>
            <button
              type="button"
              role="tab"
              data-testid="figma-ds-detail-tab-tokens"
              aria-selected={view === 'tokens'}
              className={`${styles.viewTab} ${view === 'tokens' ? styles.viewTabActive : ''}`}
              onClick={() => setView('tokens')}
            >
              Tokens
            </button>
          </div>

          {view === 'tokens' ? (
            <div className={styles.tokensPanel} data-testid="figma-ds-detail-tokens">
              <div className={styles.tokensToolbar}>
                {tokens ? (
                  <span className={styles.meta}>{`Sinh lúc ${new Date(tokens.generatedAt).toLocaleString('vi-VN')}`}</span>
                ) : <span />}
                <button
                  type="button"
                  className={styles.missingToggle}
                  disabled={tokensLoading}
                  onClick={() => { void loadTokens(); }}
                >
                  {tokensLoading ? 'Đang tải…' : 'Tải lại'}
                </button>
              </div>
              {tokensError ? <p className={styles.errorText} role="alert">{tokensError}</p> : null}
              {tokensLoading && tokens === undefined ? <p className={styles.meta}>Đang tải tokens…</p> : null}
              {tokens === null ? (
                <div className={styles.empty}>
                  <p>
                    Nguồn này chưa có tokens. Tokens được đào tự động (chạy nền) sau mỗi lần <strong>Làm mới</strong> thành
                    công — nếu vừa Làm mới xong, chờ chút rồi bấm <strong>Tải lại</strong>.
                  </p>
                </div>
              ) : null}
              {tokens ? (
                // renderMarkdownToSafeHtml đã sanitize (cùng helper các preview
                // markdown khác của web) — tokens.md do daemon tự sinh tất định.
                <div
                  className={styles.tokensMarkdown}
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(tokens.markdown) }}
                />
              ) : null}
            </div>
          ) : null}

          {view === 'tokens' ? null : (
          <>
          <div className={styles.toolbar}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Tìm component theo tên…"
              aria-label="Tìm component theo tên"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            />
            <select
              className={styles.pageSelect}
              aria-label="Lọc theo trang"
              value={pageFilter}
              onChange={(event) => { setPageFilter(event.target.value); setPage(1); }}
            >
              <option value="all">Tất cả trang</option>
              {pageOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button
              type="button"
              data-testid="figma-ds-detail-missing-only"
              className={`${styles.missingToggle} ${missingOnly ? styles.missingToggleActive : ''}`}
              aria-pressed={missingOnly}
              onClick={() => { setMissingOnly((current) => !current); setPage(1); }}
            >
              {`Thiếu mô tả (${missingCount})`}
            </button>
            {needsRenameCount > 0 ? (
              <button
                type="button"
                data-testid="figma-ds-detail-needs-rename-only"
                className={`${styles.missingToggle} ${needsRenameOnly ? styles.missingToggleActive : ''}`}
                aria-pressed={needsRenameOnly}
                onClick={() => { setNeedsRenameOnly((current) => !current); setPage(1); }}
              >
                {`Tên rác (${needsRenameCount})`}
              </button>
            ) : null}
            {detail.coverage ? (
              <button
                type="button"
                data-testid="figma-ds-detail-generate"
                className={styles.generateButton}
                disabled={missingCount === 0 || jobRunning}
                onClick={() => { void startGeneration(); }}
              >
                {jobRunning ? 'Đang sinh mô tả…' : `Sinh mô tả (${missingCount} thiếu)`}
              </button>
            ) : null}
          </div>

          {jobError ? <p className={styles.errorText} role="alert">{jobError}</p> : null}

          {job ? (
            <div className={styles.progressPanel} data-testid="figma-ds-detail-progress">
              {jobCounts ? (
                <>
                  <progress className={styles.progressBar} max={jobTotal || 1} value={jobDone} aria-label="Tiến độ sinh mô tả" />
                  <div className={styles.progressCounts}>
                    <div><strong>{jobCounts.queued}</strong><span>Hàng đợi</span></div>
                    <div><strong>{jobCounts.running}</strong><span>Đang sinh</span></div>
                    <div><strong>{jobCounts.succeeded}</strong><span>Thành công</span></div>
                    <div><strong>{jobCounts.failed}</strong><span>Lỗi</span></div>
                    <div><strong>{jobCounts.skipped}</strong><span>Bỏ qua</span></div>
                  </div>
                  <div className={styles.progressItems} data-testid="figma-ds-detail-progress-items">
                    {jobGroups!.map((group) => {
                      const expanded = expandedGroups.has(group.key);
                      return (
                        <div key={group.key} className={styles.progressGroup}>
                          <button
                            type="button"
                            className={styles.progressGroupHead}
                            onClick={() => toggleGroup(group.key)}
                          >
                            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                            {`${group.label} — ${group.done}/${group.total} · ${group.statusLabel}`}
                          </button>
                          {expanded ? (
                            <ul className={styles.progressGroupItems}>
                              {group.items.map((item) => (
                                <li key={item.anchor}>
                                  <span className={`${styles.itemBadge} ${ITEM_STATUS_BADGE_CLASS[item.status]}`}>
                                    {ITEM_STATUS_LABEL[item.status]}
                                  </span>
                                  <span>{item.name}</span>
                                  {(item.status === 'failed' || item.status === 'skipped') && item.reason ? (
                                    <span className={styles.progressItemReason}>{item.reason}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                // Job cũ (daemon chưa update) không có `items` — fallback về
                // 3 con số như panel App hiện có, KHÔNG vỡ.
                <p className={styles.progressFallback}>
                  {`Đã sinh ${job.generated} · Từ chối ${job.rejected} · Còn thiếu ${job.remaining}`}
                </p>
              )}
              {job.remainingAfterCap != null && job.remainingAfterCap > 0 ? (
                <p className={styles.progressRemaining}>{`còn ${job.remainingAfterCap} comp chờ lượt sau`}</p>
              ) : null}
            </div>
          ) : null}

          {componentsError ? <p className={styles.errorText} role="alert">{componentsError}</p> : null}

          {components === undefined ? <p className={styles.meta}>Đang tải danh mục…</p> : null}
          {!components ? null : components.length === 0 ? (
            <div className={styles.empty}><p>Nguồn này chưa có danh mục component. Bấm <strong>Làm mới</strong> để đọc từ Figma.</p></div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}><p>Không có component nào khớp bộ lọc.</p></div>
          ) : (
            <>
              <div className={styles.list}>
                {pageItems.map((item) => {
                  const badge = sourceBadge(item.descriptionSource);
                  const expanded = expandedAnchor === item.anchor;
                  return (
                    <article key={item.anchor} className={styles.row} data-testid={`figma-ds-detail-component-${item.anchor}`}>
                      <div className={styles.rowLayout}>
                        <div className={styles.rowThumbWrap}>
                          {/* Contract mục 6d — ảnh cache theo anchor, ổn định
                              qua rename/refresh; 404/chưa cache → onError ẩn
                              ảnh, giữ nguyên khoảng chừa (không vỡ layout). */}
                          <img
                            className={styles.rowThumb}
                            src={`/api/figma-design-systems/${encodeURIComponent(sourceId)}/component-image/${encodeURIComponent(item.anchor)}`}
                            alt={item.name}
                            loading="lazy"
                            onError={(event) => { event.currentTarget.style.display = 'none'; }}
                          />
                        </div>
                        <div className={styles.rowBody}>
                          <div className={styles.rowHead}>
                            <span className={`${styles.sourceBadge} ${badge.className}`}>{badge.label}</span>
                            <h3 className={styles.rowName}>{item.name}</h3>
                            <span className={styles.rowNodeId}>{item.nodeId}</span>
                          </div>
                          <p className={styles.rowDescription}>{item.description || 'Chưa có mô tả.'}</p>
                          {item.properties.length > 0 ? (
                            <button
                              type="button"
                              className={styles.rowToggle}
                              onClick={() => setExpandedAnchor(expanded ? null : item.anchor)}
                            >
                              {expanded ? 'Ẩn thuộc tính' : `Xem thuộc tính (${item.properties.length})`}
                            </button>
                          ) : null}
                          {expanded ? (
                            <table className={styles.propsTable}>
                              <thead>
                                <tr><th>Thuộc tính</th><th>Kiểu</th><th>Giá trị</th></tr>
                              </thead>
                              <tbody>
                                {item.properties.map((prop) => (
                                  <tr key={prop.name}>
                                    <td>{prop.name}</td>
                                    <td>{prop.type}</td>
                                    <td>{prop.values.join(', ')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {totalPages > 1 ? (
                <div className={styles.pagination}>
                  <button type="button" disabled={clampedPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Trước</button>
                  <span>{`Trang ${clampedPage}/${totalPages}`}</span>
                  <button type="button" disabled={clampedPage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Sau →</button>
                </div>
              ) : null}
            </>
          )}
          </>
          )}
        </>
      ) : null}
    </div>
  );
}
