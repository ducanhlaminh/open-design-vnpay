// The four Pipelines-surface modals, kept presentational: data/API logic lives
// in PipelinesView (the single owner of pipeline + project state). Each modal
// takes async submit callbacks and only owns its own busy/error UI.
//
// - RunInputModal:          collect a run input (e.g. Confluence link) before
//                            running a pipeline that declares inputPlaceholder (Req 4).
// - PipelineStatusModal:     poll GET /api/runs/:id and show compact status (Req 3).
// - PipelineResultModal:     list a finished pipeline's output files (Req 3).

import { useEffect, useRef, useState } from 'react';
import type {
  BasDocument,
  BasDocumentsResponse,
  BasFeature,
  BasFeaturesResponse,
  ChatRunStatusResponse,
  DesignSystemSummary,
  PipelineRunSource,
  PipelineView,
  ProjectSyncStatus,
  RemoteProject,
  Workflow,
} from '@open-design/contracts';

import { Icon } from '../Icon';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';
import { PlModal } from './PlModal';
import styles from './PipelineSourceModal.module.css';
import sp from './StagePicker.module.css';

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

// ── Req 4: Run source (Confluence link or BAS document) ──────────────────────
// Pipeline 1 (jira-ingest) ingests its source docs from the BAS MCP gateway. The
// user picks ONE of two cards:
//   • Confluence — paste a page URL/id; a preview panel shows the page metadata
//     fetched via the daemon's BAS proxy.
//   • BAS — pick a BAS workspace, then check the feature(s)/document(s) to ingest.
// The daemon pre-fetches the choice into the project cwd before the run. A small
// "Advanced" toggle keeps the legacy free-text JIRA key / JQL path.
type SourceKind = 'confluence' | 'bas';

export interface ConfluencePageRefLike {
  id?: string;
  title?: string;
  url?: string;
}

