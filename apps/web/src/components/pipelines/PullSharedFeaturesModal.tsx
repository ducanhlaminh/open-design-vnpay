import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectSyncFeaturePullBatchOperation,
  ProjectSyncFeaturePullBatchPlan,
  ProjectSyncFeaturePullBatchPlanItem,
  ProjectSyncFeaturePullBatchResult,
  ProjectSyncOperationPhase,
  ProjectSyncOrigin,
} from '@open-design/contracts';

import {
  createProjectSyncFeaturePullBatchOperation,
  getProjectSyncFeaturePullBatchOperation,
  listProjectSyncOrigins,
  planProjectSyncFeaturePullBatch,
  preflightProjectSyncConfluence,
  retryProjectSyncFeaturePullBatchOperation,
  waitForProjectSyncOperation,
} from '../../providers/project-sync';
import { Icon } from '../Icon';
import {
  ConfluencePreflightPanel,
  confluencePreflightBlocksPull,
  describeConfluencePullOutcome,
  describeSyncProgressPath,
  mergeConfluencePullOutcomes,
  summarizeConfluencePullOutcome,
  type ConfluencePreflightState,
} from '../project-sync/ConfluencePreflightPanel';
import { PlModal } from './PlModal';
import styles from './PullSharedFeaturesModal.module.css';

/** Wiki-backed file totals across the selected Features. Falls back to the
 *  entries when a plan item carries no `summary.confluence`. */
function confluenceTotalsOf(plan: ProjectSyncFeaturePullBatchPlan): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const feature of plan.features) {
    if (feature.summary.confluence) {
      files += feature.summary.confluence.files;
      bytes += feature.summary.confluence.bytes;
      continue;
    }
    for (const entry of feature.entries) {
      if (!entry.confluence) continue;
      files += 1;
      bytes += entry.local?.size ?? entry.origin?.size ?? 0;
    }
  }
  return { files, bytes };
}

function confluenceWarningsOf(result: ProjectSyncFeaturePullBatchResult, origins: readonly ProjectSyncOrigin[] | null): string[] {
  return result.items.flatMap((item) => {
    if (item.state !== 'succeeded') return [];
    const name = origins?.find((origin) => origin.originId === item.originId)?.name ?? item.localId;
    return describeConfluencePullOutcome(item.result.confluence, name);
  });
}

const PHASE_LABEL: Record<ProjectSyncOperationPhase, string> = {
  validating: 'Đang kiểm tra kế hoạch…',
  transferring: 'Đang tải dữ liệu',
  finalizing: 'Đang hoàn tất',
};

/** Stage của một entry output trong batch plan. Path entry là path tương đối
 *  trong feature có prefix đơn vị (`feature/<rel>`); stage do daemon gắn sẵn
 *  (`stageForOutput`) — chỉ fallback sang segment đầu của path khi thiếu. */
function stageOfEntry(entry: { stage?: string; path: string }): string {
  if (entry.stage) return entry.stage;
  const segments = entry.path.split('/').filter(Boolean);
  if (segments[0] === 'feature') segments.shift();
  if (segments[0] === 'features' && segments.length > 2) segments.splice(0, 2);
  return segments.length > 1 ? segments[0]! : 'khác';
}

/** Per-row sau khi plan: chỉ đếm output sẽ thay đổi, breakdown theo stage.
 *  0 output thay đổi → chỉ còn tài liệu/cấu hình (context/binding). */
function planItemLabelOf(item: ProjectSyncFeaturePullBatchPlanItem): string {
  const modeLabel = item.mode === 'create' ? 'Tạo mới' : 'Cập nhật';
  const changed = item.entries.filter((entry) => entry.change !== 'unchanged');
  if (changed.length === 0) return 'Không có thay đổi';
  const outputs = changed.filter((entry) => entry.kind === 'output');
  if (outputs.length === 0) return `Chỉ tài liệu/cấu hình · ${modeLabel}`;
  const byStage = new Map<string, number>();
  for (const entry of outputs) {
    const stage = stageOfEntry(entry);
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
  }
  return `${[...byStage].map(([stage, count]) => `${stage} ${count}`).join(' · ')} · ${modeLabel}`;
}

function confluenceSummaryOf(result: ProjectSyncFeaturePullBatchResult): string | null {
  return summarizeConfluencePullOutcome(mergeConfluencePullOutcomes(
    result.items.map((item) => (item.state === 'succeeded' ? item.result.confluence : undefined)),
  ));
}

