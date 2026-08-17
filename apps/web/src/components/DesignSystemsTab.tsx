import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnalytics } from '../analytics/provider';
import {
  trackDesignSystemsTemplateCardClick,
  trackDesignSystemsTopClick,
  trackDesignSystemStatusResult,
  trackPageView,
} from '../analytics/events';
import type {
  TrackingDesignSystemStatusAction,
  TrackingDesignSystemStatusValue,
} from '@open-design/contracts/analytics';
import { useI18n } from '../i18n';
import {
  localizeDesignSystemCategory,
  localizeDesignSystemSummary,
} from '../i18n/content';
import {
  deleteDesignSystemDraft,
  fetchDesignSystemShowcase,
  importFigmaDesignSystem,
  updateDesignSystemDraft,
} from '../providers/registry';
import { buildSrcdoc } from '../runtime/srcdoc';
import { Icon } from './Icon';
import { DesignSystemSyncActions } from './DesignSystemSync';
import { FigmaDesignSystemsSection } from './FigmaDesignSystemsSection';
import type { DesignSystemSummary, Surface } from '../types';

interface Props {
  systems: DesignSystemSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPreview: (id: string) => void;
  // Open a react-bundle system's detail modal already expanded to the
  // viewport (card corner "Fullscreen" action; react-bundle cards only).
  onPreviewFullscreen?: (id: string) => void;
  onOpenSystem?: (id: string) => void;
  onOpenCriteria?: (id: string) => void;
  onSystemsRefresh?: () => Promise<void> | void;
}

const CATEGORY_ORDER = [
  'Starter',
  'AI & LLM',
  'Developer Tools',
  'Productivity & SaaS',
  'Backend & Data',
  'Design & Creative',
  'Fintech & Crypto',
  'E-Commerce & Retail',
  'Media & Consumer',
  'Automotive',
];

type SurfaceFilter = 'all' | Surface;
type UserListFilter = 'all' | 'published' | 'draft';
type DesignSystemCollection = 'official' | 'enterprise';
type EnterpriseSourceKind = 'figma-links' | 'react-zip';

const SURFACE_PILLS: { value: SurfaceFilter; labelKey: 'examples.modeAll' | 'ds.surfaceWeb' | 'ds.surfaceImage' | 'ds.surfaceVideo' | 'ds.surfaceAudio' }[] = [
  { value: 'all', labelKey: 'examples.modeAll' },
  { value: 'web', labelKey: 'ds.surfaceWeb' },
  { value: 'image', labelKey: 'ds.surfaceImage' },
  { value: 'video', labelKey: 'ds.surfaceVideo' },
  { value: 'audio', labelKey: 'ds.surfaceAudio' },
];

function surfaceOf(system: DesignSystemSummary): Surface {
  return system.surface ?? 'web';
}

function isUserSystem(system: DesignSystemSummary): boolean {
  return system.source === 'user' || system.isEditable === true;
}

// `system.status` is the DesignSystemSummary status string from the
// daemon; map it onto the tracking enum used by
// `design_system_status_result.status_before|status_after`. The
// summary type today only carries `'draft' | 'published'`; the wider
// tracking enum keeps room for `ready`/`failed`/`archived` once those
// land server-side. Unknown values collapse to `'unknown'`.
function mapStatusToTracking(
  status: string | null | undefined,
): TrackingDesignSystemStatusValue {
  switch (status) {
    case 'draft':
    case 'published':
      return status;
    default:
      return 'unknown';
  }
}

