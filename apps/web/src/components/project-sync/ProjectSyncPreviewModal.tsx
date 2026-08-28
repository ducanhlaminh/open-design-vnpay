import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectSyncApplyResult,
  ProjectSyncOperation,
  ProjectSyncOriginSelection,
  ProjectSyncPlan,
  ProjectSyncResolution,
  ProjectSyncScope,
} from '@open-design/contracts';

import {
  ProjectSyncPlanExpiredError,
  createProjectSyncOperation,
  getProjectSyncOperation,
  planProjectSync,
  preflightProjectSyncConfluence,
  waitForProjectSyncOperation,
} from '../../providers/project-sync';
import { Icon } from '../Icon';
import { PlModal } from '../pipelines/PlModal';
import {
  ConfluencePreflightPanel,
  confluencePreflightBlocksPull,
  describeConfluencePullOutcome,
  type ConfluencePreflightState,
} from './ConfluencePreflightPanel';
import { SyncPreviewTree } from './SyncPreviewTree';
import { SyncSummary } from './SyncSummary';
import styles from './ProjectSyncPreview.module.css';

export interface ProjectSyncPreviewModalProps {
  scope: ProjectSyncScope;
  /** User-facing App/Feature name, used only in the dialog copy. */
  subjectName: string;
  /** Explicit origin to plan against. Needed the first time a scope is
   *  pulled — before it has a local `_studio/project-sync-mapping.json`,
   *  the daemon has nothing to infer the origin from. Once that first
   *  apply succeeds the mapping is written, so later opens can omit this. */
  origin?: ProjectSyncOriginSelection;
  onClose: () => void;
  /** Caller refreshes cards/navigation after an accepted APPLY. */
  onApplied?: (result: ProjectSyncApplyResult) => void;
}

