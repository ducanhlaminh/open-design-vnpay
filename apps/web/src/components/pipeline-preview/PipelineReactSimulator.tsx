// Use-case simulator for the docs → React workflow — the third react-app
// preview mode next to the full-app iframe and the all-screens canvas.
//
// Use cases are derived from the agent-authored `react/flow.json`: every
// simple root→leaf path through the navigation graph is one scenario. The
// simulator shows one screen at a time in a device-sized frame and SPOTLIGHTS
// the control that performs the next action (pulsing outline) — display only.
// It never drives the page: no programmatic clicks, no force-enabling, no
// auto-replay. The user steps the walkthrough with the Back/Next bar (and can
// interact with the live screen freely — e.g. open its dialog by hand).

import { useEffect, useMemo, useRef, useState } from 'react';

import { projectFileUrl } from '../../providers/registry';
import styles from './PipelineReactSimulator.module.css';

export interface SimScreenEntry {
  /** Full project-relative path: `<dir>/<slug>.html`. */
  name: string;
  slug: string;
  title: string;
}

export interface SimFlowEdge {
  from: string;
  to: string;
  label?: string;
  /** 'navigate' (default) | 'dialog' | 'dismiss' — see the ui-react skill. */
  type?: string;
}

interface UseCaseStep {
  slug: string;
  /** Label of the edge that leads INTO this step (undefined for the root). */
  viaLabel?: string;
  /** True when the edge into this step happens INSIDE the same screen (dialog open / dismiss). */
  inPlace?: boolean;
}

interface UseCasePath {
  id: string;
  title: string;
  steps: UseCaseStep[];
}

const MAX_PATHS = 16;
const MAX_DEPTH = 14;

const isInPlaceEdge = (e: SimFlowEdge) => e.type === 'dialog' || e.type === 'dismiss' || e.type === 'alert';

// ── In-screen action spotlight (display-only) ────────────────────────────────
// The screen iframes are same-origin (served through the daemon proxy), so the
// simulator can reach in and OUTLINE the element whose text matches the next
// flow edge's label. That is all it does — clicks stay with the user.

const HOTSPOT_CLASS = 'od-sim-hotspot';
const HOTSPOT_STYLE_ID = 'od-sim-hotspot-style';
const HOTSPOT_CSS = `
.${HOTSPOT_CLASS} {
  outline: 3px solid #2563eb !important;
  outline-offset: 2px;
  border-radius: 8px;
  position: relative;
  z-index: 9999;
  animation: od-sim-pulse 1.4s ease-out infinite;
}
@keyframes od-sim-pulse {
  0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.45); }
  70% { box-shadow: 0 0 0 14px rgba(37, 99, 235, 0); }
  100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
}
`;

const normalizeText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Best clickable element whose visible text matches the action label.
 * Prefers the skill's deterministic `data-flow-action="<label>"` contract;
 * falls back to STRICT text matching for legacy builds — a false positive
 * (highlighting a card-sized wrapper) is worse than no highlight at all.
 */
function findActionElement(doc: Document, label: string): HTMLElement | null {
  const want = normalizeText(label);
  if (!want) return null;
  for (const el of doc.querySelectorAll<HTMLElement>('[data-flow-action]')) {
    if (normalizeText(el.getAttribute('data-flow-action') ?? '') === want) return el;
  }
  const vw = doc.defaultView?.innerWidth ?? 0;
  const vh = doc.defaultView?.innerHeight ?? 0;
  const candidates = doc.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], input[type="submit"], input[type="button"]',
  );
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (vh > 0 && rect.height > vh * 0.5) continue;
    if (vw > 0 && vh > 0 && rect.width > vw * 0.9 && rect.height > vh * 0.35) continue;
    const text = normalizeText(el.innerText || el.getAttribute('aria-label') || '');
    if (!text || text.length > 80) continue;
    let score = 0;
    if (text === want) score = 3;
    else if (want.length >= 4 && text.includes(want)) score = 2;
    else if (text.length >= 6 && want.includes(text)) score = 1;
    if (score > bestScore) {
      best = el;
      bestScore = score;
      if (score === 3) break;
    }
  }
  return best;
}

/** Spotlight the matched element. Display only — returns cleanup, or null when no match. */
function highlightAction(doc: Document, label: string): (() => void) | null {
  if (!doc.getElementById(HOTSPOT_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = HOTSPOT_STYLE_ID;
    style.textContent = HOTSPOT_CSS;
    doc.head?.appendChild(style);
  }
  const el = findActionElement(doc, label);
  if (!el) return null;
  el.classList.add(HOTSPOT_CLASS);
  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    /* older engines: non-fatal */
  }
  return () => el.classList.remove(HOTSPOT_CLASS);
}

/**
 * Every simple root→leaf path through flow.json = one use case. Navigation
 * edges consume their target screen (no revisits); in-place edges (dialog /
 * dismiss) stay on the same screen and are deduped per-edge instead.
 */
