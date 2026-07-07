// Pipelines page (docs → output). A per-KGS-app, dependency-gated flow of
// pipelines, rendered as a numbered vertical stepper that mirrors the actual
// DAG of the selected workflow: docs-to-html (html-docs → html-cj → html-ux →
// ui-html) or docs-to-react (react-docs → react-cj → react-ux → ui-react).
//
// The "project" here is a KGS app — a project pulled from the central KGS
// (`od kg pull`), whose id is the KGS project_id. Runs happen in the BACKGROUND:
// pressing Run seeds a conversation + starts the agent on the daemon and we stay
// on this page (the daemon already runs async; we just poll status). Each row
// then exposes Status (compact run modal), Open chat (prompt more), and Quick
// result (the stage's output files). A step is locked until its prerequisites
// have succeeded.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PipelineProject,
  PipelineProjectsResponse,
  PipelineView,
  PipelinesResponse,
  PullPlan,
  RunPipelineResponse,
  Workflow,
  WorkflowsResponse,
} from '@open-design/contracts';

import { Icon, type IconName } from './Icon';
import { Toast } from './Toast';
import { navigate } from '../router';
import {
  DesignSystemRunModal,
  PullAllModal,
  PushAllModal,
  PipelineResultModal,
  PipelineStatusModal,
  RunInputModal,
  type RunSourcePayload,
} from './pipelines/PipelineModals';
import { PullConflictModal } from './pipelines/PullConflictModal';
import { PlModal } from './pipelines/PlModal';
import { pullApply, pullPlan } from '../providers/pullConflict';
import { useT } from '../i18n';
import { relativeTimeLong } from '../utils/chatTime';

// Max project cards shown before the picker collapses behind "Show all" —
// keeps the pipeline stepper (the page's real content) above the fold.
const PROJECT_CARD_LIMIT = 7;

const STATUS_LABEL: Record<string, string> = {
  idle: 'Not started',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
};

// Per-pipeline presentation: an icon and a one-line "what this step does" blurb.
// Keyed by the daemon pipeline id (apps/daemon/src/pipelines.ts). Pure UI copy.
// Blurbs describe WHAT the step does (not ordering) — the stepper's gating shows
// the DAG, which differs between workflows.
const PIPELINE_META: Record<string, { icon: IconName; blurb: string }> = {
  'jira-ingest': { icon: 'import', blurb: 'Pull Confluence / JIRA sources into clean Markdown docs.' },
  'feature-analysis': { icon: 'search', blurb: 'Extract the feature set and requirements from the ingested docs.' },
  'ux-spec': { icon: 'draw', blurb: 'Generate UX specifications from the features and customer journey.' },
  'customer-journey': { icon: 'orbit', blurb: 'Map the end-to-end customer journey from the docs, with key source text per stage.' },
  ui: { icon: 'blocks', blurb: 'Generate the static + interactive UI screens, then preview them.' },
  'ui-html': {
    icon: 'file-code',
    blurb: 'Build the interactive HTML/CSS prototype — one self-contained file per screen.',
  },
};

// Workflow B reuses the same upstream skills under distinct ids; map them to the
// canonical meta so its steps get the right icon + blurb.
const META_ALIAS: Record<string, string> = {
  'html-docs': 'jira-ingest',
  'html-cj': 'customer-journey',
  'html-ux': 'ux-spec',
};

function metaFor(id: string): { icon: IconName; blurb: string } {
  return PIPELINE_META[META_ALIAS[id] ?? id] ?? { icon: 'sparkles', blurb: '' };
}

interface ToastState {
  message: string;
  details?: string | null;
  code?: string | null;
}

