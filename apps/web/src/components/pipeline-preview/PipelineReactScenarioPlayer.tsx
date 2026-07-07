// Scenario player for the docs → React workflow — runs agent-authored
// use-case scripts (`react/scenarios.json`) against the FULL built app
// (`dist/index.html`, real HashRouter) in one persistent iframe.
//
// Division of labor (deliberate): the AGENT authors every selector, sample
// value, route and step order at pipeline time — it wrote the DOM and knows
// the domain. This player is a dumb interpreter with ZERO heuristics: it
// navigates to a step's route, types the scripted fills, spotlights the
// scripted action selector, and advances by OBSERVING the app's own
// hashchange (the app navigates itself — no click interception, no per-screen
// standalone pages, no remount/replay machinery). Projects built before the
// scenarios contract fall back to the legacy PipelineReactSimulator.
import { useEffect, useMemo, useRef, useState } from 'react';

import { projectFileUrl } from '../../providers/registry';
import styles from './PipelineReactScenarioPlayer.module.css';

export interface ScenarioFill {
  selector: string;
  value: string;
}

export interface ScenarioStep {
  /** Contract route (`/<slug>`) this step happens on. */
  route: string;
  /** CSS selector of the control the user activates (prefer [data-flow-action='…']). */
  action?: string;
  /** Human label for the fallback button bar. */
  label?: string;
  fills?: ScenarioFill[];
  /** Route the app lands on after the action. Omitted for in-screen actions (dialogs). */
  expect?: string;
}

export interface Scenario {
  id?: string;
  name: string;
  steps: ScenarioStep[];
}

/** Validate agent-authored scenarios.json. null → caller falls back to the legacy simulator. */
export function parseScenarios(raw: unknown): Scenario[] | null {
  if (!Array.isArray(raw)) return null;
  const scenarios: Scenario[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof (s as Scenario).name === 'string' ? (s as Scenario).name : '';
    const steps = Array.isArray((s as Scenario).steps)
      ? ((s as Scenario).steps as unknown[]).filter(
          (st): st is ScenarioStep =>
            Boolean(st) && typeof (st as ScenarioStep).route === 'string',
        )
      : [];
    if (name && steps.length > 0) {
      scenarios.push({ id: (s as Scenario).id, name, steps });
    }
  }
  return scenarios.length > 0 ? scenarios : null;
}

