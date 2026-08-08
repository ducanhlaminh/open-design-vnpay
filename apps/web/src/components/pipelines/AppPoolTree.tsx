'use client';

// Hierarchical folder/leaf view for an App's Confluence pool — replaces the
// old flat "group by first path segment, print the full path under each
// title" rendering that used to live inline in both AppPoolSection and
// PipelineModals.tsx's "Tài liệu App" run-source card. Builds a REAL tree
// from every path segment (not just the first), reusing the
// chevron/auto-expand/cascade-tick shapes ConfluenceTreeImport.tsx already
// established for this same App-pool import UX.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppPoolPage } from '@open-design/contracts';

import { Icon } from '../Icon';
import styles from './AppPoolTree.module.css';

export const APP_POOL_STATE_LABELS: Record<AppPoolPage['distill']['state'], string> = {
  fetched: 'Đã tải',
  stale: 'Cần chưng cất lại',
  distilling: 'Đang chưng cất',
  distilled: 'Đã chưng cất',
};

interface TreeNode {
  /** Folder nodes: the accumulated `folder/sub-folder` path (stable across
   *  reloads, used as the expand/collapse key). Leaf/merged nodes:
   *  `page:<pageId>`. */
  key: string;
  /** RAW path segment — a folder's own name, or (leaf/merged nodes) the
   *  page's file slug WITHOUT `.md`. Used ONLY to detect the `x.md`/`x/`
   *  merge pairing in `mergeSiblingsAtLevel` below; never rendered directly
   *  (a page node's display text is always `page.title`). */
  name: string;
  children: TreeNode[];
  /** Present on a leaf (no children of its own) OR a MERGED node (see
   *  `mergeSiblingsAtLevel`: a page whose export paired it with a same-named
   *  sibling folder, so this node is BOTH selectable/badged AND expandable).
   *  Absent on a plain (unmerged) folder. */
  page?: AppPoolPage;
}

/** `page.path` is `<folder>/<sub-folder>/.../<slug>.md` (relative to the
 *  App's `docs/`) — every segment except the last is a folder level. Builds
 *  the raw per-page tree first (a page's own file slug ALWAYS lands as a
 *  bare leaf here, even when a same-named sibling folder exists), then
 *  merges `x.md`/`x/` pairs via `mergeSiblingsAtLevel` — see that function's
 *  docblock for why the merge is a separate bottom-up pass rather than
 *  inline while building. */
function buildAppPoolTree(pages: AppPoolPage[]): TreeNode[] {
  const root: TreeNode = { key: '', name: '', children: [] };
  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    const folderSegments = segments.slice(0, -1);
    const lastSegment = segments[segments.length - 1] ?? page.pageId;
    let node = root;
    let keyAcc = '';
    for (const seg of folderSegments) {
      keyAcc = keyAcc ? `${keyAcc}/${seg}` : seg;
      let child = node.children.find((c) => c.page === undefined && c.name === seg);
      if (!child) {
        child = { key: keyAcc, name: seg, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      key: `page:${page.pageId}`,
      name: lastSegment.replace(/\.md$/i, ''),
      children: [],
      page,
    });
  }
  return mergeAppPoolSiblings(root.children);
}

/** Within one level's children, merge each page-leaf's raw-name sibling
 *  folder into ONE node (expandable via the folder's former children, still
 *  selectable/badged via the page) — a Confluence export pairs page `x.md`
 *  with a same-level `x/` folder holding its own children/attachments, so
 *  without this the same page renders TWICE: once as the leaf, once as the
 *  folder that has nothing of its own. Matched by RAW segment name (`x`),
 *  never by `page.title` — an export's folder name is the file slug, not
 *  the page's real title, so title-matching silently misses every pairing
 *  (the exact bug the pre-revert `PipelineFormModal.tsx`'s
 *  `mergeAppFilesSiblings`/`mergeSiblingsAtLevel` — git show
 *  cfef0fe^:apps/web/src/components/pipelines/PipelineModals.tsx — already
 *  hit and fixed). Computed for ALL matches at this level FIRST (a map pass
 *  over the whole array), THEN applied — so it's order-independent: it
 *  doesn't matter whether the file leaf or the folder happened to append
 *  first while building. A page-leaf with no same-named folder (or a folder
 *  with no same-named leaf) is untouched, per spec. */
