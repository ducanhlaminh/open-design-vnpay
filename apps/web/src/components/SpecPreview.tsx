// SpecPreview — render a Customer Journey / UX Spec JSON (customer-journey-spec /
// ux-spec skill output) as a visual spec, mirroring SimStudio's
// /customer-journey and /ux-spec routes — but reading the file DIRECTLY (no KGS
// push / Pull All needed). Layout, sidebar grouping, emotion curve (SVG line),
// stage cards and screen wireframe follow those routes; styled with open-design
// theme tokens.
import { useMemo, useState } from 'react';
import { WireloomViewer, type WireElement } from './WireloomViewer';

interface SpecComponent {
  id?: string;
  component_type?: string;
  label?: string;
  order?: number;
  region?: string;
  required?: boolean;
  data_type?: string;
  semantic_type?: string;
  prominence?: string;
}
interface SpecScreen {
  id: string;
  name?: string;
  title?: string;
  screen_type?: string;
  screen_intent?: string;
  primary_actor?: string;
  actor_id?: string;
  layout?: string;
  components?: SpecComponent[];
}
type PainPoint = string | { text?: string; description?: string; severity?: string };
// Key source-text excerpt for a stage — verbatim snippet from the docs MD that
// justifies the stage (authored by customer-journey-spec). Surfaced per-stage.
interface SpecSource {
  file?: string;
  heading?: string;
  quote?: string;
}
interface SpecStage {
  id: string;
  name?: string;
  order?: number;
  stage_type?: string;
  goal?: string;
  emotion?: string;
  emotion_score?: number;
  user_actions?: string[];
  system_responses?: string[];
  touchpoints?: string[];
  pain_points?: PainPoint[];
  thoughts?: string[];
  sources?: SpecSource[];
}
interface SpecJourney {
  id: string;
  name?: string;
  title?: string;
  actor_id?: string;
  goal?: string;
  journey_mode?: string;
  flow_type?: string;
  stages?: SpecStage[];
}
interface SpecPersona {
  id?: string;
  name: string;
  [k: string]: unknown;
}
export interface SpecDoc {
  screens?: SpecScreen[];
  journeys?: SpecJourney[];
  personas?: SpecPersona[];
}

// Theme palette — real open-design tokens (adapts to light/dark + warm accent).
const T = {
  panel: 'var(--bg-panel, #ffffff)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  muted: 'var(--bg-muted, #eef0f3)',
  border: 'var(--border, #e1e5eb)',
  borderSoft: 'var(--border-soft, #edf0f4)',
  text: 'var(--text, #1a1a1a)',
  textSoft: 'var(--text-soft, #4b5563)',
  textMuted: 'var(--text-muted, #6b7280)',
  accent: 'var(--accent, #0066b3)',
  accentSoft: 'var(--accent-soft, #d6e7f4)',
  accentTint: 'var(--accent-tint, #e6f0f8)',
  selected: 'var(--selected, var(--accent-tint, #e6f0f8))',
  amber: 'var(--amber, #b45309)',
  red: 'var(--red, #dc2626)',
  green: 'var(--green, #16a34a)',
  blue: 'var(--blue, #2563eb)',
  radius: 'var(--radius, 8px)',
  radiusSm: 'var(--radius-sm, 6px)',
  shadow: 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.05))',
  mono: 'var(--mono, ui-monospace, monospace)',
};

// component_type → short wireframe glyph (mirrors WireloomViewer GLYPH_ALIAS).
const GLYPH: Record<string, string> = {
  input: '▭', textinput: '▭', passwordinput: '▭', numberinput: '▭', textarea: '▭', search: '🔍',
  button: '▮', cta: '▮',
  select: '▽', dropdown: '▽', combobox: '▽',
  checkbox: '☐', toggle: '⊙', switch: '⊙', radio: '◉',
  text: '≡', label: '≡', paragraph: '≡',
  heading: 'H', title: 'H',
  link: '↗',
  image: '▣', illustration: '▣', icon: '◆',
  card: '▢', list: '☰', list_item: '–', listitem: '–',
  table: '▦', chart: '📊', progress: '▰', badge: '◷', stepper: '⋯', navbar: '⬒', appbar: '⬒',
};
function glyph(type?: string): string {
  return GLYPH[(type ?? '').toLowerCase()] ?? '▭';
}

