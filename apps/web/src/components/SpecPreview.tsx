// SpecPreview — render a Customer Journey / UX Spec JSON (customer-journey-spec /
// ux-spec skill output) as a visual spec, mirroring SimStudio's
// /customer-journey and /ux-spec routes — but reading the file DIRECTLY (no KGS
// push / Pull All needed). Layout, sidebar grouping, emotion curve (SVG line),
// stage cards and screen wireframe follow those routes; styled with open-design
// theme tokens.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Angry,
  Cog,
  ExternalLink,
  FileText,
  Frown,
  Info,
  Laugh,
  LayoutTemplate,
  Loader2,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Meh,
  MessageSquareQuote,
  Minimize2,
  Smile,
  Target,
  TriangleAlert,
  User,
  Users,
  X,
} from 'lucide-react';
import { fetchProjectFileText, fetchProjectFiles } from '../providers/registry';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { WireFrameView, wiretextEditUrl, DEVICES, WEB_DEVICES, type WireDoc, type DeviceKey } from './WireFrameView';

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
  /** EXPLICIT navigation target (screen id) — the ONLY source of flow edges
   *  since 2026-07-10; the ux-spec skill requires it on every navigating CTA. */
  navigates_to?: string;
  /** 'navigate' (default) | 'back' — back renders as a dashed return edge. */
  nav_type?: string;
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
  navigation_group?: string;
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
// Emotion → lucide face (replaces the emoji). Colour still comes from the
// emotion so the curve/pill read the same "good→bad" gradient as before.
function faceFor(score: number) {
  if (score >= 5) return Laugh;
  if (score >= 4) return Smile;
  if (score === 3) return Meh;
  if (score === 2) return Frown;
  return Angry;
}
function EmotionFace({ emotion, size = 18 }: { emotion?: string; size?: number }) {
  const e = emo(emotion);
  const Face = faceFor(e.score);
  return <Face size={size} color={e.color} strokeWidth={2} aria-hidden />;
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

const S = {
  wrap: {
    display: 'grid',
    gridTemplateColumns: '256px 1fr',
    gap: 14,
    height: '100%',
    minHeight: 0,
    padding: 14,
    color: T.text,
  } as const,
  side: {
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    background: T.panel,
    padding: 10,
  } as const,
  main: {
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    background: T.panel,
    padding: '20px 24px',
  } as const,
  sideItem: (active: boolean) =>
    ({
      display: 'block',
      width: '100%',
      textAlign: 'left',
      // Active = accent BORDER (+ faint tint), not a heavy fill — keeps the text
      // and the type badge readable. Non-active stays borderless (1.5px
      // transparent so there's no layout shift when it becomes active).
      border: `1.5px solid ${active ? T.accent : 'transparent'}`,
      background: active ? T.accentTint : 'transparent',
      borderRadius: T.radiusSm,
      padding: '9px 10px',
      marginBottom: 3,
      cursor: 'pointer',
      color: T.text,
      fontSize: 13.5,
    }) as const,
  badge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    background: T.muted,
    color: T.textSoft,
    fontFamily: T.mono,
  } as const,
  select: {
    width: '100%',
    fontSize: 13,
    padding: '7px 10px',
    borderRadius: T.radiusSm,
    border: `1px solid ${T.border}`,
    background: T.subtle,
    color: T.text,
  } as const,
  h1: { fontSize: 22, fontWeight: 700, margin: 0, color: T.text, letterSpacing: '-0.01em' } as const,
  meta: { fontSize: 13, color: T.textSoft, marginTop: 6 } as const,
  sectionTitle: {
    fontSize: 12.5,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: T.textSoft,
    fontWeight: 700,
    margin: '26px 0 12px',
  } as const,
};

