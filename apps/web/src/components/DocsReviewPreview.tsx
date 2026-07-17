// DocsReviewPreview — the `docs-to-reviews` workflow's review-docs stage
// preview (`review/report.json`, output of the `docs-mockup-review` skill).
// Unlike ReviewPreview (read-only, judges a GENERATED wireframe) this renders
// the REAL mockup image from the source doc on the left and an EDITABLE
// findings list on the right, per Nielsen/Norman "left = artifact under
// review, right = judgement" layout. Edits persist back to `report.json` via
// the same upsert route FileViewer's Inspect panel uses; Export bundles the
// (possibly edited) report + every image it references into one .zip so a
// reviewer always gets the full picture, never a report with missing images.
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { projectRawUrl } from '../providers/registry';
import { triggerDownload } from '../runtime/exports';

export type FindingKind = 'mismatch' | 'heuristic';
export type Severity = 'blocker' | 'major' | 'minor';
export type Verdict = 'pass' | 'warn' | 'fail';

export interface MockupFinding {
  kind?: FindingKind;
  heuristic?: string;
  source?: 'nielsen' | 'norman';
  severity?: Severity;
  issue?: string;
  recommendation?: string;
}

export interface MockupReviewImage {
  id: string;
  path: string;
  page?: string;
  feature_text?: string;
  score?: number;
  verdict?: Verdict;
  findings?: MockupFinding[];
  passes?: string[];
}

export interface DocsMockupReviewReport {
  schema_version?: string;
  kind?: string;
  generated_from?: unknown;
  summary?: { images?: number; score?: number; verdict?: Verdict; blockers?: number; majors?: number; minors?: number };
  images?: MockupReviewImage[];
}

/** Shape sniff mirroring UxResearchPreview's `isUxResearchReport` — the
 *  explicit `kind` marker is authoritative; the `images[].findings` shape is
 *  a fallback for a report saved without it round-tripping cleanly. */
export function isDocsMockupReviewReport(v: unknown): v is DocsMockupReviewReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'docs-mockup-review') return true;
  return Array.isArray(r.images) && r.images.some((i) => i && typeof i === 'object' && 'path' in (i as object));
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #6b7280)',
  faint: 'var(--text-muted, #9aa4b2)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  accent: 'var(--accent, #0066b3)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
  radius: 'var(--radius, 8px)',
};
const asVerdict = (v: unknown): Verdict => (v === 'fail' || v === 'warn' ? v : 'pass');
const verdictColor = (v: Verdict) => (v === 'fail' ? T.red : v === 'warn' ? T.amber : T.green);
const verdictLabel = (v: Verdict) => (v === 'fail' ? 'Chưa đạt' : v === 'warn' ? 'Cảnh báo' : 'Đạt');
const sevColor = (s?: string) => (s === 'blocker' ? T.red : s === 'major' ? T.amber : T.muted);
const sevLabel = (s?: string) => (s === 'blocker' ? 'Blocker' : s === 'major' ? 'Major' : 'Minor');

/** Same arithmetic as the docs-mockup-review skill's step 3 — recomputed
 *  client-side so an edit's score impact shows immediately, no re-run needed. */
function scoreImage(findings: MockupFinding[]): { score: number; verdict: Verdict } {
  let deduction = 0;
  for (const f of findings) {
    if (f.severity === 'blocker') deduction += 25;
    else if (f.severity === 'major') deduction += 10;
    else if (f.severity === 'minor') deduction += 3;
  }
  const score = Math.max(0, 100 - deduction);
  const hasBlocker = findings.some((f) => f.severity === 'blocker');
  const verdict: Verdict = hasBlocker || score < 60 ? 'fail' : score < 85 ? 'warn' : 'pass';
  return { score, verdict };
}

