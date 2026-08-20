'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesignSystemFileDetail, DesignSystemReactInfo, DesignSystemSummary, DocsReviewComponentSource } from '@open-design/contracts';
import { DesignSpecView } from '../DesignSpecView';
import { navigate } from '../../router';
import {
  fetchFigmaDesignSystemDetail,
  type GetFigmaDesignSystemSourceResponseV2,
} from '../../providers/figma-design-systems';
import { fetchDesignSystemCriteriaFile, fetchDesignSystemReactInfo, fetchDesignSystems } from '../../providers/registry';
import {
  fetchAppFigmaCatalog,
  fetchAppFigmaGuideJob,
  generateAppFigmaGuide,
  refreshAppFigmaCatalog,
  type AppFigmaCatalogResponse,
  type AppFigmaGuideJob,
} from '../../state/figma-config';
import styles from './AppDesignSystemPanel.module.css';

/** UI poll cadence for the "Sinh mô tả" background job — same order of
 *  magnitude as other job-status polls in this codebase (ds-criteria/rules),
 *  fast enough to feel live without hammering the daemon. */
const GUIDE_JOB_POLL_MS = 3_000;

type View = 'showcase' | 'criteria';

interface Props {
  appId: string;
  designSystemId?: string | null;
  /** App-level component source; `figma-links` swaps the panel for the
   *  catalogue read from the linked Figma files. Defaults to the DS view. */
  componentSource?: DocsReviewComponentSource | null;
  figmaDesignSystemSourceId?: string | null;
}

export function AppDesignSystemPanel({ appId, designSystemId, componentSource, figmaDesignSystemSourceId }: Props) {
  if (figmaDesignSystemSourceId) {
    return <SharedFigmaCatalogPanel sourceId={figmaDesignSystemSourceId} />;
  }
  if (componentSource?.mode === 'figma-links') {
    return <AppFigmaCatalogPanel appId={appId} linkCount={componentSource.links.length} />;
  }
  return <AppDesignSystemView appId={appId} designSystemId={designSystemId} />;
}

/** DS của một App gắn qua NGUỒN FIGMA DÙNG CHUNG (`figmaDesignSystemSourceId`
 *  — WP20, hoàn tất scope WP19b cho chế độ gắn DS này). WP21b RÚT GỌN panel
 *  này: nút "Sinh mô tả" + poll job + markdown dump + <details> guide đã dọn
 *  đi — mọi thao tác (component browser, sinh mô tả, xem lỗi lượt sinh gần
 *  nhất) chuyển hẳn sang trang `/design-systems/figma/:sourceId`
 *  (FigmaDsSourceDetail). Panel ở đây (trong tab DS của App) chỉ còn đọc
 *  coverage NHANH + nút điều hướng — App có thể gắn cùng lúc nhiều nguồn
 *  Figma dùng chung, nên đây vẫn cần biết đang trỏ tới nguồn nào trước khi
 *  bấm sang trang chính. */
