// Codex account status, rendered inside the Local CLI dropdown. Mirrors
// ClaudeUsagePanel's trim: login state (+ email when known) and the quota
// bars only — header text, plan badge, and footer sentence dropped.

import { useCallback, useEffect, useState } from 'react';
import type { CodexUsageResponse, CodexUsageWindow } from '@open-design/contracts';
import type { AgentInfo } from '../types';
import { AgentAuthLine } from './AgentAuthLine';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; usage: CodexUsageResponse; at: number }
  | { phase: 'error'; detail: string };

function label(window: CodexUsageWindow): string {
  if (window.durationMinutes === 300) return '5 giờ';
  if (window.durationMinutes === 10080) return '7 ngày';
  if (window.durationMinutes && window.durationMinutes % 1440 === 0) return `${window.durationMinutes / 1440} ngày`;
  if (window.durationMinutes && window.durationMinutes % 60 === 0) return `${window.durationMinutes / 60} giờ`;
  return 'Hạn mức';
}

function resetIn(epochSeconds: number | null, now: number): string {
  if (!epochSeconds) return '';
  const mins = Math.round((epochSeconds * 1000 - now) / 60_000);
  if (mins <= 0) return '';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  return days ? `reset sau ${days}n ${hours}h` : `reset sau ${hours}h ${mins % 60}m`;
}

interface Props {
  agent?: AgentInfo | null;
  /** Bubbled straight to AgentAuthLine — see its onAuthChanged doc. */
  onAuthChanged?: () => void;
}

export function CodexUsagePanel({ agent, onAuthChanged }: Props): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/usage/codex', signal ? { signal } : undefined);
      if (!res.ok) throw new Error(`daemon trả về HTTP ${res.status}`);
      const usage = await res.json() as CodexUsageResponse;
      if (!signal?.aborted) setState({ phase: 'ready', usage, at: Date.now() });
    } catch (err) {
      if (!signal?.aborted) setState({ phase: 'error', detail: err instanceof Error ? err.message : 'daemon không phản hồi' });
    }
  }, []);
  useEffect(() => { const ctrl = new AbortController(); void load(ctrl.signal); return () => ctrl.abort(); }, [load]);

  return <div className="claude-usage-section" data-testid="codex-usage-panel">
    <AgentAuthLine agentId="codex" agent={agent} onAuthChanged={onAuthChanged} />
    {state.phase === 'loading' ? <p className="claude-usage-section__note">Đang đọc mức dùng…</p> : null}
    {state.phase === 'ready' && state.usage.available ? <>
      <CodexWindow window={state.usage.primary} now={state.at} />
      {state.usage.secondary ? <CodexWindow window={state.usage.secondary} now={state.at} /> : null}
    </> : null}
    {/* Show the daemon's own reason (CLI missing, not logged in, app-server
        timeout, Docker…) — the old fixed "check Docker" text was wrong in host
        mode and hid the real cause from support. */}
    {state.phase === 'error' || (state.phase === 'ready' && !state.usage.available) ? <>
      <p className="claude-usage-section__note" data-testid="codex-usage-reason">
        {state.phase === 'ready' && state.usage.reason
          ? state.usage.reason
          : state.phase === 'error'
            ? `Chưa đọc được mức dùng Codex — ${state.detail}. Thử lại sau một lát.`
            : 'Chưa đọc được mức dùng Codex. Kiểm tra Codex CLI đã cài và đã đăng nhập (`codex login`).'}
      </p>
      <button type="button" className="claude-usage-section__retry" onClick={() => void load()}>Thử lại</button>
    </> : null}
  </div>;
}

function CodexWindow({ window, now }: { window: CodexUsageWindow; now: number }) {
  const pct = window.utilization ?? 0;
  const severity = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : window.utilization === null ? 'na' : 'ok';
  return <div className="claude-usage-win"><div className="claude-usage-win__top"><span className="claude-usage-win__label">{label(window)}</span><span className={`claude-usage-win__pct claude-usage-win__pct--${severity}`}>{window.utilization === null ? '—' : `${Math.round(pct)}%`}</span></div><div className="claude-usage-bar" aria-hidden="true"><span className={`claude-usage-bar__fill claude-usage-bar__fill--${severity}`} style={{ width: `${pct}%` }} /></div>{resetIn(window.resetsAt, now) ? <div className="claude-usage-win__reset">{resetIn(window.resetsAt, now)}</div> : null}</div>;
}
