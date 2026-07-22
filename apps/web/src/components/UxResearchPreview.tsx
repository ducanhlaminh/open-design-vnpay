// UxResearchPreview — render a UX Research report (`ux-research/report.json`,
// output of the ux-research stage's skill) as a readable researcher's report:
// a domain/summary strip + evidence-based criteria cards (priority, statement,
// rationale, journey-stage chips, psychology principles, cited sources) with
// hotlinked Growth.Design illustration images, plus a closing reference list.
// Read-only, styled with open-design theme tokens. Images are REMOTE hotlinks
// (compliance: the knowledge base never redistributes image files) — broken /
// offline images collapse silently. Mirrors pipeline-studio's UX Research panel.
import { useMemo, useState } from 'react';

export interface UxResearchSource {
  source?: string;
  title?: string;
  url?: string;
}
export interface UxResearchImage {
  url?: string;
  caption?: string;
  credit?: string;
}
export interface UxResearchCriterion {
  id?: string;
  title?: string;
  statement?: string;
  rationale?: string;
  priority?: string; // must | should | nice
  topic?: string;
  applies_to?: string[];
  psychology?: string[];
  sources?: UxResearchSource[];
  images?: UxResearchImage[];
}
export interface UxResearchReference extends UxResearchSource {
  summary?: string;
  used_for?: string[];
}
export interface UxResearchReport {
  kind?: string;
  version?: number;
  domain?: string;
  knowledge_base?: string;
  summary?: { criteria?: number; must?: number; should?: number; nice?: number };
  criteria?: UxResearchCriterion[];
  references?: UxResearchReference[];
}

/** Shape sniff used by SpecFileViewer: the explicit `kind` marker, or (for a
 * report authored without it) a criteria[] array whose entries carry a
 * statement — distinct from both the ux-spec (screens[]) and the
 * heuristic-review (summary.verdict / findings) shapes. */
export function isUxResearchReport(v: unknown): v is UxResearchReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as UxResearchReport;
  if (r.kind === 'ux-research-report') return true;
  return (
    Array.isArray(r.criteria) &&
    r.criteria.length > 0 &&
    r.criteria.every((c) => c && typeof c === 'object') &&
    r.criteria.some((c) => typeof c.statement === 'string' && Array.isArray(c.sources))
  );
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #6b7280)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  accent: 'var(--accent, #0066b3)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
};

const PRIORITY_LABEL: Record<string, string> = { must: 'Bắt buộc', should: 'Nên có', nice: 'Điểm cộng' };
const priorityColor = (p?: string) => (p === 'must' ? T.red : p === 'should' ? T.amber : T.green);
const priorityOrder: Record<string, number> = { must: 0, should: 1, nice: 2 };

function PriorityChip({ p }: { p?: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 9px',
        borderRadius: 999,
        color: '#fff',
        background: priorityColor(p),
        flexShrink: 0,
      }}
    >
      {PRIORITY_LABEL[p ?? ''] ?? p ?? '—'}
    </span>
  );
}

