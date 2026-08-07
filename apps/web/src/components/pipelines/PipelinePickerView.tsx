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

import { Icon } from '../Icon';
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
type WfProgress =
  | { status: 'loading' }
  | { status: 'ok'; done: number; total: number; running: number }
  | { status: 'error' };

function hasWorkInProgress(p: WfProgress): boolean {
  return p.status === 'ok' && (p.running > 0 || (p.done > 0 && p.done < p.total));
}

function statusLabel(p: WfProgress): string {
  if (p.status === 'loading') return '…';
  if (p.status === 'error') return 'chưa rõ tiến độ';
  if (p.done === 0 && p.running === 0) return 'Chưa chạy';
  if (p.running > 0) return `Đang chạy · bước ${p.done + 1}/${p.total}`;
  if (isFeatureDone(p)) return 'Xong';
  return `${p.done}/${p.total}`;
}

function statusDataAttr(p: WfProgress): 'idle' | 'running' | 'done' {
  if (p.status !== 'ok') return 'idle';
  if (p.running > 0) return 'running';
  if (isFeatureDone(p)) return 'done';
  return 'idle';
}

export function PipelinePickerView({ nav, appId, featureId }: Props): JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, WfProgress>>({});

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
                  ? { status: 'ok', done: proj.done, total: proj.total, running: proj.running }
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
            <h1 className={styles.title}>Pipelines</h1>
            <p className={styles.lede}>Chọn quy trình để chạy cho feature này.</p>
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
            Apps
          </button>
        </div>
        <div className={styles.notFound}>
          <span>Không tìm thấy feature này.</span>
          <button
            type="button"
            className={styles.btn}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            <Icon name="arrow-left" size={14} />
            Về Apps
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
          Apps
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
          <p className={styles.lede}>Chọn quy trình để chạy cho feature này.</p>
        </div>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelToolbar}>
          <div className={styles.listHead}>
            <h2 className={styles.listHeadTitle}>Danh sách quy trình</h2>
            <span className={styles.listHeadHint}>
              Mỗi thẻ là một workflow chạy trên feature này — tiến độ đếm riêng từng workflow.
            </span>
          </div>
        </div>

        <div className={styles.panelBody}>
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
        <div className={styles.pipelineGrid}>
          {sortedWorkflows.map((wf) => {
            const p: WfProgress = progress[wf.id] ?? { status: 'loading' };
            const wip = hasWorkInProgress(p);
            const canStart = p.status === 'ok' && p.done === 0 && p.running === 0;
            const open = () => navigate({ kind: 'pipelines-run', appId, featureId, pipelineId: wf.id });
            return (
              <div
                key={wf.id}
                className={`${styles.pipelineCard} ${wip ? styles.pipelineCardAccent : ''}`}
              >
                <div className={styles.pipelineCardHead}>
                  <span className={styles.pipelineCardName}>{wf.name}</span>
                  <span className={styles.statusChip} data-status={statusDataAttr(p)}>
                    {statusLabel(p)}
                  </span>
                </div>
                {wf.description ? (
                  <p className={styles.pipelineCardDesc} title={wf.description}>
                    {wf.description}
                  </p>
                ) : null}
                {p.status === 'ok' && p.total > 0 ? (
                  <span className={styles.segments}>
                    {Array.from({ length: p.total }).map((_, i) => (
                      // eslint-disable-next-line react/no-array-index-key -- fixed-count step segments
                      <span
                        key={i}
                        className={styles.segment}
                        data-state={i < p.done ? 'done' : i < p.done + p.running ? 'running' : 'idle'}
                      />
                    ))}
                  </span>
                ) : null}
                <div className={styles.pipelineCardFoot}>
                  <span className={styles.pipelineCardCount}>
                    {p.status === 'ok' ? `${p.done}/${p.total} bước` : ''}
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
