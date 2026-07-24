// Pipelines page (docs → output). A per-KGS-app, dependency-gated flow of
// pipelines, rendered as a numbered vertical stepper that mirrors the actual
// DAG of the docs-to-ui workflow: docs → cj → ux → then ONE step with two
// UI-Spec options (ui-html | ui-react) — run either or both.
//
// The "project" here is a KGS app — a project pulled from the central KGS
// (`od kg pull`), whose id is the KGS project_id. Runs happen in the BACKGROUND:
// pressing Run seeds a conversation + starts the agent on the daemon and we stay
// on this page (the daemon already runs async; we just poll status). Each row
// then exposes Status (compact run modal), Open chat (prompt more), and Quick
// result (the stage's output files). A step is locked until its prerequisites
// have succeeded.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// How long a just-triggered stage may report "running" before the daemon's own
// status is trusted again. Covers the pre-run pull of a slow agent stage.
const PENDING_START_GRACE_MS = 60_000;
import type {
  PipelineProject,
  PipelinePulseFeedbackListResponse,
  PipelineProjectsResponse,
  PipelineRunMode,
  PipelineView,
  PipelinesResponse,
  PullPlan,
  RunPipelineResponse,
  TargetPlatform,
  Workflow,
  WorkflowsResponse,
} from '@open-design/contracts';

import { Icon, type IconName } from './Icon';
import { Toast } from './Toast';
import { navigate, useRoute } from '../router';
import {
  DesignSystemRunModal,
  PlatformRunModal,
  RerunScopeModal,
  PullAllModal,
  PushAllModal,
  PipelineResultView,
  PipelineStatusModal,
  RunAllModal,
  RunInputModal,
  type RunAllPayload,
  type RunSourcePayload,
} from './pipelines/PipelineModals';
import { applyPendingStarts } from '../runtime/pipeline-pending-starts';
import { PullConflictModal } from './pipelines/PullConflictModal';
import { PlModal } from './pipelines/PlModal';
import { PipelineEvaluationStep } from './pipelines/PipelineEvaluationStep';
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
  'docs-map': { icon: 'blocks', blurb: 'Phân loại tài liệu theo app và ghi lại các điểm bàn giao giữa chúng — một hệ thống nhiều app, không phải nhiều sản phẩm rời. Chạy một lần cho cả dự án; sửa tay được ở docs/system-map.json.' },
  'ux-research': { icon: 'search', blurb: 'Desk research từ UX knowledge base (Growth.Design, NN/g, Baymard): tiêu chí UX kèm nguồn + hình minh hoạ, làm chuẩn cho UX Spec.' },
  'ux-review': { icon: 'eye', blurb: 'Heuristic review gate: judge the UX Spec against Nielsen + Norman usability heuristics before any UI is built.' },
  'customer-journey': { icon: 'orbit', blurb: 'Map the end-to-end customer journey from the docs, with key source text per stage.' },
  ui: { icon: 'blocks', blurb: 'Generate the static + interactive UI screens, then preview them.' },
  'ui-html': {
    icon: 'file-code',
    blurb: 'Option A — HTML preview: dựng UI-Spec thành trang HTML/CSS tĩnh xem nhanh, một file tự chứa mỗi màn.',
  },
  'ui-react': {
    icon: 'blocks',
    blurb: 'Option B — Prototype: app Vite + React 19 thật (Docker build) — nền cho mô phỏng thao tác + demo Playwright.',
  },
};

// The merged workflow's stages reuse the upstream skills under short ids; map
// them to the canonical meta so each step gets the right icon + blurb.
const META_ALIAS: Record<string, string> = {
  docs: 'jira-ingest',
  cj: 'customer-journey',
  ux: 'ux-spec',
};

function metaFor(id: string): { icon: IconName; blurb: string } {
  return PIPELINE_META[META_ALIAS[id] ?? id] ?? { icon: 'sparkles', blurb: '' };
}