// ── Emotion curve (area chart — dots overlaid as HTML so they stay round while
//    the SVG stretches full-width; each dot/emoji cell shares one column) ──────
function EmotionCurve({ stages }: { stages: SpecStage[] }) {
  if (!stages.length) return null;
  const n = stages.length;
  const pts = stages.map((s) => emo(s.emotion).score);
  const pad = 14; // viewBox units, top/bottom breathing room
  const xf = (i: number) => ((i + 0.5) / n) * 100; // percent, column-centered
  const yv = (p: number) => pad + ((5 - p) / 4) * (100 - 2 * pad); // 0..100 viewBox
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${i + 0.5} ${yv(p)}`).join(' ');
  const area = n > 1 ? `${line} L ${n - 0.5} ${100 - pad} L 0.5 ${100 - pad} Z` : '';
  const H = 120;
  return (
    <section>
      <SectionHeading hint="Biểu đồ diễn biến cảm xúc của người dùng qua từng bước — điểm càng cao (1→5) là trải nghiệm càng tích cực.">
        Hành trình cảm xúc
      </SectionHeading>
      <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.subtle, padding: 14 }}>
        <div style={{ position: 'relative', height: H }}>
          <svg
            viewBox={`0 0 ${n} 100`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          >
            {[1, 2, 3, 4, 5].map((g) => (
              <line
                key={g}
                x1={0}
                x2={n}
                y1={yv(g)}
                y2={yv(g)}
                stroke={T.border}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={g === 3 ? undefined : '3 4'}
                opacity={0.7}
              />
            ))}
            {area ? <path d={area} fill={T.accent} fillOpacity={0.12} /> : null}
            <path
              d={line}
              fill="none"
              stroke={T.accent}
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          {stages.map((s, i) => {
            const e = emo(s.emotion);
            return (
              <div
                key={s.id ?? i}
                title={`Bước ${i + 1}${s.name ? ` · ${s.name}` : ''} — ${e.label} (${e.score}/5)`}
                style={{
                  position: 'absolute',
                  left: `${xf(i)}%`,
                  top: `${yv(e.score)}%`,
                  transform: 'translate(-50%,-50%)',
                  width: 13,
                  height: 13,
                  borderRadius: 999,
                  background: e.color,
                  border: `2.5px solid ${T.panel}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
                }}
              />
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: 6, marginTop: 12 }}>
          {stages.map((s, i) => {
            const e = emo(s.emotion);
            return (
              <Tip
                key={s.id ?? i}
                block
                label={`Bước ${i + 1}${s.name ? ` · ${s.name}` : ''} — cảm xúc: ${e.label} (${e.score}/5)`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  textAlign: 'center',
                  padding: '8px 4px',
                  borderRadius: T.radiusSm,
                  background: T.panel,
                  border: `1px solid ${T.borderSoft}`,
                }}
              >
                <EmotionFace emotion={s.emotion} size={22} />
                <span style={{ fontSize: 11.5, fontWeight: 600, color: T.text, lineHeight: 1.2 }}>{e.label}</span>
                <span style={{ fontSize: 10, color: T.textMuted }}>Bước {i + 1}</span>
              </Tip>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// A clearly-labeled block inside a stage card: icon + uppercase title + body.
// Every stage sub-part (actions, responses, touchpoints, …) uses this so the
// card reads as distinct sections instead of one run-on column of text.
// A section title (uppercase) with an optional info tooltip. `hint` explains
// what the block below represents; shown on hover via a small info glyph.
function SectionHeading({ children, hint }: { children: ReactNode; hint?: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = (e: SyntheticEvent<HTMLElement>) => hint && setRect(e.currentTarget.getBoundingClientRect());
  const hide = () => setRect(null);
  return (
    <div
      tabIndex={hint ? 0 : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ ...S.sectionTitle, display: 'flex', alignItems: 'center', gap: 6, cursor: hint ? 'help' : undefined }}
    >
      <span>{children}</span>
      {hint ? <Info size={12} style={{ opacity: 0.55, flexShrink: 0 }} /> : null}
      {rect && hint ? <TipBubble rect={rect} label={hint} /> : null}
    </div>
  );
}

function StageSection({
  icon,
  title,
  color,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  color?: string;
  /** Tooltip explaining what this block represents. */
  hint?: string;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = (e: SyntheticEvent<HTMLElement>) => hint && setRect(e.currentTarget.getBoundingClientRect());
  const hide = () => setRect(null);
  return (
    <div style={{ marginTop: 14 }}>
      <div
        tabIndex={hint ? 0 : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          marginBottom: 7,
          color: color ?? T.textSoft, // lucide icon inherits via currentColor
          cursor: hint ? 'help' : undefined,
        }}
      >
        <span style={{ display: 'inline-flex', lineHeight: 1 }}>{icon}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {title}
        </span>
        {hint ? <Info size={12} style={{ opacity: 0.5, flexShrink: 0 }} /> : null}
        {rect && hint ? <TipBubble rect={rect} label={hint} /> : null}
      </div>
      {children}
    </div>
  );
}

function BulletList({
  items,
  marker,
  markerColor,
  italic,
}: {
  items: string[];
  marker: string;
  markerColor?: string;
  italic?: boolean;
}) {
  return (
    <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
      {items.map((a, i) => (
        <li
          key={i}
          style={{
            display: 'flex',
            gap: 8,
            fontSize: 13.5,
            lineHeight: 1.5,
            color: T.textSoft,
            fontStyle: italic ? 'italic' : 'normal',
          }}
        >
          <span style={{ color: markerColor ?? T.accent, flexShrink: 0, fontWeight: 700 }}>{marker}</span>
          <span>{a}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Click a source quote → open the doc, scroll to the passage, highlight it ──
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Whitespace-tolerant matcher: the stored quote may differ from the doc by
// line-wrapping/spacing, so we match its tokens with `\s+` between them.
function fuzzyRegex(q: string): RegExp | null {
  const toks = q.trim().split(/\s+/).map(escapeRegExp).filter(Boolean);
  if (!toks.length) return null;
  try {
    return new RegExp(toks.join('\\s+'), 'i');
  } catch {
    return null;
  }
}
// Find `re` across the rendered markdown's text nodes and wrap the matched
// span(s) in <mark class="od-doc-hl">. Works even when the passage straddles
// several nodes (e.g. bold/links inside it). Returns the first mark for scroll.
function highlightMatch(container: HTMLElement, re: RegExp): HTMLElement | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number; len: number }[] = [];
  let full = '';
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const text = cur.nodeValue ?? '';
    nodes.push({ node: cur as Text, start: full.length, len: text.length });
    full += text;
    cur = walker.nextNode();
  }
  const m = re.exec(full);
  if (!m) return null;
  const ms = m.index;
  const me = m.index + m[0].length;
  let first: HTMLElement | null = null;
  // Wrap back-to-front so earlier offsets stay valid as nodes are split.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const info = nodes[i]!;
    const ns = info.start;
    const ne = info.start + info.len;
    if (ne <= ms || ns >= me) continue;
    const localStart = Math.max(ms, ns) - ns;
    const localEnd = Math.min(me, ne) - ns;
    try {
      const range = document.createRange();
      range.setStart(info.node, localStart);
      range.setEnd(info.node, localEnd);
      const mark = document.createElement('mark');
      mark.className = 'od-doc-hl';
      range.surroundContents(mark);
      first = mark; // last wrapped = earliest node (reverse loop)
    } catch {
      /* skip a node we can't safely wrap */
    }
  }
  return first;
}

// Injected once (per mounted spec view) — hover affordance for clickable
// sources + the highlight flash on the located passage. Inline styles can't
// express :hover or @keyframes, so this small stylesheet carries them.
const SPEC_CSS = `
.od-src-link { cursor: pointer; transition: box-shadow .15s ease, background .15s ease; }
.od-src-link:hover { box-shadow: inset 0 0 0 2px var(--accent-soft, #d6e7f4); }
.od-doc-hl {
  background: var(--accent-tint, #e6f0f8);
  border-radius: 3px;
  padding: 1px 2px;
  animation: odDocHlFlash 1.9s ease-out;
}
@keyframes odDocHlFlash {
  0%, 12% { background: var(--amber-bg, #fde68a); }
  100% { background: var(--accent-tint, #e6f0f8); }
}
.od-spin { animation: odSpin 0.9s linear infinite; }
@keyframes odSpin { to { transform: rotate(360deg); } }

/* Custom hover tooltip (portal to body → never clipped by card overflow).
   Resets inherited uppercase/letter-spacing so the hint reads normally. */
.od-tip-pop {
  position: fixed;
  z-index: 10000;
  max-width: 300px;
  background: #1f2937;
  color: #f8fafc;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: normal;
  text-transform: none;
  font-style: normal;
  padding: 8px 11px;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,.28);
  pointer-events: none;
  white-space: normal;
  animation: odTipIn .12s ease-out;
}
@keyframes odTipIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }

/* Rendered markdown inside the source-doc modal */
.od-doc-md { font-size: 14px; line-height: 1.65; color: var(--text, #1a1a1a); word-break: break-word; }
.od-doc-md > :first-child { margin-top: 0; }
.od-doc-md h1, .od-doc-md h2, .od-doc-md h3, .od-doc-md h4 { line-height: 1.3; margin: 1.3em 0 .5em; font-weight: 650; color: var(--text, #1a1a1a); }
.od-doc-md h1 { font-size: 1.5em; } .od-doc-md h2 { font-size: 1.3em; } .od-doc-md h3 { font-size: 1.13em; } .od-doc-md h4 { font-size: 1em; }
.od-doc-md p { margin: .55em 0; }
.od-doc-md ul, .od-doc-md ol { margin: .5em 0; padding-left: 1.5em; }
.od-doc-md li { margin: .25em 0; }
.od-doc-md code { font-family: var(--mono, ui-monospace, monospace); font-size: .88em; background: var(--bg-muted, #e4e8ef); padding: 1px 5px; border-radius: 4px; }
.od-doc-md pre { background: var(--bg-subtle, #eef1f5); padding: 12px 14px; border-radius: 8px; overflow-x: auto; margin: .7em 0; }
.od-doc-md pre code { background: none; padding: 0; }
.od-doc-md .md-table-wrap { overflow-x: auto; margin: .9em 0; }
.od-doc-md table { border-collapse: collapse; width: 100%; font-size: .95em; }
.od-doc-md th, .od-doc-md td { border: 1px solid var(--border, #e1e5eb); padding: 7px 10px; text-align: left; vertical-align: top; }
.od-doc-md th { background: var(--bg-subtle, #eef1f5); font-weight: 650; }
.od-doc-md tr:nth-child(even) td { background: color-mix(in srgb, var(--bg-subtle, #eef1f5) 45%, transparent); }
.od-doc-md blockquote { border-left: 3px solid var(--accent, #0066b3); margin: .7em 0; padding: .3em 0 .3em 12px; color: var(--text-soft, #4b5563); }
.od-doc-md a { color: var(--accent, #0066b3); text-decoration: none; }
.od-doc-md a:hover { text-decoration: underline; }
.od-doc-md hr { border: none; border-top: 1px solid var(--border, #e1e5eb); margin: 1.1em 0; }
.od-doc-md img { max-width: 100%; }
.od-doc-md-scroll { overflow: auto; }
`;
function SpecStyles() {
  return <style>{SPEC_CSS}</style>;
}

// Positions a tooltip bubble under an anchor via a body portal, so it is never
// clipped by a card's `overflow:hidden` or the scroll container. Returns the
// hover handlers to spread on the anchor plus the bubble node to render inside.
function TipBubble({ rect, label }: { rect: DOMRect; label: string }) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const left = Math.max(8, Math.min(rect.left, vw - 308));
  return createPortal(
    <div className="od-tip-pop" style={{ top: rect.bottom + 8, left }} role="tooltip">
      {label}
    </div>,
    document.body,
  );
}
// Drop-in tooltip wrapper. Renders a <span> (inline) or <div> (block) that shows
// `label` on hover/focus. Safe to use inside .map() (it's a component, not a hook).
function Tip({
  label,
  children,
  block,
  style,
  className,
}: {
  label: string;
  children: ReactNode;
  block?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = (e: SyntheticEvent<HTMLElement>) => setRect(e.currentTarget.getBoundingClientRect());
  const hide = () => setRect(null);
  const Tag = block ? 'div' : 'span';
  return (
    <Tag
      className={className}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ cursor: 'help', ...style }}
    >
      {children}
      {rect ? <TipBubble rect={rect} label={label} /> : null}
    </Tag>
  );
}

interface DocLoadState {
  loading: boolean;
  text: string | null;
  resolvedName: string | null;
  error: string | null;
}
function DocQuoteModal({
  projectId,
  source,
  onClose,
}: {
  projectId: string;
  source: SpecSource;
  onClose: () => void;
}) {
  const [st, setSt] = useState<DocLoadState>({ loading: true, text: null, resolvedName: null, error: null });
  const [full, setFull] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Rendered (sanitized) markdown HTML for the loaded doc.
  const html = useMemo(() => (st.text ? renderMarkdownToSafeHtml(st.text) : ''), [st.text]);

  // Resolve the doc file (the stored `file` may be a bare basename) and load it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const file = source.file ?? '';
      let name = file;
      let content = file ? await fetchProjectFileText(projectId, file) : null;
      if (content == null && file) {
        try {
          const files = await fetchProjectFiles(projectId);
          const base = file.split('/').pop();
          const hit =
            files.find((f) => f.name === file) ??
            files.find((f) => f.name.endsWith(`/${file}`)) ??
            files.find((f) => f.name.split('/').pop() === base);
          if (hit) {
            name = hit.name;
            content = await fetchProjectFileText(projectId, hit.name);
          }
        } catch {
          /* listing failed → error state below */
        }
      }
      if (cancelled) return;
      setSt(
        content == null
          ? { loading: false, text: null, resolvedName: name, error: 'Không mở được tài liệu nguồn.' }
          : { loading: false, text: content, resolvedName: name, error: null },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, source.file]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // After the markdown renders, locate the quoted passage in the DOM, wrap it
  // in a highlight, and scroll it into view. Falls back to the heading.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !html) return;
    const q = (source.quote ?? '').trim();
    let mark: HTMLElement | null = null;
    const qre = q ? fuzzyRegex(q) : null;
    if (qre) mark = highlightMatch(el, qre);
    if (!mark && source.heading) {
      const hre = fuzzyRegex(source.heading);
      if (hre) mark = highlightMatch(el, hre);
    }
    if (!mark) return;
    const id = window.setTimeout(() => {
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(id);
  }, [html, source.quote, source.heading]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(15,23,42,0.6)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: full ? 0 : 24,
      }}
    >
      <SpecStyles />
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: full ? '100%' : 'min(880px, 100%)',
          height: full ? '100%' : undefined,
          maxHeight: full ? '100%' : '88vh',
          display: 'flex',
          flexDirection: 'column',
          // Opaque surface — the theme's --bg-panel is a translucent glass token,
          // so use the solid app-canvas colour to stop the page bleeding through.
          background: 'var(--bg-app, #ffffff)',
          color: T.text,
          border: full ? 'none' : `1px solid ${T.border}`,
          borderRadius: full ? 0 : T.radius,
          boxShadow: full ? 'none' : '0 24px 60px rgba(0,0,0,0.32)',
          overflow: 'hidden',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: `1px solid ${T.border}`,
            background: T.subtle,
          }}
        >
          <FileText size={16} color={T.accent} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(st.resolvedName ?? source.file ?? '').split('/').pop()}
            </div>
            {source.heading ? (
              <div style={{ fontSize: 11.5, color: T.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {source.heading}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setFull((v) => !v)}
            title={full ? 'Thu nhỏ' : 'Phóng to toàn màn hình'}
            aria-pressed={full}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm,
              background: 'var(--bg-app, #ffffff)',
              color: T.textSoft,
              cursor: 'pointer',
            }}
          >
            {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Đóng (Esc)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm,
              background: 'var(--bg-app, #ffffff)',
              color: T.textSoft,
              cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* body — rendered markdown; highlight injected into the DOM post-render */}
        <div className="od-doc-md-scroll" style={{ padding: '18px 22px' }}>
          {st.loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.textMuted, fontSize: 13, padding: 20 }}>
              <Loader2 size={16} className="od-spin" />
              Đang tải tài liệu…
            </div>
          ) : st.error ? (
            <div style={{ color: T.red, fontSize: 13, padding: 20 }}>{st.error}</div>
          ) : (
            <div
              ref={bodyRef}
              className="od-doc-md"
              style={full ? { maxWidth: 1000, margin: '0 auto' } : undefined}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StageCard({ stage, index, projectId }: { stage: SpecStage; index: number; projectId?: string }) {
  const e = emo(stage.emotion);
  const pains = (stage.pain_points ?? []).map(painText).filter(Boolean);
  const score = typeof stage.emotion_score === 'number' ? stage.emotion_score : e.score;
  const sources = (stage.sources ?? []).filter((s) => (s.quote ?? '').trim());
  const sc = stageColor(stage.stage_type);
  const actions = stage.user_actions ?? [];
  const responses = stage.system_responses ?? [];
  const touchpoints = stage.touchpoints ?? [];
  const thoughts = stage.thoughts ?? [];
  const [openSource, setOpenSource] = useState<SpecSource | null>(null);
  return (
    <li
      style={{
        listStyle: 'none',
        border: `1px solid ${T.border}`,
        borderLeft: `4px solid ${sc}`,
        borderRadius: T.radius,
        background: T.panel,
        boxShadow: T.shadow,
        overflow: 'hidden',
      }}
    >
      {/* Header bar — number, name + type, emotion pill */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '13px 16px',
          background: T.subtle,
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        <Tip
          block
          label={`Bước ${index} trong hành trình`}
          style={{
            flexShrink: 0,
            width: 32,
            height: 32,
            borderRadius: 999,
            background: sc,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {index}
        </Tip>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, color: T.text, lineHeight: 1.3 }}>{stage.name ?? stage.id}</div>
          <Tip
            label={`Loại bước: ${stage.stage_type ?? '—'} — phân loại hành động (ví dụ: action, decision, confirmation, error…)`}
            style={{
              ...S.badge,
              display: 'inline-block',
              marginTop: 4,
              background: 'transparent',
              border: `1px solid ${sc}`,
              color: sc,
            }}
          >
            {stage.stage_type ?? '—'}
          </Tip>
        </div>
        <Tip
          block
          label={`Cảm xúc dự đoán của người dùng ở bước này: ${e.label} (${score}/5)`}
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: T.panel,
            border: `1px solid ${T.border}`,
            borderRadius: 999,
            padding: '4px 12px 4px 9px',
          }}
        >
          <EmotionFace emotion={stage.emotion} size={20} />
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{e.label}</span>
            <span style={{ fontSize: 10.5, color: T.textMuted }}>{score}/5</span>
          </span>
        </Tip>
      </div>

      {/* Body — each sub-part as its own labeled section */}
      <div style={{ padding: '2px 16px 16px' }}>
        {stage.goal ? (
          <Tip
            block
            label="Mục tiêu người dùng muốn đạt được ở bước này."
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              background: T.accentTint,
              border: `1px solid ${T.accentSoft}`,
              borderRadius: T.radiusSm,
              padding: '10px 12px',
            }}
          >
            <Target size={16} color={T.accent} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontSize: 13.5, color: T.text, fontWeight: 500, lineHeight: 1.45 }}>{stage.goal}</span>
          </Tip>
        ) : null}

        {actions.length ? (
          <StageSection
            icon={<User size={15} />}
            title="Người dùng thao tác"
            hint="Những thao tác người dùng chủ động thực hiện ở bước này."
          >
            <BulletList items={actions} marker="•" markerColor={T.accent} />
          </StageSection>
        ) : null}

        {responses.length ? (
          <StageSection
            icon={<Cog size={15} />}
            title="Hệ thống phản hồi"
            hint="Cách hệ thống xử lý và phản hồi lại sau thao tác của người dùng."
          >
            <BulletList items={responses} marker="▸" markerColor={T.blue} italic />
          </StageSection>
        ) : null}

        {touchpoints.length ? (
          <StageSection
            icon={<MapPin size={15} />}
            title="Điểm chạm"
            hint="Màn hình / điểm tiếp xúc mà người dùng tương tác ở bước này."
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {touchpoints.map((tp) => (
                <span
                  key={tp}
                  style={{
                    fontSize: 12,
                    fontFamily: T.mono,
                    padding: '3px 9px',
                    borderRadius: 6,
                    background: 'var(--blue-bg, #e0edff)',
                    color: T.blue,
                    border: `1px solid var(--blue-border, #bcd6ff)`,
                  }}
                >
                  {tp}
                </span>
              ))}
            </div>
          </StageSection>
        ) : null}

        {thoughts.length ? (
          <StageSection
            icon={<MessageSquareQuote size={15} />}
            title="Suy nghĩ của người dùng"
            hint="Suy nghĩ, kỳ vọng hoặc băn khoăn trong đầu người dùng khi ở bước này."
          >
            <blockquote
              style={{
                margin: 0,
                borderLeft: `3px solid ${T.accent}`,
                background: T.subtle,
                borderRadius: `0 ${T.radiusSm} ${T.radiusSm} 0`,
                padding: '9px 12px',
                fontSize: 13,
                fontStyle: 'italic',
                color: T.textSoft,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                lineHeight: 1.5,
              }}
            >
              {thoughts.map((th, i) => (
                <div key={i}>&ldquo;{th}&rdquo;</div>
              ))}
            </blockquote>
          </StageSection>
        ) : null}

        {pains.length ? (
          <StageSection
            icon={<TriangleAlert size={15} />}
            title={`Điểm đau (${pains.length})`}
            color={T.red}
            hint="Khó khăn, trở ngại hoặc rủi ro người dùng có thể gặp ở bước này."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pains.map((p, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 13,
                    lineHeight: 1.45,
                    borderRadius: T.radiusSm,
                    background: 'var(--red-bg, #fee2e2)',
                    border: `1px solid var(--red-border, #fecaca)`,
                    color: T.text,
                    padding: '8px 12px',
                  }}
                >
                  {p}
                </div>
              ))}
            </div>
          </StageSection>
        ) : null}

        {sources.length ? (
          <StageSection
            icon={<FileText size={15} />}
            title={`Trích từ tài liệu (${sources.length})`}
            hint="Đoạn trích từ tài liệu nghiệp vụ là căn cứ cho bước này — bấm để mở tài liệu tại đúng đoạn."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.map((s, i) => {
                // Clickable when we can open a doc: need a project + a file to load.
                const clickable = !!projectId && !!(s.file && s.file.trim());
                return (
                  <div
                    key={i}
                    className={clickable ? 'od-src-link' : undefined}
                    onClick={clickable ? () => setOpenSource(s) : undefined}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={
                      clickable
                        ? (ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') {
                              ev.preventDefault();
                              setOpenSource(s);
                            }
                          }
                        : undefined
                    }
                    title={clickable ? 'Mở tài liệu tại đúng đoạn này' : undefined}
                    style={{
                      fontSize: 13,
                      borderRadius: T.radiusSm,
                      background: T.subtle,
                      borderLeft: `3px solid ${T.accent}`,
                      color: T.text,
                      padding: '8px 12px',
                    }}
                  >
                    <div style={{ fontStyle: 'italic', lineHeight: 1.5 }}>&ldquo;{s.quote}&rdquo;</div>
                    {s.file || s.heading ? (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 11,
                          color: clickable ? T.accent : T.textMuted,
                          marginTop: 6,
                          fontFamily: T.mono,
                        }}
                      >
                        {clickable ? <ExternalLink size={12} style={{ flexShrink: 0 }} /> : null}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(s.file ?? '').split('/').pop()}
                          {s.heading ? ` · ${s.heading}` : ''}
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </StageSection>
        ) : null}
      </div>
      {openSource && projectId ? (
        <DocQuoteModal projectId={projectId} source={openSource} onClose={() => setOpenSource(null)} />
      ) : null}
    </li>
  );
}

