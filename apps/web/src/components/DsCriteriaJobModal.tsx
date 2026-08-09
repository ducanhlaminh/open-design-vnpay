import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignSystemSummary } from '../types';
import { generateDesignSystemCriteria, getDesignSystemCriteria, streamRunLog } from '../providers/registry';
import styles from './DsCriteriaJobModal.module.css';

type Criteria = Exclude<Awaited<ReturnType<typeof getDesignSystemCriteria>>, { error: string }>;
type Job = NonNullable<Criteria['job']>;

interface Props { system: DesignSystemSummary; onClose: () => void; onDone?: () => void }

function formatDuration(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function DsCriteriaJobModal({ system, onClose, onDone }: Props) {
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [stdout, setStdout] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const autoScroll = useRef(true);
  const doneRef = useRef<string | null>(null);
  const job = criteria?.job ?? null;
  const active = job?.status === 'queued' || job?.status === 'running';
  const notes = job?.notes ?? [];
  const log = useMemo(() => [...notes, stdout].filter(Boolean).join('\n'), [notes, stdout]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next = await getDesignSystemCriteria(system.id);
      if (!cancelled && !('error' in next)) setCriteria(next);
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [system.id]);

  useEffect(() => {
    if (!job?.createdAt || !active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.createdAt, active]);

  useEffect(() => {
    if (!job || !active) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const next = await getDesignSystemCriteria(system.id);
      if (cancelled) return;
      if (!('error' in next)) {
        setCriteria(next);
        if (next.job && (next.job.status === 'queued' || next.job.status === 'running')) timer = window.setTimeout(poll, 2000);
      } else timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 2000);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [system.id, job]);

  useEffect(() => {
    if (!job?.runId || !active) return;
    return streamRunLog(job.runId, (chunk) => setStdout((current) => current + chunk));
  }, [job?.runId, active]);

  useEffect(() => {
    if (!job || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    if (doneRef.current === job.id || job.status !== 'succeeded') return;
    doneRef.current = job.id;
    onDone?.();
  }, [job, onDone]);

  useEffect(() => {
    const node = logRef.current;
    if (node && autoScroll.current) node.scrollTop = node.scrollHeight;
  }, [log]);

  async function start() {
    if (starting || active) return;
    setStarting(true);
    const result = await generateDesignSystemCriteria(system.id);
    setStarting(false);
    if ('error' in result) return;
    const next = await getDesignSystemCriteria(system.id);
    if (!('error' in next)) setCriteria(next);
  }

  const existing = (criteria?.components ?? 0) > 0;
  const label = active ? 'Đang chạy…' : job ? 'Chạy lại' : 'Bắt đầu';
  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="criteria-title">
      <div className={styles.modal}>
        <header className={styles.header}>
          <div><h2 id="criteria-title">Sinh danh mục review</h2><p>{system.title}</p></div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Đóng">×</button>
        </header>
        <p className={styles.subtitle}>{existing ? `Đang có ${criteria?.components} component · cập nhật ${new Date(criteria?.meta?.generatedAt ?? '').toLocaleString('vi-VN')}` : 'Chưa có danh mục'}</p>
        {existing ? <p className={styles.warning}>Chạy lại sẽ ghi đè components.md.</p> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={active || starting} onClick={() => void start()}>{starting ? 'Đang bắt đầu…' : label}</button>
          {active ? <span>Đã chạy {formatDuration(job!.createdAt, now)}</span> : null}
        </div>
        <ol className={styles.steps}>
          {(['read-catalog', 'generate', 'validate'] as const).map((id) => {
            const step = job?.steps.find((item) => item.id === id);
            return <li key={id} className={styles.step}><span className={`${styles.dot} ${styles[`status-${step?.status ?? 'pending'}`]}`} /> <span><b>{step?.title ?? id}</b>{step?.message ? <small>{step.message}</small> : null}</span></li>;
          })}
        </ol>
        <pre ref={logRef} className={styles.log} onScroll={(e) => { const n = e.currentTarget; autoScroll.current = n.scrollHeight - n.scrollTop - n.clientHeight < 12; }}>{loading ? 'Đang tải trạng thái…' : log || 'Chưa có log.'}</pre>
        {job?.status === 'succeeded' ? <p className={styles.success}>Đã sinh {criteria?.components ?? 0} component</p> : null}
      </div>
    </div>
  );
}