function FindingRow({
  finding,
  onChange,
  onRemove,
}: {
  finding: MockupFinding;
  onChange: (next: MockupFinding) => void;
  onRemove: () => void;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12.5,
    color: T.ink,
    background: T.paper,
    fontFamily: 'inherit',
  };
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={finding.severity ?? 'minor'}
          onChange={(e) => onChange({ ...finding, severity: e.target.value as Severity })}
          style={{ ...inputStyle, width: 'auto', fontWeight: 700, color: sevColor(finding.severity) }}
        >
          <option value="blocker">Blocker</option>
          <option value="major">Major</option>
          <option value="minor">Minor</option>
        </select>
        <select
          value={finding.kind ?? 'mismatch'}
          onChange={(e) => onChange({ ...finding, kind: e.target.value as FindingKind })}
          style={{ ...inputStyle, width: 'auto' }}
        >
          <option value="mismatch">Lệch mockup ↔ text</option>
          <option value="heuristic">Heuristic UX</option>
        </select>
        {finding.kind === 'heuristic' ? (
          <input
            value={finding.heuristic ?? ''}
            onChange={(e) => onChange({ ...finding, heuristic: e.target.value })}
            placeholder="N.5"
            style={{ ...inputStyle, width: 64, fontFamily: 'ui-monospace, monospace' }}
          />
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          title="Xoá nhận xét"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', border: 0, background: 'transparent', color: T.faint, cursor: 'pointer', padding: 4 }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        value={finding.issue ?? ''}
        onChange={(e) => onChange({ ...finding, issue: e.target.value })}
        placeholder="Vấn đề…"
        rows={2}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      <textarea
        value={finding.recommendation ?? ''}
        onChange={(e) => onChange({ ...finding, recommendation: e.target.value })}
        placeholder="Khuyến nghị…"
        rows={2}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
    </div>
  );
}

function ImageCard({
  image,
  projectId,
  onChange,
}: {
  image: MockupReviewImage;
  projectId: string;
  onChange: (next: MockupReviewImage) => void;
}) {
  const [open, setOpen] = useState(true);
  const findings = image.findings ?? [];
  const { score, verdict } = useMemo(() => scoreImage(findings), [findings]);
  const counts = useMemo(() => {
    let blockers = 0, majors = 0, minors = 0;
    for (const f of findings) {
      if (f.severity === 'blocker') blockers += 1;
      else if (f.severity === 'major') majors += 1;
      else if (f.severity === 'minor') minors += 1;
    }
    return { blockers, majors, minors };
  }, [findings]);

  const setFindings = (next: MockupFinding[]) => onChange({ ...image, findings: next });
  const addFinding = () =>
    setFindings([...findings, { kind: 'mismatch', severity: 'minor', issue: '', recommendation: '' }]);
  const updateFinding = (i: number, next: MockupFinding) =>
    setFindings(findings.map((f, idx) => (idx === i ? next : f)));
  const removeFinding = (i: number) => setFindings(findings.filter((_, idx) => idx !== i));

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 11, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '11px 14px', background: T.paper, border: 0, cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{image.page ?? image.path}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {findings.length ? <span style={{ fontSize: 11.5, color: T.faint }}>{findings.length} vấn đề</span> : null}
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: T.ink }}>{score}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(verdict) }}>
            {verdictLabel(verdict)}
          </span>
        </span>
      </button>
      {open ? (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 360px) 1fr', gap: 16, alignItems: 'start' }}>
          {/* left — the REAL mockup image from the source doc */}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>Mockup</div>
            <img
              src={projectRawUrl(projectId, image.path)}
              alt={image.page ?? image.path}
              style={{ width: '100%', borderRadius: 9, border: `1px solid ${T.border}`, display: 'block' }}
            />
            {image.feature_text ? (
              <div style={{ borderRadius: 9, border: `1px dashed ${T.border}`, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, color: T.soft }}>
                <strong style={{ color: T.ink }}>Text trong tài liệu: </strong>
                {image.feature_text}
              </div>
            ) : null}
          </div>
          {/* right — editable findings */}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11.5 }}>
              <span style={{ fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>Đánh giá</span>
              <span style={{ color: T.red }}>● {counts.blockers} blocker</span>
              <span style={{ color: T.amber }}>● {counts.majors} major</span>
              <span style={{ color: T.muted }}>● {counts.minors} minor</span>
            </div>
            {findings.map((f, i) => (
              <FindingRow key={i} finding={f} onChange={(next) => updateFinding(i, next)} onRemove={() => removeFinding(i)} />
            ))}
            <button
              type="button"
              onClick={addFinding}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: `1px dashed ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, color: T.accent, background: 'transparent', cursor: 'pointer' }}
            >
              <Icon name="plus" size={13} />
              Thêm nhận xét
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DocsReviewPreview({
  projectId,
  fileName,
  report,
  onSaved,
}: {
  projectId: string;
  /** The report.json's project-relative path — the Save target and the
   *  first file bundled into Export. */
  fileName: string;
  report: DocsMockupReviewReport;
  /** Called after a successful Save so the caller can bump its reload key
   *  and re-derive the on-disk state from the freshly written file. */
  onSaved?: () => void;
}) {
  const [images, setImages] = useState<MockupReviewImage[]>(report.images ?? []);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh report from disk (re-run, or a reload after Save) replaces local
  // edits — but not while an in-flight edit session is dirty, so a Save that
  // races a background poll never clobbers what the user just typed.
  useEffect(() => {
    if (!dirty) setImages(report.images ?? []);
  }, [report, dirty]);

  const { verdict, score, counts } = useMemo(() => {
    let blockers = 0, majors = 0, minors = 0;
    const scores: number[] = [];
    let worst: Verdict = 'pass';
    for (const img of images) {
      const { score: s, verdict: v } = scoreImage(img.findings ?? []);
      scores.push(s);
      if (v === 'fail') worst = 'fail';
      else if (v === 'warn' && worst !== 'fail') worst = 'warn';
      for (const f of img.findings ?? []) {
        if (f.severity === 'blocker') blockers += 1;
        else if (f.severity === 'major') majors += 1;
        else if (f.severity === 'minor') minors += 1;
      }
    }
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
    return { verdict: worst, score: avg, counts: { blockers, majors, minors } };
  }, [images]);

  const updateImage = (id: string, next: MockupReviewImage) => {
    setDirty(true);
    setImages((prev) => prev.map((img) => (img.id === id ? next : img)));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const nextReport: DocsMockupReviewReport = {
        ...report,
        kind: 'docs-mockup-review',
        summary: { images: images.length, score, verdict, ...counts },
        images,
      };
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, content: JSON.stringify(nextReport, null, 2) }),
      });
      if (!resp.ok) {
        const payload = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Lưu thất bại (${resp.status})`);
      }
      setDirty(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  }

  async function exportZip() {
    setExporting(true);
    setError(null);
    try {
      // Always export the SAVED file list — if there are unsaved edits, save
      // first so the exported zip never silently ships a stale report.
      if (dirty) await save();
      const files = [fileName, ...images.map((img) => img.path)];
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/archive/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (!resp.ok) {
        const payload = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Xuất file thất bại (${resp.status})`);
      }
      const blob = await resp.blob();
      triggerDownload(blob, 'review.zip');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Xuất file thất bại');
    } finally {
      setExporting(false);
    }
  }

  if (!images.length) {
    return <div style={{ padding: 16, color: T.muted }}>Report review chưa có mockup nào để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
      {/* summary strip + actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 14 }}>
        {typeof score === 'number' ? (
          <div style={{ display: 'grid', width: 48, height: 48, flexShrink: 0, placeItems: 'center', borderRadius: 12, background: verdictColor(verdict), color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 17, fontWeight: 700 }}>{score}</div>
        ) : null}
        <div>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(verdict) }}>{verdictLabel(verdict)}</span>
          <div style={{ marginTop: 6, display: 'flex', gap: 14, fontSize: 12 }}>
            <span style={{ color: T.red }}>● {counts.blockers} blocker</span>
            <span style={{ color: T.amber }}>● {counts.majors} major</span>
            <span style={{ color: T.muted }}>● {counts.minors} minor</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {error ? <span style={{ fontSize: 12, color: T.red }}>{error}</span> : null}
          {dirty ? <span style={{ fontSize: 11.5, color: T.faint }}>Chưa lưu</span> : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: dirty ? T.accent : T.faint, background: T.paper, cursor: dirty ? 'pointer' : 'default' }}
          >
            <Icon name={saving ? 'spinner' : 'check'} size={13} />
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
          <button
            type="button"
            onClick={() => void exportZip()}
            disabled={exporting}
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#fff', background: T.accent, cursor: 'pointer' }}
          >
            <Icon name={exporting ? 'spinner' : 'download'} size={13} />
            {exporting ? 'Đang xuất…' : 'Xuất file review'}
          </button>
        </div>
      </div>

      {images.map((img) => (
        <ImageCard key={img.id} image={img} projectId={projectId} onChange={(next) => updateImage(img.id, next)} />
      ))}
    </div>
  );
}
