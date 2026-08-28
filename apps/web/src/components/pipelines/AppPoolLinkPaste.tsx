'use client';

// WP app-pool-paste-link — dán link / page id Confluence vào ô tìm "Tài liệu
// dự án" (RunInputModal → nguồn app-pool). Ô tìm vốn chỉ lọc CÂY KHO CỤC BỘ
// theo tên; dán link vào thì cây báo "Không có trang nào khớp <link>". Ở đây:
//   • ref → GET /api/pipelines/confluence/resolve?ref= (hook sẵn có) → so
//     `hit.id` với `pages[].pageId`.
//   • Có trong kho → host lọc cây theo `pageIdFilter` + tự tick path.
//   • Chưa có trong kho → dòng «title» chưa có… + nút "Import + tick" (import
//     thẳng qua `importConfluenceInBatches`, KHÔNG mở panel ConfluenceTreeImport).
// Giữ PipelineModals mỏng: mọi state/logic của chế độ link nằm ở đây.

import { useMemo, useState } from 'react';
import type { AppPoolPage, ConfluencePageHit } from '@open-design/contracts';

import {
  importConfluenceInBatches,
  looksLikeConfluenceRef,
  shortConfluenceRef,
  splitConfluenceRefs,
  useConfluenceRefResolve,
} from './ConfluenceTreeImport';
import styles from './PipelineSourceModal.module.css';

export interface AppPoolRefMatch {
  /** Ô tìm đang chứa link/page id (không phải tên trang) → chế độ link. */
  active: boolean;
  refs: string[];
  loading: boolean;
  /** Lỗi tra theo ref — 400 đã kèm `CONFLUENCE_REF_FORMS_HINT` từ hook. */
  errors: Record<string, string>;
  /** Hit đã có trong kho cục bộ (khớp `pageId`). */
  inPool: { hit: ConfluencePageHit; page: AppPoolPage }[];
  /** Hit chưa có trong kho → cần import. */
  missing: ConfluencePageHit[];
  /** `active` → tập pageId cần hiện trong cây (rỗng khi chưa tra xong / chưa
   *  có trang nào trong kho); không active → undefined (cây lọc theo tên). */
  pageIdFilter: Set<string> | undefined;
}

export function useAppPoolRefMatch({
  query,
  pages,
}: {
  query: string;
  pages: readonly AppPoolPage[];
}): AppPoolRefMatch {
  const trimmed = query.trim();
  const active = trimmed.length > 0 && looksLikeConfluenceRef(trimmed);
  // Gõ chữ thường → hook nhận [] → không gọi resolve.
  const refs = useMemo(() => (active ? splitConfluenceRefs(trimmed) : []), [active, trimmed]);
  const resolved = useConfluenceRefResolve(refs);
  return useMemo(() => {
    const byId = new Map<string, AppPoolPage>();
    for (const p of pages) if (!byId.has(p.pageId)) byId.set(p.pageId, p);
    const inPool: AppPoolRefMatch['inPool'] = [];
    const missing: ConfluencePageHit[] = [];
    for (const hit of resolved.hits) {
      const page = byId.get(hit.id);
      if (page) inPool.push({ hit, page });
      else missing.push(hit);
    }
    return {
      active,
      refs,
      loading: resolved.loading,
      errors: resolved.errors,
      inPool,
      missing,
      pageIdFilter: active ? new Set(inPool.map((x) => x.page.pageId)) : undefined,
    };
  }, [active, refs, pages, resolved]);
}

export interface AppPoolLinkRowsProps {
  appId: string;
  match: AppPoolRefMatch;
  disabled?: boolean;
  /** Import xong (đã tick) — host refresh pool nền. */
  onImported: (pages: AppPoolPage[]) => void;
  /** Tick thêm các path (host merge vào Set đang tick). */
  onTick: (paths: string[]) => void;
}

/** Các dòng dưới cây ở chế độ link: đang tra / lỗi ref / trang có trong kho
 *  (meta "Từ link đã dán") / trang chưa có + nút "Import + tick". */
export function AppPoolLinkRows({ appId, match, disabled, onImported, onTick }: AppPoolLinkRowsProps) {
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [importErrors, setImportErrors] = useState<Record<string, string>>({});

  const runImport = async (hit: ConfluencePageHit) => {
    if (importing.has(hit.id)) return;
    setImporting((prev) => new Set(prev).add(hit.id));
    setImportErrors((prev) => {
      if (!(hit.id in prev)) return prev;
      const next = { ...prev };
      delete next[hit.id];
      return next;
    });
    try {
      const result = await importConfluenceInBatches(appId, [hit.url ?? hit.id]);
      // `result.pages` là TOÀN BỘ manifest hiện tại của App (xem docblock
      // ConfluenceImportBatchError) — chỉ tick đúng trang vừa import, không
      // tick cả kho.
      const own = result.pages.filter((p) => p.pageId === hit.id);
      onTick(own.map((p) => p.path));
      onImported(result.pages);
    } catch (cause) {
      setImportErrors((prev) => ({
        ...prev,
        [hit.id]: cause instanceof Error ? cause.message : 'Nhập tài liệu thất bại.',
      }));
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        next.delete(hit.id);
        return next;
      });
    }
  };

  return (
    <div className={styles.poolLinkRows}>
      {match.inPool.map(({ hit, page }) => (
        <p key={`in:${page.pageId}`} className={styles.poolLinkMeta} title={page.path}>
          «{hit.title || page.title}» · Từ link đã dán
        </p>
      ))}
      {match.missing.map((hit) => {
        const busy = importing.has(hit.id);
        const err = importErrors[hit.id];
        return (
          <div key={`missing:${hit.id}`} className={styles.poolLinkMissing}>
            <span className={styles.poolLinkMeta} title={hit.url ?? hit.id}>
              «{hit.title || hit.id}» chưa có trong tài liệu dự án
            </span>
            <button
              type="button"
              className={styles.linkBtn}
              disabled={disabled || busy}
              onClick={() => void runImport(hit)}
            >
              {busy ? 'Đang import…' : 'Import + tick'}
            </button>
            {err ? <span className={styles.poolLinkError}>{err}</span> : null}
          </div>
        );
      })}
      {Object.entries(match.errors).map(([ref, message]) => (
        <p key={`err:${ref}`} className={styles.poolLinkError} title={ref}>
          Không tra được «{shortConfluenceRef(ref)}»: {message}
        </p>
      ))}
      {match.loading ? <p className={styles.poolLinkMeta}>Đang tra trang…</p> : null}
    </div>
  );
}