function SharedFigmaCatalogPanel({ sourceId }: { sourceId: string }) {
  const [detail, setDetail] = useState<GetFigmaDesignSystemSourceResponseV2 | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setLoadError(null);
    void fetchFigmaDesignSystemDetail(sourceId)
      .then((result) => { if (!controller.signal.aborted) setDetail(result); })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [sourceId]);

  return (
    <section className={styles.section} aria-label="Design system Figma">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>{detail?.source.name ?? 'Design system Figma'}</h2>
          <p className={styles.muted}>Danh mục component dùng chung đã nạp từ link Figma. Nguồn này không có Showcase hoặc React bundle.</p>
        </div>
      </div>
      <div className={styles.criteriaWrap}>
        {detail === undefined ? <p className={styles.muted}>Đang tải danh mục…</p>
          : detail === null ? <p className={styles.empty}>{loadError ?? 'Không tìm thấy Design system Figma đã chọn.'}</p>
          : <>
              <div className={styles.criteriaHead}>
                <h3 className={styles.subheading}>Danh mục component</h3>
                <p className={styles.meta}>{detail.source.catalog?.componentCount ?? 0} component · {detail.source.catalog?.fileCount ?? detail.source.links.length} file</p>
                {detail.coverage ? (
                  <p className={styles.meta}>
                    {detail.coverage.described}/{detail.coverage.total} component có mô tả · {detail.coverage.fromGuide} từ AI · {detail.coverage.missing} thiếu
                  </p>
                ) : null}
              </div>
              <p className={styles.muted}>Cập nhật {new Date(detail.source.updatedAt).toLocaleString('vi-VN')}.</p>
              <div className={styles.guideBar}>
                <button
                  type="button"
                  className={styles.refreshButton}
                  data-testid="figma-design-system-open-detail"
                  onClick={() => navigate({ kind: 'figma-ds-detail', sourceId })}
                >
                  Mở trang Design system →
                </button>
              </div>
            </>}
      </div>
    </section>
  );
}

/** "DS" of an App whose component source is Figma links: the component
 *  catalogue the daemon reads from those files (same snapshot dr-comp uses).
 *  Reads once on open; if nothing is stored yet and a token exists, pulls
 *  from Figma right away so the tab is never blank without saying why. */
