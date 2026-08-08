'use client';

// Confluence eager parent/child tree picker — recovers the browsing UX that
// existed briefly on `ConfluenceRootField` (PipelineFormModal.tsx) before it
// was reverted in cfef0fe ("bỏ toàn bộ hướng 'Tài liệu App'"). That revert
// only reverted the App-docs-tree DIRECTION (a persistent "Confluence root"
// field on the App form); the tree-browsing MACHINERY itself — eager subtree
// fetch, auto-expand, hasChildren-aware chevrons, ancestor breadcrumbs, a
// portal dropdown that escapes modal clipping — is still the right shape for
// "search a Confluence page, then tick it or any of its descendants".
//
// Recovered from `git show cfef0fe^:apps/web/src/components/pipelines/PipelineFormModal.tsx`:
//   useConfluenceTitleSearch, confluenceHitMeta, ConfluenceDescNode,
//   buildConfluenceDescTree, collectExpandableIds, collectDescendantIds,
//   buildConfluenceNodeIndex, and the portal-dropdown positioning/outside-click
//   wiring from ConfluenceRootField.
//
// NOT recovered (deliberately dropped, out of this task's scope):
//   - the "paste a link/bare id as a root" affordance (`looksLikeConfluenceRef`
//     / addPastedRef) — this picker is title-search-only, matching the
//     `ConfluenceTitleSearchImport` UX it replaces.
//   - "implied" cascade semantics (a checked ancestor implicitly covers its
//     subtree while the subtree's own ids stay OUT of `value`, with a
//     `coveredBy` map driving greyed-out rows). `import-confluence` wants a
//     flat list of concrete page refs, so checking a parent here writes the
//     WHOLE subtree's ids into the ticked set explicitly (cascade in both
//     directions — see `toggleNode` below) instead of only the root id.
//     `ConfluenceHitWithAncestors` also no longer needs a locally-declared
//     type: `ancestors`/`hasChildren` now live on `ConfluencePageHit` itself
//     (packages/contracts) — this file codes directly against that; either
//     field being `undefined` degrades exactly as it did before (see
//     `confluenceHitMeta`/`hitShowsChevron` below).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppPoolImportResponse, ConfluencePageHit } from '@open-design/contracts';

import { Icon } from '../Icon';
import { ProgressBar } from './ProgressBar';
import styles from './ConfluenceTreeImport.module.css';

// ── Batched import (real progress) ──────────────────────────────────────────
// `POST .../import-confluence` is ONE request in, ONE response out for
// however many refs are sent — a 64-page tick would be one opaque round trip
// with no way to show real x/y progress. Chunking client-side into small
// sequential batches turns "silent for N seconds" into an actual progress
// bar, with no daemon change needed.
export const CONFLUENCE_IMPORT_BATCH_SIZE = 8;

/** Thrown when a batch POST fails mid-import. Earlier batches already landed
 *  server-side (no rollback — `import-confluence` writes files + the
 *  manifest per call), so this carries what succeeded so far rather than
 *  just an error string. */
export class ConfluenceImportBatchError extends Error {
  constructor(
    message: string,
    /** Aggregate response as of the LAST successful batch — `.pages` is the
     *  App's full current pool manifest (what `import-confluence` always
     *  returns), so this already reflects every page that landed. */
    public readonly partial: AppPoolImportResponse,
    /** Ids from `refs` that belonged to an already-succeeded batch — lets a
     *  caller un-tick just those and leave the rest ticked for a one-click
     *  retry of exactly the part that didn't make it. */
    public readonly succeededRefs: string[],
  ) {
    super(message);
    this.name = 'ConfluenceImportBatchError';
  }
}

/** Sequential batches of `CONFLUENCE_IMPORT_BATCH_SIZE` refs each — `onProgress`
 *  fires after every batch lands with (refs attempted so far, refs total),
 *  which is exactly the x/y a `ProgressBar` needs. Stops at the first
 *  failing batch (throws `ConfluenceImportBatchError`); does not retry or
 *  roll anything back. */
