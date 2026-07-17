// The four Pipelines-surface modals, kept presentational: data/API logic lives
// in PipelinesView (the single owner of pipeline + project state). Each modal
// takes async submit callbacks and only owns its own busy/error UI.
//
// - RunInputModal:          collect a run input (e.g. Confluence link) before
//                            running a pipeline that declares inputPlaceholder (Req 4).
// - PipelineStatusModal:     poll GET /api/runs/:id and show compact status (Req 3).
// - PipelineResultModal:     preview a finished pipeline's output files inline
//                            (file rail + embedded FileViewer), no workspace nav.

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
  ProjectFile,
  ProjectSyncStatus,
  RemoteProject,
  TargetPlatform,
  Workflow,
} from '@open-design/contracts';
import type { TrackingProjectKind } from '@open-design/contracts/analytics';

import { Icon } from '../Icon';
import { FileViewer } from '../FileViewer';
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
  /** false → docs stage fetches ONLY the picked pages (no link-follow). */
  followLinks?: boolean;
}

/** Shared "fetch cả trang được link" toggle (docs stage, deterministic path). */
function FollowLinksToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="pl-runall-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
        disabled={disabled}
      />
      <span className="pl-runall-toggle__body">
        <span className="pl-runall-toggle__title">Fetch cả trang được link (depth 1)</span>
        <span className="pl-runall-toggle__desc">
          Trang spec thường dẫn chiếu tài liệu khác (BO spec, logic dùng chung…) — daemon fetch luôn
          các trang mà trang nguồn link tới (cùng wiki, tối đa 15 trang) và rewrite link chéo thành
          link file nội bộ. Bỏ tick nếu chỉ cần đúng các trang đã chọn.
        </span>
      </span>
    </label>
  );
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