const HOTSPOT_CLASS = 'od-sim-hotspot';
const HOTSPOT_STYLE_ID = 'od-sim-hotspot-style';
const HOTSPOT_CSS = `
.${HOTSPOT_CLASS} {
  outline: 3px solid #2563eb !important;
  outline-offset: 2px;
  border-radius: 8px;
  cursor: pointer;
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

const normalizeRoute = (r: string): string => {
  // Compare by pathname only — apps navigate with query/search params
  // (`/payment?method=wallet`) that the scripted routes don't carry.
  const t = r.trim().replace(/^#/, '').split('?')[0]!;
  if (!t || t === '/') return '/';
  return (t.startsWith('/') ? t : `/${t}`).replace(/\/+$/, '');
};

/** Type through the native setter so React-controlled inputs see the value. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  const proto =
    el instanceof win.HTMLTextAreaElement
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Apply the step's scripted fills. Only empty controls — user input wins. */
function applyFills(doc: Document, fills: ScenarioFill[] | undefined): void {
  for (const f of fills ?? []) {
    let el: Element | null = null;
    try {
      el = doc.querySelector(f.selector);
    } catch {
      continue; // agent-authored selector is invalid CSS — skip, never crash
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (!el.value && !el.disabled && !el.readOnly) setNativeValue(el, f.value);
    } else if (el instanceof HTMLSelectElement) {
      if (!el.value) {
        el.value = f.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (el instanceof HTMLElement && el.getAttribute('aria-checked') === 'false') {
      el.click();
    }
  }
}

interface Props {
  projectId: string;
  /** Project-relative path of the built app, e.g. `docs-to-react/react/dist/index.html`. */
  indexName: string;
  scenarios: Scenario[];
  /** slug → display title, for the device header (optional). */
  titles?: Map<string, string>;
  onExit?: () => void;
}

export function PipelineReactScenarioPlayer({ projectId, indexName, scenarios, titles, onExit }: Props) {
  const [scnIdx, setScnIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [spot, setSpot] = useState<'found' | 'missing' | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const actionElRef = useRef<HTMLElement | null>(null);

  const scenario = scenarios[Math.min(scnIdx, scenarios.length - 1)] ?? null;
  const step = scenario?.steps[stepIdx] ?? null;
  const isLast = scenario ? stepIdx >= scenario.steps.length - 1 : true;
  // One persistent iframe for the whole session — routing is driven through
  // the app's own hash, never by remounting.
  const src = useMemo(() => projectFileUrl(projectId, indexName), [projectId, indexName]);

  const readRoute = (): string | null => {
    try {
      const hash = iframeRef.current?.contentWindow?.location.hash ?? '';
      return normalizeRoute(hash || '/');
    } catch {
      return null;
    }
  };
  const gotoRoute = (route: string) => {
    try {
      const win = iframeRef.current?.contentWindow;
      if (win) win.location.hash = normalizeRoute(route);
    } catch {
      /* frame not ready yet — the step effect retries */
    }
  };

  useEffect(() => {
    setStepIdx(0);
    setAutoplay(false);
  }, [scnIdx]);

  // Per-step driver: bring the app to the step's route, type the fills,
  // spotlight the action, then wait for the app to navigate itself.
  useEffect(() => {
    setSpot(null);
    actionElRef.current = null;
    const frame = iframeRef.current;
    if (!frame || !scenario || !step) return undefined;
    const stepRoute = normalizeRoute(step.route);
    const expectRoute = step.expect ? normalizeRoute(step.expect) : null;
    let disposed = false;
    let clearSpot: (() => void) | null = null;
    let hashWin: Window | null = null;
    let clickDoc: Document | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // The app navigating to the expected route IS the step completing —
    // whether via the spotlighted control, a sibling row, or the user
    // exploring. Off-script routes re-sync the stepper instead of fighting it.
    const onHash = () => {
      const r = readRoute();
      if (!r) return;
      if (expectRoute && r === expectRoute) {
        setStepIdx((i) => i + 1);
        return;
      }
      if (r !== stepRoute) {
        const k = scenario.steps.findIndex((s) => normalizeRoute(s.route) === r);
        if (k >= 0) setStepIdx(k);
      }
    };
    // In-screen steps (no `expect`, e.g. open dialog): a real click on the
    // scripted action advances after a beat — the app handles the click
    // itself (nothing is intercepted, ever).
    const onClick = (ev: MouseEvent) => {
      if (!step.action || expectRoute) return;
      const t = ev.target;
      if (t instanceof Element) {
        try {
          if (t.closest(step.action)) {
            timers.push(setTimeout(() => setStepIdx((i) => i + 1), 300));
          }
        } catch {
          /* invalid selector — fallback bar still advances */
        }
      }
    };

    // Spotlight scan — extracted so BOTH the initial retry loop and the
    // MutationObserver below can re-run it. The player never gives up on a
    // step: a control that mounts late (conditional render, dialog content,
    // async section) gets spotlighted the moment the DOM produces it. Until
    // then the hint says "chưa tìm thấy" — the app itself keeps working
    // either way (advance is hashchange-driven, nothing is intercepted).
    let observer: MutationObserver | null = null;
    let rescanPending = false;
    const scanSpot = (doc: Document): boolean => {
      if (disposed || !step.action || actionElRef.current?.isConnected) return true;
      if (!doc.getElementById(HOTSPOT_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = HOTSPOT_STYLE_ID;
        style.textContent = HOTSPOT_CSS;
        doc.head?.appendChild(style);
      }
      let el: Element | null = null;
      try {
        el = doc.querySelector(step.action);
      } catch {
        el = null;
      }
      if (!(el instanceof HTMLElement)) return false;
      if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.disabled) {
        el.disabled = false;
      }
      el.classList.add(HOTSPOT_CLASS);
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        /* non-fatal */
      }
      actionElRef.current = el;
      clearSpot = () => el.classList.remove(HOTSPOT_CLASS);
      setSpot('found');
      return true;
    };
    const watchDom = (doc: Document) => {
      if (observer || !doc.body) return;
      observer = new MutationObserver(() => {
        if (rescanPending || disposed) return;
        rescanPending = true;
        timers.push(
          setTimeout(() => {
            rescanPending = false;
            if (disposed) return;
            applyFills(doc, step.fills);
            if (scanSpot(doc)) {
              observer?.disconnect();
              observer = null;
            }
          }, 180),
        );
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    };

    const drive = (attempt: number) => {
      if (disposed) return;
      try {
        const win = frame.contentWindow;
        const doc = frame.contentDocument;
        if (win && doc && doc.readyState !== 'loading') {
          if (hashWin !== win) {
            hashWin?.removeEventListener('hashchange', onHash);
            win.addEventListener('hashchange', onHash);
            hashWin = win;
          }
          if (clickDoc !== doc) {
            clickDoc?.removeEventListener('click', onClick, true);
            doc.addEventListener('click', onClick, true);
            clickDoc = doc;
          }
          const r = readRoute();
          if (r !== stepRoute) {
            if (attempt === 0) gotoRoute(stepRoute);
            // fall through to retry — the app needs a beat to render the route
          } else {
            applyFills(doc, step.fills);
            if (!step.action) {
              setSpot(null);
              return; // terminal/observe-only step
            }
            if (scanSpot(doc)) return;
            // Not in the DOM yet — keep watching mutations instead of dying.
            watchDom(doc);
          }
        }
      } catch {
        /* frame teardown race — retry below */
      }
      if (attempt < 6) timers.push(setTimeout(() => drive(attempt + 1), 350 * (attempt < 2 ? 1 : 2)));
      else setSpot((s) => (s === 'found' ? s : 'missing'));
    };
    const onLoad = () => drive(0);
    frame.addEventListener('load', onLoad);
    drive(0);
    return () => {
      disposed = true;
      actionElRef.current = null;
      for (const t of timers) clearTimeout(t);
      frame.removeEventListener('load', onLoad);
      hashWin?.removeEventListener('hashchange', onHash);
      clickDoc?.removeEventListener('click', onClick, true);
      observer?.disconnect();
      clearSpot?.();
    };
  }, [scenario, step, stepIdx]);

  // Advance exactly the way a user would: click the scripted control; without
  // one, drive the route directly.
  const performAction = () => {
    if (!step) return;
    const el = actionElRef.current;
    if (el && el.isConnected) {
      el.click();
      if (!step.expect) return; // click handler advances dialog steps
      return; // hashchange advances navigation steps
    }
    if (step.expect) {
      gotoRoute(step.expect);
      return;
    }
    setStepIdx((i) => i + 1);
  };

  // Refs so the autoplay interval always drives the CURRENT step.
  const stepIdxRef = useRef(stepIdx);
  stepIdxRef.current = stepIdx;
  const performActionRef = useRef(performAction);
  performActionRef.current = performAction;

  useEffect(() => {
    if (!autoplay || !scenario) return undefined;
    const t = setInterval(() => {
      if (stepIdxRef.current >= scenario.steps.length - 1) {
        setAutoplay(false);
        return;
      }
      performActionRef.current();
    }, 2600);
    return () => clearInterval(t);
  }, [autoplay, scenario]);

  if (!scenario || !step) {
    return <div className={styles.msg}>scenarios.json không có kịch bản hợp lệ.</div>;
  }

  const slug = normalizeRoute(step.route).replace(/^\//, '');
  const screenTitle = titles?.get(slug) ?? (slug || '/');

  return (
    <div className={styles.root}>
      <div className={styles.topbar}>
        <select
          className={styles.caseSelect}
          value={scnIdx}
          onChange={(ev) => setScnIdx(Number(ev.target.value))}
          title="Chọn use case (kịch bản do agent sinh trong scenarios.json)"
        >
          {scenarios.map((s, i) => (
            <option key={s.id ?? i} value={i}>
              UC{i + 1}. {s.name}
            </option>
          ))}
        </select>
        <div className={styles.stepper}>
          {scenario.steps.map((s, i) => (
            <button
              key={`${s.route}-${i}`}
              type="button"
              className={i === stepIdx ? styles.stepDotActive : styles.stepDot}
              onClick={() => setStepIdx(i)}
              title={`${i + 1}. ${s.route}${s.label ? ` — ${s.label}` : ''}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={autoplay ? styles.playBtnActive : styles.playBtn}
          onClick={() => setAutoplay((v) => !v)}
          title="Tự động chạy qua các bước"
        >
          {autoplay ? '⏸ Dừng' : '▶ Tự chạy'}
        </button>
        {onExit ? (
          <button type="button" className={styles.playBtn} onClick={onExit} title="Quay về canvas toàn màn hình">
            🗺 Canvas
          </button>
        ) : null}
      </div>

      <div className={styles.stage}>
        <div className={styles.device}>
          <div className={styles.deviceHeader} title={screenTitle}>
            <span className={styles.deviceStep}>
              {stepIdx + 1}/{scenario.steps.length}
            </span>
            {screenTitle}
          </div>
          <iframe ref={iframeRef} src={src} title={scenario.name} className={styles.iframe} />
        </div>
      </div>

      {!isLast || step.action ? (
        <div className={styles.hint}>
          {spot === 'found'
            ? step.expect
              ? '👆 Bấm vào vùng sáng nhấp nháy — app sẽ tự điều hướng sang màn tiếp theo'
              : '👆 Bấm vào vùng sáng — thao tác diễn ra ngay trong màn hình này'
            : spot === 'missing'
              ? `Chưa định vị được “${step.label ?? step.action ?? ''}” — bạn vẫn thao tác trực tiếp trên màn hình được, hoặc dùng nút bên dưới`
              : 'Đang chuẩn bị màn hình…'}
        </div>
      ) : null}

      <div className={styles.actionbar}>
        <button
          type="button"
          className={styles.navBtn}
          disabled={stepIdx === 0}
          onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
        >
          ← Quay lại
        </button>
        {!isLast || step.action ? (
          <button type="button" className={styles.actionBtn} onClick={performAction} title={step.expect ?? step.route}>
            {step.label ?? 'Tiếp tục'} →
          </button>
        ) : (
          <span className={styles.done}>✓ Hết luồng</span>
        )}
      </div>
    </div>
  );
}