export async function importConfluenceInBatches(
  appId: string,
  refs: string[],
  onProgress?: (done: number, total: number) => void,
  /** Tập con của refs đến từ "Quét tài liệu liên quan" — daemon gắn cờ
   *  related trên manifest để UI tách nhóm. */
  relatedRefs?: string[],
): Promise<AppPoolImportResponse> {
  const total = refs.length;
  const relatedSet = new Set(relatedRefs ?? []);
  let aggregate: AppPoolImportResponse = { imported: 0, updated: 0, pages: [] };
  const succeededRefs: string[] = [];
  onProgress?.(0, total);
  for (let i = 0; i < refs.length; i += CONFLUENCE_IMPORT_BATCH_SIZE) {
    const chunk = refs.slice(i, i + CONFLUENCE_IMPORT_BATCH_SIZE);
    try {
      const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/import-confluence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: chunk, relatedRefs: chunk.filter((r) => relatedSet.has(r)) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `Nhập tài liệu thất bại (${res.status}).`);
      const batch = j as AppPoolImportResponse;
      aggregate = {
        imported: aggregate.imported + batch.imported,
        updated: aggregate.updated + batch.updated,
        // Each response already carries the FULL current manifest — the
        // latest batch's `.pages` supersedes every earlier one, not append.
        pages: batch.pages,
      };
      succeededRefs.push(...chunk);
      onProgress?.(succeededRefs.length, total);
    } catch (cause) {
      throw new ConfluenceImportBatchError(
        cause instanceof Error ? cause.message : 'Nhập tài liệu thất bại.',
        aggregate,
        succeededRefs,
      );
    }
  }
  return aggregate;
}

/** Debounced Confluence title search — same endpoint/response shape every
 *  other Confluence picker in this app consumes
 *  (`GET /api/pipelines/confluence/pages?q=`, `ConfluencePageHit[]`). `q`
 *  under 2 trimmed chars short-circuits to an idle `hits: null` — no fetch,
 *  no error. */
function useConfluenceTitleSearch(q: string): {
  hits: ConfluencePageHit[] | null;
  loading: boolean;
  error: string | null;
} {
  const [hits, setHits] = useState<ConfluencePageHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      setError(null);
      return undefined;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(query)}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
          setHits((j as { pages?: ConfluencePageHit[] }).pages ?? []);
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

/** "SPACE · <ancestor path> · id" meta line for one row — the ancestor
 *  segment renders only the last 1-2 ancestors (the direct parent, prefixed
 *  "… / " when the real path is deeper) so the one-line, ellipsis-truncated
 *  meta row stays readable; the FULL path is exposed separately as the row's
 *  `title` tooltip. `ancestors` undefined/empty (BAS-gateway fallback path,
 *  or a top-level page) falls back to today's "SPACE · id". */