// emotion → score(1..5) + colour + emoji + Vietnamese label. Union of the
// SimStudio EMOTION_MAP and the values the AI emits (curious/excited/…).
type Emo = { score: number; color: string; emoji: string; label: string };
const NEUTRAL: Emo = { score: 3, color: '#95a5a6', emoji: '😐', label: 'Trung tính' };
const EMOTION: Record<string, Emo> = {
  delighted: { score: 5, color: '#2ecc71', emoji: '😄', label: 'Rất hài lòng' },
  satisfied: { score: 5, color: '#27ae60', emoji: '🙂', label: 'Hài lòng' },
  excited: { score: 5, color: '#2ecc71', emoji: '🤩', label: 'Hào hứng' },
  focused: { score: 4, color: '#3498db', emoji: '🎯', label: 'Tập trung' },
  relieved: { score: 4, color: '#27ae60', emoji: '😌', label: 'Nhẹ nhõm' },
  hopeful: { score: 3, color: '#16a085', emoji: '🙏', label: 'Hy vọng' },
  curious: { score: 3, color: '#3498db', emoji: '🤔', label: 'Tò mò' },
  neutral: NEUTRAL,
  anxious: { score: 2, color: '#e67e22', emoji: '😟', label: 'Lo lắng' },
  impatient: { score: 2, color: '#f39c12', emoji: '😤', label: 'Sốt ruột' },
  tired: { score: 2, color: '#e67e22', emoji: '😩', label: 'Mệt' },
  concerned: { score: 1, color: '#e74c3c', emoji: '😰', label: 'Lo ngại' },
  frustrated: { score: 1, color: '#e74c3c', emoji: '😣', label: 'Bực bội' },
};
function emo(e?: string): Emo {
  return EMOTION[(e ?? 'neutral').toLowerCase()] ?? NEUTRAL;
}
function painText(p: PainPoint): string {
  return typeof p === 'string' ? p : p.text ?? p.description ?? '';
}
const STAGE_TYPE_COLOR: Record<string, string> = {
  awareness: T.blue,
  action: T.accent,
  decision: T.amber,
  verification: T.blue,
  waiting: T.textMuted,
  confirmation: T.green,
  validation: T.blue,
  activation: T.green,
  success: T.green,
  error: T.red,
  correction: T.amber,
};
function stageColor(t?: string): string {
  return STAGE_TYPE_COLOR[(t ?? '').toLowerCase()] ?? T.textMuted;
}
function actorOf(s: { primary_actor?: string; actor_id?: string }): string {
  return s.primary_actor || s.actor_id || '';
}

// Our components have no region; infer one (appbar/footer/bottom_nav/body) from
// type + semantic_type + position so the wireloom wireframe lays out like /ux-spec.
function inferRegion(c: SpecComponent, idx: number, total: number): string {
  const t = (c.component_type ?? '').toLowerCase();
  const sem = (c.semantic_type ?? '').toLowerCase();
  if (t === 'navbar' || t === 'appbar' || sem === 'appbar' || sem === 'navbar') return 'appbar';
  if (t === 'tabbar' || sem === 'bottom_nav' || sem === 'tabbar') return 'bottom_nav';
  if (idx === 0 && (t === 'heading' || t === 'title' || sem === 'header' || sem === 'title')) return 'appbar';
  if ((t === 'button' || t === 'cta') && idx >= total - 2) return 'footer';
  return 'body';
}
function toWireElements(comps: SpecComponent[]): WireElement[] {
  return comps.map((c, i) => ({
    id: c.id ?? `c${i}`,
    role: c.label || c.component_type || c.id || '',
    component_glyph: c.component_type || 'text',
    region: inferRegion(c, i, comps.length),
    order: c.order ?? i + 1,
    prominence: c.prominence,
    input_type: c.data_type,
  }));
}