function mergeSiblingsAtLevel(children: TreeNode[]): TreeNode[] {
  const folderByName = new Map<string, TreeNode>();
  for (const c of children) if (c.page === undefined) folderByName.set(c.name, c);
  const consumedFolders = new Set<TreeNode>();
  const replacementForLeaf = new Map<TreeNode, TreeNode>();
  for (const c of children) {
    if (c.page === undefined) continue; // not a page node
    const folder = folderByName.get(c.name);
    if (!folder || consumedFolders.has(folder)) continue; // x.md without x/, or already claimed
    consumedFolders.add(folder);
    replacementForLeaf.set(c, { ...c, children: folder.children });
  }
  const result: TreeNode[] = [];
  for (const c of children) {
    if (consumedFolders.has(c)) continue; // the folder half of a merged pair — dropped
    result.push(replacementForLeaf.get(c) ?? c);
  }
  return result;
}

/** Bottom-up: recurse into every node's children FIRST (deepest `x.md`/`x/`
 *  pairs resolve before their ancestors — a merged node keeps its OWN raw
 *  `name` unchanged, so an ancestor level can still pair IT with a sibling
 *  folder the same way one level up), THEN merge raw-name pairs at this
 *  level. This merge pass must run before any future wrapper-collapse this
 *  tree might grow (a pure path-segment folder with a single child hoisted
 *  in its place) — collapsing first would let a wrapper swallow a folder
 *  BEFORE its sibling page has a chance to pair with it by name, silently
 *  breaking that pairing (see the pre-revert `collapseIfWrapper`'s docblock
 *  for the same lesson in the old file-tree). This tree doesn't implement
 *  wrapper-collapse today — noted here only so it lands in the right order
 *  if it ever does. */
function mergeAppPoolSiblings(children: TreeNode[]): TreeNode[] {
  const recursed = children.map((c) =>
    c.children.length > 0 ? { ...c, children: mergeAppPoolSiblings(c.children) } : c,
  );
  return mergeSiblingsAtLevel(recursed);
}

/** Every page under a node's subtree — its OWN page (a leaf, or a node
 *  MERGED with its raw-name sibling folder) PLUS every descendant's, so a
 *  merged node's checkbox toggles "itself + everything beneath it" in one
 *  click, same cascade semantics a plain folder already had. */
function collectLeafPages(node: TreeNode): AppPoolPage[] {
  const own = node.page ? [node.page] : [];
  return [...own, ...node.children.flatMap(collectLeafPages)];
}

export interface AppPoolTreeProps {
  pages: AppPoolPage[];
  /** Present → every row (leaf AND folder, cascading) gets a tick checkbox
   *  keyed by `page.path` — the shape PipelineModals.tsx's "Tài liệu App" run
   *  source card needs (tick pages to include in the run). Absent → pure
   *  browse (AppPoolSection): folders are chevron-only, no checkbox. */
  selection?: {
    ticked: Set<string>;
    onToggle: (next: Set<string>) => void;
    /** Mirrors the old per-checkbox `disabled={busy}` (RunAllModal mid-submit) —
     *  ticking is locked while true; expand/collapse stays live (browsing the
     *  tree doesn't mutate anything). */
    disabled?: boolean;
  };
  /** Per-leaf trailing action slot (AppPoolSection's delete button). */
  renderLeafActions?: (page: AppPoolPage) => ReactNode;
}

/** Cascade tick: ticking a folder ticks every leaf page under it (all
 *  levels); unticking mirrors it. Mixed state (some but not all leaves
 *  ticked) reads as "off" for the click decision (tapping it fills the rest
 *  in, same as an indeterminate checkbox committing to "on" on click). */
