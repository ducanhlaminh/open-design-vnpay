// ── Section "Concept tham khảo" (modal cấu hình pipeline, focus 'labRefs') ───
// Chỉ hiện khi workflow đang mở có bước `lab-compose` (ds-lab, xem
// `hasLabRefsStage` trong PipelinesView.tsx). Người dùng dán 1..N link page
// Figma làm mẫu concept, bấm "Quét & lưu" → daemon (WP song song
// wp-lab-refs-daemon.yaml) chụp thumbnail từng concept tìm được trong các
// page đó. Nút "Quét & lưu" ĐỘC LẬP với nút "Lưu" chung của modal: refs không
// thuộc `RunAllConfig`, ghi qua PUT riêng (`putLabRefs`), không đi qua
// `configPatchFor`.
//
// Tách thành component con export riêng (thay vì viết thẳng trong
// PipelineModals.tsx) để test được trực tiếp trong jsdom mà không phải mount
// cả `RunAllModal`/`PipelinesView` — hai component đó nặng (fetch dự án,
// pipeline, design system…), xem stage-run-uses-config.test.tsx cho tiền lệ
// tách hàm/component để giữ test rẻ.

import { useEffect, useState } from 'react';

import { Icon } from '../Icon';
import { navigate } from '../../router';
import { projectFileUrl } from '../../providers/registry';
import {
  getLabRefs,
  putLabRefs,
  type LabRefsError,
  type LabRefsFile,
  type LabRefsPage,
  type LabRefsPageKind,
} from '../../providers/lab-refs';
import styles from './LabRefsSection.module.css';

export interface LabRefsSectionProps {
  projectId: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; refs: LabRefsFile }
  | { kind: 'error'; message: string };

/** Contract WP-lab-refs-daemon: PUT nhận tối đa 10 link — cắt bớt phía client
 *  thay vì để daemon từ chối cả lượt quét vì một dòng thừa. */
const MAX_LINKS = 10;

/** WP-lab-refs-v2 (bổ sung): link FRAME từng màn (Copy link to selection) là
 *  luồng CHÍNH — mỗi link = 1 màn concept. Link page/section vẫn hợp lệ
 *  (daemon vẫn nhận, quét toàn trang) nhưng chỉ nêu như lựa chọn phụ trong
 *  hint. */
const LAB_REFS_HINT = 'Dán link frame của màn (Copy link to selection) — mỗi dòng một màn; link page/section cũng được. Tối đa 10.';

function parseLinks(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LINKS);
}

/** Nhãn tiếng Việt cho badge loại node — 'page' xử lý riêng (không qua map
 *  này) vì nó không kèm kích thước. Không có tiền lệ tiếng Việt chính thức
 *  cho 'component_set' trong sản phẩm nên giữ nguyên thuật ngữ Figma. */
const SELECTION_KIND_LABELS: Partial<Record<LabRefsPageKind, string>> = {
  frame: 'Frame',
  section: 'Section',
  component: 'Component',
  component_set: 'Component Set',
  instance: 'Instance',
};

/** "390x1359" (daemon) → "390×1359" (hiển thị). Chuỗi không đúng khuôn thì
 *  hiện nguyên văn thay vì nuốt mất — tốt hơn cho debug là ẩn đi. */
function formatPageSize(size: string): string {
  const match = /^(\d+)x(\d+)$/i.exec(size);
  return match ? `${match[1]}×${match[2]}` : size;
}

/** refs.json cũ (trước WP-lab-refs-v2) không có `kind` → không badge, đúng
 *  hành vi cũ. */
function pageBadgeText(page: LabRefsPage): string | null {
  if (!page.kind) return null;
  if (page.kind === 'page') return 'Page';
  const label = SELECTION_KIND_LABELS[page.kind] ?? page.kind;
  return page.size ? `${label} · ${formatPageSize(page.size)}` : label;
}

/** Union hai nguồn warnings — refs.warnings (đã lưu, hiện ngay sau GET) và
 *  warnings của lượt PUT vừa chạy — dedupe theo nội dung chuỗi, giữ thứ tự
 *  xuất hiện đầu tiên. */
function mergeWarnings(persisted: string[], fromScan: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const w of [...persisted, ...fromScan]) {
    if (seen.has(w)) continue;
    seen.add(w);
    merged.push(w);
  }
  return merged;
}

