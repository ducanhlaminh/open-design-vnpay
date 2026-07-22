// Always-visible Claude account usage meter, mounted in the workspace chrome so
// it is reachable from every view. Shows the rolling 5-hour and 7-day
// subscription quota as percentages (the same data as Claude Code's `/usage`) —
// a compact "5h% / 7d%" chip that expands into a popover with % bars and reset
// countdowns.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClaudeUsageResponse, ClaudeUsageWindow } from '@open-design/contracts';
import { Icon } from './Icon';

const POLL_MS = 60_000;

/** Bucket a utilization % into a severity class for colouring. */
function level(pct: number | null): 'ok' | 'warn' | 'crit' | 'na' {
  if (pct === null) return 'na';
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function pctLabel(pct: number | null): string {
  return pct === null ? '—' : `${Math.round(pct)}%`;
}

/** "reset sau 2h 15m" from an ISO timestamp; empty when unknown/passed. */
function resetIn(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `reset sau ${d}n ${h}h`;
  if (h > 0) return `reset sau ${h}h ${m}m`;
  return `reset sau ${m}m`;
}

export function TokenUsageMeter() {
  const [usage, setUsage] = useState<ClaudeUsageResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch('/api/usage/claude');
        if (res.ok) {
          const data = (await res.json()) as ClaudeUsageResponse;
          if (!cancelled) {
            setUsage(data);
            setNow(Date.now());
          }
        }
      } catch {
        /* transient — keep the last value */
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
      }
    };
    // Switching Claude account (ClaudeAccountSwitcher) fires this so the meter
    // re-reads the new account's quota now instead of waiting a poll cycle.
    const refreshNow = () => {
      if (timer) window.clearTimeout(timer);
      void poll();
    };
    void poll();
    window.addEventListener('od:claude-usage-refresh', refreshNow);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('od:claude-usage-refresh', refreshNow);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      const t = ev.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Meter only renders once we know the daemon can read Claude usage. When
  // unavailable (no OAuth token / non-Claude agent) it stays hidden.
  if (!usage || !usage.available) return null;

  const five = usage.fiveHour;
  const seven = usage.sevenDay;
  const worst = Math.max(five.utilization ?? 0, seven.utilization ?? 0);

  const toggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setNow(Date.now());
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`claude-usage-chip claude-usage-chip--${level(worst)}${open ? ' is-active' : ''}`}
        onClick={toggle}
        title="Mức dùng tài khoản Claude — 5 giờ / 7 ngày"
        aria-label="Claude account usage"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="sliders" size={14} />
        <span className="claude-usage-chip__nums">
          <span className={`claude-usage-chip__v claude-usage-chip__v--${level(five.utilization)}`}>
            {pctLabel(five.utilization)}
          </span>
          <span className="claude-usage-chip__sep">/</span>
          <span className={`claude-usage-chip__v claude-usage-chip__v--${level(seven.utilization)}`}>
            {pctLabel(seven.utilization)}
          </span>
        </span>
      </button>
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popRef}
              className="claude-usage-popover"
              role="dialog"
              aria-label="Claude account usage"
              style={{ top: anchor.top, right: anchor.right }}
            >
              <div className="claude-usage-popover__head">
                <Icon name="sliders" size={15} />
                <span>Mức dùng tài khoản Claude</span>
                {usage.subscriptionType ? (
                  <span className="claude-usage-plan">{usage.subscriptionType}</span>
                ) : null}
              </div>
              <UsageWindowRow label="5 giờ" window={five} now={now} />
              <UsageWindowRow label="7 ngày" window={seven} now={now} />
              <div className="claude-usage-popover__foot">
                % hạn mức gói đã dùng — nguồn giống lệnh <code>/usage</code>.
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function UsageWindowRow({
  label,
  window: w,
  now,
}: {
  label: string;
  window: ClaudeUsageWindow;
  now: number;
}) {
  const pct = w.utilization ?? 0;
  const lvl = level(w.utilization);
  const reset = resetIn(w.resetsAt, now);
  return (
    <div className="claude-usage-win">
      <div className="claude-usage-win__top">
        <span className="claude-usage-win__label">{label}</span>
        <span className={`claude-usage-win__pct claude-usage-win__pct--${lvl}`}>{pctLabel(w.utilization)}</span>
      </div>
      <div className="claude-usage-bar" aria-hidden="true">
        <span className={`claude-usage-bar__fill claude-usage-bar__fill--${lvl}`} style={{ width: `${pct}%` }} />
      </div>
      {reset ? <div className="claude-usage-win__reset">{reset}</div> : null}
    </div>
  );
}