// Mirror of the daemon's `splitWorkflowPath` (pipelines.ts): every pipeline
// writes under its workflow folder — `docs-to-ui/…` today, `docs-to-html/…` /
// `docs-to-react/…` on projects from before the 2026-07 merge — while the
// stage `outputs` patterns are workflow-RELATIVE. Strip the folder before
// matching; without this, folder patterns (`prototype/`, `docs/jira/`,
// `react/`, …) never match and Quick result reports "No output files yet"
// for stages that plainly succeeded. Legacy unprefixed paths pass through
// unchanged.
const WORKFLOW_DIR_RE = /^(docs-to-ui|docs-to-html|docs-to-react)\//;
function stripWorkflowDir(rel: string): string {
  return rel.replace(WORKFLOW_DIR_RE, '');
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

const confPageKey = (p: ConfluencePageRefLike) => p.id ?? p.url ?? '';

/** Picker trang Confluence DÙNG CHUNG (modal Run bước Docs + modal Chạy full
 * workflow): tìm trang theo tên qua GET /api/pipelines/confluence/pages (tick
 * chọn nhiều), hoặc dán link/page id (mỗi dòng một trang — tự thêm vào danh
 * sách khi rời ô nhập). Parent chỉ giữ danh sách `pages`; mọi state tìm kiếm
 * sống trong picker. */
export function ConfluencePagePicker({
  pages,
  onPagesChange,
}: {
  pages: ConfluencePageRefLike[];
  onPagesChange: (pages: ConfluencePageRefLike[]) => void;
}) {
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; title: string; url?: string; space?: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (manual) return;
    clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      setSearchErr(null);
      void (async () => {
        try {
          const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(query.trim())}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          setHits((j as { pages?: Array<{ id: string; title: string; url?: string; space?: string }> }).pages ?? []);
        } catch (err) {
          setSearchErr(err instanceof Error ? err.message : String(err));
          setHits([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [query, manual]);

  const togglePage = (p: { id: string; title: string; url?: string }) => {
    onPagesChange(
      pages.some((x) => x.id === p.id)
        ? pages.filter((x) => x.id !== p.id)
        : [...pages, { id: p.id, title: p.title, ...(p.url ? { url: p.url } : {}) }],
    );
  };
  // Dán tay: commit khi blur HOẶC bấm Thêm — không bắt user nhớ bấm nút để
  // khỏi mất text khi chuyển thẳng sang Run.
  const commitManual = (backToSearch: boolean) => {
    const refs = manualText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length) {
      const existing = new Set(pages.map(confPageKey));
      onPagesChange([
        ...pages,
        ...refs
          .filter((r) => !existing.has(r))
          .map((r) => (/^https?:\/\//i.test(r) ? { url: r } : { id: r })),
      ]);
      setManualText('');
    }
    if (backToSearch) setManual(false);
  };

  return (
    <div className={styles.panel}>
      {/* các trang đã chọn — gỡ từng trang */}
      {pages.length > 0 ? (
        <>
          <span className={styles.sectionLabel}>Đã chọn ({pages.length})</span>
          <div className={styles.list}>
            {pages.map((p) => (
              <button
                key={confPageKey(p)}
                type="button"
                className={`${styles.row} ${styles.rowSelected}`}
                onClick={() => onPagesChange(pages.filter((x) => confPageKey(x) !== confPageKey(p)))}
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

      {manual ? (
        <>
          <label className="pl-modal-field">
            <span className="pl-modal-field__label">Dán link / page id</span>
            <textarea
              className="pl-input"
              rows={3}
              autoFocus
              placeholder={'https://wiki…/pages/123456 hoặc page id\n(mỗi dòng một trang)'}
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              onBlur={() => commitManual(false)}
            />
          </label>
          <div className={styles.footerLinks}>
            <button
              type="button"
              className="pl-btn pl-btn--primary"
              onClick={() => commitManual(true)}
              disabled={!manualText.trim()}
            >
              <Icon name="plus" size={13} />
              <span>Thêm vào danh sách</span>
            </button>
            <button type="button" className={styles.linkBtn} onClick={() => setManual(false)}>
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
              placeholder="Gõ tên trang để tìm — tick chọn nhiều trang…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {searching ? (
            <p className={styles.empty}>Đang tìm…</p>
          ) : searchErr ? (
            <p className={styles.empty}>{searchErr}</p>
          ) : hits !== null ? (
            hits.length === 0 ? (
              <p className={styles.empty}>Không trang nào khớp “{query}”.</p>
            ) : (
              <div className={styles.list}>
                {hits.map((p) => {
                  const on = pages.some((x) => x.id === p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`${styles.row}${on ? ' ' + styles.rowSelected : ''}`}
                      onClick={() => togglePage(p)}
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
          <div className={styles.footerLinks}>
            <button type="button" className={styles.linkBtn} onClick={() => setManual(true)}>
              Dán link / page id thay vì tìm →
            </button>
          </div>
        </>
      )}
    </div>
  );
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
  // Nguồn BAS đang khóa bảo trì: luôn khởi tạo ở Confluence, kể cả khi config
  // dự án từ studio có sẵn basDocumentId (nó vẫn được giữ trong project.json —
  // mở khóa là dùng lại được).
  const [kind, setKind] = useState<SourceKind>('confluence');
  const [advanced, setAdvanced] = useState(false);

  // Confluence branch — dùng picker chung ConfluencePagePicker (tìm theo tên +
  // dán link, tick chọn nhiều). Seeded từ config dự án trên studio.
  const [confPages, setConfPages] = useState<ConfluencePageRefLike[]>(defaultConfluencePages ?? []);
  const [followLinks, setFollowLinks] = useState(true);

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
      ? confPages.length > 0
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
        // One page URL/id per line. When every line parses to a page id the
        // daemon runs the docs stage DETERMINISTICALLY (fetches the pages
        // itself via the BAS gateway — no agent); a short-link/opaque URL
        // falls back to the agent path.
        const refs = confPages.map((p) => p.url ?? p.id).filter((x): x is string => Boolean(x));
        payload = { input: refs.join('\n'), ...(followLinks ? {} : { followLinks: false }) };
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
            {/* Nguồn BAS ĐANG KHÓA BẢO TRÌ — card disabled, BE cũng chặn 503
                (BAS_SOURCE_LOCKED, pipeline-routes.ts). Mở lại: bỏ disabled +
                khôi phục onClick setKind('bas') + gỡ cờ BE/CLI. */}
            <button
              type="button"
              role="radio"
              aria-checked={false}
              aria-disabled="true"
              disabled
              className={styles.card}
              style={{ opacity: 0.55, cursor: 'not-allowed' }}
              title="Nguồn BAS đang bảo trì"
            >
              <span className={styles.cardTop}>
                <Icon name="folder" size={16} />
                BAS
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '1px 8px',
                    borderRadius: 999,
                    background: 'var(--warn-weak, #fff3e0)',
                    color: 'var(--warn, #b45309)',
                  }}
                >
                  Đang bảo trì
                </span>
              </span>
              <span className={styles.cardDesc}>Tạm khóa — dùng nguồn Confluence (hoặc JIRA key/JQL ở Advanced).</span>
            </button>
          </div>

          {kind === 'confluence' ? (
            <>
              <ConfluencePagePicker pages={confPages} onPagesChange={setConfPages} />
              <FollowLinksToggle checked={followLinks} onChange={setFollowLinks} disabled={busy} />
            </>
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
            {/* "Dán link thủ công" giờ nằm TRONG ConfluencePagePicker. */}
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

// ── Target-platform picker for the UX stage ─────────────────────────────────
// Shown before running a pipeline whose `acceptsPlatform` is set (the UX Spec
// stage — it decides every screen's `layout`). Mobile is the default and the
// legacy behavior; Website makes the skill author `layout: "web"` screens,
// which the UI-Spec terminals then render as full web pages.
export function PlatformRunModal({
  pipelineName,
  onClose,
  onRun,
}: {
  pipelineName: string;
  onClose: () => void;
  onRun: (platform: TargetPlatform) => Promise<void>;
}) {
  const [platform, setPlatform] = useState<TargetPlatform>('mobile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRun(platform);
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
            disabled={busy}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Run pipeline'}</span>
          </button>
        </>
      }
    >
      <div className={styles.cards} role="radiogroup" aria-label="Target platform">
        <button
          type="button"
          role="radio"
          aria-checked={platform === 'mobile'}
          className={`${styles.card}${platform === 'mobile' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setPlatform('mobile')}
        >
          <span className={styles.cardTop}>
            <Icon name="home" size={16} />
            Mobile app
            {platform === 'mobile' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Phone-first screens (bottom actions, single-column forms) — the default.
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={platform === 'web'}
          className={`${styles.card}${platform === 'web' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setPlatform('web')}
        >
          <span className={styles.cardTop}>
            <Icon name="grid" size={16} />
            Website
            {platform === 'web' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Full web pages (tables, sidebar/top navigation, multi-column forms).
          </span>
        </button>
      </div>
      <span className={styles.hint}>
        Sets every screen's <code>layout</code> in the UX Spec; the UI-Spec stages render
        each screen accordingly.
      </span>
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Run FULL workflow (no per-stage review) ─────────────────────────────────
// One dialog collects every choice the per-stage modals would ask (source for
// the docs stage, platform for UX, design system + terminal option for the
// UI-Spec step), then the daemon chains all stages automatically — each one
// starts as its predecessor succeeds, no user review in between. Progress
// shows on the normal stepper.
export type WorkflowTerminalChoice = 'ui-html' | 'ui-react' | 'both';

export interface RunAllPayload {
  input?: string;
  /** Structured picks behind `input` — sent alongside it purely so the daemon
   *  can persist a redisplay-able (titled) version into `savedRunAll`. */
  confluencePages?: ConfluencePageRefLike[];
  terminal: WorkflowTerminalChoice;
  platform: TargetPlatform;
  designSystemId: string | null;
  skipSucceeded: boolean;
  /** false → docs stage fetches ONLY the picked pages (no link-follow). */
  followLinks?: boolean;
}

export function RunAllModal({
  workflowName,
  defaultConfluencePages,
  defaultDesignSystemId,
  defaultTerminal,
  defaultPlatform,
  defaultFollowLinks,
  defaultSkipSucceeded,
  anySucceeded,
  onClose,
  onRun,
}: {
  workflowName: string;
  /** Nguồn điền sẵn — ưu tiên cấu hình Run-all ĐÃ LƯU từ lần chạy gần nhất
   *  trên máy này; chưa từng chạy lần nào thì fallback về cấu hình Pipeline
   *  Studio (project.json). Caller (PipelinesView) chọn cái nào truyền vào,
   *  modal chỉ biết "đây là giá trị khởi tạo". */
  defaultConfluencePages?: ConfluencePageRefLike[];
  defaultDesignSystemId?: string | null;
  defaultTerminal?: WorkflowTerminalChoice;
  defaultPlatform?: TargetPlatform;
  defaultFollowLinks?: boolean;
  defaultSkipSucceeded?: boolean;
  /** Có bước nào đã xong chưa — quyết định hiện checkbox "chỉ chạy bước còn thiếu". */
  anySucceeded: boolean;
  onClose: () => void;
  onRun: (payload: RunAllPayload) => Promise<void>;
}) {
  // Same shared Confluence picker as the per-stage Docs modal (search by name
  // + paste links, multi-select); prefill from the studio project config. The
  // run input is one page URL/id per line, built from the picked pages.
  const [confPages, setConfPages] = useState<ConfluencePageRefLike[]>(defaultConfluencePages ?? []);
  const [followLinks, setFollowLinks] = useState(defaultFollowLinks ?? true);
  const [terminal, setTerminal] = useState<WorkflowTerminalChoice>(defaultTerminal ?? 'ui-html');
  const [platform, setPlatform] = useState<TargetPlatform>(defaultPlatform ?? 'mobile');
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [designSystemId, setDesignSystemId] = useState<string | null>(
    defaultDesignSystemId === undefined ? null : defaultDesignSystemId,
  );
  const [skipSucceeded, setSkipSucceeded] = useState(defaultSkipSucceeded ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await fetchDesignSystems();
        if (!cancelled) setSystems(all.filter((s) => s.status !== 'draft'));
      } catch {
        if (!cancelled) setSystems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canRun = confPages.length > 0 || skipSucceeded;
  const submit = async () => {
    if (busy || !canRun) return;
    setBusy(true);
    setError(null);
    try {
      const input = confPages
        .map((p) => p.url ?? p.id)
        .filter((x): x is string => Boolean(x))
        .join('\n');
      await onRun({
        ...(input ? { input } : {}),
        ...(confPages.length ? { confluencePages: confPages } : {}),
        terminal,
        platform,
        designSystemId,
        skipSucceeded,
        ...(followLinks ? {} : { followLinks: false }),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const terminalCard = (value: WorkflowTerminalChoice, label: string, desc: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={terminal === value}
      className={`${styles.card}${terminal === value ? ' ' + styles.cardSelected : ''}`}
      onClick={() => setTerminal(value)}
    >
      <span className={styles.cardTop}>
        <Icon name={value === 'ui-react' ? 'blocks' : value === 'both' ? 'sparkles' : 'file-code'} size={16} />
        {label}
        {terminal === value ? (
          <span className={styles.cardCheck} aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        ) : null}
      </span>
      <span className={styles.cardDesc}>{desc}</span>
    </button>
  );

  return (
    <PlModal
      title={`Chạy full workflow · ${workflowName}`}
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
            title={canRun ? undefined : 'Chọn ít nhất một trang Confluence (hoặc tick "chỉ chạy bước còn thiếu" khi Docs đã xong)'}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Đang khởi động…' : 'Chạy tất cả các bước'}</span>
          </button>
        </>
      }
    >
      <p className={styles.hint} style={{ marginTop: 0 }}>
        Toàn bộ các bước chạy <strong>tự động nối tiếp</strong> — bước sau khởi động ngay khi bước
        trước xong, không cần duyệt output từng bước. Theo dõi tiến độ trên stepper; một bước lỗi
        sẽ dừng chuỗi tại đó.
      </p>
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Nguồn tài liệu (bước Docs)</span>
        {/* Cùng picker với nút Run của riêng bước Docs: tìm trang theo tên,
            tick chọn nhiều, hoặc dán link/page id. */}
        <ConfluencePagePicker pages={confPages} onPagesChange={setConfPages} />
        <FollowLinksToggle checked={followLinks} onChange={setFollowLinks} disabled={busy} />
        <span className="pl-modal-field__hint">
          Điền sẵn từ cấu hình dự án trên Pipeline Studio (nếu có). Link/id Confluence được daemon
          fetch trực tiếp (không cần agent); dán JIRA key/JQL như một dòng nếu muốn chạy qua agent.
          Nguồn BAS đang bảo trì.
        </span>
      </div>
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Nền tảng (bước UX Spec)</span>
        <div className={styles.cards} role="radiogroup" aria-label="Target platform">
          <button
            type="button"
            role="radio"
            aria-checked={platform === 'mobile'}
            className={`${styles.card}${platform === 'mobile' ? ' ' + styles.cardSelected : ''}`}
            onClick={() => setPlatform('mobile')}
          >
            <span className={styles.cardTop}>
              <Icon name="home" size={16} />
              Mobile app
              {platform === 'mobile' ? (
                <span className={styles.cardCheck} aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              ) : null}
            </span>
            <span className={styles.cardDesc}>Màn hình dọc kiểu điện thoại — mặc định.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={platform === 'web'}
            className={`${styles.card}${platform === 'web' ? ' ' + styles.cardSelected : ''}`}
            onClick={() => setPlatform('web')}
          >
            <span className={styles.cardTop}>
              <Icon name="grid" size={16} />
              Website
              {platform === 'web' ? (
                <span className={styles.cardCheck} aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              ) : null}
            </span>
            <span className={styles.cardDesc}>Trang web đầy đủ (bảng, sidebar, form nhiều cột).</span>
          </button>
        </div>
      </div>
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Kết quả UI-Spec (bước cuối)</span>
        <div className={styles.cards} role="radiogroup" aria-label="UI-Spec terminal">
          {terminalCard('ui-html', 'HTML prototype', 'Prototype HTML tương tác, mỗi màn một file.')}
          {terminalCard('ui-react', 'React app', 'App Vite + React 19 thật (cần Docker).')}
          {terminalCard('both', 'Cả hai', 'HTML trước, React sau.')}
        </div>
      </div>
      <div className="pl-modal-field pl-modal-field--ds">
        <span className="pl-modal-field__label">Design system (tùy chọn)</span>
        <ProjectDesignSystemPicker
          designSystems={systems ?? []}
          selectedId={designSystemId}
          loading={systems === null}
          onChange={setDesignSystemId}
          popoverZIndex={1100}
        />
      </div>
      {anySucceeded ? (
        // Checkbox hardening lives in .pl-runall-toggle (pipelines.css) — the
        // app's global input pill styles would otherwise stretch it full-width
        // and blow the modal out horizontally.
        <label className="pl-runall-toggle">
          <input
            type="checkbox"
            checked={skipSucceeded}
            onChange={(ev) => setSkipSucceeded(ev.target.checked)}
            disabled={busy}
          />
          <span className="pl-runall-toggle__body">
            <span className="pl-runall-toggle__title">Chỉ chạy các bước còn thiếu</span>
            <span className="pl-runall-toggle__desc">
              Giữ kết quả các bước đã xong. Bỏ tick = chạy lại từ đầu — output cũ được snapshot vào
              lịch sử trước khi xóa.
            </span>
          </span>
        </label>
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

// ── Re-run clear-scope picker ────────────────────────────────────────────────
// Shown when re-running a stage that already succeeded AND has downstream
// stages. A re-run always clears the stage's OWN outputs (so the agent
// regenerates instead of seeing leftovers and stopping); this modal only asks
// whether to ALSO clear the now-stale downstream stages.
export function RerunScopeModal({
  pipelineName,
  downstreamNames,
  onClose,
  onChoose,
}: {
  pipelineName: string;
  /** Human names of the stages that go stale if this one is regenerated. */
  downstreamNames: string[];
  onClose: () => void;
  onChoose: (scope: 'stage' | 'downstream') => Promise<void>;
}) {
  const [scope, setScope] = useState<'stage' | 'downstream'>('stage');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChoose(scope);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Chạy lại · ${pipelineName}`}
      icon="refresh"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void submit()}
            disabled={busy}
          >
            <Icon name={busy ? 'spinner' : 'refresh'} size={14} />
            <span>{busy ? 'Đang chạy…' : 'Chạy lại'}</span>
          </button>
        </>
      }
    >
      <div className={styles.cards} role="radiogroup" aria-label="Phạm vi chạy lại">
        <button
          type="button"
          role="radio"
          aria-checked={scope === 'stage'}
          className={`${styles.card}${scope === 'stage' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setScope('stage')}
        >
          <span className={styles.cardTop}>
            <Icon name="refresh" size={16} />
            Chỉ bước này
            {scope === 'stage' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Xóa &amp; tạo lại đúng bước này. Các bước sau giữ nguyên kết quả cũ (có thể đã lỗi thời).
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={scope === 'downstream'}
          className={`${styles.card}${scope === 'downstream' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setScope('downstream')}
        >
          <span className={styles.cardTop}>
            <Icon name="layers-filled" size={16} />
            Cả các bước sau
            {scope === 'downstream' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Xóa luôn kết quả của các bước phụ thuộc — chúng về trạng thái chưa chạy và phải chạy lại.
          </span>
        </button>
      </div>
      {scope === 'downstream' && downstreamNames.length ? (
        <span className={styles.hint}>
          Sẽ xóa kết quả: <strong>{downstreamNames.join(', ')}</strong>. Bản cũ vẫn khôi phục được từ Lịch sử.
        </span>
      ) : (
        <span className={styles.hint}>Bản cũ luôn được lưu vào Lịch sử trước khi xóa nên khôi phục được.</span>
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

// ── Req 3: Quick result — preview the pipeline's output files IN the modal ───
// Instead of navigating into the project workspace (conversation + folder tree)
// to see a stage's result, we render the same FileViewer the workspace uses,
// right here, with a left rail to switch between this stage's output files. A
// non-tech user never has to meet "workspace"/folders — they open a stage and
// see its screens immediately. "Open in workspace" stays as a power-user escape
// hatch (the old navigate-away behavior via onViewFile).
const isScreenFile = (name: string) =>
  name.endsWith('.screen.json') || /(^|\/)screen\.json$/.test(name);

// A non-tech "Quick result" only lists files FileViewer renders as a visual UI
// preview, and nothing else (markdown, manifests, build assets, source, the
// full-app dist/index.html bundle, and wireframes/*.wire.json + flows/*.flow.json
// siblings all stay hidden — someone who doesn't know what a "workspace" is has
// no use for them here). Per step:
//   • ui-html / ui-react (UI-Spec) → ONLY the React per-screen pages
//     (dist/screens/) and the HTML prototype (prototype/), plus the prototype
//     auto-demo recording (prototype-demo/*.webm). The dist/index.html full-app
//     bundle is dropped — the screens canvas already shows every screen.
//   • ux-spec / cj → the one primary spec JSON (SpecPreview loads its
//     wireframes/flows as tabs INSIDE it).
//   • ux-review / ux-research → the report JSON (ReviewPreview /
//     UxResearchPreview); the sibling report.md stays hidden.
//   • design-v3 screens → screen.json.
// If a step produces NO previewable file (docs) we fall back to listing
// everything so the modal is never empty.
function isUiPreviewFile(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  if (base === 'screen.json') return true;
  // UI-Spec previews: React per-screen pages + HTML prototype (not the
  // dist/index.html bundle, dev entry, or build assets).
  if (/\.html?$/.test(base)) {
    return /(^|\/)dist\/screens\//.test(lower) || /(^|\/)prototype\//.test(lower);
  }
  // Prototype auto-demo recording (Playwright walkthrough video).
  if (/(^|\/)prototype-demo\/.*\.webm$/.test(lower)) return true;
  // Primary visual spec docs (UX Spec / Customer Journey).
  if (/-ux-spec\.json$/.test(base) || /-(customer-journey|journey|cj)\.json$/.test(base)) return true;
  // Visual report previews — UX Heuristic Review + UX Research.
  return /(^|\/)(heuristic-review|ux-research)\/[^/]*\.json$/.test(lower);
}

export function PipelineResultModal({
  projectId,
  projectKind,
  pipeline,
  onClose,
  onViewFile,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  pipeline: PipelineView;
  onClose: () => void;
  onViewFile: (fileName: string) => void;
}) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const outputs = pipeline.outputs ?? [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
        if (!res.ok) throw new Error(`files: ${res.status}`);
        const data = (await res.json()) as { files?: ProjectFile[] };
        const all = (data.files ?? [])
          // Normalize name to a clean relative path but keep every ProjectFile
          // field (kind/mime/mtime/size) — FileViewer needs them to dispatch.
          .map((f) => ({ ...f, name: (f.name ?? f.path ?? '').replace(/^\/+/, '') }))
          .filter((f) => f.name && outputs.some((o) => outputMatches(stripWorkflowDir(f.name), o)));
        // Non-tech listing: UI-previewable files only, falling back to the full
        // set when a stage ships none (so doc/cj stages still show something).
        const ui = all.filter((f) => isUiPreviewFile(f.name));
        const shown = ui.length > 0 ? ui : all;
        if (!cancelled) {
          setFiles(shown);
          setActiveName(shown[0]?.name ?? null);
        }
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

  const active = files?.find((f) => f.name === activeName) ?? null;
  const hasFiles = Boolean(files && files.length > 0);

  return (
    <PlModal
      title={`Quick result · ${pipeline.name}`}
      icon="file-code"
      size="xl"
      bodyClassName={hasFiles ? 'pl-modal__body--flush' : undefined}
      onClose={onClose}
      footer={
        <>
          {active ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => {
                onViewFile(active.name);
                onClose();
              }}
              title="Mở file này trong workspace đầy đủ (hội thoại + cây thư mục)"
            >
              <Icon name="external-link" size={13} />
              <span>Mở trong workspace</span>
            </button>
          ) : null}
          <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>
            Close
          </button>
        </>
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
        <div className="pl-result-preview">
          <aside className="pl-result-rail" aria-label="Output files">
            {files.map((f) => {
              const isActive = f.name === activeName;
              return (
                <button
                  key={f.name}
                  type="button"
                  className={`pl-result-rail__item${isActive ? ' pl-result-rail__item--active' : ''}`}
                  onClick={() => setActiveName(f.name)}
                  aria-current={isActive}
                  title={f.name}
                >
                  <span className="pl-result-rail__icon" aria-hidden="true">
                    <Icon name={isScreenFile(f.name) ? 'image' : 'file'} size={14} />
                  </span>
                  <span className="pl-result-rail__name">{f.name}</span>
                </button>
              );
            })}
          </aside>
          <div className="pl-result-stage">
            {active ? (
              <FileViewer
                // Remount the viewer per file so each renderer resets cleanly.
                key={active.name}
                projectId={projectId}
                projectKind={projectKind}
                file={active}
              />
            ) : null}
          </div>
        </div>
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
  initialSelectedIds,
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
  /** Preselected project ids (the currently-selected project) — the common
   *  "update my project" case stays confirm-only. */
  initialSelectedIds?: readonly string[];
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds ?? []),
  );
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
  const matchesQuery = (r: RemoteProject) =>
    !q || r.name.toLowerCase().includes(q) || r.projectId.toLowerCase().includes(q);

  // Apps group features but have no KGS workspace of their own (mirrors
  // pipeline-studio's server/apps.ts) — never individually pullable, so they
  // never enter `filtered`/`selected`; they're only rendered as headers.
  const appsById = new Map((rows ?? []).filter((r) => r.isApp).map((r) => [r.projectId, r]));
  const features = (rows ?? []).filter((r) => !r.isApp);
  const filtered = features.filter(matchesQuery);
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.projectId));

  // Group visible features by parent app (pipeline-studio App → Feature
  // hierarchy); features with no appId, or whose app isn't in this list
  // (filtered by scope), stay in the "ungrouped" bucket.
  const grouped = new Map<string, RemoteProject[]>();
  const ungrouped: RemoteProject[] = [];
  for (const r of filtered) {
    const appId = r.appId && appsById.has(r.appId) ? r.appId : null;
    if (!appId) {
      ungrouped.push(r);
      continue;
    }
    const list = grouped.get(appId) ?? [];
    list.push(r);
    grouped.set(appId, list);
  }
  const appGroups = [...grouped.entries()]
    .map(([appId, items]) => ({ app: appsById.get(appId)!, items }))
    .sort((a, b) => a.app.name.localeCompare(b.app.name));

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
  const renderRow = (r: RemoteProject, nested: boolean) => {
    const isLocal = localIds.has(r.projectId);
    return (
      <li key={r.projectId}>
        <label className={`pl-pullall__row${nested ? ' pl-pullall__row--nested' : ''}`}>
          <input type="checkbox" checked={selected.has(r.projectId)} onChange={() => toggle(r.projectId)} />
          <span className="pl-pullall__avatar" aria-hidden="true">
            <Icon name="folder" size={15} />
          </span>
          <span className="pl-pullall__text">
            <span className="pl-pullall__name">{r.name}</span>
            {r.name !== r.projectId ? <span className="pl-pullall__id">{r.projectId}</span> : null}
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
            {selected.size > 0 ? `${selected.size} of ${features.length} selected` : ''}
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
      ) : features.length === 0 ? (
        <div className="pl-pullall__state">
          {scopeReason ?? 'Không có dự án nào bạn được tham gia trên store — nhờ quản lý add bạn vào dự án trên Pipeline Studio.'}
        </div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Choose which remote projects to mirror locally — graph and output files are pulled
            together.
          </p>
          {features.length > 8 ? (
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
                {selected.size}/{features.length}
              </span>
            </label>
            <ul className="pl-pullall__items">
              {/* App → Feature hierarchy (pipeline-studio's App concept): each
                  app is a non-checkable group header — it has no KGS
                  workspace of its own — with its features nested underneath. */}
              {appGroups.map(({ app, items }) => (
                <li key={app.projectId}>
                  <div className="pl-pullall__group">
                    <Icon name="folder-filled" size={13} />
                    <span>{app.name}</span>
                  </div>
                  <ul className="pl-pullall__items">{items.map((r) => renderRow(r, true))}</ul>
                </li>
              ))}
              {ungrouped.map((r) => renderRow(r, false))}
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
  initialSelectedIds,
  onClose,
  onConfirm,
}: {
  /** Local pipeline projects (the push-eligible set). */
  projects: Array<{ id: string; name: string }>;
  /** The workflow(s) in scope — only the active tab's workflow is passed. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  /** Preselected project ids (the currently-selected project). Absent → every
   *  project, the classic Push all. */
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (projectIds: string[], stages: string[]) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Preselect the caller's project when given (pushing YOUR project is the
  // common case — confirm-only); else every project, the classic Push all.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds?.length ? initialSelectedIds : projects.map((p) => p.id)),
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
