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
import { getLabRefs, putLabRefs, type LabRefsError, type LabRefsFile } from '../../providers/lab-refs';
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

function parseLinks(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LINKS);
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
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setPrefilled(false);
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
      setWarnings(result.value.warnings);
    } else {
      setScanError(result.error);
    }
  };

  const openFigmaSettings = () => navigate({ kind: 'home', view: 'integrations', integrationsTab: 'mcp' });

  return (
    <div className={styles.section} aria-label="Concept tham khảo">
      <label className="pl-modal-field">
        <span className="pl-modal-field__label">Concept tham khảo</span>
        <textarea
          className="pl-input"
          rows={4}
          placeholder={'Dán link page Figma (Copy link to page) — mỗi dòng một link, tối đa 10.'}
          value={linksText}
          onChange={(e) => setLinksText(e.target.value)}
          disabled={state.kind === 'loading'}
        />
        <span className="pl-modal-field__hint">
          Dán link page Figma (Copy link to page) — mỗi dòng một link, tối đa 10.
        </span>
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
          {refs.pages.map((page) => (
            <li key={`${page.fileKey}:${page.nodeId}`} data-ok={page.ok}>
              <Icon name={page.ok ? 'check' : 'info'} size={13} />
              <span className={styles.pageText}>
                <strong>{page.name || page.url}</strong>
                {!page.ok ? <small>{page.detail ?? 'Không đọc được.'}</small> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {refs && refs.concepts.length > 0 ? (
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
      ) : null}

      {warnings.length > 0 ? (
        <ul className={styles.warnings}>
          {warnings.map((w, i) => (
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
