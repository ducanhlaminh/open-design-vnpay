// Claude account status, rendered inside the Local CLI dropdown. Trimmed to
// exactly what the user asked for: login state (+ email when known) and the
// rolling 5h/7d quota bars. The header text restating the agent name, the
// plan-tier badge, and the footer sentence that used to sit around this were
// judged redundant and dropped — the % + bar + reset per window is the only
// "quota" content that survives.
//
// Quota fetches ONCE per mount, and the dropdown only mounts it while open,
// so the quota is read when the user actually asks to see it. It
// deliberately does NOT poll: the previous always-visible header chip polled
// every 60s from every open tab, and that traffic is what pushed the
// upstream usage endpoint into HTTP 429 — which surfaced as a permanently
// blank meter, since a rate-limited first read leaves nothing to display.

import { useCallback, useEffect, useState } from 'react';
import type { ClaudeUsageResponse, ClaudeUsageWindow } from '@open-design/contracts';
import type { AgentInfo } from '../types';
import { AgentAuthLine } from './AgentAuthLine';

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

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; usage: ClaudeUsageResponse; at: number }
  | { phase: 'error' };

interface Props {
  agent?: AgentInfo | null;
  /** Bubbled straight to AgentAuthLine — see its onAuthChanged doc. */
  onAuthChanged?: () => void;
}

export function ClaudeUsagePanel({ agent, onAuthChanged }: Props): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/usage/claude', signal ? { signal } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const usage = (await res.json()) as ClaudeUsageResponse;
      if (signal?.aborted) return;
      setState({ phase: 'ready', usage, at: Date.now() });
    } catch {
      if (signal?.aborted) return;
      setState({ phase: 'error' });
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return (
    <div className="claude-usage-section">
      <AgentAuthLine agentId="claude" agent={agent} onAuthChanged={onAuthChanged} />

      {state.phase === 'loading' ? (
        <p className="claude-usage-section__note">Đang đọc mức dùng…</p>
      ) : null}

      {state.phase === 'ready' && state.usage.available ? (
        <>
          <UsageWindowRow label="5 giờ" window={state.usage.fiveHour} now={state.at} />
          <UsageWindowRow label="7 ngày" window={state.usage.sevenDay} now={state.at} />
        </>
      ) : null}

      {/* `available: false` covers both "no login" and a refused read (the usage
          endpoint rate-limits aggressively). Say so plainly and offer a retry —
          the old chip simply vanished, which was indistinguishable from being
          signed out and left no way to ask again. */}
      {state.phase === 'error' || (state.phase === 'ready' && !state.usage.available) ? (
        <>
          <p className="claude-usage-section__note">
            Chưa đọc được mức dùng. Nếu bạn vừa đăng nhập hoặc vừa mở lại nhiều lần, máy chủ có
            thể đang tạm chặn — thử lại sau một lát.
          </p>
          <button type="button" className="claude-usage-section__retry" onClick={() => void load()}>
            Thử lại
          </button>
        </>
      ) : null}
    </div>
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
        <span className={`claude-usage-win__pct claude-usage-win__pct--${lvl}`}>
          {pctLabel(w.utilization)}
        </span>
      </div>
      <div className="claude-usage-bar" aria-hidden="true">
        <span
          className={`claude-usage-bar__fill claude-usage-bar__fill--${lvl}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {reset ? <div className="claude-usage-win__reset">{reset}</div> : null}
    </div>
  );
}
