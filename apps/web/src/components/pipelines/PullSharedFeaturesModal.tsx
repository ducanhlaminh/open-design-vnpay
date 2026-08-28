import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectSyncFeaturePullBatchOperation,
  ProjectSyncFeaturePullBatchPlan,
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
  validating: 'Đang kiểm tra',
  transferring: 'Đang tải dữ liệu',
  finalizing: 'Đang hoàn tất',
};

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
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ConfluencePreflightState>({ status: 'idle' });
  const completionReported = useRef(false);
  const preflightGeneration = useRef(0);

  const resetPreflight = useCallback(() => {
    preflightGeneration.current += 1;
    setPreflight({ status: 'idle' });
  }, []);

  const runPreflight = useCallback(async (batchPlanId: string) => {
    const generation = ++preflightGeneration.current;
    setPreflight({ status: 'loading' });
    try {
      const next = await preflightProjectSyncConfluence({ batchPlanId });
      if (generation !== preflightGeneration.current) return;
      setPreflight({ status: 'ready', preflight: next });
    } catch (cause) {
      if (generation !== preflightGeneration.current) return;
      setPreflight({ status: 'error', message: errorMessage(cause, 'Không thể kiểm tra quyền truy cập Confluence.') });
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
  const busy = loadingPlan || operationActive(operation);
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
      // pressing the primary action resumes the idempotent operation.
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

  const createPlan = async () => {
    if (selectedIds.length === 0) return;
    setLoadingPlan(true);
    setError(null);
    try {
      const next = await planProjectSyncFeaturePullBatch({
        localAppId,
        originAppId: remoteAppOriginId,
        originFeatureIds: selectedIds,
      });
      setPlan(next);
      if (confluenceTotalsOf(next).files > 0) void runPreflight(next.planId);
      else resetPreflight();
    } catch (cause) {
      setError(errorMessage(cause, 'Không thể lập kế hoạch lấy tính năng.'));
    } finally {
      setLoadingPlan(false);
    }
  };

  const start = async () => {
    if (!plan) return;
    setError(null);
    try {
      setOperation(await createProjectSyncFeaturePullBatchOperation({ planId: plan.planId }));
    } catch (cause) {
      setError(errorMessage(cause, 'Không thể bắt đầu lấy tính năng.'));
    }
  };

  const retryFailed = async () => {
    if (!operation || failedItems.length === 0) return;
    setError(null);
    try {
      setOperation(await retryProjectSyncFeaturePullBatchOperation(operation.operationId));
    } catch (cause) {
      setError(errorMessage(cause, 'Không thể thử lại các tính năng bị lỗi.'));
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
      {!plan ? (
        <button type="button" className="pl-btn pl-btn--primary" disabled={busy || selectedIds.length === 0} onClick={() => void createPlan()}>
          {loadingPlan ? <Icon name="spinner" size={14} /> : null} Xem trước
        </button>
      ) : (
        <button
          type="button"
          className="pl-btn pl-btn--primary"
          disabled={busy || pullBlockedByConfluence}
          title={pullBlockedByConfluence && !busy ? 'Cần PAT và quyền truy cập Confluence để tải tài liệu wiki về máy.' : undefined}
          onClick={() => void start()}
        >
          {operationActive(operation) ? <Icon name="spinner" size={14} /> : <Icon name="download" size={14} />}
          Lấy {plan.features.length} tính năng
        </button>
      )}
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

        {progress ? (
          <section className={styles.progress} aria-label="Tiến độ lấy tính năng">
            <div className={styles.progressHead}>
              <strong>{PHASE_LABEL[operation!.phase]}</strong>
              <span>{progress.percent}% · {progress.completedItems}/{progress.totalItems}</span>
            </div>
            <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            {progress.currentFeatureId || progress.currentPath ? (
              <p className={styles.current}>
                {progress.currentFeatureId ? `Tính năng: ${progress.currentFeatureId}` : ''}
                {progress.currentFeatureId && progress.currentPath ? ' · ' : ''}
                {progress.currentPath ?? ''}
              </p>
            ) : null}
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
                      <span className={styles.count}>{itemPlan.entries.length} mục · {itemPlan.mode === 'create' ? 'Tạo mới' : 'Cập nhật'}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        {plan ? (
          <section className={styles.preview} aria-label="Tóm tắt nội dung sẽ lấy">
            <div className={styles.sectionHead}><strong>Nội dung sẽ lấy</strong><span>{plan.totalItems} mục</span></div>
            <div className={styles.summaryGrid}>
              <span><b>{plan.features.reduce((n, item) => n + item.summary.created, 0)}</b> tạo mới</span>
              <span><b>{plan.features.reduce((n, item) => n + item.summary.changed, 0)}</b> thay đổi</span>
              <span><b>{plan.features.reduce((n, item) => n + item.summary.unchanged, 0)}</b> không đổi</span>
              <span><b>{plan.features.reduce((n, item) => n + item.summary.deleted, 0)}</b> đã xóa</span>
            </div>
          </section>
        ) : null}

        {plan && confluenceTotals.files > 0 && !terminalResult ? (
          <ConfluencePreflightPanel
            files={confluenceTotals.files}
            bytes={confluenceTotals.bytes}
            state={preflight}
            disabled={busy}
            onRecheck={() => void runPreflight(plan.planId)}
          />
        ) : null}

      </div>
    </PlModal>
  );
}