export interface PullSharedFeaturesModalProps {
  localAppId: string;
  remoteAppOriginId: string;
  /** Reverse mapping from shared origin id to the local Feature id. */
  existingFeatureMappings?: ReadonlyMap<string, string>;
  preselectedOriginIds?: readonly string[];
  onClose: () => void;
  onCompleted: (result: ProjectSyncFeaturePullBatchResult) => void;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function operationActive(operation: ProjectSyncFeaturePullBatchOperation | null): boolean {
  return operation?.state === 'queued' || operation?.state === 'running';
}

export function PullSharedFeaturesModal({
  localAppId,
  remoteAppOriginId,
  existingFeatureMappings = new Map(),
  preselectedOriginIds = [],
  onClose,
  onCompleted,
}: PullSharedFeaturesModalProps) {
  const [origins, setOrigins] = useState<ProjectSyncOrigin[] | null>(null);
  const [selected, setSelected] = useState(() => new Set(preselectedOriginIds));
  const [plan, setPlan] = useState<ProjectSyncFeaturePullBatchPlan | null>(null);
  const [operation, setOperation] = useState<ProjectSyncFeaturePullBatchOperation | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ConfluencePreflightState>({ status: 'idle' });
  const completionReported = useRef(false);
  const preflightGeneration = useRef(0);

  const resetPreflight = useCallback(() => {
    preflightGeneration.current += 1;
    setPreflight({ status: 'idle' });
  }, []);

  /** Trả `true` = pass (chạy tiếp apply), `false` = chặn (panel hiện lỗi +
   *  "Kiểm tra lại"), `null` = kết quả đã cũ (generation khác). */
  const runPreflight = useCallback(async (batchPlanId: string): Promise<boolean | null> => {
    const generation = ++preflightGeneration.current;
    setPreflight({ status: 'loading' });
    try {
      const next = await preflightProjectSyncConfluence({ batchPlanId });
      if (generation !== preflightGeneration.current) return null;
      setPreflight({ status: 'ready', preflight: next });
      return next.ok;
    } catch (cause) {
      if (generation !== preflightGeneration.current) return null;
      setPreflight({ status: 'error', message: errorMessage(cause, 'Không thể kiểm tra quyền truy cập Confluence.') });
      return false;
    }
  }, []);

  useEffect(() => () => { preflightGeneration.current += 1; }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    void listProjectSyncOrigins({ kind: 'feature', appId: remoteAppOriginId })
      .then((list) => {
        if (!alive) return;
        const visible = list.filter((origin) => (
          origin.kind === 'feature'
          && origin.visibility === 'visible'
          && origin.appId === remoteAppOriginId
        ));
        setOrigins(visible);
        const ids = new Set(visible.map((origin) => origin.originId));
        setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause, 'Không thể tải danh sách tính năng.'));
      });
    return () => { alive = false; };
  }, [remoteAppOriginId]);

  const selectedIds = useMemo(
    () => (origins ?? []).filter((origin) => selected.has(origin.originId)).map((origin) => origin.originId),
    [origins, selected],
  );
  const busy = loadingPlan || starting || operationActive(operation);
  const terminalResult = operation?.state === 'succeeded' ? operation.result : undefined;
  const failedItems = terminalResult?.items.filter((item) => item.state === 'failed') ?? [];
  const displayedError = error ?? (operation?.state === 'failed'
    ? operation.error?.message ?? 'Tiến trình lấy tính năng thất bại.'
    : null);

  const confluenceWarnings = useMemo(
    () => (terminalResult ? confluenceWarningsOf(terminalResult, origins) : []),
    [origins, terminalResult],
  );

  useEffect(() => {
    if (!operation || operation.state !== 'succeeded' || !operation.result) return;
    if (operation.result.state !== 'succeeded' || completionReported.current) return;
    completionReported.current = true;
    onCompleted(operation.result);
    // Keep the dialog open when wiki files drifted or went missing so the
    // user sees which ones; the footer "Hoàn tất" button closes it.
    if (confluenceWarningsOf(operation.result, origins).length > 0) return;
    onClose();
  }, [onClose, onCompleted, operation, origins]);

  useEffect(() => {
    if (!operationActive(operation) || !operation) return;
    const controller = new AbortController();
    void waitForProjectSyncOperation(operation, getProjectSyncFeaturePullBatchOperation, {
      signal: controller.signal,
      onUpdate: (next) => {
        setError(null);
        setOperation(next);
      },
      onTransientError: (pollError) => {
        if (pollError) setError(`${pollError.message} Đang thử lại…`);
      },
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      const message = errorMessage(cause, 'Không thể đọc tiến độ lấy tính năng.');
      setError(message);
      // The server operation can still be running after a client/network
      // timeout. Mark only the local snapshot as failed so the modal unlocks;
      // pressing the primary action re-runs the pull from a fresh plan.
      setOperation((current) => current ? {
        ...current,
        state: 'failed',
        error: { code: 'CLIENT_PROGRESS_TIMEOUT', message, retryable: true },
      } : current);
    });
    return () => {
      controller.abort();
    };
  }, [operation?.operationId]);

  const toggle = useCallback((originId: string) => {
    if (busy || operation?.state === 'succeeded') return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(originId)) next.delete(originId);
      else next.add(originId);
      return next;
    });
    setPlan(null);
    setError(null);
    resetPreflight();
  }, [busy, operation?.state, resetPreflight]);

  const start = async (target: ProjectSyncFeaturePullBatchPlan) => {
    setError(null);
    setStarting(true);
    try {
      setOperation(await createProjectSyncFeaturePullBatchOperation({ planId: target.planId }));
    } catch (cause) {
      setError(errorMessage(cause, 'Không thể bắt đầu lấy tính năng.'));
    } finally {
      setStarting(false);
    }
  };

  // Một mạch plan → preflight Confluence (chỉ khi plan có file wiki) → start.
  // Lỗi giữa chừng (plan lỗi, apply failed, plan hết hạn) hiện lỗi và nút pull
  // chạy lại từ một plan mới. `pullGeneration` vô hiệu chuỗi cũ khi user đổi
  // lựa chọn hoặc modal unmount giữa chừng.
  const pullGeneration = useRef(0);
  useEffect(() => () => { pullGeneration.current += 1; }, []);
  const pull = async () => {
    if (selectedIds.length === 0) return;
    const generation = ++pullGeneration.current;
    setLoadingPlan(true);
    setError(null);
    setOperation(null);
    setPlan(null);
    resetPreflight();
    let next: ProjectSyncFeaturePullBatchPlan;
    try {
      next = await planProjectSyncFeaturePullBatch({
        localAppId,
        originAppId: remoteAppOriginId,
        originFeatureIds: selectedIds,
      });
    } catch (cause) {
      if (generation !== pullGeneration.current) return;
      setError(errorMessage(cause, 'Không thể lập kế hoạch lấy tính năng.'));
      setLoadingPlan(false);
      return;
    }
    if (generation !== pullGeneration.current) return;
    setPlan(next);
    setLoadingPlan(false);
    if (confluenceTotalsOf(next).files > 0) {
      const ok = await runPreflight(next.planId);
      if (generation !== pullGeneration.current || ok !== true) return;
    }
    await start(next);
  };

  // "Kiểm tra lại" trong panel preflight: pass thì TỰ chạy tiếp apply — chỉ
  // khi chưa có operation nào (sau một operation lỗi, nút pull chạy plan mới).
  const recheck = async () => {
    if (!plan || busy || operation !== null) return;
    const generation = pullGeneration.current;
    const ok = await runPreflight(plan.planId);
    if (ok === true && generation === pullGeneration.current) await start(plan);
  };

  const retryFailed = async () => {
    if (!operation || failedItems.length === 0) return;
    setError(null);
    setStarting(true);
    try {
      setOperation(await retryProjectSyncFeaturePullBatchOperation(operation.operationId));
    } catch (cause) {
      setError(errorMessage(cause, 'Không thể thử lại các tính năng bị lỗi.'));
    } finally {
      setStarting(false);
    }
  };

  const close = useCallback(() => {
    if (
      terminalResult?.state === 'partial'
      && terminalResult.items.some((item) => item.state === 'succeeded')
      && !completionReported.current
    ) {
      completionReported.current = true;
      onCompleted(terminalResult);
    }
    onClose();
  }, [onClose, onCompleted, terminalResult]);

  const progress = operation?.progress;
  // Bar visible from the click until the operation ends; indeterminate while
  // the request is in flight or the daemon is still validating the plan.
  const operationDone = operation !== null && !operationActive(operation);
  const showProgress = starting || progress !== undefined;
  const indeterminate = !operationDone && (!operation || operation.phase === 'validating');
  const progressPercent = operationDone || operation?.phase === 'finalizing' ? 100 : (progress?.percent ?? 0);
  const phaseLabel = operationDone
    ? (operation.state === 'failed' ? 'Lấy tính năng không thành công' : 'Đã hoàn tất')
    : PHASE_LABEL[operation?.phase ?? 'validating'];
  const currentLine = operation && !operationDone && operation.phase === 'transferring'
    ? [
      progress?.currentFeatureId ? `Tính năng: ${progress.currentFeatureId}` : null,
      describeSyncProgressPath(progress?.currentPath),
    ].filter((part): part is string => part !== null).join(' · ')
    : '';
  const confluenceSummary = terminalResult ? confluenceSummaryOf(terminalResult) : null;
  const confluenceTotals = plan ? confluenceTotalsOf(plan) : { files: 0, bytes: 0 };
  const pullBlockedByConfluence = confluencePreflightBlocksPull(confluenceTotals.files > 0, preflight);
  const footer = terminalResult ? (
    <>
      <span className={styles.footerSummary}>
        {terminalResult.items.filter((item) => item.state === 'succeeded').length} thành công
        {failedItems.length ? ` · ${failedItems.length} lỗi` : ''}
      </span>
      {failedItems.length ? (
        <button type="button" className="pl-btn pl-btn--primary" onClick={() => void retryFailed()}>
          <Icon name="reload" size={14} /> Thử lại phần bị lỗi
        </button>
      ) : (
        <button type="button" className="pl-btn pl-btn--primary" onClick={close}>Hoàn tất</button>
      )}
    </>
  ) : (
    <>
      <span className={styles.footerSummary}>{selectedIds.length} tính năng đã chọn</span>
      <button type="button" className="pl-btn" onClick={close} disabled={busy}>Hủy</button>
      <button
        type="button"
        className="pl-btn pl-btn--primary"
        disabled={busy || selectedIds.length === 0 || pullBlockedByConfluence}
        title={pullBlockedByConfluence && !busy ? 'Cần PAT và quyền truy cập Confluence để tải tài liệu wiki về máy.' : undefined}
        onClick={() => void pull()}
      >
        {busy ? <Icon name="spinner" size={14} /> : <Icon name="download" size={14} />}
        Lấy {selectedIds.length} tính năng
      </button>
    </>
  );

  return (
    <PlModal title="Lấy tính năng về máy" icon="download" size="lg" onClose={close} busy={busy} footer={footer}>
      <div className={styles.modal}>
        {displayedError ? <div className={styles.error} role="alert"><Icon name="info" size={15} /><span>{displayedError}</span></div> : null}
        {confluenceWarnings.length > 0 ? (
          <div className={styles.notice} role="alert" data-testid="feature-pull-confluence-warnings">
            <Icon name="info" size={15} />
            <ul>{confluenceWarnings.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}

        {showProgress ? (
          <section className={styles.progress} aria-label="Tiến độ lấy tính năng" data-testid="feature-pull-progress">
            <div className={styles.progressHead}>
              <strong>{phaseLabel}</strong>
              {!indeterminate && progress ? <span>{progress.completedItems}/{progress.totalItems} file · {progressPercent}%</span> : null}
            </div>
            <div
              className={styles.track}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={indeterminate ? undefined : progressPercent}
              aria-valuetext={indeterminate ? 'Đang kiểm tra kế hoạch' : undefined}
              aria-busy={indeterminate || undefined}
              data-indeterminate={indeterminate || undefined}
            >
              <span style={indeterminate ? undefined : { width: `${progressPercent}%` }} />
            </div>
            {currentLine ? <p className={styles.current}>{currentLine}</p> : null}
            {confluenceSummary ? <p className={styles.summaryLine} data-testid="feature-pull-confluence-summary">{confluenceSummary}</p> : null}
          </section>
        ) : null}

        <section className={styles.picker} aria-label="Danh sách tính năng trong kho chung">
          <div className={styles.sectionHead}>
            <strong>Tính năng trong dự án</strong>
            <span>{selectedIds.length}/{origins?.length ?? 0} đã chọn</span>
          </div>
          {origins === null && !error ? <p className={styles.empty} role="status">Đang tải danh sách tính năng…</p> : null}
          {origins?.length === 0 ? <p className={styles.empty}>Dự án này chưa có tính năng được chia sẻ.</p> : null}
          {origins?.length ? (
            <ul className={styles.list}>
              {origins.map((origin) => {
                const localId = existingFeatureMappings.get(origin.originId);
                const itemPlan = plan?.features.find((feature) => feature.originId === origin.originId);
                const itemResult = terminalResult?.items.find((item) => item.originId === origin.originId);
                return (
                  <li key={origin.originId} className={styles.row} data-state={itemResult?.state}>
                    <label className={styles.choice}>
                      <input
                        type="checkbox"
                        checked={selected.has(origin.originId)}
                        disabled={busy || operation?.state === 'succeeded'}
                        onChange={() => toggle(origin.originId)}
                      />
                      <span className={styles.identity}>
                        <strong>{origin.name}</strong>
                        <small>{localId ? `Cập nhật ${localId}` : 'Tạo mới trên máy'}</small>
                      </span>
                    </label>
                    {itemResult ? (
                      <span className={itemResult.state === 'succeeded' ? styles.success : styles.failed}>
                        {itemResult.state === 'succeeded' ? 'Thành công' : itemResult.error.message}
                      </span>
                    ) : itemPlan ? (
                      <span className={styles.count}>{planItemLabelOf(itemPlan)}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        {plan && confluenceTotals.files > 0 && !terminalResult ? (
          <ConfluencePreflightPanel
            files={confluenceTotals.files}
            bytes={confluenceTotals.bytes}
            state={preflight}
            disabled={busy}
            onRecheck={() => void recheck()}
          />
        ) : null}

      </div>
    </PlModal>
  );
}
