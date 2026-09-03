// Modal "Lấy dự án về máy" — không còn bước xem trước: bấm pull là client tự
// chạy chuỗi plan → preflight Confluence (chỉ khi plan có file wiki) → apply
// với resolution mặc định của plan (kho chung thắng khi lệch).
//
// Hai lối vào, một modal:
// - Mode danh sách (props `mappedOriginIds`/`localAppIds`): App chưa có local.
//   Chọn origin chỉ chuẩn bị destination id cho PLAN; không tạo App rỗng —
//   daemon chỉ materialize App + mapping sau khi APPLY hoàn tất sạch, nên
//   Hủy/PLAN lỗi không để lại App mồ côi trong sidebar.
// - Mode một App (props `scope`/`subjectName`): App đã có local, mapping sẵn —
//   plan tự suy origin từ mapping, mở modal là chạy luôn.

import { useEffect, useRef, useState } from 'react';
import type {
  ProjectSyncApplyResult,
  ProjectSyncOperation,
  ProjectSyncOrigin,
  ProjectSyncOriginSelection,
  ProjectSyncPlan,
  ProjectSyncScope,
} from '@open-design/contracts';

import {
  ProjectSyncPlanExpiredError,
  createProjectSyncOperation,
  getProjectSyncOperation,
  listProjectSyncOrigins,
  planProjectSync,
  preflightProjectSyncConfluence,
  waitForProjectSyncOperation,
} from '../../providers/project-sync';
import { Icon } from '../Icon';
import {
  ConfluencePreflightPanel,
  confluencePreflightBlocksPull,
  describeConfluencePullOutcome,
  describeSyncProgressPath,
  summarizeConfluencePullOutcome,
  type ConfluencePreflightState,
} from '../project-sync/ConfluencePreflightPanel';
import { PlModal } from './PlModal';
import { toSlugId } from './newProjectForm';
import styles from './PullSharedAppModal.module.css';

interface PullSharedAppModalBaseProps {
  onClose: () => void;
  /** Caller refreshes cards/navigation after an accepted APPLY. */
  onApplied: (result: ProjectSyncApplyResult) => void;
}

/** App chưa có local: list App chia sẻ, chọn 1 App/lần (backend không có batch cho App). */
export interface PullSharedAppListModeProps extends PullSharedAppModalBaseProps {
  /** originId của các App đã có mapping cục bộ — bị loại khỏi danh sách chọn. */
  mappedOriginIds: ReadonlySet<string>;
  /** App ids đang tồn tại trên máy, dùng để không ghi đè destination. */
  localAppIds: ReadonlySet<string>;
  scope?: never;
  subjectName?: never;
}

/** App đã có local + mapping: plan tự suy origin, mở modal là pull luôn. */
export interface PullSharedAppScopeModeProps extends PullSharedAppModalBaseProps {
  scope: ProjectSyncScope;
  subjectName: string;
  mappedOriginIds?: never;
  localAppIds?: never;
}

export type PullSharedAppModalProps = PullSharedAppListModeProps | PullSharedAppScopeModeProps;

interface PullTarget {
  scope: ProjectSyncScope;
  /** Chỉ mode danh sách cần: scope chưa có mapping để daemon tự suy. */
  origin?: ProjectSyncOriginSelection;
  subjectName: string;
}

