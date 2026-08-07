// Fresh modal shell + form primitives for NEW Pipelines-surface dialogs,
// styled entirely through PipelineFormModal.module.css (see AGENTS.md "Web
// CSS ownership") instead of the legacy global `pl-modal` / `pl-btn` /
// `pl-input` selectors in styles/home/pipelines.css. Those globals still back
// the OLDER modals in PipelineModals.tsx (PlModal) — this file is the new
// family screens 1-3 (PipelineNavViews.module.css) expect their dialogs to
// match visually.
//
// Behaviourally this matches or exceeds PlModal: Escape + overlay-click close
// (both suppressed while `busy`, same as PlModal), PLUS a focus trap while
// open and focus restored to the trigger element on close — PlModal has
// neither.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { ConfluencePageHit } from '@open-design/contracts';
import { Icon, type IconName } from '../Icon';
import styles from './PipelineFormModal.module.css';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface PipelineFormModalProps {
  title: string;
  icon?: IconName;
  /** While true, Escape and backdrop clicks do not close (e.g. mid-submit). */
  busy?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/** Overlay + dialog shell: `role="dialog"`, labelled by its title via
 *  `aria-labelledby`, Escape/overlay-click to close, a focus trap while open,
 *  and focus returned to whatever triggered it once closed. */
export function PipelineFormModal({
  title,
  icon,
  busy = false,
  onClose,
  footer,
  children,
}: PipelineFormModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  // Focus trap: remember the trigger, move focus into the dialog on mount,
  // and restore it on unmount — the part PlModal never did.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const first = dialog ? focusableIn(dialog)[0] : undefined;
    (first ?? dialog)?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement) trigger.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = focusableIn(dialog);
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const insideDialog = active instanceof Node && dialog.contains(active);
      if (e.shiftKey) {
        if (!insideDialog || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={styles.head}>
          <span id={titleId} className={styles.title}>
            {icon ? <Icon name={icon} size={16} /> : null}
            {title}
          </span>
          <button type="button" className={styles.close} onClick={onClose} disabled={busy} aria-label="Đóng">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </div>
  );
}

interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
}

export interface FormFieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Render-prop so the control gets a real, `useId`-generated `id` (wired to
   *  the `<label htmlFor>`) plus `aria-describedby` covering the hint/error. */
  children: (props: FormFieldControlProps) => ReactNode;
}

/** Label + control slot + optional hint + optional error. */
export function FormField({ label, hint, error, children }: FormFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy })}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} type="text" className={className ? `${styles.input} ${className}` : styles.input} {...rest} />;
  },
);

export interface ComboOption {
  value: string;
  label?: string;
}

export interface ComboInputProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  options: ComboOption[];
}

/** Text input + `<datalist>` — editable-with-suggestions. */
export function ComboInput({ id, options, className, ...rest }: ComboInputProps) {
  const listId = useId();
  return (
    <>
      <input
        id={id}
        type="text"
        list={listId}
        className={className ? `${styles.input} ${className}` : styles.input}
        {...rest}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
    </>
  );
}

// ── Confluence root combobox (App forms) ──────────────────────────────────
// User feedback (post-launch): App's "Confluence root" must be SEARCHED by
// page title, not typed as a bare link/id. Reimplemented as a small
// standalone hook + field here (rather than importing PipelineModals.tsx'
// ConfluencePagePicker, which is pre-existing WIP wired for a very different
// job — multi-page TREE selection for the run-source modal) so this stays a
// single-value combobox matching this file's own primitives/styling.

/** A pasted Confluence link or bare numeric page id is used as the root
 *  DIRECTLY — the daemon normalizes either on save (extracts the id from a
 *  URL, stores a bare id as-is). Anything else is a title fragment to
 *  SEARCH for, not a value to submit on its own. */
function looksLikeConfluenceRef(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^\d+$/.test(text);
}

/** `ConfluencePageHit` + `ancestors` + `hasChildren` — contract additions
 *  landing alongside this UI change (BE task, in parallel). Declared locally
 *  so this file can code against the exact fields ahead of/independent from
 *  `packages/contracts` picking them up; safe to drop once `ConfluencePageHit`
 *  itself carries them. Always optional — an older daemon/gateway omits them
 *  entirely: `ancestors` degrades to today's "SPACE · id" rendering,
 *  `hasChildren` degrades to "always show the chevron" (graceful, matches
 *  pre-this-change behavior). */
type ConfluenceHitWithAncestors = ConfluencePageHit & { ancestors?: string[]; hasChildren?: boolean };

/** Debounced Confluence title search — same endpoint/response shape
 *  `ConfluencePagePicker` (PipelineModals.tsx) already consumes
 *  (`GET /api/pipelines/confluence/pages?q=`, `ConfluencePageHit[]`
 *  packages/contracts). `q` under 2 trimmed chars short-circuits to an idle
 *  `hits: null` — no fetch, no error. */