// ── Customer Journey ─────────────────────────────────────────────────────────
function CustomerJourneyView({
  journeys,
  personas,
  projectId,
}: {
  journeys: SpecJourney[];
  personas: SpecPersona[];
  projectId?: string;
}) {
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
      <SpecStyles />
      <aside style={S.side}>
        <div style={{ padding: '4px 4px 8px' }}>
          <Tip
            block
            label="Danh sách các hành trình (luồng nghiệp vụ) của người dùng trong tính năng này."
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700, marginBottom: 8, color: T.text }}
          >
            <MapIcon size={16} color={T.accent} />
            Hành trình — {journeys.length}
          </Tip>
          <select
            style={S.select}
            value={actor}
            title="Lọc hành trình theo tác nhân (vai trò người dùng)."
            onChange={(e) => setActor(e.target.value)}
          >
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
            <Tip
              block
              label={`Tác nhân "${actorId.replace('actor-', '')}" — nhóm các hành trình do vai trò này thực hiện (${items.length}).`}
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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Users size={12} />
                {actorId.replace('actor-', '')}
              </span>
              <span style={{ marginLeft: 'auto', color: T.textMuted, fontWeight: 400 }}>{items.length}</span>
            </Tip>
            {items.map((j) => (
              <button
                key={j.id}
                type="button"
                title={`${j.title ?? j.name ?? j.id} — ${(j.stages ?? []).length} giai đoạn. Bấm để xem chi tiết hành trình này.`}
                style={S.sideItem(j.id === journey.id)}
                onClick={() => setSel(j.id)}
              >
                <div style={{ fontWeight: j.id === journey.id ? 700 : 500, color: j.id === journey.id ? T.accent : T.text, lineHeight: 1.35 }}>
                  {j.title ?? j.name ?? j.id}
                </div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>
                  {(j.stages ?? []).length} giai đoạn · <code>{j.id.replace('UFLW-', '')}</code>
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
            <Tip label="Mã định danh của hành trình (unique flow id)." style={{ fontFamily: T.mono, fontSize: 11.5 }}>
              {journey.id}
            </Tip>{' '}
            · actor=
            <Tip label="Tác nhân: vai trò người dùng thực hiện hành trình này." style={{ color: T.text }}>
              {journey.actor_id ?? '—'}
            </Tip>{' '}
            · mode=
            <Tip label="Chế độ mô tả: to_be = quy trình mong muốn (thiết kế lại); as_is = hiện trạng.">
              {journey.journey_mode ?? 'to_be'}
            </Tip>
            {journey.flow_type ? (
              <>
                {' '}·{' '}
                <Tip label="Loại luồng nghiệp vụ.">{journey.flow_type}</Tip>
              </>
            ) : null}
          </div>
          {journey.goal ? (
            <Tip
              block
              label="Mục tiêu tổng thể của cả hành trình — điều người dùng cuối cùng muốn hoàn thành."
              style={{
                display: 'flex',
                gap: 9,
                alignItems: 'flex-start',
                marginTop: 12,
                background: T.accentTint,
                border: `1px solid ${T.accentSoft}`,
                borderRadius: T.radiusSm,
                padding: '11px 14px',
              }}
            >
              <Target size={17} color={T.accent} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: 14, color: T.text, fontWeight: 500, lineHeight: 1.5 }}>{journey.goal}</span>
            </Tip>
          ) : null}
        </header>

        <EmotionCurve stages={stages} />

        <SectionHeading hint="Các bước tuần tự người dùng trải qua trong hành trình. Mỗi thẻ là một bước với thao tác, phản hồi hệ thống, cảm xúc và điểm đau.">
          Các giai đoạn ({stages.length})
        </SectionHeading>
        <ol style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {stages.map((st, i) => (
            <StageCard key={st.id ?? i} stage={st} index={i + 1} projectId={projectId} />
          ))}
        </ol>

        <PersonasBlock personas={personas} />
      </main>
    </div>
  );
}