const PLAN_EXPIRED_MESSAGE = 'Kế hoạch đã hết hạn. Bấm "Lấy dự án về máy" để chạy lại.';

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function PullSharedAppModal(props: PullSharedAppModalProps) {
  const { onClose, onApplied, scope: scopeProp, subjectName: subjectNameProp, mappedOriginIds, localAppIds } = props;
  const [origins, setOrigins] = useState<ProjectSyncOrigin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pulling, setPulling] = useState<PullTarget | null>(() => (
    scopeProp ? { scope: scopeProp, subjectName: subjectNameProp ?? '' } : null
  ));
  const [plan, setPlan] = useState<ProjectSyncPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [operation, setOperation] = useState<ProjectSyncOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ConfluencePreflightState>({ status: 'idle' });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [completed, setCompleted] = useState(false);
  const runGenerationRef = useRef(0);
  const applyAbortRef = useRef<AbortController | null>(null);
  const completedRef = useRef(false);
  const isListMode = !scopeProp;

  useEffect(() => {
    if (!isListMode) return;
    let alive = true;
    void listProjectSyncOrigins()
      .then((list) => { if (alive) setOrigins(list); })
      .catch((cause) => {
        if (alive) setLoadError(errorMessage(cause, 'Không thể tải danh sách dự án đã chia sẻ.'));
      });
    return () => { alive = false; };
  }, [isListMode]);

  const available = (origins ?? []).filter((origin) => (
    origin.kind === 'app' && !(mappedOriginIds?.has(origin.originId))
  ));

  /** Trả `true` = pass, `false` = chặn (panel hiện lỗi + Kiểm tra lại), `null` = dừng hẳn. */
  const runPreflight = async (planId: string, generation: number): Promise<boolean | null> => {
    setPreflight({ status: 'loading' });
    try {
      const result = await preflightProjectSyncConfluence({ planId });
      if (generation !== runGenerationRef.current) return null;
      setPreflight({ status: 'ready', preflight: result });
      return result.ok;
    } catch (cause) {
      if (generation !== runGenerationRef.current) return null;
      if (cause instanceof ProjectSyncPlanExpiredError) {
        setPreflight({ status: 'idle' });
        setError(PLAN_EXPIRED_MESSAGE);
        return null;
      }
      setPreflight({ status: 'error', message: errorMessage(cause, 'Không thể kiểm tra quyền truy cập Confluence.') });
      return false;
    }
  };

  const apply = async (target: ProjectSyncPlan, generation: number): Promise<void> => {
    applyAbortRef.current?.abort();
    const controller = new AbortController();
    applyAbortRef.current = controller;
    setApplying(true);
    setOperation(null);
    setError(null);
    try {
      // Không gửi resolutions: apply với resolution mặc định của plan.
      const initial = await createProjectSyncOperation({ planId: target.planId });
      const finished = await waitForProjectSyncOperation(initial, getProjectSyncOperation, {
        signal: controller.signal,
        onUpdate: (update) => {
          if (generation !== runGenerationRef.current) return;
          setError(null);
          setOperation(update);
        },
        onTransientError: (pollError) => {
          if (generation === runGenerationRef.current && pollError) setError(`${pollError.message} Đang thử lại…`);
        },
      });
      if (generation !== runGenerationRef.current) return;
      setOperation(finished);
      setApplying(false);
      if (finished.state === 'failed') {
        setError(finished.error?.message ?? 'Đồng bộ không thành công. Bạn có thể thử lại.');
        return;
      }
      if (!finished.result) {
        setError('Đồng bộ đã kết thúc nhưng máy chủ không trả về kết quả.');
        return;
      }
      if (completedRef.current) return;
      completedRef.current = true;
      setCompleted(true);
      onApplied(finished.result);
      // Wiki files bị lệch/không tải được không phải `stale` (mapping đã ghi)
      // nhưng người dùng phải thấy danh sách để kiểm tra lại — giữ modal mở.
      const nextWarnings = describeConfluencePullOutcome(finished.result.confluence);
      setWarnings(nextWarnings);
      if (finished.result.stale.length > 0) {
        setError(`Có ${finished.result.stale.length} mục đã thay đổi sau khi lập kế hoạch. Bấm "Lấy dự án về máy" để chạy lại.`);
        return;
      }
      if (nextWarnings.length > 0) return;
      onClose();
    } catch (cause) {
      if (generation !== runGenerationRef.current || controller.signal.aborted) return;
      if (cause instanceof ProjectSyncPlanExpiredError) setError(PLAN_EXPIRED_MESSAGE);
      else setError(errorMessage(cause, 'Không thể áp dụng đồng bộ.'));
      setApplying(false);
    } finally {
      if (applyAbortRef.current === controller) applyAbortRef.current = null;
    }
  };

  const run = async (target: PullTarget): Promise<void> => {
    const generation = ++runGenerationRef.current;
    applyAbortRef.current?.abort();
    completedRef.current = false;
    setCompleted(false);
    setError(null);
    setWarnings([]);
    setOperation(null);
    setPlan(null);
    setPreflight({ status: 'idle' });
    setPlanning(true);
    let nextPlan: ProjectSyncPlan;
    try {
      nextPlan = await planProjectSync({
        direction: 'pull',
        scope: target.scope,
        ...(target.origin ? { origin: target.origin } : {}),
        includeDeleted: true,
      });
    } catch (cause) {
      if (generation !== runGenerationRef.current) return;
      setPlanning(false);
      setError(errorMessage(cause, 'Không thể lập kế hoạch lấy dự án.'));
      return;
    }
    if (generation !== runGenerationRef.current) return;
    setPlan(nextPlan);
    setPlanning(false);
    if ((nextPlan.summary.confluence?.files ?? 0) > 0) {
      const ok = await runPreflight(nextPlan.planId, generation);
      if (ok !== true) return; // chặn: panel hiện lỗi, "Kiểm tra lại" pass sẽ tự chạy tiếp.
    }
    await apply(nextPlan, generation);
  };

  // Mode một App: mở modal là chạy luôn. Generation ref vô hiệu lần chạy mồ côi
  // của StrictMode double-mount; abort dừng poll đang treo khi unmount.
  useEffect(() => {
    if (!pulling) return;
    void run(pulling);
    return () => {
      runGenerationRef.current += 1;
      applyAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `run` đọc closure mới nhất; chỉ chạy lại khi đổi target.
  }, [pulling]);

  const recheck = async (): Promise<void> => {
    if (!plan || applying || completedRef.current || operation !== null) return;
    const generation = runGenerationRef.current;
    const ok = await runPreflight(plan.planId, generation);
    if (ok === true && generation === runGenerationRef.current) await apply(plan, generation);
  };

  const pick = (origin: ProjectSyncOrigin) => {
    if (!isListMode) return;
    const base = toSlugId(origin.name);
    let appId = base;
    let suffix = 2;
    while (localAppIds?.has(appId)) {
      const tail = `-${suffix++}`;
      appId = `${base.slice(0, 64 - tail.length)}${tail}`;
    }
    setPulling({
      scope: { kind: 'app', projectId: appId },
      origin: { mode: 'existing', originId: origin.originId },
      subjectName: origin.name,
    });
  };

  const operationActive = operation?.state === 'queued' || operation?.state === 'running';
  const busy = planning || applying || operationActive;
  const operationDone = operation !== null && !operationActive;
  const showProgress = planning || applying || operation !== null;
  const indeterminate = !operationDone && (!operation || operation.phase === 'validating');
  const progressPercent = operationDone || operation?.phase === 'finalizing' ? 100 : (operation?.progress.percent ?? 0);
  const progressCount = operation
    ? `${operation.progress.completedItems}/${operation.progress.totalItems} file · ${progressPercent}%`
    : null;
  const phaseLabel = operationDone
    ? (operation.state === 'failed' ? 'Đồng bộ không thành công' : 'Đã hoàn tất')
    : !operation || operation.phase === 'validating'
      ? 'Đang kiểm tra kế hoạch…'
      : operation.phase === 'finalizing'
        ? 'Đang hoàn tất'
        : 'Đang tải dữ liệu';
  const currentLine = operation && !operationDone && operation.phase === 'transferring'
    ? (describeSyncProgressPath(operation.progress.currentPath)
      ?? (operation.progress.currentFeatureId ? `Tính năng: ${operation.progress.currentFeatureId}` : null))
    : null;
  const confluenceSummary = operationDone && operation.state === 'succeeded'
    ? summarizeConfluencePullOutcome(operation.result?.confluence)
    : null;
  // App pull toàn bộ là kind context nên không breakdown theo stage — chỉ đếm
  // các mục sẽ thay đổi trên máy.
  const changedCount = plan ? plan.entries.filter((entry) => entry.change !== 'unchanged').length : 0;
  const confluenceFiles = plan?.summary.confluence?.files ?? 0;
  const confluenceBytes = plan?.summary.confluence?.bytes ?? 0;
  const pullBlockedByConfluence = confluencePreflightBlocksPull(confluenceFiles > 0, preflight);

  const pullingFooter = completed ? (
    <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>Hoàn tất</button>
  ) : (
    <>
      <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>Hủy</button>
      <button
        type="button"
        className="pl-btn pl-btn--primary"
        disabled={busy || pullBlockedByConfluence}
        title={pullBlockedByConfluence && !busy ? 'Cần PAT và quyền truy cập Confluence để tải tài liệu wiki về máy.' : undefined}
        onClick={() => { if (pulling) void run(pulling); }}
      >
        <Icon name={busy ? 'spinner' : 'download'} size={14} />
        Lấy dự án về máy
      </button>
    </>
  );

  if (pulling) {
    return (
      <PlModal
        title={`Lấy dự án về máy · ${pulling.subjectName}`}
        icon="download"
        size="md"
        busy={busy}
        onClose={onClose}
        footer={pullingFooter}
      >
        <div className={styles.modal}>
          {error ? (
            <div className={styles.error} role="alert">
              <Icon name="info" size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          {warnings.length > 0 ? (
            <div className={styles.notice} role="alert" data-testid="project-sync-confluence-warnings">
              <Icon name="info" size={15} />
              <ul>{warnings.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          ) : null}

          {showProgress ? (
            <section className={styles.progress} aria-label="Tiến độ lấy dự án về máy" data-testid="project-sync-progress">
              <div className={styles.progressHead}>
                <strong>{phaseLabel}</strong>
                {!indeterminate && progressCount ? <span>{progressCount}</span> : null}
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
              {currentLine ? <p className={styles.current} title={currentLine}>{currentLine}</p> : null}
              {confluenceSummary ? <p className={styles.summaryLine} data-testid="project-sync-confluence-summary">{confluenceSummary}</p> : null}
            </section>
          ) : null}

          {plan ? (
            <p className={styles.planSummary} data-testid="project-sync-plan-summary">
              Tài liệu dùng chung · {changedCount} mục cập nhật
            </p>
          ) : null}

          {plan && confluenceFiles > 0 && !completed ? (
            <ConfluencePreflightPanel
              files={confluenceFiles}
              bytes={confluenceBytes}
              state={preflight}
              disabled={busy}
              onRecheck={() => void recheck()}
            />
          ) : null}
        </div>
      </PlModal>
    );
  }

  return (
    <PlModal title="Lấy dự án về máy" icon="download" size="md" onClose={onClose}>
      <div className={styles.modal}>
        {loadError ? (
          <div className={styles.error} role="alert">
            <Icon name="info" size={15} />
            <span>{loadError}</span>
          </div>
        ) : null}
        {!loadError && origins === null ? (
          <p className={styles.loading} role="status">Đang tải danh sách dự án đã chia sẻ…</p>
        ) : null}
        {!loadError && origins !== null && available.length === 0 ? (
          <p className={styles.empty}>Chưa có dự án nào khác đã chia sẻ mà máy này chưa có.</p>
        ) : null}
        {available.length > 0 ? (
          <ul className={styles.list}>
            {available.map((origin) => (
              <li key={origin.originId} className={styles.row}>
                <span className={styles.identity}>
                  <strong>{origin.name}</strong>
                  <small>Tạo mới trên máy</small>
                </span>
                <button
                  type="button"
                  className="pl-btn pl-btn--primary pl-btn--xs"
                  onClick={() => pick(origin)}
                >
                  <Icon name="download" size={13} />
                  Lấy về máy
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PlModal>
  );
}
