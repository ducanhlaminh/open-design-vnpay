// Conflict-resolution modal for the per-project "Pull" action. Given a PullPlan
// whose `conflicts` is non-empty, the user picks Remote/Local per file (default
// Local) then Applies. Text conflicts get an inline side-by-side line diff;
// binary conflicts a size/checksum/mtime comparison. Stale (remote drifted since
// plan) and PLAN_EXPIRED are surfaced with a re-plan affordance.
//
// API logic lives in providers/pullConflict.ts; this component owns the review
// UI + its own plan/resolution/busy state (re-plan replaces the plan in place).

import { useMemo, useState } from 'react';
import type { PullApplyResult, PullConflict, PullPlan, PullResolution } from '@open-design/contracts';

import { Icon } from '../Icon';
import { PlModal } from './PlModal';
import { PlanExpiredError, pullApply, pullPlan } from '../../providers/pullConflict';
import styles from './PullConflictModal.module.css';

interface Props {
  projectId: string;
  plan: PullPlan;
  onClose: () => void;
  /** Called after a successful apply so the parent can refresh + toast. */
  onApplied: (result: PullApplyResult) => void;
}

// ── dependency-free side-by-side line diff (LCS) ─────────────────────────────
type DiffRow = { left: string | null; right: string | null; type: 'same' | 'del' | 'add' };
// Above this line count the O(n·m) LCS is skipped (memory); we fall back to a
// plain two-column dump so a huge-but-under-cap text never freezes the tab.
const LCS_LINE_CAP = 1200;

function diffLines(localText: string, remoteText: string): DiffRow[] {
  const a = localText.split('\n');
  const b = remoteText.split('\n');
  const n = a.length;
  const m = b.length;
  const rows: DiffRow[] = [];
  if (n > LCS_LINE_CAP || m > LCS_LINE_CAP) {
    const max = Math.max(n, m);
    for (let i = 0; i < max; i++) {
      rows.push({ left: i < n ? a[i]! : null, right: i < m ? b[i]! : null, type: 'same' });
    }
    return rows;
  }
  // dp[i][j] = LCS length of a[i:], b[j:]. Bounds always hold (i<n, j<m), so the
  // non-null assertions just satisfy noUncheckedIndexedAccess.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const dpi = dp[i]!;
    const dpNext = dp[i + 1]!;
    const ai = a[i]!;
    for (let j = m - 1; j >= 0; j--) {
      dpi[j] = ai === b[j]! ? dpNext[j + 1]! + 1 : Math.max(dpNext[j]!, dpi[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i]!;
    const bj = b[j]!;
    if (ai === bj) {
      rows.push({ left: ai, right: bj, type: 'same' });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ left: ai, right: null, type: 'del' });
      i++;
    } else {
      rows.push({ left: null, right: bj, type: 'add' });
      j++;
    }
  }
  while (i < n) rows.push({ left: a[i++]!, right: null, type: 'del' });
  while (j < m) rows.push({ left: null, right: b[j++]!, type: 'add' });
  return rows;
}

