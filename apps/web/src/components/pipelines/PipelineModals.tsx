// The four Pipelines-surface modals, kept presentational: data/API logic lives
// in PipelinesView (the single owner of pipeline + project state). Each modal
// takes async submit callbacks and only owns its own busy/error UI.
//
// - RunInputModal:          collect a run input (e.g. Confluence link) before
//                            running a pipeline that declares inputPlaceholder (Req 4).
// - PipelineStatusModal:     poll GET /api/runs/:id and show compact status (Req 3).
// - PipelineResultModal:     preview a finished pipeline's output files inline
//                            (file rail + embedded FileViewer), no workspace nav.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppPoolPage,
  AppPoolResponse,
  AppContextManifest,
  FeatureContextBinding,
  BasDocument,
  BasDocumentsResponse,
  BasFeature,
  BasFeaturesResponse,
  ChatRunStatusResponse,
  DesignSystemSummary,
  PipelineRunSource,
  PipelineAppsResponse,
  PipelineStatus,
  ProjectSyncOrigin,
  ProjectSyncOriginSelection,
  ProjectSyncOperation,
  PipelineView,
  ProjectFile,
  ProjectSyncStatus,
  RemoteProjectSummary,
  RunAllConfig,
  TargetPlatform,
  UiTarget,
  Workflow,
} from '@open-design/contracts';
import { UI_TARGET_IDS, UI_TARGETS } from '@open-design/contracts';
import type { TrackingProjectKind } from '@open-design/contracts/analytics';

import { Icon, type IconName } from '../Icon';
import { FileViewer } from '../FileViewer';
import { useT } from '../../i18n';
import { relativeTimeLong } from '../../utils/chatTime';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';
import { AppPoolTree } from './AppPoolTree';
import { PlModal } from './PlModal';
import { UploadDropzone, toPendingFiles, type PendingFile } from './UploadDropzone';
import { ConfluenceTreeImport } from './ConfluenceTreeImport';
import { ProgressBar } from './ProgressBar';
import styles from './PipelineSourceModal.module.css';
import sp from './StagePicker.module.css';
import { accessRoleLabel, projectTransferLabel, stepDifferenceLabel, SYNC_COPY } from './sync-copy';
import {
  contextNeedsUpdate,
  contextVersionsForSelection,
  contextVersionLabel,
  diffContextManifests,
  emptyContextSelection,
  featureHasNewContext,
  selectionForFeatures,
  serializeContextSelection,
  type AppContextSyncInfo,
  type ContextFileChange,
  type ContextTreeApp,
  type ContextTreeSelection,
  type ContextTreeSelectionPayload,
} from './context-sync-tree';

/** What the run-source modal hands back: either a structured BAS/Confluence
 * source (pre-fetched by the daemon) or free-text `input` — newline-joined
 * Confluence page URL/ids for the docs stage's deterministic fetch. */
export interface RunSourcePayload {
  source?: PipelineRunSource;
  input?: string;
  /** false → docs stage fetches ONLY the picked pages (no link-follow). */
  followLinks?: boolean;
  /** true → docs stage also scans the whole sub-tree under each seed page. */
  includeDescendants?: boolean;
  /** UI targets picked at the docs step (docs-to-ui): the daemon records them
   *  as docs-to-ui/targets.json so the post-docs stages know which products to
   *  build. Empty/omitted → single build (legacy). */
  targets?: UiTarget[];
}

/** Shared "fetch cả trang được link" toggle (docs stage, deterministic path). */
function FollowLinksToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="pl-runall-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
        disabled={disabled}
      />
      <span className="pl-runall-toggle__body">
        <span className="pl-runall-toggle__title">Fetch cả trang được link (depth 1)</span>
        <span className="pl-runall-toggle__desc">
          Trang spec thường dẫn chiếu tài liệu khác (BO spec, logic dùng chung…) — daemon fetch luôn
          các trang mà trang nguồn link tới (cùng wiki, tối đa 15 trang) và rewrite link chéo thành
          link file nội bộ. Bỏ tick nếu chỉ cần đúng các trang đã chọn.
        </span>
      </span>
    </label>
  );
}

/** Shared "fetch cả cây con" toggle. Distinct from FollowLinksToggle: that one
 *  follows HYPERLINKS out of the seed page (depth 1, any parent); this one walks
 *  the page TREE under each seed (every level). Folder-structured specs put the
 *  detail on child pages that nothing links to, so link-follow alone misses them.
 *  Honoured only on the deterministic Confluence path (`runDocsDeterministic`). */
function IncludeDescendantsToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="pl-runall-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
        disabled={disabled}
      />
      <span className="pl-runall-toggle__body">
        <span className="pl-runall-toggle__title">Fetch cả cây con của trang đã chọn</span>
        <span className="pl-runall-toggle__desc">
          Spec hay tổ chức theo thư mục: trang cha chỉ là mục lục, nội dung nằm ở các trang con (mọi
          cấp) mà không trang nào link tới. Tick để daemon quét trọn sub-tree dưới mỗi trang đã chọn
          — số trang có thể lớn, chỉ bật khi trang cha đúng là một thư mục.
        </span>
      </span>
    </label>
  );
}

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
};

// Mirror of the daemon's apps/daemon/src/pipelines.ts `outputMatches`. Kept in
// sync by hand (the patterns are stable); used to attribute a project file to a
// pipeline stage from its declared `outputs` globs. Exported so
// tests/components/pipelines/pipeline-result-files.test.ts can pin the
// workflow-id-mirror invariant directly (must_not: no behavior change).
export function outputMatches(rel: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*') || pattern.startsWith('-')) {
    return rel.endsWith(pattern.startsWith('*') ? pattern.slice(1) : pattern);
  }
  return rel === pattern || rel.endsWith('/' + pattern);
}

// Mirror of the daemon's `splitWorkflowPath` (pipelines.ts): every pipeline
// writes under its workflow folder — `docs-to-ui/…` and `docs-to-prd/…` today,
// `docs-to-html/…` / `docs-to-react/…` on projects from before the 2026-07
// merge — while the stage `outputs` patterns are workflow-RELATIVE. Strip the
// folder before matching; without this, folder patterns (`prototype/`,
// `docs/jira/`, `react/`, `review/`, …) never match and Quick result reports
// "No output files yet" for stages that plainly succeeded. Legacy unprefixed
// paths pass through unchanged. MUST be kept in sync with daemon `WORKFLOWS`
// (pipelines.ts) — every workflow id added there needs its id added here too.
const WORKFLOW_DIR_RE = /^(docs-to-ui|docs-to-prd|docs-review|ds-lab|docs-to-html|docs-to-react)\//;
// Every folder head the daemon may prefix an output with. A file whose first
// segment is NOT one of these has no workflow prefix (legacy flat output).
const KNOWN_WORKFLOW_DIRS = new Set(['docs-to-ui', 'docs-to-prd', 'docs-review', 'ds-lab', 'docs-to-html', 'docs-to-react']);
// A workflow's outputs may live under its own id OR a retired twin's folder head
// (LEGACY_WORKFLOW_DIRS in pipelines.ts): docs-to-html / docs-to-react were
// merged into docs-to-ui and old projects keep those prefixes on disk.
const WORKFLOW_DIR_ALIASES: Record<string, string[]> = {
  'docs-to-ui': ['docs-to-ui', 'docs-to-html', 'docs-to-react'],
};
/** Whether a cwd-relative file belongs to the given workflow's output tree.
 *  Files with a foreign workflow prefix (e.g. docs-to-prd docs when the open
 *  Quick result is a docs-to-ui stage) are excluded so the rail shows only the
 *  workflow you opened; unprefixed legacy files stay (can't be attributed). */
function fileInWorkflow(rel: string, workflowId: string | undefined): boolean {
  if (!workflowId) return true;
  const head = rel.split('/')[0] ?? '';
  if (!KNOWN_WORKFLOW_DIRS.has(head)) return true;
  const allowed = WORKFLOW_DIR_ALIASES[workflowId] ?? [workflowId];
  return allowed.includes(head);
}
// Multi-target subfolder (mirrors the daemon's UI_TARGET_DIRS): a per-target
// build nests post-docs outputs under <workflow>/<target>/, so both this
// segment and the workflow prefix are stripped before output-pattern matching.
const UI_TARGET_SEG_RE = /^(mobile|web-user|web-backoffice)\//;
/** The multi-target segment of a cwd-relative file (`<workflow>/<target>/…`),
 *  or null when it's a shared (docs) / single-build file. */
function targetOfFile(rel: string): UiTarget | null {
  const m = UI_TARGET_SEG_RE.exec(rel.replace(WORKFLOW_DIR_RE, ''));
  return m ? (m[1] as UiTarget) : null;
}
// Exported for the same test-pinning reason as `outputMatches` above.
export function stripWorkflowDir(rel: string): string {
  return rel.replace(WORKFLOW_DIR_RE, '').replace(UI_TARGET_SEG_RE, '');
}

/** Drop the per-target COPIES of shared docs. A multi-target build stages a
 *  byte-identical copy of the shared docs into every target's cwd
 *  (`<workflow>/<target>/docs/…`) so target-scoped skills can read `./docs`
 *  (see apps/daemon/src/server.ts run-all). Those copies double the rail. When
 *  a shared root-level original exists (target === null) we keep ONLY it and
 *  drop the copies. Genuine per-target outputs (screens) have NO root twin, so
 *  every target's file is kept and the target tabs still work. */
function dropSharedTargetCopies(list: ProjectFile[]): ProjectFile[] {
  const sharedKeys = new Set(
    list.filter((f) => targetOfFile(f.name) === null).map((f) => stripWorkflowDir(f.name)),
  );
  if (sharedKeys.size === 0) return list;
  return list.filter((f) => targetOfFile(f.name) === null || !sharedKeys.has(stripWorkflowDir(f.name)));
}

// ── Source-order sort for doc pages ───────────────────────────────────────
// Confluence pages are numbered like "I. …" (roman sections) / "1.", "2.2.3."
// (arabic sub-pages); a plain string sort mangles that (IX before V, "10"
// before "2"). Compare each path segment by its LEADING numbering token so the
// listing matches the wiki's sidebar order.
function romanToInt(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = map[s[i]!] ?? 0;
    if (v < prev) total -= v;
    else { total += v; prev = v; }
  }
  return total;
}
/** Leading numbering of a path segment → number tuple, or null if unnumbered. */
function segNumbering(seg: string): number[] | null {
  const m = /^([IVXLCDM]+|\d+(?:\.\d+)*)(?=[.\-\s]|$)/.exec(seg.trim());
  if (!m) return null;
  const tok = m[1]!;
  return /^[IVXLCDM]+$/.test(tok) ? [romanToInt(tok)] : tok.split('.').map(Number);
}
function naturalPathCompare(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const sa = as[i] ?? '';
    const sb = bs[i] ?? '';
    if (sa === sb) continue;
    const ka = segNumbering(sa);
    const kb = segNumbering(sb);
    if (ka && kb) {
      for (let j = 0; j < Math.max(ka.length, kb.length); j++) {
        const d = (ka[j] ?? 0) - (kb[j] ?? 0);
        if (d !== 0) return d;
      }
    } else if (ka && !kb) return -1; // numbered pages before unnumbered
    else if (!ka && kb) return 1;
    const c = sa.localeCompare(sb);
    if (c !== 0) return c;
  }
  return 0;
}

// ── Req 4: Run source (Confluence link or BAS document) ──────────────────────
// Pipeline 1 (confluence-ingest) ingests its source docs from Confluence
// (deterministic REST fetch, no agent) or the BAS MCP gateway. The user picks
// ONE of two cards:
//   • Confluence — paste a page URL/id; a preview panel shows the page metadata
//     fetched via the daemon's BAS proxy.
//   • BAS — pick a BAS workspace, then check the feature(s)/document(s) to ingest.
// The daemon pre-fetches the choice into the project cwd before the run. WP8
// (2026-08) removed the legacy free-text JIRA key / JQL "Advanced" path — this
// pipeline only ever takes a Confluence URL now.
type SourceKind = 'confluence' | 'bas';

export interface ConfluencePageRefLike {
  id?: string;
  title?: string;
  url?: string;
}

const confPageKey = (p: ConfluencePageRefLike) => p.id ?? p.url ?? '';

/** A node in the Confluence page tree the picker renders. */
interface ConfTreeNode {
  id: string;
  title: string;
  url?: string;
  children: ConfTreeNode[];
}
interface ConfDescendant {
  pageId: string;
  title: string;
  /** Ancestor titles between the search hit (root) and this page, top→down. */
  treePath: string[];
}

/** Build a nested tree for a search hit from the flat descendant list (each
 *  carrying its treePath of ancestor titles). Intermediate folder nodes are
 *  created from the title path and back-filled with their real pageId when
 *  their own descendant entry is processed (every ancestor is itself a
 *  descendant of the hit, so all nodes get an id). */
function buildConfTree(
  hit: { id: string; title: string; url?: string },
  descendants: ConfDescendant[],
): ConfTreeNode {
  const root: ConfTreeNode = { id: hit.id, title: hit.title, ...(hit.url ? { url: hit.url } : {}), children: [] };
  const childByTitle = (parent: ConfTreeNode, title: string): ConfTreeNode => {
    let n = parent.children.find((c) => c.title === title);
    if (!n) {
      n = { id: '', title, children: [] };
      parent.children.push(n);
    }
    return n;
  };
  for (const d of descendants) {
    let node = root;
    for (const seg of d.treePath) node = childByTitle(node, seg);
    const leaf = childByTitle(node, d.title);
    leaf.id = d.pageId;
  }
  // Drop any node that never got a real id (shouldn't happen, but keep it safe).
  const prune = (n: ConfTreeNode): void => {
    n.children = n.children.filter((c) => c.id);
    n.children.forEach(prune);
  };
  prune(root);
  return root;
}

/** All ids in a subtree (the node + every descendant). */
function confSubtreeIds(node: ConfTreeNode): string[] {
  return [node.id, ...node.children.flatMap(confSubtreeIds)];
}

/** Picker trang Confluence DÙNG CHUNG (modal Run bước Docs + modal Chạy full
 * workflow): tìm trang theo tên qua GET /api/pipelines/confluence/pages (tick
 * chọn nhiều), hoặc dán link/page id (mỗi dòng một trang — tự thêm vào danh
 * sách khi rời ô nhập). Parent chỉ giữ danh sách `pages`; mọi state tìm kiếm
 * sống trong picker. */
