import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FigmaDesignSystemRefreshChanges, RefreshFigmaDesignSystemSourceResponse } from '@open-design/contracts';

import { useI18n } from '../i18n';
import {
  createFigmaDesignSystem,
  deleteFigmaDesignSystem,
  fetchActiveGuideJobs,
  fetchFigmaDesignSystem,
  fetchFigmaDesignSystems,
  refreshFigmaDesignSystem,
  updateFigmaDesignSystem,
  type FigmaDesignSystemSource,
  type FigmaGuideActiveJob,
} from '../providers/figma-design-systems';
import { navigate } from '../router';
import { Icon } from './Icon';
import { normalizeFigmaLinks } from './pipelines/EditAppModal';
import {
  FigmaLinksPanel,
  figmaLinksVerificationKey,
  type FigmaLinksVerificationState,
} from './pipelines/FigmaLinksPanel';
import {
  FormError,
  FormField,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './pipelines/PipelineFormModal';
import styles from './FigmaDesignSystemsSection.module.css';

function sourceLinksText(source: FigmaDesignSystemSource | null): string {
  return source?.links.join('\n') ?? '';
}

function formatUpdatedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function FigmaDesignSystemsSection() {
  const { locale, t } = useI18n();
  const [sources, setSources] = useState<FigmaDesignSystemSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FigmaDesignSystemSource | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [linksText, setLinksText] = useState('');
  const [verification, setVerification] = useState<FigmaLinksVerificationState>({ status: 'idle', linksKey: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formProgress, setFormProgress] = useState<FigmaDesignSystemSource['refreshProgress']>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshResults, setRefreshResults] = useState<Record<string, FigmaDesignSystemRefreshChanges>>({});
  // WP23b (contract mục 5/6) — badge "Đang sinh mô tả x/y (z%)" trên card khi
  // nguồn đó có job sinh mô tả active. Mount: fetch 1 lần; poll 5s CHỈ khi có
  // job active nào đó, dừng khi hết (khuôn useAppImportJob).
  const [activeGuideJobs, setActiveGuideJobs] = useState<FigmaGuideActiveJob[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSources(await fetchFigmaDesignSystems());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('ds.figmaLinksLoadError'));
    } finally {
      setLoading(false);
    }
    // `t` is intentionally captured from the initial locale. Some test and
    // host providers return a new translator function per render; including
    // it here would make the load effect refire after every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const poll = async (): Promise<boolean> => {
      const jobs = await fetchActiveGuideJobs();
      if (!alive) return false;
      setActiveGuideJobs(jobs);
      const stillActive = jobs.some((job) => job.status === 'queued' || job.status === 'running');
      if (!stillActive) stopPoll();
      return stillActive;
    };
    void poll().then((stillActive) => {
      if (!alive || !stillActive) return;
      timer = setInterval(() => { void poll(); }, 5_000);
    });
    return () => {
      alive = false;
      stopPoll();
    };
  }, []);

  const activeGuideJobBySource = useMemo(() => {
    const map = new Map<string, FigmaGuideActiveJob>();
    for (const job of activeGuideJobs) {
      if (job.status === 'queued' || job.status === 'running') map.set(job.sourceId, job);
    }
    return map;
  }, [activeGuideJobs]);

  const normalized = useMemo(() => normalizeFigmaLinks(linksText), [linksText]);
  const linksKey = figmaLinksVerificationKey(normalized.links);
  const verified = verification.status === 'verified' && verification.linksKey === linksKey;
  const canSave = Boolean(name.trim()) && !normalized.error && verified && !saving;

  function openCreate() {
    setEditing(null);
    setName('');
    setLinksText('');
    setFormError(null);
    setFormProgress(null);
    setVerification({ status: 'idle', linksKey: '' });
  }

  function openEdit(source: FigmaDesignSystemSource) {
    setEditing(source);
    setName(source.name);
    setLinksText(sourceLinksText(source));
    setFormError(null);
    setFormProgress(null);
    setVerification({ status: 'idle', linksKey: '' });
  }

  function closeModal() {
    if (!saving) setEditing(undefined);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = { name: name.trim(), links: normalized.links.map((link) => link.url) };
      const source = editing
        ? await updateFigmaDesignSystem(editing.id, payload)
        : await createFigmaDesignSystem(payload);
      setSources((current) => [source, ...current.filter((item) => item.id !== source.id)]);
      const refreshResult = await refreshWithProgress(source, (latest) => {
        setFormProgress(latest.refreshProgress);
        setSources((current) => current.map((item) => item.id === latest.id ? latest : item));
      });
      setSources((current) => {
        const next = current.filter((item) => item.id !== refreshResult.source.id);
        return [refreshResult.source, ...next];
      });
      setRefreshResults((current) => ({ ...current, [source.id]: refreshResult.changes }));
      setEditing(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('ds.figmaLinksSaveError'));
    } finally {
      setSaving(false);
    }
  }

  async function refresh(source: FigmaDesignSystemSource) {
    if (busyId) return;
    setBusyId(source.id);
    setRefreshResults((current) => {
      const next = { ...current };
      delete next[source.id];
      return next;
    });
    setSources((current) => current.map((item) => item.id === source.id ? { ...item, status: 'refreshing' } : item));
    try {
      const refreshResult = await refreshWithProgress(source, (latest) => {
        setSources((current) => current.map((item) => item.id === source.id ? latest : item));
      });
      setSources((current) => current.map((item) => item.id === source.id ? refreshResult.source : item));
      setRefreshResults((current) => ({ ...current, [source.id]: refreshResult.changes }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('ds.figmaLinksRefreshError');
      setSources((current) => current.map((item) => item.id === source.id
        ? { ...item, status: 'error', lastError: message }
        : item));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(source: FigmaDesignSystemSource) {
    if (!window.confirm(t('ds.figmaLinksDeleteConfirm', { name: source.name }))) return;
    setBusyId(source.id);
    try {
      await deleteFigmaDesignSystem(source.id);
      setSources((current) => current.filter((item) => item.id !== source.id));
      setRefreshResults((current) => {
        const next = { ...current };
        delete next[source.id];
        return next;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('ds.figmaLinksDeleteError'));
    } finally {
      setBusyId(null);
    }
  }

  const statusLabel = (source: FigmaDesignSystemSource): string => {
    if (source.status === 'ready') return t('ds.figmaLinksStatusReady');
    if (source.status === 'refreshing') {
      const progress = source.refreshProgress;
      return progress
        ? t('ds.figmaLinksStatusRefreshingProgress', { completed: progress.completedFiles, total: progress.totalFiles })
        : t('ds.figmaLinksStatusRefreshing');
    }
    if (source.status === 'error') return t('ds.figmaLinksStatusError');
    return t('ds.figmaLinksStatusEmpty');
  };

  async function refreshWithProgress(
    source: FigmaDesignSystemSource,
    onProgress: (latest: FigmaDesignSystemSource) => void,
  ): Promise<RefreshFigmaDesignSystemSourceResponse> {
    let finished = false;
    const request = refreshFigmaDesignSystem(source.id).finally(() => { finished = true; });
    const poll = async () => {
      while (!finished) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (finished) break;
        try {
          onProgress(await fetchFigmaDesignSystem(source.id));
        } catch {
          // The refresh request owns the final error. A transient progress
          // poll must not replace that clearer result.
        }
      }
    };
    const polling = poll();
    try {
      return await request;
    } finally {
      await polling;
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.intro}>
        <div className={styles.introCopy}>
          <strong>{t('ds.figmaLinksTitle')}</strong>
          <span>{t('ds.figmaLinksDescription')}</span>
        </div>
        <button type="button" className={styles.primaryButton} onClick={openCreate}>
          <Icon name="link" size={14} />
          {t('ds.figmaLinksAddAction')}
        </button>
      </div>

      {loadError ? <div className={styles.loadError} role="alert">{loadError}</div> : null}
      {loading ? <div className={styles.empty}>{t('common.loading')}</div> : null}
      {!loading && sources.length === 0 ? <div className={styles.empty}>{t('ds.figmaLinksEmpty')}</div> : null}
      {sources.length > 0 ? (
        <div className={styles.grid}>
          {sources.map((source) => {
            const busy = busyId === source.id || source.status === 'refreshing';
            const refreshResult = refreshResults[source.id];
            const activeGuideJob = activeGuideJobBySource.get(source.id);
            const activeGuidePercent = activeGuideJob && activeGuideJob.total > 0
              ? Math.round((activeGuideJob.done / activeGuideJob.total) * 100)
              : 0;
            const statusClass = source.status === 'ready'
              ? `${styles.status} ${styles.statusReady}`
              : source.status === 'error'
                ? `${styles.status} ${styles.statusError}`
                : styles.status;
            return (
              <article className={styles.card} key={source.id}>
                <div className={styles.cardHead}>
                  <h3 className={styles.cardTitle}>{source.name}</h3>
                  <span className={statusClass}>
                    {busy ? <Icon name="spinner" size={12} /> : null}
                    {statusLabel(source)}
                  </span>
                </div>
                <div>
                  <div className={styles.metricRow}>
                    <div className={styles.metric}>
                      <strong>{source.catalog?.fileCount ?? source.links.length}</strong>
                      <span>{t('ds.figmaLinksFiles')}</span>
                    </div>
                    <div className={styles.metric}>
                      <strong>{source.catalog?.componentCount ?? 0}</strong>
                      <span>{t('ds.figmaLinksComponents')}</span>
                    </div>
                  </div>
                  {activeGuideJob ? (
                    <p className={styles.guideJobBadge} data-testid={`figma-design-systems-guide-badge-${source.id}`}>
                      {`Đang sinh mô tả ${activeGuideJob.done}/${activeGuideJob.total} (${activeGuidePercent}%)`}
                    </p>
                  ) : null}
                  <p className={styles.updated}>{t('ds.figmaLinksUpdatedAt', { date: formatUpdatedAt(source.catalog?.generatedAt ?? source.updatedAt, locale) })}</p>
                  {source.status === 'refreshing' ? (
                    <progress
                      className={styles.progress}
                      max={source.refreshProgress?.totalFiles ?? 1}
                      value={source.refreshProgress?.completedFiles ?? undefined}
                      aria-label={statusLabel(source)}
                    />
                  ) : null}
                  {source.lastError ? <p className={styles.error} role="alert">{source.lastError}</p> : null}
                  {refreshResult ? (
                    <div className={styles.refreshResult} role="status">
                      <strong>{t('ds.figmaLinksRefreshCompleted')}</strong>
                      <span>
                        {t('ds.figmaLinksRefreshSummary', {
                          added: refreshResult.addedComponents,
                          removed: refreshResult.removedComponents,
                          changed: refreshResult.changedComponents,
                        })}
                      </span>
                      <small>{t('ds.figmaLinksRefreshTotal', { count: refreshResult.currentComponentCount })}</small>
                    </div>
                  ) : null}
                </div>
                <div className={styles.cardActions}>
                  {/* WP21b — trang detail (/design-systems/figma/:id) là nơi
                      chính của mọi thao tác trên nguồn này (component
                      browser + sinh mô tả); card ở đây chỉ điều hướng sang. */}
                  <button
                    type="button"
                    className={styles.detailButton}
                    onClick={() => navigate({ kind: 'figma-ds-detail', sourceId: source.id })}
                  >
                    <Icon name="external-link" size={13} />
                    Mở trang Design system →
                  </button>
                  <div className={styles.cardActionsRow}>
                    <button type="button" className={styles.secondaryButton} disabled={busyId !== null} onClick={() => void refresh(source)}>
                      <Icon name="refresh" size={13} />
                      {busy ? t('ds.figmaLinksRefreshRunning') : t('ds.figmaLinksRefreshAction')}
                    </button>
                    <button type="button" className={styles.secondaryButton} disabled={busyId !== null} onClick={() => openEdit(source)}>
                      <Icon name="edit" size={13} />
                      {t('common.edit')}
                    </button>
                    <button type="button" className={styles.iconButton} disabled={busyId !== null} aria-label={t('ds.figmaLinksDeleteAria', { name: source.name })} onClick={() => void remove(source)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {editing !== undefined ? (
        <PipelineFormModal
          title={editing ? t('ds.figmaLinksEditTitle') : t('ds.figmaLinksCreateTitle')}
          icon="link"
          busy={saving}
          wide
          onClose={closeModal}
          footer={(
            <>
              <QuietButton onClick={closeModal} disabled={saving}>{t('common.cancel')}</QuietButton>
              <PrimaryButton onClick={() => void save()} disabled={!canSave} busy={saving}>
                {editing ? t('common.save') : t('ds.figmaLinksCreateAction')}
              </PrimaryButton>
            </>
          )}
        >
          <div className={styles.form}>
            <FormField label={t('ds.figmaLinksNameLabel')} hint={t('ds.figmaLinksNameHint')}>
              {(props) => <TextInput {...props} autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />}
            </FormField>
            <FormField label={t('ds.figmaLinksLinksLabel')} hint={t('ds.figmaLinksLinksHint')} error={normalized.error ?? undefined}>
              {(props) => (
                <textarea
                  {...props}
                  className={styles.linksInput}
                  rows={5}
                  value={linksText}
                  onChange={(event) => setLinksText(event.target.value)}
                  placeholder="https://www.figma.com/design/…"
                />
              )}
            </FormField>
            <FigmaLinksPanel links={normalized.links} linksError={normalized.error} onVerificationChange={setVerification} />
            {saving ? (
              <div className={styles.formProgress} role="status">
                <span>{formProgress
                  ? t('ds.figmaLinksStatusRefreshingProgress', { completed: formProgress.completedFiles, total: formProgress.totalFiles })
                  : t('ds.figmaLinksStatusRefreshing')}</span>
                <progress
                  className={styles.progress}
                  max={formProgress?.totalFiles ?? 1}
                  value={formProgress?.completedFiles ?? undefined}
                />
              </div>
            ) : null}
            {formError ? <FormError>{formError}</FormError> : null}
          </div>
        </PipelineFormModal>
      ) : null}
    </div>
  );
}