// ── UX Spec ──────────────────────────────────────────────────────────────────
function UxSpecView({
  screens,
  personas,
  wireframes,
}: {
  screens: SpecScreen[];
  personas: SpecPersona[];
  /** Wireframe bố cục tự do per screen id (wireframes/<id>.wire.json). */
  wireframes?: Record<string, WireDoc> | null;
}) {
  const [actor, setActor] = useState<string>('all');
  const actors = useMemo(() => {
    const set = new Set<string>();
    screens.forEach((s) => actorOf(s) && set.add(actorOf(s)));
    return [...set];
  }, [screens]);
  const visible = actor === 'all' ? screens : screens.filter((s) => actorOf(s) === actor);
  const [sel, setSel] = useState<string>(screens[0]?.id ?? '');
  // Device chosen for WEB screens' wireframe (shared across screens as you page
  // through them). A mobile screen ignores this — it's always a phone.
  const [device, setDevice] = useState<DeviceKey>('desktop');
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700, marginBottom: 8, color: T.text }}>
            <LayoutTemplate size={16} color={T.accent} />
            UX Spec — {screens.length} màn
          </div>
          <select style={S.select} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="all">Tất cả ({screens.length})</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {visible.map((s) => {
          const active = s.id === screen.id;
          return (
          <button key={s.id} type="button" style={S.sideItem(active)} onClick={() => setSel(s.id)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: active ? 700 : 500, color: active ? T.accent : T.text, flex: 1 }}>{s.name ?? s.title ?? s.id}</span>
              <span style={S.badge}>{s.screen_type ?? '—'}</span>
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{actorOf(s) || '—'}</div>
          </button>
          );
        })}
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

        <div style={{ ...S.sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>Wireframe — {comps.length} thành phần</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {screen.layout === 'web' ? (
              <div
                role="tablist"
                style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: T.subtle, border: `1px solid ${T.border}` }}
              >
                {WEB_DEVICES.map((d) => {
                  const active = device === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setDevice(d)}
                      title={`${DEVICES[d].label} · ${DEVICES[d].w}px`}
                      style={{
                        border: 0,
                        cursor: 'pointer',
                        borderRadius: 6,
                        padding: '3px 10px',
                        fontSize: 11,
                        fontWeight: active ? 700 : 500,
                        background: active ? T.panel : 'transparent',
                        color: active ? T.accent : T.textMuted,
                        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : undefined,
                      }}
                    >
                      {DEVICES[d].label}
                      <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.7 }}>{DEVICES[d].w}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {wireframes?.[screen.id] ? (
              <a
                href={wiretextEditUrl(wireframes[screen.id]!)}
                target="_blank"
                rel="noreferrer"
                title="Mở wireframe này trong editor wiretext.app để chỉnh tay (data nằm trong URL, không upload)"
                style={{ fontSize: 10.5, fontWeight: 500, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '2px 8px', textDecoration: 'none' }}
              >
                Mở trong wiretext ↗
              </a>
            ) : null}
          </div>
        </div>
        {wireframes?.[screen.id] ? (
          <WireFrameView
            doc={wireframes[screen.id]!}
            platform={screen.layout}
            device={device}
            base={wireframes[screen.id]!.overlayOf ? wireframes[wireframes[screen.id]!.overlayOf!] ?? undefined : undefined}
          />
        ) : (
          <p style={{ border: `1px dashed ${T.border}`, borderRadius: 9, background: T.subtle, padding: '20px 14px', textAlign: 'center', fontSize: 12, color: T.textMuted, margin: 0 }}>
            Màn này chưa có wireframe — chạy lại bước <strong>UX Spec</strong> để agent soạn bố cục
            (<code>wireframes/{screen.id}.wire.json</code>).
          </p>
        )}

        {/* Components table — text-mockup chi tiết */}
        <div style={S.sectionTitle}>Components ({comps.length})</div>
        <div style={{ border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: 'hidden' }}>
          {comps.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 13, padding: 12 }}>(màn chưa có component)</div>
          ) : (
            comps.map((c, i) => (
              <div
                key={c.id ?? i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '10px 12px',
                  fontSize: 13.5,
                  borderTop: i ? `1px solid ${T.borderSoft}` : 'none',
                  background: T.panel,
                }}
              >
                {/* order index */}
                <span style={{ flexShrink: 0, width: 18, textAlign: 'right', fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                  {i + 1}
                </span>
                {/* glyph in a tinted square */}
                <span
                  style={{
                    flexShrink: 0,
                    width: 28,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 6,
                    background: T.accentTint,
                    color: T.accent,
                    fontFamily: T.mono,
                    fontSize: 14,
                  }}
                >
                  {glyph(c.component_type)}
                </span>
                {/* label + semantic hint */}
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.label || c.component_type || c.id}
                  </span>
                  {c.semantic_type ? (
                    <span style={{ fontSize: 12, color: T.textMuted }}>{c.semantic_type}</span>
                  ) : null}
                </span>
                {/* type + required chips */}
                <span style={{ ...S.badge, flexShrink: 0 }}>{c.component_type ?? 'text'}</span>
                {c.required ? (
                  <span style={{ ...S.badge, flexShrink: 0, background: 'var(--amber-bg, #fef3c7)', color: T.amber }}>required</span>
                ) : null}
              </div>
            ))
          )}
        </div>

        <PersonasBlock personas={personas} />
      </main>
    </div>
  );
}