export function ConfluencePagePicker({
  pages,
  onPagesChange,
}: {
  pages: ConfluencePageRefLike[];
  onPagesChange: (pages: ConfluencePageRefLike[]) => void;
}) {
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; title: string; url?: string; space?: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  // Tree state: a search hit expands into its Confluence sub-tree (fetched once),
  // rendered as a checkbox tree so a parent folder can be checked wholesale.
  const [treeByHit, setTreeByHit] = useState<Record<string, ConfTreeNode>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeLoading, setTreeLoading] = useState<Set<string>>(new Set());
  const [treeErr, setTreeErr] = useState<Record<string, string>>({});
  // STAGING: ticks in the tree collect here first — nothing enters the "Đã chọn"
  // list until the user presses "Thêm". Keyed by page id → the ref to commit.
  const [staged, setStaged] = useState<Record<string, ConfluencePageRefLike>>({});
  const committedIds = useMemo(() => new Set(pages.map((p) => p.id).filter(Boolean) as string[]), [pages]);

  const loadTree = (hit: { id: string; title: string; url?: string }) => {
    if (treeByHit[hit.id] || treeLoading.has(hit.id)) return;
    setTreeLoading((s) => new Set(s).add(hit.id));
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines/confluence/descendants?ref=${encodeURIComponent(hit.id)}`);
        const j = (await res.json().catch(() => ({}))) as { pages?: ConfDescendant[]; error?: string };
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setTreeByHit((m) => ({ ...m, [hit.id]: buildConfTree(hit, j.pages ?? []) }));
      } catch (err) {
        setTreeErr((m) => ({ ...m, [hit.id]: err instanceof Error ? err.message : String(err) }));
      } finally {
        setTreeLoading((s) => {
          const n = new Set(s);
          n.delete(hit.id);
          return n;
        });
      }
    })();
  };
  const toggleExpand = (hit: { id: string; title: string; url?: string }, nodeId: string) => {
    if (nodeId === hit.id) loadTree(hit);
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(nodeId)) n.delete(nodeId);
      else n.add(nodeId);
      return n;
    });
  };
  // A node counts as "on" if already committed (in Đã chọn) OR staged (ticked,
  // pending Thêm). Tristate over the whole subtree.
  const isOn = (id: string) => committedIds.has(id) || Boolean(staged[id]);
  const nodeCheck = (node: ConfTreeNode): 'on' | 'off' | 'partial' => {
    const ids = confSubtreeIds(node);
    const on = ids.filter(isOn).length;
    return on === 0 ? 'off' : on === ids.length ? 'on' : 'partial';
  };
  // Ticking a node STAGES its whole subtree (already-committed pages are left as
  // is — remove those from the Đã chọn list instead).
  const toggleSubtree = (node: ConfTreeNode) => {
    const collect = (n: ConfTreeNode): ConfTreeNode[] => [n, ...n.children.flatMap(collect)];
    const stageable = collect(node).filter((n) => !committedIds.has(n.id));
    if (!stageable.length) return;
    const allStaged = stageable.every((n) => staged[n.id]);
    setStaged((prev) => {
      const next = { ...prev };
      for (const n of stageable) {
        if (allStaged) delete next[n.id];
        else next[n.id] = { id: n.id, title: n.title, ...(n.url ? { url: n.url } : {}) };
      }
      return next;
    });
  };
  const stagedList = Object.values(staged);
  const addStaged = () => {
    if (!stagedList.length) return;
    const existing = new Set(pages.map(confPageKey));
    onPagesChange([...pages, ...stagedList.filter((s) => !existing.has(confPageKey(s)))]);
    setStaged({});
  };

  useEffect(() => {
    if (manual) return;
    clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      setSearchErr(null);
      void (async () => {
        try {
          const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(query.trim())}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          setHits((j as { pages?: Array<{ id: string; title: string; url?: string; space?: string }> }).pages ?? []);
        } catch (err) {
          setSearchErr(err instanceof Error ? err.message : String(err));
          setHits([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [query, manual]);

  const renderConfNode = (
    node: ConfTreeNode,
    hit: { id: string; title: string; url?: string },
    depth: number,
  ): JSX.Element => {
    const cs = nodeCheck(node);
    const isHit = node.id === hit.id;
    const isExp = expanded.has(node.id);
    const hitLoaded = Boolean(treeByHit[hit.id]);
    // A hit shows a chevron until we know whether it has children; inner nodes
    // show one only when they actually do.
    const hasKids = node.children.length > 0 || (isHit && !hitLoaded);
    const committed = committedIds.has(node.id);
    return (
      <div key={node.id || node.title}>
        <div className={styles.treeRow} style={{ paddingLeft: 10 + depth * 22 }} onClick={() => toggleSubtree(node)}>
          {hasKids ? (
            <button
              type="button"
              className={styles.treeChevron}
              onClick={(e) => {
                e.stopPropagation();
                if (isHit) toggleExpand(hit, node.id);
                else setExpanded((s) => { const n = new Set(s); n.has(node.id) ? n.delete(node.id) : n.add(node.id); return n; });
              }}
              title={isExp ? 'Thu gọn' : 'Mở rộng'}
            >
              <Icon name={isHit && treeLoading.has(hit.id) ? 'spinner' : isExp ? 'chevron-down' : 'chevron-right'} size={13} />
            </button>
          ) : (
            <span className={styles.treeSpacer} aria-hidden="true" />
          )}
          <span className={`${styles.treeCheck}${cs === 'on' ? ' ' + styles.treeCheckOn : ''}${cs === 'partial' ? ' ' + styles.treeCheckPartial : ''}`}>
            {cs === 'on' ? <Icon name="check" size={12} /> : cs === 'partial' ? <Icon name="minus" size={12} /> : null}
          </span>
          <span className={`${styles.treeName}${hasKids ? ' ' + styles.treeNameFolder : ''}`}>{node.title}</span>
          {committed ? <span className={styles.treeAdded}>đã thêm</span> : null}
        </div>
        {isExp && isHit && treeErr[hit.id] ? (
          <div className={styles.treeMsg} style={{ paddingLeft: 10 + (depth + 1) * 22 }}>{treeErr[hit.id]}</div>
        ) : null}
        {isExp && node.children.length ? node.children.map((c) => renderConfNode(c, hit, depth + 1)) : null}
        {isExp && isHit && hitLoaded && node.children.length === 0 ? (
          <div className={styles.treeMsg} style={{ paddingLeft: 10 + (depth + 1) * 22 }}>Không có trang con.</div>
        ) : null}
      </div>
    );
  };

  // Dán tay: commit khi blur HOẶC bấm Thêm — không bắt user nhớ bấm nút để
  // khỏi mất text khi chuyển thẳng sang Run.
  const commitManual = (backToSearch: boolean) => {
    const refs = manualText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length) {
      const existing = new Set(pages.map(confPageKey));
      onPagesChange([
        ...pages,
        ...refs
          .filter((r) => !existing.has(r))
          .map((r) => (/^https?:\/\//i.test(r) ? { url: r } : { id: r })),
      ]);
      setManualText('');
    }
    if (backToSearch) setManual(false);
  };

  return (
    <div className={styles.panel}>
      {/* các trang đã chọn — gỡ từng trang */}
      {pages.length > 0 ? (
        <>
          <span className={styles.sectionLabel}>Đã chọn ({pages.length})</span>
          <div className={styles.list}>
            {pages.map((p) => (
              <button
                key={confPageKey(p)}
                type="button"
                className={`${styles.row} ${styles.rowSelected}`}
                onClick={() => onPagesChange(pages.filter((x) => confPageKey(x) !== confPageKey(p)))}
                title="Bấm để bỏ trang này"
              >
                <span className={`${styles.checkbox} ${styles.checkboxOn}`}>
                  <Icon name="close" size={11} />
                </span>
                <span className={styles.rowBody}>
                  <span className={styles.rowName}>{p.title ?? p.url ?? p.id}</span>
                  {p.id ? <span className={styles.rowSummary}>{p.id}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {manual ? (
        <>
          <label className="pl-modal-field">
            <span className="pl-modal-field__label">Dán link / page id</span>
            <textarea
              className="pl-input"
              rows={3}
              autoFocus
              placeholder={'https://wiki…/pages/123456 hoặc page id\n(mỗi dòng một trang)'}
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              onBlur={() => commitManual(false)}
            />
          </label>
          <div className={styles.footerLinks}>
            <button
              type="button"
              className="pl-btn pl-btn--primary"
              onClick={() => commitManual(true)}
              disabled={!manualText.trim()}
            >
              <Icon name="plus" size={13} />
              <span>Thêm vào danh sách</span>
            </button>
            <button type="button" className={styles.linkBtn} onClick={() => setManual(false)}>
              ← Quay lại tìm theo tên
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="pl-modal-field">
            <span className="pl-modal-field__label">Tìm trang Confluence</span>
            <input
              type="text"
              className="pl-input"
              placeholder="Gõ tên trang để tìm — tick trang/thư mục rồi bấm Thêm…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {searching ? (
            <p className={styles.empty}>Đang tìm…</p>
          ) : searchErr ? (
            <p className={styles.empty}>{searchErr}</p>
          ) : hits !== null ? (
            hits.length === 0 ? (
              <p className={styles.empty}>Không trang nào khớp “{query}”.</p>
            ) : (
              <>
                <div className={styles.tree}>
                  {hits.map((h) =>
                    renderConfNode(treeByHit[h.id] ?? { id: h.id, title: h.title, ...(h.url ? { url: h.url } : {}), children: [] }, h, 0),
                  )}
                </div>
                <p className={styles.treeHint}>
                  Bấm ▸ để xem trang con · tick thư mục cha để chọn cả nhánh · rồi bấm “Thêm”.
                </p>
              </>
            )
          ) : null}
          {stagedList.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <button type="button" className="pl-btn pl-btn--primary" onClick={addStaged}>
                <Icon name="plus" size={13} />
                <span>Thêm {stagedList.length} trang vào danh sách</span>
              </button>
              <button type="button" className={styles.linkBtn} onClick={() => setStaged({})}>
                Bỏ tick
              </button>
            </div>
          ) : null}
          <div className={styles.footerLinks}>
            <button type="button" className={styles.linkBtn} onClick={() => setManual(true)}>
              Dán link / page id thay vì tìm →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// UI-target selector cards, shared by the docs-step Run modal and the Run-all
// modal. Multi-select (mobile / web-user / web-backoffice).
const TARGET_DESC: Record<UiTarget, string> = {
  mobile: 'App điện thoại — màn dọc.',
  'web-user': 'Website cho người dùng cuối.',
  'web-backoffice': 'Website backoffice cho nhân viên/quản trị.',
};
export function toggleTargetIn(list: UiTarget[], t: UiTarget): UiTarget[] {
  return list.includes(t) ? list.filter((x) => x !== t) : [...list, t];
}
function TargetCards({ targets, onToggle }: { targets: UiTarget[]; onToggle: (t: UiTarget) => void }) {
  return (
    <div className={styles.cards} role="group" aria-label="UI targets">
      {UI_TARGET_IDS.map((t) => {
        const def = UI_TARGETS[t];
        const on = targets.includes(t);
        return (
          <button
            key={t}
            type="button"
            role="checkbox"
            aria-checked={on}
            className={`${styles.card}${on ? ' ' + styles.cardSelected : ''}`}
            onClick={() => onToggle(t)}
          >
            <span className={styles.cardTop}>
              <Icon name={def.platform === 'mobile' ? 'home' : 'grid'} size={16} />
              {def.label}
              {on ? (
                <span className={styles.cardCheck} aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              ) : null}
            </span>
            <span className={styles.cardDesc}>{TARGET_DESC[t]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RunInputModal({
  pipelineName,
  placeholder,
  defaultConfluencePages,
  defaultBasDocumentId,
  showTargets = false,
  defaultTargets,
  onClose,
  onRun,
}: {
  pipelineName: string;
  placeholder: string;
  /** Nguồn cấu hình sẵn từ Pipeline Studio (project.json) — tick sẵn các
   *  trang, user vẫn thêm/bớt được cho từng lần chạy. Có basDocumentId → mở
   *  sẵn nhánh BAS với tài liệu đó được chọn. */
  defaultConfluencePages?: ConfluencePageRefLike[];
  defaultBasDocumentId?: string;
  /** docs-to-ui only: show the UI-target multi-select on the docs step so the
   *  daemon can write targets.json when the docs run starts. */
  showTargets?: boolean;
  defaultTargets?: UiTarget[];
  onClose: () => void;
  onRun: (payload: RunSourcePayload) => Promise<void>;
}) {
  // Nguồn BAS đang khóa bảo trì: luôn khởi tạo ở Confluence, kể cả khi config
  // dự án từ studio có sẵn basDocumentId (nó vẫn được giữ trong project.json —
  // mở khóa là dùng lại được).
  const [kind, setKind] = useState<SourceKind>('confluence');

  // Confluence branch — dùng picker chung ConfluencePagePicker (tìm theo tên +
  // dán link, tick chọn nhiều). Seeded từ config dự án trên studio.
  const [confPages, setConfPages] = useState<ConfluencePageRefLike[]>(defaultConfluencePages ?? []);
  const [followLinks, setFollowLinks] = useState(true);
  const [includeDescendants, setIncludeDescendants] = useState(false);
  // docs-to-ui: which UI products to build. Recorded as targets.json when the
  // docs run starts. Default to the last run's targets, else a single mobile app.
  const [targets, setTargets] = useState<UiTarget[]>(
    defaultTargets && defaultTargets.length ? defaultTargets : ['mobile'],
  );

  // BAS branch (KG document → feature)
  const [basDocuments, setBasDocuments] = useState<BasDocument[] | null>(null);
  const [basDocLoading, setBasDocLoading] = useState(false);
  const [basDocumentId, setBasDocumentId] = useState('');
  const [basFeatures, setBasFeatures] = useState<BasFeature[] | null>(null);
  const [basFeatLoading, setBasFeatLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load BAS documents the first time the BAS card is shown.
  useEffect(() => {
    if (kind !== 'bas' || basDocuments !== null || basDocLoading) return;
    setBasDocLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch('/api/pipelines/bas/documents');
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `BAS documents: ${res.status}`);
        setBasDocuments((j as BasDocumentsResponse).documents ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBasDocuments([]);
      } finally {
        setBasDocLoading(false);
      }
    })();
  }, [kind, basDocuments, basDocLoading]);

  const loadFeatures = async (docId: string) => {
    setBasDocumentId(docId);
    setSelected(new Set());
    setBasFeatures(null);
    setBasFeatLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/bas/documents/${encodeURIComponent(docId)}/features`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `BAS features: ${res.status}`);
      setBasFeatures((j as BasFeaturesResponse).features ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBasFeatures([]);
    } finally {
      setBasFeatLoading(false);
    }
  };

  // Preselect the studio-configured BAS document once the document list is in:
  // pick it + load its features, exactly as if the user clicked it.
  useEffect(() => {
    if (kind !== 'bas' || !defaultBasDocumentId || basDocuments === null) return;
    if (basDocumentId || basFeatures !== null || basFeatLoading) return;
    if (!basDocuments.some((d) => d.id === defaultBasDocumentId)) return;
    void loadFeatures(defaultBasDocumentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, defaultBasDocumentId, basDocuments, basDocumentId, basFeatures, basFeatLoading]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canRun = kind === 'confluence' ? confPages.length > 0 : basDocumentId.length > 0; // features optional → whole document

  const submit = async () => {
    if (busy || !canRun) return;
    setBusy(true);
    setError(null);
    try {
      let payload: RunSourcePayload;
      if (kind === 'confluence') {
        // One page URL/id per line. When every line parses to a page id the
        // daemon runs the docs stage DETERMINISTICALLY (fetches the pages
        // itself via the BAS gateway — no agent). A short-link/opaque URL that
        // doesn't parse to a page id fails fast instead (WP8: no more agent
        // fallback path).
        const refs = confPages.map((p) => p.url ?? p.id).filter((x): x is string => Boolean(x));
        payload = {
          input: refs.join('\n'),
          ...(followLinks ? {} : { followLinks: false }),
          ...(includeDescendants ? { includeDescendants: true } : {}),
        };
      } else {
        const featureIds = [...selected];
        payload = {
          source: {
            kind: 'bas',
            documentId: basDocumentId,
            ...(featureIds.length ? { featureIds } : {}),
          },
        };
      }
      // docs-to-ui docs step: carry the chosen UI targets so the daemon writes
      // targets.json for the post-docs stages.
      if (showTargets && targets.length) payload.targets = targets;
      await onRun(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Run · ${pipelineName}`}
      icon="play"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void submit()}
            disabled={busy || !canRun}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Chạy bước này'}</span>
          </button>
        </>
      }
    >
      {showTargets ? (
        <div className="pl-modal-field">
          <span className="pl-modal-field__label">Sản phẩm cần build (chọn ≥1)</span>
          <TargetCards targets={targets} onToggle={(t) => setTargets((cur) => toggleTargetIn(cur, t))} />
          <span className="pl-modal-field__hint">
            Ghi vào <code>targets.json</code> khi chạy bước Docs. Mỗi sản phẩm được build riêng
            (output tách thư mục theo target); build per-target chạy qua “Chạy full workflow”.
          </span>
        </div>
      ) : null}
      <div className={styles.cards} role="radiogroup" aria-label="Document source">
        <button
          type="button"
          role="radio"
          aria-checked={kind === 'confluence'}
          className={`${styles.card}${kind === 'confluence' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setKind('confluence')}
        >
          <span className={styles.cardTop}>
            <Icon name="import" size={16} />
            Confluence
            {kind === 'confluence' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>Paste a Confluence page link — preview its metadata, then ingest.</span>
        </button>
        {/* Nguồn BAS ĐANG KHÓA BẢO TRÌ — card disabled, BE cũng chặn 503
            (BAS_SOURCE_LOCKED, pipeline-routes.ts). Mở lại: bỏ disabled +
            khôi phục onClick setKind('bas') + gỡ cờ BE/CLI. */}
        <button
          type="button"
          role="radio"
          aria-checked={false}
          aria-disabled="true"
          disabled
          className={styles.card}
          style={{ opacity: 0.55, cursor: 'not-allowed' }}
          title="Nguồn BAS đang bảo trì"
        >
          <span className={styles.cardTop}>
            <Icon name="folder" size={16} />
            BAS
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10.5,
                fontWeight: 700,
                padding: '1px 8px',
                borderRadius: 999,
                background: 'var(--warn-weak, #fff3e0)',
                color: 'var(--warn, #b45309)',
              }}
            >
              Đang bảo trì
            </span>
          </span>
          <span className={styles.cardDesc}>Tạm khóa — dùng nguồn Confluence.</span>
        </button>
      </div>

      {kind === 'confluence' ? (
        <>
          <ConfluencePagePicker pages={confPages} onPagesChange={setConfPages} />
          <FollowLinksToggle checked={followLinks} onChange={setFollowLinks} disabled={busy} />
          <IncludeDescendantsToggle
            checked={includeDescendants}
            onChange={setIncludeDescendants}
            disabled={busy}
          />
        </>
      ) : (
        <div className={styles.panel}>
          <span className={styles.sectionLabel}>BAS document</span>
          {basDocLoading ? (
            <p className={styles.empty}>Loading BAS documents…</p>
          ) : !basDocuments || basDocuments.length === 0 ? (
            <p className={styles.empty}>No BAS documents returned (check BAS configuration).</p>
          ) : (
            <div className={styles.list}>
              {basDocuments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`${styles.row}${d.id === basDocumentId ? ' ' + styles.rowSelected : ''}`}
                  onClick={() => void loadFeatures(d.id)}
                >
                  <span className={`${styles.checkbox}${d.id === basDocumentId ? ' ' + styles.checkboxOn : ''}`}>
                    {d.id === basDocumentId ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowName}>{d.label || d.id}</span>
                    {d.nodeCount !== undefined ? (
                      <span className={styles.rowSummary}>{d.nodeCount} nodes</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          )}

          {basDocumentId ? (
            <>
              <span className={styles.sectionLabel}>Features (leave empty to ingest the whole document)</span>
              {basFeatLoading ? (
                <p className={styles.empty}>Loading…</p>
              ) : !basFeatures || basFeatures.length === 0 ? (
                <p className={styles.empty}>No features found — running will ingest the whole document.</p>
              ) : (
                <div className={styles.list}>
                  {basFeatures.map((f) => {
                    const on = selected.has(f.id);
                    return (
                      <button
                        key={f.id}
                        type="button"
                        className={`${styles.row}${on ? ' ' + styles.rowSelected : ''}`}
                        onClick={() => toggle(f.id)}
                        aria-pressed={on}
                      >
                        <span className={`${styles.checkbox}${on ? ' ' + styles.checkboxOn : ''}`}>
                          {on ? <Icon name="check" size={12} /> : null}
                        </span>
                        <span className={styles.rowBody}>
                          <span className={styles.rowName}>{f.name}</span>
                          {f.summary ? <span className={styles.rowSummary}>{f.summary}</span> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Design-system picker for UI stages (ui-html) ─────────────────────────────
// Shown before running a pipeline whose `acceptsDesignSystem` is set. Picks an
// optional brand to apply at HTML-gen time: "None" → a generic, design-led
// prototype (the pre-existing behavior); a system → its DESIGN.md + tokens get
// injected into the agent's system prompt for this run. Only NON-draft systems
// are offered, because the daemon won't inject a draft's assets (see
// isProjectUsableDesignSystem) — so a draft created from a .fig must be
// published first to appear here.
export function DesignSystemRunModal({
  pipelineName,
  defaultId,
  requireReactBundle,
  onClose,
  onRun,
}: {
  pipelineName: string;
  /** Design system cấu hình sẵn từ Pipeline Studio (project.json) — chọn sẵn
   *  trong danh sách, user vẫn đổi được cho từng lần chạy. */
  defaultId?: string;
  /** UI-Spec (React DS): chỉ liệt kê design system có bộ React (import từ
   *  Figma IR) — KỂ CẢ bản draft (DS import mặc định là draft), và bắt buộc
   *  chọn một cái mới cho Run. */
  requireReactBundle?: boolean;
  onClose: () => void;
  onRun: (designSystemId: string | null) => Promise<void>;
}) {
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(defaultId ?? null); // null = None
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await fetchDesignSystems();
        if (cancelled) return;
        setSystems(
          requireReactBundle
            ? all.filter((s) => s.hasReactBundle)
            : all.filter((s) => s.status !== 'draft'),
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSystems([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requireReactBundle]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRun(selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Run · ${pipelineName}`}
      icon="play"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void submit()}
            disabled={busy || systems === null || (requireReactBundle && !selected)}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Chạy bước này'}</span>
          </button>
        </>
      }
    >
      <div className="pl-modal-field pl-modal-field--ds">
        <span className="pl-modal-field__label">
          {requireReactBundle ? 'Design system (bắt buộc — bộ React từ Figma)' : 'Design system (optional)'}
        </span>
        {/* Same swatch + live-theme-preview picker as the chat composer. It
            portals its popover to <body>; popoverZIndex lifts it above the
            modal backdrop (z 1000) so it isn't hidden behind the overlay. The
            --ds modifier restyles its compact header pill into a full-width
            form control (see pipelines.css). */}
        <ProjectDesignSystemPicker
          designSystems={systems ?? []}
          selectedId={selected}
          loading={systems === null}
          onChange={setSelected}
          popoverZIndex={1100}
        />
        <span className="pl-modal-field__hint">
          {requireReactBundle ? (
            <>
              Chỉ liệt kê design system có bộ React (import từ Figma IR trong Settings →
              Design systems) — màn hình sẽ được ghép từ đúng component + token của bộ này.
            </>
          ) : (
            <>
              Applies a brand's <code>DESIGN.md</code> + tokens to the generated HTML. Leave as{' '}
              <strong>None</strong> for a generic, design-led prototype. Only published systems
              appear — publish a draft (e.g. one created from a <code>.fig</code>) to use it here.
            </>
          )}
        </span>
      </div>
      {systems !== null && systems.length === 0 ? (
        <p className="pl-modal-empty">
          {requireReactBundle
            ? 'Chưa có design system nào có bộ React — import file .ir.json từ plugin fig-export trong Settings → Design systems trước.'
            : 'No published design systems yet — running with None.'}
        </p>
      ) : null}
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Target-platform picker for the UX stage ─────────────────────────────────
// Shown before running a pipeline whose `acceptsPlatform` is set (the UX Spec
// stage — it decides every screen's `layout`). Mobile is the default and the
// legacy behavior; Website makes the skill author `layout: "web"` screens,
// which the UI-Spec terminals then render as full web pages.
export function PlatformRunModal({
  pipelineName,
  onClose,
  onRun,
}: {
  pipelineName: string;
  onClose: () => void;
  onRun: (platform: TargetPlatform) => Promise<void>;
}) {
  const [platform, setPlatform] = useState<TargetPlatform>('mobile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRun(platform);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Run · ${pipelineName}`}
      icon="play"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void submit()}
            disabled={busy}
          >
            <Icon name={busy ? 'spinner' : 'play'} size={14} />
            <span>{busy ? 'Starting…' : 'Chạy bước này'}</span>
          </button>
        </>
      }
    >
      <div className={styles.cards} role="radiogroup" aria-label="Target platform">
        <button
          type="button"
          role="radio"
          aria-checked={platform === 'mobile'}
          className={`${styles.card}${platform === 'mobile' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setPlatform('mobile')}
        >
          <span className={styles.cardTop}>
            <Icon name="home" size={16} />
            Mobile app
            {platform === 'mobile' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Phone-first screens (bottom actions, single-column forms) — the default.
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={platform === 'web'}
          className={`${styles.card}${platform === 'web' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setPlatform('web')}
        >
          <span className={styles.cardTop}>
            <Icon name="grid" size={16} />
            Website
            {platform === 'web' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Full web pages (tables, sidebar/top navigation, multi-column forms).
          </span>
        </button>
      </div>
      <span className={styles.hint}>
        Sets every screen's <code>layout</code> in the UX Spec; the UI-Spec stages render
        each screen accordingly.
      </span>
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Cấu hình pipeline (một modal, không chạy gì) ─────────────────────────────
// Modal gom mọi lựa chọn mà các modal từng-bước sẽ hỏi (nguồn cho bước Docs,
// target cho UX, design system + kiểu output cho bước UI-Spec) và CHỈ LƯU chúng
// vào cấu hình dự án (`PUT /api/pipelines/projects/:id/run-config`). Chạy full
// workflow là hành động NGOÀI modal: nút "Chạy pipeline" trên màn Chạy đọc
// đúng cấu hình đã lưu này rồi POST run-all thẳng.
export type WorkflowTerminalChoice = 'ui-html' | 'ui-react' | 'ui-react-ds' | 'both';

export interface RunAllPayload {
  input?: string;
  /** Structured picks behind `input` — sent alongside it purely so the daemon
   *  can persist a redisplay-able (titled) version into `savedRunAll`. */
  confluencePages?: ConfluencePageRefLike[];
  terminal: WorkflowTerminalChoice;
  platform: TargetPlatform;
  /** UI targets to build (docs-to-ui): mobile / web-user / web-backoffice. When
   *  ≥1, the post-docs chain runs once per target; empty → single build. */
  targets?: UiTarget[];
  designSystemId: string | null;
  /** Multi-target run (≥2 targets): each target's OWN design system — mobile
   *  and web come from different Figma libs. Recorded into targets.json so
   *  later single-stage re-runs resolve the same DS per target. */
  designSystemByTarget?: Partial<Record<UiTarget, string>>;
  skipSucceeded: boolean;
  /** Danh sách id bước sẽ chạy (người dùng tự tick ở section "Các bước sẽ
   *  chạy"). Có mặt và không rỗng → daemon chạy ĐÚNG các bước này theo thứ tự
   *  workflow, bỏ qua `lean`/`skipSucceeded`. Vắng mặt → hành vi cũ. */
  stageIds?: string[];
  /** true → run only docs → UX Spec → UI, dropping the analysis stages. */
  lean?: boolean;
  /** false → docs stage fetches ONLY the picked pages (no link-follow). */
  followLinks?: boolean;
  /** true → docs stage also scans the whole sub-tree under each seed page. */
  includeDescendants?: boolean;
  /** The docs were UPLOADED from this modal, so the daemon must DROP the ingest
   *  stage from the chain — that stage's declared output is the very folder the
   *  files landed in, so running it would delete them and fetch nothing. */
  docsFromUpload?: boolean;
  /** App Docs Pool nguồn — trang CHÍNH đã tick; daemon copy các trang này vào `<wf>/docs/`. */
  appPool?: { appId: string; paths: string[] };
}

/** Section duy nhất mà modal hiển thị khi mở từ nút "Đổi" của một dòng trên rail
 *  cấu hình — cùng modal, nhưng chỉ đúng phần người dùng bấm vào. Không truyền =
 *  modal đầy đủ (mọi section). Cả hai chế độ footer đều là "Hủy / Lưu". */
export type RunAllFocus = 'source' | 'designSystem' | 'targets' | 'stages' | 'mode';

const RUN_ALL_FOCUS_TITLES: Record<RunAllFocus, string> = {
  source: 'Nguồn tài liệu',
  designSystem: 'Design system',
  targets: 'Sản phẩm cần build',
  stages: 'Các bước sẽ chạy',
  mode: 'Chế độ chạy',
};

/**
 * Ba đầu ra UI-Spec của `docs-to-ui` — BA LỰA CHỌN THAY THẾ NHAU, không phải ba
 * bước nối tiếp: cả ba cùng `dependsOn: ['ux-review']` nên ở cùng một tầng của
 * đồ thị, và một lần chạy chỉ nên ra một loại prototype.
 *
 * Vì sao là một danh sách KHAI BÁO chứ không suy ra từ đồ thị: "cùng tầng" KHÔNG
 * đồng nghĩa với "chọn một". Workflow `docs-review` có `dr-comp` và `dr-flow`
 * cũng cùng phụ thuộc `dr-docs`, cũng cùng tầng — nhưng CẢ HAI đều phải chạy vì
 * `dr-review` đọc output của cả hai. Suy ra từ hình dạng đồ thị sẽ biến workflow
 * đó thành một lựa-chọn-một sai hoàn toàn.
 */
export const UI_TERMINAL_STAGE_IDS: ReadonlySet<string> = new Set([
  'ui-html',
  'ui-react',
  'ui-react-ds',
]);

/** Nhãn + mô tả của từng đầu ra UI-Spec, dùng cho nhóm radio ở bước cuối. */
const UI_TERMINAL_LABELS: Record<string, { label: string; desc: string }> = {
  'ui-html': { label: 'HTML prototype', desc: 'Prototype HTML tương tác, mỗi màn một file.' },
  'ui-react': { label: 'React app', desc: 'App Vite + React 19 thật (cần Docker).' },
  'ui-react-ds': {
    label: 'React DS',
    desc: 'App React ghép từ bộ design system đã import (cần DS Figma).',
  },
};

/** Một bước của workflow như section "Các bước sẽ chạy" cần biết — tập con của
 *  `PipelineView`, nên caller truyền thẳng danh sách pipeline vào được. */
export interface RunStageOption {
  id: string;
  name: string;
  /** Phụ thuộc TĨNH của registry (mode-independent). Cố ý KHÔNG dùng
   *  `effectiveDependsOn`: lựa chọn bước giờ tự quyết chuỗi chạy, nên cái phải
   *  giữ đúng là "bước này đọc output của bước nào", không phải cổng gating của
   *  một chế độ chạy nào đó. */
  dependsOn: string[];
  status: PipelineStatus;
  /** Chế độ chạy hiện tại của dự án bỏ bước này (daemon: `skippedInLeanRun`). */
  skipped?: boolean;
  /** Stage đang HOLD, không chạy được từ bất kỳ đâu (2026-08 web-first — daemon
   *  `PipelineView.held`, xem `HELD_STAGE_IDS` trong pipelines.ts). Picker phải
   *  vô hiệu hoá lựa chọn này thay vì để người dùng tick rồi nhận lỗi 400/503 —
   *  KHÔNG hard-code danh sách id ở đây, luôn đọc field này từ dữ liệu server. */
  held?: boolean;
}

/** Các bước mà chế độ "Tiết kiệm" bỏ — MIRROR bằng tay của `skippedInLeanRun`
 *  trong `apps/daemon/src/pipelines.ts` (contracts không mang cờ đó; `skipped`
 *  chỉ bật khi dự án ĐANG chạy lean, nên một mình nó không đủ để dựng preset ở
 *  chế độ Đầy đủ). Sai lệch chỉ làm preset thiếu/thừa một bước — người dùng vẫn
 *  tick tay được — nên đây là mirror an toàn, không phải nguồn sự thật. */
const LEAN_SKIPPABLE_STAGE_IDS = new Set(['cj', 'ux-research', 'ux-review']);

export function isLeanSkippableStage(stage: RunStageOption): boolean {
  return stage.skipped === true || LEAN_SKIPPABLE_STAGE_IDS.has(stage.id);
}

/** Lựa chọn ban đầu: khôi phục đúng `stageIds` đã lưu; chưa có thì tick các bước
 *  CHƯA `succeeded` (chạy tiếp phần còn thiếu). Mọi bước đều đã xong thì tick
 *  hết — mặc định rỗng sẽ khoá luôn nút Lưu mà không nói được vì sao.
 *
 *  Stage `held` (2026-08 hold) không bao giờ vào lựa chọn KHỞI TẠO — kể cả khi
 *  nó nằm trong `savedStageIds` đã lưu (cấu hình lưu từ trước lúc hold): picker
 *  vô hiệu hoá checkbox của nó nên người dùng không tự tick lại được, và một
 *  bước không tick được thì cũng không nên tự bật sẵn. Lưu lại (Save) sau đó
 *  ghi đè `stageIds` KHÔNG còn id đó — dọn dần config cũ mỗi khi mở lại modal. */
export function initialStageSelection(
  stages: readonly RunStageOption[],
  savedStageIds?: readonly string[],
): Set<string> {
  const selectable = stages.filter((s) => !s.held);
  const known = new Set(selectable.map((s) => s.id));
  const restored = (savedStageIds ?? []).filter((id) => known.has(id));
  if (restored.length > 0) return new Set(restored);
  const pending = selectable.filter((s) => s.status !== 'succeeded').map((s) => s.id);
  return new Set(pending.length > 0 ? pending : selectable.map((s) => s.id));
}

/**
 * Tick MỘT bước ⇒ CHỈ thêm đúng bước đó vào lựa chọn.
 *
 * Cổng phụ thuộc theo bước đã bỏ — điều kiện duy nhất còn lại là bước 1 (tài
 * liệu nạp), gate ở ngoài picker này. Trước đây hàm này kéo theo mọi phụ
 * thuộc CHƯA `succeeded`, đệ quy; giờ người dùng có toàn quyền tick một bước
 * dù phụ thuộc của nó chưa tick/chưa xong — bước đó sẽ chạy với dữ liệu hiện
 * có trên đĩa, không còn bị chặn ở đây. `missingRunDeps` bên dưới tính đúng
 * phần "sẽ chạy thiếu gì" đó để hiện chú thích mềm trong danh sách, không
 * phải để ép tick lại. Tên hàm giữ nguyên (còn nhiều call-site trong file
 * này); tham số `stages` giữ để chữ ký không đổi qua các lần gọi hiện có.
 */
export function selectStageWithDeps(
  stageId: string,
  stages: readonly RunStageOption[],
  selected: ReadonlySet<string>,
): Set<string> {
  void stages;
  const next = new Set(selected);
  next.add(stageId);
  return next;
}

/**
 * Bỏ tick MỘT bước ⇒ CHỈ bỏ đúng bước đó khỏi lựa chọn.
 *
 * Mặt đối xứng của `selectStageWithDeps` ở trên: trước đây bỏ tick một bước
 * kéo theo mọi bước đang tick "vì thế mất input", đệ quy; giờ không còn cascade
 * nào cả — bỏ tick một bước không đổi trạng thái tick của bước nào khác, kể cả
 * bước phụ thuộc nó. `missingRunDeps` nói rõ hệ quả (bước nào sẽ chạy thiếu
 * input) thay vì âm thầm bỏ hộ người dùng.
 */
export function deselectStageWithDependents(
  stageId: string,
  stages: readonly RunStageOption[],
  selected: ReadonlySet<string>,
): Set<string> {
  void stages;
  const next = new Set(selected);
  next.delete(stageId);
  return next;
}

/**
 * Phụ thuộc TĨNH của `stage` mà hiện KHÔNG nằm trong `selected` và cũng CHƯA
 * `succeeded` trên đĩa — tức nếu `stage` chạy ngay bây giờ, nó sẽ chạy với dữ
 * liệu hiện có thay vì input mới từ những phụ thuộc này. Nguồn cho chú thích
 * MỀM trong danh sách bước (không phải lỗi): cổng phụ thuộc theo bước đã bỏ,
 * người dùng có toàn quyền chọn vậy — họ chỉ cần được nói cho biết.
 */
export function missingRunDeps(
  stage: RunStageOption,
  stages: readonly RunStageOption[],
  selected: ReadonlySet<string>,
): RunStageOption[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const out: RunStageOption[] = [];
  for (const depId of stage.dependsOn) {
    const dep = byId.get(depId);
    if (dep && dep.status !== 'succeeded' && !selected.has(dep.id)) out.push(dep);
  }
  return out;
}

const STAGE_BADGES: Record<string, string> = {
  succeeded: 'Xong',
  failed: 'Lỗi',
  running: 'Đang chạy',
  queued: 'Đang chờ',
};

export function RunAllModal({
  workflowName,
  defaultConfluencePages,
  defaultDesignSystemId,
  defaultDesignSystemByTarget,
  defaultTerminal,
  defaultPlatform,
  defaultTargets,
  defaultFollowLinks,
  defaultIncludeDescendants,
  defaultDocsFromUpload,
  defaultAppPool,
  defaultSkipSucceeded,
  defaultLean,
  stages = [],
  defaultStageIds,
  hasPlatform = true,
  hasTerminal = true,
  hasDesignSystem = true,
  hasUpload = false,
  appId,
  supportsLean = true,
  anySucceeded,
  focus,
  onClose,
  onSaveConfig,
  onUploadDocs,
}: {
  workflowName: string;
  /** Nguồn điền sẵn — ưu tiên cấu hình Run-all ĐÃ LƯU từ lần chạy gần nhất
   *  trên máy này; chưa từng chạy lần nào thì fallback về cấu hình Pipeline
   *  Studio (project.json). Caller (PipelinesView) chọn cái nào truyền vào,
   *  modal chỉ biết "đây là giá trị khởi tạo". */
  defaultConfluencePages?: ConfluencePageRefLike[];
  defaultDesignSystemId?: string | null;
  /** DS RIÊNG từng target, prefilled từ lần chạy trước (multi-target). */
  defaultDesignSystemByTarget?: Partial<Record<UiTarget, string>>;
  defaultTerminal?: WorkflowTerminalChoice;
  defaultPlatform?: TargetPlatform;
  /** UI targets prefilled from the last run (docs-to-ui multi-target). */
  defaultTargets?: UiTarget[];
  defaultFollowLinks?: boolean;
  /** Chỉ caller ở chế độ focus truyền: modal khi đó đang SỬA giá trị đã lưu nên
   *  checkbox phải hiện đúng trạng thái cũ. Luồng chạy full để trống (không tick). */
  defaultIncludeDescendants?: boolean;
  /** Cũng chỉ dành cho chế độ focus: mở sẵn đúng nhánh nguồn đang lưu, để dòng
   *  rail "File tải lên" không mở ra một modal trông như đang dùng Confluence. */
  defaultDocsFromUpload?: boolean;
  /** App Docs Pool đã lưu (docs/app-docs-pool-spec.md §2.2) — trang CHÍNH đã
   *  tick từ pool của App. Chỉ có nghĩa khi `appId` khớp App của dự án. */
  defaultAppPool?: { appId: string; paths: string[] } | null;
  defaultSkipSucceeded?: boolean;
  defaultLean?: boolean;
  /** Mọi bước của workflow đang mở, ĐÚNG thứ tự stepper — nguồn của section
   *  "Các bước sẽ chạy" (tên, trạng thái, và `dependsOn` để tick lan lên phụ
   *  thuộc). Rỗng = workflow không có bước nào; focus 'stages' báo không dùng
   *  được thay vì mở một danh sách trống. */
  stages?: RunStageOption[];
  /** `stageIds` đã lưu của lần cấu hình trước. Vắng mặt → mặc định tick các
   *  bước chưa `succeeded`. */
  defaultStageIds?: string[];
  /** Whether the active workflow HAS a stage that uses each picker — a
   *  workflow with no UX/UI stages (e.g. Docs → PRD Review) hides them so the
   *  modal only shows config it actually consumes. Default true (docs-to-ui). */
  hasPlatform?: boolean;
  hasTerminal?: boolean;
  hasDesignSystem?: boolean;
  /** Bước ingest của workflow có affordance "Tải file lên" (`acceptsUpload`)
   *  không — có thì modal mở thêm nhánh nguồn "Tải file .md lên" bên cạnh
   *  Confluence, đúng như nút Run của riêng bước đó. */
  hasUpload?: boolean;
  /** App sở hữu dự án đang mở (`PipelineProject.app.id`) — khi có VÀ pool của
   *  App đó không rỗng, modal thêm thẻ nguồn "Tài liệu App" (docs/app-docs-pool-spec.md
   *  §WP-6). Vắng mặt (dự án chưa gán App) → không có thẻ này, hành vi y hệt cũ. */
  appId?: string;
  /** Lean là khái niệm CHỈ của docs-to-ui (bỏ hành trình/research/rà soát để
   *  tới UI nhanh hơn). docs-to-prd không có bước nào bỏ được — hành trình +
   *  research chính là bằng chứng của bài review — nên workflow đó ẩn hẳn
   *  section "Chế độ chạy" và không bao giờ gửi lean lên daemon. */
  supportsLean?: boolean;
  /** Có bước nào đã xong chưa — quyết định hiện checkbox "chỉ chạy bước còn thiếu". */
  anySucceeded: boolean;
  /** Mở từ nút "Đổi" của một dòng rail: chỉ hiện section đó. Bỏ trống = hiện
   *  mọi section. Footer giống nhau ở cả hai chế độ ("Hủy / Lưu"). */
  focus?: RunAllFocus;
  onClose: () => void;
  /** Bấm "Lưu": ghi cấu hình dự án (PUT /api/pipelines/projects/:id/run-config,
   *  owner là PipelinesView). Chế độ focus chỉ gửi field của section đang mở;
   *  chế độ đầy đủ gửi mọi section modal đang hiện. Reject → modal hiện lỗi,
   *  không đóng. */
  onSaveConfig?: (patch: Partial<RunAllConfig>) => Promise<void>;
  /** Ghi các file `.md` đã chọn vào `<workflow>/docs/` ngay khi bấm Lưu (nguồn
   *  "Tải file lên" chỉ có nghĩa khi file đã nằm trong `docs/`). Owner là
   *  PipelinesView (nó giữ projectId/workflowId); modal chỉ gom file. Bắt buộc
   *  có khi `hasUpload`. Reject → modal hiện lỗi, không lưu. */
  onUploadDocs?: (files: File[]) => Promise<void>;
}) {
  const t = useT();
  // Same shared Confluence picker as the per-stage Docs modal (search by name
  // + paste links, multi-select); prefill from the studio project config. The
  // run input is one page URL/id per line, built from the picked pages.
  const [confPages, setConfPages] = useState<ConfluencePageRefLike[]>(defaultConfluencePages ?? []);
  const [followLinks, setFollowLinks] = useState(defaultFollowLinks ?? true);
  const [includeDescendants, setIncludeDescendants] = useState(defaultIncludeDescendants ?? false);
  // Nguồn tài liệu cho bước ingest: fetch từ Confluence, tự tải file `.md`
  // lên, hoặc tick trang có sẵn trong pool tài liệu của App. Ba nhánh loại
  // trừ nhau — 'upload' khiến daemon BỎ HẲN bước ingest khỏi chuỗi
  // (docsFromUpload), vì chạy nó sẽ xóa đúng file vừa nạp; 'app-pool' copy
  // deterministic các trang đã tick (§2.4), không cần agent.
  // Dự án GẮN App: nguồn tài liệu của workflow CHỈ còn là pool của App
  // (nạp/import ở bước tạo App) — mode Confluence bị ẩn hẳn, khỏi fetch lại
  // thứ App đã có. Dự án không gắn App giữ đường Confluence cũ.
  const [docsSource, setDocsSource] = useState<'confluence' | 'upload' | 'app-pool'>(
    defaultDocsFromUpload ? 'upload' : appId !== undefined ? 'app-pool' : defaultAppPool?.paths?.length ? 'app-pool' : 'confluence',
  );
  const [pendingDocs, setPendingDocs] = useState<PendingFile[]>([]);
  const uploading = docsSource === 'upload' && hasUpload;

  // ── App Docs Pool (§WP-6) ─────────────────────────────────────────────────
  // Pool của App sở hữu dự án — fetch một lần khi có appId, đủ để quyết định
  // thẻ "Tài liệu App" có hiện hay không (pool rỗng → không hiện thẻ, y hệt
  // App chưa từng import gì).
  const [appPoolPages, setAppPoolPages] = useState<AppPoolPage[] | null>(null);
  const [appPoolLoading, setAppPoolLoading] = useState(false);
  const [appPoolError, setAppPoolError] = useState<string | null>(null);
  const [appPoolImportOpen, setAppPoolImportOpen] = useState(false);
  // Ô search lọc cây pool (thay cho picker tìm-Confluence cũ của workflow).
  const [appPoolQuery, setAppPoolQuery] = useState('');
  // Trang CHÍNH đã tick, keyed theo `path` (khớp `RunAllConfig.appPool.paths`).
  const [appPoolPaths, setAppPoolPaths] = useState<Set<string>>(
    new Set(appId && defaultAppPool?.appId === appId ? (defaultAppPool?.paths ?? []) : []),
  );

  const refreshAppPool = useCallback(
    async (background = false) => {
      if (!appId) return;
      if (!background) setAppPoolLoading(true);
      try {
        const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/pool`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as AppPoolResponse;
        setAppPoolPages(j.pages);
        setAppPoolError(null);
      } catch (cause) {
        setAppPoolError(cause instanceof Error ? cause.message : 'Không tải được tài liệu App.');
      } finally {
        if (!background) setAppPoolLoading(false);
      }
    },
    [appId],
  );

  useEffect(() => {
    setAppPoolPages(null);
    void refreshAppPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const appPoolAvailable = appId !== undefined && (appPoolPages?.length ?? 0) > 0;
  // Legacy single-platform (docs-to-prd has no UI stage / non-target callers).
  // docs-to-ui uses the `targets` multi-select below; platform is derived from
  // the first target in submit when targets are set.
  const [platform] = useState<TargetPlatform>(defaultPlatform ?? 'mobile');
  // Multi-target build (docs-to-ui): which UI products to generate. Default to
  // the last run's targets, else a single mobile app (legacy shape).
  const [targets, setTargets] = useState<UiTarget[]>(defaultTargets && defaultTargets.length ? defaultTargets : ['mobile']);
  const toggleTarget = (t: UiTarget) =>
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [designSystemId, setDesignSystemId] = useState<string | null>(
    defaultDesignSystemId === undefined ? null : defaultDesignSystemId,
  );
  // DS RIÊNG từng target (≥2 target): mobile và web đến từ lib Figma khác
  // nhau nên một id chung không phục vụ được multi-target build.
  const [dsByTarget, setDsByTarget] = useState<Partial<Record<UiTarget, string>>>(
    defaultDesignSystemByTarget ?? {},
  );
  const [skipSucceeded, setSkipSucceeded] = useState(defaultSkipSucceeded ?? false);
  // Các bước sẽ chạy ở lần "Chạy pipeline" tới. Khởi tạo một lần (lazy init):
  // modal chỉ sống trong lúc mở nên không cần đồng bộ lại với props.
  const [stageIds, setStageIdsState] = useState<Set<string>>(() =>
    initialStageSelection(stages, defaultStageIds),
  );
  // Người dùng đã ĐỘNG vào lựa chọn bước trong lần mở này chưa. Chế độ đầy đủ
  // (mở từ "Chạy pipeline" khi chưa có nguồn tài liệu) hiện section này cùng 5
  // section khác, và mặc định của nó là "các bước chưa xong" — ghi thẳng nó vào
  // cấu hình sẽ âm thầm biến một lần Lưu-nguồn-tài-liệu thành "từ nay đừng chạy
  // lại các bước đã xong". Chỉ ghi khi người dùng thật sự chọn (hoặc khi cấu
  // hình đã có sẵn `stageIds` từ trước, lúc đó ghi lại chính nó là vô hại).
  const [stagesTouched, setStagesTouched] = useState(false);
  const setStageIds = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setStagesTouched(true);
    setStageIdsState(next);
  };
  const toggleStage = (id: string) =>
    setStageIds((prev) =>
      prev.has(id)
        ? deselectStageWithDependents(id, stages, prev)
        : selectStageWithDeps(id, stages, prev),
    );
  // Thứ tự workflow, không phải thứ tự tick — dòng tóm tắt phải đọc đúng thứ tự
  // daemon sẽ chạy.
  const selectedStages = stages.filter((s) => stageIds.has(s.id));
  // Bước 1 (tài liệu nạp) — điều kiện DUY NHẤT còn lại sau khi cổng phụ thuộc
  // theo bước bị bỏ. Nhận diện bằng `dependsOn` rỗng (đúng cho cả ba workflow:
  // docs / prd-docs / dr-docs), không phải theo vị trí trong mảng, để không lệ
  // thuộc thứ tự caller truyền `stages` vào.
  const ingestStage = stages.find((s) => s.dependsOn.length === 0);
  const ingestPending = ingestStage !== undefined && ingestStage.status !== 'succeeded';

  // ── Bước cuối: BA đầu ra UI-Spec gộp thành MỘT bước, chọn một ─────────────
  // `forkStages` rỗng hoặc chỉ có một phần tử (docs-to-prd, docs-review) → không
  // có gì để chọn, mọi bước render thành hàng đánh số bình thường.
  const forkStages = hasTerminal ? stages.filter((s) => UI_TERMINAL_STAGE_IDS.has(s.id)) : [];
  const hasFork = forkStages.length >= 2;
  const stepStages = hasFork ? stages.filter((s) => !UI_TERMINAL_STAGE_IDS.has(s.id)) : stages;
  // MỌI đầu ra của bước cuối đang held (2026-08 hold) → cả hàng vô hiệu hoá,
  // không riêng từng radio — không còn gì để "chọn 1 trong N" nữa.
  const allForkHeld = forkStages.length > 0 && forkStages.every((s) => s.held === true);
  // Đầu ra đang chọn. Nguồn ưu tiên là `stageIds` (bước ĐANG tick), vì đó mới là
  // thứ quyết định lần chạy tới; `defaultTerminal` chỉ đỡ khi chưa tick nhánh
  // nào. `both` là giá trị cấu hình CŨ (html + react cùng lượt) — bề mặt mới chỉ
  // cho chọn một, nên nó rơi về nhánh đầu tiên thay vì để radio trống. Một
  // `defaultTerminal` held (cấu hình lưu từ trước lúc hold) không được ưu tiên —
  // rơi về đầu ra đầu tiên CHƯA held, nếu còn.
  const [terminal, setTerminal] = useState<WorkflowTerminalChoice>(() => {
    const initial = initialStageSelection(stages, defaultStageIds);
    const ticked = stages.find((s) => UI_TERMINAL_STAGE_IDS.has(s.id) && initial.has(s.id));
    if (ticked) return ticked.id as WorkflowTerminalChoice;
    const defaultIsHeld = forkStages.find((s) => s.id === defaultTerminal)?.held === true;
    if (defaultTerminal && defaultTerminal !== 'both' && !defaultIsHeld) return defaultTerminal;
    return (forkStages.find((s) => !s.held)?.id as WorkflowTerminalChoice | undefined) ?? 'ui-html';
  });
  // Bước cuối có đang chạy không = có nhánh nào được tick không.
  const forkEnabled = forkStages.some((s) => stageIds.has(s.id));
  /** Bỏ tick MỌI nhánh đầu ra — qua `deselectStageWithDependents` chứ không xoá
   *  thẳng khỏi Set, để bất biến "bước được tick luôn đủ input" do một hàm duy
   *  nhất giữ (hôm nay nhánh cuối chưa có bước nào phụ thuộc nó, ngày mai có). */
  const clearFork = (from: ReadonlySet<string>): Set<string> => {
    let out = new Set(from);
    for (const s of forkStages) {
      if (out.has(s.id)) out = deselectStageWithDependents(s.id, stages, out);
    }
    return out;
  };
  /** Chọn một đầu ra ⇒ BẬT luôn bước cuối và bỏ nhánh đang chọn trước đó. Bấm
   *  vào "React app" nghĩa là muốn React, không phải "ghi nhớ để lát nữa tick".
   *  Guard `held` phòng thủ (nút render đã `disabled`, nên onClick không tới
   *  đây trong UI thật — chỉ chặn thêm khi hàm bị gọi thẳng, ví dụ từ test). */
  const pickTerminal = (id: string) => {
    if (forkStages.find((s) => s.id === id)?.held) return;
    setTerminal(id as WorkflowTerminalChoice);
    setStageIds((prev) => selectStageWithDeps(id, stages, clearFork(prev)));
  };
  const toggleForkStep = () => {
    if (allForkHeld) return;
    setStageIds((prev) => (forkEnabled ? clearFork(prev) : selectStageWithDeps(terminal, stages, prev)));
  };
  /** Preset (Tất cả / Chỉ bước chưa xong / Tiết kiệm) thao tác trên CẢ danh sách
   *  nên tự nhiên tick cả ba nhánh đầu ra — thu về đúng một nhánh, ưu tiên nhánh
   *  đang chọn, để bề mặt không bao giờ mâu thuẫn với luật "chọn 1 trong 3". */
  const applyPreset = (next: Set<string>) => {
    const picked = forkStages.filter((s) => next.has(s.id));
    if (picked.length > 1) {
      const keep = picked.find((s) => s.id === terminal) ?? picked[0]!;
      for (const s of picked) if (s.id !== keep.id) next.delete(s.id);
      if (keep.id !== terminal) setTerminal(keep.id as WorkflowTerminalChoice);
    }
    setStageIds(next);
  };
  // Workflow không hỗ trợ lean thì bỏ qua cả default đã lưu (cờ đó là của lần
  // chạy docs-to-ui trên cùng project, không phải của workflow này).
  const [lean, setLean] = useState(supportsLean ? (defaultLean ?? false) : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Keep the FULL list; the picker filters per terminal below (React DS
        // needs react-bundle systems, which default to draft after import).
        const all = await fetchDesignSystems();
        if (!cancelled) setSystems(all);
      } catch {
        if (!cancelled) setSystems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Nguồn: nhánh upload cần ≥1 file, nhánh App-pool cần ≥1 trang đã tick,
  // nhánh Confluence cần ≥1 trang.
  const hasSource = uploading
    ? pendingDocs.length > 0
    : docsSource === 'app-pool'
      ? appPoolPaths.size > 0
      : confPages.length > 0;
  // Nhánh upload ĐANG là nguồn đã lưu: file cũ vẫn nằm trong `docs/` nên không
  // bắt tải lại — Lưu khi đó chỉ xác nhận lại lựa chọn nguồn.
  const sourceOk = hasSource || (uploading && defaultDocsFromUpload === true);
  // Validate theo ĐÚNG các section đang hiện: chế độ focus chỉ đòi section đó
  // hợp lệ, chế độ đầy đủ đòi nguồn tài liệu + (docs-to-ui) ≥1 target.
  const canSave = focus
    ? focus === 'source'
      ? sourceOk
      : focus === 'targets'
        ? targets.length > 0
        : focus === 'stages'
          ? // Chạy 0 bước không có nghĩa gì — Lưu một danh sách rỗng chỉ tạo ra
            // một nút "Chạy pipeline" không làm gì cả.
            stageIds.size > 0
          : true
    : (sourceOk || skipSucceeded) &&
      (!hasPlatform || targets.length > 0) &&
      (stages.length === 0 || stageIds.size > 0);
  // DS RIÊNG từng target, lọc còn đúng các target ĐANG chọn (multi-target).
  const dsByTargetForSelected = (): Partial<Record<UiTarget, string>> =>
    Object.fromEntries(
      targets.flatMap((t) => (dsByTarget[t] ? [[t, dsByTarget[t]!]] : [])),
    ) as Partial<Record<UiTarget, string>>;

  // Patch config của MỘT section — field ngoài section giữ nguyên giá trị đã
  // lưu (daemon merge shallow vào `metadata.runAllConfig`).
  const configPatchFor = (section: RunAllFocus): Partial<RunAllConfig> => {
    switch (section) {
      case 'source':
        // Ba nhánh loại trừ nhau — mỗi lần Lưu section này PHẢI resend cả ba
        // field (`confluencePages` / `docsFromUpload` / `appPool`), kể cả để
        // XÓA hai nhánh không chọn: field vắng mặt trong patch được daemon
        // PRESERVE giá trị cũ (bài học appFiles, xem spec §2.2), nên chỉ gửi
        // đúng field của nhánh đang chọn sẽ để sót giá trị cũ của nhánh khác.
        if (uploading) return { docsFromUpload: true, confluencePages: [], appPool: null };
        if (docsSource === 'app-pool' && appId) {
          return {
            docsFromUpload: false,
            confluencePages: [],
            appPool: { appId, paths: [...appPoolPaths] },
          };
        }
        return {
          confluencePages: confPages,
          followLinks,
          includeDescendants,
          docsFromUpload: false,
          appPool: null,
        };
      case 'designSystem':
        return {
          designSystemId,
          ...(hasPlatform && targets.length >= 2
            ? { designSystemByTarget: dsByTargetForSelected() }
            : {}),
        };
      case 'targets':
        return { targets };
      case 'stages':
        // `terminal` đi CÙNG `stageIds` vì bước cuối giờ là một phần của section
        // này. Hai field không thừa nhau: `stageIds` chi phối lần chạy tick tay,
        // còn `terminal` là thứ DUY NHẤT chỉ định đầu ra cho đường chạy tự động
        // (`selectRunStages` bỏ qua `terminal` khi `stageIds` không rỗng, và bỏ
        // qua `stageIds` khi nó rỗng) — ghi lệch nhau thì hai đường chạy cùng
        // một cấu hình sẽ ra hai kết quả khác nhau.
        return { stageIds: selectedStages.map((s) => s.id), ...(hasTerminal ? { terminal } : {}) };
      case 'mode':
        return { lean };
    }
  };

  // Cấu hình gửi lên khi bấm Lưu: focus = đúng một section, đầy đủ = mọi section
  // modal ĐANG hiện. Section bị ẩn (workflow không có bước dùng nó) phải nằm
  // ngoài patch — gửi giá trị mặc định của state sẽ âm thầm ghi đè cấu hình cũ.
  const configPatch = (): Partial<RunAllConfig> =>
    focus
      ? configPatchFor(focus)
      : {
          ...configPatchFor('source'),
          ...(stages.length > 0 && (stagesTouched || (defaultStageIds?.length ?? 0) > 0)
            ? configPatchFor('stages')
            : {}),
          // Workflow không có bước target (docs-to-prd): giữ field platform
          // legacy để lần chạy tới vẫn có giá trị, thay vì rơi về mặc định.
          ...(hasPlatform ? configPatchFor('targets') : { platform }),
          ...(supportsLean ? configPatchFor('mode') : {}),
          ...(hasDesignSystem ? configPatchFor('designSystem') : {}),
          ...(hasTerminal ? { terminal } : {}),
          ...(anySucceeded ? { skipSucceeded } : {}),
        };

  // Chế độ focus render ĐÚNG một section (nút "Đổi" của dòng rail tương ứng);
  // không focus thì hiện tất cả như modal "Chạy full workflow" cũ.
  const shows = (section: RunAllFocus) => !focus || focus === section;
  // Workflow đang chạy có thể không có section vừa bấm (vd Docs → PRD Review
  // không có bước UI nên không có target/design system, cũng không có chế độ
  // Tiết kiệm). Nói thẳng ra thay vì mở một modal trống rỗng.
  const focusUnavailable =
    (focus === 'designSystem' && !hasDesignSystem) ||
    (focus === 'targets' && !hasPlatform) ||
    // Workflow không có bước nào để chọn — gần như không xảy ra (một workflow
    // rỗng cũng không render được stepper), nhưng section này đọc dữ liệu từ
    // caller nên vẫn phải có nhánh cho "caller chưa truyền gì".
    (focus === 'stages' && stages.length === 0) ||
    (focus === 'mode' && !supportsLean);

  const save = async () => {
    if (busy || !canSave || focusUnavailable) return;
    setBusy(true);
    setError(null);
    try {
      // Nhánh upload: file vẫn phải nằm trong `<workflow>/docs/` — chỉ lưu cờ
      // docsFromUpload mà không ghi file thì bước sau không có gì để đọc.
      if (uploading && pendingDocs.length > 0) {
        if (!onUploadDocs) throw new Error('Chưa có handler tải file lên');
        await onUploadDocs(pendingDocs.map((p) => p.file));
      }
      if (!onSaveConfig) throw new Error('Chưa có handler lưu cấu hình');
      await onSaveConfig(configPatch());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Card shape shared with the target picker so the choices read as one set.
  const modeCard = (value: boolean, label: string, desc: string, icon: IconName) => (
    <button
      type="button"
      role="radio"
      aria-checked={lean === value}
      className={`${styles.card}${lean === value ? ' ' + styles.cardSelected : ''}`}
      onClick={() => setLean(value)}
      disabled={busy}
    >
      <span className={styles.cardTop}>
        <Icon name={icon} size={16} />
        {label}
        {lean === value ? (
          <span className={styles.cardCheck} aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        ) : null}
      </span>
      <span className={styles.cardDesc}>{desc}</span>
    </button>
  );

  return (
    <>
      <PlModal
      title={focus ? RUN_ALL_FOCUS_TITLES[focus] : `Cấu hình pipeline · ${workflowName}`}
      icon="sliders"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          {/* Modal CHỈ lưu cấu hình — chạy full workflow là nút "Chạy pipeline"
              ngoài modal, đọc đúng cấu hình vừa lưu này. */}
          <button
            type="button"
            className="pl-btn pl-btn--primary"
            onClick={() => void save()}
            disabled={busy || !canSave || focusUnavailable}
            title={
              canSave
                ? undefined
                : focus === 'targets' || (!focus && hasPlatform && targets.length === 0)
                  ? 'Chọn ít nhất một sản phẩm cần build'
                  : focus === 'stages' || (!focus && stages.length > 0 && stageIds.size === 0)
                    ? 'Tick ít nhất một bước sẽ chạy'
                  : uploading
                    ? 'Chọn ít nhất một file .md'
                    : docsSource === 'app-pool'
                      ? 'Tick ít nhất một trang trong tài liệu dự án'
                      : focus
                        ? 'Chọn ít nhất một trang Confluence'
                        : 'Chọn ít nhất một trang Confluence (hoặc tick "chỉ chạy bước còn thiếu" khi Docs đã xong)'
            }
          >
            <Icon name={busy ? 'spinner' : 'check'} size={14} />
            <span>{busy ? 'Đang lưu…' : 'Lưu'}</span>
          </button>
        </>
      }
    >
      {focusUnavailable ? (
        <p className="pl-modal-empty">Workflow này không có lựa chọn đó.</p>
      ) : null}
      {focus ? null : (
      <p className={styles.hint} style={{ marginTop: 0 }}>
        Bấm <strong>Lưu</strong> chỉ ghi cấu hình cho dự án, <strong>không chạy gì</strong>. Muốn
        chạy thì bấm <strong>Chạy pipeline</strong> ở màn Chạy — toàn bộ các bước chạy tự động nối
        tiếp bằng đúng cấu hình này, một bước lỗi sẽ dừng chuỗi tại đó.
      </p>
      )}
      {shows('source') ? (
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Tài liệu đầu vào cho 3 workflow</span>
        <span className="pl-modal-field__hint">
          Chọn <strong>URD</strong> của tính năng/sản phẩm làm tài liệu chính (bắt buộc). Có thể chọn thêm
          <strong> PRD</strong> làm tài liệu bổ sung để agent nắm nhanh bối cảnh dự án. Các tài liệu này được dùng
          chung khi chạy cả 3 workflow.
        </span>
        {/* Workflow có bước ingest nhận file tay (`acceptsUpload`, ví dụ Docs →
            Review tài liệu) thì cho chọn nguồn ngay tại đây. Dự án GẮN App:
            thẻ Confluence bị ẨN — tài liệu chỉ chọn từ pool App (mọi workflow
            dùng chung modal này, chung một nguồn). */}
        {hasUpload || appPoolAvailable ? (
          <div className={styles.cards} role="radiogroup" aria-label="Nguồn tài liệu">
            {appId === undefined ? (
            <button
              type="button"
              role="radio"
              aria-checked={docsSource === 'confluence'}
              className={`${styles.card}${docsSource === 'confluence' ? ' ' + styles.cardSelected : ''}`}
              onClick={() => setDocsSource('confluence')}
              disabled={busy}
            >
              <span className={styles.cardTop}>
                <Icon name="import" size={16} />
                Confluence
                {docsSource === 'confluence' ? (
                  <span className={styles.cardCheck} aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </span>
              <span className={styles.cardDesc}>
                Chọn URD trước; chọn thêm PRD nếu có. Daemon tải các trang đã chọn về Markdown.
              </span>
            </button>
            ) : null}
            {appPoolAvailable ? (
              <button
                type="button"
                role="radio"
                aria-checked={docsSource === 'app-pool'}
                className={`${styles.card}${docsSource === 'app-pool' ? ' ' + styles.cardSelected : ''}`}
                onClick={() => setDocsSource('app-pool')}
                disabled={busy}
              >
                <span className={styles.cardTop}>
                  <Icon name="blocks" size={16} />
                  Tài liệu dự án
                  {docsSource === 'app-pool' ? (
                    <span className={styles.cardCheck} aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                </span>
                <span className={styles.cardDesc}>
                  Tick URD của tính năng làm tài liệu chính; PRD chỉ là ngữ cảnh bổ sung. Bước 1 copy các trang
                  này vào docs-feature/ — toàn bộ kho luôn sẵn ở docs-app/ để agent nắm toàn cảnh dự án.
                </span>
              </button>
            ) : null}
            {hasUpload ? (
              <button
                type="button"
                role="radio"
                aria-checked={docsSource === 'upload'}
                className={`${styles.card}${docsSource === 'upload' ? ' ' + styles.cardSelected : ''}`}
                onClick={() => setDocsSource('upload')}
                disabled={busy}
              >
                <span className={styles.cardTop}>
                  <Icon name="upload" size={16} />
                  Tải file .md lên
                  {docsSource === 'upload' ? (
                    <span className={styles.cardCheck} aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                </span>
                <span className={styles.cardDesc}>
                  Tải URD làm tài liệu chính; có thể thêm PRD để bổ sung bối cảnh. Bỏ bước fetch và chạy từ bước
                  sau.
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
        {uploading ? (
          <>
            <UploadDropzone
              pending={pendingDocs}
              onAdd={(files) => {
                const next = toPendingFiles(files);
                if (next.length) setPendingDocs((cur) => [...cur, ...next]);
              }}
              onRemove={(id) => setPendingDocs((cur) => cur.filter((p) => p.id !== id))}
              disabled={busy}
            />
            <span className="pl-modal-field__hint">
              File được ghi vào <code>{'<workflow>'}/docs/</code> ngay khi bấm Lưu, và bước "Tài liệu
              → Markdown" bị <strong>bỏ khỏi chuỗi</strong> khi chạy — thư mục đó chính là output của
              bước ấy, chạy nó sẽ xóa sạch file bạn vừa nạp.
            </span>
          </>
        ) : docsSource === 'app-pool' && appPoolAvailable ? (
          <>
            {appPoolError ? <p className={styles.empty}>{appPoolError}</p> : null}
            {/* Một PANEL có tầng: thanh công cụ (tìm + đếm) → vùng cây nổi lên
                trên nền lõm → chân panel. Trước đây ô tìm và cây đổ thẳng ra
                nền modal nên cả khối đọc như một danh sách phẳng không đầu
                không cuối, không biết cây bắt đầu và kết thúc ở đâu. */}
            <div className={styles.poolPicker}>
              <div className={styles.poolHead}>
                <span className={styles.poolSearch}>
                  <Icon name="search" size={14} />
                  {/* KHÔNG dùng `.pl-proj-search` toàn cục ở đây: class đó là
                      `flex: 0 1 260px`, dựng cho thanh công cụ NẰM NGANG. Trong
                      `.pl-modal-field` (flex column) thì 260px rơi vào chiều
                      CAO, và `border-radius: 999px` biến ô tìm thành một hình
                      bầu dục cao nửa modal. */}
                  <input
                    type="search"
                    className={styles.poolSearchInput}
                    value={appPoolQuery}
                    onChange={(event) => setAppPoolQuery(event.target.value)}
                    placeholder="Tìm URD hoặc PRD trong tài liệu dự án…"
                    aria-label="Tìm URD hoặc PRD trong tài liệu dự án"
                    disabled={busy}
                  />
                </span>
                <span
                  className={`${styles.poolCount}${appPoolPaths.size > 0 ? ' ' + styles.poolCountOn : ''}`}
                >
                  {appPoolPaths.size > 0 ? `${appPoolPaths.size} trang đã tick` : 'Chưa tick trang nào'}
                </span>
              </div>
              <div className={styles.poolTree}>
                <AppPoolTree
                  pages={appPoolPages ?? []}
                  query={appPoolQuery}
                  selection={{ ticked: appPoolPaths, onToggle: setAppPoolPaths, disabled: busy }}
                />
              </div>
              <div className={styles.poolFoot}>
                <span className={styles.poolFootHint}>
                  Trang đã tick nạp vào <code>docs-feature/</code>
                </span>
                <button
                  type="button"
                  className={styles.poolImportBtn}
                  onClick={() => setAppPoolImportOpen((open) => !open)}
                >
                  <Icon name="import" size={13} />
                  {appPoolImportOpen ? 'Ẩn nhập tài liệu' : 'Import thêm từ Confluence'}
                </button>
              </div>
            </div>
            {/* Panel nhập thêm chỉ dựng khi MỞ. Trước đây nó là một khối có
                `border-top` luôn render, nên lúc đóng vẫn để lại một vạch kẻ
                lửng lơ dưới cây — thứ trông y như lỗi layout. */}
            {appPoolImportOpen && appId ? (
              <div className={styles.poolImportPanel}>
                <ConfluenceTreeImport
                  appId={appId}
                  onImported={(result) => {
                    setAppPoolImportOpen(false);
                    // Tick sẵn đúng các trang vừa nhập/cập nhật — người dùng
                    // không phải tìm lại chúng trong cây vừa mới dài thêm ra.
                    setAppPoolPaths((prev) => {
                      const next = new Set(prev);
                      for (const p of result.pages) next.add(p.path);
                      return next;
                    });
                    void refreshAppPool(true);
                  }}
                  onPartialImport={(result) => {
                    // KHÔNG đóng panel — importError vẫn cần hiện ở đó. Vẫn
                    // tick + refresh vì phần đã nhập đã nằm trong pool rồi.
                    setAppPoolPaths((prev) => {
                      const next = new Set(prev);
                      for (const p of result.pages) next.add(p.path);
                      return next;
                    });
                    void refreshAppPool(true);
                  }}
                />
              </div>
            ) : null}
          </>
        ) : docsSource === 'app-pool' ? (
          <>
            {/* Dự án gắn App nhưng pool RỖNG: không rơi về picker Confluence —
                tài liệu phải nạp ở màn App trước. */}
            {appPoolError ? <p className={styles.empty}>{appPoolError}</p> : null}
            <p className="pl-modal-field__hint">
              Dự án này chưa có tài liệu nào trong kho. Nạp tài liệu ở màn <b>Dự án</b> (mục "Tài liệu
              App" — Import từ Confluence) rồi quay lại đây tick trang cho workflow.
            </p>
          </>
        ) : (
          <>
            {/* Cùng picker với nút Run của riêng bước Docs: tìm trang theo tên,
                tick chọn nhiều, hoặc dán link/page id. */}
            <ConfluencePagePicker pages={confPages} onPagesChange={setConfPages} />
            <FollowLinksToggle checked={followLinks} onChange={setFollowLinks} disabled={busy} />
            <IncludeDescendantsToggle
              checked={includeDescendants}
              onChange={setIncludeDescendants}
              disabled={busy}
            />
            <span className="pl-modal-field__hint">
              Điền sẵn từ cấu hình dự án trên Pipeline Studio (nếu có). Link/id Confluence được daemon
              fetch trực tiếp (không cần agent). Chỉ hỗ trợ Confluence — JIRA đã ngừng hỗ trợ.
              Nguồn BAS đang bảo trì.
            </span>
          </>
        )}
      </div>
      ) : null}
      {hasPlatform && shows('targets') ? (
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Sản phẩm cần build (chọn ≥1)</span>
        <TargetCards targets={targets} onToggle={toggleTarget} />
        <span className="pl-modal-field__hint">
          Chọn nhiều thì mỗi sản phẩm được build riêng (docs → cj → ux → ui chạy một lần cho mỗi
          target), output tách thư mục theo target.
        </span>
      </div>
      ) : null}
      {stages.length > 0 && shows('stages') ? (
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Các bước sẽ chạy</span>
        {ingestPending && ingestStage ? (
          // Điều kiện duy nhất còn lại (bước 1) phải nêu rõ TRƯỚC khi người
          // dùng tick linh tinh các bước sau rồi bị API từ chối — mọi bước
          // khác giờ tick/bỏ tick tự do, nhưng không bước nào chạy ra dữ liệu
          // thật nếu bước 1 chưa xong.
          <span className={styles.stageIngestNote}>
            <Icon name="info" size={12} />
            {t('pipelines.runAllPicker.ingestRequired', { stage: ingestStage.name })}
          </span>
        ) : null}
        <div className={styles.stagePresets}>
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => applyPreset(new Set(stages.map((s) => s.id)))}
            disabled={busy}
          >
            Tất cả
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() =>
              applyPreset(new Set(stages.filter((s) => s.status !== 'succeeded').map((s) => s.id)))
            }
            disabled={busy}
          >
            Chỉ bước chưa xong
          </button>
          {/* Chế độ "Tiết kiệm" cũ, dựng lại thành MỘT preset: tick mọi bước
              không nằm trong nhóm bị bỏ khi chạy lean. Không còn cần một công
              tắc riêng đứng cạnh danh sách bước và nói ngược lại nó. */}
          {stages.some(isLeanSkippableStage) ? (
            <button
              type="button"
              className="pl-btn pl-btn--xs"
              onClick={() =>
                applyPreset(new Set(stages.filter((s) => !isLeanSkippableStage(s)).map((s) => s.id)))
              }
              disabled={busy}
              title="Bỏ các bước phân tích (hành trình, research, rà soát) — đúng chuỗi của chế độ Tiết kiệm cũ"
            >
              Tiết kiệm
            </button>
          ) : null}
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => setStageIds(new Set())}
            disabled={busy}
          >
            Bỏ chọn hết
          </button>
        </div>
        {/* Danh sách ĐÁNH SỐ theo đúng thứ tự daemon chạy. Ba đầu ra UI-Spec
            không phải bước 7-8-9 nối tiếp mà là ba lựa chọn thay thế nhau, nên
            chúng gộp vào MỘT hàng cuối có nhóm radio — thứ mà danh sách phẳng
            (và cả sơ đồ node trước đây) đều không nói được. */}
        <ol className={styles.stageList}>
          {stepStages.map((stage, i) => {
            const badge = STAGE_BADGES[stage.status] ?? 'Chưa chạy';
            // Chú thích MỀM — không phải lỗi, không chặn Lưu: bước này đang
            // tick nhưng có phụ thuộc chưa tick và chưa `succeeded`, nên nó sẽ
            // chạy với dữ liệu hiện có thay vì input mới từ phụ thuộc đó.
            const missing = stageIds.has(stage.id) ? missingRunDeps(stage, stages, stageIds) : [];
            return (
              <li key={stage.id} className={styles.stageItem}>
                <label className={styles.stageRow}>
                  <span className={styles.stageNum} aria-hidden="true">
                    {i + 1}
                  </span>
                  <input
                    type="checkbox"
                    className={styles.stageCheckbox}
                    checked={stageIds.has(stage.id)}
                    onChange={() => toggleStage(stage.id)}
                    disabled={busy}
                  />
                  <span className={styles.stageName}>{stage.name}</span>
                  {isLeanSkippableStage(stage) ? (
                    <span
                      className={styles.stageOptional}
                      title="Chế độ Tiết kiệm bỏ bước này — không bước nào chờ nó"
                    >
                      tuỳ chọn
                    </span>
                  ) : null}
                  <span
                    className={`${styles.stageBadge} ${
                      stage.status === 'succeeded'
                        ? styles.stageBadgeDone
                        : stage.status === 'failed'
                          ? styles.stageBadgeFailed
                          : styles.stageBadgeIdle
                    }`}
                  >
                    {badge}
                  </span>
                </label>
                {missing.length > 0 ? (
                  <p className={styles.stageSoftNote}>
                    {t('pipelines.runAllPicker.softNote', {
                      stages: missing.map((m) => m.name).join(', '),
                    })}
                  </p>
                ) : null}
              </li>
            );
          })}
          {hasFork ? (() => {
            // Chú thích mềm áp cho ĐẦU RA đang chọn (terminal) — ba nhánh đều
            // dùng chung `ux-review` nên chỉ cần tính trên nhánh hiện bật.
            const chosen = forkEnabled ? forkStages.find((s) => s.id === terminal) : undefined;
            const forkMissing = chosen ? missingRunDeps(chosen, stages, stageIds) : [];
            return (
            <li className={`${styles.stageItem} ${styles.stageItemFork}`}>
              <label className={styles.stageRow}>
                <span className={styles.stageNum} aria-hidden="true">
                  {stepStages.length + 1}
                </span>
                <input
                  type="checkbox"
                  className={styles.stageCheckbox}
                  checked={forkEnabled}
                  onChange={toggleForkStep}
                  disabled={busy || allForkHeld}
                  title={allForkHeld ? t('pipelines.held.tooltip') : undefined}
                />
                <span className={styles.stageName}>Kết quả UI-Spec</span>
                <span className={styles.stageOptional}>chọn 1 trong {forkStages.length}</span>
                {allForkHeld ? (
                  <span className={styles.stageBadge} style={{ opacity: 0.75 }}>
                    {t('pipelines.held.badge')}
                  </span>
                ) : null}
              </label>
              <div
                className={`${styles.forkOptions}${forkEnabled ? '' : ' ' + styles.forkOptionsOff}`}
                role="radiogroup"
                aria-label="Kết quả UI-Spec"
              >
                {forkStages.map((s) => {
                  const meta = UI_TERMINAL_LABELS[s.id];
                  const on = forkEnabled && terminal === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-disabled={s.held ? 'true' : undefined}
                      className={`${styles.forkOption}${on ? ' ' + styles.forkOptionOn : ''}`}
                      onClick={() => pickTerminal(s.id)}
                      disabled={busy || s.held === true}
                      style={s.held ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                      title={s.held ? t('pipelines.held.tooltip') : undefined}
                    >
                      <span className={styles.forkDot} aria-hidden="true" />
                      <span className={styles.forkLabel}>{meta?.label ?? s.name}</span>
                      <span className={styles.forkDesc}>{meta?.desc ?? ''}</span>
                      <span
                        className={`${styles.stageBadge} ${
                          s.held
                            ? styles.stageBadgeIdle
                            : s.status === 'succeeded'
                              ? styles.stageBadgeDone
                              : s.status === 'failed'
                                ? styles.stageBadgeFailed
                                : styles.stageBadgeIdle
                        }`}
                      >
                        {s.held ? t('pipelines.held.badge') : (STAGE_BADGES[s.status] ?? 'Chưa chạy')}
                      </span>
                    </button>
                  );
                })}
              </div>
              {forkMissing.length > 0 ? (
                <p className={styles.stageSoftNote}>
                  {t('pipelines.runAllPicker.softNote', {
                    stages: forkMissing.map((m) => m.name).join(', '),
                  })}
                </p>
              ) : null}
            </li>
            );
          })() : null}
        </ol>
        <span className="pl-modal-field__hint">
          {selectedStages.length > 0 ? (
            <>
              Sẽ chạy {selectedStages.length} bước:{' '}
              <strong>{selectedStages.map((s) => s.name).join(' → ')}</strong>
            </>
          ) : (
            'Chưa tick bước nào — chọn ít nhất một bước thì mới lưu được.'
          )}
        </span>
        <span className="pl-modal-field__hint">{t('pipelines.runAllPicker.hint')}</span>
      </div>
      ) : null}
      {supportsLean && shows('mode') ? (
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Chế độ chạy</span>
        <div className={styles.cards} role="radiogroup" aria-label="Chế độ chạy">
          {modeCard(false, 'Đầy đủ', 'Chạy mọi bước: hành trình, UX research, và bước rà soát heuristic.', 'sparkles')}
          {modeCard(true, 'Tiết kiệm', 'Chỉ docs → UX Spec → UI. Bỏ hành trình, research và rà soát.', 'file-code')}
        </div>
        {lean ? (
          <span className="pl-modal-field__hint">
            Nhanh và rẻ hơn, nhưng UX Spec viết từ tài liệu thôi — không có hành trình, tiêu chí
            research hay bước rà soát. Hợp để xem nhanh, chưa hợp để bàn giao.
          </span>
        ) : null}
      </div>
      ) : null}
      {hasDesignSystem && shows('designSystem') && hasPlatform && targets.length >= 2 ? (
        // ≥2 target: DS RIÊNG từng target — mobile và web đến từ lib Figma
        // khác nhau. Ghi vào targets.json để re-run stage lẻ resolve đúng DS.
        <div className="pl-modal-field pl-modal-field--ds">
          <span className="pl-modal-field__label">
            {terminal === 'ui-react-ds'
            ? 'Design system TỪNG TARGET (bắt buộc — bộ React từ Figma)'
              : 'Design system TỪNG TARGET (tùy chọn)'}
          </span>
          {targets.map((t) => (
            <div key={t} className="pl-modal-field__dsrow">
              <span className="pl-modal-field__dsrow-label">{UI_TARGETS[t].label}</span>
              <ProjectDesignSystemPicker
                designSystems={(systems ?? []).filter(
                  (s) =>
                    (terminal === 'ui-react-ds' ? s.hasReactBundle : s.status !== 'draft') &&
                    // Thẻ platform của DS phải khớp target (DS chưa gắn thẻ
                    // hiện ở mọi target): app mobile không nhận lib web và
                    // ngược lại.
                    (UI_TARGETS[t].platform === 'mobile'
                      ? s.platform !== 'web'
                      : s.platform !== 'mobile'),
                )}
                selectedId={dsByTarget[t] ?? null}
                loading={systems === null}
                onChange={(id) =>
                  setDsByTarget((cur) => {
                    const next = { ...cur };
                    if (id) next[t] = id;
                    else delete next[t];
                    return next;
                  })
                }
                popoverZIndex={1100}
              />
            </div>
          ))}
          <span className="pl-modal-field__hint">
            Target chưa chọn DS sẽ dùng DS chung/mặc định của dự án.
          </span>
        </div>
      ) : hasDesignSystem && shows('designSystem') ? (
      <div className="pl-modal-field pl-modal-field--ds">
        <span className="pl-modal-field__label">
          {terminal === 'ui-react-ds'
            ? 'Design system (bắt buộc — bộ React từ Figma)'
              : 'Design system (tùy chọn)'}
        </span>
        <ProjectDesignSystemPicker
          designSystems={(systems ?? []).filter((s) =>
            terminal === 'ui-react-ds' ? s.hasReactBundle : s.status !== 'draft',
          )}
          selectedId={designSystemId}
          loading={systems === null}
          onChange={setDesignSystemId}
          popoverZIndex={1100}
        />
      </div>
      ) : null}
      {anySucceeded && !focus ? (
        // Checkbox hardening lives in .pl-runall-toggle (pipelines.css) — the
        // app's global input pill styles would otherwise stretch it full-width
        // and blow the modal out horizontally.
        <label className="pl-runall-toggle">
          <input
            type="checkbox"
            checked={skipSucceeded}
            onChange={(ev) => setSkipSucceeded(ev.target.checked)}
            disabled={busy}
          />
          <span className="pl-runall-toggle__body">
            <span className="pl-runall-toggle__title">Chỉ chạy các bước còn thiếu</span>
            <span className="pl-runall-toggle__desc">
              Áp dụng cho lần chạy tới: giữ kết quả các bước đã xong. Bỏ tick = chạy lại từ đầu —
              output cũ được snapshot vào lịch sử trước khi xóa.
            </span>
          </span>
        </label>
      ) : null}
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
    </>
  );
}

// ── Re-run clear-scope picker ────────────────────────────────────────────────
// Shown when re-running a stage that already succeeded AND has downstream
// stages. A re-run always clears the stage's OWN outputs (so the agent
// regenerates instead of seeing leftovers and stopping); this modal only asks
// whether to ALSO clear the now-stale downstream stages.
export function RerunScopeModal({
  pipelineName,
  downstreamNames,
  onClose,
  onChoose,
}: {
  pipelineName: string;
  /** Human names of the stages that go stale if this one is regenerated. */
  downstreamNames: string[];
  onClose: () => void;
  onChoose: (scope: 'stage' | 'downstream') => Promise<void>;
}) {
  const [scope, setScope] = useState<'stage' | 'downstream'>('stage');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChoose(scope);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Chạy lại · ${pipelineName}`}
      icon="refresh"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            // 'downstream' xóa luôn kết quả các bước phụ thuộc — nặng tay hơn hẳn
            // 'stage' (chỉ xóa đúng bước này), nên chỉ scope này đọc như phá hủy.
            className={`pl-btn ${scope === 'downstream' ? 'pl-btn--danger' : 'pl-btn--run'}`}
            onClick={() => void submit()}
            disabled={busy}
          >
            <Icon name={busy ? 'spinner' : 'refresh'} size={14} />
            <span>{busy ? 'Đang chạy…' : 'Chạy lại'}</span>
          </button>
        </>
      }
    >
      <div className={styles.cards} role="radiogroup" aria-label="Phạm vi chạy lại">
        <button
          type="button"
          role="radio"
          aria-checked={scope === 'stage'}
          className={`${styles.card}${scope === 'stage' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setScope('stage')}
        >
          <span className={styles.cardTop}>
            <Icon name="refresh" size={16} />
            Chỉ bước này
            {scope === 'stage' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Xóa &amp; tạo lại đúng bước này. Các bước sau giữ nguyên kết quả cũ (có thể đã lỗi thời).
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={scope === 'downstream'}
          className={`${styles.card}${scope === 'downstream' ? ' ' + styles.cardSelected : ''}`}
          onClick={() => setScope('downstream')}
        >
          <span className={styles.cardTop}>
            <Icon name="layers-filled" size={16} />
            Cả các bước sau
            {scope === 'downstream' ? (
              <span className={styles.cardCheck} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          <span className={styles.cardDesc}>
            Xóa luôn kết quả của các bước phụ thuộc — chúng về trạng thái chưa chạy và phải chạy lại.
          </span>
        </button>
      </div>
      {scope === 'downstream' && downstreamNames.length ? (
        <span className={styles.hint}>
          Sẽ xóa kết quả: <strong>{downstreamNames.join(', ')}</strong>. Bản cũ vẫn khôi phục được từ Lịch sử.
        </span>
      ) : (
        <span className={styles.hint}>Bản cũ luôn được lưu vào Lịch sử trước khi xóa nên khôi phục được.</span>
      )}
      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}

/**
 * Pre-flight confirm for "Chạy pipeline" (run-all), covering TWO independent
 * questions `PipelinesView` asks before every run-all POST — either one alone
 * is enough to open this dialog (an EMPTY answer to both runs straight
 * through, no dialog: nothing to say, so nothing to ask — see the spec's
 * `must_not`):
 *
 *  - `stageNames` (`stagesLosingOutputForRunAll`): the about-to-run set
 *    currently has a result for at least one stage that this run will erase.
 *  - `staleInputs` (`staleInputsForRunAll`): a stage about to run will read
 *    its primary input from an ancestor that is NOT part of this run and
 *    already succeeded a while ago — the rail's "· ngoài chế độ" case. This
 *    never loses anything (that ancestor's result is untouched), so it must
 *    still surface even when `stageNames` is empty (first-ever `ux` run, but
 *    `cj` is stale — nothing to clear, everything to say).
 *
 * Each becomes its own section, hidden entirely when empty, so the dialog
 * only ever shows what actually applies. Named-action confirm button (never
 * a bare "OK"); wording states facts, not scares — the daemon commits the
 * current output to project history BEFORE clearing it (`commitHistory`,
 * ahead of the re-run clear in `runPipeline`), so a clear is always
 * restorable, and a stale input is simply "still exactly what it was", not
 * "wrong". */
export function RunAllClearConfirmModal({
  stageNames,
  staleInputs = [],
  onClose,
  onConfirm,
}: {
  /** Display NAMES (not raw ids) of every stage about to lose its current
   *  result. */
  stageNames: string[];
  /** Every about-to-run stage whose primary input still comes from an older,
   *  out-of-run ancestor — resolved to display names by the caller (mirrors
   *  `stageNames` above), `updatedAt` is that ancestor's own last-run time.
   *  Absent/empty when no about-to-run stage's input chain is stale. */
  staleInputs?: Array<{ stageName: string; sourceName: string; updatedAt: number }>;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const willLoseOutput = stageNames.length > 0;
  const hasStaleInputs = staleInputs.length > 0;
  return (
    <PlModal
      title={willLoseOutput ? 'Sẽ xoá kết quả cũ' : 'Vài đầu vào lấy từ ngoài lần chạy này'}
      icon="refresh"
      onClose={onClose}
      footer={
        <>
          {/* Cancel is the DEFAULT — autofocused, so an accidental Enter
           *  never fires the (possibly destructive) confirm action. */}
          <button type="button" className="pl-btn" onClick={onClose} autoFocus>
            Huỷ
          </button>
          <button
            type="button"
            className={willLoseOutput ? 'pl-btn pl-btn--danger' : 'pl-btn pl-btn--primary'}
            onClick={() => void onConfirm()}
          >
            <Icon name="refresh" size={14} />
            <span>{willLoseOutput ? 'Chạy và xoá kết quả cũ' : 'Chạy'}</span>
          </button>
        </>
      }
    >
      {willLoseOutput ? (
        <div className={styles.clearConfirmSection}>
          <span className={styles.clearConfirmBody}>
            Chạy bây giờ sẽ <span className={styles.danger}>xoá kết quả hiện có</span> của:{' '}
            <span className={styles.em}>{stageNames.join(', ')}</span>.
          </span>
          <span className={styles.clearConfirmBody}>
            Kết quả cũ được <span className={styles.em}>lưu vào lịch sử dự án</span> trước khi xoá — có thể khôi phục lại sau.
          </span>
        </div>
      ) : null}
      {hasStaleInputs ? (
        <div className={styles.clearConfirmSection}>
          <span className={styles.sectionLabel}>Đầu vào lấy từ ngoài lần chạy này</span>
          {staleInputs.map((row, i) => (
            <span key={`${row.stageName}-${row.sourceName}-${i}`} className={styles.clearConfirmBody}>
              <span className={styles.em}>{row.stageName}</span> sẽ dùng kết quả của{' '}
              <span className={styles.em}>{row.sourceName}</span> từ {relativeTimeLong(row.updatedAt, t)}.
            </span>
          ))}
          <span className={styles.clearConfirmBody}>
            Mỗi bước nguồn ở trên nằm ngoài lần chạy này nên kết quả của nó <span className={styles.em}>giữ nguyên</span> — bước phụ thuộc sẽ dùng đúng bản đó.
          </span>
        </div>
      ) : null}
    </PlModal>
  );
}

// ── Req 3: Compact run-status modal ──────────────────────────────────────────
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

const TASK_STATUS_META: Record<string, { icon: IconName; label: string; cls: string }> = {
  queued: { icon: 'more-horizontal', label: 'Đang chờ', cls: 'queued' },
  running: { icon: 'spinner', label: 'Đang chạy', cls: 'running' },
  succeeded: { icon: 'check', label: 'Xong', cls: 'succeeded' },
  failed: { icon: 'close', label: 'Lỗi', cls: 'failed' },
};

/** `PipelineView.error` — a contract addition landing alongside this UI
 *  change (BE task, in parallel): a short, human fail-fast/failure reason
 *  per stage on `GET /api/pipelines` (an unconfigured-source ingest run's
 *  fail-fast message, or a short agent-failure summary) — the thing "Xem
 *  lỗi" is supposed to show but couldn't when the run row itself was gone
 *  (e.g. after a daemon restart) or never carried an error string. Declared
 *  locally so this modal can read it ahead of/independent from
 *  packages/contracts picking it up; safe to drop once `PipelineView` itself
 *  carries it. */
type PipelineViewWithError = PipelineView & { error?: string };

/** Fallback when the daemon has genuinely lost every trace of why a stage
 *  failed (old run row gone, and BE hasn't sent a fail-fast `error` either)
 *  — "Xem lỗi" must never render a blank dialog for a failed stage. */
const NO_ERROR_DETAIL_FALLBACK = 'Không còn chi tiết lỗi (daemon có thể đã khởi động lại). Chạy lại bước để tái hiện.';

export function PipelineStatusModal({
  pipeline,
  projectId,
  onClose,
  onOpenChat,
  onOpenTask,
  onRefresh,
}: {
  pipeline: PipelineViewWithError;
  projectId: string;
  onClose: () => void;
  onOpenChat: (() => void) | null;
  /** Open one fan-out task's conversation (per-task chat). */
  onOpenTask?: (conversationId: string) => void;
  onRefresh: () => void;
}) {
  const tasks = pipeline.subConversations ?? [];
  const doneCount = tasks.filter((t) => t.status === 'succeeded' || t.status === 'failed').length;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  const taskCounts = {
    all: tasks.length,
    running: tasks.filter((t) => t.status === 'running').length,
    queued: tasks.filter((t) => t.status === 'queued').length,
    succeeded: tasks.filter((t) => t.status === 'succeeded').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };
  const runId = pipeline.lastRunId ?? null;
  const [run, setRun] = useState<ChatRunStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [taskTab, setTaskTab] = useState<'all' | 'running' | 'queued' | 'succeeded' | 'failed'>('all');
  // A status tab that has emptied out (e.g. all "running" finished) falls back
  // to "all" so the list is never blank while tasks still exist.
  const effectiveTab = taskTab === 'all' || taskCounts[taskTab] > 0 ? taskTab : 'all';
  const visibleTasks = effectiveTab === 'all' ? tasks : tasks.filter((t) => t.status === effectiveTab);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as ChatRunStatusResponse;
        if (cancelled) return;
        setRun(data);
        setNow(Date.now());
        const terminal = ['succeeded', 'failed', 'canceled'].includes(data.status);
        if (terminal) {
          onRefresh();
        } else {
          timer = window.setTimeout(poll, 1500);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId, onRefresh]);

  const status = run?.status ?? pipeline.status;
  const isRunning = status === 'queued' || status === 'running';
  const elapsed = run ? formatElapsed((run.updatedAt || now) - run.createdAt) : null;
  const isFanout = tasks.length > 0;

  const cancel = async () => {
    if (canceling) return;
    setCanceling(true);
    try {
      // A fan-out stage has no single lastRunId — cancel it stage-wide (stops
      // the pool + every live sub-run); a single-agent stage cancels its run.
      if (isFanout || !runId) {
        await fetch(
          `/api/pipelines/${encodeURIComponent(projectId)}/${encodeURIComponent(pipeline.id)}/cancel`,
          { method: 'POST' },
        );
      } else {
        await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
      }
      onRefresh();
    } catch {
      /* ignore — poll reflects the result */
    } finally {
      setCanceling(false);
    }
  };

  return (
    <PlModal
      title={`Status · ${pipeline.name}`}
      icon="pipeline"
      onClose={onClose}
      footer={
        <>
          {onOpenChat ? (
            <button type="button" className="pl-btn" onClick={onOpenChat}>
              <Icon name="comment" size={14} />
              <span>Open chat</span>
            </button>
          ) : null}
          {isRunning && (runId || isFanout) ? (
            <button
              type="button"
              className="pl-btn pl-btn--danger"
              data-testid="pipeline-status-cancel"
              onClick={() => void cancel()}
              disabled={canceling}
            >
              <Icon name={canceling ? 'spinner' : 'stop'} size={14} />
              <span>{canceling ? 'Canceling…' : 'Cancel run'}</span>
            </button>
          ) : null}
          <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {tasks.length > 0 ? (
        <div className="pl-status-detail">
          <div className="pl-fanout-summary">
            <span className={`pl-status-detail__badge pl-status--${pipeline.status}`}>
              {pipeline.status === 'running' || pipeline.status === 'queued' ? <Icon name="spinner" size={14} /> : null}
              <span>
                {doneCount}/{tasks.length} xong
                {failedCount ? ` · ${failedCount} lỗi` : ''}
              </span>
            </span>
            <span className="pl-fanout-summary__hint">Các tác vụ chạy song song — bấm để mở hội thoại từng cái.</span>
          </div>
          <div className="pl-fanout-tabs" role="tablist">
            {([
              { key: 'all', label: 'Tất cả' },
              { key: 'running', label: 'Đang chạy' },
              { key: 'queued', label: 'Đang chờ' },
              { key: 'succeeded', label: 'Xong' },
              { key: 'failed', label: 'Lỗi' },
            ] as const)
              .filter((t) => t.key === 'all' || taskCounts[t.key] > 0)
              .map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === t.key}
                  className={`pl-fanout-tab pl-fanout-tab--${t.key}${effectiveTab === t.key ? ' is-active' : ''}`}
                  onClick={() => setTaskTab(t.key)}
                >
                  <span>{t.label}</span>
                  <span className="pl-fanout-tab__count">{taskCounts[t.key]}</span>
                </button>
              ))}
          </div>
          <ul className="pl-fanout-list">
            {visibleTasks.map((task) => {
              const meta = TASK_STATUS_META[task.status] ?? TASK_STATUS_META.queued!;
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`pl-fanout-item pl-fanout-item--${meta.cls}`}
                    onClick={() => onOpenTask?.(task.id)}
                    title={`Mở hội thoại: ${task.title}`}
                  >
                    <span className={`pl-fanout-item__icon pl-fanout-item__icon--${meta.cls}`} aria-hidden="true">
                      <Icon name={meta.icon} size={13} />
                    </span>
                    <span className="pl-fanout-item__name">{task.title}</span>
                    <span className="pl-fanout-item__status">{meta.label}</span>
                    <Icon name="chevron-right" size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : !runId ? (
        // No run row to poll (never run, OR the old run's state is gone —
        // e.g. a daemon restart between the run and opening this dialog).
        // That second case is exactly why "Xem lỗi" could render blank: a
        // failed stage with no runId had NOTHING to show. `pipeline.error`
        // (BE fail-fast/failure reason, independent of any run row) is now
        // the primary content whenever it's there; a genuinely lost failure
        // still gets the explicit fallback instead of silence.
        pipeline.error ? (
          <div className="pl-status-detail">
            <div className={`pl-status-detail__badge pl-status--${pipeline.status}`}>
              <span>{RUN_STATUS_LABEL[pipeline.status] ?? pipeline.status}</span>
            </div>
            <pre className="pl-status-detail__error">{pipeline.error}</pre>
            {pipeline.errorReportId ? (
              <p className="pl-status-detail__hint">Đã gửi báo cáo lỗi <span className="pl-mono">#{pipeline.errorReportId}</span> cho đội phát triển.</p>
            ) : null}
          </div>
        ) : pipeline.status === 'failed' ? (
          <p className="pl-modal-empty">{NO_ERROR_DETAIL_FALLBACK}</p>
        ) : (
          <p className="pl-modal-empty">No run for this pipeline yet.</p>
        )
      ) : (
        <div className="pl-status-detail">
          <div className={`pl-status-detail__badge pl-status--${status}`}>
            {isRunning ? <Icon name="spinner" size={14} /> : null}
            <span>{RUN_STATUS_LABEL[status] ?? status}</span>
          </div>
          <dl className="pl-status-detail__meta">
            {elapsed ? (
              <div>
                <dt>Elapsed</dt>
                <dd>{elapsed}</dd>
              </div>
            ) : null}
            <div>
              <dt>Run id</dt>
              <dd className="pl-mono">{runId}</dd>
            </div>
          </dl>
          {/* `pipeline.error` (BE fail-fast/failure reason) is the PRIMARY
              error content when present; the run's own `error` (agent stdout
              summary from GET /api/runs/:id) stays visible too, as secondary
              detail, unless it's the exact same string. Neither existing is
              the "legitimately empty" case this whole fix is for — a failed
              stage never shows a blank body once BE sends anything at all. */}
          {pipeline.error ? <pre className="pl-status-detail__error">{pipeline.error}</pre> : null}
          {run?.error && run.error !== pipeline.error ? (
            <pre className="pl-status-detail__error">{run.error}</pre>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              <Icon name="info" size={14} />
              <span>{error}</span>
            </div>
          ) : null}
          {!pipeline.error && !run?.error && !error && status === 'failed' ? (
            <p className="pl-modal-empty">{NO_ERROR_DETAIL_FALLBACK}</p>
          ) : null}
          {status === 'failed' && pipeline.errorReportId ? (
            <p className="pl-status-detail__hint">Đã gửi báo cáo lỗi <span className="pl-mono">#{pipeline.errorReportId}</span> cho đội phát triển.</p>
          ) : null}
          {isRunning ? (
            <p className="pl-status-detail__hint">
              Running in the background — you can close this and keep working.
            </p>
          ) : null}
        </div>
      )}
    </PlModal>
  );
}

// ── Req 3: Quick result — preview the pipeline's output files IN the modal ───
// Instead of navigating into the project workspace (conversation + folder tree)
// to see a stage's result, we render the same FileViewer the workspace uses,
// right here, with a left rail to switch between this stage's output files. A
// non-tech user never has to meet "workspace"/folders — they open a stage and
// see its screens immediately. "Open in workspace" stays as a power-user escape
// hatch (the old navigate-away behavior via onViewFile).
const isScreenFile = (name: string) =>
  name.endsWith('.screen.json') || /(^|\/)screen\.json$/.test(name);

// A non-tech "Quick result" only lists files FileViewer renders as a visual UI
// preview, and nothing else (markdown, manifests, build assets, source, the
// full-app dist/index.html bundle, and wireframes/*.wire.json + flows/*.flow.json
// siblings all stay hidden — someone who doesn't know what a "workspace" is has
// no use for them here). Per step:
//   • ui-html / ui-react (UI-Spec) → ONLY the React per-screen pages
//     (dist/screens/) and the HTML prototype (prototype/), plus the prototype
//     auto-demo recording (prototype-demo/*.webm). The dist/index.html full-app
//     bundle is dropped — the screens canvas already shows every screen.
//   • ux-spec / cj → the one primary spec JSON (SpecPreview loads its
//     wireframes/flows as tabs INSIDE it).
//   • ux-review / ux-research → the report JSON (ReviewPreview /
//     UxResearchPreview); the sibling report.md stays hidden.
//   • design-v3 screens → screen.json.
//   • docs (dr-docs) / dr-review → the ingested/redline .md pages under
//     docs/** or docs-feature/**.
// If a step produces NO previewable file we fall back to listing everything
// so the modal is never empty.
export function isUiPreviewFile(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  // dr-review's "the run produced no review" note (sibling of `review/`, see
  // apps/daemon/src/docs-review.ts's DOCS_REVIEW_FAILURE_NOTE) — surfaced here
  // so Quick result shows the readable failure reason instead of an empty
  // list when the stage failed before any page succeeded.
  if (base === 'review-khong-chay-duoc.md') return true;
  // dr-comp's failure note (apps/daemon/src/docs-components.ts's
  // DOCS_COMPONENT_FAILURE_NOTE) — same reasoning as review-khong-chay-duoc.md.
  if (base === 'comp-khong-chay-duoc.md') return true;
  if (base === 'screen.json') return true;
  // dr-comp ("Màn hình → Component" 2.0): one entry per screen —
  // `comp/<SCREEN-KEY>.screen.json` opens ScreenComponentsPreview (rail of
  // every screen + wireframe + DS component panel). Its wireframes/*.html,
  // comp/index.json, _inputs.json, _role-map.json and summary.md stay hidden.
  if (/(^|\/)comp\/[^/]+\.screen\.json$/.test(lower)) return true;
  // dr-flow ("Đánh giá luồng UX"): ONE entry per flow — `flows/<FLOW-ID>/
  // ux-review.json` opens the full source diagram + findings panel
  // (FlowUxReviewPreview). Its siblings (as-is/proposed.drawio|.mmd, patch/
  // screens/cells.json) and the derived flows/<id>.flowchart.json / index.json
  // stay hidden — same diagram, no reason to list it five times.
  if (/(^|\/)flows\/[^/]+\/ux-review\.json$/.test(lower)) return true;
  // UI-Spec previews: React per-screen pages + HTML prototype (not the
  // dist/index.html bundle, dev entry, or build assets).
  if (/\.html?$/.test(base)) {
    return /(^|\/)dist\/screens\//.test(lower) || /(^|\/)prototype\//.test(lower);
  }
  // Prototype auto-demo recording (Playwright walkthrough video).
  if (/(^|\/)prototype-demo\/.*\.webm$/.test(lower)) return true;
  // Ingested doc PAGES (docs/**/*.md AND docs-feature/**/*.md — App docs pool,
  // 08/2026, ingests into docs-feature/ instead of docs/, and dr-review clones
  // whichever root the pages came from into review/<root>/, same pairing as
  // FileViewer.isDocsReviewRedlinePage) — the readable content. NOT the
  // _index companion (a table of contents) and NOT the image files (those
  // render INLINE inside each page now, so listing them as separate entries
  // is noise).
  if (/(^|\/)(docs|docs-feature)\/.+\.md$/.test(lower)) return base !== '_index.md';
  // Primary visual spec docs (UX Spec / Customer Journey).
  if (/-ux-spec\.json$/.test(base) || /-(customer-journey|journey|cj)\.json$/.test(base)) return true;
  // docs-review's digest (review/summary.md) — the clone pages themselves
  // already match the docs|docs-feature rule above.
  if (/(^|\/)review\/summary\.md$/.test(lower)) return true;
  // Visual report previews — UX Heuristic Review + UX Research + docs-to-prd's
  // PRD Mockup Review (DocsReviewPreview).
  return /(^|\/)(heuristic-review|ux-research|review)\/[^/]*\.json$/.test(lower);
}

// Shared data layer for the Quick-result surfaces (modal + full-page route).
// Fetches the project's files, filters to this stage's previewable outputs, and
// tracks the active file / target. Both PipelineResultModal and
// PipelineResultView render the SAME rail + FileViewer from this state.
type PipelineResultState = ReturnType<typeof usePipelineResultFiles>;

function usePipelineResultFiles(projectId: string, pipeline: PipelineView, workflowId?: string) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  // Multi-target: which target's outputs to show (null = this stage produced a
  // single/shared build). Set to the first available target once files load.
  const [activeTarget, setActiveTarget] = useState<UiTarget | null>(null);
  const outputs = pipeline.outputs ?? [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
        if (!res.ok) throw new Error(`files: ${res.status}`);
        const data = (await res.json()) as { files?: ProjectFile[] };
        const all = (data.files ?? [])
          // Normalize name to a clean relative path but keep every ProjectFile
          // field (kind/mime/mtime/size) — FileViewer needs them to dispatch.
          .map((f) => ({ ...f, name: (f.name ?? f.path ?? '').replace(/^\/+/, '') }))
          // Scope to the workflow the Quick result was opened in — two workflows
          // that both emit docs/** must not bleed into each other's rail.
          .filter((f) => fileInWorkflow(f.name, workflowId))
          .filter((f) => f.name && outputs.some((o) => outputMatches(stripWorkflowDir(f.name), o)));
        // Non-tech listing: UI-previewable files only, falling back to the full
        // set when a stage ships none (so doc/cj stages still show something).
        const ui = all.filter((f) => isUiPreviewFile(f.name));
        // Collapse the per-target docs copies down to the shared original.
        const deduped = dropSharedTargetCopies(ui.length > 0 ? ui : all);
        // Source order (wiki sidebar): sort by the numbering in each path segment.
        const shown = deduped.slice().sort((x, y) => naturalPathCompare(x.name, y.name));
        if (!cancelled) {
          setFiles(shown);
          // Default to the first target present (multi-target build); the rail
          // filters to it so a 3-target run isn't one flat wall of files.
          const firstTarget = shown.map((f) => targetOfFile(f.name)).find((t): t is UiTarget => t !== null) ?? null;
          setActiveTarget(firstTarget);
          const first = shown.find((f) => (firstTarget ? targetOfFile(f.name) === firstTarget : true));
          setActiveName(first?.name ?? shown[0]?.name ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // outputs derives from pipeline; pipeline.id is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pipeline.id, workflowId]);

  // Targets present across this stage's output files (multi-target build).
  const availableTargets = useMemo(() => {
    const set = new Set<UiTarget>();
    for (const f of files ?? []) {
      const t = targetOfFile(f.name);
      if (t) set.add(t);
    }
    return UI_TARGET_IDS.filter((t) => set.has(t));
  }, [files]);
  // The rail shows the active target's files (plus any shared/null-target file).
  const visibleFiles = useMemo(
    () => (activeTarget ? (files ?? []).filter((f) => { const t = targetOfFile(f.name); return t === null || t === activeTarget; }) : (files ?? [])),
    [files, activeTarget],
  );
  const active = visibleFiles.find((f) => f.name === activeName) ?? visibleFiles[0] ?? null;
  const hasFiles = Boolean(files && files.length > 0);

  return {
    files,
    error,
    activeName,
    setActiveName,
    activeTarget,
    setActiveTarget,
    availableTargets,
    visibleFiles,
    active,
    hasFiles,
    outputs,
  };
}

// ── Rail file tree ──────────────────────────────────────────────────────────
// Pipeline 1 (docs → Markdown) writes each page folder-structured by its
// Confluence parent/child tree (docs/confluence/<parent>/<child>.md — see
// apps/daemon/src/bas/bas-client.ts), so the file rail nests by path segments to
// mirror that wiki hierarchy instead of a flat wall. Generalizes: any set nests
// by its shared folders; a single-folder set (e.g. dist/screens/*) stays flat.
type RailNode =
  | { kind: 'file'; file: ProjectFile }
  | { kind: 'dir'; label: string; children: RailNode[] };

function buildRailTree(files: ProjectFile[]): RailNode[] {
  const rows = files.map((f) => ({ f, segs: f.name.split('/').filter(Boolean) }));
  // Drop leading segments shared by EVERY file (workflow dir + docs/confluence/…)
  // so the tree starts at the first level where the pages actually branch. Never
  // consume a file's own filename (last segment).
  let common = 0;
  if (rows.length > 0) {
    const first = rows[0]!.segs;
    const maxCommon = Math.min(...rows.map((r) => r.segs.length - 1));
    while (common < maxCommon && rows.every((r) => r.segs[common] === first[common])) common += 1;
  }
  const roots: RailNode[] = [];
  const dirIndex = new Map<string, RailNode & { kind: 'dir' }>();
  for (const { f, segs } of rows) {
    const rest = segs.slice(common);
    const folders = rest.slice(0, -1);
    let level = roots;
    let keyPath = '';
    for (const folder of folders) {
      keyPath += `/${folder}`;
      let dir = dirIndex.get(keyPath);
      if (!dir) {
        dir = { kind: 'dir', label: folder, children: [] };
        dirIndex.set(keyPath, dir);
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({ kind: 'file', file: f });
  }
  return compactRailTree(roots);
}

// VS-Code-style compact folders: a folder whose only child is another folder
// collapses into one row ("docs / confluence") so a deep single-child chain
// doesn't waste three indented rows on nothing branching.
function compactRailTree(nodes: RailNode[]): RailNode[] {
  return nodes.map((n) => {
    if (n.kind !== 'dir') return n;
    let label = n.label;
    let children = n.children;
    while (children.length === 1 && children[0]!.kind === 'dir') {
      const only = children[0] as RailNode & { kind: 'dir' };
      label = `${label} / ${only.label}`;
      children = only.children;
    }
    return { kind: 'dir', label, children: compactRailTree(children) };
  });
}

function railKey(n: RailNode, i: number): string {
  return n.kind === 'file' ? n.file.name : `dir:${n.label}:${i}`;
}

// Link-followed pages land under docs/context/ (see bas-client.ts) — they are
// CONTEXT ONLY (agent reads them for domain understanding; no screens/mockups
// are built from them). The rail marks them so they read distinctly from the
// main pages the pipeline actually builds.
function isContextPage(name: string): boolean {
  return /(^|\/)docs\/context\//.test(name);
}
function isContextLabel(label: string): boolean {
  return label === 'context' || /(^|\s\/\s|\/)context$/.test(label);
}

// Active-file + pick handler, shared down the tree so nodes don't thread props.
const RailCtx = createContext<{ activeName: string | null; onPick: (name: string) => void }>({
  activeName: null,
  onPick: () => {},
});

function RailNodeView({ node }: { node: RailNode }) {
  return node.kind === 'dir' ? (
    <RailFolder label={node.label} nodes={node.children} />
  ) : (
    <RailFile file={node.file} />
  );
}

function RailFolder({ label, nodes }: { label: string; nodes: RailNode[] }) {
  const [open, setOpen] = useState(true);
  const context = isContextLabel(label);
  return (
    <div className="pl-result-rail__group">
      <button
        type="button"
        className={`pl-result-rail__folder${context ? ' pl-result-rail__folder--context' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={context ? `${label} — trang ngữ cảnh (chỉ để hiểu nghiệp vụ)` : label}
      >
        <span className="pl-result-rail__caret" aria-hidden="true">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </span>
        <span className="pl-result-rail__folder-icon" aria-hidden="true">
          <Icon name="folder" size={15} />
        </span>
        <span className="pl-result-rail__folder-name">{label}</span>
        {context ? <span className="pl-result-rail__ctx-badge">Context</span> : null}
      </button>
      {/* Indented children with a left guide line so nesting reads at a glance. */}
      {open ? (
        <div className="pl-result-rail__children">
          {nodes.map((n, i) => (
            <RailNodeView key={railKey(n, i)} node={n} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RailFile({ file }: { file: ProjectFile }) {
  const { activeName, onPick } = useContext(RailCtx);
  const isActive = file.name === activeName;
  const context = isContextPage(file.name);
  return (
    <button
      type="button"
      className={`pl-result-rail__item${isActive ? ' pl-result-rail__item--active' : ''}${context ? ' pl-result-rail__item--context' : ''}`}
      onClick={() => onPick(file.name)}
      aria-current={isActive}
      title={context ? `${file.name} — trang ngữ cảnh (chỉ để hiểu nghiệp vụ, không dựng màn)` : file.name}
    >
      <span className="pl-result-rail__icon" aria-hidden="true">
        <Icon name={context ? 'info' : isScreenFile(file.name) ? 'image' : 'file'} size={14} />
      </span>
      {/* File name only — the full path stays as the hover title. */}
      <span className="pl-result-rail__name">{file.name.split('/').pop() || file.name}</span>
      {context ? <span className="pl-result-rail__ctx-badge">Context</span> : null}
    </button>
  );
}

// The rail + embedded FileViewer, shared by the modal and the route page.
// Exported (named) so pipeline-result-rail.test.tsx can render it directly —
// PipelineResultBody backs BOTH surfaces (modal + route page), so a test
// against this function covers every step that uses Quick result.
export function PipelineResultBody({
  projectId,
  projectKind,
  state,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  state: PipelineResultState;
}) {
  const {
    files,
    error,
    activeName,
    setActiveName,
    activeTarget,
    setActiveTarget,
    availableTargets,
    visibleFiles,
    active,
    outputs,
  } = state;
  // Rail thu gọn/mở nhớ qua localStorage, dùng chung cho mọi bước Quick result
  // (WP17b, 2026-08-20) — người dùng đối chiếu sơ đồ cần bề ngang cho viewer
  // hơn là cây file 244px luôn hiện. Đọc localStorage ngay trong initializer
  // (không phải useEffect) để lần render đầu đã đúng trạng thái, tránh
  // flash-mở-rồi-gọn; guard typeof window vì component này SSR-safe tới nay.
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('od.quickResult.rail') !== '0';
  });
  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      const next = !open;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('od.quickResult.rail', next ? '1' : '0');
      }
      return next;
    });
  }, []);
  if (error) {
    return (
      <div className="pl-modal-error" role="alert">
        <Icon name="info" size={14} />
        <span>{error}</span>
      </div>
    );
  }
  if (files === null) {
    return <p className="pl-modal-empty">Loading files…</p>;
  }
  if (files.length === 0) {
    return (
      <p className="pl-modal-empty">
        Bước này chưa có tệp kết quả. Hãy chạy bước hoặc dùng <strong>Lấy dự án về máy</strong>{' '}
        để nhận {outputs.join(', ') || 'kết quả'}.
      </p>
    );
  }
  // A single output file (e.g. a cj/ux-spec/review JSON) makes the file rail
  // pointless — there's nothing to switch between. Drop it and let the viewer
  // take the whole width. The rail only earns its keep with multiple files or
  // multiple build targets to page through.
  const showRail = visibleFiles.length > 1 || availableTargets.length > 1;
  if (!showRail) {
    return (
      <div className="pl-result-preview pl-result-preview--solo">
        <div className="pl-result-stage">
          {active ? (
            <FileViewer key={active.name} projectId={projectId} projectKind={projectKind} file={active} />
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="pl-result-preview">
      <aside
        className={`pl-result-rail${railOpen ? '' : ' pl-result-rail--collapsed'}`}
        aria-label="Output files"
      >
        {/* Nút thu gọn luôn ở đầu rail. Gọn lại vẫn giữ một dải mỏng (không ẩn
            hẳn aside) vì cần chỗ cho nút bấm mở lại — ẩn hẳn thì người dùng
            hết cách quay lại cây file. */}
        <button
          type="button"
          className="pl-result-rail__toggle"
          onClick={toggleRail}
          aria-label={railOpen ? 'Ẩn danh sách file' : 'Hiện danh sách file'}
          title={railOpen ? 'Ẩn danh sách file' : 'Hiện danh sách file'}
        >
          <Icon name={railOpen ? 'chevron-left' : 'chevron-right'} size={14} />
        </button>
        {railOpen ? (
          <>
            {availableTargets.length > 1 ? (
              <div className="pl-result-rail__targets" role="tablist" aria-label="Target">
                {availableTargets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={activeTarget === t}
                    className={`pl-result-rail__target${activeTarget === t ? ' pl-result-rail__target--active' : ''}`}
                    onClick={() => {
                      setActiveTarget(t);
                      const first = (files ?? []).find((f) => targetOfFile(f.name) === t);
                      if (first) setActiveName(first.name);
                    }}
                  >
                    {UI_TARGETS[t].label}
                  </button>
                ))}
              </div>
            ) : null}
            <RailCtx.Provider value={{ activeName: active?.name ?? null, onPick: setActiveName }}>
              {buildRailTree(visibleFiles).map((n, i) => (
                <RailNodeView key={railKey(n, i)} node={n} />
              ))}
            </RailCtx.Provider>
          </>
        ) : null}
      </aside>
      <div className="pl-result-stage">
        {active ? (
          <FileViewer
            // Remount the viewer per file so each renderer resets cleanly.
            key={active.name}
            projectId={projectId}
            projectKind={projectKind}
            file={active}
          />
        ) : null}
      </div>
    </div>
  );
}

export function PipelineResultModal({
  projectId,
  projectKind,
  pipeline,
  onClose,
  onViewFile,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  pipeline: PipelineView;
  onClose: () => void;
  onViewFile: (fileName: string) => void;
}) {
  const state = usePipelineResultFiles(projectId, pipeline);
  const { active, hasFiles } = state;

  return (
    <PlModal
      title={`Quick result · ${pipeline.name}`}
      icon="file-code"
      size="xl"
      bodyClassName={hasFiles ? 'pl-modal__body--flush' : undefined}
      onClose={onClose}
      footer={
        <>
          {active ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => {
                onViewFile(active.name);
                onClose();
              }}
              title="Mở file này trong workspace đầy đủ (hội thoại + cây thư mục)"
            >
              <Icon name="external-link" size={13} />
              <span>Mở trong workspace</span>
            </button>
          ) : null}
          <button type="button" className="pl-btn pl-btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <PipelineResultBody projectId={projectId} projectKind={projectKind} state={state} />
    </PlModal>
  );
}

// Full-page Quick result — same rail + FileViewer as the modal, but rendered
// as its own route (`/pipelines/:projectId/result/:pipelineId`) so the preview
// gets the whole viewport instead of a cramped xl modal. `onBack` returns to
// the pipelines stepper; `onViewFile` still opens the file in the full
// workspace for power users.
export function PipelineResultView({
  projectId,
  projectKind,
  pipeline,
  workflowId,
  onBack,
  onViewFile,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  pipeline: PipelineView;
  /** Scope the rail to this workflow's output tree (docs-to-ui vs docs-to-prd). */
  workflowId?: string;
  onBack: () => void;
  onViewFile: (fileName: string) => void;
}) {
  const state = usePipelineResultFiles(projectId, pipeline, workflowId);
  const { active } = state;

  return (
    <section className="pl-result-page" aria-label={`Quick result · ${pipeline.name}`}>
      <header className="pl-result-page__header">
        <button type="button" className="pl-btn pl-result-page__back" onClick={onBack}>
          <Icon name="arrow-left" size={14} />
          {/* Đích của Back là màn Chạy của chính bước này (lùi một cấp), không
              phải trang Pipelines ngoài cùng — nhãn phải nói đúng điều đó. */}
          <span>Quay lại</span>
        </button>
        <div className="pl-result-page__title">
          <Icon name="file-code" size={16} />
          <span>
            Quick result · <strong>{pipeline.name}</strong>
          </span>
        </div>
        <div className="pl-result-page__actions">
          {active ? (
            <button
              type="button"
              className="pl-btn"
              onClick={() => onViewFile(active.name)}
              title="Mở file này trong workspace đầy đủ (hội thoại + cây thư mục)"
            >
              <Icon name="external-link" size={13} />
              <span>Mở trong workspace</span>
            </button>
          ) : null}
        </div>
      </header>
      <div className="pl-result-page__body">
        <PipelineResultBody projectId={projectId} projectKind={projectKind} state={state} />
      </div>
    </section>
  );
}

// ── StagePicker — pipeline chips shared by the Pull all / Push all modals.
// All checked (the default) = legacy whole-project file sync; narrowing only
// affects OUTPUT FILES — the KG graph always moves whole-project. Zero checked
// disables the modal's confirm (an empty list would read as "no filter"
// server-side). Each chip carries a local↔store badge fed by
// POST /api/kg/sync-status: "≠ remote" (something a push/pull would move) or
// "đồng bộ" — aggregated over the projects currently selected in the modal.
export function allStageIds(workflows: Workflow[]): Set<string> {
  return new Set(workflows.flatMap((w) => w.pipelineIds));
}

// StagePicker resolves each stage chip's human name from `Workflow.stages`
// (packages/contracts/src/api/pipelines.ts) — populated by the daemon from
// its `PipelineDef.name` registry (apps/daemon/src/pipelines.ts), so there is
// no mirror to keep in sync here. A pid missing a `stages` entry (or an older
// daemon that omits the optional field) falls back to the raw id.
function stageNamesOf(workflows: Workflow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const w of workflows) {
    for (const s of w.stages ?? []) names.set(s.id, s.name);
  }
  return names;
}

interface StageDiff {
  differs: boolean;
  changed: number;
  localOnly: number;
  remoteOnly: number;
  local: number;
  remote: number;
}

/** One fetch per modal open — the per-project results are aggregated
 *  client-side as the project selection changes (no refetch). */
function useSyncStatus(): ProjectSyncStatus[] | null {
  const [data, setData] = useState<ProjectSyncStatus[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/kg/sync-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const j = await res.json().catch(() => ({}));
        if (!cancelled) setData(res.ok ? ((j?.data?.results ?? []) as ProjectSyncStatus[]) : []);
      } catch {
        if (!cancelled) setData([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** Sum the per-project stage diffs over `scope` (empty scope = every local
 *  project — remote-only projects simply have no data to contribute). */
function aggregateDiff(
  results: ProjectSyncStatus[] | null,
  scope: ReadonlySet<string>,
): Map<string, StageDiff> | undefined {
  if (!results) return undefined;
  const map = new Map<string, StageDiff>();
  for (const r of results) {
    if (scope.size > 0 && !scope.has(r.projectId)) continue;
    for (const s of r.stages) {
      const cur =
        map.get(s.stage) ?? { differs: false, changed: 0, localOnly: 0, remoteOnly: 0, local: 0, remote: 0 };
      map.set(s.stage, {
        differs: cur.differs || s.differs,
        changed: cur.changed + s.changed,
        localOnly: cur.localOnly + s.localOnly,
        remoteOnly: cur.remoteOnly + s.remoteOnly,
        local: cur.local + s.local,
        remote: cur.remote + s.remote,
      });
    }
  }
  return map;
}

function StagePicker({
  workflows,
  selected,
  onChange,
  diffByStage,
  diffLoading = false,
  subjectName,
  showEmpty = false,
  collapsible = false,
  defaultExpanded = true,
}: {
  workflows: Workflow[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Aggregated local↔store diff per stage; absent key → no badge. */
  diffByStage?: ReadonlyMap<string, StageDiff>;
  diffLoading?: boolean;
  /** When present, this picker belongs to one independent Feature workflow. */
  subjectName?: string;
  /** App-level sharing keeps one section per Feature, even before it has output. */
  showEmpty?: boolean;
  /** Keep large App transfers compact by showing each Feature as an accordion row. */
  collapsible?: boolean;
  /** Only the first Feature is expanded when an App contains many Features. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const stageNames = useMemo(() => stageNamesOf(workflows), [workflows]);
  // Chỉ đưa vào đây những bước đã thực sự sinh ra kết quả ở máy hoặc ở bản
  // được chia sẻ. Không nên cho người dùng chọn một workflow chưa từng chạy:
  // nó không có gì để chuyển và chỉ làm danh sách dài, khó hiểu.
  const visibleWorkflows = useMemo(() => {
    if (!diffByStage) return [];
    return workflows
      .map((workflow) => ({
        ...workflow,
        pipelineIds: workflow.pipelineIds.filter((pipelineId) => {
          const status = diffByStage.get(pipelineId);
          return Boolean(status && status.local + status.remote > 0);
        }),
      }))
      .filter((workflow) => workflow.pipelineIds.length > 0);
  }, [diffByStage, workflows]);
  const visibleStageIds = visibleWorkflows.flatMap((workflow) => workflow.pipelineIds);
  const selectedVisibleCount = visibleStageIds.filter((id) => selected.has(id)).length;
  const canCollapse = collapsible && Boolean(subjectName);
  const showDetails = !canCollapse || expanded;

  if ((diffLoading || visibleWorkflows.length === 0) && !showEmpty) return null;
  return (
    <section className={sp.section} aria-label={subjectName ? `Các bước của ${subjectName}` : 'Các bước'}>
      {subjectName ? (
        canCollapse ? (
          <button
            type="button"
            className={sp.subject}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Thu gọn' : 'Mở'} các bước của ${subjectName}`}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className={sp.subjectLabel}>Tính năng</span>
            <strong>{subjectName}</strong>
            <span className={sp.subjectMeta}>
              {diffLoading ? 'Đang kiểm tra' : `${selectedVisibleCount}/${visibleStageIds.length} bước`}
            </span>
            <span className={sp.subjectChevron} aria-hidden="true">
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
            </span>
          </button>
        ) : (
          <div className={sp.subject}>
            <span className={sp.subjectLabel}>Tính năng</span>
            <strong>{subjectName}</strong>
          </div>
        )
      ) : null}
      {showDetails ? (
        <>
          <div className={sp.head}>
            <span className={sp.title}>Chọn kết quả muốn đồng bộ</span>
            <span className={sp.hint}>
              {diffLoading ? 'Đang kiểm tra thay đổi…' : 'Bấm vào từng bước để chọn hoặc bỏ chọn kết quả'}
            </span>
            <span className={sp.count}>
              {selectedVisibleCount}/{visibleStageIds.length}
            </span>
          </div>
          {diffLoading ? <div className={sp.empty}>Đang kiểm tra kết quả đã chạy…</div> : null}
          {!diffLoading && visibleWorkflows.length === 0 ? (
            <div className={sp.empty}>Tính năng này chưa có kết quả workflow để đồng bộ.</div>
          ) : null}
          {visibleWorkflows.map((w) => (
            <div key={w.id} className={sp.wf}>
              <div className={sp.wfname}>{w.name}</div>
              <div className={sp.chips}>
                {w.pipelineIds.map((pid) => {
              const d = diffByStage?.get(pid);
              const stageLabel = stageNames.get(pid) ?? pid;
              const parts = d
                ? [
                    d.changed > 0 ? `${d.changed} file thay đổi` : '',
                    d.localOnly > 0 ? `${d.localOnly} tệp chỉ có trên máy` : '',
                    d.remoteOnly > 0 ? `${d.remoteOnly} tệp chỉ có ở bản đã chia sẻ` : '',
                  ].filter(Boolean)
                : [];
              const diffTitle = d
                ? d.differs
                  ? `Có thay đổi: ${parts.join(', ')}`
                  : `Đã cập nhật (trên máy ${d.local} / bản chia sẻ ${d.remote} tệp)`
                : 'Chưa có dữ liệu so sánh';
              // Nhãn hiển thị là tên người-đọc-được; id kỹ thuật thô (docs, ux,
              // ui-html…) vẫn hữu ích khi debug nên giữ lại trong tooltip.
              const title = `${pid} — ${diffTitle}`;
                  return (
                    <button
                      key={pid}
                      type="button"
                      className={sp.chip}
                      aria-pressed={selected.has(pid)}
                      aria-label={`${selected.has(pid) ? 'Bỏ chọn' : 'Chọn'} kết quả ${stageLabel}`}
                      onClick={() => toggle(pid)}
                      title={title}
                    >
                      <span className={sp.tick} aria-hidden="true">
                        ✓
                      </span>
                      <span className={sp.id}>{stageLabel}</span>
                      {d ? (
                        d.differs ? (
                          <span className={`${sp.badge} ${sp.badgeDiff}`}>{stepDifferenceLabel(true, true)}</span>
                        ) : d.local + d.remote > 0 ? (
                          <span className={`${sp.badge} ${sp.badgeSync}`}>{stepDifferenceLabel(false, true)}</span>
                        ) : null
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}

export interface ContextTransferSelection extends ContextTreeSelectionPayload {
  /** Resolution is sent only for Apps whose local and shared Context have
   * both changed. It never changes a Feature binding implicitly. */
  contextConflictResolutions?: Record<string, 'keep_local' | 'use_shared'>;
  /** Historical Feature bindings plus current App version, in install order. */
  contextVersions?: Record<string, string[]>;
}

/** Each Feature owns an independent workflow run, so stage selection must not
 * be flattened when an App contains multiple Features. */
export type FeatureStageSelections = Record<string, string[]>;

export interface ContextSyncAppInput extends ContextTreeApp {
  ownerName?: string | null;
  lastPublishedAt?: string | null;
  alreadyOnThisDevice?: boolean;
}

type ContextCarrier = {
  context?: AppContextSyncInfo | null;
  appContext?: AppContextManifest | {
    current: AppContextManifest;
    localCurrentDigest?: string | null;
  } | null;
  contextManifest?: AppContextManifest | null;
  contextVersion?: string | null;
  currentContextVersion?: string | null;
  latestContextVersion?: string | null;
  sharedContextVersion?: string | null;
  contextDigest?: string | null;
  sharedContextDigest?: string | null;
  contextChangedFiles?: AppContextSyncInfo['changedFiles'];
  appContextBinding?: { contextVersion?: string | null } | null;
};

function contextInfoOf(value: ContextCarrier | undefined): AppContextSyncInfo | null {
  if (!value) return null;
  const nested = value.context ?? null;
  const manifest = value.appContext && 'current' in value.appContext
    ? value.appContext.current
    : value.appContext ?? value.contextManifest ?? null;
  const currentVersion = nested?.currentVersion ?? manifest?.contextVersion ?? value.currentContextVersion ?? value.contextVersion ?? null;
  const sharedVersion = nested?.sharedVersion ?? value.sharedContextVersion ?? null;
  const latestVersion = nested?.latestVersion ?? value.latestContextVersion ?? currentVersion;
  const info: AppContextSyncInfo = {
    currentVersion,
    sharedVersion,
    latestVersion,
    localDigest: nested?.localDigest ?? manifest?.contentDigest ?? value.contextDigest ?? null,
    sharedDigest: nested?.sharedDigest ?? value.sharedContextDigest ?? null,
    changedFiles: nested?.changedFiles ?? value.contextChangedFiles ?? [],
  };
  return Object.values(info).some((field) => Array.isArray(field) ? field.length > 0 : Boolean(field)) ? info : null;
}

function featureBindingOf(value: ContextCarrier | undefined): string | null {
  return value?.appContextBinding?.contextVersion ?? value?.contextVersion ?? null;
}

/** Context is mandatory with an App/Feature transfer, so it belongs in an
 * unobtrusive hover explanation rather than another selectable tree row. */
function AppContextPopover({ appName, version }: { appName: string; version?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="pl-pullall__context-popover"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button type="button" className="pl-pullall__version pl-pullall__context-badge-toggle" aria-label={`Thông tin tài liệu dùng chung của ${appName}`} aria-expanded={open}>
        Bản chung {contextVersionLabel(version)}
      </button>
      {open ? (
        <span className="pl-pullall__context-tooltip" role="tooltip">
          <strong>Tài liệu dùng chung của {appName}</strong>
          <span>Tài liệu tham khảo và tiêu chuẩn thiết kế. Luôn đi kèm khi chia sẻ hoặc lấy dự án này.</span>
        </span>
      ) : null}
    </span>
  );
}

function FolderExpander({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" className="pl-pullall__tree-toggle" aria-expanded={open} aria-label={`${open ? 'Thu gọn' : 'Mở'} ${label}`} onClick={onToggle}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
    </button>
  );
}

/** Toggle one Feature while keeping its mandatory parent Context selected.
 * App-scoped sharing may include any subset of the App's Features. */
function toggleFeatureSelection(
  app: ContextTreeApp,
  featureId: string,
  selection: ContextTreeSelection,
  pinnedAppIds: ReadonlySet<string> = new Set(),
): ContextTreeSelection {
  const featureIds = new Set(selection.featureIds);
  const appIds = new Set(selection.appIds);
  if (featureIds.has(featureId)) featureIds.delete(featureId);
  else featureIds.add(featureId);
  const appStillSelected = app.features.some((feature) => featureIds.has(feature.id));
  if (appStillSelected || pinnedAppIds.has(app.id)) appIds.add(app.id);
  else appIds.delete(app.id);
  return { appIds, featureIds };
}

function toggleUngroupedFeature(featureId: string, selection: ContextTreeSelection): ContextTreeSelection {
  const featureIds = new Set(selection.featureIds);
  if (featureIds.has(featureId)) featureIds.delete(featureId);
  else featureIds.add(featureId);
  return { appIds: new Set(selection.appIds), featureIds };
}

/** Pull remains a one-Feature-at-a-time comparison flow. */
function selectOneFeature(app: ContextTreeApp, featureId: string, selection: ContextTreeSelection): ContextTreeSelection {
  if (selection.featureIds.size === 1 && selection.featureIds.has(featureId)) return emptyContextSelection();
  return { appIds: new Set([app.id]), featureIds: new Set([featureId]) };
}

function selectOneUngroupedFeature(featureId: string, selection: ContextTreeSelection): ContextTreeSelection {
  if (selection.featureIds.size === 1 && selection.featureIds.has(featureId)) return emptyContextSelection();
  return { appIds: new Set(), featureIds: new Set([featureId]) };
}

// ── PullAllModal — pick WHICH remote projects to pull (Req: "Pull all" was
// all-or-nothing; with many remote projects that floods the local mirror)
// and WHICH pipelines' output files come down with them. Lists
// GET /api/kg/remote-projects with checkboxes; Confirm hands the chosen ids
// (+ stages when narrowed) to PipelinesView → POST /api/kg/pull-all.

export function PullAllModal({
  localIds,
  workflows,
  scopeName,
  initialSelectedIds,
  onClose,
  onConfirm,
  syncReady,
  onReconnect,
}: {
  /** Project ids already mirrored locally (badge + preselect-none hint). */
  localIds: ReadonlySet<string>;
  /** The workflow(s) in scope — PipelinesView passes ONLY the active tab's
   *  workflow, so Pull all is per-workflow and never drags the other
   *  workflow's outputs along. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  /** Preselected project ids (the currently-selected project) — the common
   *  "update my project" case stays confirm-only. */
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (selection: ContextTransferSelection, stages: string[]) => Promise<void>;
  syncReady: boolean;
  onReconnect: () => void;
}) {
  const [rows, setRows] = useState<RemoteProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localAppContexts, setLocalAppContexts] = useState<Record<string, {
    version: string | null;
    digest: string | null;
  }>>({});
  // Membership scope note from the daemon (e.g. "chưa đăng nhập") — shown as
  // the empty state so the user knows WHY the list is empty.
  const [scopeReason, setScopeReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ContextTreeSelection>(() => ({
    appIds: new Set<string>(),
    featureIds: new Set(initialSelectedIds?.slice(0, 1) ?? []),
  }));
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(() => allStageIds(workflows));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsedApps, setCollapsedApps] = useState<ReadonlySet<string>>(() => new Set());
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, 'keep_local' | 'use_shared'>>({});
  // Local↔store diff for the stage chips' badges (only locally-mirrored
  // projects have a local side to compare; remote-only ones contribute none).
  const syncStatus = useSyncStatus();
  const diffByStage = aggregateDiff(syncStatus, selection.featureIds);
  const toggleFolder = (appId: string) => setCollapsedApps((current) => {
    const next = new Set(current);
    if (next.has(appId)) next.delete(appId); else next.add(appId);
    return next;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/kg/remote-projects');
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error?.message || j?.error || `remote list failed: ${res.status}`);
        if (!cancelled) {
          setRows((j?.data ?? []) as RemoteProjectSummary[]);
          setScopeReason(typeof j?.reason === 'string' ? j.reason : null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/pipelines/apps')
      .then(async (response) => response.ok ? await response.json() as PipelineAppsResponse : null)
      .then((payload) => {
        if (cancelled || !payload) return;
        setLocalAppContexts(Object.fromEntries(payload.apps.map((app) => [app.id, {
          version: app.context?.current?.contextVersion ?? null,
          digest: app.context?.localCurrentDigest ?? null,
        }])));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const q = search.trim().toLowerCase();
  const rawApps = (rows ?? []).filter((row) => row.isApp);
  const rawFeatures = (rows ?? []).filter((row) => !row.isApp);
  const appsById = new Map(rawApps.map((row) => [row.projectId, row]));
  const remoteApps: ContextSyncAppInput[] = rawApps.map((row) => ({
    id: row.projectId,
    name: row.displayName || row.name,
    context: row.appContext ? {
      currentVersion: row.appContext.current.contextVersion,
      latestVersion: row.appContext.current.contextVersion,
      sharedVersion: row.appContext.current.contextVersion,
      sharedDigest: row.appContext.current.contentDigest,
      localDigest: localAppContexts[row.projectId]?.digest ?? row.appContext.localCurrentDigest ?? null,
      ...(localAppContexts[row.projectId]?.version
        ? { currentVersion: localAppContexts[row.projectId]!.version }
        : {}),
    } : contextInfoOf(row as RemoteProjectSummary & ContextCarrier),
    ownerName: row.ownerName,
    lastPublishedAt: row.lastPublishedAt,
    alreadyOnThisDevice: row.alreadyOnThisDevice || localIds.has(row.projectId) || row.projectId in localAppContexts,
    features: rawFeatures
      .filter((feature) => feature.appId === row.projectId)
      .map((feature) => ({
        id: feature.projectId,
        name: feature.displayName,
        boundVersion: feature.appContextBinding?.contextVersion
          ?? featureBindingOf(feature as RemoteProjectSummary & ContextCarrier),
      })),
  }));
  const ungrouped = rawFeatures.filter((feature) => !feature.appId || !appsById.has(feature.appId));
  const filteredApps = remoteApps.filter((app) => {
    if (!q) return true;
    return app.name.toLowerCase().includes(q)
      || app.id.toLowerCase().includes(q)
      || app.features.some((feature) => feature.name.toLowerCase().includes(q) || feature.id.toLowerCase().includes(q));
  });
  const filteredUngrouped = ungrouped.filter((row) => !q
    || row.displayName.toLowerCase().includes(q)
    || row.projectId.toLowerCase().includes(q));
  useEffect(() => {
    if (remoteApps.length === 0 || selection.featureIds.size === 0) return;
    const missingParent = remoteApps.some((app) =>
      !selection.appIds.has(app.id) && app.features.some((feature) => selection.featureIds.has(feature.id)),
    );
    if (missingParent) setSelection(selectionForFeatures(remoteApps, [...selection.featureIds]));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderUngroupedRow = (r: RemoteProjectSummary) => {
    const isLocal = r.alreadyOnThisDevice || localIds.has(r.projectId);
    return (
      <li key={r.projectId}>
        <label className="pl-pullall__row">
          <input
            type="checkbox"
            checked={selection.featureIds.has(r.projectId)}
            onChange={() => setSelection((current) => selectOneUngroupedFeature(r.projectId, current))}
          />
          <span className="pl-pullall__avatar" aria-hidden="true">
            <Icon name="folder" size={15} />
          </span>
          <span className="pl-pullall__text">
            <span className="pl-pullall__name">{r.displayName}</span>
            <span className="pl-pullall__id">
              {[r.appName, r.ownerName ? `Phụ trách: ${r.ownerName}` : null, r.version ? `Bản ${r.version}` : null, accessRoleLabel(r.accessRole)]
                .filter(Boolean).join(' · ') || r.projectId}
            </span>
          </span>
          <span className="pl-pullall__meta">
            <span className="pl-pullall__badge">{projectTransferLabel(isLocal)}</span>
            <span className="pl-pullall__files">
              {r.availableOutputs.length > 0 ? `${r.availableOutputs.length} nhóm kết quả` : r.files > 0 ? `${r.files} tệp` : 'Chưa có tệp kết quả'}
            </span>
          </span>
        </label>
      </li>
    );
  };

  const submit = async () => {
    if (!syncReady || (selection.appIds.size === 0 && selection.featureIds.size === 0) || busy) return;
    if (selection.featureIds.size > 0 && stageSel.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Always send the explicit stage list: the picker is scoped to the
      // active workflow, so even "all checked" must not sync the OTHER
      // workflow's outputs.
      await onConfirm(
        {
          ...serializeContextSelection(selection),
          contextConflictResolutions: conflictResolutions,
          contextVersions: contextVersionsForSelection(remoteApps, selection),
        },
        [...stageSel],
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`${SYNC_COPY.downloadTitle}${scopeName ? ` — ${scopeName}` : ''}`}
      icon="download"
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selection.featureIds.size > 0
              ? `Đang chọn ${selection.featureIds.size} tính năng`
              : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            // Pull ghi đè file local bằng bản trên store — không phải một hành
            // động "an toàn", nên không dùng style primary/run.
            className="pl-btn pl-btn--danger"
            data-testid="pipeline-pull-confirm"
            onClick={() => void submit()}
            disabled={!syncReady || busy
              || (selection.featureIds.size === 0 && selection.appIds.size === 0)
              || (selection.featureIds.size > 0 && stageSel.size === 0)}
          >
            <Icon name={busy ? 'spinner' : 'download'} size={14} />
            <span>
              {busy
                ? 'Đang lấy về…'
                : selection.featureIds.size === 0
                  ? 'Lấy về máy'
                  : `Lấy tính năng đã chọn`}
            </span>
          </button>
        </>
      }
    >
      {busy ? <ProgressBar label="Đang lấy dữ liệu từ kho chung…" /> : null}
      {!syncReady ? (
        <div className="pl-modal-error" role="alert">
          <span>{SYNC_COPY.reconnectHint}</span>{' '}
          <button type="button" className="pl-btn pl-btn--xs" onClick={onReconnect}>{SYNC_COPY.reconnect}</button>
        </div>
      ) : null}
      {loadError ? (
        <div className="pl-modal-error" role="alert">
          {loadError}
        </div>
      ) : rows === null ? (
        <div className="pl-pullall__state">
          <Icon name="spinner" size={16} />
          <span>{SYNC_COPY.loadingProjects}</span>
        </div>
      ) : rawApps.length === 0 && rawFeatures.length === 0 ? (
        <div className="pl-pullall__state">
          {scopeReason ?? SYNC_COPY.noSharedProjects}
        </div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Chọn dự án và các bước cần lấy kết quả. Dự án mới sẽ được tạo trên máy; dự án đã có sẽ
            được cập nhật. Nếu có thay đổi ở cả hai phía, bạn sẽ được chọn cách xử lý trước khi ghi.
          </p>
          <div className="pl-pullall__picker">
            <div className="pl-pullall__picker-head">
              <div className="pl-pullall__searchbox">
                <Icon name="search" size={18} aria-hidden="true" />
                <input
                  type="search"
                  className="pl-pullall__search"
                  aria-label="Tìm dự án hoặc tính năng"
                  placeholder="Tìm dự án hoặc tính năng…"
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                />
              </div>
              {q ? <button type="button" className="pl-pullall__search-done" onClick={() => setSearch('')}>Xong</button> : null}
              <span className="pl-pullall__picker-count">
                {selection.featureIds.size > 0 ? 'Đã chọn 1 tính năng' : 'Chọn một tính năng'}
              </span>
            </div>
            <div className="pl-pullall__list" role="group" aria-label="Tính năng được chia sẻ">
            <ul className="pl-pullall__items">
              {filteredApps.map((app) => {
                const conflict = Boolean(app.alreadyOnThisDevice && contextNeedsUpdate(app.context));
                const open = !collapsedApps.has(app.id);
                return (
                  <li key={app.id} className="pl-pullall__app-node">
                    <div className="pl-pullall__group pl-pullall__group--selectable">
                      <Icon name="folder-filled" size={15} />
                      <span className="pl-pullall__group-name">{app.name}</span>
                      <AppContextPopover appName={app.name} version={app.context?.latestVersion ?? app.context?.currentVersion} />
                      <FolderExpander open={open} label={app.name} onToggle={() => toggleFolder(app.id)} />
                    </div>
                    {selection.featureIds.size > 0 && selection.appIds.has(app.id) && conflict ? (
                      <fieldset className="pl-pullall__conflict">
                        <legend>Tài liệu dùng chung trên máy cũng đã được sửa. Bạn muốn dùng bản nào?</legend>
                        <label><input type="radio" name={`context-conflict-${app.id}`} checked={conflictResolutions[app.id] === 'keep_local'} onChange={() => setConflictResolutions((current) => ({ ...current, [app.id]: 'keep_local' }))} /> Giữ bản trên máy</label>
                        <label><input type="radio" name={`context-conflict-${app.id}`} checked={conflictResolutions[app.id] !== 'keep_local'} onChange={() => setConflictResolutions((current) => ({ ...current, [app.id]: 'use_shared' }))} /> Dùng bản được chia sẻ</label>
                      </fieldset>
                    ) : null}
                    {open ? <ul className="pl-pullall__items pl-pullall__branch">
                      {app.features.map((feature) => {
                        const latest = app.context?.latestVersion ?? app.context?.currentVersion;
                        const stale = featureHasNewContext(feature, app.context);
                        return (
                          <li key={feature.id}>
                            <label className="pl-pullall__row pl-pullall__row--feature">
                              <input type="checkbox" checked={selection.featureIds.has(feature.id)} onChange={() => setSelection((current) => selectOneFeature(app, feature.id, current))} />
                              <span className="pl-pullall__avatar" aria-hidden="true"><Icon name="folder" size={15} /></span>
                              <span className="pl-pullall__text">
                                <span className="pl-pullall__name">{feature.name}</span>
                                <span className="pl-pullall__id">Đang dùng bộ tài liệu {contextVersionLabel(feature.boundVersion)}</span>
                              </span>
                              {stale ? <span className="pl-pullall__version pl-pullall__version--stale">Có bản {contextVersionLabel(latest)} mới</span> : null}
                            </label>
                          </li>
                        );
                      })}
                    </ul> : null}
                  </li>
                );
              })}
              {filteredUngrouped.map(renderUngroupedRow)}
              {filteredApps.length === 0 && filteredUngrouped.length === 0 ? (
                <li className="pl-pullall__state">{SYNC_COPY.noSearchResults(search)}</li>
              ) : null}
              </ul>
            </div>
          </div>
          {selection.featureIds.size > 0 ? (
            <StagePicker
              workflows={workflows}
              selected={stageSel}
              onChange={setStageSel}
              diffByStage={diffByStage}
              diffLoading={syncStatus === null}
            />
          ) : null}
          {selection.appIds.size === 0 && selection.featureIds.size === 0 ? (
            <div className="pl-modal-error" role="alert">{SYNC_COPY.chooseProject}</div>
          ) : null}
          {selection.featureIds.size > 0 && stageSel.size === 0 ? (
            <div className="pl-modal-error" role="alert">
              {SYNC_COPY.chooseStep}
            </div>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </PlModal>
  );
}

// ── PushAllModal — pick WHICH local projects to push to the shared
// media-service store and WHICH pipelines' output files go with them.
// Mirrors PullAllModal but lists the LOCAL mirror (no fetch needed); Confirm
// hands ids (+ stages when narrowed) to PipelinesView → POST /api/kg/push-all.
export function PushAllModal({
  projects,
  apps,
  workflows,
  scopeName,
  initialSelectedIds,
  initialAppIds,
  destination,
  destinations,
  newDestinationId,
  defaultNewDestinationName,
  onDestinationChange,
  selectionLocked = false,
  onClose,
  onConfirm,
  syncReady,
  onReconnect,
  onUpgradeFeatureContext,
}: {
  /** Local pipeline projects (the push-eligible set). */
  projects: Array<{
    id: string;
    name: string;
    app?: { id: string; name?: string };
    contextVersion?: string | null;
    appContextBinding?: { contextVersion?: string | null } | null;
  }>;
  /** Complete App list, including Apps with zero Feature. */
  apps?: ContextSyncAppInput[];
  /** The workflow(s) in scope — only the active tab's workflow is passed. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  /** Preselected project ids (the currently-selected project). Absent → every
   *  project, the classic Push all. */
  initialSelectedIds?: readonly string[];
  /** Allows an App with no Feature to share its common context by itself. */
  initialAppIds?: readonly string[];
  /** Optional real origin chooser, used by App/Feature share actions. */
  destination?: ProjectSyncOriginSelection | null;
  destinations?: readonly ProjectSyncOrigin[];
  /** Stable generated id used when switching from an existing destination to a new copy. */
  newDestinationId?: string;
  /** Local App/Feature name used when the optional custom name is blank. */
  defaultNewDestinationName?: string;
  onDestinationChange?: (destination: ProjectSyncOriginSelection) => void;
  /** A row action already has a fixed App/Feature scope; don't let its
   * selection UI imply that another tree will be transferred instead. */
  selectionLocked?: boolean;
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (
    selection: ContextTransferSelection,
    stages: string[],
    stagesByFeature?: FeatureStageSelections,
    onProgress?: (operation: ProjectSyncOperation) => void,
  ) => Promise<void>;
  syncReady: boolean;
  onReconnect: () => void;
  onUpgradeFeatureContext?: (
    featureId: string,
    appId: string,
    contextVersion: string,
    contentDigest: string,
  ) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [contextData, setContextData] = useState<Record<string, {
    current: AppContextManifest | null;
    versions: AppContextManifest[];
    bindings: Array<{ featureId: string; binding: FeatureContextBinding }>;
  }>>({});
  // Preselect the caller's project when given (pushing YOUR project is the
  // common case — confirm-only); else every project, the classic Push all.
  const groupedProjects = new Map<string, ContextSyncAppInput>();
  for (const app of apps ?? []) groupedProjects.set(app.id, { ...app, features: [...app.features] });
  const ungroupedProjects: typeof projects = [];
  for (const project of projects) {
    if (!project.app) {
      ungroupedProjects.push(project);
      continue;
    }
    const group = groupedProjects.get(project.app.id) ?? {
      id: project.app.id,
      name: project.app.name ?? project.app.id,
      context: contextInfoOf(project.app as typeof project.app & ContextCarrier),
      features: [],
    };
    if (!group.features.some((feature) => feature.id === project.id)) {
      group.features.push({
        id: project.id,
        name: project.name,
        boundVersion: featureBindingOf(project as typeof project & ContextCarrier),
      });
    }
    groupedProjects.set(group.id, group);
  }
  const appGroups = [...groupedProjects.values()].map((app) => {
    const loaded = contextData[app.id];
    if (!loaded) return app;
    return {
      ...app,
      context: loaded.current ? {
        currentVersion: loaded.current.contextVersion,
        latestVersion: loaded.current.contextVersion,
        localDigest: loaded.current.contentDigest,
        sharedDigest: app.context?.sharedDigest,
        changedFiles: diffContextManifests(
          loaded.current,
          loaded.versions.find((manifest) => manifest.contextVersion === loaded.current?.previousVersion),
        ),
      } : app.context,
      features: app.features.map((feature) => ({
        ...feature,
        boundVersion: loaded.bindings.find((item) => item.featureId === feature.id)?.binding.contextVersion
          ?? feature.boundVersion,
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const appIdsKey = [...groupedProjects.keys()].sort().join('\u0000');
  useEffect(() => {
    let cancelled = false;
    const appIds = appIdsKey ? appIdsKey.split('\u0000') : [];
    void Promise.all(appIds.map(async (appId) => {
      try {
        const response = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/context`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.data) return null;
        return [appId, {
          current: payload.data.current ?? null,
          versions: Array.isArray(payload.data.versions) ? payload.data.versions : [],
          bindings: Array.isArray(payload.data.bindings) ? payload.data.bindings : [],
        }] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries.filter((entry): entry is readonly [string, { current: AppContextManifest | null; versions: AppContextManifest[]; bindings: Array<{ featureId: string; binding: FeatureContextBinding }> }] => entry !== null));
      setContextData(next);
    });
    return () => { cancelled = true; };
  }, [appIdsKey]);
  const initialFeatureIds = initialSelectedIds ?? [];
  const [selection, setSelection] = useState<ContextTreeSelection>(() => {
    const base = selectionForFeatures(appGroups, initialFeatureIds);
    return { appIds: new Set([...base.appIds, ...(initialAppIds ?? [])]), featureIds: base.featureIds };
  });
  const [stageSelByFeature, setStageSelByFeature] = useState<Record<string, ReadonlySet<string>>>({});
  const [search, setSearch] = useState('');
  const [newDestinationName, setNewDestinationName] = useState(
    destination?.mode === 'new' ? destination.name ?? '' : '',
  );
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<ProjectSyncOperation | null>(null);
  const [upgradeBusy, setUpgradeBusy] = useState<string | null>(null);
  const [upgradedFeatures, setUpgradedFeatures] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingUpgrade, setPendingUpgrade] = useState<{
    featureId: string;
    featureName: string;
    appId: string;
    fromVersion: string | null;
    toVersion: string;
    contentDigest: string;
    changedFiles: ContextFileChange[];
  } | null>(null);
  const [collapsedApps, setCollapsedApps] = useState<ReadonlySet<string>>(() => new Set());
  const syncStatus = useSyncStatus();
  const featureNameById = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    for (const app of appGroups) for (const feature of app.features) names.set(feature.id, feature.name);
    return names;
  }, [appGroups, projects]);
  const visibleStagesForFeature = (featureId: string): ReadonlySet<string> => {
    if (!syncStatus) return new Set();
    const diff = aggregateDiff(syncStatus, new Set([featureId]));
    return new Set(workflows.flatMap((workflow) => workflow.pipelineIds).filter((stageId) => {
      const status = diff?.get(stageId);
      return Boolean(status && status.local + status.remote > 0);
    }));
  };
  const selectedStagesForFeature = (featureId: string): ReadonlySet<string> =>
    stageSelByFeature[featureId] ?? visibleStagesForFeature(featureId);
  const selectedFeatureIds = [...selection.featureIds];
  const hasFeatureWithNoSelectedOutput = selectedFeatureIds.some((featureId) => {
    const visible = visibleStagesForFeature(featureId);
    return visible.size > 0 && selectedStagesForFeature(featureId).size === 0;
  });
  const toggleFolder = (appId: string) => setCollapsedApps((current) => {
    const next = new Set(current);
    if (next.has(appId)) next.delete(appId); else next.add(appId);
    return next;
  });
  const searchQuery = search.trim().toLowerCase();
  const filteredAppGroups = appGroups
    .map((app) => {
      if (!searchQuery || app.name.toLowerCase().includes(searchQuery) || app.id.toLowerCase().includes(searchQuery)) return app;
      return {
        ...app,
        features: app.features.filter((feature) =>
          feature.name.toLowerCase().includes(searchQuery) || feature.id.toLowerCase().includes(searchQuery),
        ),
      };
    })
    .filter((app) => app.features.length > 0 || app.name.toLowerCase().includes(searchQuery) || app.id.toLowerCase().includes(searchQuery));
  const filteredUngroupedProjects = ungroupedProjects.filter((project) => !searchQuery
    || project.name.toLowerCase().includes(searchQuery)
    || project.id.toLowerCase().includes(searchQuery));
  const renderUngroupedProject = (project: (typeof projects)[number]) => (
    <li key={project.id}>
      <label className="pl-pullall__row">
        <input
          type="checkbox"
          checked={selection.featureIds.has(project.id)}
          disabled={selectionLocked}
          onChange={() => setSelection((current) => toggleUngroupedFeature(project.id, current))}
        />
        <span className="pl-pullall__avatar" aria-hidden="true"><Icon name="folder" size={15} /></span>
        <span className="pl-pullall__text">
          <span className="pl-pullall__name">{project.name}</span>
          {project.name !== project.id ? <span className="pl-pullall__id">{project.id}</span> : null}
        </span>
      </label>
    </li>
  );

  const submit = async () => {
    if (!syncReady || (selection.appIds.size === 0 && selection.featureIds.size === 0) || busy) return;
    if (syncStatus === null || hasFeatureWithNoSelectedOutput) return;
    setBusy(true);
    setOperation(null);
    setError(null);
    try {
      // Explicit stage list always — see PullAllModal.submit.
      const stagesByFeature = Object.fromEntries(selectedFeatureIds.map((featureId) => [
        featureId,
        [...selectedStagesForFeature(featureId)],
      ]));
      const stageUnion = [...new Set(Object.values(stagesByFeature).flat())];
      await onConfirm({
        ...serializeContextSelection(selection),
        contextVersions: contextVersionsForSelection(appGroups, selection),
      }, stageUnion, stagesByFeature, setOperation);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`${SYNC_COPY.shareTitle}${scopeName ? ` — ${scopeName}` : ''}`}
      icon="upload"
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selection.featureIds.size > 0
              ? `Đang chọn ${selection.featureIds.size} tính năng`
              : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            // Push ghi đè bản trên store (mirror-prune còn xóa file trên store
            // không còn ở local) — cùng lý do PullAllModal đổi sang danger.
            className="pl-btn pl-btn--danger"
            data-testid="pipeline-push-confirm"
            onClick={() => void submit()}
            disabled={!syncReady || busy || syncStatus === null
              || (selection.featureIds.size === 0 && selection.appIds.size === 0)
              || hasFeatureWithNoSelectedOutput}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={14} />
            <span>
              {busy
                ? operation ? `Đang chia sẻ · ${operation.progress.percent}%` : 'Đang chuẩn bị…'
                : selection.featureIds.size === 0
                  ? 'Chia sẻ dự án'
                  : selection.featureIds.size > 1
                      ? `Chia sẻ ${selection.featureIds.size} tính năng đã chọn`
                      : 'Chia sẻ tính năng đã chọn'}
            </span>
          </button>
        </>
      }
    >
      {busy ? (
        <ProgressBar
          label={operation
            ? `Đang chia sẻ · ${operation.progress.completedItems}/${operation.progress.totalItems} mục (${operation.progress.percent}%)`
            : 'Đang chuẩn bị dữ liệu chia sẻ…'}
          percent={operation?.progress.percent}
        />
      ) : null}
      {!syncReady ? (
        <div className="pl-modal-error" role="alert">
          <span>{SYNC_COPY.reconnectHint}</span>{' '}
          <button type="button" className="pl-btn pl-btn--xs" onClick={onReconnect}>{SYNC_COPY.reconnect}</button>
        </div>
      ) : null}
      {destination && onDestinationChange ? (
        <div className="pl-pullall__destination">
          <label htmlFor="pl-share-destination">Chia sẻ vào</label>
          <select
            id="pl-share-destination"
            aria-label="Chia sẻ vào"
            value={destination.mode === 'existing' ? `existing:${destination.originId}` : 'new'}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              onDestinationChange(value === 'new'
                ? {
                    mode: 'new',
                    originId: newDestinationId ?? destination.originId,
                    ...(newDestinationName.trim() ? { name: newDestinationName.trim() } : {}),
                  }
                : { mode: 'existing', originId: value.slice('existing:'.length) });
            }}
          >
            {(destinations ?? []).map((item) => (
              <option key={item.originId} value={`existing:${item.originId}`}>{item.name}</option>
            ))}
            <option value="new">Tạo bản chia sẻ mới</option>
          </select>
          {destination.mode === 'new' ? (
            <div className="pl-pullall__destination-new">
              <label>
                <span>Tên hiển thị mới <em>(không bắt buộc)</em></span>
                <input
                  type="text"
                  aria-label="Tên hiển thị mới trên kho chung"
                  maxLength={160}
                  value={newDestinationName}
                  placeholder={defaultNewDestinationName ? `Giữ tên hiện tại: ${defaultNewDestinationName}` : 'Giữ tên hiện tại'}
                  disabled={busy}
                  onChange={(event) => {
                    const name = event.target.value;
                    setNewDestinationName(name);
                    onDestinationChange({
                      mode: 'new',
                      originId: newDestinationId ?? destination.originId,
                      ...(name.trim() ? { name: name.trim() } : {}),
                    });
                  }}
                />
              </label>
              <small>Hệ thống tự tạo mã. Nếu để trống, bản chia sẻ sẽ giữ tên hiện tại.</small>
            </div>
          ) : null}
        </div>
      ) : null}
      {appGroups.length === 0 && projects.length === 0 ? (
        <div className="pl-pullall__state">Chưa có dự án hoặc tính năng nào trên máy để chia sẻ.</div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            {selectionLocked
              ? 'Tính năng này sẽ được chia sẻ cùng tài liệu dùng chung của dự án.'
              : (initialAppIds?.length ?? 0) > 0
                ? 'Chọn các tính năng muốn chia sẻ. Tài liệu dùng chung của dự án luôn đi kèm.'
                : 'Chọn các tính năng muốn chia sẻ. Tài liệu dùng chung của dự án sẽ luôn đi kèm để đảm bảo kết quả dùng đúng tiêu chuẩn.'}
          </p>
          <div className="pl-pullall__picker">
            <div className="pl-pullall__picker-head">
              <div className="pl-pullall__searchbox">
                <Icon name="search" size={18} aria-hidden="true" />
                <input
                  type="search"
                  className="pl-pullall__search"
                  aria-label="Tìm dự án hoặc tính năng"
                  placeholder="Tìm dự án hoặc tính năng…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              {searchQuery ? <button type="button" className="pl-pullall__search-done" onClick={() => setSearch('')}>Xong</button> : null}
              <span className="pl-pullall__picker-count">
                {selection.featureIds.size > 0 ? `Đã chọn ${selection.featureIds.size} tính năng` : 'Chưa chọn tính năng'}
              </span>
            </div>
            <div className="pl-pullall__list" role="group" aria-label="Tính năng trên máy">
            <ul className="pl-pullall__items">
              {filteredAppGroups.map((app) => {
                const version = app.context?.currentVersion ?? app.context?.latestVersion;
                const open = !collapsedApps.has(app.id);
                return (
                  <li key={app.id} className="pl-pullall__app-node">
                    <div className="pl-pullall__group pl-pullall__group--selectable">
                      <Icon name="folder-filled" size={15} />
                      <span className="pl-pullall__group-name">{app.name}</span>
                      <AppContextPopover appName={app.name} version={version} />
                      <FolderExpander open={open} label={app.name} onToggle={() => toggleFolder(app.id)} />
                    </div>
                    {open ? <ul className="pl-pullall__items pl-pullall__branch">
                      {app.features.map((feature) => {
                        const latest = app.context?.latestVersion ?? app.context?.currentVersion;
                        const stale = !upgradedFeatures.has(feature.id) && featureHasNewContext(feature, app.context);
                        return (
                          <li key={feature.id}>
                            <div className="pl-pullall__row pl-pullall__row--feature">
                              <input
                                type="checkbox"
                                aria-label={`Chọn Feature ${feature.name}`}
                                checked={selection.featureIds.has(feature.id)}
                                disabled={selectionLocked}
                                onChange={() => setSelection((current) => toggleFeatureSelection(
                                  app,
                                  feature.id,
                                  current,
                                  new Set(initialAppIds ?? []),
                                ))}
                              />
                              <span className="pl-pullall__avatar" aria-hidden="true"><Icon name="folder" size={15} /></span>
                              <span className="pl-pullall__text">
                                <span className="pl-pullall__name">{feature.name}</span>
                                <span className="pl-pullall__id">Đang dùng bộ tài liệu {contextVersionLabel(upgradedFeatures.has(feature.id) ? latest : feature.boundVersion)}</span>
                              </span>
                              {stale ? (
                                <button
                                  type="button"
                                  className="pl-pullall__upgrade"
                                  disabled={!onUpgradeFeatureContext || upgradeBusy === feature.id || !latest || !app.context?.localDigest}
                                  title={onUpgradeFeatureContext ? 'Xem thay đổi trước khi dùng bộ tài liệu mới' : 'Cần cập nhật ứng dụng để dùng bản mới'}
                                  onClick={() => {
                                    if (!onUpgradeFeatureContext || !latest || !app.context?.localDigest) return;
                                    setPendingUpgrade({
                                      featureId: feature.id,
                                      featureName: feature.name,
                                      appId: app.id,
                                      fromVersion: feature.boundVersion ?? null,
                                      toVersion: latest,
                                      contentDigest: app.context.localDigest,
                                      changedFiles: [...(app.context.changedFiles ?? [])],
                                    });
                                  }}
                                >
                                  {upgradeBusy === feature.id ? 'Đang cập nhật…' : 'Xem thay đổi'}
                                </button>
                              ) : <span className="pl-pullall__version">Đang dùng bản mới nhất</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul> : null}
                  </li>
                );
              })}
              {filteredUngroupedProjects.length ? (
                <li>
                  <div className="pl-pullall__group"><Icon name="folder" size={13} /><span>Chưa thuộc dự án</span></div>
                  <ul className="pl-pullall__items">{filteredUngroupedProjects.map(renderUngroupedProject)}</ul>
                </li>
              ) : null}
              {filteredAppGroups.length === 0 && filteredUngroupedProjects.length === 0 ? (
                <li className="pl-pullall__state">Không tìm thấy dự án hoặc tính năng phù hợp.</li>
              ) : null}
              </ul>
            </div>
          </div>
          {pendingUpgrade ? (
            <section className="pl-pullall__conflict" role="dialog" aria-label={`Xác nhận nâng Context cho ${pendingUpgrade.featureName}`}>
              <strong>Xem thay đổi trước khi dùng bản mới</strong>
              <p>
                {pendingUpgrade.featureName} đang dùng {contextVersionLabel(pendingUpgrade.fromVersion)} và sẽ chuyển sang{' '}
                {contextVersionLabel(pendingUpgrade.toVersion)} cho các lần chạy tiếp theo. Kết quả và Context của các lần chạy cũ vẫn được giữ nguyên.
              </p>
              {pendingUpgrade.changedFiles.length > 0 ? (
                <ul aria-label="Các tệp Context thay đổi">
                  {pendingUpgrade.changedFiles.map((change) => (
                    <li key={`${change.operation}:${change.path}`}>
                      {change.operation === 'add' ? 'Thêm' : change.operation === 'delete' ? 'Xóa' : 'Sửa'}: {change.path}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Không có chi tiết tệp; hãy kiểm tra version trước khi xác nhận.</p>
              )}
              <div>
                <button type="button" className="pl-btn pl-btn--xs" disabled={upgradeBusy === pendingUpgrade.featureId} onClick={() => setPendingUpgrade(null)}>
                  Giữ bản đang dùng
                </button>{' '}
                <button
                  type="button"
                  className="pl-btn pl-btn--xs pl-btn--danger"
                  disabled={upgradeBusy === pendingUpgrade.featureId}
                  onClick={() => {
                    setUpgradeBusy(pendingUpgrade.featureId);
                    setError(null);
                    void onUpgradeFeatureContext?.(
                      pendingUpgrade.featureId,
                      pendingUpgrade.appId,
                      pendingUpgrade.toVersion,
                      pendingUpgrade.contentDigest,
                    )
                      .then(() => {
                        setUpgradedFeatures((current) => new Set(current).add(pendingUpgrade.featureId));
                        setPendingUpgrade(null);
                      })
                      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
                      .finally(() => setUpgradeBusy(null));
                  }}
                >
                  {upgradeBusy === pendingUpgrade.featureId ? 'Đang cập nhật…' : `Xác nhận dùng ${contextVersionLabel(pendingUpgrade.toVersion)}`}
                </button>
              </div>
            </section>
          ) : null}
          {selectedFeatureIds.map((featureId, index) => (
            <StagePicker
              key={featureId}
              workflows={workflows}
              subjectName={featureNameById.get(featureId) ?? featureId}
              showEmpty
              selected={selectedStagesForFeature(featureId)}
              onChange={(next) => setStageSelByFeature((current) => ({ ...current, [featureId]: next }))}
              diffByStage={aggregateDiff(syncStatus, new Set([featureId]))}
              diffLoading={syncStatus === null}
              collapsible
              defaultExpanded={index === 0}
            />
          ))}
          {selection.appIds.size === 0 && selection.featureIds.size === 0 ? (
            <div className="pl-modal-error" role="alert">{SYNC_COPY.chooseProject}</div>
          ) : null}
          {hasFeatureWithNoSelectedOutput ? (
            <div className="pl-modal-error" role="alert">
              {SYNC_COPY.chooseStep}
            </div>
          ) : null}
          {error ? (
            <div className="pl-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </PlModal>
  );
}

// The old dual-mode NewProjectModal is gone: creating an App and creating a
// Feature are two separate, single-purpose forms now (./NewAppModal.tsx and
// ./NewFeatureModal.tsx, both built on the fresh PipelineFormModal
// primitives). Only the Feature one is re-exported here, because that is the
// one PipelinesView.tsx pulls from this module alongside the other pipelines
// modals; the App form is used from PipelinesRoute.tsx directly.
export { NewFeatureModal } from './NewFeatureModal';
