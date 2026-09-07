// "Câu hỏi / Trả lời / Dẫn chứng" — mục ở cuối Quick result docs-review
// (wp-docs-review-tracing) cho người review thấy agent đã HỎI gì, TRẢ LỜI ra
// sao, dựa trên DẪN CHỨNG nào. Câu hỏi + dẫn chứng do daemon tự ghi (Gói A,
// `/api/docs/search`); phần trả lời do agent tự khai (Gói C) — vẫn nên đối
// chiếu, xem chú thích cuối panel.
//
// Không hiện khung rỗng: gọi component này chỉ khi `stage` đã có (spec).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocsTracingItem, DocsTracingStagePayload, ProjectFile } from '@open-design/contracts';
import type { TrackingProjectKind } from '@open-design/contracts/analytics';

import { Icon } from '../Icon';
import { FileViewer } from '../FileViewer';
import { PlModal } from './PlModal';
import styles from './PipelineTracingPanel.module.css';

/** Fetch riêng (không dùng chung `usePipelineResultFiles`): panel cần DANH
 *  SÁCH ĐẦY ĐỦ mọi file của dự án (kể cả `docs-app/`/`docs-feature/`, vốn bị
 *  lọc khỏi rail Quick result vì không phải output của stage) để mở đúng file
 *  một dẫn chứng trỏ tới. */
function useAllProjectFiles(projectId: string): ProjectFile[] | null {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
        if (!res.ok) throw new Error(`files: ${res.status}`);
        const data = (await res.json()) as { files?: ProjectFile[] };
        const all = (data.files ?? []).map((f) => ({ ...f, name: (f.name ?? f.path ?? '').replace(/^\/+/, '') }));
        if (!cancelled) setFiles(all);
      } catch {
        if (!cancelled) setFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return files;
}

/** `"docs-app/<path>.md#<heading>"` (citation agent khai) → phần path
 *  (bỏ neo `#…`). */
function stripCitationAnchor(citation: string): string {
  const idx = citation.indexOf('#');
  return idx >= 0 ? citation.slice(0, idx) : citation;
}

/** Một mục dẫn chứng có thể mở trong FileViewer: quy về CÙNG một hình dạng dù
 *  nguồn là `results` (daemon tự ghi, có score) hay `citations` (agent khai,
 *  không score). */
interface EvidenceRef {
  key: string;
  label: string;
  score?: number;
  /** Tiêu đề mục cần cuộn tới trong file (đoạn cuối breadcrumb, hoặc phần sau
   *  `#` của citation). Rỗng = không định vị được, chỉ mở file. */
  heading: string;
  /** Đường dẫn ĐẦY ĐỦ tính từ gốc workflow (đã có tiền tố `docs-app/` /
   *  `docs-feature/`) — dùng để khớp với `ProjectFile.name`. */
  scopedPath: string;
}

/** Đoạn cuối của breadcrumb `A › B › C` = tiêu đề mục thật trong file. */
function lastCrumbSegment(crumb: string): string {
  const parts = crumb.split(/\s*[›>|/]\s*/u).filter(Boolean);
  return (parts[parts.length - 1] ?? '').trim();
}

function evidenceFromResults(items: DocsTracingItem['results']): EvidenceRef[] {
  return items.map((r, i) => ({
    key: `r${i}:${r.path}:${r.line}`,
    label: r.crumb || r.path,
    score: r.score,
    heading: lastCrumbSegment(r.crumb || ''),
    scopedPath: `${r.scope === 'app' ? 'docs-app' : 'docs-feature'}/${r.path}`,
  }));
}

function evidenceFromCitations(citations: string[]): EvidenceRef[] {
  return citations.map((c, i) => {
    const hash = c.indexOf('#');
    return {
      key: `c${i}:${c}`,
      label: c,
      heading: hash >= 0 ? c.slice(hash + 1).trim() : '',
      scopedPath: stripCitationAnchor(c),
    };
  });
}

/** Chuẩn hoá để so tiêu đề: bỏ dấu, bỏ ký tự không chữ-số, lowercase — tiêu
 *  đề trong `_sections.md`/citation có thể lệch dấu câu, số thứ tự, khoảng
 *  trắng so với văn bản render. */
const normHeading = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');

/** Cuộn tới + tô sáng đúng mục trong nội dung file đã render. FileViewer dựng
 *  markdown bất đồng bộ (tải nội dung rồi mới render) nên phải thử lại có
 *  nhịp — cùng cách DsShowcasePreview định vị component trong trang showcase.
 *  Không tìm thấy sau ~5s → trả false để UI nói thật thay vì im lặng. */