const S = {
  wrap: {
    display: 'grid',
    gridTemplateColumns: '240px 1fr',
    gap: 12,
    height: '100%',
    minHeight: 0,
    padding: 12,
    color: T.text,
  } as const,
  side: {
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    background: T.panel,
    padding: 8,
  } as const,
  main: {
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    background: T.panel,
    padding: 16,
  } as const,
  sideItem: (active: boolean) =>
    ({
      display: 'block',
      width: '100%',
      textAlign: 'left',
      border: `1px solid ${active ? T.accentSoft : 'transparent'}`,
      background: active ? T.selected : 'transparent',
      borderRadius: T.radiusSm,
      padding: '6px 8px',
      marginBottom: 2,
      cursor: 'pointer',
      color: T.text,
      fontSize: 12,
    }) as const,
  badge: {
    fontSize: 9,
    padding: '1px 6px',
    borderRadius: 999,
    background: T.muted,
    color: T.textSoft,
    fontFamily: T.mono,
  } as const,
  select: {
    width: '100%',
    fontSize: 11,
    padding: '4px 6px',
    borderRadius: T.radiusSm,
    border: `1px solid ${T.border}`,
    background: T.subtle,
    color: T.text,
  } as const,
  h1: { fontSize: 15, fontWeight: 600, margin: 0, color: T.text } as const,
  meta: { fontSize: 11, color: T.textMuted, marginTop: 2 } as const,
  sectionTitle: {
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: T.textMuted,
    fontWeight: 600,
    margin: '18px 0 6px',
  } as const,
};

