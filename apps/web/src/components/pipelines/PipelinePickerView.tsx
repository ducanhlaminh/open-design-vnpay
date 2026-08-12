// Pipelines drill-down — Screen 3: pick a pipeline (workflow) for one
// Feature. One card per workflow (`GET /api/workflows`), each showing that
// workflow's OWN progress for this feature (`GET /api/pipelines/projects
// ?workflowId=<id>`, which already scopes done/total/running to the passed
// workflow — see usePipelineNav's header comment on why Screen 1/2 progress
// and per-workflow progress are deliberately separate questions).
//
// Never auto-skips to a single workflow even when only one has data: skipping
// means the user never learns the other workflows exist. Instead the
// workflow with work in progress sorts first and gets an accent ring.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineProjectsResponse, Workflow, WorkflowsResponse } from '@open-design/contracts';

import { Icon, type IconName } from '../Icon';
import { navigate } from '../../router';
import { isFeatureDone } from './usePipelineNav';
import type { PipelineNav } from './usePipelineNav';
import styles from './PipelineNavViews.module.css';

interface Props {
  nav: PipelineNav;
  appId: string;
  featureId: string;
}

// ── "Gần đây" write side — see PipelinesAppsView.tsx for the read side and
// the localStorage shape/key this must stay in lockstep with. ─────────────
const RECENT_KEY = 'od.pipelines.recent';
const RECENT_LIMIT = 3;

interface RecentEntry {
  appId: string;
  featureId: string;
  appName: string;
  featureName: string;
  at: number;
}

function isRecentEntry(x: unknown): x is RecentEntry {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.appId === 'string' &&
    typeof r.featureId === 'string' &&
    typeof r.appName === 'string' &&
    typeof r.featureName === 'string' &&
    typeof r.at === 'number'
  );
}

function recordRecent(entry: Omit<RecentEntry, 'at'>): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const prevArr: unknown = raw ? JSON.parse(raw) : [];
    const prev = Array.isArray(prevArr) ? prevArr.filter(isRecentEntry) : [];
    const next = [
      { ...entry, at: Date.now() },
      ...prev.filter((p) => !(p.appId === entry.appId && p.featureId === entry.featureId)),
    ].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded, disabled storage, or an embedded webview that throws on
    // access — recents are best-effort, drop silently.
  }
}

// ── Per-workflow progress for this feature ──────────────────────────────
type RunningStage = { id: string; name: string; startedAt?: number };
type WfProgress =
  | { status: 'loading' }
  | { status: 'ok'; done: number; total: number; running: number; runningStage?: RunningStage }
  | { status: 'error' };

function hasWorkInProgress(p: WfProgress): boolean {
  return p.status === 'ok' && (p.running > 0 || (p.done > 0 && p.done < p.total));
}

// "N phút" đã trôi kể từ `startedAt`. < 1 phút hiện "vừa xong / dưới 1 phút".
function elapsedMinutes(startedAt: number, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - startedAt) / 60_000);
  return mins < 1 ? 'dưới 1 phút' : `${mins} phút`;
}

function statusLabel(p: WfProgress): string {
  if (p.status === 'loading') return '…';
  if (p.status === 'error') return 'chưa rõ tiến độ';
  if (p.done === 0 && p.running === 0) return 'Chưa chạy';
  if (p.running > 0) return 'Đang chạy';
  if (isFeatureDone(p)) return 'Xong';
  return `${p.done}/${p.total}`;
}

function statusDataAttr(p: WfProgress): 'idle' | 'running' | 'done' {
  if (p.status !== 'ok') return 'idle';
  if (p.running > 0) return 'running';
  if (isFeatureDone(p)) return 'done';
  return 'idle';
}

// Ba luồng có cùng nguồn vào nhưng mục tiêu khác nhau. Giữ phần mô tả ngắn
// tại đây để thẻ dễ quét; mô tả kỹ thuật đầy đủ vẫn nằm trong registry backend.
const WORKFLOW_CARD_COPY: Record<string, { label: string; description: string; icon: IconName }> = {
  'docs-to-ui': {
    label: 'Từ yêu cầu đến giao diện',
    description: 'Tạo hành trình, đặc tả trải nghiệm và bản xem trước giao diện.',
    icon: 'draw',
  },
  'docs-to-prd': {
    label: 'Kiểm tra độ đầy đủ yêu cầu',
    description: 'Đối chiếu URD/PRD, hành trình người dùng và các điểm còn thiếu.',
    icon: 'search',
  },
  'docs-review': {
    label: 'Rà soát chất lượng tài liệu',
    description: 'Kiểm tra nội dung, luồng màn hình và đề xuất chỉnh sửa rõ ràng.',
    icon: 'eye',
  },
};

