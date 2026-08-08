'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppPoolResponse } from '@open-design/contracts';

import { Icon } from '../Icon';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { fetchProjectFileText } from '../../providers/registry';
import { ProgressBar } from './ProgressBar';
import { branchSummaries, needsDistill } from './DistillModal';
import type { BranchSummary } from './DistillModal';
import styles from './AppDistillSection.module.css';

interface LogEntry { id: number; text: string; }
interface Preview { path: string; title: string; html: string | null; loading: boolean; error: string | null; }

const poolUrl = (appId: string) => `/api/pipelines/apps/${encodeURIComponent(appId)}/pool`;
const distillUrl = (appId: string) => `/api/pipelines/apps/${encodeURIComponent(appId)}/distill`;
const time = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function pageClean(page: AppPoolResponse['pages'][number]): boolean {
  return page.distill.state === 'distilled' && page.distill.distilledHash === page.contentHash;
}

function overviewStatus(pool: AppPoolResponse, branches: BranchSummary[]): string {
  if (pool.distill.progress?.error && !pool.distill.running) return 'Lỗi';
  if (pool.overviewExists && branches.length > 0 && branches.every((branch) => branch.status === 'clean')) return 'Xong';
  return pool.distill.running ? 'Đang chưng cất' : 'Chờ';
}