// Short format label for a UI-Spec terminal option (the picker's card title
// and the merged step's status chips).
function uiSpecOptionLabel(p: { id: string }): string {
  return p.id === 'ui-react' ? 'React' : 'HTML';
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
  // Chế độ chạy của DỰ ÁN (lưu từ lần Run-all gần nhất). Quyết định bước nào bị
  // bỏ qua, nên nó phải hiện trên stepper — nếu không, người dùng nhìn một bước
  // xám mà không hiểu vì sao (lựa chọn nằm trong modal đã đóng từ lâu).
  const [runMode, setRunMode] = useState<PipelineRunMode>('full');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratedRunIds, setRatedRunIds] = useState<Set<string>>(new Set());

  const [syncBusy, setSyncBusy] = useState<null | 'pull' | 'push'>(null);
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
  const [buildBusy, setBuildBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
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
  // Nhóm card theo App (Studio: feature link vào app qua project.json.appId,
  // daemon mirror về `pr.app` lúc pull). Nhóm xuất hiện theo thứ tự relevance
  // của feature đầu tiên trong nhóm; feature chưa gán app dồn vào nhóm cuối.
  // Không có app nào → render lưới phẳng như cũ (không header thừa).
  const projectGroups = useMemo(() => {
    const order: string[] = [];
    const byKey = new Map<string, { key: string; name: string; projects: PipelineProject[] }>();
    for (const pr of visibleProjects) {
      const key = pr.app?.id ?? '';
      let g = byKey.get(key);
      if (!g) {
        g = { key, name: key ? pr.app?.name || pr.app!.id : 'Chưa gán app', projects: [] };
        byKey.set(key, g);
        order.push(key);
      }
      g.projects.push(pr);
    }
    const groups = order.map((k) => byKey.get(k)!);
    const loose = groups.findIndex((g) => g.key === '');
    if (loose >= 0 && groups.length > 1) groups.push(...groups.splice(loose, 1));
    return groups;
  }, [visibleProjects]);
  const groupedByApp = projectGroups.some((g) => g.key !== '');
  // App groups đóng/mở được — mặc định mở hết; trạng thái theo app id.
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set());
  const toggleAppGroup = (key: string) =>
    setCollapsedApps((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [pullPlanState, setPullPlanState] = useState<PullPlan | null>(null);

  const [toast, setToast] = useState<ToastState | null>(null);
  // "Pull all"/"Push all" open pick-projects/pipelines modals instead of
  // moving everything blindly. (Tạo dự án đã chuyển hẳn sang Pipeline Studio.)
  const [pullAllOpen, setPullAllOpen] = useState(false);
  const [pushAllOpen, setPushAllOpen] = useState(false);
  const [runAllOpen, setRunAllOpen] = useState(false);
  const [runInputFor, setRunInputFor] = useState<PipelineView | null>(null);
  const [designSystemFor, setDesignSystemFor] = useState<PipelineView | null>(null);
  const [platformFor, setPlatformFor] = useState<PipelineView | null>(null);
  const [resetScopeFor, setResetScopeFor] = useState<PipelineView | null>(null);
  // Chosen re-run clear scope, threaded from the scope modal through the normal
  // run flow (input/design-system/platform modals all end at startRun). A ref so
  // it survives the intermediate modals without re-render churn; consumed once.
  const pendingResetScopeRef = useRef<'stage' | 'downstream' | undefined>(undefined);
  const [statusFor, setStatusFor] = useState<PipelineView | null>(null);
  // Quick result is now a full-page route (/pipelines/:projectId/result/:pipelineId)
  // instead of an xl modal — read it from the URL so back/forward + deep links work.
  const route = useRoute();

  const pushToast = useCallback((t: ToastState) => setToast(t), []);

  // Deep-link into a Quick result: align the selected project with the routed
  // one so `load` fetches the pipeline list that owns route.pipelineId.
  useEffect(() => {
    if (route.kind === 'pipeline-result' && route.projectId && route.projectId !== projectId) {
      setProjectId(route.projectId);
    }
  }, [route, projectId]);

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

  // Stages this device just asked to run → deadline. See applyPendingStarts.
  const pendingStartsRef = useRef<Map<string, number>>(new Map());
  const markPendingStart = useCallback((pipelineId: string) => {
    pendingStartsRef.current.set(pipelineId, Date.now() + PENDING_START_GRACE_MS);
  }, []);

  const load = useCallback(async (pid: string, opts?: { background?: boolean }) => {
    if (!pid || !workflowId) {
      setPipelines([]);
      return;
    }
    // Background refreshes (the 2.5s in-flight poll + post-action reloads)
    // must NOT flip `loading`: that swaps the whole stepper for the skeleton
    // on every tick — a constant visible flicker while a pipeline runs. The
    // skeleton is for the FIRST load / project switch only, when there is
    // nothing on screen yet.
    const background = opts?.background === true;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const [res, feedbackRes] = await Promise.all([
        fetch(`/api/pipelines?projectId=${encodeURIComponent(pid)}&workflowId=${encodeURIComponent(workflowId)}`),
        fetch(`/api/pipelines/feedback?projectId=${encodeURIComponent(pid)}`),
      ]);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `load failed: ${res.status}`);
      }
      const data = (await res.json()) as PipelinesResponse;
      setPipelines(applyPendingStarts(data.pipelines ?? [], pendingStartsRef.current, Date.now()));
      setRunMode(data.runMode ?? 'full');
      if (feedbackRes.ok) {
        const feedbackData = (await feedbackRes.json()) as PipelinePulseFeedbackListResponse;
        setRatedRunIds(new Set(feedbackData.feedback.map((item) => item.runId)));
      }
      if (background) setError(null);
    } catch (err) {
      // A transient poll hiccup must not wipe the stepper mid-run — keep the
      // last known state on background failures; the next tick self-heals.
      if (!background) {
        setError(err instanceof Error ? err.message : String(err));
        setPipelines([]);
      }
    } finally {
      if (!background) setLoading(false);
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
      void load(projectId, { background: true });
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
        if (projectId) void load(projectId, { background: true });
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
      void load(projectId, { background: true });
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

  // Build/rebuild the ui-react app from synced sources. dist/ never
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
      void load(projectId, { background: true });
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

  // Prototype auto-demo: Playwright drives the BUILT react app through its
  // flow.json use cases (video + per-step screenshots → react/prototype-demo/).
  const buildReactDemoRun = async () => {
    if (!projectId) return;
    setDemoBusy(true);
    try {
      const res = await fetch('/api/pipelines/react-demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `demo failed: ${res.status}`);
      pushToast({
        message: `Đã quay ${j.cases ?? 0} kịch bản demo → react/prototype-demo/`,
        details: 'Đẩy kết quả lên để studio phát video trong tab Mô phỏng.',
      });
    } catch (err) {
      pushToast({
        message: 'Không dựng được demo',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setDemoBusy(false);
    }
  };

  // Conflict-aware pull of ONE project's files (PLAN → RESOLVE → APPLY).
  // 0 conflicts → apply straight through (keep-local default, no modal); else open
  // PullConflictModal so the user resolves each differing file. Reached from the
  // Pull modal when exactly one locally-mirrored project is selected — bulk pulls
  // take the blind-overwrite path instead (pre-pull .odhistory snapshot).
  const pullProject = async (pid: string) => {
    try {
      const plan = await pullPlan(pid);
      if (plan.conflicts.length === 0) {
        const result = await pullApply({
          projectId: pid,
          planId: plan.planId,
          resolutions: {},
          onConflictDefault: 'local',
        });
        void load(pid, { background: true });
        pushToast({
          message: `Pulled “${pid}” — ${result.downloaded} new file(s)`,
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
    // Target platform for the UX stage (`acceptsPlatform`). `undefined` omits
    // the field → the skill's default (mobile).
    platform?: TargetPlatform,
  ) => {
    if (!projectId) return;
    const body: Record<string, unknown> = { projectId };
    if (payload?.source) body.source = payload.source;
    else if (payload?.input && payload.input.trim()) body.input = payload.input.trim();
    if (payload?.followLinks === false) body.followLinks = false;
    if (payload?.includeDescendants) body.includeDescendants = true;
    // docs-to-ui docs step: chosen UI targets → daemon writes targets.json.
    if (payload?.targets && payload.targets.length) body.targets = payload.targets;
    if (designSystemId !== undefined) body.designSystemId = designSystemId;
    if (platform !== undefined) body.platform = platform;
    // Re-run clear scope chosen in the scope modal (default 'stage' when absent —
    // still clears this stage's own outputs so the agent regenerates).
    if (pendingResetScopeRef.current) body.resetScope = pendingResetScopeRef.current;
    pendingResetScopeRef.current = undefined;
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
    markPendingStart(pipelineId);
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

  // Kick the WHOLE workflow (POST /api/pipelines/run-all): the daemon chains
  // every stage automatically — no per-stage review. We optimistically flip the
  // first planned stage to running; the poller tracks the rest of the chain.
  const startRunAll = async (payload: RunAllPayload) => {
    if (!projectId) return;
    const res = await fetch('/api/pipelines/run-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        ...(workflowId ? { workflowId } : {}),
        ...(payload.input ? { input: payload.input } : {}),
        ...(payload.confluencePages?.length ? { confluencePages: payload.confluencePages } : {}),
        terminal: payload.terminal,
        platform: payload.platform,
        ...(payload.targets?.length ? { targets: payload.targets } : {}),
        designSystemId: payload.designSystemId,
        ...(payload.skipSucceeded ? { skipSucceeded: true } : {}),
        ...(payload.lean ? { lean: true } : {}),
        ...(payload.followLinks === false ? { followLinks: false } : {}),
        ...(payload.includeDescendants ? { includeDescendants: true } : {}),
      }),
    });
    if (!res.ok && res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `run-all failed: ${res.status}`);
    }
    const j = (await res.json().catch(() => null)) as { stages?: string[] } | null;
    const first = j?.stages?.[0];
    if (first) {
      markPendingStart(first);
      setPipelines((prev) => prev.map((p) => (p.id === first ? { ...p, status: 'running' } : p)));
    }
    // NO immediate reload here — same as startRun. The daemon kicks the chain
    // off fire-and-forget and answers 202 before any stage is marked running, so
    // a reload fired now races it and almost always wins: the fetched (still
    // idle) rows replace the optimistic "running" one, `anyRunning` goes false,
    // and the 2.5s poller therefore never starts — the board sits frozen until
    // something else forces a load, e.g. leaving the route and coming back.
    // Worst with "skip succeeded", where the first stage is an agent stage whose
    // pre-run pull delays the status flip by seconds.
    // The optimistic flip alone starts the poller, which owns the rest.
    pushToast({
      message: `Đã khởi động full workflow — ${j?.stages?.length ?? 0} bước chạy nối tiếp trong nền`,
      details: (j?.stages ?? []).join(' → '),
    });
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

  // Transitive downstream of a stage (every pipeline whose dependsOn chain
  // reaches it) — drives whether the re-run scope choice is meaningful.
  const downstreamOf = useCallback(
    (id: string): PipelineView[] => {
      const set = new Set<string>([id]);
      for (;;) {
        let grew = false;
        for (const p of pipelines) {
          if (set.has(p.id)) continue;
          if (p.dependsOn.some((d) => set.has(d))) {
            set.add(p.id);
            grew = true;
          }
        }
        if (!grew) break;
      }
      return pipelines.filter((p) => p.id !== id && set.has(p.id));
    },
    [pipelines],
  );

  // The normal run flow: stages with an input/design-system/platform choice open
  // their modal first; the rest start immediately.
  const proceedRun = (p: PipelineView) => {
    if (p.inputPlaceholder) setRunInputFor(p);
    else if (p.acceptsDesignSystem) setDesignSystemFor(p);
    else if (p.acceptsPlatform) setPlatformFor(p);
    else void runDirect(p);
  };

  // Run click: a RE-RUN (already succeeded) of a stage that has downstream first
  // asks the clear scope (this stage only vs also the stale downstream); then the
  // normal flow proceeds. A first run — or a terminal with no downstream — skips
  // straight to it (a re-run there still clears its own output daemon-side).
  const onRunClick = (p: PipelineView) => {
    if (p.status === 'succeeded' && downstreamOf(p.id).length > 0) setResetScopeFor(p);
    else proceedRun(p);
  };

  const openChat = (p: PipelineView) => {
    if (!p.lastConversationId) return;
    navigate({ kind: 'project', projectId, conversationId: p.lastConversationId, fileName: null });
  };

  const hasProjects = projects.length > 0;

  // UI-Spec option picker (the merged terminal step's Run): choose HTML or
  // React, then hand off to the normal per-pipeline run flow.
  const [uiSpecPickerOpen, setUiSpecPickerOpen] = useState(false);

  // Group the flat pipeline list into stepper entries. The UI-Spec terminals
  // (ui-html | ui-react) are alternative OPTIONS of one step — they render as
  // ONE card whose Run opens an option-picker modal, so the flow never reads
  // as "HTML first, React after". Membership is by EXPLICIT id (mirror of the
  // daemon's UI_TERMINAL_IDS), NOT by comparing dependsOn: dependsOn identity
  // is server-derived data, and a daemon reporting mode-adjusted lists once
  // fused cj/ux-research/ux into a phantom three-badge "UI-Spec" card. Ids
  // cannot drift per mode, so this grouping is stable no matter what the
  // daemon reports.
  const UI_TERMINAL_IDS = new Set(['ui-html', 'ui-react']);
  const stepEntries: PipelineView[][] = [];
  for (const p of pipelines) {
    const last = stepEntries[stepEntries.length - 1];
    const sibling = !!last && UI_TERMINAL_IDS.has(p.id) && UI_TERMINAL_IDS.has(last[0]!.id);
    if (sibling) last!.push(p);
    else stepEntries.push([p]);
  }
  // A step is done when any of its options succeeded (either UI-Spec output
  // completes the step).
  const doneCount = stepEntries.filter((opts) => opts.some((p) => p.status === 'succeeded')).length;
  const feedbackPipeline = pipelines
    .filter((pipeline) => pipeline.status === 'succeeded' || pipeline.status === 'failed')
    .sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0))
    .at(-1);
  const feedbackRunId = feedbackPipeline
    ? feedbackPipeline.lastRunId
      ?? `legacy:${projectId}:${workflowId}:${feedbackPipeline.id}:${feedbackPipeline.updatedAt ?? 'existing'}`
    : null;

  // Full-page Quick result route: swap the whole stepper for the output preview
  // so it owns the viewport (the old modal was too cramped). The pipeline comes
  // from the already-loaded list; `back` returns to the stepper.
  if (route.kind === 'pipeline-result') {
    const target = pipelines.find((p) => p.id === route.pipelineId);
    const backToStepper = () => navigate({ kind: 'home', view: 'pipelines' });
    if (target) {
      return (
        <PipelineResultView
          projectId={route.projectId}
          projectKind="other"
          pipeline={target}
          workflowId={workflowId}
          onBack={backToStepper}
          onViewFile={(fileName) =>
            navigate({ kind: 'project', projectId: route.projectId, conversationId: null, fileName })
          }
        />
      );
    }
    return (
      <section className="pl-result-page pl-result-page--gate" aria-label="Quick result">
        <header className="pl-result-page__header">
          <button type="button" className="pl-btn pl-result-page__back" onClick={backToStepper}>
            <Icon name="arrow-left" size={14} />
            <span>Pipelines</span>
          </button>
        </header>
        <div className="pl-result-page__body">
          <p className="pl-modal-empty">
            {loading || !projectsLoaded ? 'Đang tải kết quả…' : 'Không tìm thấy pipeline này.'}
          </p>
        </div>
      </section>
    );
  }

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
          <p className="pipelines-page__lede">Biến tài liệu sản phẩm thành màn hình UI:</p>
          <ol className="pipelines-page__steps">
            <li>
              <span>
                <strong>Chọn dự án</strong> — chưa có thì bấm <strong>Tải dự án về…</strong>
              </span>
            </li>
            <li>
              <span>
                <strong>Chạy lần lượt các bước</strong> — bước sau mở khi bước trước xong.
              </span>
            </li>
            <li>
              <span>
                <strong>Đẩy kết quả lên…</strong> để studio và máy khác cùng thấy.
              </span>
            </li>
          </ol>
        </div>
        {hasProjects && pipelines.length > 0 ? (
          <div className="pipelines-progress" aria-label="Pipeline progress">
            <span className="pipelines-progress__count">
              {doneCount}
              <span className="pipelines-progress__total">/{stepEntries.length}</span>
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

      {/* Sync toolbar — MỘT cặp Pull/Push duy nhất. Mỗi nút mở hộp thoại chọn
          dự án + bước (dự án đang chọn được tick sẵn nên thao tác thường ngày
          vẫn là 2 click); pull đúng một dự án đã có trên máy đi đường xử lý
          xung đột. Build app KHÔNG nằm ở đây — nó thuộc option React trong
          modal UI-Spec. */}
      <div className="pipelines-toolbar">
        <div className="pipelines-toolbar__group pipelines-toolbar__group--actions">
          <span className="pipelines-toolbar__label">Chạy</span>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => setRunAllOpen(true)}
            disabled={!projectId || pipelines.length === 0 || pipelines.some((p) => p.status === 'running' || p.status === 'queued')}
            title="Chạy toàn bộ workflow tự động — các bước nối tiếp nhau, không cần duyệt output từng bước"
          >
            <Icon name="play" size={14} />
            <span>Chạy full workflow</span>
          </button>
          {/* Chế độ đang lưu của dự án. Chỉ hiện khi Tiết kiệm — ở chế độ Đầy
              đủ không có bước nào bị bỏ nên không có gì phải giải thích. Bấm
              vào mở đúng modal đã chọn ra nó. */}
          {runMode === 'lean' && pipelines.some((p) => p.skipped) ? (
            <button
              type="button"
              className="pl-mode-chip"
              onClick={() => setRunAllOpen(true)}
              title="Dự án đang chạy ở chế độ Tiết kiệm — các bước phân tích bị bỏ qua. Bấm để đổi chế độ ở modal Chạy full workflow."
            >
              <Icon name="file-code" size={12} />
              <span>Tiết kiệm</span>
              <span className="pl-mode-chip__count">
                bỏ {pipelines.filter((p) => p.skipped).length} bước
              </span>
            </button>
          ) : null}
        </div>
        <div className="pipelines-toolbar__group pipelines-toolbar__group--actions">
          <span className="pipelines-toolbar__label">Đồng bộ</span>
          <button
            type="button"
            className="pl-btn"
            onClick={() => setPullAllOpen(true)}
            disabled={syncBusy !== null}
            title="Tải dự án từ kho chung (KGS) về máy — hộp thoại cho chọn dự án và bước; dự án đang chọn được tick sẵn"
          >
            <Icon name={syncBusy === 'pull' ? 'spinner' : 'download'} size={14} />
            <span>{syncBusy === 'pull' ? 'Đang tải…' : 'Tải dự án về…'}</span>
          </button>
          <button
            type="button"
            className="pl-btn"
            onClick={() => setPushAllOpen(true)}
            disabled={syncBusy !== null}
            title="Đẩy kết quả lên kho chung (KGS) để studio / máy khác thấy — hộp thoại cho chọn dự án và bước; dự án đang chọn được tick sẵn"
          >
            <Icon name={syncBusy === 'push' ? 'spinner' : 'upload'} size={14} />
            <span>{syncBusy === 'push' ? 'Đang đẩy…' : 'Đẩy kết quả lên…'}</span>
          </button>
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
        {(() => {
          const projectCard = (pr: PipelineProject) => {
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
          };
          const moreCards = (
            <>
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
            </>
          );
          // Chưa gán app nào → lưới phẳng như cũ. Có app → mỗi app một nhóm
          // đóng/mở được, feature lẻ dồn xuống nhóm "Chưa gán app" cuối cùng.
          if (!groupedByApp) {
            return (
              <div className="pl-card-grid">
                {visibleProjects.map(projectCard)}
                {moreCards}
              </div>
            );
          }
          const hasMoreCards =
            hiddenProjectCount > 0 || (showAllProjects && projects.length > PROJECT_CARD_LIMIT);
          return (
            <>
              {projectGroups.map((g) => {
                const collapsed = collapsedApps.has(g.key);
                const done = g.projects.reduce((n, p) => n + p.done, 0);
                const total = g.projects.reduce((n, p) => n + p.total, 0);
                const running = g.projects.reduce((n, p) => n + p.running, 0);
                return (
                  <div key={g.key || '(no-app)'} className="pl-app-group">
                    <button
                      type="button"
                      className="pl-app-group__head"
                      onClick={() => toggleAppGroup(g.key)}
                      aria-expanded={!collapsed}
                    >
                      <span className={`pl-app-group__chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">
                        <Icon name="chevron-right" size={14} />
                      </span>
                      <Icon name={g.key ? 'blocks' : 'folder'} size={14} />
                      <span className="pl-app-group__name">{g.name}</span>
                      <span className="pl-app-group__meta">
                        {g.projects.length} feature · {done}/{total} done
                        {running > 0 ? ` · ${running} running` : ''}
                      </span>
                    </button>
                    {!collapsed ? <div className="pl-card-grid">{g.projects.map(projectCard)}</div> : null}
                  </div>
                );
              })}
              {hasMoreCards ? <div className="pl-card-grid">{moreCards}</div> : null}
            </>
          );
        })()}
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
              system). Nhờ quản lý add bạn vào dự án, rồi bấm <strong>Tải dự án về…</strong> (hoặc{' '}
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
          {stepEntries.map((opts, idx) => {
            const isLast = idx === stepEntries.length - 1;
            // Option-group step (the UI-Spec terminals): ONE card whose Run
            // opens the HTML-vs-React picker modal — the options are
            // alternatives, not consecutive steps.
            if (opts.length > 1) {
              const anyRunning = opts.some((o) => o.status === 'running' || o.status === 'queued');
              const anyDone = opts.some((o) => o.status === 'succeeded');
              const active = opts.some((o) => o.active);
              const groupStatus = anyRunning ? 'running' : anyDone ? 'succeeded' : 'idle';
              return (
                <li
                  key={opts.map((o) => o.id).join('+')}
                  className="pl-step"
                  data-status={groupStatus}
                  data-active={active ? 'yes' : 'no'}
                >
                  <div className="pl-step__spine" aria-hidden="true">
                    <span className="pl-step__node">
                      {anyDone ? (
                        <Icon name="check" size={14} />
                      ) : anyRunning ? (
                        <Icon name="spinner" size={14} />
                      ) : !active ? (
                        <Icon name="eye-off" size={13} />
                      ) : (
                        <span className="pl-step__num">{idx + 1}</span>
                      )}
                    </span>
                    {!isLast ? <span className="pl-step__connector" /> : null}
                  </div>

                  <div className="pl-step__card">
                    <span className="pl-step__icon" aria-hidden="true">
                      <Icon name="blocks" size={18} />
                    </span>
                    <div className="pl-step__body">
                      <div className="pl-step__heading">
                        <span className="pl-step__name">UI-Spec</span>
                        {opts.map((o) => (
                          <span key={o.id} className={`pl-status pl-status--${o.status}`}>
                            {uiSpecOptionLabel(o)}: {STATUS_LABEL[o.status] ?? o.status}
                          </span>
                        ))}
                      </div>
                      <p className="pl-step__desc">
                        Bước cuối — sinh UI-Spec từ UX Spec. Bấm Run để chọn định dạng: HTML
                        prototype hoặc React app (chạy một hoặc cả hai).
                      </p>
                      {/* Một card không được vừa tick xanh vừa báo "khóa". Đã có
                          option chạy xong nghĩa là bước này ĐÃ mở khóa; nếu giờ
                          gate không còn thỏa thì đó là bước trên vừa bị reset —
                          nói đúng chuyện đó thay vì gọi là khóa. Gate lấy theo
                          effectiveDependsOn để không bao giờ nêu tên một bước
                          mà chế độ hiện tại bỏ qua. */}
                      {!active && (opts[0]!.effectiveDependsOn ?? opts[0]!.dependsOn).length > 0 ? (
                        <p className={anyDone ? 'pl-step__stale' : 'pl-step__lock'}>
                          <Icon name={anyDone ? 'info' : 'eye-off'} size={12} />
                          {anyDone ? 'Bản hiện tại dựng từ kết quả cũ — chạy lại ' : 'Cần xong '}
                          {(opts[0]!.effectiveDependsOn ?? opts[0]!.dependsOn)
                            .map((dep) => pipelines.find((x) => x.id === dep)?.name ?? dep)
                            .join(', ')}
                          {anyDone ? ' để đồng bộ lại' : ' trước'}
                        </p>
                      ) : null}
                    </div>

                    <div className="pl-step__actions">
                      <button
                        type="button"
                        className="pl-btn pl-btn--run"
                        onClick={() => setUiSpecPickerOpen(true)}
                        disabled={!active}
                        title="Chọn định dạng UI-Spec (HTML / React) rồi chạy"
                      >
                        <Icon name={anyRunning ? 'spinner' : 'play'} size={14} />
                        <span>{anyRunning ? 'Đang chạy…' : anyDone ? 'Run / kết quả' : 'Run'}</span>
                      </button>
                    </div>
                  </div>
                </li>
              );
            }
            const p = opts[0]!;
            const isBusy = busyId === p.id;
            const isRunning = p.status === 'running' || p.status === 'queued';
            const meta = metaFor(p.id);
            const canChat = !!p.lastConversationId;
            const hasRunInfo = Boolean(p.updatedAt || p.lastInput || p.lastSource || p.lastRunId);
            const infoOpen = infoForId === p.id;
            const histOpen = historyForId === p.id;
            // BỎ QUA ≠ BỊ KHÓA: chế độ Tiết kiệm không chạy bước này, nhưng nó
            // không chặn ai cả và vẫn bấm chạy lẻ được. Chỉ tính là "bỏ qua"
            // khi bước CHƯA có kết quả — đã có output (từ lần chạy Đầy đủ
            // trước) thì vẫn là Done, không bao giờ giấu kết quả thật.
            const isSkipped = p.skipped === true && p.status !== 'succeeded' && !isRunning;
            return (
              <li
                key={p.id}
                className="pl-step"
                data-status={p.status}
                data-active={p.active ? 'yes' : 'no'}
                data-skipped={isSkipped ? 'yes' : 'no'}
              >
                <div className="pl-step__spine" aria-hidden="true">
                  <span className="pl-step__node">
                    {p.status === 'succeeded' ? (
                      <Icon name="check" size={14} />
                    ) : isRunning ? (
                      <Icon name="spinner" size={14} />
                    ) : isSkipped ? (
                      <Icon name="minus" size={13} />
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
                      <span className={`pl-status pl-status--${isSkipped ? 'skipped' : p.status}`}>
                        {isSkipped ? 'Bỏ qua' : (STATUS_LABEL[p.status] ?? p.status)}
                      </span>
                      {p.skipped && p.status === 'succeeded' ? (
                        <span className="pl-status pl-status--offmode" title="Bước này không nằm trong chế độ Tiết kiệm — kết quả còn lại từ lần chạy trước">
                          ngoài chế độ
                        </span>
                      ) : null}
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
                    {/* `updatedAt` là dấu thời gian của LẦN GHI STATE gần nhất,
                        không phải lần chạy: reset downstream lúc bắt đầu
                        run-all cũng đóng dấu nó — và vì reset MERGE metadata
                        (db giữ nguyên lastRunId cũ), lastRunId không chứng minh
                        được gì. Chỉ status mới đáng tin: idle (kể cả "Bỏ qua")
                        thì không có dòng "Last run" — nếu không sẽ ra "Bỏ qua ·
                        Last run: 35m ago", tự mâu thuẫn. Chi tiết lần chạy cũ
                        vẫn xem được ở nút (i) và Lịch sử. */}
                    {p.updatedAt && (isRunning || p.status === 'succeeded' || p.status === 'failed') ? (
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
                    {/* Bước bỏ qua mà đầu vào của nó CHƯA xong thì vẫn chưa chạy
                        được — lúc đó nói lý do thật (thiếu đầu vào) thay vì mời
                        chạy bổ sung một thứ đang bấm không được. */}
                    {isSkipped && p.active ? (
                      <p className="pl-step__skipnote">
                        <Icon name="minus" size={12} />
                        Bỏ qua ở chế độ Tiết kiệm — không chặn bước nào; chạy bổ sung nếu cần bàn
                        giao.
                      </p>
                    ) : !p.active && (p.effectiveDependsOn ?? p.dependsOn).length > 0 ? (
                      <p className="pl-step__lock">
                        <Icon name="eye-off" size={12} />
                        Cần xong{' '}
                        {(p.effectiveDependsOn ?? p.dependsOn)
                          .map((dep) => pipelines.find((x) => x.id === dep)?.name ?? dep)
                          .join(', ')}{' '}
                        trước
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
                          onClick={() =>
                            navigate({ kind: 'pipeline-result', projectId, pipelineId: p.id })
                          }
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
                      // Bước bị bỏ qua vẫn chạy được: nút chuyển sang thứ cấp
                      // (không phải hành động chính của chế độ này) nhưng KHÔNG
                      // bao giờ disable — bỏ qua là mặc định, không phải cấm.
                      <button
                        type="button"
                        className={isSkipped ? 'pl-btn' : 'pl-btn pl-btn--run'}
                        onClick={() => onRunClick(p)}
                        disabled={isBusy}
                        title={
                          isSkipped
                            ? 'Chạy riêng bước này dù chế độ Tiết kiệm bỏ qua nó'
                            : 'Run this pipeline in the background'
                        }
                      >
                        <Icon name={isBusy ? 'spinner' : 'play'} size={14} />
                        <span>{isBusy ? 'Starting…' : isSkipped ? 'Chạy bổ sung' : 'Run'}</span>
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
          {feedbackPipeline && feedbackRunId ? (
            <PipelineEvaluationStep
              projectId={projectId}
              workflowId={workflowId}
              pipeline={feedbackPipeline}
              pipelines={pipelines}
              runId={feedbackRunId}
              submitted={ratedRunIds.has(feedbackRunId)}
              onSubmitted={() => setRatedRunIds((current) => new Set(current).add(feedbackRunId))}
            />
          ) : null}
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
      {uiSpecPickerOpen
        ? (() => {
            // Live options from the current pipeline list (statuses keep
            // refreshing while the modal is open). Matched by terminal id, not
            // "any multi-entry group" — this modal is specifically the
            // HTML-vs-React picker.
            const options = stepEntries.find(
              (e) => e.length > 1 && e.every((o) => UI_TERMINAL_IDS.has(o.id)),
            );
            if (!options) return null;
            return (
              <PlModal
                title="UI-Spec — chọn định dạng"
                icon="blocks"
                size="md"
                onClose={() => setUiSpecPickerOpen(false)}
              >
                <p style={{ fontSize: 12.5, opacity: 0.75, margin: '0 0 12px' }}>
                  Hai lựa chọn là NGANG HÀNG — cùng sinh UI-Spec từ UX Spec. Chạy một định dạng,
                  hoặc cả hai nếu cần so sánh.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {options.map((o) => {
                    const oRunning = o.status === 'running' || o.status === 'queued';
                    const oCanChat = !!o.lastConversationId;
                    return (
                      <div
                        key={o.id}
                        style={{
                          border: '1px solid var(--border, rgba(127,127,127,.3))',
                          borderRadius: 10,
                          padding: '14px 14px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Icon name={o.id === 'ui-react' ? 'blocks' : 'file-code'} size={18} />
                          <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                            {uiSpecOptionLabel(o)}
                          </span>
                          <span className={`pl-status pl-status--${o.status}`}>
                            {STATUS_LABEL[o.status] ?? o.status}
                          </span>
                        </div>
                        <p style={{ fontSize: 12, opacity: 0.75, margin: 0, flex: 1 }}>
                          {o.id === 'ui-react'
                            ? 'App Vite + React 19 + Tailwind v4 thật, build trong Docker — preview như app chạy thật, có luồng điều hướng.'
                            : 'HTML/CSS prototype tương tác — mỗi màn một file tự chứa, mở xem ngay không cần build.'}
                        </p>
                        {/* Cùng luật với card trên stepper: idle không có "Last
                            run" — updatedAt của bước idle là dấu reset, không
                            phải dấu lần chạy. */}
                        {o.updatedAt && (oRunning || o.status === 'succeeded' || o.status === 'failed') ? (
                          <p style={{ fontSize: 11.5, opacity: 0.6, margin: 0 }}>
                            Last run: {relativeTimeLong(o.updatedAt, t)}
                          </p>
                        ) : null}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {oRunning ? (
                            <button
                              type="button"
                              className="pl-btn pl-btn--run"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                setStatusFor(o);
                              }}
                            >
                              <Icon name="spinner" size={14} />
                              <span>Status</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="pl-btn pl-btn--run"
                              disabled={busyId === o.id || !o.active}
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                onRunClick(o);
                              }}
                            >
                              <Icon
                                name={o.status === 'failed' || o.status === 'succeeded' ? 'refresh' : 'play'}
                                size={14}
                              />
                              <span>
                                {o.status === 'succeeded'
                                  ? 'Run again'
                                  : o.status === 'failed'
                                    ? 'Retry'
                                    : 'Run'}
                              </span>
                            </button>
                          )}
                          {o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                navigate({ kind: 'pipeline-result', projectId, pipelineId: o.id });
                              }}
                            >
                              <Icon name="file-code" size={14} />
                              <span>Quick result</span>
                            </button>
                          ) : null}
                          {o.status === 'failed' ? (
                            <button
                              type="button"
                              className="pl-btn pl-btn--danger"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                setStatusFor(o);
                              }}
                            >
                              <Icon name="info" size={14} />
                              <span>View error</span>
                            </button>
                          ) : null}
                          {oCanChat ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => openChat(o)}
                            >
                              <Icon name="comment" size={14} />
                              <span>Open chat</span>
                            </button>
                          ) : null}
                          {o.id === 'ui-react' && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void buildReactApp()}
                              disabled={buildBusy || demoBusy || !projectId}
                              title="Build lại app từ source — react/dist/ không được sync, nên sau khi Pull dự án cần build lại để preview. Cần Docker trên máy này."
                            >
                              <Icon name={buildBusy ? 'spinner' : 'play'} size={14} />
                              <span>{buildBusy ? 'Đang build…' : 'Build app'}</span>
                            </button>
                          ) : null}
                          {o.id === 'ui-react' && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void buildReactDemoRun()}
                              disabled={demoBusy || buildBusy || !projectId}
                              title="Prototype tự chạy: Playwright bấm xuyên các kịch bản flow.json trên app đã build, ghi video + screenshot từng bước vào react/prototype-demo/ (không dùng agent). Lần đầu sẽ cài Playwright + Chromium (một lần)."
                            >
                              <Icon name={demoBusy ? 'spinner' : 'present'} size={14} />
                              <span>{demoBusy ? 'Đang quay…' : 'Dựng demo'}</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="pl-btn"
                            onClick={() => {
                              setUiSpecPickerOpen(false);
                              setHistoryForId(o.id);
                              if (projectId) void loadHistory(projectId);
                            }}
                            title="Các bản đã push chứa output của định dạng này"
                          >
                            <Icon name="history" size={14} />
                            <span>Lịch sử</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </PlModal>
            );
          })()
        : null}
      {pullAllOpen ? (
        <PullAllModal
          localIds={new Set(projects.map((pr) => pr.id))}
          workflows={activeWorkflows}
          scopeName={activeWorkflows[0]?.name}
          initialSelectedIds={projectId ? [projectId] : undefined}
          onClose={() => setPullAllOpen(false)}
          onConfirm={async (ids, stages) => {
            // Exactly ONE locally-mirrored project + full stage scope → the
            // conflict-aware path (PLAN → RESOLVE → APPLY), so local edits are
            // never overwritten silently. Anything broader takes the bulk
            // endpoint (blind overwrite behind a pre-pull .odhistory snapshot).
            const allStages = activeWorkflows[0]?.pipelineIds.length ?? 0;
            const pid = ids.length === 1 ? ids[0]! : null;
            if (pid && projects.some((pr) => pr.id === pid) && stages.length >= allStages) {
              setProjectId(pid);
              await pullProject(pid);
              return;
            }
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
          initialSelectedIds={projectId ? [projectId] : undefined}
          onClose={() => setPushAllOpen(false)}
          onConfirm={async (ids, stages) => {
            const ok = await syncAll('push', ids, stages);
            if (!ok) throw new Error('Push failed — see the toast for details.');
          }}
        />
      ) : null}
      {runAllOpen ? (() => {
        const runAllProject = projects.find((pr) => pr.id === projectId);
        // Saved run-all config (this device's last trigger) wins; a project
        // that has never run full-workflow yet has no `savedRunAll`, so this
        // falls back to Pipeline Studio's config — exactly "first run defaults
        // from Studio, every run after that remembers what was last used".
        const runAllDefaults = runAllProject?.savedRunAll ?? runAllProject?.config;
        return (
          <RunAllModal
            workflowName={workflows.find((w) => w.id === workflowId)?.name ?? 'Docs → UI-Spec'}
            defaultConfluencePages={runAllDefaults?.confluencePages}
            defaultDesignSystemId={runAllDefaults?.designSystemId}
            defaultTerminal={runAllDefaults?.terminal}
            defaultPlatform={runAllDefaults?.platform}
            defaultTargets={runAllDefaults?.targets}
            defaultFollowLinks={runAllDefaults?.followLinks}
            defaultSkipSucceeded={runAllDefaults?.skipSucceeded}
            defaultLean={runAllDefaults?.lean}
            // Only show a picker when the active workflow HAS a stage using it —
            // Docs → PRD Review has no UX/UI/design-system stage, so it shows
            // just the Confluence source + scan toggles.
            hasPlatform={pipelines.some((p) => p.acceptsPlatform)}
            hasTerminal={pipelines.some((p) => p.id === 'ui-html' || p.id === 'ui-react')}
            hasDesignSystem={pipelines.some((p) => p.acceptsDesignSystem)}
            // Lean chỉ là khái niệm của docs-to-ui — các workflow khác (Docs →
            // PRD Review) chạy đủ chuỗi, ẩn hẳn section "Chế độ chạy".
            supportsLean={workflowId === 'docs-to-ui'}
            anySucceeded={pipelines.some((p) => p.status === 'succeeded')}
            onClose={() => setRunAllOpen(false)}
            onRun={startRunAll}
          />
        );
      })() : null}
      {runInputFor ? (() => {
        const runInputProject = projects.find((pr) => pr.id === projectId);
        const runInputDefaults = runInputProject?.savedRunAll ?? runInputProject?.config;
        return (
        <RunInputModal
          pipelineName={runInputFor.name}
          placeholder={runInputFor.inputPlaceholder ?? ''}
          defaultConfluencePages={runInputProject?.config?.confluencePages}
          defaultBasDocumentId={runInputProject?.config?.basDocumentId}
          // Docs step of docs-to-ui: offer the UI-target picker so targets.json
          // is written from the docs run (Docs → PRD Review has no such stage).
          showTargets={pipelines.some((p) => p.acceptsPlatform)}
          defaultTargets={runInputDefaults?.targets}
          onClose={() => setRunInputFor(null)}
          onRun={async (payload) => {
            await startRun(runInputFor.id, payload);
            pushToast({ message: `Started “${runInputFor.name}” — running in background` });
          }}
        />
        );
      })() : null}
      {designSystemFor ? (
        <DesignSystemRunModal
          pipelineName={designSystemFor.name}
          defaultId={projects.find((pr) => pr.id === projectId)?.config?.designSystemId ?? undefined}
          onClose={() => setDesignSystemFor(null)}
          onRun={async (designSystemId) => {
            await startRun(designSystemFor.id, undefined, designSystemId);
            pushToast({ message: `Started “${designSystemFor.name}” — running in background` });
          }}
        />
      ) : null}
      {platformFor ? (
        <PlatformRunModal
          pipelineName={platformFor.name}
          onClose={() => setPlatformFor(null)}
          onRun={async (platform) => {
            await startRun(platformFor.id, undefined, undefined, platform);
            pushToast({ message: `Started “${platformFor.name}” — running in background` });
          }}
        />
      ) : null}
      {resetScopeFor ? (
        <RerunScopeModal
          pipelineName={resetScopeFor.name}
          downstreamNames={downstreamOf(resetScopeFor.id).map((d) => d.name)}
          onClose={() => setResetScopeFor(null)}
          onChoose={async (scope) => {
            // Remember the choice, then continue into the stage's normal run
            // flow (which may open the platform/design-system/input modal).
            pendingResetScopeRef.current = scope;
            const p = resetScopeFor;
            setResetScopeFor(null);
            proceedRun(p);
          }}
        />
      ) : null}
      {statusFor ? (
        <PipelineStatusModal
          // Fresh copy from the polled list so the fan-out task list updates live.
          pipeline={pipelines.find((p) => p.id === statusFor.id) ?? statusFor}
          projectId={projectId ?? ''}
          onClose={() => setStatusFor(null)}
          onOpenTask={(conversationId) => {
            navigate({ kind: 'project', projectId, conversationId, fileName: null });
            setStatusFor(null);
          }}
          onOpenChat={
            statusFor.lastConversationId
              ? () => {
                  openChat(statusFor);
                  setStatusFor(null);
                }
              : null
          }
          onRefresh={() => {
            if (projectId) void load(projectId, { background: true });
          }}
        />
      ) : null}
      {pullPlanState ? (
        <PullConflictModal
          projectId={projectId}
          plan={pullPlanState}
          onClose={() => setPullPlanState(null)}
          onApplied={(result) => {
            void load(projectId, { background: true });
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