function TagChip({ text }: { text: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${T.border}`,
        color: T.soft,
        background: T.subtle,
      }}
    >
      {text}
    </span>
  );
}

function SourceLink({ s }: { s: UxResearchSource }) {
  const label = [s.source, s.title].filter(Boolean).join(' — ') || s.url || 'nguồn';
  return s.url ? (
    <a
      href={s.url}
      target="_blank"
      rel="noreferrer noopener"
      style={{ fontSize: 12, color: T.accent, textDecoration: 'none' }}
    >
      {label} ↗
    </a>
  ) : (
    <span style={{ fontSize: 12, color: T.soft }}>{label}</span>
  );
}

// Hotlinked illustration image: caption + credit below; a load failure
// (offline, dead link) removes the figure entirely instead of a broken icon.
function Illustration({ img }: { img: UxResearchImage }) {
  const [failed, setFailed] = useState(false);
  if (!img.url || failed) return null;
  return (
    <figure style={{ margin: 0, maxWidth: 320 }}>
      <img
        src={img.url}
        alt={img.caption ?? ''}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{
          maxWidth: '100%',
          borderRadius: 8,
          border: `1px solid ${T.border}`,
          display: 'block',
        }}
      />
      <figcaption style={{ fontSize: 11.5, color: T.muted, marginTop: 4, lineHeight: 1.45 }}>
        {img.caption}
        {img.credit ? <span style={{ display: 'block', fontStyle: 'italic' }}>Ảnh: {img.credit}</span> : null}
      </figcaption>
    </figure>
  );
}

function CriterionCard({ c, defaultOpen }: { c: UxResearchCriterion; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const images = (c.images ?? []).filter((i) => i.url);
  const hasDetail = Boolean(
    c.rationale || c.applies_to?.length || c.psychology?.length || images.length || c.sources?.length,
  );
  return (
    <div style={{ border: `1px solid ${T.border}`, borderLeft: `3px solid ${priorityColor(c.priority)}`, borderRadius: 12, background: T.paper, overflow: 'hidden' }}>
      {/* Header row — always visible, click to expand the evidence/rationale. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 5, padding: '13px 15px', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }}
      >
        {/* Top line — arrow, priority chip, id and title all vertically centred. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <span style={{ flexShrink: 0, fontSize: 12, color: T.muted, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
          <PriorityChip p={c.priority} />
          {c.id ? <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: T.muted }}>{c.id}</span> : null}
          <strong style={{ flex: 1, minWidth: 0, fontSize: 15, color: T.ink, lineHeight: 1.4 }}>{c.title ?? '—'}</strong>
        </span>
        {/* Collapsed → statement preview (2 lines) so the row stays scannable. */}
        {!open && c.statement ? (
          <span
            style={{
              fontSize: 13,
              color: T.muted,
              lineHeight: 1.5,
              paddingLeft: 22,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {c.statement}
          </span>
        ) : null}
      </button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 15px 14px 40px' }}>
          {c.statement ? <p style={{ margin: 0, fontSize: 14, color: T.ink, lineHeight: 1.6 }}>{c.statement}</p> : null}
          {c.rationale ? (
            <p style={{ margin: 0, fontSize: 13.5, color: T.soft, lineHeight: 1.6 }}>
              <span style={{ fontWeight: 700 }}>Vì sao: </span>
              {c.rationale}
            </p>
          ) : null}
          {(c.applies_to?.length || c.psychology?.length) ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(c.applies_to ?? []).map((a) => (
                <TagChip key={`a-${a}`} text={a} />
              ))}
              {(c.psychology ?? []).map((p) => (
                <TagChip key={`p-${p}`} text={`🧠 ${p}`} />
              ))}
            </div>
          ) : null}
          {images.length ? (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {images.map((img, i) => (
                <Illustration key={img.url ?? i} img={img} />
              ))}
            </div>
          ) : null}
          {c.sources?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px dashed ${T.border}`, paddingTop: 8 }}>
              {c.sources.map((s, i) => (
                <SourceLink key={s.url ?? i} s={s} />
              ))}
            </div>
          ) : null}
          {!hasDetail && !c.statement ? (
            <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Không có chi tiết bổ sung.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Toggle chip for the priority filter strip. Off → dimmed outline.
function PriorityFilterChip({ active, color, label, count, onClick }: { active: boolean; color: string; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        fontWeight: 600,
        padding: '4px 11px',
        borderRadius: 999,
        cursor: 'pointer',
        border: `1px solid ${active ? color : T.border}`,
        background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
        color: active ? color : T.muted,
        opacity: active ? 1 : 0.65,
      }}
    >
      <i style={{ width: 8, height: 8, borderRadius: '50%', background: active ? color : T.muted }} />
      {label} {count}
    </button>
  );
}