function AppFigmaCatalogPanel({ appId, linkCount }: { appId: string; linkCount: number }) {
  const [catalog, setCatalog] = useState<AppFigmaCatalogResponse | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WP19b: nút "Sinh mô tả (N thiếu)" — job nền, poll ~3s tới khi kết thúc.
  const [guideJob, setGuideJob] = useState<AppFigmaGuideJob | null>(null);
  const [guideError, setGuideError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const generation = ++requestGeneration.current;
    setRefreshing(true);
    setError(null);
    const result = await refreshAppFigmaCatalog(appId, controller.signal);
    if (controller.signal.aborted || generation !== requestGeneration.current) return;
    setRefreshing(false);
    if (result.ok) setCatalog(result.catalog);
    else setError(result.error);
  }, [appId]);

  useEffect(() => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const generation = ++requestGeneration.current;
    setCatalog(undefined);
    setRefreshing(false);
    setError(null);
    setGuideJob(null);
    setGuideError(null);
    void fetchAppFigmaCatalog(appId, controller.signal).then((res) => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setCatalog(res);
      // First open with nothing stored yet: read from Figma now.
      if (res && res.hasToken && res.generatedAt == null && (res.links?.length ?? 0) > 0) void refresh();
    });
    return () => {
      controller.abort();
      if (activeController.current === controller) activeController.current = null;
    };
  }, [appId, refresh]);

  const missingCount = catalog?.coverage?.missing ?? 0;
  const guideJobRunning = guideJob != null && (guideJob.status === 'queued' || guideJob.status === 'running');

  const startGuideGeneration = useCallback(async () => {
    setGuideError(null);
    const result = await generateAppFigmaGuide(appId);
    if (!result.ok) {
      setGuideError(result.error);
      return;
    }
    setGuideJob(result.job);
  }, [appId]);

  // Poll while the job is queued/running; stop as soon as it lands on a
  // terminal status, and refetch the catalog once (guideMarkdown + coverage
  // đã đổi) instead of re-hitting Figma — the job never touches components.
  useEffect(() => {
    if (!guideJob || (guideJob.status !== 'queued' && guideJob.status !== 'running')) return undefined;
    let alive = true;
    const jobId = guideJob.id;
    const timer = setInterval(() => {
      void fetchAppFigmaGuideJob(appId, jobId).then((job) => {
        if (!alive || !job) return;
        setGuideJob(job);
        if (job.status === 'succeeded') {
          clearInterval(timer);
          void fetchAppFigmaCatalog(appId).then((res) => { if (alive && res) setCatalog(res); });
        } else if (job.status === 'failed') {
          clearInterval(timer);
          setGuideError(job.error ?? 'Sinh mô tả thất bại.');
        }
      });
    }, GUIDE_JOB_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [appId, guideJob?.id, guideJob?.status]);

  const generatedLabel = catalog?.generatedAt ? new Date(catalog.generatedAt).toLocaleString('vi-VN') : null;

  return (
    <section className={styles.section} aria-label="Design System">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Danh mục component từ Figma</h2>
          <p className={styles.muted}>Đọc từ {linkCount} file Figma đã link cho dự án — đây là danh mục bước “Màn hình → Component” dùng để đối chiếu.</p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          data-testid="figma-catalog-refresh"
          disabled={refreshing || catalog === undefined || (catalog !== null && !catalog.hasToken)}
          onClick={() => { void refresh(); }}
        >
          {refreshing ? 'Đang đọc…' : 'Đọc lại từ Figma'}
        </button>
      </div>
      <div className={styles.criteriaWrap}>
        {catalog === undefined ? (
          <p className={styles.muted}>Đang tải danh mục…</p>
        ) : catalog === null ? (
          <p className={styles.empty}>Không tải được danh mục (daemon không phản hồi).</p>
        ) : (
          <>
            <div className={styles.criteriaHead}>
              <h3 className={styles.subheading}>Danh mục component</h3>
              <p className={styles.meta}>
                {catalog.generatedAt ? `${catalog.componentCount} component · đọc lúc ${generatedLabel}` : 'chưa đọc lần nào'}
              </p>
              {catalog.files.length > 0 ? (
                <ul className={styles.fileList}>
                  {catalog.files.map((file) => (
                    <li key={file.fileKey}>
                      <a href={file.url} target="_blank" rel="noreferrer">{file.name || file.fileKey}</a>
                      <span className={styles.muted}> · {file.componentCount} component</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {catalog.coverage ? (
                <p className={styles.meta}>
                  {catalog.coverage.described}/{catalog.coverage.total} component có mô tả · {catalog.coverage.fromGuide} từ AI · {catalog.coverage.missing} thiếu
                </p>
              ) : null}
            </div>
            {catalog.coverage ? (
              <div className={styles.guideBar}>
                <button
                  type="button"
                  className={styles.refreshButton}
                  data-testid="figma-guide-generate"
                  disabled={missingCount === 0 || guideJobRunning}
                  onClick={() => { void startGuideGeneration(); }}
                >
                  {guideJobRunning ? 'Đang sinh mô tả…' : `Sinh mô tả (${missingCount} thiếu)`}
                </button>
                {guideJobRunning ? <p className={styles.muted}>{guideJob?.message ?? 'Đang xử lý…'}</p> : null}
              </div>
            ) : null}
            {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
            {guideError ? <p className={styles.errorText} role="alert">{guideError}</p> : null}
            {!catalog.hasToken ? (
              <div className={styles.empty}><p>Chưa có token Figma nên chưa đọc được danh mục. Vào <strong>Sửa dự án</strong> → Nguồn đối chiếu component → dán Personal Access Token.</p></div>
            ) : catalog.markdown ? (
              <DesignSpecView source={catalog.markdown} loadingLabel="Đang tải danh mục…" />
            ) : refreshing ? (
              <p className={styles.muted}>Đang đọc component từ Figma…</p>
            ) : (
              <div className={styles.empty}><p>Chưa có danh mục. Bấm <strong>Đọc lại từ Figma</strong>.</p></div>
            )}
            {catalog.guideMarkdown ? (
              <details className={styles.guideDetails}>
                <summary className={styles.guideSummary}>Mô tả AI sinh (components-guide.md)</summary>
                <DesignSpecView source={catalog.guideMarkdown} loadingLabel="Đang tải mô tả AI sinh…" />
              </details>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function AppDesignSystemView({ appId, designSystemId }: { appId: string; designSystemId?: string | null }) {
  const [view, setView] = useState<View>('showcase');
  const [system, setSystem] = useState<DesignSystemSummary | null>(null);
  const [reactInfo, setReactInfo] = useState<DesignSystemReactInfo | null | undefined>(undefined);
  const [criteria, setCriteria] = useState<DesignSystemFileDetail | null | undefined>(undefined);
  const [showcaseError, setShowcaseError] = useState(false);

  useEffect(() => {
    setView('showcase');
    setSystem(null);
    setReactInfo(undefined);
    setCriteria(undefined);
    setShowcaseError(false);
    if (!designSystemId) return;
    let alive = true;
    void Promise.all([fetchDesignSystems(), fetchDesignSystemReactInfo(designSystemId)]).then(([systems, info]) => {
      if (!alive) return;
      setSystem(systems.find((item) => item.id === designSystemId) ?? null);
      setReactInfo(info);
    });
    return () => { alive = false; };
  }, [appId, designSystemId]);

  useEffect(() => {
    if (!designSystemId || view !== 'criteria') return;
    let alive = true;
    void fetchDesignSystemCriteriaFile(designSystemId).then((result) => {
      if (!alive) return;
      setCriteria('error' in result ? null : result);
    });
    return () => { alive = false; };
  }, [designSystemId, view]);

  const title = system?.title ?? designSystemId ?? 'Design System';
  const componentCount = useMemo(
    () => criteria?.content.match(/^###\s+`/gm)?.length ?? 0,
    [criteria],
  );

  if (!designSystemId) {
    return <section className={styles.section} aria-label="Design System"><p className={styles.empty}>Dự án chưa chọn Design System. Chọn DS ở <strong>Sửa dự án</strong>.</p></section>;
  }

  return (
    <section className={styles.section} aria-label="Design System">
      <div className={styles.header}>
        <div><h2 className={styles.heading}>{title}</h2><p className={styles.muted}>Design System gắn cho dự án này.</p></div>
      </div>
      <div className={styles.modeBar} role="tablist" aria-label="Nội dung Design System">
        <button type="button" role="tab" aria-selected={view === 'showcase'} className={`${styles.modeButton}${view === 'showcase' ? ` ${styles.modeButtonActive}` : ''}`} onClick={() => setView('showcase')}>Showcase</button>
        <button type="button" role="tab" aria-selected={view === 'criteria'} className={`${styles.modeButton}${view === 'criteria' ? ` ${styles.modeButtonActive}` : ''}`} onClick={() => setView('criteria')}>Danh mục component</button>
      </div>
      {view === 'showcase' ? (
        <div className={styles.frameWrap}>
          {showcaseError || reactInfo === null ? <p className={styles.empty}>DS này không phải bản nạp từ Figma nên không có showcase.</p> : <iframe className={styles.frame} title={`${title} showcase`} src={`/api/design-systems/${encodeURIComponent(designSystemId)}/showcase`} onError={() => setShowcaseError(true)} />}
        </div>
      ) : (
        <div className={styles.criteriaWrap}>
          <div className={styles.criteriaHead}><h3 className={styles.subheading}>Danh mục component</h3>{criteria ? <p className={styles.meta}>{componentCount} component · {criteria.updatedAt ? new Date(criteria.updatedAt).toLocaleString('vi-VN') : 'chưa rõ thời gian cập nhật'}</p> : null}</div>
          {criteria === undefined ? <p className={styles.muted}>Đang tải danh mục…</p> : criteria === null ? <div className={styles.empty}><p>Chưa có danh mục. Danh mục sinh tự động khi nạp DS Figma; vào trang Design System bấm <strong>Sinh lại</strong>.</p><p className={styles.muted}>Đây là danh mục bước “Màn hình → Component” dùng để đối chiếu.</p></div> : <DesignSpecView source={criteria.content} loadingLabel="Đang tải danh mục…" />}
        </div>
      )}
    </section>
  );
}
