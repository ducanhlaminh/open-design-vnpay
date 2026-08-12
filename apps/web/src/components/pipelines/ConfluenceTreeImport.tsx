'use client';

// Confluence eager parent/child tree picker — recovers the browsing UX that
// existed briefly on `ConfluenceRootField` (PipelineFormModal.tsx) before it
// was reverted in cfef0fe ("bỏ toàn bộ hướng 'Tài liệu App'"). That revert
// only reverted the App-docs-tree DIRECTION (a persistent "Confluence root"
// field on the App form); the tree-browsing MACHINERY itself — eager subtree
// fetch, hasChildren-aware chevrons, ancestor breadcrumbs — is still the right
// shape for "search a Confluence page, then tick it or any of its descendants".
//
// Cây con nạp sớm nhưng MẶC ĐỊNH ĐÓNG (bản trước mở sẵn mọi tầng). Một truy
// vấn thường trả về chục trang cha, mở hết thành vài trăm hàng và chính trang
// người dùng đang tìm bị đẩy khỏi màn hình. Nạp sớm vẫn giữ nguyên vì nó trả
// lời được câu "trang này có con thật không" — thứ quyết định hàng đó có mũi
// tên hay không — và làm cú bấm mở ra không phải chờ mạng.
//
// Recovered from `git show cfef0fe^:apps/web/src/components/pipelines/PipelineFormModal.tsx`:
//   useConfluenceTitleSearch, confluenceHitMeta, ConfluenceDescNode,
//   buildConfluenceDescTree, collectDescendantIds, buildConfluenceNodeIndex.
//
// KHÔNG còn portal dropdown. Kết quả tìm đổ thẳng vào vùng danh sách của panel
// (cùng chỗ với danh sách trang đã tick, chuyển chế độ theo ô tìm có chữ hay
// không). Dropdown cũ phải render qua portal vào document.body kèm toán
// flip-above chỉ để thoát `overflow-y: auto` của modal — và đổi lại nó che mất
// chính cái panel đang chọn, không cuộn cùng modal, đè lên footer trên màn hẹp,
// và kéo theo cả một bộ outside-click + listener resize/scroll. Đổ inline bỏ
// hết chỗ đó, không mất tính năng nào.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function normalizeConfluenceSearch(value: string): string {
  return value
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('vi')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function fuzzyTokenScore(queryToken: string, candidateToken: string): number {
  if (queryToken === candidateToken) return 0;
  if (candidateToken.startsWith(queryToken)) return 2;
  if (candidateToken.includes(queryToken)) return 4;
  if (queryToken.length === candidateToken.length) {
    for (let index = 0; index < queryToken.length - 1; index += 1) {
      const swapped = `${queryToken.slice(0, index)}${queryToken[index + 1]}${queryToken[index]}${queryToken.slice(index + 2)}`;
      if (swapped === candidateToken) return 7;
    }
  }
  const distance = editDistance(queryToken, candidateToken);
  const allowed = queryToken.length >= 6 ? 2 : queryToken.length >= 4 ? 1 : 0;
  return distance <= allowed ? 6 + distance : Number.POSITIVE_INFINITY;
}

/** Accent-insensitive fuzzy rank for the Confluence picker. Title matches
 * lead, followed by breadcrumb/space/id matches; misspelled tokens are
 * tolerated without hiding the upstream results entirely. */