export function UxResearchPreview({ report }: { report: UxResearchReport }) {
  type Prio = 'must' | 'should' | 'nice';
  const prioOf = (c: UxResearchCriterion): Prio =>
    c.priority === 'must' ? 'must' : c.priority === 'should' ? 'should' : 'nice';
  const allCriteria = useMemo(
    () =>
      [...(report.criteria ?? [])].sort(
        (a, b) => (priorityOrder[a.priority ?? 'nice'] ?? 2) - (priorityOrder[b.priority ?? 'nice'] ?? 2),
      ),
    [report.criteria],
  );
  const counts = {
    must: allCriteria.filter((c) => prioOf(c) === 'must').length,
    should: allCriteria.filter((c) => prioOf(c) === 'should').length,
    nice: allCriteria.filter((c) => prioOf(c) === 'nice').length,
  };
  // Priority filter — all on by default; min 1 active so the list never empties.
  const [prios, setPrios] = useState<Set<Prio>>(() => new Set<Prio>(['must', 'should', 'nice']));
  const togglePrio = (k: Prio) =>
    setPrios((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size === 1) return prev;
        next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });
  const criteria = useMemo(() => allCriteria.filter((c) => prios.has(prioOf(c))), [allCriteria, prios]);
  // Group by topic (keeps the priority sort inside each group; groups ordered
  // by their most important criterion).
  const groups = useMemo(() => {
    const map = new Map<string, UxResearchCriterion[]>();
    for (const c of criteria) {
      const key = c.topic || 'khác';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [criteria]);
  const [refsOpen, setRefsOpen] = useState(false);

  return (
    <div style={{ padding: '16px 20px 32px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, border: `1px solid ${T.border}`, borderRadius: 12, background: T.paper, padding: '16px 18px' }}>
        <strong style={{ fontSize: 17, color: T.ink }}>Báo cáo UX Research{report.domain ? ` · ${report.domain}` : ''}</strong>
        {/* Priority FILTER — click a chip to focus on that tier. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, color: T.muted }}>{allCriteria.length} tiêu chí · lọc:</span>
          <PriorityFilterChip active={prios.has('must')} color={T.red} label="Bắt buộc" count={counts.must} onClick={() => togglePrio('must')} />
          <PriorityFilterChip active={prios.has('should')} color={T.amber} label="Nên có" count={counts.should} onClick={() => togglePrio('should')} />
          <PriorityFilterChip active={prios.has('nice')} color={T.green} label="Điểm cộng" count={counts.nice} onClick={() => togglePrio('nice')} />
        </div>
        <span style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
          Tiêu chí bắt buộc mở sẵn; các tiêu chí khác thu gọn — bấm để xem lý do, nguồn, minh hoạ.
        </span>
      </div>
      {report.knowledge_base === 'unavailable' ? (
        <div style={{ fontSize: 13, color: T.amber, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px', background: T.subtle, lineHeight: 1.5 }}>
          Knowledge base không có trên máy chạy stage này — tiêu chí sinh từ kiến thức nền của agent,
          không có trích dẫn nguồn.
        </div>
      ) : null}
      {groups.map(([topic, list]) => (
        <section key={topic} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {topic}
          </h3>
          {list.map((c, i) => (
            <CriterionCard key={c.id ?? `${topic}-${i}`} c={c} defaultOpen={prioOf(c) === 'must'} />
          ))}
        </section>
      ))}
      {report.references?.length ? (
        <section style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
          <button
            type="button"
            onClick={() => setRefsOpen((o) => !o)}
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: T.accent }}
          >
            Tài liệu tham khảo ({report.references.length}) {refsOpen ? '▾' : '▸'}
          </button>
          {refsOpen ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {report.references.map((r, i) => (
                <li key={r.url ?? i} style={{ fontSize: 12.5, color: T.soft, lineHeight: 1.5 }}>
                  <SourceLink s={r} />
                  {r.summary ? <span style={{ display: 'block', color: T.muted }}>{r.summary}</span> : null}
                  {r.used_for?.length ? (
                    <span style={{ display: 'block', fontSize: 11.5, color: T.muted }}>Dùng cho: {r.used_for.join(', ')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