function useScrollToHeading(
  container: HTMLElement | null,
  heading: string,
  ready: boolean,
): 'seeking' | 'found' | 'missing' {
  const [status, setStatus] = useState<'seeking' | 'found' | 'missing'>('seeking');
  useEffect(() => {
    if (!container || !ready) return undefined;
    if (!heading) {
      setStatus('missing');
      return undefined;
    }
    setStatus('seeking');
    const want = normHeading(heading);
    let cancelled = false;
    let attempt = 0;
    let highlighted: HTMLElement | null = null;
    const tick = () => {
      if (cancelled) return;
      attempt += 1;
      const headings = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, strong');
      let hit: HTMLElement | null = null;
      for (const el of headings) {
        if (normHeading(el.textContent ?? '') === want) { hit = el; break; }
      }
      if (!hit && want.length > 6) {
        for (const el of headings) {
          const text = normHeading(el.textContent ?? '');
          if (text && (text.includes(want) || want.includes(text))) { hit = el; break; }
        }
      }
      if (hit) {
        hit.style.scrollMarginTop = '8px';
        hit.style.background = 'var(--accent-tint, #e6f0f8)';
        hit.style.boxShadow = '0 0 0 4px var(--accent-tint, #e6f0f8)';
        hit.style.borderRadius = '3px';
        highlighted = hit;
        hit.scrollIntoView({ block: 'start' });
        setStatus('found');
        return;
      }
      if (attempt < 12) window.setTimeout(tick, attempt < 4 ? 250 : 600);
      else setStatus('missing');
    };
    tick();
    return () => {
      cancelled = true;
      if (highlighted) {
        highlighted.style.background = '';
        highlighted.style.boxShadow = '';
      }
    };
  }, [container, heading, ready]);
  return status;
}

/** Tìm file thật khớp một dẫn chứng: so `scopedPath` với `f.name` sau khi bỏ
 *  tiền tố thư mục workflow (`<wfDir>/…`) — dẫn chứng không biết wfDir, file
 *  thật thì có. Match ĐUÔI để chịu được lệch tiền tố nhỏ (vd multi-target). */
function findEvidenceFile(files: ProjectFile[] | null, scopedPath: string): ProjectFile | null {
  if (!files) return null;
  const needle = scopedPath.replace(/^\/+/, '');
  return files.find((f) => f.name === needle || f.name.endsWith(`/${needle}`)) ?? null;
}

function EvidenceRow({ ev, onOpen }: { ev: EvidenceRef; onOpen: (ev: EvidenceRef) => void }) {
  return (
    <button type="button" className={styles.evidenceRow} onClick={() => onOpen(ev)} title={ev.scopedPath}>
      <Icon name="file" size={13} />
      <span className={styles.evidencePath}>{ev.scopedPath}</span>
      {ev.heading ? <span className={styles.evidenceCrumb}>› {ev.heading}</span> : null}
      {typeof ev.score === 'number' ? <span className={styles.evidenceScore}>{ev.score.toFixed(3)}</span> : null}
    </button>
  );
}

/** Modal xem dẫn chứng: mở TOÀN tài liệu, tự cuộn tới mục và tô sáng. Đọc
 *  trong khung nhỏ nhét dưới danh sách câu hỏi thì không ra gì (tài liệu
 *  nghiệp vụ toàn bảng rộng) — modal lớn mới đủ chỗ. */
