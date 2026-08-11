import { useCallback, useEffect, useState } from 'react';
import type { CodexUsageResponse, CodexUsageWindow } from '@open-design/contracts';
import { Icon } from './Icon';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; usage: CodexUsageResponse; at: number }
  | { phase: 'error' };

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

export function CodexUsagePanel(): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/usage/codex', signal ? { signal } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const usage = await res.json() as CodexUsageResponse;
      if (!signal?.aborted) setState({ phase: 'ready', usage, at: Date.now() });
    } catch {
      if (!signal?.aborted) setState({ phase: 'error' });
    }
  }, []);
  useEffect(() => { const ctrl = new AbortController(); void load(ctrl.signal); return () => ctrl.abort(); }, [load]);

  return <div className="claude-usage-section" data-testid="codex-usage-panel">
    <div className="claude-usage-section__head"><Icon name="sliders" size={14} /><span>Mức dùng tài khoản Codex</span>
      {state.phase === 'ready' && state.usage.planType ? <span className="claude-usage-plan">{state.usage.planType}</span> : null}
    </div>
    {state.phase === 'loading' ? <p className="claude-usage-section__note">Đang đọc mức dùng…</p> : null}
    {state.phase === 'ready' && state.usage.available ? <>
      <CodexWindow window={state.usage.primary} now={state.at} />
      {state.usage.secondary ? <CodexWindow window={state.usage.secondary} now={state.at} /> : null}
      <p className="claude-usage-section__foot">% hạn mức Codex đã dùng — đọc một lần khi mở Local CLI.</p>
    </> : null}
    {state.phase === 'error' || (state.phase === 'ready' && !state.usage.available) ? <>
      <p className="claude-usage-section__note">Chưa đọc được mức dùng Codex. Kiểm tra lại Docker và trạng thái đăng nhập.</p>
      <button type="button" className="claude-usage-section__retry" onClick={() => void load()}>Thử lại</button>
    </> : null}
  </div>;
}

function CodexWindow({ window, now }: { window: CodexUsageWindow; now: number }) {
  const pct = window.utilization ?? 0;
  const severity = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : window.utilization === null ? 'na' : 'ok';
  return <div className="claude-usage-win"><div className="claude-usage-win__top"><span className="claude-usage-win__label">{label(window)}</span><span className={`claude-usage-win__pct claude-usage-win__pct--${severity}`}>{window.utilization === null ? '—' : `${Math.round(pct)}%`}</span></div><div className="claude-usage-bar" aria-hidden="true"><span className={`claude-usage-bar__fill claude-usage-bar__fill--${severity}`} style={{ width: `${pct}%` }} /></div>{resetIn(window.resetsAt, now) ? <div className="claude-usage-win__reset">{resetIn(window.resetsAt, now)}</div> : null}</div>;
}