function shortSum(sum: string): string {
  return sum ? sum.slice(0, 12) : '—';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ConflictDiff({ conflict }: { conflict: PullConflict }) {
  const rows = useMemo(() => {
    if (conflict.kind !== 'text' || conflict.local.preview == null || conflict.remote.preview == null) {
      return null;
    }
    return diffLines(conflict.local.preview, conflict.remote.preview);
  }, [conflict]);

  if (!rows) {
    // Binary (or oversized text) — metadata-only comparison.
    return (
      <table className={styles.metaTable}>
        <thead>
          <tr>
            <th />
            <th>Local</th>
            <th>Remote</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Size</th>
            <td>{fmtBytes(conflict.local.size)}</td>
            <td>{fmtBytes(conflict.remote.size)}</td>
          </tr>
          <tr>
            <th>Checksum</th>
            <td>{shortSum(conflict.local.checksum)}</td>
            <td>{shortSum(conflict.remote.checksum)}</td>
          </tr>
          <tr>
            <th>Modified</th>
            <td>{conflict.local.mtime ? new Date(conflict.local.mtime).toLocaleString() : '—'}</td>
            <td>{conflict.remote.mtime ? new Date(conflict.remote.mtime).toLocaleString() : '—'}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  return (
    <div className={styles.diff} role="table" aria-label="side-by-side diff">
      <div className={styles.diffHead} role="row">
        <span role="columnheader">Local</span>
        <span role="columnheader">Remote</span>
      </div>
      <div className={styles.diffBody}>
        {rows.map((r, idx) => (
          <div key={idx} className={styles.diffRow} role="row">
            <pre className={`${styles.diffCell} ${r.type === 'del' ? styles.del : ''}`}>
              {r.left ?? ''}
            </pre>
            <pre className={`${styles.diffCell} ${r.type === 'add' ? styles.add : ''}`}>
              {r.right ?? ''}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PullConflictModal({ projectId, plan: initialPlan, onClose, onApplied }: Props) {
  const [plan, setPlan] = useState<PullPlan>(initialPlan);
  const [resolutions, setResolutions] = useState<Record<string, PullResolution>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<PullApplyResult['stale']>([]);
  const [expired, setExpired] = useState(false);

  const resolutionFor = (path: string): PullResolution => resolutions[path] ?? 'local';

  const setOne = (path: string, value: PullResolution) =>
    setResolutions((prev) => ({ ...prev, [path]: value }));

  const setAll = (value: PullResolution) =>
    setResolutions(Object.fromEntries(plan.conflicts.map((c) => [c.path, value])));

  const toggleExpand = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const replan = async () => {
    setBusy(true);
    setError(null);
    setStale([]);
    setExpired(false);
    try {
      const fresh = await pullPlan(projectId);
      if (fresh.conflicts.length === 0) {
        // The conflict cleared itself between plans — apply straight through.
        const result = await pullApply({
          projectId,
          planId: fresh.planId,
          resolutions: {},
          onConflictDefault: 'local',
        });
        onApplied(result);
        onClose();
        return;
      }
      setPlan(fresh);
      setResolutions({});
      setExpanded(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    setStale([]);
    setExpired(false);
    try {
      const result = await pullApply({ projectId, planId: plan.planId, resolutions, onConflictDefault: 'local' });
      onApplied(result);
      if (result.stale.length > 0) {
        setStale(result.stale);
      } else {
        onClose();
      }
    } catch (err) {
      if (err instanceof PlanExpiredError) {
        setExpired(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const remoteCount = plan.conflicts.filter((c) => resolutionFor(c.path) === 'remote').length;

  const footer = (
    <div className={styles.footer}>
      <span className={styles.warn}>
        <Icon name="info" size={14} /> Keeping Local means a later Push will overwrite Remote.
      </span>
      <div className={styles.footerActions}>
        <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="pl-btn pl-btn--primary" onClick={() => void apply()} disabled={busy}>
          <Icon name={busy ? 'spinner' : 'download'} size={14} />
          <span>{busy ? 'Applying…' : `Apply (${remoteCount} remote, ${plan.conflicts.length - remoteCount} local)`}</span>
        </button>
      </div>
    </div>
  );

  return (
    <PlModal title="Resolve pull conflicts" icon="download" size="lg" busy={busy} onClose={onClose} footer={footer}>
      <p className={styles.summary}>
        <strong>{plan.summary.new}</strong> new · <strong>{plan.summary.unchanged}</strong> unchanged ·{' '}
        <strong>{plan.summary.conflicts}</strong> conflict{plan.summary.conflicts === 1 ? '' : 's'}
      </p>

      <div className={styles.batchRow}>
        <span>Resolve all:</span>
        <button type="button" className="pl-btn pl-btn--xs" onClick={() => setAll('remote')} disabled={busy}>
          All Remote
        </button>
        <button type="button" className="pl-btn pl-btn--xs" onClick={() => setAll('local')} disabled={busy}>
          All Local
        </button>
      </div>

      <ul className={styles.list}>
        {plan.conflicts.map((c) => {
          const choice = resolutionFor(c.path);
          const isOpen = expanded.has(c.path);
          return (
            <li key={c.path} className={styles.item}>
              <div className={styles.itemHead}>
                <button
                  type="button"
                  className={styles.expandBtn}
                  onClick={() => toggleExpand(c.path)}
                  aria-expanded={isOpen}
                  title="View diff"
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                  <span className={styles.path}>{c.path}</span>
                </button>
                <span className={styles.badges}>
                  <span className={styles.stage}>{c.stage || 'misc'}</span>
                  <span className={styles.kind} data-kind={c.kind}>
                    {c.kind}
                  </span>
                </span>
                <span className={styles.toggle} role="radiogroup" aria-label={`resolution for ${c.path}`}>
                  <button
                    type="button"
                    className={`${styles.toggleBtn} ${choice === 'remote' ? styles.toggleActive : ''}`}
                    onClick={() => setOne(c.path, 'remote')}
                    aria-pressed={choice === 'remote'}
                    disabled={busy}
                  >
                    Remote
                  </button>
                  <button
                    type="button"
                    className={`${styles.toggleBtn} ${choice === 'local' ? styles.toggleActive : ''}`}
                    onClick={() => setOne(c.path, 'local')}
                    aria-pressed={choice === 'local'}
                    disabled={busy}
                  >
                    Local
                  </button>
                </span>
              </div>
              {isOpen ? (
                <div className={styles.itemDiff}>
                  <ConflictDiff conflict={c} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {stale.length > 0 ? (
        <div className={styles.notice} role="alert">
          <Icon name="info" size={15} />
          <div>
            <strong>{stale.length} file(s) skipped</strong> — remote changed since this plan:
            <ul>
              {stale.map((s) => (
                <li key={s.path}>
                  {s.path} — {s.reason}
                </li>
              ))}
            </ul>
            <button type="button" className="pl-btn pl-btn--xs" onClick={() => void replan()} disabled={busy}>
              Re-plan
            </button>
          </div>
        </div>
      ) : null}

      {expired ? (
        <div className={styles.notice} role="alert">
          <Icon name="info" size={15} />
          <div>
            This plan expired. <button type="button" className="pl-btn pl-btn--xs" onClick={() => void replan()} disabled={busy}>Re-plan</button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className={styles.error} role="alert">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}