function deriveUseCases(entries: SimScreenEntry[], flow: SimFlowEdge[]): UseCasePath[] {
  const slugs = new Set(entries.map((e) => e.slug));
  const titleOf = new Map(entries.map((e) => [e.slug, e.title]));
  const edgeId = (e: SimFlowEdge) => `${e.from}|${e.to}|${e.label ?? ''}|${e.type ?? ''}`;
  const seenEdges = new Set<string>();
  const edges = flow.filter((e) => {
    if (!slugs.has(e.from) || !slugs.has(e.to)) return false;
    if (e.from === e.to && !isInPlaceEdge(e)) return false;
    const id = edgeId(e);
    if (seenEdges.has(id)) return false;
    seenEdges.add(id);
    return true;
  });
  if (edges.length === 0) return [];
  const outgoing = new Map<string, SimFlowEdge[]>();
  for (const e of edges) {
    const arr = outgoing.get(e.from) ?? [];
    arr.push(e);
    outgoing.set(e.from, arr);
  }
  const navTargets = new Set(edges.filter((e) => !isInPlaceEdge(e)).map((e) => e.to));
  const roots = [...new Set(edges.map((e) => e.from))].filter((s) => !navTargets.has(s));
  const startPoints = roots.length > 0 ? roots : [edges[0]!.from];

  const paths: UseCasePath[] = [];
  const walk = (steps: UseCaseStep[], visited: Set<string>, usedEdges: Set<string>) => {
    if (paths.length >= MAX_PATHS) return;
    const here = steps[steps.length - 1]!.slug;
    const next = (outgoing.get(here) ?? []).filter((e) =>
      isInPlaceEdge(e) && e.to === e.from ? !usedEdges.has(edgeId(e)) : !visited.has(e.to),
    );
    if (next.length === 0 || steps.length >= MAX_DEPTH) {
      if (steps.length > 1) {
        const first = titleOf.get(steps[0]!.slug) ?? steps[0]!.slug;
        const last = titleOf.get(here) ?? here;
        paths.push({
          id: steps.map((s) => `${s.slug}${s.inPlace ? '*' : ''}`).join('>'),
          title: `${first} → ${last} (${steps.length} bước)`,
          steps,
        });
      }
      return;
    }
    for (const e of next) {
      // An in-place edge KEEPS the screen only when to === from; a dismiss
      // whose `to` is another slug moves screens like a navigation edge.
      const stays = isInPlaceEdge(e) && e.to === e.from;
      walk(
        [...steps, { slug: stays ? here : e.to, viaLabel: e.label, inPlace: stays }],
        stays ? visited : new Set([...visited, e.to]),
        new Set([...usedEdges, edgeId(e)]),
      );
      if (paths.length >= MAX_PATHS) return;
    }
  };
  for (const root of startPoints) {
    walk([{ slug: root }], new Set([root]), new Set());
  }
  return paths;
}

interface Props {
  projectId: string;
  entries: SimScreenEntry[];
  flow: SimFlowEdge[];
  /** slug → target platform (react/layout.json): web screens get a desktop-wide
   *  device frame instead of the phone width. */
  layouts?: Record<string, 'mobile' | 'web'>;
  /** Back to the canvas view (rendered as a button in the topbar). */
  onExit?: () => void;
}

// Web screens preview at three breakpoints (the built app is real responsive
// HTML — changing the frame width changes the viewport). Mobile-app screens
// keep the single phone width from the CSS.
const WEB_DEVICE_WIDTHS = { desktop: 1280, tablet: 834, mobile: 390 } as const;
type WebDevice = keyof typeof WEB_DEVICE_WIDTHS;