function useConfluenceTitleSearch(q: string): {
  hits: ConfluenceHitWithAncestors[] | null;
  loading: boolean;
  error: string | null;
} {
  const [hits, setHits] = useState<ConfluenceHitWithAncestors[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      setError(null);
      return;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(query)}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
          setHits((j as { pages?: ConfluenceHitWithAncestors[] }).pages ?? []);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setHits([]);
        } finally {
          setLoading(false);
        }
      })();
    }, 350);
    return () => clearTimeout(timer.current);
  }, [q]);

  return { hits, loading, error };
}

/** "SPACE · <ancestor path> · id" meta line for one dropdown option — the
 *  ancestor segment renders only the last 1-2 ancestors (the direct parent,
 *  prefixed "… / " when the real path is deeper) so the one-line, ellipsis-
 *  truncated meta row stays readable; the FULL path is exposed separately as
 *  the option's `title` tooltip. `ancestors` undefined/empty (older daemon,
 *  or a top-level page) → falls back to today's "SPACE · id". */
function confluenceHitMeta(hit: ConfluenceHitWithAncestors): { text: string; fullPath: string | null } {
  const parts: string[] = [];
  if (hit.space) parts.push(hit.space);
  const ancestors = hit.ancestors;
  if (ancestors && ancestors.length > 0) {
    const tail = ancestors.slice(-2);
    const prefix = ancestors.length > tail.length ? '… / ' : '';
    parts.push(`${prefix}${tail.join(' / ')}`);
  }
  parts.push(hit.id);
  return {
    text: parts.join(' · '),
    fullPath: ancestors && ancestors.length > 0 ? ancestors.join(' / ') : null,
  };
}

/** One node of a search hit's expanded sub-tree
 *  (`GET /api/pipelines/confluence/descendants?ref=`) — same treePath-
 *  grouping idea as PipelineModals.tsx' `buildConfTree`/`buildAppDocsTree`,
 *  reimplemented locally here (see the file-level note above on why this
 *  file doesn't import PipelineModals.tsx). One fetch per top-level hit
 *  returns the WHOLE sub-tree (every level, flat + treePath), so expanding a
 *  node deeper than direct children is pure client-side tree walking — no
 *  per-level re-fetch. */
interface ConfluenceDescNode {
  id: string;
  title: string;
  children: ConfluenceDescNode[];
}

function buildConfluenceDescTree(
  rootId: string,
  rootTitle: string,
  flat: Array<{ pageId: string; title: string; treePath: string[] }>,
): ConfluenceDescNode {
  const root: ConfluenceDescNode = { id: rootId, title: rootTitle, children: [] };
  const childByTitle = (parent: ConfluenceDescNode, title: string): ConfluenceDescNode => {
    let n = parent.children.find((c) => c.title === title);
    if (!n) {
      n = { id: '', title, children: [] };
      parent.children.push(n);
    }
    return n;
  };
  for (const d of flat) {
    let node = root;
    for (const seg of d.treePath) node = childByTitle(node, seg);
    const leaf = childByTitle(node, d.title);
    leaf.id = d.pageId;
  }
  const prune = (n: ConfluenceDescNode): void => {
    n.children = n.children.filter((c) => c.id);
    n.children.forEach(prune);
  };
  prune(root);
  return root;
}

