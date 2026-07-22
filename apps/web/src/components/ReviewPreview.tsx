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

function ScreenCard({
  s,
  wire,
  base,
  platform,
  defaultOpen,
  severities,
}: {
  s: ReviewScreen;
  wire?: WireDoc | null;
  base?: WireDoc | null;
  platform?: string;
  /** Clean/minor-only screens start collapsed so the eye lands on real problems. */
  defaultOpen: boolean;
  /** Active severity filter — hide findings the user has toggled off. */
  severities: Set<Severity>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const verdict = asVerdict(s.verdict);
  // Web screens are wide → stack the wireframe above the findings (block). Mobile
  // screens are narrow → put them side-by-side (flex/grid).
  const isWeb = platform === 'web';
  const allFindings = (s.findings ?? [])
    .filter((f) => f.status !== 'pass' && (f.severity === 'blocker' || f.severity === 'major' || f.severity === 'minor'))
    .sort((a, b) => (sevOrder[a.severity ?? 'minor'] ?? 2) - (sevOrder[b.severity ?? 'minor'] ?? 2));
  const findings = allFindings.filter((f) => severities.has((f.severity ?? 'minor') as Severity));
  // Severity headline for the collapsed row: worst unfiltered severity present.
  const worst = allFindings[0]?.severity;
  const title = s.screen_name ?? s.name ?? s.screen ?? '—';
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden', background: T.paper }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 11, padding: '13px 16px', background: T.paper, border: 0, cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ flexShrink: 0, fontSize: 12, color: T.faint, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
        {s.screen ? (
          <span style={{ flexShrink: 0, borderRadius: 6, background: T.subtle, padding: '3px 9px', fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 700, color: T.muted }}>{s.screen}</span>
        ) : null}
        <span style={{ fontSize: 15, fontWeight: 650, color: T.ink }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {allFindings.length ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: sevColor(worst) }}>
              <i style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor(worst) }} />
              {allFindings.length} vấn đề
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: T.green, fontWeight: 600 }}>✓ Không lỗi</span>
          )}
          {typeof s.score === 'number' ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14, fontWeight: 700, color: T.ink }}>{s.score}</span> : null}
          <VerdictChip v={verdict} />
        </span>
      </button>
      {open ? (
        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            padding: 16,
            display: isWeb ? 'flex' : 'grid',
            ...(isWeb
              ? { flexDirection: 'column', gap: 18 }
              : { gridTemplateColumns: 'minmax(0, 360px) 1fr', gap: 18, alignItems: 'start' }),
          }}
        >
          {/* wireframe — the exact layout the review judged */}
          <div style={{ minWidth: 0 }}>
            <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>Wireframe</div>
            {wire ? (
              <WireFrameView doc={wire} platform={platform} base={base ?? undefined} />
            ) : (
              <p style={{ margin: 0, borderRadius: 9, border: `1px dashed ${T.border}`, padding: '18px 14px', textAlign: 'center', fontSize: 13, color: T.faint }}>
                Màn này chưa có wireframe.
              </p>
            )}
          </div>
          {/* findings */}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ marginBottom: 0, fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.faint }}>
              Nhận xét {findings.length ? `(${findings.length})` : ''}
            </div>
            {findings.length ? (
              findings.map((f, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderLeft: `3px solid ${sevColor(f.severity)}`, borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: sevColor(f.severity) }}>
                    <i style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor(f.severity) }} />
                    {sevLabel(f.severity)}
                  </span>
                  {f.heuristic ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.muted }}>{f.heuristic}</span> : null}
                  {f.name ? <span style={{ fontSize: 14, fontWeight: 650, color: T.ink }}>{f.name}</span> : null}
                </div>
                {f.issue ? <p style={{ margin: '7px 0 0', fontSize: 14, lineHeight: 1.6, color: T.soft }}>{f.issue}</p> : null}
                {f.recommendation ? (
                  <p style={{ margin: '7px 0 0', fontSize: 14, lineHeight: 1.6, color: T.muted }}>
                    <strong style={{ color: T.ink }}>Khuyến nghị: </strong>{f.recommendation}
                  </p>
                ) : null}
              </div>
            ))
            ) : (
              <p style={{ margin: 0, borderRadius: 9, border: `1px dashed ${T.border}`, padding: '18px 14px', textAlign: 'center', fontSize: 13.5, color: T.faint }}>
                {allFindings.length ? 'Không có mục nào khớp bộ lọc mức độ.' : 'Không có vi phạm — màn này đạt các heuristic được soi.'}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Toggle chip for the severity filter strip. Off → dimmed outline.
function SevFilterChip({ active, color, label, count, onClick }: { active: boolean; color: string; label: string; count: number; onClick: () => void }) {
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
        color: active ? color : T.faint,
        opacity: active ? 1 : 0.7,
      }}
    >
      <i style={{ width: 8, height: 8, borderRadius: '50%', background: active ? color : T.faint }} />
      {label} {count}
    </button>
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

  // Severity filter — all on by default; toggling narrows the findings shown.
  // Kept at min 1 active so the list never goes silently empty.
  const [severities, setSeverities] = useState<Set<Severity>>(
    () => new Set<Severity>(['blocker', 'major', 'minor']),
  );
  const toggleSeverity = (k: Severity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size === 1) return prev; // keep at least one on
        next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });

  if (!screens.length) {
    return <div style={{ padding: 16, color: T.muted }}>Report review chưa có màn nào để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18, maxWidth: 1080, margin: '0 auto' }}>
      {/* summary strip — score + verdict + severity FILTER (click to focus) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '16px 18px', background: T.paper }}>
        {typeof score === 'number' ? (
          <div style={{ display: 'grid', width: 54, height: 54, flexShrink: 0, placeItems: 'center', borderRadius: 14, background: verdictColor(verdict), color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 19, fontWeight: 700 }}>{score}</div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <VerdictChip v={verdict} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SevFilterChip active={severities.has('blocker')} color={T.red} label="Blocker" count={counts.blockers} onClick={() => toggleSeverity('blocker')} />
            <SevFilterChip active={severities.has('major')} color={T.amber} label="Major" count={counts.majors} onClick={() => toggleSeverity('major')} />
            <SevFilterChip active={severities.has('minor')} color={T.muted} label="Minor" count={counts.minors} onClick={() => toggleSeverity('minor')} />
          </div>
        </div>
        <p style={{ marginLeft: 'auto', maxWidth: 320, fontSize: 12.5, lineHeight: 1.55, color: T.faint }}>
          Đánh giá heuristic (Nielsen + Norman) trên wireframe UX Spec, trước khi dựng UI. Màn có
          blocker/major mở sẵn; màn sạch thu gọn.
        </p>
      </div>

      {screens.map((s, i) => {
        const wire = s.screen ? wireframes?.[s.screen] ?? null : null;
        const base = wire?.overlayOf ? wireframes?.[wire.overlayOf] ?? null : null;
        // Open by default only when the screen has a blocker or major — clean and
        // minor-only screens stay collapsed so the reader lands on real problems.
        const defaultOpen = (s.findings ?? []).some(
          (f) => f.status !== 'pass' && (f.severity === 'blocker' || f.severity === 'major'),
        );
        return (
          <ScreenCard
            key={s.screen ?? i}
            s={s}
            wire={wire}
            base={base}
            platform={s.screen ? platforms?.[s.screen] : undefined}
            defaultOpen={defaultOpen}
            severities={severities}
          />
        );
      })}
    </div>
  );
}