function confluenceHitMeta(hit: ConfluencePageHit): { text: string; fullPath: string | null } {
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
 *  (`GET /api/pipelines/confluence/descendants?ref=`). One fetch per
 *  top-level hit returns the WHOLE sub-tree (every level, flat + treePath),
 *  so expanding a node deeper than direct children is pure client-side tree
 *  walking — no per-level re-fetch. */
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

/** Every node id in a subtree that HAS children (the node itself, if it's
 *  not a leaf, plus every non-leaf descendant) — auto-expand target: a
 *  freshly loaded subtree opens fully by default (every level), so this
 *  seeds `expandedNode` with every id a chevron could collapse. */
function collectExpandableIds(node: ConfluenceDescNode): string[] {
  if (node.children.length === 0) return [];
  return [node.id, ...node.children.flatMap(collectExpandableIds)];
}

/** Every descendant id under a node, NOT including the node itself — what a
 *  cascade-tick on this node must also add/remove from the ticked set. */
function collectDescendantIds(node: ConfluenceDescNode): string[] {
  return node.children.flatMap((c) => [c.id, ...collectDescendantIds(c)]);
}

/** Indexes every node (top-level hit AND every nested descendant) across
 *  every subtree fetched so far, by pageId — cascade-tick needs to resolve
 *  ANY ticked id (not just top-level hit ids) to its node, since the user can
 *  tick a page nested several levels deep inside an already-expanded hit. */
function buildConfluenceNodeIndex(
  descByHit: Record<string, ConfluenceDescNode | 'loading' | 'error'>,
): Map<string, ConfluenceDescNode> {
  const idx = new Map<string, ConfluenceDescNode>();
  const walk = (n: ConfluenceDescNode) => {
    idx.set(n.id, n);
    n.children.forEach(walk);
  };
  for (const tree of Object.values(descByHit)) {
    if (tree && tree !== 'loading' && tree !== 'error') walk(tree);
  }
  return idx;
}

export interface ConfluenceTreePickerProps {
  /** Explicit set of ticked Confluence page ids — parent AND every
   *  descendant tick land here individually (see `toggleNode`); no separate
   *  "implied by ancestor" bookkeeping. Controlled by the caller so it can be
   *  combined with a "Nhập N trang" button (`ConfluenceTreeImport`) or held
   *  across an App-creation submit (`NewAppModal`). */
  ticked: Set<string>;
  onTickedChange: (next: Set<string>) => void;
  /** Controlled (optional): tập pageId đã tick TỪ danh sách "Tài liệu liên
   *  quan" — subset của `ticked`. Caller giữ để gửi `relatedRefs` khi import
   *  (daemon gắn cờ related, UI pool tách nhóm "Docs liên quan"). */
  relatedTicked?: Set<string>;
  onRelatedTickedChange?: (next: Set<string>) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Passed through to the search `<input>` — lets a `FormField` render-prop
   *  wire label/hint association (see `NewAppModal`'s pre-create picker). */
  id?: string;
  'aria-describedby'?: string;
}

/** Search-by-title input + portal-rendered result tree: every rendered hit
 *  eagerly fetches its sub-tree as soon as it renders (dedup'd by id,
 *  auto-expanded), and ticking any row (hit or nested descendant) cascades
 *  the tick to its whole loaded subtree in both directions. */
export function ConfluenceTreePicker({
  ticked,
  onTickedChange,
  relatedTicked,
  onRelatedTickedChange,
  disabled,
  placeholder,
  autoFocus,
  id,
  'aria-describedby': describedBy,
}: ConfluenceTreePickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Options render through a portal — needs its own ref for the outside-click
  // check, since it's no longer a DOM descendant of wrapRef.
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Portal position, recomputed while open. Same flip-above math as
  // CustomSelect.tsx's `updatePosition` (this repo's existing portal-dropdown
  // precedent) — reused rather than reinvented.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  // Expand/collapse state shared by top-level hits AND any nested descendant
  // node (keyed by pageId) — expanding a hit for the FIRST time also
  // triggers its one-shot sub-tree fetch (see descByHit below); expanding a
  // node that's already loaded is pure local state, no fetch.
  const [expandedNode, setExpandedNode] = useState<Set<string>>(new Set());
  const [descByHit, setDescByHit] = useState<Record<string, ConfluenceDescNode | 'loading' | 'error'>>({});

  const trimmed = query.trim();
  const { hits, loading, error } = useConfluenceTitleSearch(query);
  const showFloating = open && trimmed.length >= 2;

  // ── Tài liệu liên quan (depth-1, opt-in) ─────────────────────────────────
  // Import pool KHÔNG tự follow link nữa (kéo nhầm trang nhánh wiki khác);
  // thay bằng nút quét chủ động: daemon trả các trang được LINK từ những
  // trang đã tick, user tick chọn từng trang — tick = thêm thẳng pageId vào
  // `ticked`, mọi luồng import phía sau (batch, tạo App, Sửa App) ăn nguyên.
  type RelatedPage = { pageId: string; title: string; ancestors: string[]; linkedFrom: string };
  const [related, setRelated] = useState<RelatedPage[] | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const scanRelated = async () => {
    setRelatedLoading(true);
    setRelatedError(null);
    try {
      const res = await fetch('/api/pipelines/confluence/linked-pages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [...ticked] }),
      });
      const j = (await res.json().catch(() => ({}))) as { pages?: RelatedPage[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRelated(j.pages ?? []);
    } catch (cause) {
      setRelatedError(cause instanceof Error ? cause.message : 'Không quét được tài liệu liên quan.');
    } finally {
      setRelatedLoading(false);
    }
  };
  const toggleRelated = (pageId: string) => {
    const next = new Set(ticked);
    const nextRelated = new Set(relatedTicked ?? []);
    if (next.has(pageId)) {
      next.delete(pageId);
      nextRelated.delete(pageId);
    } else {
      next.add(pageId);
      nextRelated.add(pageId);
    }
    onTickedChange(next);
    onRelatedTickedChange?.(nextRelated);
  };

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

  useLayoutEffect(() => {
    if (!showFloating) return undefined;
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [showFloating, updatePos]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // Fetch dedupe is tracked in a REF (not derived from `descByHit` state) so
  // dispatching fetches doesn't need `descByHit` as an effect dependency —
  // persists across searches: a page seen again under a different query is
  // never re-fetched.
  const dispatchedFetch = useRef<Set<string>>(new Set());
  const fetchHitSubtree = useCallback((hit: ConfluencePageHit) => {
    if (dispatchedFetch.current.has(hit.id)) return;
    dispatchedFetch.current.add(hit.id);
    setDescByHit((m) => ({ ...m, [hit.id]: 'loading' }));
    // Eager-load auto-expands from the moment the fetch is dispatched (the
    // loading row IS the "lightweight per-hit loading" indicator) — no
    // waiting for a chevron click.
    setExpandedNode((s) => new Set(s).add(hit.id));
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines/confluence/descendants?ref=${encodeURIComponent(hit.id)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        const flat = (j.pages ?? []) as Array<{ pageId: string; title: string; treePath: string[] }>;
        const tree = buildConfluenceDescTree(hit.id, hit.title, flat);
        setDescByHit((m) => ({ ...m, [hit.id]: tree }));
        // "All levels open by default": expand every internal node the fetch
        // just revealed, not only the hit's own top level.
        const ids = collectExpandableIds(tree);
        if (ids.length) setExpandedNode((s) => new Set([...s, ...ids]));
      } catch {
        setDescByHit((m) => ({ ...m, [hit.id]: 'error' }));
      }
    })();
  }, []);

  // Eager load: every rendered hit that isn't a confirmed leaf (hasChildren
  // !== false) gets its sub-tree fetched in parallel as soon as the hit list
  // renders — bounded by the search result size, no extra throttling needed.
  useEffect(() => {
    if (!hits) return;
    for (const h of hits) {
      if (h.hasChildren === false) continue;
      fetchHitSubtree(h);
    }
  }, [hits, fetchHitSubtree]);

  const toggleExpandedNode = (nodeId: string) => {
    setExpandedNode((s) => {
      const n = new Set(s);
      if (n.has(nodeId)) n.delete(nodeId);
      else n.add(nodeId);
      return n;
    });
  };

  const nodeIndex = useMemo(() => buildConfluenceNodeIndex(descByHit), [descByHit]);

  // Cascade tick: checking a node checks its whole loaded subtree too;
  // unchecking mirrors it. If the subtree isn't fetched yet, only the node's
  // own id moves — the effect below catches the subtree up once it loads.
  const toggleNode = (id: string) => {
    const node = nodeIndex.get(id);
    const descendantIds = node ? collectDescendantIds(node) : [];
    const next = new Set(ticked);
    if (next.has(id)) {
      next.delete(id);
      descendantIds.forEach((d) => next.delete(d));
    } else {
      next.add(id);
      descendantIds.forEach((d) => next.add(d));
    }
    onTickedChange(next);
  };

  // A subtree can finish loading AFTER its root was already ticked (the
  // eager fetch races the user's click) — once that data lands, cascade the
  // tick down onto whatever descendant ids are still missing so "checking a
  // parent checks its whole subtree" holds regardless of fetch timing.
  useEffect(() => {
    const missing = new Set<string>();
    for (const id of ticked) {
      const node = nodeIndex.get(id);
      if (!node) continue;
      for (const d of collectDescendantIds(node)) {
        if (!ticked.has(d)) missing.add(d);
      }
    }
    if (missing.size === 0) return;
    const next = new Set(ticked);
    missing.forEach((d) => next.add(d));
    onTickedChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIndex]);

  const renderDescNode = (node: ConfluenceDescNode, depth: number): JSX.Element => {
    const on = ticked.has(node.id);
    const isExpanded = expandedNode.has(node.id);
    const hasKids = node.children.length > 0;
    return (
      <div key={node.id}>
        <div
          className={styles.nodeRow}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => toggleNode(node.id)}
        >
          {hasKids ? (
            <button
              type="button"
              className={styles.chevron}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpandedNode(node.id);
              }}
            >
              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className={styles.chevronSpacer} aria-hidden="true" />
          )}
          <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
            {on ? <Icon name="check" size={11} /> : null}
          </span>
          <span className={styles.optionTitle}>{node.title}</span>
        </div>
        {isExpanded ? node.children.map((c) => renderDescNode(c, depth + 1)) : null}
      </div>
    );
  };

  // `hasChildren === false` (contract): confirmed leaf, no chevron, ever.
  // `hasChildren === true` or `undefined` (older daemon, "unknown"): show the
  // chevron — UNLESS we've already fetched this hit's sub-tree this session
  // and it came back empty, which reclassifies it as a leaf for the rest of
  // the session (no re-fetch, no more chevron).
  const hitShowsChevron = (h: ConfluencePageHit): boolean => {
    if (h.hasChildren === false) return false;
    const desc = descByHit[h.id];
    if (desc && desc !== 'loading' && desc !== 'error') return desc.children.length > 0;
    return true;
  };

  const renderHitRow = (h: ConfluencePageHit): JSX.Element => {
    const meta = confluenceHitMeta(h);
    const on = ticked.has(h.id);
    const isExpanded = expandedNode.has(h.id);
    const desc = descByHit[h.id];
    const showChevron = hitShowsChevron(h);
    return (
      <div key={h.id}>
        <div className={styles.hitRow} title={meta.fullPath ?? undefined} onClick={() => toggleNode(h.id)}>
          {showChevron ? (
            <button
              type="button"
              className={styles.chevron}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpandedNode(h.id);
              }}
            >
              <Icon name={desc === 'loading' ? 'spinner' : isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className={styles.chevronSpacer} aria-hidden="true" />
          )}
          <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
            {on ? <Icon name="check" size={11} /> : null}
          </span>
          <span className={styles.optionBody}>
            <span className={styles.optionTitle}>{h.title}</span>
            <span className={styles.optionMeta}>{meta.text}</span>
          </span>
        </div>
        {isExpanded && desc === 'loading' ? (
          <p className={styles.msg} style={{ paddingLeft: 30 }}>
            Đang tải…
          </p>
        ) : null}
        {isExpanded && desc === 'error' ? (
          <p className={styles.msg} style={{ paddingLeft: 30 }}>
            Không tải được trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error' && desc.children.length === 0 ? (
          <p className={styles.msg} style={{ paddingLeft: 30 }}>
            Không có trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error' ? desc.children.map((c) => renderDescNode(c, 1)) : null}
      </div>
    );
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <label className={styles.searchField}>
        <Icon name="search" size={14} />
        <input
          id={id}
          aria-describedby={describedBy}
          type="text"
          role="combobox"
          aria-expanded={showFloating}
          aria-autocomplete="list"
          autoComplete="off"
          className={styles.searchInput}
          placeholder={placeholder ?? 'Tìm trang Confluence theo tên…'}
          autoFocus={autoFocus}
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        />
      </label>
      <div className={styles.relatedWrap}>
        <button
          type="button"
          className={styles.relatedScan}
          disabled={disabled || relatedLoading || ticked.size === 0}
          title={ticked.size === 0 ? 'Tick ít nhất một trang trước rồi quét' : 'Tìm các trang được link từ những trang đã tick (depth-1)'}
          onClick={() => void scanRelated()}
        >
          <Icon name={relatedLoading ? 'spinner' : 'link'} size={13} />
          {relatedLoading ? 'Đang quét tài liệu liên quan…' : 'Quét tài liệu liên quan'}
        </button>
        {relatedError ? <p className={styles.msg}>{relatedError}</p> : null}
        {related && related.length === 0 ? (
          <p className={styles.msg}>Không tìm thấy tài liệu liên quan từ các trang đã tick.</p>
        ) : null}
        {related && related.length > 0 ? (
          <div className={styles.relatedList}>
            {related.map((r) => {
              const on = ticked.has(r.pageId);
              return (
                <div key={r.pageId} className={styles.hitRow} onClick={() => !disabled && toggleRelated(r.pageId)}>
                  <span className={styles.chevronSpacer} aria-hidden="true" />
                  <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
                    {on ? <Icon name="check" size={11} /> : null}
                  </span>
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{r.title}</span>
                    <span className={styles.optionMeta}>
                      {r.ancestors.length ? `${r.ancestors.join(' / ')} · ` : ''}nhắc tới trong “{r.linkedFrom}”
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {showFloating && pos
        ? createPortal(
            <div
              ref={dropdownRef}
              className={styles.dropdown}
              role="listbox"
              style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            >
              {loading ? (
                <p className={styles.msg}>Đang tìm…</p>
              ) : error ? (
                <p className={styles.msg}>{error}</p>
              ) : hits && hits.length > 0 ? (
                hits.map((h) => renderHitRow(h))
              ) : hits ? (
                <p className={styles.msg}>Không có trang nào khớp “{trimmed}”.</p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export interface ConfluenceTreeImportProps {
  appId: string;
  onImported: (result: AppPoolImportResponse) => void;
  /** Fired INSTEAD of `onImported` when a batch fails mid-import — whatever
   *  landed before the failing batch is already persisted server-side (no
   *  rollback). Callers should still refresh their pool view from `.pages`,
   *  but must NOT close the import panel here (unlike `onImported`'s usual
   *  side effect) — `importError` below stays visible next to the picker so
   *  the user sees what happened and can retry the leftover ticked refs. */
  onPartialImport?: (result: AppPoolImportResponse) => void;
  disabled?: boolean;
}

/** `ConfluenceTreePicker` + its own ticked-set state + a "Nhập N trang"
 *  button that imports in batches (see `importConfluenceInBatches` above,
 *  for a real x/y progress bar) — the self-contained shape every EXISTING-App
 *  import surface wants (AppPoolSection, PipelineModals.tsx's app-pool card).
 *  `NewAppModal`'s pre-create screen uses the bare `ConfluenceTreePicker`
 *  instead, since it needs to hold the ticked ids across the App-creation
 *  POST before any import call can fire (it calls `importConfluenceInBatches`
 *  directly once the App exists). */
export function ConfluenceTreeImport({ appId, onImported, onPartialImport, disabled }: ConfluenceTreeImportProps) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [relatedTicked, setRelatedTicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const importTicked = async () => {
    if (importing || ticked.size === 0) return;
    setImporting(true);
    setImportError(null);
    const refs = [...ticked];
    setImportProgress({ done: 0, total: refs.length });
    try {
      const result = await importConfluenceInBatches(appId, refs, (done, total) => setImportProgress({ done, total }), [...relatedTicked]);
      onImported(result);
      setTicked(new Set());
    } catch (cause) {
      if (cause instanceof ConfluenceImportBatchError) {
        setImportError(
          `${cause.message} (đã nhập ${cause.succeededRefs.length}/${refs.length} trang trước khi lỗi — không rollback, thử lại bên dưới để tiếp tục phần còn lại)`,
        );
        // Bỏ tick đúng những trang ĐÃ nhập; batch lỗi + phần chưa-tới-lượt vẫn
        // tick sẵn, nên bấm "Nhập" lại là retry đúng phần thiếu.
        if (cause.succeededRefs.length > 0) {
          const succeeded = new Set(cause.succeededRefs);
          setTicked((prev) => new Set([...prev].filter((id) => !succeeded.has(id))));
          onPartialImport?.(cause.partial);
        }
      } else {
        setImportError(cause instanceof Error ? cause.message : 'Nhập tài liệu thất bại.');
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const percent =
    importProgress && importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0;

  return (
    <div className={styles.wrap}>
      <ConfluenceTreePicker ticked={ticked} onTickedChange={setTicked} relatedTicked={relatedTicked} onRelatedTickedChange={setRelatedTicked} disabled={disabled || importing} />
      {ticked.size > 0 && !importing ? (
        <div className={styles.summaryRow}>
          <p className={styles.summaryText}>{ticked.size} trang đã tick</p>
          <button type="button" className={styles.primaryButton} onClick={() => void importTicked()} disabled={importing}>
            Nhập {ticked.size} trang
          </button>
        </div>
      ) : null}
      {importing && importProgress ? (
        <ProgressBar
          label={`Đang nhập tài liệu… ${importProgress.done}/${importProgress.total} trang (${percent}%)`}
          percent={percent}
        />
      ) : null}
      {importError ? <p className={styles.error}>{importError}</p> : null}
    </div>
  );
}