function formatShortDate(value: number | string | undefined): string {
  if (!value) return 'just now';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

export function DesignSystemsTab({
  systems,
  selectedId,
  onSelect,
  onPreview,
  onPreviewFullscreen,
  onOpenSystem,
  onOpenCriteria,
  onSystemsRefresh,
}: Props) {
  const { locale, t } = useI18n();
  const analytics = useAnalytics();
  const designSystemsPageViewFiredRef = useRef(false);
  useEffect(() => {
    if (designSystemsPageViewFiredRef.current) return;
    designSystemsPageViewFiredRef.current = true;
    // v2 doc: the DS list page also carries `area` / `view_type` /
    // `entry_from` so it can stitch the cross-surface DS funnel.
    // `entry_from` is `unknown` here because the tab is reached
    // through the home nav rail; a router-aware entry mapper can
    // refine this later.
    trackPageView(analytics.track, {
      page_name: 'design_systems',
      area: 'design_system_list',
      view_type: 'page',
      entry_from: 'unknown',
      available_design_system_count: systems.length,
    });
  }, [analytics.track, systems.length]);
  const searchTrackedRef = useRef(false);
  const categoryTrackedRef = useRef(false);
  const [filter, setFilter] = useState('');
  const [userFilter, setUserFilter] = useState<UserListFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<DesignSystemSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Import trực tiếp từ zip của plugin Fig Pipeline ngay trên trang này —
  // chọn file là import luôn (không form phụ); xong thì refresh danh sách.
  // Lọc theo product family: app mobile (fixed viewport) vs website
  // (responsive) — mỗi target dùng lib riêng nên danh sách cần chia được.
  const [platformFilter, setPlatformFilter] = useState<'all' | 'mobile' | 'web'>('all');
  const [platformBusyId, setPlatformBusyId] = useState<string | null>(null);
  const setSystemPlatform = async (system: DesignSystemSummary, next: 'mobile' | 'web') => {
    if (platformBusyId) return;
    setPlatformBusyId(system.id);
    // Bấm lại thẻ đang bật = gỡ thẻ (null).
    await updateDesignSystemDraft(system.id, {
      platform: system.platform === next ? null : next,
    });
    await onSystemsRefresh?.();
    setPlatformBusyId(null);
  };
  const figmaFileRef = useRef<HTMLInputElement | null>(null);
  const [figmaImporting, setFigmaImporting] = useState(false);
  const [figmaImportError, setFigmaImportError] = useState<string | null>(null);
  const [figmaImportWarnings, setFigmaImportWarnings] = useState<string[]>([]);
  const handleFigmaImportFiles = async (files: File[]) => {
    if (files.length === 0 || figmaImporting) return;
    setFigmaImporting(true);
    setFigmaImportError(null);
    setFigmaImportWarnings([]);
    const result = await importFigmaDesignSystem({ files, craftApplies: [] });
    if ('error' in result) {
      setFigmaImportError(result.error.message ?? 'Import failed.');
    } else {
      setFigmaImportWarnings(result.warnings ?? []);
      await onSystemsRefresh?.();
    }
    setFigmaImporting(false);
  };
  const [designSystemCollection, setDesignSystemCollection] = useState<DesignSystemCollection>('enterprise');
  const [enterpriseSourceKind, setEnterpriseSourceKind] = useState<EnterpriseSourceKind>('figma-links');
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>('all');
  const [category, setCategory] = useState<string>('All');
  // Cache fetched showcase HTML across re-renders so cards never re-flicker
  // when the user filters / scrolls back. null = "in flight"; undefined =
  // "not yet requested". Mirrors the pattern used by ExamplesTab.
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});

  const librarySystems = useMemo(
    () => systems.filter((system) => !isUserSystem(system)),
    [systems],
  );

  const surfaceScoped = useMemo(
    () => surfaceFilter === 'all'
      ? librarySystems
      : librarySystems.filter((s) => surfaceOf(s) === surfaceFilter),
    [librarySystems, surfaceFilter],
  );

  const userSystems = useMemo(() => {
    let editable = systems.filter(isUserSystem);
    // Tab Mobile/Web: lọc theo thẻ platform của DS (multi-target dùng lib
    // riêng cho app và web). DS chưa gắn thẻ chỉ hiện ở "All" — gắn thẻ một
    // chạm bằng nút M/W trên từng dòng.
    if (platformFilter !== 'all') {
      editable = editable.filter((system) => system.platform === platformFilter);
    }
    if (userFilter === 'all') return editable;
    return editable.filter((system) => (system.status ?? 'draft') === userFilter);
  }, [systems, userFilter, platformFilter]);

  // Total systems per surface, ignoring every active filter. Drives the
  // "this surface is now empty" fallback below — that guard must react to
  // the catalog itself, not to a transient style/search filter.
  const surfaceTotals = useMemo(() => {
    const counts: Record<SurfaceFilter, number> = { all: librarySystems.length, web: 0, image: 0, video: 0, audio: 0 };
    for (const s of librarySystems) counts[surfaceOf(s)]++;
    return counts;
  }, [librarySystems]);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const s of surfaceScoped) cats.add(s.category || 'Uncategorized');
    const ordered: string[] = [];
    for (const c of CATEGORY_ORDER) if (cats.has(c)) ordered.push(c);
    for (const c of [...cats].sort()) if (!ordered.includes(c)) ordered.push(c);
    return ['All', ...ordered];
  }, [surfaceScoped]);

  // Keep surfaceFilter and category in sync when systems changes dynamically.
  // If the currently selected surface has zero items, fall back to 'all'.
  // If the current category is no longer present in the filtered list, fall back to 'All'.
  useEffect(() => {
    if (surfaceFilter !== 'all' && surfaceTotals[surfaceFilter] === 0) {
      setSurfaceFilter('all');
      setCategory('All');
    } else if (category !== 'All' && !categories.includes(category)) {
      setCategory('All');
    }
  }, [systems, surfaceFilter, surfaceTotals, category, categories]);

  // Systems matching the active style category and search text, before the
  // surface filter is applied. Both the surface pill counts and the visible
  // grid derive from this so a surface chip always reports its own result
  // set rather than the unfiltered catalog total.
  const queryScoped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return librarySystems.filter((s) => {
      if (category !== 'All' && (s.category || 'Uncategorized') !== category) return false;
      if (!q) return true;
      const summary = localizeDesignSystemSummary(locale, s).toLowerCase();
      const categoryLabel = localizeDesignSystemCategory(
        locale,
        s.category || 'Uncategorized',
      ).toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        summary.includes(q) ||
        categoryLabel.includes(q)
      );
    });
  }, [librarySystems, filter, category, locale]);

  const surfaceCounts = useMemo(() => {
    const counts: Record<SurfaceFilter, number> = {
      all: queryScoped.length, web: 0, image: 0, video: 0, audio: 0,
    };
    for (const s of queryScoped) counts[surfaceOf(s)]++;
    return counts;
  }, [queryScoped]);

  const filtered = useMemo(
    () => surfaceFilter === 'all'
      ? queryScoped
      : queryScoped.filter((s) => surfaceOf(s) === surfaceFilter),
    [queryScoped, surfaceFilter],
  );

  // Category metadata is authored in English; keep raw values in state for
  // filtering while localizing the visible labels for the current UI locale.
  const renderCategory = (c: string) => {
    if (c === 'All') return t('ds.categoryAll');
    if (c === 'Uncategorized') return t('ds.categoryUncategorized');
    return localizeDesignSystemCategory(locale, c);
  };

  function loadThumb(id: string) {
    setThumbs((prev) => {
      if (prev[id] !== undefined) return prev;
      void fetchDesignSystemShowcase(id).then((html) => {
        setThumbs((p) => ({ ...p, [id]: html }));
      });
      return { ...prev, [id]: null };
    });
  }

  async function refreshSystems() {
    await onSystemsRefresh?.();
  }

  function openRename(system: DesignSystemSummary) {
    setActionMenuId(null);
    setRenameTarget(system);
    setRenameValue(system.title);
    setRenameError(null);
  }

  function closeRename() {
    if (renameSaving) return;
    setRenameTarget(null);
    setRenameValue('');
    setRenameError(null);
  }

  async function saveRename() {
    if (!renameTarget || renameSaving) return;
    const title = renameValue.trim();
    if (!title || title === renameTarget.title) {
      closeRename();
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const updated = await updateDesignSystemDraft(renameTarget.id, { title });
      if (!updated) {
        setRenameError('Không thể đổi tên bộ Design System. Vui lòng thử lại.');
        return;
      }
      await refreshSystems();
      setRenameTarget(null);
      setRenameValue('');
    } catch {
      setRenameError('Không thể đổi tên bộ Design System. Vui lòng thử lại.');
    } finally {
      setRenameSaving(false);
    }
  }

  async function togglePublished(system: DesignSystemSummary) {
    setBusyId(system.id);
    const startedAt = performance.now();
    const willPublish = system.status !== 'published';
    const action: TrackingDesignSystemStatusAction = willPublish
      ? 'publish'
      : 'unpublish';
    const statusBefore = mapStatusToTracking(system.status);
    const isDefaultBefore = system.id === selectedId;
    let succeeded = false;
    let errorCode: string | undefined;
    try {
      const updated = await updateDesignSystemDraft(system.id, {
        status: willPublish ? 'published' : 'draft',
      });
      succeeded = Boolean(updated);
      if (!succeeded) errorCode = 'DS_STATUS_UPDATE_RETURNED_NULL';
      await refreshSystems();
    } catch (err) {
      errorCode = err instanceof Error
        ? `DS_STATUS_UPDATE_THREW:${err.message.slice(0, 80)}`
        : 'DS_STATUS_UPDATE_THREW';
      throw err;
    } finally {
      setBusyId(null);
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action,
        result: succeeded ? 'success' : 'failed',
        design_system_id: system.id,
        status_before: statusBefore,
        status_after: succeeded
          ? willPublish
            ? 'published'
            : 'draft'
          : statusBefore,
        is_default_before: isDefaultBefore,
        is_default_after: isDefaultBefore,
        error_code: errorCode,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  }

  async function deleteSystem(system: DesignSystemSummary) {
    const ok = window.confirm(`Delete "${system.title}"? This removes the draft design system from this device.`);
    if (!ok) {
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action: 'delete',
        result: 'cancelled',
        design_system_id: system.id,
        status_before: mapStatusToTracking(system.status),
        status_after: mapStatusToTracking(system.status),
        is_default_before: system.id === selectedId,
        is_default_after: system.id === selectedId,
        duration_ms: 0,
      });
      return;
    }
    setBusyId(system.id);
    const startedAt = performance.now();
    const statusBefore = mapStatusToTracking(system.status);
    const wasDefault = system.id === selectedId;
    let succeeded = false;
    let errorCode: string | undefined;
    try {
      const deleted = await deleteDesignSystemDraft(system.id);
      succeeded = Boolean(deleted);
      if (!succeeded) errorCode = 'DS_DELETE_RETURNED_FALSE';
      if (succeeded && selectedId === system.id) {
        const fallback = systems.find((candidate) =>
          candidate.id !== system.id && isUserSystem(candidate),
        );
        if (fallback) onSelect(fallback.id);
      }
      await refreshSystems();
    } catch (err) {
      errorCode = err instanceof Error
        ? `DS_DELETE_THREW:${err.message.slice(0, 80)}`
        : 'DS_DELETE_THREW';
      throw err;
    } finally {
      setBusyId(null);
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action: 'delete',
        result: succeeded ? 'success' : 'failed',
        design_system_id: system.id,
        status_before: statusBefore,
        status_after: succeeded ? 'deleted' : statusBefore,
        is_default_before: wasDefault,
        // After a successful delete the row is gone; if it was the
        // default the consumer remapped to a fallback above, so this
        // DS is no longer the default either way.
        is_default_after: false,
        error_code: errorCode,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  }

  function handleMakeDefaultClick(system: DesignSystemSummary): void {
    const wasDefault = system.id === selectedId;
    const statusBefore = mapStatusToTracking(system.status);
    onSelect(system.id);
    trackDesignSystemStatusResult(analytics.track, {
      page_name: 'design_systems',
      area: 'design_system_status',
      action: wasDefault ? 'unset_default' : 'set_default',
      result: 'success',
      design_system_id: system.id,
      status_before: statusBefore,
      status_after: statusBefore,
      is_default_before: wasDefault,
      is_default_after: !wasDefault,
      duration_ms: 0,
    });
  }

  return (
    <div className="tab-panel design-systems-manager" data-testid="design-systems-tab">
      <div className="ds-manager-subtabs">
        <div className="subtab-pill ds-manager-collection-tabs" role="tablist" aria-label={t('ds.managerSourceLabel')}>
            <button
              type="button"
              role="tab"
              aria-selected={designSystemCollection === 'enterprise'}
              className={designSystemCollection === 'enterprise' ? 'active' : ''}
              onClick={() => setDesignSystemCollection('enterprise')}
            >
              {t('ds.managerEnterprise')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={designSystemCollection === 'official'}
              className={designSystemCollection === 'official' ? 'active' : ''}
              onClick={() => setDesignSystemCollection('official')}
            >
              {t('ds.managerOfficialPresets')}
            </button>
        </div>
      </div>

      {designSystemCollection === 'enterprise' ? (
        <section className="ds-settings-card" aria-label={t('ds.managerEnterpriseSystems')}>
        <div className="ds-settings-card__head">
          <div>
            <span className="ds-manager-eyebrow">{t('ds.managerTabSystem')}</span>
            <h2>{t('ds.managerEnterpriseSystems')}</h2>
          </div>
          {enterpriseSourceKind === 'react-zip' ? <div className="ds-tag-tabs" role="tablist" aria-label={t('ds.managerPlatformFilter')}>
            <button
              type="button"
              role="tab"
              aria-selected={platformFilter === 'all'}
              className={platformFilter === 'all' ? 'active' : ''}
              onClick={() => setPlatformFilter('all')}
            >
              {t('ds.categoryAll')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={platformFilter === 'mobile'}
              className={platformFilter === 'mobile' ? 'active' : ''}
              onClick={() => setPlatformFilter('mobile')}
            >
              Mobile
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={platformFilter === 'web'}
              className={platformFilter === 'web' ? 'active' : ''}
              onClick={() => setPlatformFilter('web')}
            >
              Web
            </button>
          </div> : null}
          {enterpriseSourceKind === 'react-zip' ? <select
            aria-label={t('ds.managerFilterAria')}
            value={userFilter}
            onChange={(event) => setUserFilter(event.target.value as UserListFilter)}
          >
            <option value="all">{t('ds.categoryAll')}</option>
            <option value="published">{t('ds.managerPublished')}</option>
            <option value="draft">{t('ds.managerDraft')}</option>
          </select> : null}
        </div>

        <div className="ds-enterprise-source-tabs" role="tablist" aria-label={t('ds.managerEnterpriseSourceLabel')}>
          <button
            type="button"
            role="tab"
            aria-selected={enterpriseSourceKind === 'figma-links'}
            className={enterpriseSourceKind === 'figma-links' ? 'active' : ''}
            onClick={() => setEnterpriseSourceKind('figma-links')}
          >
            <Icon name="link" size={15} />
            <span>
              <strong>{t('ds.managerFigmaLinksTab')}</strong>
              <small>{t('ds.managerFigmaLinksTabDescription')}</small>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={enterpriseSourceKind === 'react-zip'}
            className={enterpriseSourceKind === 'react-zip' ? 'active' : ''}
            onClick={() => setEnterpriseSourceKind('react-zip')}
          >
            <Icon name="file-code" size={15} />
            <span>
              <strong>{t('ds.managerReactZipTab')}</strong>
              <small>{t('ds.managerReactZipTabDescription')}</small>
            </span>
          </button>
        </div>

        {enterpriseSourceKind === 'figma-links' ? <FigmaDesignSystemsSection /> : (
          <div className="ds-enterprise-react-panel">
            <DesignSystemSyncActions
              systems={systems}
              onSystemsRefresh={onSystemsRefresh}
            />

            <div className="ds-manager-quick-actions ds-manager-quick-actions--react">
          {/* Đường tắt tạo DS từ Figma: chọn (các) zip plugin Fig Pipeline là
              import ngay — foundation trước, UI lib sau (đặt tên 01-/02- để cố
              định thứ tự merge). Bộ React + token compile ngay khi upload. */}
          <input
            ref={figmaFileRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void handleFigmaImportFiles(files);
            }}
          />
          <button
            type="button"
            className="ds-create-row ds-create-row--figma"
            onClick={() => figmaFileRef.current?.click()}
            disabled={figmaImporting}
          >
            <span>
              <strong>{figmaImporting ? t('ds.managerImportingFigma') : t('ds.managerImportFigma')}</strong>
              <small>{t('ds.managerImportDescription')}</small>
            </span>
            <span className="ds-create-row__action">{figmaImporting ? '…' : t('ds.managerImportAction')}</span>
          </button>
            </div>
            {figmaImportError ? (
          <div className="ds-user-empty" role="alert">
            {figmaImportError}
          </div>
            ) : null}
            {figmaImportWarnings.length > 0 ? (
          <details className="ds-user-empty">
            <summary>{t('ds.managerImportWarnings', { count: figmaImportWarnings.length })}</summary>
            <ul>
              {figmaImportWarnings.slice(0, 20).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
            ) : null}

            {userSystems.length === 0 ? (
          <div className="ds-user-empty">
            {t('ds.managerEmptySystems')}
          </div>
            ) : (
          <div className="ds-user-list">
            {userSystems.map((system) => {
              const status = system.status ?? 'draft';
              const canUseInProjects = status === 'published';
              const selected = canUseInProjects && system.id === selectedId;
              const busy = busyId === system.id;
              return (
                <div className="ds-user-row" key={system.id}>
                  <button
                    type="button"
                    className="ds-user-row__open"
                    aria-label={`Mở ${system.title}`}
                    onClick={() => onOpenSystem?.(system.id)}
                  >
                    <span className="ds-user-row__title">
                      <span>{system.title}</span>
                      {selected ? <span className="ds-card-badge">{t('ds.badgeDefault')}</span> : null}
                      {system.platform ? (
                        <span className="ds-card-badge">
                          {system.platform === 'mobile' ? 'Mobile' : 'Web'}
                        </span>
                      ) : null}
                    </span>
                    <span className="ds-user-row__meta">
                      {t('ds.managerUpdatedByYou', { date: formatShortDate(system.updatedAt) })}
                      {system.platform ? ` · ${system.platform === 'mobile' ? 'Mobile' : 'Web'}` : ''}
                    </span>
                  </button>
                  <div className="ds-user-row__actions">
                    <span className={`ds-user-row__status ${status === 'published' ? 'is-published' : ''}`}>
                      {status === 'published' ? 'Đã xuất bản' : 'Bản nháp'}
                    </span>
                    <div className="ds-type-switch" role="group" aria-label="Loại Design System">
                      <button type="button" aria-pressed={system.platform === 'mobile'} onClick={() => void setSystemPlatform(system, 'mobile')}>Mobile</button>
                      <button type="button" aria-pressed={system.platform === 'web'} onClick={() => void setSystemPlatform(system, 'web')}>Web</button>
                    </div>
                    <div className="ds-user-row__menu-wrap">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Thao tác với ${system.title}`}
                        aria-expanded={actionMenuId === system.id}
                        onClick={() => setActionMenuId((current) => current === system.id ? null : system.id)}
                        disabled={busy}
                      >
                        <Icon name="more-horizontal" />
                      </button>
                      {actionMenuId === system.id ? (
                        <div className="ds-user-row__menu" role="menu" aria-label={`Thao tác với ${system.title}`}>
                          {system.hasReactBundle && onOpenCriteria ? <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); onOpenCriteria(system.id); }}>Danh mục review</button> : null}
                          {!selected && canUseInProjects ? <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); handleMakeDefaultClick(system); }}>Đặt làm mặc định</button> : null}
                          <button type="button" role="menuitem" onClick={() => openRename(system)}>Đổi tên</button>
                          <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); void togglePublished(system); }}>
                            {status === 'published' ? 'Chuyển về bản nháp' : 'Xuất bản'}
                          </button>
                          <button type="button" role="menuitem" className="danger" onClick={() => { setActionMenuId(null); void deleteSystem(system); }}>Xóa bộ Design System</button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
            )}
          </div>
        )}
        </section>
      ) : null}

      {renameTarget ? (
        <div className="modal-backdrop" onClick={closeRename}>
          <form
            className="modal modal-rename"
            aria-label="Đổi tên bộ Design System"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void saveRename();
            }}
          >
            <h2>Đổi tên bộ Design System</h2>
            <p>Tên mới chỉ thay đổi cách hiển thị. Phiên bản Figma và các dự án đang dùng bộ này không bị ảnh hưởng.</p>
            <input
              autoFocus
              type="text"
              aria-label="Tên bộ Design System"
              value={renameValue}
              disabled={renameSaving}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            {renameError ? <p className="library-install-error" role="alert">{renameError}</p> : null}
            <div className="row">
              <button type="button" onClick={closeRename} disabled={renameSaving}>Hủy</button>
              <button
                type="submit"
                className="primary"
                disabled={renameSaving || !renameValue.trim() || renameValue.trim() === renameTarget.title}
              >
                {renameSaving ? 'Đang lưu…' : 'Lưu tên mới'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {designSystemCollection === 'official' ? (
        <section className="ds-settings-card" aria-label={t('ds.managerOfficialPresets')}>
        <div className="ds-settings-card__head">
          <div>
            <span className="ds-manager-eyebrow">{t('ds.managerLibrary')}</span>
            <h2>{t('ds.managerOfficialPresets')}</h2>
          </div>
        </div>
        <div className="tab-panel-toolbar ds-manager-toolbar">
          <input
            data-testid="design-systems-search"
            placeholder={t('ds.searchPlaceholder')}
            value={filter}
            onFocus={() => {
              if (searchTrackedRef.current) return;
              searchTrackedRef.current = true;
              trackDesignSystemsTopClick(analytics.track, {
                page_name: 'design_systems',
                area: 'design_systems',
                element: 'search_input',
              });
            }}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            data-testid="design-systems-category-select"
            value={category}
            onFocus={() => {
              if (categoryTrackedRef.current) return;
              categoryTrackedRef.current = true;
              trackDesignSystemsTopClick(analytics.track, {
                page_name: 'design_systems',
                area: 'design_systems',
                element: 'search_dropdown',
              });
            }}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {renderCategory(c)}
              </option>
            ))}
          </select>
        </div>
        <div
          className="examples-filter-row"
          role="tablist"
          aria-label={t('ds.surfaceLabel')}
        >
          <span className="examples-filter-label">{t('ds.surfaceLabel')}</span>
          {/* Hide chips with no items in the active style/search filter, but
              always keep "all" and the currently selected surface — otherwise a
              transient search could remove the active chip and leave the grid
              filtered with no chip showing aria-selected. */}
          {SURFACE_PILLS.filter(
            (p) => p.value === surfaceFilter || p.value === 'all' || surfaceCounts[p.value] > 0,
          ).map((p) => (
            <button
              key={p.value}
              type="button"
              role="tab"
              aria-selected={surfaceFilter === p.value}
              data-testid={`design-systems-surface-${p.value}`}
              className={`filter-pill ${surfaceFilter === p.value ? 'active' : ''}`}
              onClick={() => {
                trackDesignSystemsTopClick(analytics.track, {
                  page_name: 'design_systems',
                  area: 'design_systems',
                  element: 'filter_chip',
                  filter_name: p.value,
                });
                setSurfaceFilter(p.value);
              }}
            >
              {t(p.labelKey)}
              <span className="filter-pill-count">{surfaceCounts[p.value]}</span>
            </button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <div className="tab-empty" data-testid="design-systems-empty">{t('ds.emptyNoMatch')}</div>
        ) : (
          <div className="ds-grid" data-testid="design-systems-grid">
            {filtered.map((s) => (
              <DesignSystemCard
                key={s.id}
                system={s}
                active={s.id === selectedId}
                thumbHtml={thumbs[s.id]}
                onIntersect={() => loadThumb(s.id)}
                onSelect={() => {
                  trackDesignSystemsTemplateCardClick(analytics.track, {
                    page_name: 'design_systems',
                    area: 'templates_card',
                    element: 'templates_card',
                    templates_id: s.id,
                    templates_type: s.source ?? 'library',
                  });
                  onSelect(s.id);
                }}
                onPreview={() => {
                  trackDesignSystemsTemplateCardClick(analytics.track, {
                    page_name: 'design_systems',
                    area: 'templates_card',
                    element: 'templates_card',
                    templates_id: s.id,
                    templates_type: s.source ?? 'library',
                  });
                  onPreview(s.id);
                }}
                onPreviewFullscreen={
                  s.hasReactBundle && onPreviewFullscreen
                    ? () => {
                        trackDesignSystemsTemplateCardClick(analytics.track, {
                          page_name: 'design_systems',
                          area: 'templates_card',
                          element: 'templates_card',
                          templates_id: s.id,
                          templates_type: s.source ?? 'library',
                        });
                        onPreviewFullscreen(s.id);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
        </section>
      ) : null}

    </div>
  );
}

interface CardProps {
  system: DesignSystemSummary;
  active: boolean;
  thumbHtml: string | null | undefined;
  onIntersect: () => void;
  onSelect: () => void;
  onPreview: () => void;
  onPreviewFullscreen?: () => void;
}

function DesignSystemCard({
  system,
  active,
  thumbHtml,
  onIntersect,
  onSelect,
  onPreview,
  onPreviewFullscreen,
}: CardProps) {
  const { locale, t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  // Lazy-load the showcase iframe only when the card scrolls into the
  // viewport. With ~120 design systems we can't afford to mount every
  // iframe up front — even with `loading="lazy"`, srcDoc iframes ignore
  // the native lazy hint, so we gate via IntersectionObserver.
  useEffect(() => {
    if (thumbHtml !== undefined) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      onIntersect();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onIntersect();
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [thumbHtml, onIntersect]);

  const localizedSummary = localizeDesignSystemSummary(locale, system);
  const categoryLabel = localizeDesignSystemCategory(
    locale,
    system.category || 'Uncategorized',
  );

  return (
    <div
      ref={ref}
      className={`ds-card ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      data-testid={`design-system-card-${system.id}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div
      className="ds-card-thumb"
      data-testid={`design-system-preview-${system.id}`}
      onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        title={t('ds.previewTitle')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onPreview();
          }
        }}
      >
        {thumbHtml ? (
          <iframe
            title={`${system.title} preview`}
            sandbox="allow-scripts"
            srcDoc={buildSrcdoc(thumbHtml)}
            tabIndex={-1}
            aria-hidden
          />
        ) : (
          <div className="ds-card-thumb-fallback" aria-hidden>
            {system.swatches && system.swatches.length > 0 ? (
              <div className="ds-card-thumb-swatches">
                {system.swatches.map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </div>
            ) : (
              <span className="ds-card-thumb-placeholder">
                {thumbHtml === null ? '' : ''}
              </span>
            )}
          </div>
        )}
        <span className="ds-card-thumb-overlay" aria-hidden>
          {t('ds.preview')}
        </span>
        {onPreviewFullscreen ? (
          <button
            type="button"
            className="ds-card-thumb-fullscreen"
            aria-label={t('common.fullscreen')}
            title={t('common.fullscreen')}
            onClick={(e) => {
              e.stopPropagation();
              onPreviewFullscreen();
            }}
          >
            <Icon name="maximize" />
          </button>
        ) : null}
      </div>
      <div className="ds-card-meta" data-testid={`design-system-select-${system.id}`}>
        <div className="ds-card-title-row">
          <span className="ds-card-title">{system.title}</span>
          {active ? (
            <span className="ds-card-badge">{t('ds.badgeDefault')}</span>
          ) : null}
        </div>
        <div className="ds-card-summary">{localizedSummary}</div>
        <div className="ds-card-footer">
          <span className="ds-card-category">{categoryLabel}</span>
          {system.swatches && system.swatches.length > 0 ? (
            <div className="ds-card-swatches" aria-hidden>
              {system.swatches.map((c, i) => (
                <span key={i} style={{ background: c }} title={c} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