// ── Emotion curve (SVG line chart — mirrors customer-journey-v2 EmotionCurve) ──
function EmotionCurve({ stages }: { stages: SpecStage[] }) {
  if (!stages.length) return null;
  const pts = stages.map((s) => emo(s.emotion).score);
  const W = 600;
  const H = 80;
  const pad = 12;
  const step = pts.length > 1 ? (W - 2 * pad) / (pts.length - 1) : 0;
  const y = (p: number) => H - pad - ((p - 1) / 4) * (H - 2 * pad);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${pad + i * step} ${y(p)}`).join(' ');
  return (
    <section>
      <div style={S.sectionTitle}>Emotion curve</div>
      <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.subtle, padding: 12 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }}>
          {[1, 2, 3, 4, 5].map((g) => (
            <line key={g} x1={pad} x2={W - pad} y1={y(g)} y2={y(g)} stroke={T.border} strokeWidth={1} />
          ))}
          <path d={path} fill="none" stroke={T.accent} strokeWidth={2} />
          {pts.map((p, i) => (
            <circle key={i} cx={pad + i * step} cy={y(p)} r={3.5} fill={stages[i] ? emo(stages[i]!.emotion).color : T.accent} />
          ))}
        </svg>
        <div style={{ display: 'flex', marginTop: 4 }}>
          {stages.map((s, i) => (
            <span
              key={s.id ?? i}
              style={{ width: `${100 / stages.length}%`, textAlign: 'center', fontSize: 9, color: T.textMuted }}
            >
              {i + 1}. {emo(s.emotion).emoji} {emo(s.emotion).label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function DetailList({ title, items, prefix, italic }: { title: string; items?: string[]; prefix: string; italic?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.textMuted, marginBottom: 2 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 11 }}>
        {items.map((a, i) => (
          <li key={i} style={{ color: T.textSoft, fontStyle: italic ? 'italic' : 'normal', marginBottom: 1 }}>
            {prefix} {a}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StageCard({ stage, index }: { stage: SpecStage; index: number }) {
  const e = emo(stage.emotion);
  const pains = (stage.pain_points ?? []).map(painText).filter(Boolean);
  const score = typeof stage.emotion_score === 'number' ? stage.emotion_score : e.score;
  const sources = (stage.sources ?? []).filter((s) => (s.quote ?? '').trim());
  return (
    <li style={{ listStyle: 'none', border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.subtle, padding: 12 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <div
          style={{
            flexShrink: 0,
            width: 26,
            height: 26,
            borderRadius: 999,
            background: T.accentTint,
            color: T.accent,
            fontSize: 12,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {index}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{stage.name ?? stage.id}</strong>
            <span style={{ ...S.badge, background: 'transparent', border: `1px solid ${stageColor(stage.stage_type)}`, color: stageColor(stage.stage_type) }}>
              {stage.stage_type ?? '—'}
            </span>
            <span style={{ fontSize: 10, color: T.textMuted }}>
              {e.emoji} {e.label} · {score}/5
            </span>
          </div>
          {stage.goal ? <div style={{ fontSize: 12, color: T.textSoft, marginTop: 4 }}>🎯 {stage.goal}</div> : null}
          <DetailList title="User actions" items={stage.user_actions} prefix="•" />
          <DetailList title="System responses" items={stage.system_responses} prefix="▸" italic />
          {(stage.touchpoints ?? []).length ? (
            <div style={{ marginTop: 8, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', color: T.textMuted }}>Touchpoints:</span>
              {stage.touchpoints!.map((tp) => (
                <span key={tp} style={{ ...S.badge, background: 'var(--blue-bg, #e0edff)', color: T.blue }}>
                  {tp}
                </span>
              ))}
            </div>
          ) : null}
          {(stage.thoughts ?? []).length ? (
            <blockquote
              style={{ margin: '8px 0 0', borderLeft: `2px solid ${T.accent}`, paddingLeft: 8, fontSize: 11, fontStyle: 'italic', color: T.textSoft }}
            >
              {stage.thoughts!.map((th, i) => (
                <div key={i}>&ldquo;{th}&rdquo;</div>
              ))}
            </blockquote>
          ) : null}
          {pains.length ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', color: T.textMuted, marginBottom: 4 }}>
                ⚠️ Pain points ({pains.length})
              </div>
              {pains.map((p, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    borderRadius: T.radiusSm,
                    background: 'var(--red-bg, #fee2e2)',
                    border: `1px solid var(--red-border, #fecaca)`,
                    color: T.text,
                    padding: '4px 8px',
                    marginBottom: 4,
                  }}
                >
                  {p}
                </div>
              ))}
            </div>
          ) : null}
          {sources.length ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', color: T.textMuted, marginBottom: 4 }}>
                📄 Key text from docs ({sources.length})
              </div>
              {sources.map((s, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    borderRadius: T.radiusSm,
                    background: T.muted,
                    borderLeft: `2px solid ${T.accent}`,
                    color: T.text,
                    padding: '5px 8px',
                    marginBottom: 4,
                  }}
                >
                  <div style={{ fontStyle: 'italic' }}>&ldquo;{s.quote}&rdquo;</div>
                  {s.file || s.heading ? (
                    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 3 }}>
                      {(s.file ?? '').split('/').pop()}
                      {s.heading ? ` · ${s.heading}` : ''}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ── Customer Journey ─────────────────────────────────────────────────────────
function CustomerJourneyView({ journeys, personas }: { journeys: SpecJourney[]; personas: SpecPersona[] }) {
  const [actor, setActor] = useState<string>('all');
  const actors = useMemo(() => {
    const set = new Map<string, string>();
    journeys.forEach((j) => j.actor_id && set.set(j.actor_id, j.actor_id));
    return [...set.keys()];
  }, [journeys]);
  const visible = actor === 'all' ? journeys : journeys.filter((j) => j.actor_id === actor);
  const [sel, setSel] = useState<string>(journeys[0]?.id ?? '');
  const journey = visible.find((j) => j.id === sel) ?? visible[0] ?? journeys[0];
  const stages = useMemo(
    () => [...(journey?.stages ?? [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)),
    [journey],
  );
  const grouped = useMemo(() => {
    const m = new Map<string, SpecJourney[]>();
    visible.forEach((j) => {
      const k = j.actor_id ?? '—';
      (m.get(k) ?? m.set(k, []).get(k)!).push(j);
    });
    return [...m.entries()];
  }, [visible]);
  if (!journey) return <div style={{ padding: 16, color: T.textMuted }}>No journeys.</div>;
  return (
    <div style={S.wrap}>
      <aside style={S.side}>
        <div style={{ padding: '4px 4px 8px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🗺 Customer Journey — {journeys.length}</div>
          <select style={S.select} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="all">Tất cả ({journeys.length})</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {grouped.map(([actorId, items]) => (
          <div key={actorId} style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                color: T.accent,
                background: T.accentTint,
                border: `1px solid ${T.accentSoft}`,
                borderRadius: T.radiusSm,
                padding: '3px 6px',
                marginBottom: 4,
                display: 'flex',
                gap: 6,
              }}
            >
              <span>👥 {actorId.replace('actor-', '')}</span>
              <span style={{ marginLeft: 'auto', color: T.textMuted, fontWeight: 400 }}>{items.length}</span>
            </div>
            {items.map((j) => (
              <button key={j.id} type="button" style={S.sideItem(j.id === journey.id)} onClick={() => setSel(j.id)}>
                <div style={{ fontWeight: 500 }}>{j.title ?? j.name ?? j.id}</div>
                <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                  {(j.stages ?? []).length} stages · <code>{j.id.replace('UFLW-', '')}</code>
                </div>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <main style={S.main}>
        <header>
          <h1 style={S.h1}>{journey.title ?? journey.name ?? journey.id}</h1>
          <div style={S.meta}>
            <code style={{ fontSize: 10 }}>{journey.id}</code> · actor=
            <span style={{ color: T.text }}>{journey.actor_id ?? '—'}</span> · mode={journey.journey_mode ?? 'to_be'}
            {journey.flow_type ? ` · ${journey.flow_type}` : ''}
          </div>
          {journey.goal ? <p style={{ fontSize: 12, color: T.textSoft, marginTop: 6 }}>🎯 {journey.goal}</p> : null}
        </header>

        <EmotionCurve stages={stages} />

        <div style={S.sectionTitle}>Stages ({stages.length})</div>
        <ol style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((st, i) => (
            <StageCard key={st.id ?? i} stage={st} index={i + 1} />
          ))}
        </ol>

        <PersonasBlock personas={personas} />
      </main>
    </div>
  );
}

// ── UX Spec ──────────────────────────────────────────────────────────────────
function UxSpecView({ screens, personas }: { screens: SpecScreen[]; personas: SpecPersona[] }) {
  const [actor, setActor] = useState<string>('all');
  const actors = useMemo(() => {
    const set = new Set<string>();
    screens.forEach((s) => actorOf(s) && set.add(actorOf(s)));
    return [...set];
  }, [screens]);
  const visible = actor === 'all' ? screens : screens.filter((s) => actorOf(s) === actor);
  const [sel, setSel] = useState<string>(screens[0]?.id ?? '');
  const screen = visible.find((s) => s.id === sel) ?? visible[0] ?? screens[0];
  const comps = useMemo(
    () => [...(screen?.components ?? [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)),
    [screen],
  );
  if (!screen) return <div style={{ padding: 16, color: T.textMuted }}>No screens.</div>;
  return (
    <div style={S.wrap}>
      <aside style={S.side}>
        <div style={{ padding: '4px 4px 8px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>📐 UX Spec — {screens.length} màn</div>
          <select style={S.select} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="all">Tất cả ({screens.length})</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {visible.map((s) => (
          <button key={s.id} type="button" style={S.sideItem(s.id === screen.id)} onClick={() => setSel(s.id)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 500, flex: 1 }}>{s.name ?? s.title ?? s.id}</span>
              <span style={S.badge}>{s.screen_type ?? '—'}</span>
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{actorOf(s) || '—'}</div>
          </button>
        ))}
      </aside>
      <main style={S.main}>
        <header>
          <h1 style={S.h1}>{screen.name ?? screen.title ?? screen.id}</h1>
          <div style={S.meta}>
            <code style={{ fontSize: 10 }}>{screen.id}</code> · {screen.screen_type ?? '—'} · actor=
            {actorOf(screen) || '—'} {screen.layout ? `· ${screen.layout}` : ''}
          </div>
          {screen.screen_intent ? (
            <p style={{ fontSize: 12, color: T.textSoft, marginTop: 6 }}>{screen.screen_intent}</p>
          ) : null}
        </header>

        <div style={S.sectionTitle}>Wireframe (Wireloom) — {comps.length} thành phần</div>
        <WireloomViewer screenName={screen.name ?? screen.title ?? screen.id} elements={toWireElements(comps)} />

        {/* Components table — text-mockup chi tiết */}
        <div style={S.sectionTitle}>Components</div>
        <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: 'hidden' }}>
          {comps.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12, padding: 10 }}>(màn chưa có component)</div>
          ) : (
            comps.map((c, i) => (
              <div
                key={c.id ?? i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  fontSize: 12,
                  borderTop: i ? `1px solid ${T.borderSoft}` : 'none',
                  background: i % 2 ? T.subtle : T.panel,
                }}
              >
                <span style={{ fontFamily: T.mono, fontSize: 13, width: 20, textAlign: 'center', color: T.accent }}>
                  {glyph(c.component_type)}
                </span>
                <span style={{ flex: 1 }}>{c.label || c.component_type || c.id}</span>
                <span style={S.badge}>{c.component_type ?? 'text'}</span>
                {c.required ? <span style={{ ...S.badge, background: 'var(--amber-bg, #fef3c7)', color: T.amber }}>required</span> : null}
              </div>
            ))
          )}
        </div>

        <PersonasBlock personas={personas} />
      </main>
    </div>
  );
}

function PersonasBlock({ personas }: { personas: SpecPersona[] }) {
  if (!personas || personas.length === 0) return null;
  return (
    <>
      <div style={S.sectionTitle}>Personas ({personas.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {personas.map((p, i) => (
          <div
            key={p.id ?? i}
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: T.radius,
              padding: 10,
              fontSize: 11,
              minWidth: 180,
              flex: '1 1 180px',
              background: T.subtle,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12 }}>🧑 {p.name}</div>
            {Object.entries(p)
              .filter(([k]) => !['id', 'name'].includes(k))
              .slice(0, 6)
              .map(([k, v]) => (
                <div key={k} style={{ color: T.textMuted, marginTop: 2 }}>
                  <span style={{ color: T.textSoft }}>{k}:</span> {Array.isArray(v) ? v.join(', ') : String(v)}
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Mermaid generators (CJ → journey, UX → flowchart) ────────────────────────
function mmText(s: string | undefined): string {
  return (s ?? '').replace(/["\n:;#|<>]/g, ' ').replace(/\s+/g, ' ').trim() || '?';
}
function mmId(s: string): string {
  return 'n' + (s || '').replace(/[^A-Za-z0-9_]/g, '_');
}
// Normalize a label/screen name for fuzzy CTA→screen matching: strip Vietnamese
// diacritics, lowercase, keep alphanumerics separated by single spaces.
function normLabel(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Significant tokens only (len >= 4) so short Vietnamese function words don't
// cause spurious matches.
function sigTokens(s: string | undefined): string[] {
  return normLabel(s).split(' ').filter((w) => w.length >= 4);
}
const CTA_TYPES = new Set(['button', 'cta', 'link', 'submit']);
const BACK_RE = /\b(back|quay lai|tro lai|truoc|huy|cancel|close|dong|thoat)\b/;
function isCta(c: SpecComponent): boolean {
  const t = (c.component_type ?? '').toLowerCase();
  const sem = (c.semantic_type ?? '').toLowerCase();
  return CTA_TYPES.has(t) || /button|cta|submit|nav|link/.test(sem);
}
// The CTA most likely to drive forward navigation: primary prominence, else a
// dedicated cta type, else the last action on the screen.
function pickPrimaryCta(ctas: SpecComponent[]): SpecComponent | null {
  if (ctas.length === 0) return null;
  return (
    ctas.find((c) => /primary|high|strong/i.test(c.prominence ?? '')) ??
    ctas.find((c) => (c.component_type ?? '').toLowerCase() === 'cta') ??
    ctas[ctas.length - 1] ??
    null
  );
}
// Heuristic: resolve a CTA label to a target screen by name/intent overlap.
function matchTargetScreen(label: string, fromId: string, screens: SpecScreen[]): string | null {
  const ln = normLabel(label);
  if (ln.length < 3) return null;
  const lt = sigTokens(label);
  let best: { id: string; score: number } | null = null;
  for (const s of screens) {
    if (s.id === fromId) continue;
    const cand = normLabel(s.name ?? s.title ?? s.id);
    let score = 0;
    if (cand.length >= 4 && (cand.includes(ln) || ln.includes(cand))) score += 3;
    const st = new Set([...sigTokens(s.name ?? s.title ?? s.id), ...sigTokens(s.screen_intent)]);
    for (const w of lt) if (st.has(w)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { id: s.id, score };
  }
  return best ? best.id : null;
}

export function specToMermaid(doc: SpecDoc): string {
  const journeys = Array.isArray(doc.journeys) ? doc.journeys : [];
  const screens = Array.isArray(doc.screens) ? doc.screens : [];
  if (journeys.length > 0) {
    const lines = ['journey', `  title ${mmText(journeys[0]?.name) || 'Customer Journey'}`];
    for (const j of journeys) {
      const stages = [...(j.stages ?? [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      lines.push(`  section ${mmText(j.name ?? j.id)}`);
      const actor = mmText(j.actor_id) || 'user';
      if (stages.length === 0) lines.push(`    ${mmText(j.name ?? j.id)}: ${NEUTRAL.score}: ${actor}`);
      for (const st of stages) lines.push(`    ${mmText(st.name ?? st.id)}: ${emo(st.emotion).score}: ${actor}`);
    }
    return lines.join('\n');
  }

  // UX spec → screen-level NAVIGATION flowchart. Each screen is ONE node; edges
  // are inferred from CTA-like components, not from component order:
  //   1. a CTA whose label name-matches another screen → edge to that screen,
  //   2. otherwise the primary CTA advances to the next screen in order,
  //   3. back/cancel CTAs loop to the previous screen (dashed).
  if (screens.length === 0) return 'flowchart LR\n  empty["(no content)"]';
  const lines = ['flowchart LR'];
  for (const s of screens) lines.push(`  ${mmId(s.id)}["${mmText(s.name ?? s.title ?? s.id)}"]`);

  type Edge = { from: string; to: string; label: string; dashed: boolean };
  const edges: Edge[] = [];
  const byKey = new Map<string, Edge>();
  const addEdge = (from: string, to: string, label: string, dashed: boolean) => {
    if (from === to) return;
    const key = `${from}>${to}>${dashed ? 'd' : 's'}`;
    const existing = byKey.get(key);
    if (existing) {
      if (label && !existing.label.split(' / ').includes(label)) {
        existing.label = existing.label ? `${existing.label} / ${label}` : label;
      }
      return;
    }
    const e = { from, to, label, dashed };
    byKey.set(key, e);
    edges.push(e);
  };

  screens.forEach((s, i) => {
    const prevScreen = i > 0 ? screens[i - 1] : undefined;
    const nextScreen = i < screens.length - 1 ? screens[i + 1] : undefined;
    const ctas = [...(s.components ?? [])].filter(isCta).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const primary = pickPrimaryCta(ctas);
    let forwardUsed = false;
    for (const c of ctas) {
      const raw = c.label ?? c.component_type ?? '';
      const label = mmText(raw);
      if (BACK_RE.test(normLabel(raw))) {
        if (prevScreen) addEdge(mmId(s.id), mmId(prevScreen.id), label, true);
        continue;
      }
      const target = matchTargetScreen(raw, s.id, screens);
      if (target) {
        addEdge(mmId(s.id), mmId(target), label, false);
        if (c === primary) forwardUsed = true;
      } else if (c === primary && nextScreen && !forwardUsed) {
        addEdge(mmId(s.id), mmId(nextScreen.id), label, false);
        forwardUsed = true;
      }
    }
  });

  // Fallback: nothing inferred → linear storyboard in document order so the
  // graph is still connected instead of disjoint boxes.
  if (edges.length === 0 && screens.length > 1) {
    for (let i = 0; i < screens.length - 1; i++) {
      const a = screens[i];
      const b = screens[i + 1];
      if (a && b) addEdge(mmId(a.id), mmId(b.id), '', false);
    }
  }

  // Start marker → entry screen (first screen with no incoming solid edge).
  const incoming = new Set(edges.filter((e) => !e.dashed).map((e) => e.to));
  const entry = screens.find((s) => !incoming.has(mmId(s.id))) ?? screens[0];
  if (entry) lines.push(`  __start(("●")) --> ${mmId(entry.id)}`);
  for (const e of edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    lines.push(e.label ? `  ${e.from} ${arrow}|"${e.label}"| ${e.to}` : `  ${e.from} ${arrow} ${e.to}`);
  }
  lines.push('  classDef odstart fill:#0066b3,stroke:#0066b3,color:#ffffff;');
  lines.push('  class __start odstart;');
  return lines.join('\n');
}

export function SpecPreview({ doc }: { doc: SpecDoc }) {
  const screens = Array.isArray(doc.screens) ? doc.screens : [];
  const journeys = Array.isArray(doc.journeys) ? doc.journeys : [];
  const personas = Array.isArray(doc.personas) ? doc.personas : [];
  const hasUx = screens.length > 0;
  const hasCj = journeys.length > 0;
  const [kind, setKind] = useState<'ux' | 'cj'>(hasUx ? 'ux' : 'cj');
  const active = hasUx && hasCj ? kind : hasUx ? 'ux' : 'cj';

  if (!hasUx && !hasCj) {
    if (personas.length > 0)
      return (
        <div style={{ padding: 14 }}>
          <PersonasBlock personas={personas} />
        </div>
      );
    return <div style={{ padding: 16, color: T.textMuted }}>Không có nội dung CJ/UX để preview.</div>;
  }

  const body =
    active === 'ux' ? (
      <UxSpecView screens={screens} personas={personas} />
    ) : (
      <CustomerJourneyView journeys={journeys} personas={personas} />
    );

  if (!(hasUx && hasCj)) return body;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0' }}>
        {(['ux', 'cj'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 12px',
              borderRadius: T.radiusSm,
              cursor: 'pointer',
              border: `1px solid ${active === k ? T.accent : T.border}`,
              background: active === k ? T.accentTint : T.panel,
              color: active === k ? T.accent : T.textMuted,
            }}
          >
            {k === 'ux' ? `UX Spec (${screens.length})` : `Customer Journey (${journeys.length})`}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
    </div>
  );
}