export function PipelinePickerView({ nav, appId, featureId }: Props): JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, WfProgress>>({});
  // Nhịp đồng hồ để "đã chạy N phút" tự tăng mà không cần refetch. Chỉ chạy
  // khi có ít nhất một workflow đang chạy (bật/tắt ở effect bên dưới).
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setWorkflows(null);
    setWorkflowsError(null);
    setProgress({});
    (async () => {
      try {
        const res = await fetch('/api/workflows');
        const json: WorkflowsResponse | { error?: string } = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string })?.error || `HTTP ${res.status}`);
        const wfs = (json as WorkflowsResponse).workflows ?? [];
        if (cancelled) return;
        setWorkflows(wfs);
        setProgress(Object.fromEntries(wfs.map((w) => [w.id, { status: 'loading' } as WfProgress])));
        // Fan out one progress fetch per workflow, in parallel. Each updates
        // its own card independently — one failing must not block the rest.
        for (const w of wfs) {
          fetch(`/api/pipelines/projects?workflowId=${encodeURIComponent(w.id)}`)
            .then(async (r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const j: PipelineProjectsResponse = await r.json();
              const proj = (j.projects ?? []).find((p) => p.id === featureId);
              if (cancelled) return;
              setProgress((prev) => ({
                ...prev,
                [w.id]: proj
                  ? {
                      status: 'ok',
                      done: proj.done,
                      total: proj.total,
                      running: proj.running,
                      ...(proj.runningStage ? { runningStage: proj.runningStage } : {}),
                    }
                  : { status: 'ok', done: 0, total: 0, running: 0 },
              }));
            })
            .catch(() => {
              if (cancelled) return;
              setProgress((prev) => ({ ...prev, [w.id]: { status: 'error' } }));
            });
        }
      } catch (err) {
        if (cancelled) return;
        setWorkflowsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [featureId]);

  // Có ít nhất một workflow đang chạy (để bật đồng hồ đếm phút).
  const anyRunning = useMemo(
    () => Object.values(progress).some((p) => p.status === 'ok' && p.running > 0),
    [progress],
  );
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const app = nav.appById(appId);
  const feature = nav.featureOf(appId, featureId);

  // Record into "Gần đây" once app + feature are known — guarded so a
  // re-render (progress fetches resolving) doesn't keep bumping the entry.
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current) return;
    if (!nav.loaded || !app || !feature) return;
    recordedRef.current = true;
    recordRecent({
      appId,
      featureId,
      appName: app.unassigned ? 'Chưa gán app' : app.name,
      featureName: feature.name,
    });
  }, [nav.loaded, app, feature, appId, featureId]);

  const sortedWorkflows = useMemo(() => {
    if (!workflows) return [];
    return [...workflows].sort((a, b) => {
      const aWip = hasWorkInProgress(progress[a.id] ?? { status: 'loading' });
      const bWip = hasWorkInProgress(progress[b.id] ?? { status: 'loading' });
      if (aWip !== bWip) return aWip ? -1 : 1;
      return 0;
    });
  }, [workflows, progress]);

  if (nav.loaded && (!app || !feature)) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.headerCopy}>
            <h1 className={styles.title}>Quy trình</h1>
            <p className={styles.lede}>Chọn quy trình để chạy cho tính năng này.</p>
          </div>
        </div>
        <div className={styles.breadcrumb}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => navigate({ kind: 'pipelines-app', appId })}
            aria-label="Quay lại"
            title="Quay lại"
          >
            <Icon name="arrow-left" size={14} />
          </button>
          <button
            type="button"
            className={styles.breadcrumbLink}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            Dự án
          </button>
        </div>
        <div className={styles.notFound}>
          <span>Không tìm thấy tính năng này.</span>
          <button
            type="button"
            className={styles.btn}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            <Icon name="arrow-left" size={14} />
            Về dự án
          </button>
        </div>
      </div>
    );
  }

  const appName = app ? (app.unassigned ? 'Chưa gán app' : app.name) : '';
  const featureName = feature?.name ?? '';
  const featureStatus: 'done' | 'running' | 'idle' = feature
    ? isFeatureDone(feature)
      ? 'done'
      : feature.running > 0
        ? 'running'
        : 'idle'
    : 'idle';
  const featureStatusText = featureStatus === 'done' ? 'Xong' : featureStatus === 'running' ? 'Đang chạy' : 'Chưa chạy';

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumb}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate({ kind: 'pipelines-app', appId })}
          aria-label="Quay lại"
          title="Quay lại"
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          type="button"
          className={styles.breadcrumbLink}
          onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
        >
          Dự án
        </button>
        <span className={styles.breadcrumbSep}>›</span>
        <button
          type="button"
          className={styles.breadcrumbLink}
          onClick={() => navigate({ kind: 'pipelines-app', appId })}
        >
          {appName}
        </button>
        <span className={styles.breadcrumbSep}>›</span>
        <span className={styles.breadcrumbCurrent}>{featureName}</span>
      </div>

      {/* Cùng khung với màn Apps/Features: header trang (tên feature + chip
          trạng thái + mô tả) NGOÀI panel, danh sách quy trình trong panel. */}
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.subHeaderTop}>
            <h1 className={styles.title}>{featureName}</h1>
            <span className={styles.statusChip} data-status={featureStatus}>
              {featureStatusText}
            </span>
          </div>
          <p className={styles.lede}>Chọn quy trình để chạy cho tính năng này.</p>
        </div>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelToolbar}>
          <div className={styles.listHead}>
            <h2 className={styles.listHeadTitle}>Danh sách quy trình</h2>
            <span className={styles.listHeadHint}>
              Mỗi thẻ là một quy trình chạy trên tính năng này — tiến độ được tính riêng cho từng quy trình.
            </span>
          </div>
        </div>

        <div className={styles.panelBody}>
      <aside className={styles.workflowInputCallout} aria-label="Tài liệu đầu vào dùng chung">
        <span className={styles.workflowInputTitle}>Tài liệu đầu vào dùng chung cho 3 workflow</span>
        <span className={styles.workflowInputText}>
          Chọn <strong>URD</strong> của tính năng/sản phẩm làm tài liệu chính (bắt buộc). Có thể chọn thêm
          <strong> PRD</strong> làm tài liệu bổ sung để agent nắm nhanh bối cảnh dự án. Bạn sẽ chọn các tài liệu này
          sau khi bấm Mở workflow.
        </span>
      </aside>
      {workflowsError ? (
        <div className={styles.error}>
          <Icon name="info" size={16} />
          <span>{workflowsError}</span>
        </div>
      ) : workflows === null ? (
        <div className={styles.pipelineGrid} aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- fixed-count skeleton placeholders
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      ) : (
        <div className={styles.pipelineGrid} data-workflow-count={sortedWorkflows.length}>
          {sortedWorkflows.map((wf, index) => {
            const p: WfProgress = progress[wf.id] ?? { status: 'loading' };
            const wip = hasWorkInProgress(p);
            const canStart = p.status === 'ok' && p.done === 0 && p.running === 0;
            const open = () => navigate({ kind: 'pipelines-run', appId, featureId, pipelineId: wf.id });
            const cardCopy = WORKFLOW_CARD_COPY[wf.id];
            return (
              <div
                key={wf.id}
                className={`${styles.pipelineCard} ${wip ? styles.pipelineCardAccent : ''}`}
              >
                <div className={styles.pipelineCardTop}>
                  <span className={styles.pipelineCardIcon} aria-hidden>
                    <Icon name={cardCopy?.icon ?? 'pipeline'} size={18} />
                  </span>
                  <span className={styles.pipelineCardIndex}>0{index + 1}</span>
                </div>
                <div className={styles.pipelineCardHead}>
                  <div className={styles.pipelineCardTitleGroup}>
                    {cardCopy ? <span className={styles.pipelineCardLabel}>{cardCopy.label}</span> : null}
                    <span className={styles.pipelineCardName}>{wf.name}</span>
                  </div>
                  <span className={styles.statusChip} data-status={statusDataAttr(p)}>
                    {statusLabel(p)}
                  </span>
                </div>
                {cardCopy?.description || wf.description ? (
                  <p className={styles.pipelineCardDesc} title={cardCopy?.description ?? wf.description}>
                    {cardCopy?.description ?? wf.description}
                  </p>
                ) : null}
                {p.status === 'ok' && p.running > 0 && p.runningStage ? (
                  <div className={styles.runningNow}>
                    <span className={styles.runningDot} aria-hidden />
                    <span className={styles.runningStageName} title={p.runningStage.name}>
                      {p.runningStage.name}
                    </span>
                    {p.runningStage.startedAt ? (
                      <span className={styles.runningElapsed}>
                        · {elapsedMinutes(p.runningStage.startedAt, now)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className={styles.pipelineCardFoot}>
                  <span className={styles.pipelineCardCount}>
                    {p.status === 'ok' && p.running === 0 ? `${p.done}/${p.total} bước` : ''}
                  </span>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`}
                    onClick={open}
                  >
                    {canStart ? 'Bắt đầu' : 'Mở'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
        </div>
      </section>
    </div>
  );
}