export function rankConfluenceHits(query: string, hits: readonly ConfluencePageHit[]): ConfluencePageHit[] {
  const normalizedQuery = normalizeConfluenceSearch(query);
  if (!normalizedQuery) return [...hits];
  const queryTokens = normalizedQuery.split(' ');
  return hits
    .map((hit, index) => {
      const title = normalizeConfluenceSearch(hit.title);
      const titleTokens = title.split(' ').filter(Boolean);
      const metadata = normalizeConfluenceSearch([hit.space, ...(hit.ancestors ?? []), hit.id].filter(Boolean).join(' '));
      let score: number;
      if (title === normalizedQuery) score = 0;
      else if (title.startsWith(normalizedQuery)) score = 5;
      else if (title.includes(normalizedQuery)) score = 10 + title.indexOf(normalizedQuery);
      else {
        const tokenScores = queryTokens.map((token) => {
          const titleScore = Math.min(...titleTokens.map((candidate) => fuzzyTokenScore(token, candidate)));
          if (Number.isFinite(titleScore)) return titleScore;
          return metadata.includes(token) ? 18 : 80;
        });
        score = 24 + tokenScores.reduce((total, value) => total + value, 0);
      }
      return { hit, score, index };
    })
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ hit }) => hit);
}

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
    let cancelled = false;
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const search = async (value: string): Promise<ConfluencePageHit[]> => {
            const res = await fetch(`/api/pipelines/confluence/pages?q=${encodeURIComponent(value)}`);
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            return (j as { pages?: ConfluencePageHit[] }).pages ?? [];
          };
          let pages = await search(query);
          // Confluence searches the full CQL phrase. When that returns no
          // rows, use up to two meaningful words to obtain a candidate set,
          // then rank it against the original phrase locally.
          if (pages.length === 0) {
            const fallbackTerms = [...new Set(query.split(/\s+/).filter((term) => normalizeConfluenceSearch(term).length >= 2))]
              .sort((left, right) => right.length - left.length)
              .slice(0, 2);
            const fallback = await Promise.all(fallbackTerms.map(search));
            const byId = new Map(fallback.flat().map((page) => [page.id, page]));
            pages = [...byId.values()];
          }
          if (!cancelled) setHits(rankConfluenceHits(query, pages));
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setHits([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      timer.current = undefined;
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
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

/** Every descendant id under a node, NOT including the node itself — what a
 *  cascade-tick on this node must also add/remove from the ticked set. */
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

function collectDescendantIds(node: ConfluenceDescNode): string[] {
  return node.children.flatMap((child) => [child.id, ...collectDescendantIds(child)]);
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
  // Expand/collapse state shared by top-level hits AND any nested descendant
  // node (keyed by pageId) — expanding a hit for the FIRST time also
  // triggers its one-shot sub-tree fetch (see descByHit below); expanding a
  // node that's already loaded is pure local state, no fetch.
  const [expandedNode, setExpandedNode] = useState<Set<string>>(new Set());
  const [descByHit, setDescByHit] = useState<Record<string, ConfluenceDescNode | 'loading' | 'error'>>({});

  const trimmed = query.trim();
  const { hits, loading, error } = useConfluenceTitleSearch(query);
  // Kết quả tìm hiện NGAY TRONG vùng danh sách của panel, không phải một
  // dropdown nổi. Dropdown cũ phải render qua portal vào document.body kèm
  // toán flip-above để thoát `overflow-y: auto` của modal — và đổi lại, nó che
  // mất chính cái panel đang chọn, không cuộn cùng modal, và trên màn hẹp thì
  // đè lên cả footer. Cùng một khung nhìn cho "đang tìm" và "đã tick" bỏ hết
  // các vấn đề đó, không cần một mét vuông định vị nào.
  const searching = trimmed.length >= 2;

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

  // Fetch dedupe is tracked in a REF (not derived from `descByHit` state) so
  // dispatching fetches doesn't need `descByHit` as an effect dependency —
  // persists across searches: a page seen again under a different query is
  // never re-fetched.
  const dispatchedFetch = useRef<Set<string>>(new Set());
  const fetchHitSubtree = useCallback((hit: ConfluencePageHit) => {
    if (dispatchedFetch.current.has(hit.id)) return;
    dispatchedFetch.current.add(hit.id);
    setDescByHit((m) => ({ ...m, [hit.id]: 'loading' }));
    // Cây con vẫn được nạp SỚM (để chevron biết trang có con thật hay không, và
    // để mở ra là có ngay), nhưng KHÔNG tự mở nữa: một truy vấn như "Kế toán"
    // trả về chục kết quả, mở hết mọi tầng biến danh sách thành vài trăm hàng
    // và trang cha — thứ người dùng đang tìm — trôi mất khỏi màn hình.
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines/confluence/descendants?ref=${encodeURIComponent(hit.id)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        const flat = (j.pages ?? []) as Array<{ pageId: string; title: string; treePath: string[] }>;
        setDescByHit((m) => ({ ...m, [hit.id]: buildConfluenceDescTree(hit.id, hit.title, flat) }));
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

  // Tên trang của mọi id ĐÃ THẤY trong phiên này, tích luỹ dần. Phải là cache
  // chứ không phải tra thẳng `hits`: `hits` chỉ chứa kết quả của truy vấn HIỆN
  // TẠI, nên một trang tick dưới từ khoá trước sẽ mất tên (rơi về id thô) ngay
  // khi người dùng gõ từ khoá mới — đúng lúc danh sách "đã tick" cần nó nhất.
  const [titleCache, setTitleCache] = useState<Record<string, string>>({});
  useEffect(() => {
    setTitleCache((prev) => {
      const next = { ...prev };
      let grew = false;
      const put = (id: string, title: string) => {
        if (next[id] === title) return;
        next[id] = title;
        grew = true;
      };
      for (const h of hits ?? []) put(h.id, h.title);
      for (const [id, node] of nodeIndex) put(id, node.title);
      for (const r of related ?? []) put(r.pageId, r.title);
      return grew ? next : prev;
    });
  }, [hits, nodeIndex, related]);

  // Checkbox cho phép chọn nhiều tài liệu; chọn trang cha sẽ chọn cả cây con
  // đã nạp để khi nhập không mất các trang liên quan trong cùng nhánh.
  const toggleNode = (id: string) => {
    const node = nodeIndex.get(id);
    const descendants = node ? collectDescendantIds(node) : [];
    const next = new Set(ticked);
    if (next.has(id)) {
      next.delete(id);
      descendants.forEach((childId) => next.delete(childId));
    } else {
      next.add(id);
      descendants.forEach((childId) => next.add(childId));
    }
    onTickedChange(next);
  };

  useEffect(() => {
    const missing = new Set<string>();
    for (const id of ticked) {
      const node = nodeIndex.get(id);
      if (!node) continue;
      for (const childId of collectDescendantIds(node)) {
        if (!ticked.has(childId)) missing.add(childId);
      }
    }
    if (missing.size === 0) return;
    const next = new Set(ticked);
    missing.forEach((childId) => next.add(childId));
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
          className={`${styles.nodeRow}${on ? ' ' + styles.rowOn : ''}${hasKids ? '' : ' ' + styles.rowLeaf}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={hasKids ? () => toggleExpandedNode(node.id) : undefined}
        >
          {renderTickBox(node.id, node.title, () => toggleNode(node.id))}
          <span className={styles.optionTitle}>{node.title}</span>
          {/* Nút tròn ở mép phải chỉ dùng để mở/đóng cây, tách hẳn khỏi radio
              chọn tài liệu ở bên trái. */}
          {hasKids ? (
            <button
              type="button"
              className={`${styles.chevron}${isExpanded ? ' ' + styles.chevronOpen : ''}`}
              aria-label={`${isExpanded ? 'Thu gọn' : 'Mở'} ${node.title}`}
              aria-expanded={isExpanded}
              onClick={(event) => { event.stopPropagation(); toggleExpandedNode(node.id); }}
            >
              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : null}
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
        {/* Bấm HÀNG = mở/đóng cây con; tick chỉ đổi khi bấm đúng ô tick. Hai
            hành động này khác hẳn nhau về hậu quả — mở cây con là xem, tick là
            quyết định trang nào được nhập — nên gộp cả hai vào một vùng bấm
            khiến người duyệt cây tick nhầm liên tục. Hàng không có con thì
            không có gì để mở, nên nó KHÔNG bấm được (xem `.rowLeaf`): giả vờ
            bấm được rồi không phản ứng gì còn khó hiểu hơn. */}
        <div
          className={`${styles.hitRow}${on ? ' ' + styles.rowOn : ''}${showChevron ? '' : ' ' + styles.rowLeaf}`}
          title={meta.fullPath ?? undefined}
          onClick={showChevron ? () => toggleExpandedNode(h.id) : undefined}
        >
          {renderTickBox(h.id, h.title, () => toggleNode(h.id))}
          <span className={styles.optionBody}>
            <span className={styles.optionTitle}>{h.title}</span>
            <span className={styles.optionMeta}>{meta.text}</span>
          </span>
          {showChevron ? (
            <button
              type="button"
              className={`${styles.chevron}${isExpanded ? ' ' + styles.chevronOpen : ''}`}
              aria-label={`${isExpanded ? 'Thu gọn' : 'Mở'} ${h.title}`}
              aria-expanded={isExpanded}
              onClick={(event) => { event.stopPropagation(); toggleExpandedNode(h.id); }}
            >
              <Icon name={desc === 'loading' ? 'spinner' : isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : null}
        </div>
        {isExpanded && desc === 'loading' ? (
          <p className={styles.msg} style={{ paddingLeft: 35 }}>
            Đang tải…
          </p>
        ) : null}
        {isExpanded && desc === 'error' ? (
          <p className={styles.msg} style={{ paddingLeft: 35 }}>
            Không tải được trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error' && desc.children.length === 0 ? (
          <p className={styles.msg} style={{ paddingLeft: 35 }}>
            Không có trang con.
          </p>
        ) : null}
        {isExpanded && desc && desc !== 'loading' && desc !== 'error' ? desc.children.map((c) => renderDescNode(c, 1)) : null}
      </div>
    );
  };

  /** Checkbox dùng chung cho hàng kết quả và hàng cây con. */
  const renderTickBox = (pageId: string, title: string, onToggle: () => void) => {
    const selected = ticked.has(pageId);
    const node = nodeIndex.get(pageId);
    const children = node ? collectDescendantIds(node) : [];
    const partial = children.length > 0 && (
      selected
        ? children.some((childId) => !ticked.has(childId))
        : children.some((childId) => ticked.has(childId))
    );
    return (
      <button
        type="button"
        className={`${styles.checkbox} ${styles.checkboxBtn}${selected ? ' ' + styles.checkboxOn : partial ? ' ' + styles.checkboxPartial : ''}`}
        aria-checked={partial ? 'mixed' : selected}
        role="checkbox"
        aria-label={`${selected ? 'Bỏ chọn' : 'Chọn'} ${title}`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {selected ? <Icon name="check" size={11} /> : partial ? <Icon name="minus" size={11} /> : null}
      </button>
    );
  };

  // Bỏ tick từ danh sách "đã tick": trang đến từ nhánh "liên quan" phải đi qua
  // `toggleRelated` để `relatedTicked` (cờ gửi lên daemon) không bị bỏ lại.
  const untick = (id: string) => {
    if (relatedTicked?.has(id)) toggleRelated(id);
    else toggleNode(id);
  };

  // Một PANEL ba tầng, cùng ngôn ngữ với picker "Nguồn tài liệu": thanh công
  // cụ (tìm + đếm) → vùng danh sách nổi lên → chân panel. Điểm quan trọng nhất
  // không phải cái khung, mà là VÙNG GIỮA: trước đây tick xong thì dropdown
  // đóng lại và trên màn không còn dấu vết gì ngoài một dòng chữ đếm — người
  // dùng không soát lại được mình đã tick những trang nào, cũng không bỏ tick
  // được trang nào mà không phải đi tìm lại nó trong kết quả tìm kiếm.
  return (
    <div className={styles.picker}>
      <div className={styles.pickerHead}>
        <label className={styles.searchField}>
          <Icon name="search" size={14} />
          <input
            id={id}
            aria-describedby={describedBy}
            type="text"
            role="combobox"
            aria-expanded={searching}
            aria-autocomplete="list"
            aria-controls={`${id ?? 'confluence-picker'}-results`}
            autoComplete="off"
            className={styles.searchInput}
            placeholder={placeholder ?? 'Tìm trang Confluence theo tên…'}
            autoFocus={autoFocus}
            disabled={disabled}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape XOÁ ô tìm (thay vì đóng dropdown như trước) — đó là
              // hành động "quay lại danh sách đã tick" duy nhất còn ý nghĩa.
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </label>
        {searching ? (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => setQuery('')}
            disabled={disabled}
          >
            Xong
          </button>
        ) : null}
        <span className={`${styles.pickerCount}${ticked.size > 0 ? ' ' + styles.pickerCountOn : ''}`}>
          {ticked.size > 0 ? `${ticked.size} trang đã chọn` : 'Chưa tick trang nào'}
        </span>
      </div>

      {/* MỘT vùng, hai chế độ: đang gõ → kết quả tìm; ô tìm trống → các trang
          đã tick (+ tài liệu liên quan nếu đã quét). Chip đếm ở đầu panel luôn
          hiện tổng, nên chuyển chế độ không bao giờ làm mất dấu con số. */}
      <div className={styles.pickerBody} id={`${id ?? 'confluence-picker'}-results`} role="listbox" aria-label="Chọn tài liệu Confluence">
        {searching ? (
          loading ? (
            <p className={styles.msg}>Đang tìm…</p>
          ) : error ? (
            <p className={styles.msg}>{error}</p>
          ) : hits && hits.length > 0 ? (
            hits.map((h) => renderHitRow(h))
          ) : hits ? (
            <p className={styles.pickerEmpty}>Không có trang nào khớp “{trimmed}”.</p>
          ) : null
        ) : null}
        {!searching && ticked.size === 0 && !related?.length ? (
          <p className={styles.pickerEmpty}>
            Gõ tên trang vào ô trên để tìm, rồi chọn các tài liệu cần dùng.
          </p>
        ) : null}
        {!searching && ticked.size > 0 ? (
          <>
            <p className={styles.groupHead}>Tài liệu đã chọn</p>
            {[...ticked].map((id) => (
              <div key={id} className={styles.pickedRow}>
                <span className={`${styles.checkbox} ${styles.checkboxOn}`} aria-hidden><Icon name="check" size={11} /></span>
                <span className={styles.pickedTitle} title={titleCache[id] ?? id}>
                  {titleCache[id] ?? id}
                </span>
                {relatedTicked?.has(id) ? <span className={styles.pickedTag}>liên quan</span> : null}
                <button
                  type="button"
                  className={styles.pickedRemove}
                  disabled={disabled}
                  aria-label={`Bỏ tick ${titleCache[id] ?? id}`}
                  onClick={() => untick(id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </>
        ) : null}
        {!searching && related && related.length > 0 ? (
          <>
            <p className={`${styles.groupHead} ${styles.groupHeadRelated}`}>
              Tài liệu liên quan · {related.length}
            </p>
            {related.map((r) => {
              const on = ticked.has(r.pageId);
              return (
                // Trang liên quan không có cây con để mở, nên ô tick là điều
                // khiển DUY NHẤT — cùng luật với hàng lá của kết quả tìm.
                <div key={r.pageId} className={`${styles.hitRow} ${styles.rowLeaf}${on ? ' ' + styles.rowOn : ''}`}>
                  {renderTickBox(r.pageId, r.title, () => toggleRelated(r.pageId))}
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{r.title}</span>
                    <span className={styles.optionMeta}>
                      {r.ancestors.length ? `${r.ancestors.join(' / ')} · ` : ''}nhắc tới trong “{r.linkedFrom}”
                    </span>
                  </span>
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      <div className={styles.pickerFoot}>
        <span className={styles.pickerFootMsg}>
          {relatedError
            ? relatedError
            : related && related.length === 0
              ? 'Không tìm thấy tài liệu liên quan từ các trang đã tick.'
              : 'Quét để tìm tài liệu liên quan từ những trang đã tick.'}
        </span>
        <button
          type="button"
          className={styles.relatedScan}
          disabled={disabled || relatedLoading || ticked.size === 0}
          title={ticked.size === 0 ? 'Tick ít nhất một trang trước rồi quét' : 'Tìm các trang được link từ những trang đã tick'}
          onClick={() => void scanRelated()}
        >
          <Icon name={relatedLoading ? 'spinner' : 'link'} size={13} />
          {relatedLoading ? 'Đang quét…' : 'Quét tài liệu liên quan'}
        </button>
      </div>
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
      {/* Số trang đã tick giờ là chip trong đầu panel picker — hàng này chỉ còn
          hành động, không lặp lại con số ngay bên dưới chỗ vừa nói nó. */}
      {ticked.size > 0 && !importing ? (
        <div className={styles.summaryRow}>
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
