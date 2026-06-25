// The four Pipelines-surface modals, kept presentational: data/API logic lives
// in PipelinesView (the single owner of pipeline + project state). Each modal
// takes async submit callbacks and only owns its own busy/error UI.
//
// - NewPipelineProjectModal: create a KGS pipeline project (Req 2).
// - RunInputModal:          collect a run input (e.g. Confluence link) before
//                            running a pipeline that declares inputPlaceholder (Req 4).
// - PipelineStatusModal:     poll GET /api/runs/:id and show compact status (Req 3).
// - PipelineResultModal:     list a finished pipeline's output files (Req 3).

import { useEffect, useState } from 'react';
import type {
  BasDocument,
  BasDocumentsResponse,
  BasFeature,
  BasFeaturesResponse,
  ChatRunStatusResponse,
  PipelineRunSource,
  PipelineView,
} from '@open-design/contracts';

import { Icon } from '../Icon';
import { PlModal } from './PlModal';
import styles from './PipelineSourceModal.module.css';

/** What the run-source modal hands back: either a structured BAS/Confluence
 * source (pre-fetched by the daemon) or a legacy free-text input (JIRA/JQL). */
export interface RunSourcePayload {
  source?: PipelineRunSource;
  input?: string;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
};

// Mirror of the daemon's apps/daemon/src/pipelines.ts `outputMatches`. Kept in
// sync by hand (the patterns are stable); used to attribute a project file to a
// pipeline stage from its declared `outputs` globs.
function outputMatches(rel: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*') || pattern.startsWith('-')) {
    return rel.endsWith(pattern.startsWith('*') ? pattern.slice(1) : pattern);
  }
  return rel === pattern || rel.endsWith('/' + pattern);
}

// ── Req 2: New pipeline project ──────────────────────────────────────────────
export function NewPipelineProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (id: string) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = id.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title="New pipeline project"
      icon="pipeline"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            onClick={() => void submit()}
            disabled={busy || !id.trim()}
          >
            <Icon name={busy ? 'spinner' : 'plus'} size={14} />
            <span>{busy ? 'Creating…' : 'Create project'}</span>
          </button>
        </>
      }
    >
      <label className="pl-modal-field">
        <span className="pl-modal-field__label">Project id</span>
        <input
          type="text"
          className="pl-input"
          autoFocus
          placeholder="e.g. XPOS"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <span className="pl-modal-field__hint">
          The id you type <strong>is</strong> the KGS project_id. Allowed: A–Z a–z 0–9 . _ -
        </span>
      </label>
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Req 4: Run source (Confluence link or BAS document) ──────────────────────
// Pipeline 1 (jira-ingest) ingests its source docs from the BAS MCP gateway. The
// user picks ONE of two cards:
//   • Confluence — paste a page URL/id; a preview panel shows the page metadata
//     fetched via the daemon's BAS proxy.
//   • BAS — pick a BAS workspace, then check the feature(s)/document(s) to ingest.
// The daemon pre-fetches the choice into the project cwd before the run. A small
// "Advanced" toggle keeps the legacy free-text JIRA key / JQL path.
type SourceKind = 'confluence' | 'bas';