export function AppDistillSection({ appId }: { appId: string }): JSX.Element {
  const [pool, setPool] = useState<AppPoolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previousPool = useRef<AppPoolResponse | null>(null);
  const logId = useRef(0);

  const addLog = useCallback((text: string) => {
    setLogs((current) => [...current, { id: logId.current++, text: `${time()} · ${text}` }].slice(-200));
  }, []);

  const loadPool = useCallback(async () => {
    const response = await fetch(poolUrl(appId));
    if (!response.ok) throw new Error(`Không thể tải tài liệu App (${response.status}).`);
    return (await response.json()) as AppPoolResponse;
  }, [appId]);

  const applyPool = useCallback((next: AppPoolResponse) => {
    const previous = previousPool.current;
    const branches = branchSummaries(next.pages);
    if (!previous && next.distill.running) addLog('Đang theo dõi job chưng cất đang chạy…');
    if (!previous && next.distill.progress?.error && !next.distill.running) {
      addLog(`Kết thúc — lỗi: ${next.distill.progress.error}`);
    }
    if (previous) {
      if (!previous.distill.running && next.distill.running) addLog(`Bắt đầu chưng cất — ${branches.length} nhánh`);
      const oldBranches = new Map(branchSummaries(previous.pages).map((branch) => [branch.name, branch]));
      for (const branch of branches) {
        const old = oldBranches.get(branch.name);
        const started = branch.pages.some((page) => page.distill.state === 'distilling') && !old?.pages.some((page) => page.distill.state === 'distilling');
        if (started) addLog(`Nhánh ${branch.name}: bắt đầu (${branch.pages.length} trang)`);
        if (branch.pages.every(pageClean) && !old?.pages.every(pageClean)) addLog(`Nhánh ${branch.name}: xong ✓`);
        if (old?.pages.some((page) => page.distill.state === 'distilling') && branch.pages.some((page) => page.distill.state === 'fetched' || page.distill.state === 'stale')) {
          addLog(`Nhánh ${branch.name}: thất bại — revert`);
        }
      }
      if (!previous.overviewExists && next.overviewExists) addLog('_overview.md: đã tạo ✓');
      if (previous.distill.running && !next.distill.running) {
        addLog(next.distill.progress?.error ? `Kết thúc — lỗi: ${next.distill.progress.error}` : 'Hoàn tất — pool sạch');
      }
    }
    previousPool.current = next;
    setPool(next);
  }, [addLog]);

  const poll = useCallback(async () => {
    try {
      applyPool(await loadPool());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải tài liệu App.');
    }
  }, [applyPool, loadPool]);

  useEffect(() => {
    setPool(null);
    setError(null);
    setHasRun(false);
    setLogs([]);
    previousPool.current = null;
    void poll();
  }, [appId, poll]);

  // Dep là CẢ object `pool` (mỗi lần poll set object mới) chứ không phải
  // boolean `running` — boolean giữ nguyên true giữa các tick thì effect
  // không chạy lại và chuỗi setTimeout đứt sau đúng một lần poll.
  useEffect(() => {
    if (!pool?.distill.running) return undefined;
    const timer = window.setTimeout(() => void poll(), 1500);
    return () => window.clearTimeout(timer);
  }, [pool, poll]);

  const startDistill = async () => {
    setHasRun(true);
    try {
      const response = await fetch(distillUrl(appId), { method: 'POST' });
      if (!response.ok && response.status !== 409) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Không thể chưng cất tài liệu (${response.status}).`);
      }
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể chưng cất tài liệu.');
    }
  };

  const branches = useMemo(() => branchSummaries(pool?.pages ?? []), [pool?.pages]);
  const running = pool?.distill.running ?? false;
  const pending = pool?.distill.pending ?? 0;
  const progress = pool?.distill.progress;
  const shouldShowPanel = Boolean(pool && (running || hasRun || progress?.error));
  const status = pool ? overviewStatus(pool, branches) : null;

  const openPreview = async (path: string, title: string) => {
    setPreview({ path, title, html: null, loading: true, error: null });
    try {
      const text = await fetchProjectFileText(appId, `docs/${path}`);
      if (text === null) throw new Error(`Không đọc được ${path}.`);
      setPreview({ path, title, html: renderMarkdownToSafeHtml(text), loading: false, error: null });
    } catch (cause) {
      setPreview({ path, title, html: null, loading: false, error: cause instanceof Error ? cause.message : `Không đọc được ${path}.` });
    }
  };

  if (!pool && !error) return <section className={styles.section}><p className={styles.muted}>Đang tải tài liệu…</p></section>;
  if (error && !pool) return <section className={styles.section}><p className={styles.error}>{error}</p><button type="button" className={styles.secondaryButton} onClick={() => void poll()}>Thử lại</button></section>;
  if (!pool) return <section className={styles.section} />;

  const totalPercent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const ready = !running && !needsDistill(pool);
  const overviewButton = pool.overviewExists ? <button type="button" className={styles.fileButton} onClick={() => void openPreview('_overview.md', '_overview.md')}><Icon name="file" size={13} />_overview.md</button> : null;

  return (
    <section className={styles.section} aria-label="Tài liệu chưng cất">
      <div className={styles.summary}>
        <span>{pool.pages.length} trang · {branches.length} nhánh</span>
        <span className={`${styles.statusBadge} ${styles[`status${status === 'Xong' ? 'Clean' : status === 'Lỗi' ? 'Error' : running ? 'Running' : 'Pending'}`]}`}>{status === 'Xong' ? 'Đã chưng cất đủ' : status === 'Lỗi' ? 'Lỗi' : running ? 'Đang chưng cất' : `Còn ${pending} trang`}</span>
      </div>

      {needsDistill(pool) && !running ? (
        <div className={styles.hero}>
          <Icon name="sparkles" size={26} />
          <p>{pending > 0 ? `Còn ${pending} trang chưa chưng cất` : 'Thiếu bản tổng hợp _overview.md'}</p>
          <button type="button" className={styles.heroButton} onClick={() => void startDistill()}>Chưng cất tài liệu</button>
        </div>
      ) : null}

      {shouldShowPanel ? (
        <div className={styles.fanout}>
          {progress ? <ProgressBar label={`Đang chưng cất… ${progress.done}/${progress.total} phần`} percent={totalPercent} /> : null}
          {branches.map((branch) => <div className={styles.branchRow} key={branch.name}><span><strong>{branch.name}</strong><small>{branch.pages.length} trang</small></span><span className={`${styles.branchBadge} ${styles[`branch${branch.status}`]}`}>{branch.status === 'clean' ? 'Đã chưng cất' : branch.status === 'running' ? 'Đang chưng cất' : running ? 'Chờ' : 'Lỗi'}</span></div>)}
          <div className={styles.branchRow}><span><strong>Tổng hợp _overview.md</strong></span><span className={styles.branchBadge}>{pool.overviewExists ? 'Xong' : status}</span></div>
          {progress?.error ? <div className={styles.errorBanner} role="alert"><span>{progress.error}</span>{!running && needsDistill(pool) ? <button type="button" className={styles.secondaryButton} onClick={() => void startDistill()}>Thử lại</button> : null}</div> : null}
        </div>
      ) : null}

      {logs.length > 0 ? <div className={styles.log} aria-label="Log tiến trình">{logs.map((entry) => <div key={entry.id}>{entry.text}</div>)}</div> : null}

      {ready || pool.overviewExists ? (
        <div className={styles.files}><h3>Bản chưng cất</h3>{overviewButton}{branches.filter((branch) => branch.status === 'clean').map((branch) => <button type="button" className={styles.fileButton} key={branch.name} onClick={() => void openPreview(`_branches/${branch.name}.md`, `_branches/${branch.name}.md`)}><Icon name="file" size={13} />_branches/{branch.name}.md</button>)}</div>
      ) : null}
      {preview ? <div className={styles.preview}><div className={styles.previewHead}><strong>{preview.title}</strong><button type="button" className={styles.closeButton} onClick={() => setPreview(null)} aria-label="Đóng preview">×</button></div><div className={styles.previewScroll}>{preview.loading ? <p className={styles.muted}>Đang tải…</p> : null}{preview.error ? <p className={styles.error}>{preview.error}</p> : null}{preview.html ? <div className={`${styles.previewBody} markdown-rendered`} dangerouslySetInnerHTML={{ __html: preview.html }} /> : null}</div></div> : null}
    </section>
  );
}
