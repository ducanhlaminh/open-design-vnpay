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
  BasDocument,
  BasDocumentsResponse,
  BasFeature,
  BasFeaturesResponse,
  ChatRunStatusResponse,
  DesignSystemSummary,
  PipelineRunSource,
  PipelineStatus,
  PipelineView,
  ProjectFile,
  ProjectSyncStatus,
  RemoteProject,
  RunAllConfig,
  TargetPlatform,
  UiTarget,
  Workflow,
} from '@open-design/contracts';
import { UI_TARGET_IDS, UI_TARGETS } from '@open-design/contracts';
import type { TrackingProjectKind } from '@open-design/contracts/analytics';

import { Icon, type IconName } from '../Icon';
import { FileViewer } from '../FileViewer';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';
import { AppPoolTree } from './AppPoolTree';
import { PlModal } from './PlModal';
import { UploadDropzone, toPendingFiles, type PendingFile } from './UploadDropzone';
import { ConfluenceTreeImport } from './ConfluenceTreeImport';
import styles from './PipelineSourceModal.module.css';
import sp from './StagePicker.module.css';
import poolStyles from './AppPoolSection.module.css';
import { PipelineFlowCanvas } from './PipelineFlowCanvas';

/** What the run-source modal hands back: either a structured BAS/Confluence
 * source (pre-fetched by the daemon) or a legacy free-text input (JIRA/JQL). */
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
const WORKFLOW_DIR_RE = /^(docs-to-ui|docs-to-prd|docs-review|docs-to-html|docs-to-react)\//;
// Every folder head the daemon may prefix an output with. A file whose first
// segment is NOT one of these has no workflow prefix (legacy flat output).
const KNOWN_WORKFLOW_DIRS = new Set(['docs-to-ui', 'docs-to-prd', 'docs-review', 'docs-to-html', 'docs-to-react']);
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
// Pipeline 1 (jira-ingest) ingests its source docs from the BAS MCP gateway. The
// user picks ONE of two cards:
//   • Confluence — paste a page URL/id; a preview panel shows the page metadata
//     fetched via the daemon's BAS proxy.
//   • BAS — pick a BAS workspace, then check the feature(s)/document(s) to ingest.
// The daemon pre-fetches the choice into the project cwd before the run. A small
// "Advanced" toggle keeps the legacy free-text JIRA key / JQL path.
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
  const [advanced, setAdvanced] = useState(false);

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

  // Advanced (legacy JQL / JIRA key) branch
  const [jql, setJql] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load BAS documents the first time the BAS card is shown.
  useEffect(() => {
    if (advanced || kind !== 'bas' || basDocuments !== null || basDocLoading) return;
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
  }, [advanced, kind, basDocuments, basDocLoading]);

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

  const canRun = advanced
    ? true // JQL is optional — the skill prompts if empty
    : kind === 'confluence'
      ? confPages.length > 0
      : basDocumentId.length > 0; // features optional → whole document

  const submit = async () => {
    if (busy || !canRun) return;
    setBusy(true);
    setError(null);
    try {
      let payload: RunSourcePayload;
      if (advanced) {
        payload = { input: jql.trim() };
      } else if (kind === 'confluence') {
        // One page URL/id per line. When every line parses to a page id the
        // daemon runs the docs stage DETERMINISTICALLY (fetches the pages
        // itself via the BAS gateway — no agent); a short-link/opaque URL
        // falls back to the agent path.
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
      {advanced ? (
        <>
          <label className="pl-modal-field">
            <span className="pl-modal-field__label">JIRA key / JQL</span>
            <input
              type="text"
              className="pl-input"
              autoFocus
              placeholder={placeholder}
              value={jql}
              onChange={(e) => setJql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <span className="pl-modal-field__hint">
              Paste a JIRA project key or JQL. Leave empty to let the skill ask. Pulled via the
              <code> mcp-atlassian</code> server (not BAS).
            </span>
          </label>
          <div className={styles.footerLinks}>
            <button type="button" className={styles.linkBtn} onClick={() => setAdvanced(false)}>
              ← Quay lại chọn nguồn Confluence / BAS
            </button>
          </div>
        </>
      ) : (
        <>
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
              <span className={styles.cardDesc}>Tạm khóa — dùng nguồn Confluence (hoặc JIRA key/JQL ở Advanced).</span>
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

          {/* Lối tắt phụ, gom một hàng ghost-chip — không tranh chú ý với picker. */}
          <div className={styles.footerLinks}>
            {/* "Dán link thủ công" giờ nằm TRONG ConfluencePagePicker. */}
            <button type="button" className={styles.linkBtn} onClick={() => setAdvanced(true)}>
              <Icon name="settings" size={12} />
              <span>Advanced: JIRA key / JQL</span>
            </button>
          </div>
        </>
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
  /** App Docs Pool nguồn (docs/app-docs-pool-spec.md §2.2) — trang CHÍNH đã
   *  tick. Có mặt (paths ≥1) → daemon copy deterministic các trang này vào
   *  `<wf>/docs/` SAU KHI qua GATE (mọi trang trong pool `distilled`); FE chỉ
   *  cho gửi payload này khi `distill.clean === true` (xem `runAllWithSavedConfig`). */
  appPool?: { appId: string; paths: string[] };
}

/** Section duy nhất mà modal hiển thị khi mở từ nút "Đổi" của một dòng trên rail
 *  cấu hình — cùng modal, nhưng chỉ đúng phần người dùng bấm vào. Không truyền =
 *  modal đầy đủ (mọi section). Cả hai chế độ footer đều là "Hủy / Lưu". */
export type RunAllFocus = 'source' | 'designSystem' | 'targets' | 'stages' | 'mode' | 'terminal';

const RUN_ALL_FOCUS_TITLES: Record<RunAllFocus, string> = {
  source: 'Nguồn tài liệu',
  designSystem: 'Design system',
  targets: 'Sản phẩm cần build',
  stages: 'Các bước sẽ chạy',
  mode: 'Chế độ chạy',
  terminal: 'Kết quả UI-Spec',
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
 *  hết — mặc định rỗng sẽ khoá luôn nút Lưu mà không nói được vì sao. */
export function initialStageSelection(
  stages: readonly RunStageOption[],
  savedStageIds?: readonly string[],
): Set<string> {
  const known = new Set(stages.map((s) => s.id));
  const restored = (savedStageIds ?? []).filter((id) => known.has(id));
  if (restored.length > 0) return new Set(restored);
  const pending = stages.filter((s) => s.status !== 'succeeded').map((s) => s.id);
  return new Set(pending.length > 0 ? pending : stages.map((s) => s.id));
}

/**
 * Tick MỘT bước ⇒ kéo theo mọi phụ thuộc CHƯA `succeeded` của nó, đệ quy.
 *
 * Bất biến phải giữ: mỗi bước được tick đều có đủ input tại thời điểm nó chạy.
 * Daemon KHÔNG hỏi gating khi chạy run-all (nó gọi thẳng runPipeline theo thứ
 * tự), nên một lựa chọn thiếu phụ thuộc vẫn chạy thật — với thư mục input rỗng
 * — và trả về kết quả rác trông y như thành công. Phụ thuộc đã `succeeded` thì
 * output có sẵn trên đĩa, không cần chạy lại, nên không bị tự tick (người dùng
 * vẫn tick tay được để regenerate).
 */
export function selectStageWithDeps(
  stageId: string,
  stages: readonly RunStageOption[],
  selected: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const next = new Set(selected);
  const add = (id: string): void => {
    const stage = byId.get(id);
    if (!stage || next.has(id)) return;
    next.add(id);
    for (const dep of stage.dependsOn) {
      const depStage = byId.get(dep);
      if (!depStage || depStage.status === 'succeeded') continue;
      add(dep);
    }
  };
  add(stageId);
  return next;
}

/**
 * Bỏ tick MỘT bước ⇒ bỏ theo mọi bước đang tick mà vì thế mất input, đệ quy —
 * mặt đối xứng của `selectStageWithDeps`, giữ đúng một bất biến. Một bước phụ
 * thuộc vào bước vừa bỏ nhưng bước đó đã `succeeded` thì KHÔNG bị bỏ: output
 * của nó vẫn nằm trên đĩa, việc bỏ chỉ có nghĩa "không chạy lại".
 */
export function deselectStageWithDependents(
  stageId: string,
  stages: readonly RunStageOption[],
  selected: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const next = new Set(selected);
  next.delete(stageId);
  for (;;) {
    let shrank = false;
    for (const stage of stages) {
      if (!next.has(stage.id)) continue;
      const starved = stage.dependsOn.some((dep) => {
        const depStage = byId.get(dep);
        return !!depStage && depStage.status !== 'succeeded' && !next.has(dep);
      });
      if (starved) {
        next.delete(stage.id);
        shrank = true;
      }
    }
    if (!shrank) break;
  }
  return next;
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
  const [appPoolDistill, setAppPoolDistill] = useState<AppPoolResponse['distill'] | null>(null);
  const [appPoolLoading, setAppPoolLoading] = useState(false);
  const [appPoolError, setAppPoolError] = useState<string | null>(null);
  const [appPoolDistilling, setAppPoolDistilling] = useState(false);
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
        setAppPoolDistill(j.distill);
        setAppPoolDistilling(j.distill.running);
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
    setAppPoolDistill(null);
    void refreshAppPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  useEffect(() => {
    if (!appPoolDistilling) return undefined;
    const interval = window.setInterval(() => void refreshAppPool(true), 3000);
    return () => window.clearInterval(interval);
  }, [appPoolDistilling, refreshAppPool]);

  const appPoolAvailable = appId !== undefined && (appPoolPages?.length ?? 0) > 0;
  const startAppPoolDistill = async () => {
    if (!appId) return;
    setAppPoolError(null);
    try {
      const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/distill`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setAppPoolDistilling(true);
      await refreshAppPool(true);
    } catch (cause) {
      setAppPoolError(cause instanceof Error ? cause.message : 'Không chưng cất được tài liệu App.');
    }
  };
  const [terminal, setTerminal] = useState<WorkflowTerminalChoice>(defaultTerminal ?? 'ui-html');
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
        return { stageIds: selectedStages.map((s) => s.id) };
      case 'mode':
        return { lean };
      case 'terminal':
        return { terminal };
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
    (focus === 'mode' && !supportsLean) ||
    (focus === 'terminal' && !hasTerminal);

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

  const terminalCard = (value: WorkflowTerminalChoice, label: string, desc: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={terminal === value}
      className={`${styles.card}${terminal === value ? ' ' + styles.cardSelected : ''}`}
      onClick={() => setTerminal(value)}
    >
      <span className={styles.cardTop}>
        <Icon name={value === 'ui-react' ? 'blocks' : value === 'ui-react-ds' ? 'palette' : value === 'both' ? 'sparkles' : 'file-code'} size={16} />
        {label}
        {terminal === value ? (
          <span className={styles.cardCheck} aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        ) : null}
      </span>
      <span className={styles.cardDesc}>{desc}</span>
    </button>
  );

  // Same card shape as the terminal picker so the two choices read as one set.
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
                      ? 'Tick ít nhất một trang trong Tài liệu App'
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
        <span className="pl-modal-field__label">Nguồn tài liệu (bước 1 — chưng cất &amp; nạp)</span>
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
              <span className={styles.cardDesc}>Daemon tự fetch các trang đã chọn về Markdown.</span>
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
                  Tài liệu App
                  {docsSource === 'app-pool' ? (
                    <span className={styles.cardCheck} aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                </span>
                <span className={styles.cardDesc}>Tick trang từ pool đã import + chưng cất sẵn cho App này.</span>
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
                <span className={styles.cardDesc}>Có sẵn tài liệu — bỏ luôn bước fetch, chạy thẳng từ bước sau.</span>
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
            <div className={poolStyles.header}>
              <p className={styles.hint} style={{ margin: 0 }}>
                {appPoolPaths.size > 0 ? `${appPoolPaths.size} trang đã tick` : 'Tick trang CHÍNH sẽ ingest vào docs/.'}
              </p>
              <button
                type="button"
                className={poolStyles.primaryButton}
                onClick={() => void startAppPoolDistill()}
                disabled={busy || appPoolLoading || appPoolDistilling || (appPoolDistill?.pending ?? 0) === 0}
              >
                Chưng cất tài liệu
                {appPoolDistill?.pending ? <span className={poolStyles.count}>{appPoolDistill.pending}</span> : null}
              </button>
            </div>
            {appPoolDistilling && appPoolDistill?.progress ? (
              <p className={poolStyles.progress}>Tiến độ: {appPoolDistill.progress.done}/{appPoolDistill.progress.total}</p>
            ) : null}
            {appPoolDistill && !appPoolDistill.clean ? (
              <p className="pl-modal-field__hint">
                Còn {appPoolDistill.pending} trang chưa chưng cất — không sao: bước 1 sẽ tự chưng cất trước khi nạp (chạy sẽ lâu hơn). Bấm "Chưng cất tài liệu" ở đây nếu muốn làm trước.
              </p>
            ) : null}
            <input
              className="pl-proj-search"
              value={appPoolQuery}
              onChange={(event) => setAppPoolQuery(event.target.value)}
              placeholder="Tìm trang trong tài liệu App — tick nhiều trang cho workflow…"
              disabled={busy}
            />
            <AppPoolTree
              pages={appPoolPages ?? []}
              query={appPoolQuery}
              selection={{ ticked: appPoolPaths, onToggle: setAppPoolPaths, disabled: busy }}
            />
            <div className={poolStyles.importSection}>
              <button type="button" className={poolStyles.linkButton} onClick={() => setAppPoolImportOpen((open) => !open)}>
                <Icon name="import" size={13} />
                {appPoolImportOpen ? 'Ẩn nhập tài liệu' : 'Import thêm từ Confluence'}
              </button>
              {appPoolImportOpen && appId ? (
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
              ) : null}
            </div>
          </>
        ) : docsSource === 'app-pool' ? (
          <>
            {/* Dự án gắn App nhưng pool RỖNG: không rơi về picker Confluence —
                tài liệu phải nạp ở màn App trước. */}
            {appPoolError ? <p className={styles.empty}>{appPoolError}</p> : null}
            <p className="pl-modal-field__hint">
              App này chưa có tài liệu nào trong pool. Nạp tài liệu ở màn <b>App</b> (mục "Tài liệu
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
              fetch trực tiếp (không cần agent); dán JIRA key/JQL như một dòng nếu muốn chạy qua agent.
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
        <div className={styles.stagePresets}>
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => setStageIds(new Set(stages.map((s) => s.id)))}
            disabled={busy}
          >
            Tất cả
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() =>
              setStageIds(new Set(stages.filter((s) => s.status !== 'succeeded').map((s) => s.id)))
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
                setStageIds(new Set(stages.filter((s) => !isLeanSkippableStage(s)).map((s) => s.id)))
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
        {/* Sơ đồ node: cùng một `stageIds` với danh sách ngay dưới, không phải
            hai nguồn sự thật. Sơ đồ nói được thứ danh sách dọc không nói nổi —
            ba đầu ra UI-Spec là BA NHÁNH SONG SONG, và bước nào chờ bước nào.
            Không truyền `onRunStage`: trong modal cấu hình, chạy lẻ một bước
            không có nghĩa. */}
        <div className={styles.stageGraph}>
          <PipelineFlowCanvas
            pipelines={stages}
            selectedIds={stageIds}
            onToggle={(id) => toggleStage(id)}
          />
        </div>
        <ul className={styles.stageList}>
          {stages.map((stage) => {
            const badge = STAGE_BADGES[stage.status] ?? 'Chưa chạy';
            return (
              <li key={stage.id}>
                <label className={styles.stageRow}>
                  <input
                    type="checkbox"
                    className={styles.stageCheckbox}
                    checked={stageIds.has(stage.id)}
                    onChange={() => toggleStage(stage.id)}
                    disabled={busy}
                  />
                  <span className={styles.stageName}>{stage.name}</span>
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
              </li>
            );
          })}
        </ul>
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
        <span className="pl-modal-field__hint">
          Tick một bước thì các bước nó cần (chưa xong) được tick theo — daemon chạy thẳng chuỗi
          đã chọn, không chờ điều kiện, nên một bước thiếu input sẽ chạy ra kết quả rỗng.
        </span>
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
      {hasTerminal && shows('terminal') ? (
      <div className="pl-modal-field">
        <span className="pl-modal-field__label">Kết quả UI-Spec (bước cuối)</span>
        <div className={styles.cards} role="radiogroup" aria-label="UI-Spec terminal">
          {terminalCard('ui-html', 'HTML prototype', 'Prototype HTML tương tác, mỗi màn một file.')}
          {terminalCard('ui-react', 'React app', 'App Vite + React 19 thật (cần Docker).')}
          {terminalCard('ui-react-ds', 'React DS', 'App React ghép từ bộ design system đã import (cần DS Figma).')}
          {terminalCard('both', 'Cả hai', 'HTML trước, React sau.')}
        </div>
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
// If a step produces NO previewable file (docs) we fall back to listing
// everything so the modal is never empty.
function isUiPreviewFile(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  // dr-review's "the run produced no review" note (sibling of `review/`, see
  // apps/daemon/src/docs-review.ts's DOCS_REVIEW_FAILURE_NOTE) — surfaced here
  // so Quick result shows the readable failure reason instead of an empty
  // list when the stage failed before any page succeeded.
  if (base === 'review-khong-chay-duoc.md') return true;
  if (base === 'screen.json') return true;
  // UI-Spec previews: React per-screen pages + HTML prototype (not the
  // dist/index.html bundle, dev entry, or build assets).
  if (/\.html?$/.test(base)) {
    return /(^|\/)dist\/screens\//.test(lower) || /(^|\/)prototype\//.test(lower);
  }
  // Prototype auto-demo recording (Playwright walkthrough video).
  if (/(^|\/)prototype-demo\/.*\.webm$/.test(lower)) return true;
  // Ingested doc PAGES (docs/**/*.md) — the readable content. NOT the _index
  // companion (a table of contents) and NOT the image files (those render
  // INLINE inside each page now, so listing them as separate entries is noise).
  if (/(^|\/)docs\/.+\.md$/.test(lower)) return base !== '_index.md';
  // Primary visual spec docs (UX Spec / Customer Journey).
  if (/-ux-spec\.json$/.test(base) || /-(customer-journey|journey|cj)\.json$/.test(base)) return true;
  // docs-review's digest (review/summary.md) — the clone pages themselves
  // already match the docs/**/*.md rule above.
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
function PipelineResultBody({
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
        No output files yet for this stage. Run it (or <strong>Tải dự án về…</strong> from KGS) to
        produce its {outputs.join(', ') || 'outputs'}.
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
      <aside className="pl-result-rail" aria-label="Output files">
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
}: {
  workflows: Workflow[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Aggregated local↔store diff per stage; absent key → no badge. */
  diffByStage?: ReadonlyMap<string, StageDiff>;
  diffLoading?: boolean;
}) {
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const stageNames = useMemo(() => stageNamesOf(workflows), [workflows]);
  return (
    <section className={sp.section} aria-label="Pipelines">
      <div className={sp.head}>
        <span className={sp.title}>Pipelines</span>
        <span className={sp.hint}>
          {diffLoading ? 'đang so với store…' : 'bỏ tích bước nào thì output bước đó không đồng bộ'}
        </span>
        <span className={sp.count}>
          {selected.size}/{allStageIds(workflows).size}
        </span>
      </div>
      {workflows.map((w) => (
        <div key={w.id} className={sp.wf}>
          <div className={sp.wfname}>{w.name}</div>
          <div className={sp.chips}>
            {w.pipelineIds.map((pid) => {
              const d = diffByStage?.get(pid);
              const parts = d
                ? [
                    d.changed > 0 ? `${d.changed} file thay đổi` : '',
                    d.localOnly > 0 ? `${d.localOnly} file chỉ có local` : '',
                    d.remoteOnly > 0 ? `${d.remoteOnly} file chỉ có trên store` : '',
                  ].filter(Boolean)
                : [];
              const diffTitle = d
                ? d.differs
                  ? `Khác store: ${parts.join(', ')}`
                  : `Đồng bộ với store (local ${d.local} / store ${d.remote} file)`
                : 'Chưa có dữ liệu so sánh với store';
              // Nhãn hiển thị là tên người-đọc-được; id kỹ thuật thô (docs, ux,
              // ui-html…) vẫn hữu ích khi debug nên giữ lại trong tooltip.
              const title = `${pid} — ${diffTitle}`;
              return (
                <button
                  key={pid}
                  type="button"
                  className={sp.chip}
                  aria-pressed={selected.has(pid)}
                  onClick={() => toggle(pid)}
                  title={title}
                >
                  <span className={sp.tick} aria-hidden="true">
                    ✓
                  </span>
                  <span className={sp.id}>{stageNames.get(pid) ?? pid}</span>
                  {d ? (
                    d.differs ? (
                      <span className={`${sp.badge} ${sp.badgeDiff}`}>≠ remote</span>
                    ) : d.local + d.remote > 0 ? (
                      <span className={`${sp.badge} ${sp.badgeSync}`}>đồng bộ</span>
                    ) : null
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
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
  onConfirm: (projectIds: string[], stages: string[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<RemoteProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Membership scope note from the daemon (e.g. "chưa đăng nhập") — shown as
  // the empty state so the user knows WHY the list is empty.
  const [scopeReason, setScopeReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds ?? []),
  );
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(() => allStageIds(workflows));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  // Local↔store diff for the stage chips' badges (only locally-mirrored
  // projects have a local side to compare; remote-only ones contribute none).
  const syncStatus = useSyncStatus();
  const diffByStage = aggregateDiff(syncStatus, selected);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/kg/remote-projects');
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error?.message || j?.error || `remote list failed: ${res.status}`);
        if (!cancelled) {
          setRows((j?.data ?? []) as RemoteProject[]);
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

  const q = search.trim().toLowerCase();
  const matchesQuery = (r: RemoteProject) =>
    !q || r.name.toLowerCase().includes(q) || r.projectId.toLowerCase().includes(q);

  // Apps group features but have no KGS workspace of their own (mirrors
  // pipeline-studio's server/apps.ts) — never individually pullable, so they
  // never enter `filtered`/`selected`; they're only rendered as headers.
  const appsById = new Map((rows ?? []).filter((r) => r.isApp).map((r) => [r.projectId, r]));
  const features = (rows ?? []).filter((r) => !r.isApp);
  const filtered = features.filter(matchesQuery);
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.projectId));

  // Group visible features by parent app (pipeline-studio App → Feature
  // hierarchy); features with no appId, or whose app isn't in this list
  // (filtered by scope), stay in the "ungrouped" bucket.
  const grouped = new Map<string, RemoteProject[]>();
  const ungrouped: RemoteProject[] = [];
  for (const r of filtered) {
    const appId = r.appId && appsById.has(r.appId) ? r.appId : null;
    if (!appId) {
      ungrouped.push(r);
      continue;
    }
    const list = grouped.get(appId) ?? [];
    list.push(r);
    grouped.set(appId, list);
  }
  const appGroups = [...grouped.entries()]
    .map(([appId, items]) => ({ app: appsById.get(appId)!, items }))
    .sort((a, b) => a.app.name.localeCompare(b.app.name));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAllVisible = () => {
    const next = new Set(selected);
    if (allVisibleSelected) for (const r of filtered) next.delete(r.projectId);
    else for (const r of filtered) next.add(r.projectId);
    setSelected(next);
  };
  const renderRow = (r: RemoteProject, nested: boolean) => {
    const isLocal = localIds.has(r.projectId);
    return (
      <li key={r.projectId}>
        <label className={`pl-pullall__row${nested ? ' pl-pullall__row--nested' : ''}`}>
          <input type="checkbox" checked={selected.has(r.projectId)} onChange={() => toggle(r.projectId)} />
          <span className="pl-pullall__avatar" aria-hidden="true">
            <Icon name="folder" size={15} />
          </span>
          <span className="pl-pullall__text">
            <span className="pl-pullall__name">{r.name}</span>
            {r.name !== r.projectId ? <span className="pl-pullall__id">{r.projectId}</span> : null}
          </span>
          <span className="pl-pullall__meta">
            {isLocal ? <span className="pl-pullall__badge">local</span> : null}
            <span className="pl-pullall__files">
              {r.files > 0 ? `${r.files} files` : r.inKgs ? 'graph only' : '—'}
            </span>
          </span>
        </label>
      </li>
    );
  };

  const submit = async () => {
    if (selected.size === 0 || stageSel.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Always send the explicit stage list: the picker is scoped to the
      // active workflow, so even "all checked" must not sync the OTHER
      // workflow's outputs.
      await onConfirm([...selected], [...stageSel]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Pull projects from KGS${scopeName ? ` — ${scopeName}` : ''}`}
      icon="download"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selected.size > 0 ? `${selected.size} of ${features.length} selected` : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            // Pull ghi đè file local bằng bản trên store — không phải một hành
            // động "an toàn", nên không dùng style primary/run.
            className="pl-btn pl-btn--danger"
            onClick={() => void submit()}
            disabled={busy || selected.size === 0 || stageSel.size === 0}
          >
            <Icon name={busy ? 'spinner' : 'download'} size={14} />
            <span>
              {busy
                ? 'Pulling…'
                : selected.size === 0
                  ? 'Pull'
                  : `Pull ${selected.size} project${selected.size > 1 ? 's' : ''}`}
            </span>
          </button>
        </>
      }
    >
      {loadError ? (
        <div className="pl-modal-error" role="alert">
          {loadError}
        </div>
      ) : rows === null ? (
        <div className="pl-pullall__state">
          <Icon name="spinner" size={16} />
          <span>Loading remote projects…</span>
        </div>
      ) : features.length === 0 ? (
        <div className="pl-pullall__state">
          {scopeReason ?? 'Không có dự án nào bạn được tham gia trên store — nhờ quản lý add bạn vào dự án trên Pipeline Studio.'}
        </div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Choose which remote projects to mirror locally — graph and output files are pulled
            together. Kéo về sẽ <strong>ghi đè</strong> file local hiện có bằng bản trên store (bản
            local hiện tại được lưu vào Lịch sử trước khi ghi đè, khôi phục được nếu cần).
          </p>
          {features.length > 8 ? (
            <input
              type="search"
              className="pl-pullall__search"
              placeholder="Search by name or id…"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
            />
          ) : null}
          <div className="pl-pullall__list" role="group" aria-label="Remote projects">
            <label className="pl-pullall__head">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              <span className="pl-pullall__headlabel">
                Select all{q ? ' matches' : ''}
              </span>
              <span className="pl-pullall__headcount">
                {selected.size}/{features.length}
              </span>
            </label>
            <ul className="pl-pullall__items">
              {/* App → Feature hierarchy (pipeline-studio's App concept): each
                  app is a non-checkable group header — it has no KGS
                  workspace of its own — with its features nested underneath. */}
              {appGroups.map(({ app, items }) => (
                <li key={app.projectId}>
                  <div className="pl-pullall__group">
                    <Icon name="folder-filled" size={13} />
                    <span>{app.name}</span>
                  </div>
                  <ul className="pl-pullall__items">{items.map((r) => renderRow(r, true))}</ul>
                </li>
              ))}
              {ungrouped.map((r) => renderRow(r, false))}
              {filtered.length === 0 ? (
                <li className="pl-pullall__state">No project matches “{search}”.</li>
              ) : null}
            </ul>
          </div>
          <StagePicker
            workflows={workflows}
            selected={stageSel}
            onChange={setStageSel}
            diffByStage={diffByStage}
            diffLoading={syncStatus === null}
          />
          {stageSel.size === 0 ? (
            <div className="pl-modal-error" role="alert">
              Chọn ít nhất một pipeline để pull.
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

// ── PushAllModal — pick WHICH local projects to push back to KGS and WHICH
// pipelines' output files go with them (the graph push stays whole-project).
// Mirrors PullAllModal but lists the LOCAL mirror (no fetch needed); Confirm
// hands ids (+ stages when narrowed) to PipelinesView → POST /api/kg/push-all.
export function PushAllModal({
  projects,
  workflows,
  scopeName,
  initialSelectedIds,
  onClose,
  onConfirm,
}: {
  /** Local pipeline projects (the push-eligible set). */
  projects: Array<{ id: string; name: string }>;
  /** The workflow(s) in scope — only the active tab's workflow is passed. */
  workflows: Workflow[];
  /** Active workflow name, shown in the modal title. */
  scopeName?: string;
  /** Preselected project ids (the currently-selected project). Absent → every
   *  project, the classic Push all. */
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  /** Always receives the explicit stage list of the scoped workflow. */
  onConfirm: (projectIds: string[], stages: string[]) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Preselect the caller's project when given (pushing YOUR project is the
  // common case — confirm-only); else every project, the classic Push all.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds?.length ? initialSelectedIds : projects.map((p) => p.id)),
  );
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(() => allStageIds(workflows));
  const [busy, setBusy] = useState(false);
  const syncStatus = useSyncStatus();
  const diffByStage = aggregateDiff(syncStatus, selected);

  const allSelected = projects.length > 0 && projects.every((p) => selected.has(p.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id)));
  };

  const submit = async () => {
    if (selected.size === 0 || stageSel.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Explicit stage list always — see PullAllModal.submit.
      await onConfirm([...selected], [...stageSel]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlModal
      title={`Push projects to KGS${scopeName ? ` — ${scopeName}` : ''}`}
      icon="upload"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="pl-pullall__footcount" aria-live="polite">
            {selected.size > 0 ? `${selected.size} of ${projects.length} selected` : ''}
          </span>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button
            type="button"
            // Push ghi đè bản trên store (mirror-prune còn xóa file trên store
            // không còn ở local) — cùng lý do PullAllModal đổi sang danger.
            className="pl-btn pl-btn--danger"
            onClick={() => void submit()}
            disabled={busy || selected.size === 0 || stageSel.size === 0}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={14} />
            <span>
              {busy
                ? 'Pushing…'
                : selected.size === 0
                  ? 'Push'
                  : `Push ${selected.size} project${selected.size > 1 ? 's' : ''}`}
            </span>
          </button>
        </>
      }
    >
      {projects.length === 0 ? (
        <div className="pl-pullall__state">Chưa có project local nào để push.</div>
      ) : (
        <>
          <p className="pl-pullall__hint">
            Chọn project và pipeline muốn đẩy lên store — graph luôn push cả project, phần
            pipeline chỉ lọc file output. Đẩy sẽ <strong>ghi đè</strong> bản trên store bằng file
            local — file trên store không còn tồn tại ở local sẽ bị xóa theo; bản cũ trên store vẫn
            xem lại được ở tab Lịch sử.
          </p>
          <div className="pl-pullall__list" role="group" aria-label="Local projects">
            <label className="pl-pullall__head">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span className="pl-pullall__headlabel">Select all</span>
              <span className="pl-pullall__headcount">
                {selected.size}/{projects.length}
              </span>
            </label>
            <ul className="pl-pullall__items">
              {projects.map((p) => (
                <li key={p.id}>
                  <label className="pl-pullall__row">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="pl-pullall__avatar" aria-hidden="true">
                      <Icon name="folder" size={15} />
                    </span>
                    <span className="pl-pullall__text">
                      <span className="pl-pullall__name">{p.name}</span>
                      {p.name !== p.id ? <span className="pl-pullall__id">{p.id}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <StagePicker
            workflows={workflows}
            selected={stageSel}
            onChange={setStageSel}
            diffByStage={diffByStage}
            diffLoading={syncStatus === null}
          />
          {stageSel.size === 0 ? (
            <div className="pl-modal-error" role="alert">
              Chọn ít nhất một pipeline để push.
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
