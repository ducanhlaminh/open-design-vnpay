// Pipelines page (docs → UI). A per-KGS-app, dependency-gated flow of the five
// pipelines, rendered as a numbered vertical stepper that mirrors the actual
// DAG: jira-ingest → feature-analysis → {ux-spec ∥ customer-journey} → ui.
//
// The "project" here is a KGS app — a project pulled from the central KGS
// (`od kg pull`), whose id is the KGS project_id. Runs happen in the BACKGROUND:
// pressing Run seeds a conversation + starts the agent on the daemon and we stay
// on this page (the daemon already runs async; we just poll status). Each row
// then exposes Status (compact run modal), Open chat (prompt more), and Quick
// result (the stage's output files). A step is locked until its prerequisites
// have succeeded.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PipelineProject,
  PipelineProjectsResponse,
  PipelineView,
  PipelinesResponse,
  RunPipelineResponse,
  Workflow,
  WorkflowsResponse,
} from '@open-design/contracts';

import { Icon, type IconName } from './Icon';
import { Toast } from './Toast';
import { navigate } from '../router';
import {
  NewPipelineProjectModal,
  PipelineResultModal,
  PipelineStatusModal,
  RunInputModal,
} from './pipelines/PipelineModals';

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
  'customer-journey': { icon: 'orbit', blurb: 'Map the end-to-end customer journey across the features.' },
  ui: { icon: 'blocks', blurb: 'Generate the static + interactive UI screens, then preview them.' },
  'html-feature-cj': {
    icon: 'search',
    blurb: 'Generate the feature set AND the customer journey together in one run.',
  },
  'ui-html': {
    icon: 'file-code',
    blurb: 'Build the interactive HTML/CSS prototype — one self-contained file per screen.',
  },
};

// Workflow B reuses the same upstream skills under distinct ids; map them to the
// canonical meta so its steps get the right icon + blurb.
const META_ALIAS: Record<string, string> = {
  'html-docs': 'jira-ingest',
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
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string>('');
  const [projects, setProjects] = useState<PipelineProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [pipelines, setPipelines] = useState<PipelineView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [syncBusy, setSyncBusy] = useState<null | 'pull' | 'push'>(null);
  const [uploading, setUploading] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [runInputFor, setRunInputFor] = useState<PipelineView | null>(null);
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

  // Pull/push ALL KGS apps at once (not per-project). Pull refreshes the app list.
  const syncAll = async (kind: 'pull' | 'push') => {
    setSyncBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/kg/${kind}-all`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `${kind}-all failed: ${res.status}`);
      if (kind === 'pull') {
        await loadProjects();
        if (projectId) void load(projectId);
      }
      pushToast({ message: kind === 'pull' ? 'Pulled all apps from KGS' : 'Pushed all apps to KGS' });
    } catch (err) {
      pushToast({
        message: kind === 'pull' ? "Couldn't pull from KGS" : "Couldn't push to KGS",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setSyncBusy(null);
    }
  };

  // Create a brand-new pipeline project (id IS the KGS project_id). Throws on
  // failure so the modal can keep itself open + show the inline error too.
  const createProject = async (id: string) => {
    try {
      const res = await fetch('/api/pipelines/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: id, name: id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `create failed: ${res.status}`);
      await loadProjects();
      setProjectId(id);
      pushToast({ message: `Created project “${id}”` });
    } catch (err) {
      pushToast({
        message: "Couldn't create project",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
      throw err;
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

  // Start a pipeline run in the BACKGROUND: POST the run, optimistically flip the
  // row to "running" (the poller takes over), and DON'T navigate away. Throws on
  // failure so callers (incl. the input modal) can surface it.
  const startRun = async (pipelineId: string, input?: string) => {
    if (!projectId) return;
    const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...(input && input.trim() ? { input: input.trim() } : {}) }),
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
            onClick={() => void syncAll('pull')}
            disabled={syncBusy !== null}
            title="Pull ALL apps from KGS into the local mirror"
          >
            <Icon name={syncBusy === 'pull' ? 'spinner' : 'download'} size={14} />
            <span>{syncBusy === 'pull' ? 'Pulling…' : 'Pull all'}</span>
          </button>
          <button
            type="button"
            className="pl-btn"
            onClick={() => void syncAll('push')}
            disabled={syncBusy !== null}
            title="Push ALL locally-mirrored apps back to KGS"
          >
            <Icon name={syncBusy === 'push' ? 'spinner' : 'upload'} size={14} />
            <span>{syncBusy === 'push' ? 'Pushing…' : 'Push all'}</span>
          </button>
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
        </div>
      </div>

      {/* Req 1 + 2: KGS project selection cards + New project card */}
      <section className="pipelines-projects" aria-label="KGS project">
        <span className="pl-field__label">KGS project</span>
        <div className="pl-card-grid">
          {projects.map((pr) => {
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
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className="pl-proj-card pl-proj-card--new"
            onClick={() => setNewProjectOpen(true)}
          >
            <Icon name="plus" size={18} />
            <span>New project</span>
          </button>
        </div>
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
            <strong>No pipeline project yet</strong>
            <p>
              Click <strong>New project</strong> above to create one (the id is the KGS project_id),
              or pull an existing one with <code>od kg pull &lt;project-id&gt;</code> /{' '}
              <strong>Pull all</strong>. Then run its docs → UI pipelines here.
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
                    </div>
                    {meta.blurb ? <p className="pl-step__desc">{meta.blurb}</p> : null}
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
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Modals ── */}
      {newProjectOpen ? (
        <NewPipelineProjectModal onClose={() => setNewProjectOpen(false)} onCreate={createProject} />
      ) : null}
      {runInputFor ? (
        <RunInputModal
          pipelineName={runInputFor.name}
          placeholder={runInputFor.inputPlaceholder ?? ''}
          onClose={() => setRunInputFor(null)}
          onRun={async (input) => {
            await startRun(runInputFor.id, input);
            pushToast({ message: `Started “${runInputFor.name}” — running in background` });
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