/** Pull-only preview: sharing now uses the common `PushAllModal` everywhere. */
export function ProjectSyncPreviewModal({ scope, subjectName, origin, onClose, onApplied }: ProjectSyncPreviewModalProps) {
  const [plan, setPlan] = useState<ProjectSyncPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ProjectSyncResolution>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [operation, setOperation] = useState<ProjectSyncOperation | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ConfluencePreflightState>({ status: 'idle' });
  const [confluenceWarnings, setConfluenceWarnings] = useState<string[]>([]);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const planRef = useRef<ProjectSyncPlan | null>(null);
  const loadGenerationRef = useRef(0);
  const preflightGenerationRef = useRef(0);
  const applyGenerationRef = useRef(0);
  const applyAbortRef = useRef<AbortController | null>(null);
  const completedOperationIdsRef = useRef(new Set<string>());
  const completedSuccessfullyRef = useRef(false);

  // Callers commonly construct these objects inline. Depending on their object
  // identity caused every unrelated parent poll to discard the current tree and
  // start a new PLAN request. Rebuild stable request values from primitives so an
  // equal-valued rerender is a no-op.
  const requestScope = useMemo<ProjectSyncScope>(() => ({
    kind: scope.kind,
    projectId: scope.projectId,
    ...(scope.appId !== undefined ? { appId: scope.appId } : {}),
  }), [scope.appId, scope.kind, scope.projectId]);
  const requestOrigin = useMemo<ProjectSyncOriginSelection | undefined>(() => {
    if (!origin) return undefined;
    if (origin.mode === 'existing') return { mode: 'existing', originId: origin.originId };
    return {
      mode: 'new',
      originId: origin.originId,
      ...(origin.name !== undefined ? { name: origin.name } : {}),
    };
  }, [origin?.mode, origin?.originId, origin?.mode === 'new' ? origin.name : undefined]);

  // Confluence-backed files are re-downloaded from the wiki on THIS machine,
  // so the daemon checks PAT / base / space rights per plan. Only called when
  // the plan actually carries such entries; the Pull button stays blocked
  // until the check passes.
  const runPreflight = useCallback(async (planId: string) => {
    const generation = ++preflightGenerationRef.current;
    setPreflight({ status: 'loading' });
    try {
      const result = await preflightProjectSyncConfluence({ planId });
      if (generation !== preflightGenerationRef.current) return;
      setPreflight({ status: 'ready', preflight: result });
    } catch (cause) {
      if (generation !== preflightGenerationRef.current) return;
      if (cause instanceof ProjectSyncPlanExpiredError) {
        setPreflight({ status: 'idle' });
        setExpired(true);
        return;
      }
      setPreflight({ status: 'error', message: cause instanceof Error ? cause.message : 'Không thể kiểm tra quyền truy cập Confluence.' });
    }
  }, []);

  const load = useCallback(async (replacePlan: boolean) => {
    const generation = ++loadGenerationRef.current;
    const hasPlan = planRef.current !== null;
    setLoading(replacePlan || !hasPlan);
    setRefreshing(!replacePlan && hasPlan);
    setError(null);
    setExpired(false);
    setConfluenceWarnings([]);
    if (replacePlan) {
      planRef.current = null;
      setPlan(null);
      setResolutions({});
      preflightGenerationRef.current += 1;
      setPreflight({ status: 'idle' });
    }
    try {
      const nextPlan = await planProjectSync({
        direction: 'pull',
        scope: requestScope,
        origin: requestOrigin,
        includeDeleted: true,
      });
      if (generation !== loadGenerationRef.current) return;
      planRef.current = nextPlan;
      setPlan(nextPlan);
      setResolutions(Object.fromEntries(nextPlan.entries.map((entry) => [entry.path, entry.resolution])));
      if ((nextPlan.summary.confluence?.files ?? 0) > 0) {
        void runPreflight(nextPlan.planId);
      } else {
        preflightGenerationRef.current += 1;
        setPreflight({ status: 'idle' });
      }
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Không thể tải phần xem trước đồng bộ.');
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [requestOrigin, requestScope, runPreflight]);

  useEffect(() => {
    void load(true);
    return () => {
      loadGenerationRef.current += 1;
      preflightGenerationRef.current += 1;
      applyGenerationRef.current += 1;
      applyAbortRef.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    if (expired || error) reloadRef.current?.focus();
  }, [error, expired]);

  const finishOperation = (next: ProjectSyncOperation, generation: number): boolean => {
    if (generation !== applyGenerationRef.current) return true;
    setOperation(next);
    if (next.state === 'queued' || next.state === 'running') return false;
    setApplying(false);
    if (next.state === 'failed') {
      setError(next.error?.message ?? 'Đồng bộ không thành công. Bạn có thể thử lại.');
      return true;
    }
    if (!next.result) {
      setError('Đồng bộ đã kết thúc nhưng máy chủ không trả về kết quả.');
      return true;
    }
    if (completedOperationIdsRef.current.has(next.operationId)) return true;
    completedOperationIdsRef.current.add(next.operationId);
    completedSuccessfullyRef.current = true;
    onApplied?.(next.result);
    // Wiki files that drifted or could not be fetched are not `stale` (the
    // mapping is persisted) but the user must see which files to re-check.
    const warnings = describeConfluencePullOutcome(next.result.confluence);
    setConfluenceWarnings(warnings);
    if (next.result.stale.length > 0) {
      setError(`Có ${next.result.stale.length} mục đã thay đổi sau khi lập kế hoạch. Hãy tải lại để xem kế hoạch mới.`);
      return true;
    }
    if (warnings.length > 0) return true;
    onClose();
    return true;
  };

  const apply = async () => {
    if (!plan || completedSuccessfullyRef.current) return;
    const generation = ++applyGenerationRef.current;
    applyAbortRef.current?.abort();
    const controller = new AbortController();
    applyAbortRef.current = controller;
    setApplying(true);
    setOperation(null);
    setError(null);
    setExpired(false);
    try {
      const initial = await createProjectSyncOperation({ planId: plan.planId, resolutions });
      const next = await waitForProjectSyncOperation(initial, getProjectSyncOperation, {
        signal: controller.signal,
        onUpdate: (update) => {
          if (generation !== applyGenerationRef.current) return;
          setError(null);
          setOperation(update);
        },
        onTransientError: (pollError) => {
          if (generation === applyGenerationRef.current && pollError) setError(`${pollError.message} Đang thử lại…`);
        },
      });
      finishOperation(next, generation);
    } catch (cause) {
      if (generation !== applyGenerationRef.current) return;
      if (controller.signal.aborted) return;
      if (cause instanceof ProjectSyncPlanExpiredError) setExpired(true);
      else setError(cause instanceof Error ? cause.message : 'Không thể áp dụng đồng bộ.');
      setApplying(false);
    } finally {
      if (applyAbortRef.current === controller) applyAbortRef.current = null;
    }
  };

  const operationItem = operation?.progress.currentFeatureId ?? operation?.progress.currentPath;
  const phaseLabel = operation?.phase === 'validating'
    ? 'Đang kiểm tra kế hoạch'
    : operation?.phase === 'finalizing'
      ? 'Đang hoàn tất'
      : 'Đang tải dữ liệu';

  const title = `Lấy dự án về máy · ${subjectName}`;
  const confluenceFiles = plan?.summary.confluence?.files ?? 0;
  const confluenceBytes = plan?.summary.confluence?.bytes ?? 0;
  const confluenceRequired = confluenceFiles > 0;
  const pullBlockedByConfluence = confluencePreflightBlocksPull(confluenceRequired, preflight);
  const completed = completedSuccessfullyRef.current;

  const footer = (
    <div className={styles.footer}>
      <span className={styles.footerNote} aria-live="polite">
        {applying && operation
          ? `${operation.progress.completedItems}/${operation.progress.totalItems} mục · ${operation.progress.percent}%`
          : plan ? `${plan.summary.changed + plan.summary.created + plan.summary.deleted} mục sẽ được cập nhật` : 'Xem trước nội dung trước khi cập nhật'}
      </span>
      <div className={styles.footerActions}>
        <button type="button" className="pl-btn" onClick={onClose} disabled={applying}>{completed ? 'Đóng' : 'Hủy'}</button>
        <button
          type="button"
          className="pl-btn pl-btn--primary"
          onClick={() => void apply()}
          title={pullBlockedByConfluence && !applying ? 'Cần PAT và quyền truy cập Confluence để tải tài liệu wiki về máy.' : undefined}
          disabled={!plan || loading || refreshing || applying || expired || completed || pullBlockedByConfluence}
        >
          <Icon name={applying ? 'spinner' : 'download'} size={14} />
          {applying ? `Đang lấy về${operation ? ` · ${operation.progress.percent}%` : '…'}` : 'Lấy dự án về máy'}
        </button>
      </div>
    </div>
  );

  return (
    <PlModal title={title} icon="download" size="lg" busy={applying} onClose={onClose} footer={footer}>
      <div className={styles.modal}>
        {loading ? <div className={styles.loading} role="status">Đang tải trạng thái và bản trong kho chung…</div> : null}
        {refreshing ? <div className={styles.loading} role="status">Đang làm mới bản xem trước…</div> : null}
        {operation ? (
          <div className={styles.progressPanel} aria-live="polite">
            <div className={styles.progressMeta}>
              <strong>{phaseLabel}</strong>
              <span>{operation.progress.completedItems}/{operation.progress.totalItems} mục · {operation.progress.percent}%</span>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="Tiến độ lấy dự án về máy"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={operation.progress.percent}
            >
              <span style={{ width: `${operation.progress.percent}%` }} />
            </div>
            {operationItem ? <div className={styles.progressItem} title={operationItem}>{operationItem}</div> : null}
          </div>
        ) : null}
        {plan ? (
          <fieldset className={styles.previewContent} disabled={applying} aria-busy={applying}>
            <SyncSummary summary={plan.summary} />
            <SyncPreviewTree plan={plan} resolutions={resolutions} onResolutionChange={(path, resolution) => setResolutions((current) => ({ ...current, [path]: resolution }))} />
          </fieldset>
        ) : null}
        {plan && confluenceRequired ? (
          <ConfluencePreflightPanel
            files={confluenceFiles}
            bytes={confluenceBytes}
            state={preflight}
            disabled={applying || expired || completed}
            onRecheck={() => void runPreflight(plan.planId)}
          />
        ) : null}
        {confluenceWarnings.length > 0 ? (
          <div className={styles.notice} role="alert" data-testid="project-sync-confluence-warnings">
            <Icon name="info" size={15} />
            <ul>{confluenceWarnings.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
        {!loading && !error && !plan ? <p className={styles.empty}>Chưa có thay đổi nào để xem trước.</p> : null}
        {expired ? <div className={styles.error} role="alert"><Icon name="refresh" size={15} /><span>Kế hoạch đã hết hạn. Tải lại để nhận ảnh chụp mới trước khi áp dụng.</span><button ref={reloadRef} type="button" className="pl-btn pl-btn--xs" onClick={() => void load(false)}>Tải lại xem trước</button></div> : null}
        {error ? <div className={styles.error} role="alert"><Icon name="info" size={15} /><span>{error}</span><button ref={reloadRef} type="button" className="pl-btn pl-btn--xs" onClick={() => void load(false)}>Tải lại</button></div> : null}
      </div>
    </PlModal>
  );
}
