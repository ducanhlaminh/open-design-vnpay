import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useT } from '../i18n';
import type { AppConfig, DesignSystemSummary } from '../types';
import {
  fetchDesignSystems,
  importFigmaDesignSystem,
  importGitHubDesignSystem,
  importLocalDesignSystem,
  updateDesignSystemDraft,
} from '../providers/registry';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';
import { FigmaDesignSystemDetailModal } from './FigmaDesignSystemDetailModal';
import { Icon } from './Icon';
import { orderDesignSystemGroups } from './design-system-group-order';
import { DsCriteriaJobModal } from './DsCriteriaJobModal';

// Sibling Settings section that hosts the design-systems registry.
// Lifted out of the previous LibrarySection so each surface (functional
// skills vs. design systems) gets its own dedicated nav entry instead of
// sharing a sub-tab toggle. See specs/current/skills-and-design-templates.md.

interface Props {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}

function toggleCraftSlug(current: string[], slug: string, enabled: boolean): string[] {
  const next = new Set(current);
  if (enabled) next.add(slug);
  else next.delete(slug);
  return Array.from(next);
}

export function DesignSystemsSection({ cfg, setCfg }: Props) {
  const t = useT();
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [previewSystem, setPreviewSystem] = useState<DesignSystemSummary | null>(null);
  const [criteriaSystem, setCriteriaSystem] = useState<DesignSystemSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; original: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Monotonic token for the active rename modal session. Bumped whenever the
  // modal opens or closes so a slow PATCH that resolves after the user has
  // moved on cannot clobber a newer session's modal state.
  const renameSessionRef = useRef(0);
  const [importPath, setImportPath] = useState('');
  // Figma là đường import CHÍNH (zip từ plugin Fig Pipeline) — mặc định luôn,
  // chọn file là bấm Import được ngay. Local/GitHub là nguồn phụ cho DS dạng
  // CSS/token (ui-html), giữ sau nút Figma.
  const [importSource, setImportSource] = useState<'local' | 'github' | 'figma'>('figma');
  // Figma IR uploads: .ir.json and/or plugin .zip bundles. The daemon merges
  // in NATURAL FILENAME ORDER (01-, 02-, … — foundation/token export first),
  // so selection order here does not matter.
  const [importIrFiles, setImportIrFiles] = useState<File[]>([]);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importCriteria, setImportCriteria] = useState<{ rules: boolean; components: boolean } | null>(null);
  const [packageImportMode, setPackageImportMode] = useState<'normalized' | 'hybrid' | 'verbatim'>('hybrid');
  const [craftApplies, setCraftApplies] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [showOnlyHidden, setShowOnlyHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importedDesignSystem, setImportedDesignSystem] = useState<DesignSystemSummary | null>(null);
  const [highlightedDesignSystemId, setHighlightedDesignSystemId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    fetchDesignSystems().then(setDesignSystems);
  }, []);


  const disabledDS = useMemo(
    () => new Set(cfg.disabledDesignSystems ?? []),
    [cfg.disabledDesignSystems],
  );
  const hiddenDesignSystemCount = useMemo(
    () => designSystems.filter((system) => disabledDS.has(system.id)).length,
    [designSystems, disabledDS],
  );

  const categories = useMemo(() => {
    const cats = new Set(designSystems.map((d) => d.category));
    return ['All', ...Array.from(cats).sort()];
  }, [designSystems]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return designSystems.filter((d) => {
      if (showOnlyHidden && !disabledDS.has(d.id)) return false;
      if (categoryFilter !== 'All' && d.category !== categoryFilter) return false;
      if (
        q &&
        !d.title.toLowerCase().includes(q) &&
        !d.summary.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [designSystems, categoryFilter, disabledDS, search, showOnlyHidden]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DesignSystemSummary[]>();
    for (const d of filtered) {
      const list = groups.get(d.category) ?? [];
      list.push(d);
      groups.set(d.category, list);
    }
    return groups;
  }, [filtered]);

  // Pin groups that hold editable (user-created) systems to the top so a
  // user's own design systems are the first thing they see. Issue #2813.
  const orderedGroups = useMemo(
    () => orderDesignSystemGroups(Array.from(grouped.entries())),
    [grouped],
  );

  useEffect(() => {
    if (!highlightedDesignSystemId) return;
    const raf = window.requestAnimationFrame(() => {
      const card = cardRefs.current.get(highlightedDesignSystemId);
      if (typeof card?.scrollIntoView === 'function') {
        card.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    });
    const timeout = window.setTimeout(() => {
      setHighlightedDesignSystemId((current) =>
        current === highlightedDesignSystemId ? null : current,
      );
    }, 2200);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [filtered, highlightedDesignSystemId]);

  useEffect(() => {
    if (hiddenDesignSystemCount === 0) setShowOnlyHidden(false);
  }, [hiddenDesignSystemCount]);

  function toggleDSDisabled(id: string, enabled: boolean) {
    setCfg((c) => {
      const set = new Set(c.disabledDesignSystems ?? []);
      if (enabled) set.delete(id);
      else set.add(id);
      return { ...c, disabledDesignSystems: [...set] };
    });
  }

  function startRename(ds: DesignSystemSummary) {
    renameSessionRef.current += 1;
    setRenameTarget({ id: ds.id, original: ds.title });
    setRenameInput(ds.title);
    setRenameError(null);
  }

  function cancelRename() {
    renameSessionRef.current += 1;
    setRenameTarget(null);
    setRenameError(null);
    setRenaming(false);
  }

  // Rename an editable design system via PATCH /api/design-systems/:id, then
  // reflect the new title in the local list (re-sorted to keep card order
  // stable). Built-in systems never reach here — the button is editable-only.
  async function commitRename() {
    if (!renameTarget || renaming) return;
    const trimmed = renameInput.trim();
    if (!trimmed || trimmed === renameTarget.original) {
      cancelRename();
      return;
    }
    const session = renameSessionRef.current;
    const targetId = renameTarget.id;
    setRenaming(true);
    setRenameError(null);
    const updated = await updateDesignSystemDraft(targetId, { title: trimmed });
    if (updated) {
      // The rename happened server-side, so reflect it in the list even if the
      // user has since moved to another rename session.
      setDesignSystems((current) =>
        current
          .map((d) => (d.id === targetId ? { ...d, title: updated.title } : d))
          .sort((a, b) => a.title.localeCompare(b.title)),
      );
    }
    // Ignore a stale completion: the user cancelled or opened another rename
    // while this PATCH was in flight, so the modal state now belongs to a
    // different session and must not be touched.
    if (renameSessionRef.current !== session) return;
    setRenaming(false);
    // updateDesignSystemDraft returns null on any non-OK response or fetch
    // failure. Keep the modal open with the typed title intact so a transient
    // daemon/network error can be retried instead of silently disappearing.
    if (!updated) {
      setRenameError(t('settings.designSystemRenameFailed'));
      return;
    }
    setRenameTarget(null);
    setRenameError(null);
  }

  function clearImportFeedback() {
    setImportError(null);
    setImportMessage(null);
    setImportedDesignSystem(null);
    setImportWarnings([]);
    setImportCriteria(null);
  }

  async function handleLocalImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const importTarget = importPath.trim();
    if (importing) return;
    if (importSource === 'figma' ? importIrFiles.length === 0 : !importTarget) return;
    setImporting(true);
    setImportError(null);
    setImportMessage(null);
    setImportedDesignSystem(null);
    setImportWarnings([]);
    const importOptions = {
      importMode: packageImportMode,
      craftApplies,
    };
    let importWarningsNext: string[] = [];
    let result: Awaited<ReturnType<typeof importLocalDesignSystem>>;
    if (importSource === 'figma') {
      const figmaResult = await importFigmaDesignSystem({ files: importIrFiles, craftApplies });
      if (!('error' in figmaResult)) importWarningsNext = figmaResult.warnings;
      result = figmaResult;
    } else if (importSource === 'github') {
      result = await importGitHubDesignSystem({ githubUrl: importTarget, ...importOptions });
    } else {
      result = await importLocalDesignSystem({ baseDir: importTarget, ...importOptions });
    }
    setImporting(false);
    if ('error' in result) {
      setImportError(result.error.message);
      return;
    }
    const importedSystem = result.designSystem;
    setDesignSystems((current) => {
      const withoutDuplicate = current.filter((system) => system.id !== importedSystem.id);
      return [...withoutDuplicate, importedSystem].sort((a, b) => a.title.localeCompare(b.title));
    });
    setPreviewSystem(null);
    setImportPath('');
    setImportIrFiles([]);
    setImportWarnings(importWarningsNext);
    setImportedDesignSystem(importedSystem);
    const criteria = 'criteria' in result && result.criteria && typeof result.criteria === 'object'
      ? result.criteria as { rules: boolean; components: boolean }
      : null;
    setImportCriteria(criteria);
    setImportMessage(importedSystem.title);
  }

  function viewImportedDesignSystem() {
    if (!importedDesignSystem) return;
    setSearch('');
    setShowOnlyHidden(false);
    setCategoryFilter(importedDesignSystem.category);
    setPreviewSystem(null);
    setHighlightedDesignSystemId(importedDesignSystem.id);
  }

  function toggleShowOnlyHidden() {
    setShowOnlyHidden((current) => {
      const next = !current;
      if (next) {
        setSearch('');
        setCategoryFilter('All');
      }
      return next;
    });
  }

  return (
    <section className="settings-section settings-design-systems">
      <div className="library-section-header">
        <h4 className="library-section-title">
          {t('settings.designSystemsInstalled')}{' '}
          <span className="library-section-count">{designSystems.length}</span>
        </h4>
        <button
          type="button"
          className="primary-ghost library-add-btn"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((v) => !v)}
        >
          <span aria-hidden="true" className="library-add-btn-icon">+</span>
          <span>{t('settings.designSystemsAdd')}</span>
        </button>
      </div>
      {hiddenDesignSystemCount > 0 ? (
        <div className="library-hidden-banner">
          <span>
            {t('settings.designSystemsHiddenCount', { count: hiddenDesignSystemCount })}
          </span>
          <button
            type="button"
            className="library-hidden-banner-link"
            onClick={toggleShowOnlyHidden}
          >
            {showOnlyHidden
              ? t('settings.designSystemsShowAll')
              : t('settings.designSystemsShowHidden')}
          </button>
        </div>
      ) : null}

      <div className={`accordion-collapsible library-add-panel${addOpen ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <form className="library-install-form" onSubmit={handleLocalImport}>
            <div className="library-import-controls">
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {t('settings.designSystemsSource')}
                </span>
                <div className="seg-control library-import-source-control">
                  <button
                    type="button"
                    className={importSource === 'figma' ? 'active' : ''}
                    onClick={() => {
                      setImportSource('figma');
                      clearImportFeedback();
                    }}
                  >
                    {t('settings.designSystemsSourceFigma')}
                  </button>
                  <button
                    type="button"
                    className={importSource === 'local' ? 'active' : ''}
                    onClick={() => {
                      setImportSource('local');
                      clearImportFeedback();
                    }}
                  >
                    {t('settings.designSystemsSourceLocal')}
                  </button>
                  <button
                    type="button"
                    className={importSource === 'github' ? 'active' : ''}
                    onClick={() => {
                      setImportSource('github');
                      clearImportFeedback();
                    }}
                  >
                    {t('settings.designSystemsSourceGithub')}
                  </button>
                </div>
              </div>
              {/* Import mode only applies to scanned project imports; Figma IR
                  is compiled verbatim by design. */}
              <div className="library-import-row" hidden={importSource === 'figma'}>
                <span className="library-import-option-label">
                  {t('settings.designSystemsStructure')}
                </span>
                <div className="seg-control library-import-mode-control">
                  <button
                    type="button"
                    className={packageImportMode === 'hybrid' ? 'active' : ''}
                    onClick={() => setPackageImportMode('hybrid')}
                  >
                    {t('settings.designSystemsModeHybrid')}
                  </button>
                  <button
                    type="button"
                    className={packageImportMode === 'normalized' ? 'active' : ''}
                    onClick={() => setPackageImportMode('normalized')}
                  >
                    {t('settings.designSystemsModeNormalized')}
                  </button>
                  <button
                    type="button"
                    className={packageImportMode === 'verbatim' ? 'active' : ''}
                    onClick={() => setPackageImportMode('verbatim')}
                  >
                    {t('settings.designSystemsModeVerbatim')}
                  </button>
                </div>
              </div>
              {/* Craft rules chỉ có nghĩa cho DS dạng CSS/token (ui-html) —
                  đường Figma react-ds đã gắn craft theo SKILL, checkbox ở đây
                  là bước thừa nên ẩn: chọn zip là Import được ngay. */}
              <div className="library-import-row" hidden={importSource === 'figma'}>
                <span className="library-import-option-label">
                  {t('settings.designSystemsCraft')}
                </span>
                <div className="library-import-checkboxes">
                  <label className="library-import-checkbox">
                    <input
                      type="checkbox"
                      checked={craftApplies.includes('color')}
                      onChange={(e) =>
                        setCraftApplies((current) =>
                          toggleCraftSlug(current, 'color', e.target.checked),
                        )
                      }
                    />
                    <span>{t('settings.designSystemsCraftColor')}</span>
                  </label>
                  <label className="library-import-checkbox">
                    <input
                      type="checkbox"
                      checked={craftApplies.includes('accessibility-baseline')}
                      onChange={(e) =>
                        setCraftApplies((current) =>
                          toggleCraftSlug(current, 'accessibility-baseline', e.target.checked),
                        )
                      }
                    />
                    <span>{t('settings.designSystemsCraftAccessibility')}</span>
                  </label>
                </div>
              </div>
              <div className="library-import-row">
                <span className="library-import-option-label">
                  {importSource === 'figma'
                    ? t('settings.designSystemsFigmaFiles')
                    : importSource === 'github'
                      ? t('settings.designSystemsGithubUrl')
                      : t('settings.designSystemsProjectPath')}
                </span>
                <div className="library-install-row">
                  {importSource === 'figma' ? (
                    <input
                      type="file"
                      className="library-import-input"
                      accept=".json,.zip,.md,application/json,application/zip,text/markdown"
                      multiple
                      onChange={(e) => {
                        setImportIrFiles(Array.from(e.target.files ?? []));
                        clearImportFeedback();
                      }}
                    />
                  ) : (
                    <input
                      type="text"
                      className="library-import-input"
                      placeholder={importSource === 'github' ? 'https://github.com/owner/repo' : '/path/to/project'}
                      value={importPath}
                      onChange={(e) => {
                        setImportPath(e.target.value);
                        clearImportFeedback();
                      }}
                    />
                  )}
                  <button
                    type="submit"
                    className="library-install-submit"
                    disabled={
                      importing ||
                      (importSource === 'figma'
                        ? importIrFiles.length === 0
                        : importPath.trim().length === 0)
                    }
                  >
                    {importing
                      ? t('settings.libraryLoading')
                      : importSource === 'figma'
                        ? t('settings.designSystemsImportFigma')
                        : importSource === 'github'
                          ? t('settings.designSystemsImportGithub')
                          : t('settings.designSystemsImportProject')}
                  </button>
                </div>
              </div>
              {importSource === 'figma' ? (
                <p className="library-install-hint">
                  {t('settings.designSystemsFigmaFilesHelp')} Có thể kéo kèm 1 file `.md` là bộ quy tắc UX dùng khi review tài liệu — tuỳ chọn, không có cũng nạp được.
                </p>
              ) : null}
            </div>
            {importError ? <p className="library-install-error">{importError}</p> : null}
            {importWarnings.length > 0 ? (
              <details className="library-install-warnings">
                <summary>
                  {t('settings.designSystemsImportWarnings', { count: importWarnings.length })}
                </summary>
                <ul>
                  {importWarnings.slice(0, 30).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {importCriteria?.rules ? <p className="library-install-status">Đã nạp bộ quy tắc review (rules.md).</p> : null}
            {importedDesignSystem && !importCriteria?.components ? <p className="library-install-status">Danh mục component chưa sinh, bấm Sinh danh mục trên thẻ DS để chạy.</p> : null}
            {importMessage ? (
              <p className="library-install-status">
                <span>{t('settings.designSystemsImportedStatus', { title: importMessage })}</span>
                {importedDesignSystem ? (
                  <button
                    type="button"
                    className="library-install-status-link"
                    onClick={viewImportedDesignSystem}
                  >
                    {t('settings.designSystemsViewImported')}
                  </button>
                ) : null}
              </p>
            ) : null}
          </form>
        </div>
      </div>

      <div className="library-toolbar library-toolbar-row">
        <input
          type="search"
          className="library-search"
          placeholder={t('settings.librarySearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="library-filter-select">
          <select
            aria-label={t('settings.designSystemsCategory')}
            value={categoryFilter}
            data-active={categoryFilter !== 'All' ? 'true' : undefined}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            {categories.map((cat) => {
              const count =
                cat === 'All'
                  ? designSystems.length
                  : designSystems.filter((d) => d.category === cat).length;
              return (
                <option
                  key={cat}
                  value={cat}
                >
                  {cat === 'All' ? t('settings.designSystemsAllCategories') : cat} ({count})
                </option>
              );
            })}
          </select>
        </label>
      </div>

      <div className="library-content">
        {filtered.length === 0 ? (
          <p className="library-empty">{t('settings.libraryNoResults')}</p>
        ) : (
          <>
            {orderedGroups.map(([category, items]) => (
              <div key={category} className="library-group">
                {categoryFilter === 'All' ? (
                  <h4 className="library-group-title">
                    {category}{' '}
                    <span className="library-group-count">{items.length}</span>
                  </h4>
                ) : null}
                <div className="ds-grid">
                  {items.map((ds) => (
                    <div
                      key={ds.id}
                      ref={(node) => {
                        if (node) cardRefs.current.set(ds.id, node);
                        else cardRefs.current.delete(ds.id);
                      }}
                      className={`library-ds-card${
                        disabledDS.has(ds.id) ? ' disabled' : ''
                      }${
                        highlightedDesignSystemId === ds.id ? ' highlighted' : ''
                      }`}
                    >
                      <div
                        className="library-ds-card-content"
                        role="button"
                        tabIndex={0}
                        aria-haspopup="dialog"
                        onClick={() => setPreviewSystem(ds)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          setPreviewSystem(ds);
                        }}
                      >
                        {ds.swatches && ds.swatches.length > 0 && (
                          <div className="library-ds-swatches">
                            {ds.swatches.slice(0, 4).map((c, i) => (
                              <span
                                key={i}
                                className="library-ds-swatch"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        )}
                        <div className="library-ds-title">
                          <span className="library-ds-title-text">{ds.title}</span>
                          {ds.source === 'user' || ds.isEditable === true ? (
                            <button
                              type="button"
                              className="library-ds-edit"
                              title={t('common.rename')}
                              aria-label={`${t('common.rename')} ${ds.title}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                startRename(ds);
                              }}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <Icon name="pencil" size={13} />
                            </button>
                          ) : null}
                        </div>
                        <div className="library-ds-summary">{ds.summary}</div>
                      </div>
                      {ds.hasReactBundle ? (
                        <button
                          type="button"
                          className="library-ds-criteria-btn"
                          title="Sinh danh mục component để review tài liệu (chạy agent, ~6 phút)"
                          aria-label={`Sinh danh mục review ${ds.title}`}
                          onClick={(e) => { e.stopPropagation(); setCriteriaSystem(ds); }}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="blocks" size={13} />
                          Danh mục review
                        </button>
                      ) : null}
                      <div className="library-ds-toggle-cell">
                        <label
                          className="toggle-switch toggle-switch-sm"
                          title={t('settings.designSystemsShowInHomeGallery')}
                        >
                          <input
                            type="checkbox"
                            aria-label={t('settings.designSystemsShowInHomeGallery')}
                            checked={!disabledDS.has(ds.id)}
                            onChange={(e) =>
                              toggleDSDisabled(ds.id, e.target.checked)
                            }
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {previewSystem ? (
        previewSystem.hasReactBundle ? (
          <FigmaDesignSystemDetailModal
            system={previewSystem}
            onClose={() => setPreviewSystem(null)}
          />
        ) : (
          <DesignSystemPreviewModal
            system={previewSystem}
            onClose={() => setPreviewSystem(null)}
          />
        )
      ) : null}
      {renameTarget ? (
        <div className="modal-backdrop" onClick={cancelRename}>
          <form
            className="modal modal-rename"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void commitRename();
            }}
          >
            <h2>{t('common.rename')}</h2>
            <label>
              <input
                type="text"
                value={renameInput}
                autoFocus
                aria-label={t('common.rename')}
                onChange={(e) => setRenameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
              />
            </label>
            {renameError ? <p className="library-install-error">{renameError}</p> : null}
            <div className="row">
              <button type="button" onClick={cancelRename}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={
                  renaming ||
                  !renameInput.trim() ||
                  renameInput.trim() === renameTarget.original
                }
              >
                {t('common.save')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {criteriaSystem ? (
        <DsCriteriaJobModal
          system={criteriaSystem}
          onClose={() => setCriteriaSystem(null)}
          onDone={() => { void fetchDesignSystems().then(setDesignSystems); }}
        />
      ) : null}
    </section>
  );
}
