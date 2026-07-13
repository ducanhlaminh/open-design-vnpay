// ReviewPreview — render a UX heuristic-review report (`heuristic-review/report.json`,
// output of the ux-review stage's heuristic-eval skill) as a readable summary:
// an overall verdict/score strip + per-screen findings (severity, heuristic,
// issue, recommendation). Read-only, styled with open-design theme tokens.
// Mirrors pipeline-studio's ReviewPanel content.
import { useMemo, useState } from 'react';
import { WireFrameView, DEVICES, WEB_DEVICES, type WireDoc, type DeviceKey } from './WireFrameView';

type Verdict = 'pass' | 'warn' | 'fail';
type Severity = 'blocker' | 'major' | 'minor';

interface Finding {
  heuristic?: string;
  name?: string;
  severity?: Severity;
  status?: string;
  issue?: string;
  recommendation?: string;
  source?: string;
}
interface ReviewScreen {
  screen?: string;
  screen_name?: string;
  name?: string;
  score?: number;
  verdict?: Verdict;
  findings?: Finding[];
}
export interface ReviewReport {
  generated_from?: unknown;
  summary?: { screens?: number; score?: number; verdict?: Verdict };
  score?: number;
  verdict?: Verdict;
  screens?: ReviewScreen[];
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #6b7280)',
  faint: 'var(--text-muted, #9aa4b2)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
  radius: 'var(--radius, 8px)',
};
const asVerdict = (v: unknown): Verdict => (v === 'fail' || v === 'warn' ? v : 'pass');
const verdictColor = (v: Verdict) => (v === 'fail' ? T.red : v === 'warn' ? T.amber : T.green);
const verdictLabel = (v: Verdict) => (v === 'fail' ? 'Chưa đạt' : v === 'warn' ? 'Cảnh báo' : 'Đạt');
const sevOrder: Record<string, number> = { blocker: 0, major: 1, minor: 2 };
const sevColor = (s?: string) => (s === 'blocker' ? T.red : s === 'major' ? T.amber : T.muted);
const sevLabel = (s?: string) => (s === 'blocker' ? 'Blocker' : s === 'major' ? 'Major' : 'Minor');

function VerdictChip({ v }: { v: Verdict }) {
  return (
    <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(v) }}>
      {verdictLabel(v)}
    </span>
  );
}