export interface ConfluenceRootFieldProps extends FormFieldControlProps {
  /** What the form submits: `App.confluenceRoots` — every selected root
   *  pageId (multi-root, docs/app-docs-tree-picker-spec.md). `[]` clears. */
  value: string[];
  onValueChange: (next: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Mirrors the plain TextInput's `onKeyDown Enter → submit` convention —
   *  fires only when the input has nothing pending to add (a ref-looking
   *  query is added as a chip on Enter instead of submitting the form). */
  onEnter?: () => void;
}

/** Multi-root browser for the App's "Confluence root(s)" field
 *  (docs/app-docs-tree-picker-spec.md): search by page TITLE (debounced),
 *  expand a hit to browse its sub-tree, and click any row's checkbox to add
 *  it as a root CHIP (multi-add — picking does not close the dropdown) — or
 *  paste a page URL/bare id and add it directly. Selected roots render as
 *  removable chips below the input; a prefilled root with no known title
 *  (existing App roots, opened for edit) shows its bare id until the user
 *  re-resolves it via search. */
export function ConfluenceRootField({
  id,
  'aria-describedby': describedBy,
  value,
  onValueChange,
  placeholder,
  autoFocus,
  disabled,
  onEnter,
}: ConfluenceRootFieldProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Titles we've actually seen this session (search hits / expanded
  // children) — prefilled `value` ids carry no title, so their chip shows
  // the bare id until/unless the user re-finds that page here.
  const [titleById, setTitleById] = useState<Record<string, string>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  // Options render through a portal (see below) — needs its own ref for the
  // outside-click check, since it's no longer a DOM descendant of wrapRef.
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Portal position, recomputed while open. Same shape/flip-above math as
  // CustomSelect.tsx's `updatePosition` (this repo's existing portal-dropdown
  // precedent) — reused rather than reinvented, including the `openAbove`
  // heuristic (flip when there's little room below AND more room above).
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(
    null,
  );
  // Expand/collapse state shared by top-level hits AND any nested descendant
  // node (keyed by pageId) — expanding a hit for the FIRST time also
  // triggers its one-shot sub-tree fetch (see descByHit below); expanding a
  // node that's already loaded is pure local state, no fetch.
  const [expandedNode, setExpandedNode] = useState<Set<string>>(new Set());
  const [descByHit, setDescByHit] = useState<Record<string, ConfluenceDescNode | 'loading' | 'error'>>({});

  const trimmed = query.trim();
  const isRef = looksLikeConfluenceRef(trimmed);
  // No point searching once the text already resolves as a direct ref.
  const { hits, loading, error } = useConfluenceTitleSearch(isRef ? '' : query);

  const showFloating = open && (isRef ? trimmed.length > 0 : trimmed.length >= 2);

  const updatePos = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 12;
    const below = window.innerHeight - rect.bottom - viewportPad;
    const above = rect.top - viewportPad;
    const maxHeight = Math.max(160, Math.min(260, Math.max(below, above) - gap));
    const openAbove = below < 200 && above > below;
    setPos({
      top: openAbove ? Math.max(viewportPad, rect.top - maxHeight - gap) : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  }, []);

  // Keep the portal aligned with the input while it's showing — window
  // resize (or a taller form elsewhere reusing this field) shouldn't leave
  // the list floating over the wrong spot.
  useLayoutEffect(() => {
    if (!showFloating) return;
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [showFloating, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const addRoot = (rootId: string, title?: string) => {
    if (title) setTitleById((m) => ({ ...m, [rootId]: title }));
    if (value.includes(rootId)) return;
    onValueChange([...value, rootId]);
  };
  const removeRoot = (rootId: string) => onValueChange(value.filter((v) => v !== rootId));
  const toggleRoot = (rootId: string, title?: string) => {
    if (value.includes(rootId)) removeRoot(rootId);
    else addRoot(rootId, title);
  };

  const addPastedRef = () => {
    if (!trimmed) return;
    addRoot(trimmed);
    setQuery('');
  };

  // First expand of a hit fetches its whole sub-tree once; re-expanding
  // (already fetched, or collapsing) is just the local Set toggle below.
  const toggleExpand = (nodeId: string, fetchFrom?: ConfluenceHitWithAncestors) => {
    setExpandedNode((s) => {
      const n = new Set(s);
      if (n.has(nodeId)) n.delete(nodeId);
      else n.add(nodeId);
      return n;
    });
    if (!fetchFrom || descByHit[fetchFrom.id]) return;
    setDescByHit((m) => ({ ...m, [fetchFrom.id]: 'loading' }));
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines/confluence/descendants?ref=${encodeURIComponent(fetchFrom.id)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        const flat = (j.pages ?? []) as Array<{ pageId: string; title: string; treePath: string[] }>;
        setDescByHit((m) => ({ ...m, [fetchFrom.id]: buildConfluenceDescTree(fetchFrom.id, fetchFrom.title, flat) }));
      } catch {
        setDescByHit((m) => ({ ...m, [fetchFrom.id]: 'error' }));
      }
    })();
  };

  const renderDescNode = (node: ConfluenceDescNode, depth: number): JSX.Element => {
    const on = value.includes(node.id);
    const isExpanded = expandedNode.has(node.id);
    const hasKids = node.children.length > 0;
    return (
      <div key={node.id}>
        <div
          className={styles.comboNodeRow}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => toggleRoot(node.id, node.title)}
        >
          {hasKids ? (
            <button
              type="button"
              className={styles.comboChevron}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
            >
              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className={styles.comboChevronSpacer} aria-hidden="true" />
          )}
          <span className={`${styles.comboCheckbox}${on ? ' ' + styles.comboCheckboxOn : ''}`}>
            {on ? <Icon name="check" size={11} /> : null}
          </span>
          <span className={styles.comboOptionTitle}>{node.title}</span>
        </div>
        {isExpanded ? node.children.map((c) => renderDescNode(c, depth + 1)) : null}
      </div>
    );
  };

  // `hasChildren === false` (contract): confirmed leaf, no chevron, ever.
  // `hasChildren === true` or `undefined` (older daemon, "unknown"): show the
  // chevron — UNLESS we've already fetched this hit's sub-tree this session
  // and it came back empty, which reclassifies it as a leaf for the rest of
  // the session (no re-fetch, no more chevron) even though the search hit
  // itself didn't know that up front.
  const hitShowsChevron = (h: ConfluenceHitWithAncestors): boolean => {
    if (h.hasChildren === false) return false;
    const desc = descByHit[h.id];
    if (desc && desc !== 'loading' && desc !== 'error') return desc.children.length > 0;
    return true;
  };

  const renderHitRow = (h: ConfluenceHitWithAncestors): JSX.Element => {
    const meta = confluenceHitMeta(h);
    const on = value.includes(h.id);
    const isExpanded = expandedNode.has(h.id);
    const desc = descByHit[h.id];
    const showChevron = hitShowsChevron(h);
    return (
      <div key={h.id}>
        <div className={styles.comboHitRow} title={meta.fullPath ?? undefined} onClick={() => toggleRoot(h.id, h.title)}>
          {showChevron ? (
            <button
              type="button"
              className={styles.comboChevron}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(h.id, h);
              }}
            >
              <Icon name={desc === 'loading' ? 'spinner' : isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className={styles.comboChevronSpacer} aria-hidden="true" />
          )}
          <span className={`${styles.comboCheckbox}${on ? ' ' + styles.comboCheckboxOn : ''}`}>
            {on ? <Icon name="check" size={11} /> : null}
          </span>
          <span className={styles.comboOptionBody}>
            <span className={styles.comboOptionTitle}>{h.title}</span>
            <span className={styles.comboOptionMeta}>{meta.text}</span>
          </span>
        </div>
        {isExpanded && desc === 'error' ? (
          <p className={styles.comboMsg} style={{ paddingLeft: 30 }}>
            Không tải được trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error' && desc.children.length === 0 ? (
          <p className={styles.comboMsg} style={{ paddingLeft: 30 }}>
            Không có trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error'
          ? desc.children.map((c) => renderDescNode(c, 1))
          : null}
      </div>
    );
  };

  return (
    <div className={styles.comboWrap} ref={wrapRef}>
      <input
        id={id}
        aria-describedby={describedBy}
        type="text"
        role="combobox"
        aria-expanded={showFloating}
        aria-autocomplete="list"
        autoComplete="off"
        className={styles.input}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (isRef && trimmed) {
              e.preventDefault();
              addPastedRef();
              return;
            }
            onEnter?.();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {value.length > 0 ? (
        <div className={styles.comboChips}>
          {value.map((rootId) => (
            <span key={rootId} className={styles.comboChip}>
              <span className={styles.comboChipTitle}>{titleById[rootId] ?? rootId}</span>
              {titleById[rootId] ? <span className={styles.comboChipId}>{rootId}</span> : null}
              <button
                type="button"
                className={styles.comboChipRemove}
                onClick={() => removeRoot(rootId)}
                aria-label={`Bỏ ${titleById[rootId] ?? rootId}`}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {showFloating && pos
        ? createPortal(
            <div
              ref={dropdownRef}
              className={styles.comboDropdown}
              role="listbox"
              style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            >
              {isRef ? (
                <button type="button" className={styles.comboAddRefRow} onClick={addPastedRef}>
                  <Icon name="plus" size={13} />
                  <span className={styles.comboOptionTitle}>Thêm: {trimmed}</span>
                </button>
              ) : loading ? (
                <p className={styles.comboMsg}>Đang tìm…</p>
              ) : error ? (
                <p className={styles.comboMsg}>{error} — vẫn dán link/page id trực tiếp được.</p>
              ) : hits && hits.length > 0 ? (
                hits.map((h) => renderHitRow(h))
              ) : hits ? (
                <p className={styles.comboMsg}>Không có trang nào khớp “{trimmed}”.</p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface FormButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  busy?: boolean;
}

/** Accent-filled call to action. Does not reuse `pl-btn`. */
export function PrimaryButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${styles.btnPrimary} ${className}` : `${styles.btn} ${styles.btnPrimary}`}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Nút cho hành động PHÁ HỦY (xóa App/Feature): đỏ đầy nền để nó không bị
 *  bấm nhầm như một nút xác nhận bình thường. */
export function DangerButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${styles.btnDanger} ${className}` : `${styles.btn} ${styles.btnDanger}`}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Neutral, low-emphasis button (Cancel / secondary actions). */
export function QuietButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${className}` : styles.btn}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Đoạn văn giải thích trong thân hộp thoại (hộp thoại xác nhận không có
 *  trường nhập nào, chỉ có chữ). */
export function FormText({ children }: { children: ReactNode }) {
  return <p className={styles.text}>{children}</p>;
}

/** Inline error banner, matching the old `.pl-modal-error` treatment. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div className={styles.error} role="alert">
      <Icon name="info" size={14} />
      <span>{children}</span>
    </div>
  );
}