// Distinct hue per persona so the cards don't read as one grey block.
const PERSONA_HUES = [210, 152, 268, 22, 334, 45, 190, 300];
const personaInitials = (name: string): string =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
const prettyKey = (k: string): string => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
// The one attribute that best captions a persona (shown under the name).
const PERSONA_CAPTION_KEYS = ['role', 'title', 'segment', 'occupation', 'market'];

function PersonaCard({ p, i }: { p: SpecPersona; i: number }) {
  const hue = PERSONA_HUES[i % PERSONA_HUES.length]!;
  const color = `hsl(${hue} 55% 45%)`;
  const captionKey = PERSONA_CAPTION_KEYS.find((k) => typeof (p as Record<string, unknown>)[k] === 'string');
  const caption = captionKey ? String((p as Record<string, unknown>)[captionKey]) : '';
  const attrs = Object.entries(p as Record<string, unknown>).filter(
    ([k]) => !['id', 'name', captionKey].includes(k),
  );
  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: T.radius,
        overflow: 'hidden',
        background: T.panel,
        minWidth: 230,
        flex: '1 1 250px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px' }}>
        <div
          style={{
            width: 38,
            height: 38,
            flexShrink: 0,
            borderRadius: '50%',
            background: color,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          {personaInitials(p.name)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.name}
          </div>
          {caption ? (
            <div style={{ fontSize: 11.5, color, fontWeight: 600, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {caption}
            </div>
          ) : null}
        </div>
      </div>
      {/* attributes */}
      {attrs.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: T.border, borderTop: `1px solid ${T.border}` }}>
          {attrs.map(([k, v], idx) => (
            <div
              key={k}
              style={{
                background: T.panel,
                padding: '8px 12px',
                // last odd cell spans both columns so the grid stays flush
                gridColumn: idx === attrs.length - 1 && attrs.length % 2 === 1 ? '1 / -1' : undefined,
              }}
            >
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.textMuted }}>
                {prettyKey(k)}
              </div>
              <div style={{ fontSize: 12, color: T.textSoft, marginTop: 2, wordBreak: 'break-word' }}>
                {Array.isArray(v) ? v.join(', ') : String(v)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PersonasBlock({ personas }: { personas: SpecPersona[] }) {
  if (!personas || personas.length === 0) return null;
  return (
    <>
      <div style={S.sectionTitle}>Personas ({personas.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {personas.map((p, i) => (
          <PersonaCard key={p.id ?? i} p={p} i={i} />
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
/** Whether the spec carries EXPLICIT navigation data (any component with a
 *  `navigates_to`). Specs authored before 2026-07-10 don't — the viewer shows
 *  a "re-run UX Spec" hint instead of guessing edges from labels. */
export function specHasExplicitNav(doc: SpecDoc): boolean {
  const screens = Array.isArray(doc.screens) ? doc.screens : [];
  return screens.some((s) =>
    (s.components ?? []).some((c) => typeof c.navigates_to === 'string' && c.navigates_to.trim().length > 0),
  );
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

  // UX spec → screen-level NAVIGATION flowchart. Each screen is ONE node;
  // edges come EXCLUSIVELY from components' explicit `navigates_to` (the
  // ux-spec skill requires it on every navigating CTA; `nav_type: 'back'`
  // renders dashed). The old label-matching heuristic guessed wrong flows
  // and was removed 2026-07-10 — a dangling/absent target draws NO edge.
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

  const screenIds = new Set(screens.map((s) => s.id));
  for (const s of screens) {
    const comps = [...(s.components ?? [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    for (const c of comps) {
      const target = typeof c.navigates_to === 'string' ? c.navigates_to.trim() : '';
      if (!target || !screenIds.has(target)) continue; // no target / dangling id → no edge, no guess
      const dashed = (c.nav_type ?? '').toLowerCase() === 'back';
      addEdge(mmId(s.id), mmId(target), mmText(c.label ?? c.component_type ?? ''), dashed);
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

export function SpecPreview({
  doc,
  wireframes,
  projectId,
}: {
  doc: SpecDoc;
  /** Wireframe bố cục tự do per screen id (wireframes/<id>.wire.json, cạnh file spec). */
  wireframes?: Record<string, WireDoc> | null;
  /** Project the spec belongs to — enables clicking a source quote to open the
   *  underlying doc, scroll to the passage, and highlight it. Omit to disable. */
  projectId?: string;
}) {
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
      <UxSpecView screens={screens} personas={personas} wireframes={wireframes} />
    ) : (
      <CustomerJourneyView journeys={journeys} personas={personas} projectId={projectId} />
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