export function RunInputModal({
  pipelineName,
  placeholder,
  defaultConfluencePages,
  defaultBasDocumentId,
  onClose,
  onRun,
}: {
  pipelineName: string;
  placeholder: string;
  /** Nguồn cấu hình sẵn từ Pipeline Studio (project.json) — tick sẵn các
   *  trang, user vẫn thêm/bớt được cho từng lần chạy. Có basDocumentId → mở
   *  sẵn nhánh BAS với tài liệu đó được chọn. */
  defaultConfluencePages?: ConfluencePageRefLike[];
  defaultBasDocumentId?: string;
  onClose: () => void;
  onRun: (payload: RunSourcePayload) => Promise<void>;
}) {
  const [kind, setKind] = useState<SourceKind>(defaultBasDocumentId ? 'bas' : 'confluence');
  const [advanced, setAdvanced] = useState(false);

  // Confluence branch — picker "tìm trang theo tên, tick chọn nhiều" như bên
  // pipeline-studio (GET /api/pipelines/confluence/pages), kèm chế độ dán
  // link tay. Seeded từ config dự án trên studio.
  const [confPages, setConfPages] = useState<ConfluencePageRefLike[]>(defaultConfluencePages ?? []);
  const [confManual, setConfManual] = useState(false);
  const [confRef, setConfRef] = useState('');
  const [confQuery, setConfQuery] = useState('');
  const [confHits, setConfHits] = useState<Array<{ id: string; title: string; url?: string; space?: string }> | null>(null);
  const [confSearching, setConfSearching] = useState(false);
  const [confSearchErr, setConfSearchErr] = useState<string | null>(null);
  const confDebounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (advanced || kind !== 'confluence' || confManual) return;
    clearTimeout(confDebounce.current);
    if (confQuery.trim().length < 2) {
      setConfHits(null);
      return;
    }
    confDebounce.current = setTimeout(() => {
      setConfSearching(true);
      setConfSearchErr(null);
      void (async () => {
        try {
          const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(confQuery.trim())}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          setConfHits((j as { pages?: Array<{ id: string; title: string; url?: string; space?: string }> }).pages ?? []);
        } catch (err) {
          setConfSearchErr(err instanceof Error ? err.message : String(err));
          setConfHits([]);
        } finally {
          setConfSearching(false);
        }
      })();
    }, 350);
    return () => clearTimeout(confDebounce.current);
  }, [confQuery, kind, advanced, confManual]);

  const confKey = (p: ConfluencePageRefLike) => p.id ?? p.url ?? '';
  const toggleConfPage = (p: { id: string; title: string; url?: string }) => {
    setConfPages((prev) =>
      prev.some((x) => x.id === p.id)
        ? prev.filter((x) => x.id !== p.id)
        : [...prev, { id: p.id, title: p.title, ...(p.url ? { url: p.url } : {}) }],
    );
  };
  const addManualConfLinks = () => {
    const refs = confRef
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!refs.length) return;
    setConfPages((prev) => {
      const existing = new Set(prev.map(confKey));
      return [...prev, ...refs.filter((r) => !existing.has(r)).map((r) => (/^https?:\/\//i.test(r) ? { url: r } : { id: r }))];
    });
    setConfRef('');
    setConfManual(false);
  };

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

  // Preselect the studio-configured BAS document once the document list is in:
  // pick it + load its features, exactly as if the user clicked it.
  useEffect(() => {
    if (kind !== 'bas' || !defaultBasDocumentId || basDocuments === null) return;
    if (basDocumentId || basFeatures !== null || basFeatLoading) return;
    if (!basDocuments.some((d) => d.id === defaultBasDocumentId)) return;
    void loadFeatures(defaultBasDocumentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, defaultBasDocumentId, basDocuments, basDocumentId, basFeatures, basFeatLoading]);

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
      ? confManual
        ? confRef.trim().length > 0
        : confPages.length > 0
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
        // by the BE — hand the picked pages over as the run input, one per line.
        const refs = confManual
          ? [confRef.trim()]
          : confPages.map((p) => p.url ?? p.id).filter((x): x is string => Boolean(x));
        payload = { input: refs.join('\n') };
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
          <div className={styles.footerLinks}>
            <button type="button" className={styles.linkBtn} onClick={() => setAdvanced(false)}>
              ← Quay lại chọn nguồn Confluence / BAS
            </button>
          </div>
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
              {/* các trang đã chọn — gỡ từng trang */}
              {confPages.length > 0 ? (
                <>
                  <span className={styles.sectionLabel}>Đã chọn ({confPages.length})</span>
                  <div className={styles.list}>
                    {confPages.map((p) => (
                      <button
                        key={confKey(p)}
                        type="button"
                        className={`${styles.row} ${styles.rowSelected}`}
                        onClick={() => setConfPages((prev) => prev.filter((x) => confKey(x) !== confKey(p)))}
                        title="Bấm để bỏ trang này"
                      >
                        <span className={`${styles.checkbox} ${styles.checkboxOn}`}>
                          <Icon name="close" size={11} />
                        </span>
                        <span className={styles.rowBody}>
                          <span className={styles.rowName}>{p.title ?? p.url ?? p.id}</span>
                          {p.id ? <span className={styles.rowSummary}>{p.id}</span> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              {confManual ? (
                <>
                  <label className="pl-modal-field">
                    <span className="pl-modal-field__label">Dán link / page id</span>
                    <textarea
                      className="pl-input"
                      rows={3}
                      autoFocus
                      placeholder={'https://wiki…/pages/123456 hoặc page id\n(mỗi dòng một trang)'}
                      value={confRef}
                      onChange={(e) => setConfRef(e.target.value)}
                    />
                  </label>
                  <div className={styles.footerLinks}>
                    <button type="button" className="pl-btn pl-btn--primary" onClick={addManualConfLinks} disabled={!confRef.trim()}>
                      <Icon name="plus" size={13} />
                      <span>Thêm vào danh sách</span>
                    </button>
                    <button type="button" className={styles.linkBtn} onClick={() => setConfManual(false)}>
                      ← Quay lại tìm theo tên
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="pl-modal-field">
                    <span className="pl-modal-field__label">Tìm trang Confluence</span>
                    <input
                      type="text"
                      className="pl-input"
                      autoFocus
                      placeholder="Gõ tên trang để tìm — tick chọn nhiều trang…"
                      value={confQuery}
                      onChange={(e) => setConfQuery(e.target.value)}
                    />
                  </label>
                  {confSearching ? (
                    <p className={styles.empty}>Đang tìm…</p>
                  ) : confSearchErr ? (
                    <p className={styles.empty}>{confSearchErr}</p>
                  ) : confHits !== null ? (
                    confHits.length === 0 ? (
                      <p className={styles.empty}>Không trang nào khớp “{confQuery}”.</p>
                    ) : (
                      <div className={styles.list}>
                        {confHits.map((p) => {
                          const on = confPages.some((x) => x.id === p.id);
                          return (
                            <button
                              key={p.id}
                              type="button"
                              className={`${styles.row}${on ? ' ' + styles.rowSelected : ''}`}
                              onClick={() => toggleConfPage(p)}
                              aria-pressed={on}
                            >
                              <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
                                {on ? <Icon name="check" size={12} /> : null}
                              </span>
                              <span className={styles.rowBody}>
                                <span className={styles.rowName}>{p.title}</span>
                                <span className={styles.rowSummary}>
                                  {p.space ? `${p.space} · ` : ''}
                                  {p.id}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )
                  ) : null}
                </>
              )}
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

          {/* Lối tắt phụ, gom một hàng ghost-chip — không tranh chú ý với picker. */}
          <div className={styles.footerLinks}>
            {kind === 'confluence' && !confManual ? (
              <button type="button" className={styles.linkBtn} onClick={() => setConfManual(true)}>
                <Icon name="edit" size={12} />
                <span>Dán link thủ công</span>
              </button>
            ) : null}
            <button type="button" className={styles.linkBtn} onClick={() => setAdvanced(true)}>
              <Icon name="settings" size={12} />
              <span>Advanced: JIRA key / JQL</span>
            </button>
          </div>
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

// ── Design-system picker for UI stages (ui-html) ─────────────────────────────
// Shown before running a pipeline whose `acceptsDesignSystem` is set. Picks an
// optional brand to apply at HTML-gen time: "None" → a generic, design-led
// prototype (the pre-existing behavior); a system → its DESIGN.md + tokens get
// injected into the agent's system prompt for this run. Only NON-draft systems
// are offered, because the daemon won't inject a draft's assets (see
// isProjectUsableDesignSystem) — so a draft created from a .fig must be
// published first to appear here.
export function DesignSystemRunModal({
  pipelineName,
  defaultId,
  onClose,
  onRun,
}: {
  pipelineName: string;
  /** Design system cấu hình sẵn từ Pipeline Studio (project.json) — chọn sẵn
   *  trong danh sách, user vẫn đổi được cho từng lần chạy. */
  defaultId?: string;
  onClose: () => void;
  onRun: (designSystemId: string | null) => Promise<void>;
}) {
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(defaultId ?? null); // null = None
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await fetchDesignSystems();
        if (cancelled) return;
        setSystems(all.filter((s) => s.status !== 'draft'));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSystems([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRun(selected);
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
            disabled={busy || systems === null}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Run pipeline'}</span>
          </button>
        </>
      }
    >
      <div className="pl-modal-field pl-modal-field--ds">
        <span className="pl-modal-field__label">Design system (optional)</span>
        {/* Same swatch + live-theme-preview picker as the chat composer. It
            portals its popover to <body>; popoverZIndex lifts it above the
            modal backdrop (z 1000) so it isn't hidden behind the overlay. The
            --ds modifier restyles its compact header pill into a full-width
            form control (see pipelines.css). */}
        <ProjectDesignSystemPicker
          designSystems={systems ?? []}
          selectedId={selected}
          loading={systems === null}
          onChange={setSelected}
          popoverZIndex={1100}
        />
        <span className="pl-modal-field__hint">
          Applies a brand's <code>DESIGN.md</code> + tokens to the generated HTML. Leave as{' '}
          <strong>None</strong> for a generic, design-led prototype. Only published systems
          appear — publish a draft (e.g. one created from a <code>.fig</code>) to use it here.
        </span>
      </div>
      {systems !== null && systems.length === 0 ? (
        <p className="pl-modal-empty">No published design systems yet — running with None.</p>
      ) : null}
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

// ── StagePicker — pipeline chips shared by the Pull all / Push all modals.
// All checked (the default) = legacy whole-project file sync; narrowing only
// affects OUTPUT FILES — the KG graph always moves whole-project. Zero checked
// disables the modal's confirm (an empty list would read as "no filter"
// server-side). Each chip carries a local↔store badge fed by
// POST /api/kg/sync-status: "≠ remote" (something a push/pull would move) or
// "đồng bộ" — aggregated over the projects currently selected in the modal.
export function allStageIds(workflows: Workflow[]): Set<string> {
  return new Set(workflows.flatMap((w) => w.pipelineIds));
}

interface StageDiff {
  differs: boolean;
  changed: number;
  localOnly: number;
  remoteOnly: number;
  local: number;
  remote: number;
}

/** One fetch per modal open — the per-project results are aggregated
 *  client-side as the project selection changes (no refetch). */
function useSyncStatus(): ProjectSyncStatus[] | null {
  const [data, setData] = useState<ProjectSyncStatus[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/kg/sync-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const j = await res.json().catch(() => ({}));
        if (!cancelled) setData(res.ok ? ((j?.data?.results ?? []) as ProjectSyncStatus[]) : []);
      } catch {
        if (!cancelled) setData([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** Sum the per-project stage diffs over `scope` (empty scope = every local
 *  project — remote-only projects simply have no data to contribute). */
function aggregateDiff(
  results: ProjectSyncStatus[] | null,
  scope: ReadonlySet<string>,
): Map<string, StageDiff> | undefined {
  if (!results) return undefined;
  const map = new Map<string, StageDiff>();
  for (const r of results) {
    if (scope.size > 0 && !scope.has(r.projectId)) continue;
    for (const s of r.stages) {
      const cur =
        map.get(s.stage) ?? { differs: false, changed: 0, localOnly: 0, remoteOnly: 0, local: 0, remote: 0 };
      map.set(s.stage, {
        differs: cur.differs || s.differs,
        changed: cur.changed + s.changed,
        localOnly: cur.localOnly + s.localOnly,
        remoteOnly: cur.remoteOnly + s.remoteOnly,
        local: cur.local + s.local,
        remote: cur.remote + s.remote,
      });
    }
  }
  return map;
}

function StagePicker({
  workflows,
  selected,
  onChange,
  diffByStage,
  diffLoading = false,
}: {
  workflows: Workflow[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Aggregated local↔store diff per stage; absent key → no badge. */
  diffByStage?: ReadonlyMap<string, StageDiff>;
  diffLoading?: boolean;
}) {
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <section className={sp.section} aria-label="Pipelines">
      <div className={sp.head}>
        <span className={sp.title}>Pipelines</span>
        <span className={sp.hint}>
          {diffLoading ? 'đang so với store…' : 'bỏ tích bước nào thì output bước đó không đồng bộ'}
        </span>
        <span className={sp.count}>
          {selected.size}/{allStageIds(workflows).size}
        </span>
      </div>
      {workflows.map((w) => (
        <div key={w.id} className={sp.wf}>
          <div className={sp.wfname}>{w.name}</div>
          <div className={sp.chips}>
            {w.pipelineIds.map((pid) => {
              const d = diffByStage?.get(pid);
              const parts = d
                ? [
                    d.changed > 0 ? `${d.changed} file thay đổi` : '',
                    d.localOnly > 0 ? `${d.localOnly} file chỉ có local` : '',
                    d.remoteOnly > 0 ? `${d.remoteOnly} file chỉ có trên store` : '',
                  ].filter(Boolean)
                : [];
              const title = d
                ? d.differs
                  ? `Khác store: ${parts.join(', ')}`
                  : `Đồng bộ với store (local ${d.local} / store ${d.remote} file)`
                : 'Chưa có dữ liệu so sánh với store';
              return (
                <button
                  key={pid}
                  type="button"
                  className={sp.chip}
                  aria-pressed={selected.has(pid)}
                  onClick={() => toggle(pid)}
                  title={title}
                >
                  <span className={sp.tick} aria-hidden="true">
                    ✓
                  </span>
                  <span className={sp.id}>{pid}</span>
                  {d ? (
                    d.differs ? (
                      <span className={`${sp.badge} ${sp.badgeDiff}`}>≠ remote</span>
                    ) : d.local + d.remote > 0 ? (
                      <span className={`${sp.badge} ${sp.badgeSync}`}>đồng bộ</span>
                    ) : null
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── PullAllModal — pick WHICH remote projects to pull (Req: "Pull all" was
// all-or-nothing; with many remote projects that floods the local mirror)
// and WHICH pipelines' output files come down with them. Lists
// GET /api/kg/remote-projects with checkboxes; Confirm hands the chosen ids
// (+ stages when narrowed) to PipelinesView → POST /api/kg/pull-all.

export function PullAllModal({
  localIds,
  workflows,
  scopeName,
  onClose,
  onConfirm,
}: {
  /** Project ids already mirrored locally (badge + preselect-none hint). */
  localIds: ReadonlySet<string>;
  /** The workflow(s) in scope — PipelinesView passes ONLY the active tab's
   *  workflow, so Pull all is per-workflow and never drags the other
   *  workflow's outputs along. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (projectIds: string[], stages: string[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<RemoteProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Membership scope note from the daemon (e.g. "chưa đăng nhập") — shown as
  // the empty state so the user knows WHY the list is empty.
  const [scopeReason, setScopeReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(() => allStageIds(workflows));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  // Local↔store diff for the stage chips' badges (only locally-mirrored
  // projects have a local side to compare; remote-only ones contribute none).
  const syncStatus = useSyncStatus();
  const diffByStage = aggregateDiff(syncStatus, selected);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/kg/remote-projects');
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error?.message || j?.error || `remote list failed: ${res.status}`);
        if (!cancelled) {
          setRows((j?.data ?? []) as RemoteProject[]);
          setScopeReason(typeof j?.reason === 'string' ? j.reason : null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.projectId.toLowerCase().includes(q),
  );
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.projectId));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAllVisible = () => {
    const next = new Set(selected);
    if (allVisibleSelected) for (const r of filtered) next.delete(r.projectId);
    else for (const r of filtered) next.add(r.projectId);
    setSelected(next);
  };

  const submit = async () => {
    if (selected.size === 0 || stageSel.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Always send the explicit stage list: the picker is scoped to the
      // active workflow, so even "all checked" must not sync the OTHER
      // workflow's outputs.
      await onConfirm([...selected], [...stageSel]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Pull projects from KGS${scopeName ? ` — ${scopeName}` : ''}`}
      icon="download"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selected.size > 0 ? `${selected.size} of ${rows?.length ?? 0} selected` : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            onClick={() => void submit()}
            disabled={busy || selected.size === 0 || stageSel.size === 0}
          >
            <Icon name={busy ? 'spinner' : 'download'} size={14} />
            <span>
              {busy
                ? 'Pulling…'
                : selected.size === 0
                  ? 'Pull'
                  : `Pull ${selected.size} project${selected.size > 1 ? 's' : ''}`}
            </span>
          </button>
        </>
      }
    >
      {loadError ? (
        <div className="pl-modal-error" role="alert">
          {loadError}
        </div>
      ) : rows === null ? (
        <div className="pl-pullall__state">
          <Icon name="spinner" size={16} />
          <span>Loading remote projects…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="pl-pullall__state">
          {scopeReason ?? 'Không có dự án nào bạn được tham gia trên store — nhờ quản lý add bạn vào dự án trên Pipeline Studio.'}
        </div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Choose which remote projects to mirror locally — graph and output files are pulled
            together.
          </p>
          {rows.length > 8 ? (
            <input
              type="search"
              className="pl-pullall__search"
              placeholder="Search by name or id…"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
            />
          ) : null}
          <div className="pl-pullall__list" role="group" aria-label="Remote projects">
            <label className="pl-pullall__head">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              <span className="pl-pullall__headlabel">
                Select all{q ? ' matches' : ''}
              </span>
              <span className="pl-pullall__headcount">
                {selected.size}/{rows.length}
              </span>
            </label>
            <ul className="pl-pullall__items">
              {filtered.map((r) => {
                const isLocal = localIds.has(r.projectId);
                return (
                  <li key={r.projectId}>
                    <label className="pl-pullall__row">
                      <input
                        type="checkbox"
                        checked={selected.has(r.projectId)}
                        onChange={() => toggle(r.projectId)}
                      />
                      <span className="pl-pullall__avatar" aria-hidden="true">
                        <Icon name="folder" size={15} />
                      </span>
                      <span className="pl-pullall__text">
                        <span className="pl-pullall__name">{r.name}</span>
                        {r.name !== r.projectId ? (
                          <span className="pl-pullall__id">{r.projectId}</span>
                        ) : null}
                      </span>
                      <span className="pl-pullall__meta">
                        {isLocal ? <span className="pl-pullall__badge">local</span> : null}
                        <span className="pl-pullall__files">
                          {r.files > 0 ? `${r.files} files` : r.inKgs ? 'graph only' : '—'}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
              {filtered.length === 0 ? (
                <li className="pl-pullall__state">No project matches “{search}”.</li>
              ) : null}
            </ul>
          </div>
          <StagePicker
            workflows={workflows}
            selected={stageSel}
            onChange={setStageSel}
            diffByStage={diffByStage}
            diffLoading={syncStatus === null}
          />
          {stageSel.size === 0 ? (
            <div className="pl-modal-error" role="alert">
              Chọn ít nhất một pipeline để pull.
            </div>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </PlModal>
  );
}

// ── PushAllModal — pick WHICH local projects to push back to KGS and WHICH
// pipelines' output files go with them (the graph push stays whole-project).
// Mirrors PullAllModal but lists the LOCAL mirror (no fetch needed); Confirm
// hands ids (+ stages when narrowed) to PipelinesView → POST /api/kg/push-all.
export function PushAllModal({
  projects,
  workflows,
  scopeName,
  onClose,
  onConfirm,
}: {
  /** Local pipeline projects (the push-eligible set). */
  projects: Array<{ id: string; name: string }>;
  /** The workflow(s) in scope — only the active tab's workflow is passed. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (projectIds: string[], stages: string[]) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Preselect every project — the classic Push all pushed everything; the
  // modal exists to let the user narrow, not to make the common case slower.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(projects.map((p) => p.id)),
  );
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(() => allStageIds(workflows));
  const [busy, setBusy] = useState(false);
  const syncStatus = useSyncStatus();
  const diffByStage = aggregateDiff(syncStatus, selected);

  const allSelected = projects.length > 0 && projects.every((p) => selected.has(p.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id)));
  };

  const submit = async () => {
    if (selected.size === 0 || stageSel.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Explicit stage list always — see PullAllModal.submit.
      await onConfirm([...selected], [...stageSel]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Push projects to KGS${scopeName ? ` — ${scopeName}` : ''}`}
      icon="upload"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selected.size > 0 ? `${selected.size} of ${projects.length} selected` : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            onClick={() => void submit()}
            disabled={busy || selected.size === 0 || stageSel.size === 0}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={14} />
            <span>
              {busy
                ? 'Pushing…'
                : selected.size === 0
                  ? 'Push'
                  : `Push ${selected.size} project${selected.size > 1 ? 's' : ''}`}
            </span>
          </button>
        </>
      }
    >
      {projects.length === 0 ? (
        <div className="pl-pullall__state">Chưa có project local nào để push.</div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Chọn project và pipeline muốn đẩy lên store — graph luôn push cả project, phần
            pipeline chỉ lọc file output.
          </p>
          <div className="pl-pullall__list" role="group" aria-label="Local projects">
            <label className="pl-pullall__head">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span className="pl-pullall__headlabel">Select all</span>
              <span className="pl-pullall__headcount">
                {selected.size}/{projects.length}
              </span>
            </label>
            <ul className="pl-pullall__items">
              {projects.map((p) => (
                <li key={p.id}>
                  <label className="pl-pullall__row">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="pl-pullall__avatar" aria-hidden="true">
                      <Icon name="folder" size={15} />
                    </span>
                    <span className="pl-pullall__text">
                      <span className="pl-pullall__name">{p.name}</span>
                      {p.name !== p.id ? <span className="pl-pullall__id">{p.id}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <StagePicker
            workflows={workflows}
            selected={stageSel}
            onChange={setStageSel}
            diffByStage={diffByStage}
            diffLoading={syncStatus === null}
          />
          {stageSel.size === 0 ? (
            <div className="pl-modal-error" role="alert">
              Chọn ít nhất một pipeline để push.
            </div>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </PlModal>
  );
}