export function PipelinesView() {
  const t = useT();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string>('');
  // Pull all / Push all are scoped to the ACTIVE workflow tab — their modals
  // only offer (and only sync) this workflow's pipelines. Fallback to all
  // while the workflow list is still loading.
  const activeWorkflows = useMemo(() => {
    const hit = workflows.filter((w) => w.id === workflowId);
    return hit.length > 0 ? hit : workflows;
  }, [workflows, workflowId]);
  const [projects, setProjects] = useState<PipelineProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [pipelines, setPipelines] = useState<PipelineView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [syncBusy, setSyncBusy] = useState<null | 'pull' | 'push'>(null);
  const [uploading, setUploading] = useState(false);
  // Project history (version hóa output), scoped per PIPELINE CARD: the card's
  // Lịch sử button opens a panel listing the store versions whose snapshot
  // contains THAT stage's outputs (v.stages) + this machine's commits for the
  // same pipeline. Restore from a card only rewinds that stage's files.
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyData, setHistoryData] = useState<{
    versions: Array<{ verId: string; at: string; by: { email?: string; name?: string } | null; files: number; gitCommit?: string; stages?: string[] }>;
    commits: Array<{ commit: string; at: string; kind: string; pipelineId?: string; status?: string; by?: { email?: string } | null; filesChanged?: number; note?: string }>;
  } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  // Project picker controls — with many KGS projects the raw card grid became
  // a wall pushing the actual pipeline flow below the fold.
  const [projectSearch, setProjectSearch] = useState('');
  const [showAllProjects, setShowAllProjects] = useState(false);
  // Which stage's "run info" panel is expanded (input/source of the last run).
  const [infoForId, setInfoForId] = useState<string | null>(null);

  // Đổi project → đóng panel lịch sử của card cũ; dữ liệu cũ không còn đúng.
  useEffect(() => {
    setHistoryForId(null);
    setHistoryData(null);
  }, [projectId]);

  // Relevance order for the picker: the selected project is pinned first, then
  // anything currently running, then in-progress work, then untouched, and
  // finished projects last — alphabetical inside each band. With no search the
  // grid shows the first PROJECT_CARD_LIMIT cards; searching always shows every
  // match (a filtered result set is small by construction).
  const { visibleProjects, hiddenProjectCount } = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const matches = q
      ? projects.filter(
          (pr) => pr.name.toLowerCase().includes(q) || pr.id.toLowerCase().includes(q),
        )
      : projects;
    const band = (pr: PipelineProject): number => {
      if (pr.id === projectId) return 0;
      if (pr.running > 0) return 1;
      if (pr.done > 0 && pr.done < pr.total) return 2;
      if (pr.total === 0 || pr.done === 0) return 3;
      return 4; // complete
    };
    const sorted = matches
      .slice()
      .sort((a, b) => band(a) - band(b) || a.name.localeCompare(b.name));
    if (q || showAllProjects || sorted.length <= PROJECT_CARD_LIMIT) {
      return { visibleProjects: sorted, hiddenProjectCount: 0 };
    }
    return {
      visibleProjects: sorted.slice(0, PROJECT_CARD_LIMIT),
      hiddenProjectCount: sorted.length - PROJECT_CARD_LIMIT,
    };
  }, [projects, projectSearch, showAllProjects, projectId]);
  const [pullPlanState, setPullPlanState] = useState<PullPlan | null>(null);

  const [toast, setToast] = useState<ToastState | null>(null);
  // "Pull all"/"Push all" open pick-projects/pipelines modals instead of
  // moving everything blindly. (Tạo dự án đã chuyển hẳn sang Pipeline Studio.)
  const [pullAllOpen, setPullAllOpen] = useState(false);
  const [pushAllOpen, setPushAllOpen] = useState(false);
  const [runInputFor, setRunInputFor] = useState<PipelineView | null>(null);
  const [designSystemFor, setDesignSystemFor] = useState<PipelineView | null>(null);
  const [statusFor, setStatusFor] = useState<PipelineView | null>(null);
  const [resultFor, setResultFor] = useState<PipelineView | null>(null);

  const pushToast = useCallback((t: ToastState) => setToast(t), []);

  // Load the available workflows once; default-select the first.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/workflows');
        if (!res.ok) return;
        const data = (await res.json()) as WorkflowsResponse;
        setWorkflows(data.workflows ?? []);
        setWorkflowId((cur) => cur || data.defaultWorkflowId);
      } catch {
        /* workflows are optional chrome; ignore */
      }
    })();
  }, []);

  // The selectable "projects" are KGS apps pulled from KGS, not chat workspaces.
  // Progress badges are scoped to the active workflow, so refetch on switch.
  const loadProjects = useCallback(async () => {
    if (!workflowId) return;
    try {
      const res = await fetch(`/api/pipelines/projects?workflowId=${encodeURIComponent(workflowId)}`);
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const data = (await res.json()) as PipelineProjectsResponse;
      const list = data.projects ?? [];
      setProjects(list);
      const first = list[0];
      if (first) setProjectId((cur) => cur || first.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectsLoaded(true);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const load = useCallback(async (pid: string) => {
    if (!pid || !workflowId) {
      setPipelines([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/pipelines?projectId=${encodeURIComponent(pid)}&workflowId=${encodeURIComponent(workflowId)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `load failed: ${res.status}`);
      }
      const data = (await res.json()) as PipelinesResponse;
      setPipelines(data.pipelines ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPipelines([]);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  // Background polling: while any pipeline for the selected project is in flight,
  // refresh its status until everything settles. When the last run finishes,
  // refresh the project cards too so their done/total badge updates.
  const anyRunning = pipelines.some((p) => p.status === 'running' || p.status === 'queued');
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (!anyRunning || !projectId) return;
    const id = window.setInterval(() => {
      void load(projectId);
    }, 2500);
    return () => window.clearInterval(id);
  }, [anyRunning, projectId, load]);
  useEffect(() => {
    if (prevRunningRef.current && !anyRunning) void loadProjects();
    prevRunningRef.current = anyRunning;
  }, [anyRunning, loadProjects]);

  // Keep the project-list running spinners live: while ANY project (not just the
  // selected one) has a pipeline in flight, re-poll the list so a run started or
  // finished on another project shows / clears its spinner without a manual
  // refresh. The initial fetch already carries `running`, so entering the route
  // shows the spinners immediately.
  const anyProjectRunning = projects.some((p) => p.running > 0);
  useEffect(() => {
    if (!anyProjectRunning) return;
    const id = window.setInterval(() => {
      void loadProjects();
    }, 3500);
    return () => window.clearInterval(id);
  }, [anyProjectRunning, loadProjects]);

  // Pull/push ALL KGS apps at once (not per-project). Pull refreshes the app list.
  // `projectIds` narrows to the projects chosen in the Pull all / Push all modal;
  // `stages` narrows which pipelines' OUTPUT FILES travel (graph stays whole-
  // project). Either omitted → legacy everything.
  const syncAll = async (kind: 'pull' | 'push', projectIds?: string[], stages?: string[]) => {
    setSyncBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/kg/${kind}-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(projectIds?.length ? { projectIds } : {}),
          ...(stages?.length ? { stages } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `${kind}-all failed: ${res.status}`);
      if (kind === 'pull') {
        await loadProjects();
        if (projectId) void load(projectId);
      }
      // push-all/pull-all now round-trip output files too (graph + files); show
      // the file count so the user can see the artifacts moved, not just nodes.
      const results = (j?.data?.results ?? []) as Array<Record<string, number>>;
      const projectCount = results.length;
      const fileCount = results.reduce(
        (sum, r) => sum + (kind === 'pull' ? r.files ?? 0 : r.filesUploaded ?? 0),
        0,
      );
      pushToast({
        message:
          kind === 'pull'
            ? `Pulled ${projectCount} project(s) from KGS — ${fileCount} file(s)`
            : `Pushed ${projectCount} project(s) to KGS — ${fileCount} file(s)`,
      });
      return true;
    } catch (err) {
      pushToast({
        message: kind === 'pull' ? "Couldn't pull from KGS" : "Couldn't push to KGS",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
      return false;
    } finally {
      setSyncBusy(null);
    }
  };

  // Manual upload of the selected project's output files to KGS (+ B2 convert).
  const uploadToKgs = async () => {
    if (!projectId) return;
    setUploading(true);
    try {
      const res = await fetch('/api/pipelines/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `upload failed: ${res.status}`);
      void load(projectId);
      pushToast({ message: `Uploaded “${projectId}” to KGS` });
    } catch (err) {
      pushToast({
        message: "Couldn't upload to KGS",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setUploading(false);
    }
  };

  // Changelog của project: published versions (store `_v/`) + local commits.
  const loadHistory = async (pid: string) => {
    setHistoryBusy(true);
    try {
      const res = await fetch(`/api/pipelines/history?projectId=${encodeURIComponent(pid)}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `history failed: ${res.status}`);
      setHistoryData({ versions: j.versions ?? [], commits: j.commits ?? [] });
    } catch (err) {
      setHistoryData(null);
      pushToast({
        message: 'Không tải được lịch sử',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setHistoryBusy(false);
    }
  };

  // Restore: rewind outputs về một bản đã push (store) hoặc một commit local.
  // `stage` giới hạn version-restore vào output của đúng pipeline đó (nút
  // Khôi phục trong card). Trạng thái hiện tại được daemon chốt vào
  // .odhistory trước — luôn undo được.
  const restoreHistory = async (opts: { verId?: string; commit?: string; stage?: string }) => {
    if (!projectId) return;
    const label = opts.verId ?? opts.commit?.slice(0, 10) ?? '';
    const scope = opts.stage ? `output của bước "${opts.stage}"` : 'output';
    if (!window.confirm(`Khôi phục ${scope} về bản ${label}? Trạng thái hiện tại sẽ được lưu vào lịch sử trước khi ghi đè.`)) {
      return;
    }
    setRestoreBusy(label);
    try {
      const res = await fetch('/api/pipelines/history/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...opts }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `restore failed: ${res.status}`);
      pushToast({ message: `Đã khôi phục ${j.files ?? 0} file về bản ${label}` });
      void load(projectId);
      void loadHistory(projectId);
    } catch (err) {
      pushToast({
        message: 'Khôi phục thất bại',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setRestoreBusy(null);
    }
  };

  // Build/rebuild the docs-to-react app from synced sources. dist/ never
  // syncs (PipelineDef.syncExclude), so after "Pull project" this is what
  // makes the app previewable again. 422 carries the tsc/vite error tail.
  const buildReactApp = async () => {
    if (!projectId) return;
    setBuildBusy(true);
    try {
      const res = await fetch('/api/pipelines/react-build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `build failed: ${res.status}`);
      void load(projectId);
      pushToast({ message: `Built React app for “${projectId}” → react/dist/` });
    } catch (err) {
      pushToast({
        message: "Couldn't build the React app",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setBuildBusy(false);
    }
  };

  // Conflict-aware pull of the selected project's files (PLAN → RESOLVE → APPLY).
  // 0 conflicts → apply straight through (keep-local default, no modal); else open
  // PullConflictModal so the user resolves each differing file.
  const pullProject = async () => {
    if (!projectId) return;
    setPullBusy(true);
    try {
      const plan = await pullPlan(projectId);
      if (plan.conflicts.length === 0) {
        const result = await pullApply({
          projectId,
          planId: plan.planId,
          resolutions: {},
          onConflictDefault: 'local',
        });
        void load(projectId);
        pushToast({
          message: `Pulled “${projectId}” — ${result.downloaded} new file(s)`,
          ...(result.stale.length ? { details: `${result.stale.length} skipped (remote changed)`, code: 'warn' } : {}),
        });
      } else {
        setPullPlanState(plan);
      }
    } catch (err) {
      pushToast({
        message: "Couldn't pull from KGS",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setPullBusy(false);
    }
  };

  // Start a pipeline run in the BACKGROUND: POST the run, optimistically flip the
  // row to "running" (the poller takes over), and DON'T navigate away. Throws on
  // failure so callers (incl. the input modal) can surface it.
  const startRun = async (
    pipelineId: string,
    payload?: RunSourcePayload,
    // Per-run design system for UI stages: a string id, or `null` for explicit
    // "None". `undefined` (the common case) omits the field → daemon default.
    designSystemId?: string | null,
  ) => {
    if (!projectId) return;
    const body: Record<string, unknown> = { projectId };
    if (payload?.source) body.source = payload.source;
    else if (payload?.input && payload.input.trim()) body.input = payload.input.trim();
    if (designSystemId !== undefined) body.designSystemId = designSystemId;
    const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `run failed: ${res.status}`);
    }
    const j = (await res.json().catch(() => null)) as RunPipelineResponse | null;
    setPipelines((prev) =>
      prev.map((p) =>
        p.id === pipelineId
          ? {
              ...p,
              status: 'running',
              ...(j?.agentRunId ? { lastRunId: j.agentRunId } : {}),
              ...(j?.conversationId ? { lastConversationId: j.conversationId } : {}),
            }
          : p,
      ),
    );
  };

  const runDirect = async (p: PipelineView) => {
    setBusyId(p.id);
    try {
      await startRun(p.id);
      pushToast({ message: `Started “${p.name}” — running in background` });
    } catch (err) {
      pushToast({
        message: `Couldn't start “${p.name}”`,
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  // Run click: pipelines that take an input (e.g. jira-ingest's Confluence link)
  // open a modal first; the rest start immediately.
  const onRunClick = (p: PipelineView) => {
    if (p.inputPlaceholder) setRunInputFor(p);
    else if (p.acceptsDesignSystem) setDesignSystemFor(p);
    else void runDirect(p);
  };

  const openChat = (p: PipelineView) => {
    if (!p.lastConversationId) return;
    navigate({ kind: 'project', projectId, conversationId: p.lastConversationId, fileName: null });
  };

  const viewFile = (fileName: string) => {
    navigate({ kind: 'project', projectId, conversationId: null, fileName });
  };

  const hasProjects = projects.length > 0;
  const doneCount = pipelines.filter((p) => p.status === 'succeeded').length;

  return (
    <section className="pipelines-page" aria-labelledby="pipelines-title" data-testid="pipelines-view">
      <header className="pipelines-page__hero">
        <div className="pipelines-page__copy">
          <span className="pipelines-page__eyebrow">
            <Icon name="pipeline" size={13} />
            Docs → UI
          </span>
          <h1 id="pipelines-title" className="pipelines-page__title">
            Pipelines
          </h1>
          <p className="pipelines-page__lede">
            A dependency-gated flow that turns product docs into UI screens — each step runs a
            guided agent in the background; track it, jump into the chat, or open its result.
          </p>
        </div>
        {hasProjects && pipelines.length > 0 ? (
          <div className="pipelines-progress" aria-label="Pipeline progress">
            <span className="pipelines-progress__count">
              {doneCount}
              <span className="pipelines-progress__total">/{pipelines.length}</span>
            </span>
            <span className="pipelines-progress__label">steps done</span>
          </div>
        ) : null}
      </header>

      {/* Workflow selector — each workflow is its own docs→output flow */}
      {workflows.length > 1 ? (
        <div className="pl-workflow-tabs" role="tablist" aria-label="Workflow">
          {workflows.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === workflowId}
              className={`pl-workflow-tab${w.id === workflowId ? ' is-active' : ''}`}
              onClick={() => setWorkflowId(w.id)}
            >
              <span className="pl-workflow-tab__name">{w.name}</span>
              {w.description ? (
                <span className="pl-workflow-tab__desc">{w.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* Sync toolbar (global KGS pull/push + per-project upload) */}
      <div className="pipelines-toolbar">
        <div className="pipelines-toolbar__group pipelines-toolbar__group--actions">
          <button
            type="button"
            className="pl-btn"
            onClick={() => setPullAllOpen(true)}
            disabled={syncBusy !== null}
            title="Pull các project từ KGS về — chỉ output của workflow đang chọn"
          >
            <Icon name={syncBusy === 'pull' ? 'spinner' : 'download'} size={14} />
            <span>{syncBusy === 'pull' ? 'Pulling…' : 'Pull all'}</span>
          </button>
          <button
            type="button"
            className="pl-btn"
            onClick={() => setPushAllOpen(true)}
            disabled={syncBusy !== null}
            title="Push các project local lên KGS — chỉ output của workflow đang chọn"
          >
            <Icon name={syncBusy === 'push' ? 'spinner' : 'upload'} size={14} />
            <span>{syncBusy === 'push' ? 'Pushing…' : 'Push all'}</span>
          </button>
          {hasProjects ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => void pullProject()}
              disabled={pullBusy || !projectId}
              title="Pull this project's files from KGS, resolving conflicts with local edits"
            >
              <Icon name={pullBusy ? 'spinner' : 'download'} size={14} />
              <span>{pullBusy ? 'Pulling…' : 'Pull project'}</span>
            </button>
          ) : null}
          {hasProjects ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => void uploadToKgs()}
              disabled={uploading || !projectId}
              title="Upload this project's output files to KGS (UX/CJ also convert to graph)"
            >
              <Icon name={uploading ? 'spinner' : 'upload'} size={14} />
              <span>{uploading ? 'Uploading…' : 'Upload project'}</span>
            </button>
          ) : null}
          {hasProjects && workflowId === 'docs-to-react' ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => void buildReactApp()}
              disabled={buildBusy || !projectId}
              title="Build the React app from its sources (react/dist/ is never synced — after a pull, build here to preview). Requires Docker."
            >
              <Icon name={buildBusy ? 'spinner' : 'play'} size={14} />
              <span>{buildBusy ? 'Building…' : 'Build app'}</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Req 1 + 2: KGS project selection cards + New project card.
          UX for many projects: search + smart order (selected → running →
          in-progress → untouched → complete) + collapsed grid (first
          PROJECT_CARD_LIMIT cards) with an explicit "Show all" toggle. */}
      <section className="pipelines-projects" aria-label="KGS project">
        <div className="pl-proj-toolbar">
          <span className="pl-field__label">
            KGS project
            {projects.length > 0 ? (
              <span className="pl-proj-count"> · {projects.length}</span>
            ) : null}
          </span>
          {projects.length > PROJECT_CARD_LIMIT ? (
            <input
              type="search"
              className="pl-proj-search"
              placeholder="Search projects…"
              value={projectSearch}
              onChange={(ev) => setProjectSearch(ev.target.value)}
              aria-label="Search projects"
            />
          ) : null}
        </div>
        <div className="pl-card-grid">
          {visibleProjects.map((pr) => {
            const complete = pr.total > 0 && pr.done >= pr.total;
            return (
              <button
                key={pr.id}
                type="button"
                className={`pl-proj-card${pr.id === projectId ? ' is-selected' : ''}`}
                onClick={() => setProjectId(pr.id)}
                aria-pressed={pr.id === projectId}
              >
                <span className="pl-proj-card__top">
                  <Icon name="folder" size={15} />
                  <span className="pl-proj-card__name">{pr.name}</span>
                  {pr.running > 0 ? (
                    <span
                      className="pl-proj-card__running"
                      aria-label={`${pr.running} pipeline running`}
                      title={`${pr.running} pipeline running`}
                    >
                      <Icon name="spinner" size={13} />
                    </span>
                  ) : null}
                  {pr.id === projectId ? (
                    <span className="pl-proj-card__check" aria-hidden="true">
                      <Icon name="check" size={13} />
                    </span>
                  ) : null}
                </span>
                <span className="pl-proj-card__progress">
                  <span
                    className="pl-proj-card__dot"
                    data-complete={complete ? 'yes' : 'no'}
                    aria-hidden="true"
                  />
                  {pr.done}/{pr.total} done
                  {pr.running > 0 ? ` · ${pr.running} running` : ''}
                </span>
              </button>
            );
          })}
          {hiddenProjectCount > 0 ? (
            <button
              type="button"
              className="pl-proj-card pl-proj-card--more"
              onClick={() => setShowAllProjects(true)}
              title="Show every project card"
            >
              <span className="pl-proj-more__count">+{hiddenProjectCount}</span>
              <span>Show all</span>
            </button>
          ) : null}
          {showAllProjects && projects.length > PROJECT_CARD_LIMIT ? (
            <button
              type="button"
              className="pl-proj-card pl-proj-card--more"
              onClick={() => setShowAllProjects(false)}
              title="Collapse back to the most relevant projects"
            >
              <span className="pl-proj-more__chevron">
                <Icon name="chevron-down" size={16} />
              </span>
              <span>Show less</span>
            </button>
          ) : null}
        </div>
        {projectSearch && visibleProjects.length === 0 ? (
          <div className="pl-proj-noresult">No project matches “{projectSearch}”.</div>
        ) : null}
      </section>

      {error ? (
        <div className="pipelines-error" role="alert">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {/* The stepper flow for the selected project */}
      {projectsLoaded && !hasProjects ? (
        <div className="pipelines-empty">
          <span className="pipelines-empty__icon" aria-hidden="true">
            <Icon name="pipeline" size={22} />
          </span>
          <div className="pipelines-empty__body">
            <strong>Chưa có dự án nào trên máy này</strong>
            <p>
              Dự án được tạo trên <strong>Pipeline Studio</strong> (kèm link Confluence + design
              system). Nhờ quản lý add bạn vào dự án, rồi bấm <strong>Pull all</strong> (hoặc{' '}
              <code>od kg pull &lt;project-id&gt;</code>) để kéo về và chạy pipeline tại đây.
            </p>
          </div>
        </div>
      ) : loading || !projectsLoaded ? (
        <div className="pipelines-flow pipelines-flow--loading" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="pl-step pl-step--skeleton">
              <div className="pl-step__spine">
                <span className="pl-step__node" />
              </div>
              <div className="pl-step__card" />
            </div>
          ))}
        </div>
      ) : (
        <ol className="pipelines-flow">
          {pipelines.map((p, idx) => {
            const isBusy = busyId === p.id;
            const isRunning = p.status === 'running' || p.status === 'queued';
            const meta = metaFor(p.id);
            const isLast = idx === pipelines.length - 1;
            const canChat = !!p.lastConversationId;
            const hasRunInfo = Boolean(p.updatedAt || p.lastInput || p.lastSource || p.lastRunId);
            const infoOpen = infoForId === p.id;
            const histOpen = historyForId === p.id;
            return (
              <li
                key={p.id}
                className="pl-step"
                data-status={p.status}
                data-active={p.active ? 'yes' : 'no'}
              >
                <div className="pl-step__spine" aria-hidden="true">
                  <span className="pl-step__node">
                    {p.status === 'succeeded' ? (
                      <Icon name="check" size={14} />
                    ) : isRunning ? (
                      <Icon name="spinner" size={14} />
                    ) : !p.active ? (
                      <Icon name="eye-off" size={13} />
                    ) : (
                      <span className="pl-step__num">{idx + 1}</span>
                    )}
                  </span>
                  {!isLast ? <span className="pl-step__connector" /> : null}
                </div>

                <div className="pl-step__card">
                  <span className="pl-step__icon" aria-hidden="true">
                    <Icon name={meta.icon} size={18} />
                  </span>
                  <div className="pl-step__body">
                    <div className="pl-step__heading">
                      <span className="pl-step__name">{p.name}</span>
                      <span className={`pl-status pl-status--${p.status}`}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                      {hasRunInfo ? (
                        <button
                          type="button"
                          className={`pl-step__infobtn${infoOpen ? ' is-open' : ''}`}
                          onClick={() => setInfoForId(infoOpen ? null : p.id)}
                          title="Show what this stage's last run was fed (input link / source / time)"
                          aria-expanded={infoOpen}
                        >
                          <Icon name="info" size={13} />
                        </button>
                      ) : null}
                    </div>
                    {meta.blurb ? <p className="pl-step__desc">{meta.blurb}</p> : null}
                    {p.updatedAt ? (
                      <p className="pl-step__lastrun">Last run: {relativeTimeLong(p.updatedAt, t)}</p>
                    ) : null}
                    {infoOpen ? (
                      <dl className="pl-step__info">
                        {p.updatedAt ? (
                          <div className="pl-step__info-row">
                            <dt>Last run</dt>
                            <dd>
                              {new Date(p.updatedAt).toLocaleString()} (
                              {relativeTimeLong(p.updatedAt, t)})
                            </dd>
                          </div>
                        ) : null}
                        {p.lastInput ? (
                          <div className="pl-step__info-row">
                            <dt>Input</dt>
                            <dd>
                              {/^https?:\/\//i.test(p.lastInput.trim()) ? (
                                <a href={p.lastInput.trim()} target="_blank" rel="noreferrer">
                                  {p.lastInput.trim()}
                                </a>
                              ) : (
                                <code>{p.lastInput}</code>
                              )}
                            </dd>
                          </div>
                        ) : null}
                        {p.lastSource?.kind === 'confluence' ? (
                          <div className="pl-step__info-row">
                            <dt>Source</dt>
                            <dd>
                              Confluence —{' '}
                              {/^https?:\/\//i.test(p.lastSource.ref.trim()) ? (
                                <a href={p.lastSource.ref.trim()} target="_blank" rel="noreferrer">
                                  {p.lastSource.ref.trim()}
                                </a>
                              ) : (
                                <code>{p.lastSource.ref}</code>
                              )}
                            </dd>
                          </div>
                        ) : p.lastSource?.kind === 'bas' ? (
                          <div className="pl-step__info-row">
                            <dt>Source</dt>
                            <dd>
                              BAS document <code>{p.lastSource.documentId}</code>
                              {p.lastSource.featureIds?.length
                                ? ` · ${p.lastSource.featureIds.length} feature(s): ${p.lastSource.featureIds.join(', ')}`
                                : ' · whole document'}
                            </dd>
                          </div>
                        ) : null}
                        {canChat ? (
                          <div className="pl-step__info-row">
                            <dt>Run</dt>
                            <dd>
                              <button
                                type="button"
                                className="pl-step__info-link"
                                onClick={() => openChat(p)}
                              >
                                Open the run conversation →
                              </button>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                    {!p.active && p.dependsOn.length > 0 ? (
                      <p className="pl-step__lock">
                        <Icon name="eye-off" size={12} />
                        Locked — finish{' '}
                        {p.dependsOn
                          .map((dep) => pipelines.find((x) => x.id === dep)?.name ?? dep)
                          .join(', ')}{' '}
                        first
                      </p>
                    ) : null}

                  </div>

                  <div className="pl-step__actions">
                    {!p.active ? (
                      <button type="button" className="pl-btn pl-btn--run" disabled>
                        <Icon name="play" size={14} />
                        <span>Run</span>
                      </button>
                    ) : isRunning ? (
                      <>
                        <button
                          type="button"
                          className="pl-btn pl-btn--run"
                          onClick={() => setStatusFor(p)}
                        >
                          <Icon name="spinner" size={14} />
                          <span>Status</span>
                        </button>
                        {canChat ? (
                          <button type="button" className="pl-btn" onClick={() => openChat(p)}>
                            <Icon name="comment" size={14} />
                            <span>Open chat</span>
                          </button>
                        ) : null}
                      </>
                    ) : p.status === 'succeeded' ? (
                      <>
                        <button
                          type="button"
                          className="pl-btn pl-btn--run"
                          onClick={() => setResultFor(p)}
                        >
                          <Icon name="file-code" size={14} />
                          <span>Quick result</span>
                        </button>
                        {canChat ? (
                          <button type="button" className="pl-btn" onClick={() => openChat(p)}>
                            <Icon name="comment" size={14} />
                            <span>Open chat</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="pl-btn"
                          onClick={() => onRunClick(p)}
                          disabled={isBusy}
                          title="Run this pipeline again"
                        >
                          <Icon name={isBusy ? 'spinner' : 'refresh'} size={14} />
                          <span>Run again</span>
                        </button>
                      </>
                    ) : p.status === 'failed' ? (
                      <>
                        <button
                          type="button"
                          className="pl-btn pl-btn--danger"
                          onClick={() => setStatusFor(p)}
                        >
                          <Icon name="info" size={14} />
                          <span>View error</span>
                        </button>
                        {canChat ? (
                          <button type="button" className="pl-btn" onClick={() => openChat(p)}>
                            <Icon name="comment" size={14} />
                            <span>Open chat</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="pl-btn pl-btn--run"
                          onClick={() => onRunClick(p)}
                          disabled={isBusy}
                        >
                          <Icon name={isBusy ? 'spinner' : 'refresh'} size={14} />
                          <span>Retry</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="pl-btn pl-btn--run"
                        onClick={() => onRunClick(p)}
                        disabled={isBusy}
                        title="Run this pipeline in the background"
                      >
                        <Icon name={isBusy ? 'spinner' : 'play'} size={14} />
                        <span>{isBusy ? 'Starting…' : 'Run'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="pl-btn"
                      onClick={() => {
                        const next = histOpen ? null : p.id;
                        setHistoryForId(next);
                        if (next && projectId) void loadHistory(projectId);
                      }}
                      title="Các bản đã push chứa output của bước này — xem & khôi phục riêng bước này"
                      aria-expanded={histOpen}
                    >
                      <Icon name={historyBusy && histOpen ? 'spinner' : 'history'} size={14} />
                      <span>Lịch sử</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Modals ── */}
      {historyForId
        ? (() => {
            const stageId = historyForId;
            const stageName = pipelines.find((x) => x.id === stageId)?.name ?? stageId;
            // Store versions whose frozen snapshot carries THIS stage's outputs
            // + this machine's .odhistory commits for the same pipeline.
            const vers = (historyData?.versions ?? []).filter((v) => v.stages?.includes(stageId));
            const cms = (historyData?.commits ?? []).filter((c) => c.pipelineId === stageId);
            return (
              <PlModal
                title={`Lịch sử — ${stageName}`}
                icon="history"
                size="md"
                busy={restoreBusy !== null}
                onClose={() => setHistoryForId(null)}
              >
                <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
                  Bản đã push chứa output bước này ({vers.length})
                </div>
                {historyBusy && !historyData ? (
                  <div style={{ fontSize: 12, opacity: 0.6 }}>Đang tải…</div>
                ) : null}
                {vers.map((v, i) => (
                  <div
                    key={v.verId}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5 }}
                  >
                    <code style={{ fontWeight: 700 }}>{v.verId}</code>
                    <span
                      style={{ opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                    >
                      {v.by?.name || v.by?.email || 'không rõ'} · {new Date(v.at).toLocaleString('vi-VN')}
                      {i === 0 ? ' · mới nhất' : ''}
                    </span>
                    <button
                      type="button"
                      className="pl-btn"
                      disabled={restoreBusy !== null}
                      onClick={() => void restoreHistory({ verId: v.verId, stage: stageId })}
                      title={`Khôi phục CHỈ output của bước "${stageName}" về bản ${v.verId}`}
                    >
                      {restoreBusy === v.verId ? 'Đang khôi phục…' : 'Khôi phục'}
                    </button>
                  </div>
                ))}
                {historyData && vers.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.6 }}>
                    Chưa có bản nào trên store chứa output của bước này — chạy bước rồi push để tạo.
                  </div>
                ) : null}
                {cms.length > 0 ? (
                  <>
                    <div style={{ fontSize: 12.5, fontWeight: 700, margin: '12px 0 4px' }}>
                      Trên máy này ({cms.length})
                    </div>
                    {cms.slice(0, 10).map((c) => (
                      <div
                        key={c.commit}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}
                      >
                        <code style={{ opacity: 0.6 }}>{c.commit.slice(0, 8)}</code>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {c.kind}
                          {c.status ? ` [${c.status}]` : ''}
                          {typeof c.filesChanged === 'number' ? ` · ${c.filesChanged} file` : ''}
                          {' · '}
                          {new Date(c.at).toLocaleString('vi-VN')}
                        </span>
                        <button
                          type="button"
                          className="pl-btn"
                          disabled={restoreBusy !== null}
                          onClick={() => void restoreHistory({ commit: c.commit })}
                          title="Rewind TOÀN BỘ project về commit này (mọi file, không chỉ bước này)"
                        >
                          {restoreBusy === c.commit.slice(0, 10) ? '…' : 'Khôi phục'}
                        </button>
                      </div>
                    ))}
                  </>
                ) : null}
              </PlModal>
            );
          })()
        : null}
      {pullAllOpen ? (
        <PullAllModal
          localIds={new Set(projects.map((pr) => pr.id))}
          workflows={activeWorkflows}
          scopeName={activeWorkflows[0]?.name}
          onClose={() => setPullAllOpen(false)}
          onConfirm={async (ids, stages) => {
            const ok = await syncAll('pull', ids, stages);
            if (!ok) throw new Error('Pull failed — see the toast for details.');
          }}
        />
      ) : null}
      {pushAllOpen ? (
        <PushAllModal
          projects={projects.map((pr) => ({ id: pr.id, name: pr.name }))}
          workflows={activeWorkflows}
          scopeName={activeWorkflows[0]?.name}
          onClose={() => setPushAllOpen(false)}
          onConfirm={async (ids, stages) => {
            const ok = await syncAll('push', ids, stages);
            if (!ok) throw new Error('Push failed — see the toast for details.');
          }}
        />
      ) : null}
      {runInputFor ? (
        <RunInputModal
          pipelineName={runInputFor.name}
          placeholder={runInputFor.inputPlaceholder ?? ''}
          defaultConfluencePages={projects.find((pr) => pr.id === projectId)?.config?.confluencePages}
          defaultBasDocumentId={projects.find((pr) => pr.id === projectId)?.config?.basDocumentId}
          onClose={() => setRunInputFor(null)}
          onRun={async (payload) => {
            await startRun(runInputFor.id, payload);
            pushToast({ message: `Started “${runInputFor.name}” — running in background` });
          }}
        />
      ) : null}
      {designSystemFor ? (
        <DesignSystemRunModal
          pipelineName={designSystemFor.name}
          defaultId={projects.find((pr) => pr.id === projectId)?.config?.designSystemId}
          onClose={() => setDesignSystemFor(null)}
          onRun={async (designSystemId) => {
            await startRun(designSystemFor.id, undefined, designSystemId);
            pushToast({ message: `Started “${designSystemFor.name}” — running in background` });
          }}
        />
      ) : null}
      {statusFor ? (
        <PipelineStatusModal
          pipeline={statusFor}
          onClose={() => setStatusFor(null)}
          onOpenChat={
            statusFor.lastConversationId
              ? () => {
                  openChat(statusFor);
                  setStatusFor(null);
                }
              : null
          }
          onRefresh={() => {
            if (projectId) void load(projectId);
          }}
        />
      ) : null}
      {resultFor ? (
        <PipelineResultModal
          projectId={projectId}
          pipeline={resultFor}
          onClose={() => setResultFor(null)}
          onViewFile={viewFile}
        />
      ) : null}
      {pullPlanState ? (
        <PullConflictModal
          projectId={projectId}
          plan={pullPlanState}
          onClose={() => setPullPlanState(null)}
          onApplied={(result) => {
            void load(projectId);
            pushToast({
              message: `Pulled “${projectId}” — ${result.downloaded} downloaded, ${result.keptLocal} kept local`,
              ...(result.stale.length
                ? { details: `${result.stale.length} skipped (remote changed)`, code: 'warn' }
                : {}),
            });
          }}
        />
      ) : null}

      {toast ? (
        <Toast
          message={toast.message}
          details={toast.details ?? null}
          code={toast.code ?? null}
          role={toast.code ? 'alert' : 'status'}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </section>
  );
}