function EvidenceModal({
  ev,
  file,
  projectId,
  projectKind,
  onClose,
}: {
  ev: EvidenceRef;
  file: ProjectFile | null;
  projectId: string;
  projectKind: TrackingProjectKind;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const seek = useScrollToHeading(host, ev.heading, !!file);
  // Portal ra <body> + tầng z RIÊNG: mục này nằm sâu trong `.pl-result-page`
  // và backdrop mặc định của PlModal ở z-index 1000, THẤP HƠN header/pill của
  // app (1200) — modal mở ra bị thanh công cụ đè lên đúng chỗ nút đóng.
  return createPortal(
    <div className={styles.modalLayer}>
      <PlModal title={ev.heading || ev.scopedPath} onClose={onClose} icon="file" size="xl" bodyClassName="pl-modal__body--flush">
        {/* `pl-modal__body--flush` là flex HÀNG (khuôn 2 pane của Quick result)
            — mục này xếp dọc nên cần lớp bọc riêng. */}
        <div className={styles.modalBody}>
          <div className={styles.modalPath}>
            {ev.scopedPath}
            {typeof ev.score === 'number' ? <span className={styles.evidenceScore}>{ev.score.toFixed(3)}</span> : null}
          </div>
          {file && seek === 'missing' ? (
            <p className={styles.evidenceMissing}>
              Không định vị được mục{ev.heading ? ` "${ev.heading}"` : ''} trong tài liệu — đang xem từ đầu.
            </p>
          ) : null}
          <div className={styles.modalViewer} ref={setHost}>
            {file ? (
              <FileViewer key={file.name} projectId={projectId} projectKind={projectKind} file={file} />
            ) : (
              <p className={styles.evidenceMissing}>Không tìm thấy file này trong dự án hiện tại.</p>
            )}
          </div>
        </div>
      </PlModal>
    </div>,
    document.body,
  );
}

function TracingItemRow({ item, onOpen }: { item: DocsTracingItem; onOpen: (ev: EvidenceRef) => void }) {
  const [expanded, setExpanded] = useState(false);
  const evidence = evidenceFromResults(item.results);
  const citationEvidence = evidenceFromCitations(item.citations).filter(
    (c) => !evidence.some((e) => e.scopedPath === c.scopedPath),
  );
  const evidenceCount = evidence.length + citationEvidence.length;
  return (
    <div className={styles.item}>
      <button
        type="button"
        className={styles.itemHeader}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className={styles.question}>{item.question}</span>
        {item.orphan ? <span className={styles.orphanBadge}>lệch câu hỏi</span> : null}
        {/* Trạng thái đọc được khi ĐANG ĐÓNG — người review lướt danh sách
            biết ngay câu nào agent chưa kết luận, không phải mở từng cái. */}
        <span className={item.answer ? styles.metaAnswered : styles.metaMissing}>
          {item.answer ? 'đã trả lời' : 'chưa trả lời'}
        </span>
        <span className={styles.metaCount}>{evidenceCount} dẫn chứng</span>
      </button>
      <div className={`accordion-collapsible${expanded ? ' open' : ''}`}>
        <div className={`accordion-collapsible-inner ${styles.itemBody}`}>
          <div className={styles.answerBlock}>
            <span className={styles.blockLabel}>Trả lời</span>
            {item.answer ? (
              <p className={styles.answerText}>{item.answer}</p>
            ) : (
              <p className={styles.answerMuted}>agent chưa ghi trả lời</p>
            )}
            {item.usedFor ? <p className={styles.usedFor}>Dùng cho: {item.usedFor}</p> : null}
          </div>
          {evidence.length > 0 || citationEvidence.length > 0 ? (
            <div className={styles.evidenceBlock}>
              <span className={styles.blockLabel}>Dẫn chứng</span>
              {evidence.map((ev) => (
                <EvidenceRow key={ev.key} ev={ev} onOpen={onOpen} />
              ))}
              {citationEvidence.map((ev) => (
                <EvidenceRow key={ev.key} ev={ev} onOpen={onOpen} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PipelineTracingPanel({
  stage,
  projectId,
  projectKind,
}: {
  stage: DocsTracingStagePayload;
  projectId: string;
  projectKind: TrackingProjectKind;
}) {
  const files = useAllProjectFiles(projectId);
  // Mặc định ĐÓNG: trang Quick result cao cố định (`.pl-result-page`,
  // 100dvh − 128px, overflow hidden) nên một mục tự do cao ~700px sẽ bóp
  // FileViewer còn một dải mỏng — chính là lỗi đã thấy. Đóng = 1 dòng ~40px;
  // mở = danh sách tự cuộn trong khung có trần chiều cao (xem .list trong CSS).
  const [open, setOpen] = useState(false);
  // Dẫn chứng mở trong MODAL (không nhét khung nhỏ dưới danh sách).
  const [preview, setPreview] = useState<EvidenceRef | null>(null);
  if (stage.items.length === 0) return null;
  const answered = stage.items.filter((i) => i.answer).length;
  return (
    <section className={styles.panel} aria-label="Câu hỏi / Trả lời / Dẫn chứng">
      <button
        type="button"
        className={styles.panelHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        <Icon name="search" size={13} />
        <span className={styles.panelTitle}>Câu hỏi / Trả lời / Dẫn chứng</span>
        <span className={styles.panelCount}>
          {stage.items.length} câu · {answered}/{stage.items.length} đã trả lời
        </span>
        {stage.truncated ? (
          <span className={styles.truncated} title="Đã đạt giới hạn 200 truy vấn — các truy vấn sau không được ghi thêm.">
            đã cắt ở 200 truy vấn
          </span>
        ) : null}
      </button>
      {open ? (
        <>
          <div className={styles.list}>
            {stage.items.map((item, i) => (
              <TracingItemRow key={`${item.question}:${i}`} item={item} onOpen={setPreview} />
            ))}
          </div>
          <p className={styles.footnote}>
            Câu hỏi và dẫn chứng do hệ thống ghi tự động. Phần trả lời do agent tự khai — vẫn nên đối chiếu.
          </p>
        </>
      ) : null}
      {preview ? (
        <EvidenceModal
          ev={preview}
          file={findEvidenceFile(files, preview.scopedPath)}
          projectId={projectId}
          projectKind={projectKind}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