export function LabRefsSection({ projectId }: LabRefsSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [linksText, setLinksText] = useState('');
  // Prefill CHỈ một lần khi GET tải xong — không ghi đè lúc người dùng đang
  // gõ dở, và không ghi đè sau một lượt "Quét & lưu" (textarea lúc đó đã
  // đúng nội dung vừa gửi, không có gì để đồng bộ lại).
  const [prefilled, setPrefilled] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<LabRefsError | null>(null);
  // Warnings của LƯỢT PUT vừa chạy trong phiên này — khác với `refs.warnings`
  // (đã lưu từ trước, đọc thẳng từ `state`). Union hai nguồn ở chỗ render,
  // xem `mergeWarnings`.
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setPrefilled(false);
    setScanWarnings([]);
    void (async () => {
      const result = await getLabRefs(projectId);
      if (cancelled) return;
      if (result.ok) setState({ kind: 'loaded', refs: result.value });
      else setState({ kind: 'error', message: result.error.message });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (state.kind === 'loaded' && !prefilled) {
      setLinksText(state.refs.pages.map((p) => p.url).join('\n'));
      setPrefilled(true);
    }
  }, [state, prefilled]);

  const links = parseLinks(linksText);
  const refs = state.kind === 'loaded' ? state.refs : null;

  const scan = async () => {
    if (links.length === 0 || scanning) return;
    setScanning(true);
    setScanError(null);
    const result = await putLabRefs(projectId, links);
    setScanning(false);
    if (result.ok) {
      setState({ kind: 'loaded', refs: result.value.refs });
      setScanWarnings(result.value.warnings);
    } else {
      setScanError(result.error);
    }
  };

  const openFigmaSettings = () => navigate({ kind: 'home', view: 'integrations', integrationsTab: 'mcp' });

  const displayedWarnings = mergeWarnings(refs?.warnings ?? [], scanWarnings);
  const missingImageCount = refs ? refs.concepts.filter((c) => c.png === '').length : 0;

  return (
    <div className={styles.section} aria-label="Concept tham khảo">
      <label className="pl-modal-field">
        <span className="pl-modal-field__label">Concept tham khảo</span>
        <textarea
          className="pl-input"
          rows={4}
          placeholder={LAB_REFS_HINT}
          value={linksText}
          onChange={(e) => setLinksText(e.target.value)}
          disabled={state.kind === 'loading'}
        />
        <span className="pl-modal-field__hint">{LAB_REFS_HINT}</span>
      </label>

      <button
        type="button"
        className={`pl-btn pl-btn--primary ${styles.scanBtn}`}
        onClick={() => void scan()}
        disabled={scanning || links.length === 0}
      >
        <Icon name={scanning ? 'spinner' : 'search'} size={14} />
        <span>{scanning ? 'Đang quét…' : 'Quét & lưu'}</span>
      </button>

      {scanError ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>
            {scanError.detail ?? scanError.message}
            {scanError.code === 'FIGMA_TOKEN_REQUIRED' ? (
              <>
                {' '}
                <button type="button" className={styles.linkButton} onClick={openFigmaSettings}>
                  Mở Cài đặt → Figma
                </button>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <p className={styles.loadError} role="alert">
          {state.message}
        </p>
      ) : null}

      {refs && refs.pages.length > 0 ? (
        <ul className={styles.pages}>
          {refs.pages.map((page) => {
            const badge = pageBadgeText(page);
            return (
              <li key={`${page.fileKey}:${page.nodeId}`} data-ok={page.ok}>
                <Icon name={page.ok ? 'check' : 'info'} size={13} />
                <span className={styles.pageText}>
                  <span className={styles.pageTitleRow}>
                    <strong>{page.name || page.url}</strong>
                    {badge ? <span className={styles.pageBadge}>{badge}</span> : null}
                  </span>
                  {!page.ok ? <small>{page.detail ?? 'Không đọc được.'}</small> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {refs && refs.concepts.length > 0 ? (
        <>
          {missingImageCount > 0 ? (
            <p className={styles.missingImages} role="alert">
              {missingImageCount} concept chưa có ảnh (lỗi tải từ Figma) — bấm Quét & lưu để thử lại.
            </p>
          ) : null}
          <div className={styles.grid} role="list" aria-label="Concept đã quét">
            {refs.concepts.map((concept) => (
              <div key={concept.id} className={styles.cell} role="listitem">
                {concept.png ? (
                  <img className={styles.cellImg} src={projectFileUrl(projectId, concept.png)} alt={concept.name} />
                ) : (
                  <span className={styles.cellError}>Ảnh lỗi</span>
                )}
                <span className={styles.cellName}>{concept.name}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {displayedWarnings.length > 0 ? (
        <ul className={styles.warnings}>
          {displayedWarnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      <span className="pl-modal-field__hint">
        Concept gắn vào bước Bản đồ màn — chạy lại bước đó để map concept ↔ màn sau khi quét.
      </span>
    </div>
  );
}