export function RunInputModal({
  pipelineName,
  placeholder,
  onClose,
  onRun,
}: {
  pipelineName: string;
  placeholder: string;
  onClose: () => void;
  onRun: (payload: RunSourcePayload) => Promise<void>;
}) {
  const [kind, setKind] = useState<SourceKind>('confluence');
  const [advanced, setAdvanced] = useState(false);

  // Confluence branch — just paste the link/id; no preview/verify step.
  const [confRef, setConfRef] = useState('');

  // BAS branch (KG document → feature)
  const [basDocuments, setBasDocuments] = useState<BasDocument[] | null>(null);
  const [basDocLoading, setBasDocLoading] = useState(false);
  const [basDocumentId, setBasDocumentId] = useState('');
  const [basFeatures, setBasFeatures] = useState<BasFeature[] | null>(null);
  const [basFeatLoading, setBasFeatLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Advanced (legacy JQL / JIRA key) branch
  const [jql, setJql] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load BAS documents the first time the BAS card is shown.
  useEffect(() => {
    if (advanced || kind !== 'bas' || basDocuments !== null || basDocLoading) return;
    setBasDocLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch('/api/pipelines/bas/documents');
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `BAS documents: ${res.status}`);
        setBasDocuments((j as BasDocumentsResponse).documents ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBasDocuments([]);
      } finally {
        setBasDocLoading(false);
      }
    })();
  }, [advanced, kind, basDocuments, basDocLoading]);

  const loadFeatures = async (docId: string) => {
    setBasDocumentId(docId);
    setSelected(new Set());
    setBasFeatures(null);
    setBasFeatLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/bas/documents/${encodeURIComponent(docId)}/features`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `BAS features: ${res.status}`);
      setBasFeatures((j as BasFeaturesResponse).features ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBasFeatures([]);
    } finally {
      setBasFeatLoading(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canRun = advanced
    ? true // JQL is optional — the skill prompts if empty
    : kind === 'confluence'
      ? confRef.trim().length > 0
      : basDocumentId.length > 0; // features optional → whole document

  const submit = async () => {
    if (busy || !canRun) return;
    setBusy(true);
    setError(null);
    try {
      let payload: RunSourcePayload;
      if (advanced) {
        payload = { input: jql.trim() };
      } else if (kind === 'confluence') {
        // Confluence is fetched by the AGENT via the Atlassian MCP, not pre-fetched
        // by the BE — so hand the link over as the run input.
        payload = { input: confRef.trim() };
      } else {
        const featureIds = [...selected];
        payload = {
          source: {
            kind: 'bas',
            documentId: basDocumentId,
            ...(featureIds.length ? { featureIds } : {}),
          },
        };
      }
      await onRun(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Run · ${pipelineName}`}
      icon="play"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void submit()}
            disabled={busy || !canRun}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Run pipeline'}</span>
          </button>
        </>
      }
    >
      {advanced ? (
        <>
          <label className="pl-modal-field">
            <span className="pl-modal-field__label">JIRA key / JQL</span>
            <input
              type="text"
              className="pl-input"
              autoFocus
              placeholder={placeholder}
              value={jql}
              onChange={(e) => setJql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <span className="pl-modal-field__hint">
              Paste a JIRA project key or JQL. Leave empty to let the skill ask. Pulled via the
              <code> mcp-atlassian</code> server (not BAS).
            </span>
          </label>
          <button type="button" className={styles.advancedToggle} onClick={() => setAdvanced(false)}>
            ← Back to Confluence / BAS sources
          </button>
        </>
      ) : (
        <>
          <div className={styles.cards} role="radiogroup" aria-label="Document source">
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'confluence'}
              className={`${styles.card}${kind === 'confluence' ? ' ' + styles.cardSelected : ''}`}
              onClick={() => setKind('confluence')}
            >
              <span className={styles.cardTop}>
                <Icon name="import" size={16} />
                Confluence
                {kind === 'confluence' ? (
                  <span className={styles.cardCheck} aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </span>
              <span className={styles.cardDesc}>Paste a Confluence page link — preview its metadata, then ingest.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'bas'}
              className={`${styles.card}${kind === 'bas' ? ' ' + styles.cardSelected : ''}`}
              onClick={() => setKind('bas')}
            >
              <span className={styles.cardTop}>
                <Icon name="folder" size={16} />
                BAS
                {kind === 'bas' ? (
                  <span className={styles.cardCheck} aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </span>
              <span className={styles.cardDesc}>Pick a BAS document, then choose the feature(s) to ingest.</span>
            </button>
          </div>

          {kind === 'confluence' ? (
            <div className={styles.panel}>
              <label className="pl-modal-field">
                <span className="pl-modal-field__label">Confluence page</span>
                <input
                  type="text"
                  className="pl-input"
                  autoFocus
                  placeholder="https://wiki…/pages/123456 or page id"
                  value={confRef}
                  onChange={(e) => setConfRef(e.target.value)}
                />
              </label>
              <span className={styles.hint}>Paste the Confluence page link or id, then Run.</span>
            </div>
          ) : (
            <div className={styles.panel}>
              <span className={styles.sectionLabel}>BAS document</span>
              {basDocLoading ? (
                <p className={styles.empty}>Loading BAS documents…</p>
              ) : !basDocuments || basDocuments.length === 0 ? (
                <p className={styles.empty}>No BAS documents returned (check BAS configuration).</p>
              ) : (
                <div className={styles.list}>
                  {basDocuments.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`${styles.row}${d.id === basDocumentId ? ' ' + styles.rowSelected : ''}`}
                      onClick={() => void loadFeatures(d.id)}
                    >
                      <span className={`${styles.checkbox}${d.id === basDocumentId ? ' ' + styles.checkboxOn : ''}`}>
                        {d.id === basDocumentId ? <Icon name="check" size={12} /> : null}
                      </span>
                      <span className={styles.rowBody}>
                        <span className={styles.rowName}>{d.label || d.id}</span>
                        {d.nodeCount !== undefined ? (
                          <span className={styles.rowSummary}>{d.nodeCount} nodes</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {basDocumentId ? (
                <>
                  <span className={styles.sectionLabel}>Features (leave empty to ingest the whole document)</span>
                  {basFeatLoading ? (
                    <p className={styles.empty}>Loading…</p>
                  ) : !basFeatures || basFeatures.length === 0 ? (
                    <p className={styles.empty}>No features found — running will ingest the whole document.</p>
                  ) : (
                    <div className={styles.list}>
                      {basFeatures.map((f) => {
                        const on = selected.has(f.id);
                        return (
                          <button
                            key={f.id}
                            type="button"
                            className={`${styles.row}${on ? ' ' + styles.rowSelected : ''}`}
                            onClick={() => toggle(f.id)}
                            aria-pressed={on}
                          >
                            <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
                              {on ? <Icon name="check" size={12} /> : null}
                            </span>
                            <span className={styles.rowBody}>
                              <span className={styles.rowName}>{f.name}</span>
                              {f.summary ? <span className={styles.rowSummary}>{f.summary}</span> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          <button type="button" className={styles.advancedToggle} onClick={() => setAdvanced(true)}>
            Advanced: JIRA key / JQL (via mcp-atlassian) →
          </button>
        </>
      )}

      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Req 3: Compact run-status modal ──────────────────────────────────────────
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

export function PipelineStatusModal({
  pipeline,
  onClose,
  onOpenChat,
  onRefresh,
}: {
  pipeline: PipelineView;
  onClose: () => void;
  onOpenChat: (() => void) | null;
  onRefresh: () => void;
}) {
  const runId = pipeline.lastRunId ?? null;
  const [run, setRun] = useState<ChatRunStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as ChatRunStatusResponse;
        if (cancelled) return;
        setRun(data);
        setNow(Date.now());
        const terminal = ['succeeded', 'failed', 'canceled'].includes(data.status);
        if (terminal) {
          onRefresh();
        } else {
          timer = window.setTimeout(poll, 1500);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId, onRefresh]);

  const status = run?.status ?? pipeline.status;
  const isRunning = status === 'queued' || status === 'running';
  const elapsed = run ? formatElapsed((run.updatedAt || now) - run.createdAt) : null;

  const cancel = async () => {
    if (!runId || canceling) return;
    setCanceling(true);
    try {
      await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    } catch {
      /* ignore — poll reflects the result */
    } finally {
      setCanceling(false);
    }
  };

  return (
    <PlModal
      title={`Status · ${pipeline.name}`}
      icon="pipeline"
      onClose={onClose}
      footer={
        <>
          {onOpenChat ? (
            <button type="button" className="pl-btn" onClick={onOpenChat}>
              <Icon name="comment" size={14} />
              <span>Open chat</span>
            </button>
          ) : null}
          {isRunning && runId ? (
            <button
              type="button"
              className="pl-btn pl-btn--danger"
              onClick={() => void cancel()}
              disabled={canceling}
            >
              <Icon name={canceling ? 'spinner' : 'stop'} size={14} />
              <span>{canceling ? 'Canceling…' : 'Cancel run'}</span>
            </button>
          ) : null}
          <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {!runId ? (
        <p className="pl-modal-empty">No run for this pipeline yet.</p>
      ) : (
        <div className="pl-status-detail">
          <div className={`pl-status-detail__badge pl-status--${status}`}>
            {isRunning ? <Icon name="spinner" size={14} /> : null}
            <span>{RUN_STATUS_LABEL[status] ?? status}</span>
          </div>
          <dl className="pl-status-detail__meta">
            {elapsed ? (
              <div>
                <dt>Elapsed</dt>
                <dd>{elapsed}</dd>
              </div>
            ) : null}
            <div>
              <dt>Run id</dt>
              <dd className="pl-mono">{runId}</dd>
            </div>
          </dl>
          {run?.error ? (
            <pre className="pl-status-detail__error">{run.error}</pre>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              <Icon name="info" size={14} />
              <span>{error}</span>
            </div>
          ) : null}
          {isRunning ? (
            <p className="pl-status-detail__hint">
              Running in the background — you can close this and keep working.
            </p>
          ) : null}
        </div>
      )}
    </PlModal>
  );
}

// ── Req 3: Quick result — the pipeline's output files ────────────────────────
interface ProjectFile {
  name: string;
  path: string;
}

export function PipelineResultModal({
  projectId,
  pipeline,
  onClose,
  onViewFile,
}: {
  projectId: string;
  pipeline: PipelineView;
  onClose: () => void;
  onViewFile: (fileName: string) => void;
}) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outputs = pipeline.outputs ?? [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
        if (!res.ok) throw new Error(`files: ${res.status}`);
        const data = (await res.json()) as { files?: Array<{ name?: string; path?: string }> };
        const all = (data.files ?? [])
          .map((f) => {
            const rel = (f.name ?? f.path ?? '').replace(/^\/+/, '');
            return { name: rel, path: f.path ?? rel };
          })
          .filter((f) => f.name && outputs.some((o) => outputMatches(f.name, o)));
        if (!cancelled) setFiles(all);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // outputs derives from pipeline; pipeline.id is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pipeline.id]);

  const isScreen = (name: string) => name.endsWith('.screen.json') || /(^|\/)screen\.json$/.test(name);

  return (
    <PlModal
      title={`Quick result · ${pipeline.name}`}
      icon="file-code"
      size="md"
      onClose={onClose}
      footer={
        <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>
          Close
        </button>
      }
    >
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : files === null ? (
        <p className="pl-modal-empty">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="pl-modal-empty">
          No output files yet for this stage. Run it (or <strong>Pull all</strong> from KGS) to
          produce its {outputs.join(', ') || 'outputs'}.
        </p>
      ) : (
        <ul className="pl-result-list">
          {files.map((f) => (
            <li key={f.name} className="pl-result-row">
              <span className="pl-result-row__icon" aria-hidden="true">
                <Icon name={isScreen(f.name) ? 'image' : 'file'} size={15} />
              </span>
              <span className="pl-result-row__name" title={f.name}>
                {f.name}
              </span>
              <button
                type="button"
                className="pl-btn pl-btn--run"
                onClick={() => {
                  onViewFile(f.name);
                  onClose();
                }}
              >
                <Icon name={isScreen(f.name) ? 'eye' : 'external-link'} size={13} />
                <span>{isScreen(f.name) ? 'Preview' : 'View'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PlModal>
  );
}