export function PipelineReactSimulator({ projectId, entries, flow, layouts, onExit }: Props) {
  const useCases = useMemo(() => deriveUseCases(entries, flow), [entries, flow]);
  const [pathIdx, setPathIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  // Viewport for WEB screens (Desktop/Tablet/Mobile tabs in the topbar).
  const [device, setDevice] = useState<WebDevice>('desktop');
  // 'found' → the action element is spotlighted in-screen; 'missing' → no match.
  const [hotspot, setHotspot] = useState<'found' | 'missing' | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Bumped on backward/non-linear jumps to remount the iframe back to the
  // screen's base state (the user may have opened dialogs by hand).
  const [resetKey, setResetKey] = useState(0);

  const path = useCases[Math.min(pathIdx, useCases.length - 1)] ?? null;
  const byName = useMemo(() => new Map(entries.map((e) => [e.slug, e])), [entries]);
  const step = path?.steps[stepIdx] ?? null;
  const entry = step ? byName.get(step.slug) ?? null : null;
  const nextStep = path?.steps[stepIdx + 1] ?? null;

  const goToStep = (i: number, current: number) => {
    if (i !== current + 1) setResetKey((k) => k + 1);
    setStepIdx(i);
  };

  // Switching use case restarts it from the first screen.
  useEffect(() => {
    setStepIdx(0);
    setResetKey((k) => k + 1);
  }, [pathIdx]);

  // Spotlight the NEXT action once the screen's React app has painted. The
  // app renders asynchronously after iframe `load`, so retry on a short
  // backoff instead of probing once. Display only — no listeners installed.
  useEffect(() => {
    setHotspot(null);
    const frame = iframeRef.current;
    const label = nextStep?.viaLabel;
    if (nextStep && !label) {
      setHotspot('missing');
      return undefined;
    }
    if (!frame || !label) return undefined;
    let cleanup: (() => void) | null = null;
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tryAttach = (attempt: number) => {
      if (disposed || cleanup) return;
      try {
        const doc = frame.contentDocument;
        if (doc && doc.readyState !== 'loading') {
          cleanup = highlightAction(doc, label);
          if (cleanup) {
            setHotspot('found');
            return;
          }
        }
      } catch {
        /* cross-origin or teardown race — treated as no match below */
      }
      if (attempt < 4) timers.push(setTimeout(() => tryAttach(attempt + 1), 400 * (attempt + 1)));
      else setHotspot('missing');
    };
    const onLoad = () => tryAttach(0);
    frame.addEventListener('load', onLoad);
    // The iframe may already be loaded (in-place step on the same screen).
    tryAttach(0);
    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      frame.removeEventListener('load', onLoad);
      cleanup?.();
    };
  }, [entry?.name, resetKey, stepIdx, nextStep?.slug, nextStep?.viaLabel]);

  if (useCases.length === 0 || !path || !entry) {
    return (
      <div className={styles.msg}>
        Không dựng được kịch bản mô phỏng — thiếu hoặc rỗng <code>react/flow.json</code>.
        Chạy lại bước “UI-Spec (React)” để agent sinh luồng điều hướng.
        {onExit ? (
          <>
            {' '}
            <button type="button" className={styles.playBtn} onClick={onExit}>
              ← Về canvas
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.topbar}>
        <select
          className={styles.caseSelect}
          value={pathIdx}
          onChange={(ev) => setPathIdx(Number(ev.target.value))}
          title="Chọn use case (một đường đi qua luồng điều hướng)"
        >
          {useCases.map((p, i) => (
            <option key={p.id} value={i}>
              UC{i + 1}. {p.title}
            </option>
          ))}
        </select>
        <div className={styles.stepper}>
          {path.steps.map((s, i) => (
            <button
              key={`${s.slug}-${i}`}
              type="button"
              className={i === stepIdx ? styles.stepDotActive : styles.stepDot}
              onClick={() => goToStep(i, stepIdx)}
              title={`${i + 1}. ${byName.get(s.slug)?.title ?? s.slug}${s.viaLabel ? ` (qua: ${s.viaLabel})` : ''}${s.inPlace ? ' — dialog trong màn hình' : ''}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
        {entry && layouts?.[entry.slug] === 'web' ? (
          <div className={styles.deviceTabs} role="tablist" title="Kích thước khung xem (viewport) cho màn web">
            {(Object.keys(WEB_DEVICE_WIDTHS) as WebDevice[]).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={device === d}
                className={device === d ? styles.deviceTabActive : styles.deviceTab}
                onClick={() => setDevice(d)}
              >
                {d === 'desktop' ? 'Desktop' : d === 'tablet' ? 'Tablet' : 'Mobile'}
                <span className={styles.deviceTabW}>{WEB_DEVICE_WIDTHS[d]}</span>
              </button>
            ))}
          </div>
        ) : null}
        {onExit ? (
          <button type="button" className={styles.playBtn} onClick={onExit} title="Quay về canvas toàn màn hình">
            🗺 Canvas
          </button>
        ) : null}
      </div>

      <div className={styles.stage}>
        <div
          className={styles.device}
          // Web screen → frame at the chosen breakpoint (real responsive
          // viewport); mobile-app screens keep the CSS phone width.
          style={entry && layouts?.[entry.slug] === 'web' ? { width: `min(${WEB_DEVICE_WIDTHS[device]}px, 100%)` } : undefined}
        >
          <div className={styles.deviceHeader} title={entry.title}>
            <span className={styles.deviceStep}>
              {stepIdx + 1}/{path.steps.length}
            </span>
            {entry.title}
          </div>
          <iframe
            key={`${entry.name}#${resetKey}`}
            ref={iframeRef}
            src={projectFileUrl(projectId, entry.name)}
            title={entry.title}
            className={styles.iframe}
          />
        </div>
      </div>

      {nextStep ? (
        <div className={styles.hint}>
          {hotspot === 'found'
            ? `Hành động kế tiếp được tô sáng trên màn hình: “${nextStep.viaLabel ?? ''}”`
            : hotspot === 'missing'
              ? `Không tìm thấy nút “${nextStep.viaLabel ?? ''}” trên màn hình`
              : 'Đang tìm nút hành động trên màn hình…'}
        </div>
      ) : null}

      <div className={styles.actionbar}>
        <button
          type="button"
          className={styles.navBtn}
          disabled={stepIdx === 0}
          onClick={() => goToStep(Math.max(0, stepIdx - 1), stepIdx)}
        >
          ← Quay lại
        </button>
        {nextStep ? (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setStepIdx((i) => i + 1)}
            title={byName.get(nextStep.slug)?.title ?? nextStep.slug}
          >
            {nextStep.viaLabel ?? 'Tiếp tục'} →
          </button>
        ) : (
          <span className={styles.done}>✓ Hết luồng</span>
        )}
      </div>
    </div>
  );
}
