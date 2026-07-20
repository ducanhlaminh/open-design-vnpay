// Always-visible token Usage meter, mounted in the workspace chrome so it is
// reachable from every view. Shows two rolling buckets — the current daemon
// session and the trailing 7 days — as a compact "session / week" chip that
// expands into a popover with input/output split bars.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TokenUsageBucket, TokenUsageResponse } from '@open-design/contracts';
import { Icon } from './Icon';

const POLL_MS = 8000;

/** Compact token count: 1234 → "1.2K", 1_234_567 → "1.23M". */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function formatFull(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n || 0));
}

const EMPTY: TokenUsageBucket = { inputTokens: 0, outputTokens: 0, totalTokens: 0, runs: 0 };

export function TokenUsageMeter() {
  const [usage, setUsage] = useState<TokenUsageResponse | null>(null);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch('/api/usage/tokens');
        if (res.ok) {
          const data = (await res.json()) as TokenUsageResponse;
          if (!cancelled) setUsage(data);
        }
      } catch {
        /* transient — keep the last value */
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Refresh faster while the popover is open so the numbers feel live.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/usage/tokens');
        if (res.ok && !cancelled) setUsage((await res.json()) as TokenUsageResponse);
      } catch {
        /* ignore */
      }
    };
    const id = window.setInterval(tick, 2500);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open]);

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

  const session = usage?.session ?? EMPTY;
  const week = usage?.week ?? EMPTY;

  const toggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`token-usage-chip${open ? ' is-active' : ''}`}
        onClick={toggle}
        title="Token đã dùng — Phiên / Tuần (7 ngày)"
        aria-label="Token usage"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="sliders" size={14} />
        <span className="token-usage-chip__nums">
          <span className="token-usage-chip__session">{formatTokens(session.totalTokens)}</span>
          <span className="token-usage-chip__sep">/</span>
          <span className="token-usage-chip__week">{formatTokens(week.totalTokens)}</span>
        </span>
      </button>
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popRef}
              className="token-usage-popover"
              role="dialog"
              aria-label="Token usage"
              style={{ top: anchor.top, right: anchor.right }}
            >
              <div className="token-usage-popover__head">
                <Icon name="sliders" size={15} />
                <span>Token đã dùng</span>
              </div>
              <UsageBucketRow label="Phiên hiện tại" bucket={session} />
              <UsageBucketRow label="7 ngày qua" bucket={week} />
              <div className="token-usage-popover__foot">
                <span className="token-usage-dot token-usage-dot--in" /> Nhập
                <span className="token-usage-dot token-usage-dot--out" /> Xuất
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function UsageBucketRow({ label, bucket }: { label: string; bucket: TokenUsageBucket }) {
  const total = bucket.totalTokens || 1;
  const inPct = (bucket.inputTokens / total) * 100;
  const outPct = (bucket.outputTokens / total) * 100;
  return (
    <div className="token-usage-bucket">
      <div className="token-usage-bucket__top">
        <span className="token-usage-bucket__label">{label}</span>
        <span className="token-usage-bucket__total" title={`${formatFull(bucket.totalTokens)} tokens`}>
          {formatTokens(bucket.totalTokens)}
        </span>
      </div>
      <div className="token-usage-bar" aria-hidden="true">
        <span className="token-usage-bar__in" style={{ width: `${inPct}%` }} />
        <span className="token-usage-bar__out" style={{ width: `${outPct}%` }} />
      </div>
      <div className="token-usage-bucket__meta">
        <span>Nhập {formatTokens(bucket.inputTokens)}</span>
        <span>Xuất {formatTokens(bucket.outputTokens)}</span>
        <span>{bucket.runs} run</span>
      </div>
    </div>
  );
}
