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
   *  reloads, used as the expand/collapse key). Leaf nodes: `page:<pageId>`. */
  key: string;
  name: string;
  children: TreeNode[];
  /** Present on leaf nodes only — one node per pool page. */
  page?: AppPoolPage;
}

/** `page.path` is `<folder>/<sub-folder>/.../<slug>.md` (relative to the
 *  App's `docs/`) — every segment except the last is a folder level; the
 *  leaf itself renders `page.title` (not the file slug), so the extension
 *  and casing of the last segment don't matter here. */
function buildAppPoolTree(pages: AppPoolPage[]): TreeNode[] {
  const root: TreeNode = { key: '', name: '', children: [] };
  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    const folderSegments = segments.slice(0, -1);
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
    node.children.push({ key: `page:${page.pageId}`, name: page.title, children: [], page });
  }
  return root.children;
}

function collectLeafPages(node: TreeNode): AppPoolPage[] {
  if (node.page) return [node.page];
  return node.children.flatMap(collectLeafPages);
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

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const indent = 8 + depth * 16;
    if (node.page) {
      const page = node.page;
      const on = selection ? selection.ticked.has(page.path) : false;
      return (
        <div className={styles.row} style={{ paddingLeft: indent }} key={node.key}>
          <span className={styles.chevronSpacer} aria-hidden="true" />
          {selection ? (
            <button
              type="button"
              className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}
              onClick={() => toggleTick(node)}
              disabled={selection.disabled}
              aria-pressed={on}
              aria-label={`Tick trang ${page.title}`}
            >
              {on ? <Icon name="check" size={11} /> : null}
            </button>
          ) : null}
          <span className={styles.rowBody} title={page.path}>
            <span className={styles.rowTitle}>{page.title}</span>
          </span>
          <span className={`${styles.badge} ${styles[page.distill.state]}`}>{APP_POOL_STATE_LABELS[page.distill.state]}</span>
          {renderLeafActions ? renderLeafActions(page) : null}
        </div>
      );
    }
    const open = isExpanded(node.key);
    const leafPaths = selection ? collectLeafPages(node).map((p) => p.path) : [];
    const allOn = selection ? leafPaths.length > 0 && leafPaths.every((p) => selection.ticked.has(p)) : false;
    const someOn = selection ? !allOn && leafPaths.some((p) => selection.ticked.has(p)) : false;
    return (
      <div key={node.key}>
        <div className={styles.folderRow} style={{ paddingLeft: indent }}>
          <button
            type="button"
            className={styles.chevron}
            onClick={() => toggleExpanded(node.key)}
            aria-label={open ? `Thu gọn ${node.name}` : `Mở rộng ${node.name}`}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          {selection ? (
            <button
              type="button"
              className={`${styles.checkbox}${allOn ? ' ' + styles.checkboxOn : someOn ? ' ' + styles.checkboxIndeterminate : ''}`}
              onClick={() => toggleTick(node)}
              disabled={selection.disabled}
              aria-pressed={allOn}
              aria-label={`Tick cả nhánh ${node.name}`}
            >
              {allOn ? <Icon name="check" size={11} /> : null}
            </button>
          ) : null}
          <span className={styles.folderName} onClick={() => toggleExpanded(node.key)}>
            {node.name}
          </span>
        </div>
        {open ? node.children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    );
  };

  return <div className={styles.tree}>{tree.map((n) => renderNode(n, 0))}</div>;
}