export function AppPoolTree({ pages, selection, renderLeafActions }: AppPoolTreeProps) {
  const tree = useMemo(() => buildAppPoolTree(pages), [pages]);
  // Seeded ONCE (first non-empty tree) with every top-level folder key, per
  // "mặc định cấp 1 mở, sâu hơn đóng" — a later pool refresh (distill
  // polling, a fresh import) must not stomp on folders the user has since
  // toggled, so this never re-seeds after that first pass.
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (expanded === null && tree.length > 0) {
      setExpanded(new Set(tree.map((n) => n.key)));
    }
  }, [tree, expanded]);

  const isExpanded = (key: string) => expanded?.has(key) ?? false;
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleTick = (node: TreeNode) => {
    if (!selection || selection.disabled) return;
    const leafPaths = collectLeafPages(node).map((p) => p.path);
    if (leafPaths.length === 0) return;
    const allOn = leafPaths.every((p) => selection.ticked.has(p));
    const next = new Set(selection.ticked);
    if (allOn) leafPaths.forEach((p) => next.delete(p));
    else leafPaths.forEach((p) => next.add(p));
    selection.onToggle(next);
  };

  // Unified row: whether a chevron shows depends on `node.children.length`
  // (NOT on `node.page`) and whether a badge/delete-button/checkbox-by-path
  // shows depends on `node.page` (NOT on children) — the two used to be
  // mutually exclusive (a node was either a childless page leaf or a
  // page-less folder), but a MERGED node (see `mergeSiblingsAtLevel`) is
  // BOTH: expandable via the folder half it absorbed, selectable/badged via
  // the page half. A plain leaf or plain folder still renders exactly as
  // before — this only ADDS the merged case, it doesn't change either of
  // the other two.
  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const indent = 8 + depth * 16;
    const hasChildren = node.children.length > 0;
    const open = isExpanded(node.key);
    // `collectLeafPages` already returns "own page (if any) + every
    // descendant page" — so this ONE formula covers a plain leaf's own tick
    // state, a plain folder's cascade state, AND a merged node's "self +
    // subtree" state identically (see that function's docblock).
    const leafPaths = selection ? collectLeafPages(node).map((p) => p.path) : [];
    const allOn = selection ? leafPaths.length > 0 && leafPaths.every((p) => selection.ticked.has(p)) : false;
    const someOn = selection ? !allOn && leafPaths.some((p) => selection.ticked.has(p)) : false;
    const displayName = node.page ? node.page.title : node.name;
    return (
      <div key={node.key}>
        <div className={node.page ? styles.row : styles.folderRow} style={{ paddingLeft: indent }}>
          {hasChildren ? (
            <button
              type="button"
              className={styles.chevron}
              onClick={() => toggleExpanded(node.key)}
              aria-label={open ? `Thu gọn ${displayName}` : `Mở rộng ${displayName}`}
            >
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className={styles.chevronSpacer} aria-hidden="true" />
          )}
          {selection ? (
            <button
              type="button"
              className={`${styles.checkbox}${allOn ? ' ' + styles.checkboxOn : someOn ? ' ' + styles.checkboxIndeterminate : ''}`}
              onClick={() => toggleTick(node)}
              disabled={selection.disabled}
              aria-pressed={allOn}
              aria-label={node.page ? `Tick trang ${displayName}` : `Tick cả nhánh ${displayName}`}
            >
              {allOn ? <Icon name="check" size={11} /> : null}
            </button>
          ) : null}
          {node.page ? (
            <span className={styles.rowBody} title={node.page.path}>
              <span className={styles.rowTitle}>{displayName}</span>
            </span>
          ) : (
            <span className={styles.folderName} onClick={() => toggleExpanded(node.key)}>
              {displayName}
            </span>
          )}
          {node.page ? (
            <span className={`${styles.badge} ${styles[node.page.distill.state]}`}>
              {APP_POOL_STATE_LABELS[node.page.distill.state]}
            </span>
          ) : null}
          {/* Deleting a merged node only removes ITS page — never its
              absorbed children, per spec ("không đụng con"). */}
          {node.page && renderLeafActions ? renderLeafActions(node.page) : null}
        </div>
        {open ? node.children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    );
  };

  return <div className={styles.tree}>{tree.map((n) => renderNode(n, 0))}</div>;
}