function ScreenCard({ s, wire, base, platform }: { s: ReviewScreen; wire?: WireDoc | null; base?: WireDoc | null; platform?: string }) {
  const [open, setOpen] = useState(true);
  const verdict = asVerdict(s.verdict);
  // Web screens are wide → stack the wireframe above the findings (block). Mobile
  // screens are narrow → put them side-by-side (flex/grid).
  const isWeb = platform === 'web';
  const findings = (s.findings ?? [])
    .filter((f) => f.status !== 'pass' && (f.severity === 'blocker' || f.severity === 'major' || f.severity === 'minor'))
    .sort((a, b) => (sevOrder[a.severity ?? 'minor'] ?? 2) - (sevOrder[b.severity ?? 'minor'] ?? 2));
  const title = s.screen_name ?? s.name ?? s.screen ?? '—';
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 11, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '11px 14px', background: T.paper, border: 0, cursor: 'pointer', textAlign: 'left' }}
      >
        {s.screen ? (
          <span style={{ flexShrink: 0, borderRadius: 6, background: T.subtle, padding: '3px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, color: T.muted }}>{s.screen}</span>
        ) : null}
        <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {findings.length ? <span style={{ fontSize: 11.5, color: T.faint }}>{findings.length} vấn đề</span> : null}
          {typeof s.score === 'number' ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: T.ink }}>{s.score}</span> : null}
          <VerdictChip v={verdict} />
        </span>
      </button>
      {open ? (
        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            padding: 14,
            display: isWeb ? 'flex' : 'grid',
            ...(isWeb
              ? { flexDirection: 'column', gap: 16 }
              : { gridTemplateColumns: 'minmax(0, 360px) 1fr', gap: 16, alignItems: 'start' }),
          }}
        >
          {/* wireframe — the exact layout the review judged */}
          <div style={{ minWidth: 0 }}>
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>Wireframe</div>
            {wire ? (
              <WireFrameView doc={wire} platform={platform} base={base ?? undefined} />
            ) : (
              <p style={{ margin: 0, borderRadius: 9, border: `1px dashed ${T.border}`, padding: '18px 14px', textAlign: 'center', fontSize: 12, color: T.faint }}>
                Màn này chưa có wireframe.
              </p>
            )}
          </div>
          {/* findings */}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ marginBottom: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>
              Nhận xét {findings.length ? `(${findings.length})` : ''}
            </div>
            {findings.length ? (
              findings.map((f, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: sevColor(f.severity) }}>
                    <i style={{ width: 7, height: 7, borderRadius: '50%', background: sevColor(f.severity) }} />
                    {sevLabel(f.severity)}
                  </span>
                  {f.heuristic ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: T.muted }}>{f.heuristic}</span> : null}
                  {f.name ? <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink }}>{f.name}</span> : null}
                </div>
                {f.issue ? <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.5, color: T.soft }}>{f.issue}</p> : null}
                {f.recommendation ? (
                  <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>
                    <strong style={{ color: T.ink }}>Khuyến nghị: </strong>{f.recommendation}
                  </p>
                ) : null}
              </div>
            ))
            ) : (
              <p style={{ margin: 0, borderRadius: 9, border: `1px dashed ${T.border}`, padding: '18px 14px', textAlign: 'center', fontSize: 12.5, color: T.faint }}>
                Không có vi phạm — màn này đạt các heuristic được soi.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewPreview({
  report,
  wireframes,
  platforms,
}: {
  report: ReviewReport;
  /** Wireframe per screen id — the exact layout the review judged. */
  wireframes?: Record<string, WireDoc> | null;
  /** Per-screen platform (web|mobile) for the responsive layout. */
  platforms?: Record<string, string> | null;
}) {
  const screens = Array.isArray(report.screens) ? report.screens : [];
  const { verdict, score, counts } = useMemo(() => {
    let blockers = 0;
    let majors = 0;
    let minors = 0;
    for (const s of screens) {
      for (const f of s.findings ?? []) {
        if (f.status === 'pass') continue;
        if (f.severity === 'blocker') blockers += 1;
        else if (f.severity === 'major') majors += 1;
        else if (f.severity === 'minor') minors += 1;
      }
    }
    const v = asVerdict(report.summary?.verdict ?? report.verdict);
    const sc = report.summary?.score ?? report.score;
    return { verdict: v, score: sc, counts: { blockers, majors, minors } };
  }, [report, screens]);

  if (!screens.length) {
    return <div style={{ padding: 16, color: T.muted }}>Report review chưa có màn nào để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
      {/* summary strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 14 }}>
        {typeof score === 'number' ? (
          <div style={{ display: 'grid', width: 48, height: 48, flexShrink: 0, placeItems: 'center', borderRadius: 12, background: verdictColor(verdict), color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 17, fontWeight: 700 }}>{score}</div>
        ) : null}
        <div>
          <VerdictChip v={verdict} />
          <div style={{ marginTop: 6, display: 'flex', gap: 14, fontSize: 12 }}>
            <span style={{ color: T.red }}>● {counts.blockers} blocker</span>
            <span style={{ color: T.amber }}>● {counts.majors} major</span>
            <span style={{ color: T.muted }}>● {counts.minors} minor</span>
          </div>
        </div>
        <p style={{ marginLeft: 'auto', maxWidth: 360, fontSize: 12, lineHeight: 1.5, color: T.faint }}>
          Đánh giá heuristic (Nielsen + Norman) trên wireframe UX Spec, trước khi dựng UI.
        </p>
      </div>

      {screens.map((s, i) => {
        const wire = s.screen ? wireframes?.[s.screen] ?? null : null;
        const base = wire?.overlayOf ? wireframes?.[wire.overlayOf] ?? null : null;
        return (
          <ScreenCard
            key={s.screen ?? i}
            s={s}
            wire={wire}
            base={base}
            platform={s.screen ? platforms?.[s.screen] : undefined}
          />
        );
      })}
    </div>
  );
}
