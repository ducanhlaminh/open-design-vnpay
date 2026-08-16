// ── Panel "Token Figma + kiểm tra link" (dùng chung cho Dự án mới / Thông tin dự án)
// Khi App chọn nguồn component là "Link Figma", bước Màn hình → Component đọc
// danh mục component thẳng từ Figma REST API bằng Personal Access Token
// (daemon làm, không agent/MCP, không cần Figma Desktop đang mở). Vì vậy
// người dùng chỉ cần đúng HAI thứ và panel này gom cả hai vào một chỗ:
//   1. Token Figma (lưu một lần cho cả máy — GET không bao giờ trả lại token
//      thật, chỉ `hasToken`), kèm hướng dẫn lấy token ngay tại chỗ.
//   2. Từng link đọc được hay không: tên file + số component, hoặc lý do lỗi
//      (không có quyền, link sai, file chỉ dùng component thư viện khác…).
// Có token + link hợp lệ → tự kiểm tra (debounce) để người dùng thấy dấu ✓
// ngay khi dán link, không phải bấm thêm.

import { useEffect, useRef, useState } from 'react';
import type { FigmaLinkVerification } from '@open-design/contracts';

import { Icon } from '../Icon';
import {
  fetchFigmaConfig,
  fetchFigmaDesktopStatus,
  saveFigmaConfig,
  testFigmaConnection,
  verifyFigmaLinks,
} from '../../state/figma-config';
import type { FigmaDesktopStatusResponse } from '../../state/figma-config';
import styles from './FigmaLinksPanel.module.css';

export const FIGMA_TOKEN_GUIDE_STEPS: readonly string[] = [
  'Mở Figma (web hoặc Desktop) → bấm ảnh đại diện góc trên → Settings.',
  'Chọn thẻ Security → mục Personal access tokens → Generate new token.',
  'Đặt tên (vd “Open Design”), thời hạn tuỳ ý; quyền chỉ cần File content: Read-only.',
  'Bấm Generate, sao chép token (Figma chỉ hiện MỘT lần) rồi dán vào ô bên dưới.',
];

export type FigmaLinksPanelProps = {
  /** Link đã chuẩn hoá (normalizeFigmaLinks). Rỗng khi người dùng chưa dán/đang sai. */
  links: Array<{ url: string; fileKey: string; nodeId?: string }>;
  /** Có lỗi cú pháp link → không kiểm tra, chỉ nhắc sửa. */
  linksError: string | null;
};

type TokenState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'saved'; handle?: string }
  | { kind: 'error'; message: string };

export function FigmaLinksPanel({ links, linksError }: FigmaLinksPanelProps) {
  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [rows, setRows] = useState<FigmaLinkVerification[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<FigmaDesktopStatusResponse | null>(null);
  const [desktopChecking, setDesktopChecking] = useState(false);

  const linksKey = links.map((link) => link.fileKey).join('|');
  // Hàng "Figma Desktop" chỉ có ý nghĩa khi người dùng đang dùng nguồn Link Figma.
  const showDesktopRow = links.length > 0 || Boolean(linksError);

  const runVerify = async (currentLinks: typeof links) => {
    abortRef.current?.abort();
    if (currentLinks.length === 0) { setRows(null); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setVerifying(true);
    setVerifyError(null);
    const result = await verifyFigmaLinks({ links: currentLinks }, controller.signal);
    if (controller.signal.aborted) return;
    setVerifying(false);
    if (!result) { setVerifyError('Không kiểm tra được link (daemon không phản hồi). Thử lại sau.'); return; }
    if (!result.hasToken) { setToken({ kind: 'missing' }); setRows(null); return; }
    setRows(result.links);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchFigmaConfig();
      if (cancelled) return;
      if (!cfg) { setToken({ kind: 'error', message: 'Không đọc được cấu hình Figma từ daemon.' }); return; }
      if (!cfg.hasToken) { setToken({ kind: 'missing' }); return; }
      const probe = await testFigmaConnection();
      if (cancelled) return;
      setToken(probe.ok
        ? { kind: 'saved', ...(probe.handle ? { handle: probe.handle } : probe.email ? { handle: probe.email } : {}) }
        : { kind: 'error', message: probe.detail ?? 'Token Figma đã lưu nhưng không dùng được.' });
    })();
    return () => { cancelled = true; };
  }, []);

  // Có token + link hợp lệ → tự kiểm tra sau khi người dùng ngừng gõ.
  useEffect(() => {
    if (token.kind !== 'saved' || linksError || links.length === 0) {
      abortRef.current?.abort();
      setRows(null);
      setVerifying(false);
      return;
    }
    const timer = window.setTimeout(() => { void runVerify(links); }, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.kind, linksKey, linksError]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Trạng thái Figma Desktop chỉ đáng hỏi khi người dùng đang dùng nguồn Link
  // Figma (có link hoặc đang sửa link lỗi); hỏi một lần lúc mount.
  useEffect(() => {
    if (!showDesktopRow) return;
    let cancelled = false;
    setDesktopChecking(true);
    void (async () => {
      const status = await fetchFigmaDesktopStatus();
      if (cancelled) return;
      setDesktopChecking(false);
      setDesktopStatus(status);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheckDesktopStatus = async () => {
    setDesktopChecking(true);
    const status = await fetchFigmaDesktopStatus();
    setDesktopChecking(false);
    setDesktopStatus(status);
  };

  const saveToken = async () => {
    const value = draft.trim();
    if (!value || saving) return;
    setSaving(true);
    // Kiểm tra TRƯỚC khi lưu để token sai không đè lên token đang chạy tốt.
    const probe = await testFigmaConnection({ token: value });
    if (!probe.ok) {
      setSaving(false);
      setToken({ kind: token.kind === 'saved' ? 'saved' : 'missing', ...(token.kind === 'saved' && token.handle ? { handle: token.handle } : {}) } as TokenState);
      setVerifyError(probe.detail ?? 'Token không hợp lệ.');
      return;
    }
    const saved = await saveFigmaConfig({ token: value });
    setSaving(false);
    if (!saved?.hasToken) { setVerifyError('Không lưu được token vào daemon.'); return; }
    setDraft('');
    setEditing(false);
    setVerifyError(null);
    setToken({ kind: 'saved', ...(probe.handle ? { handle: probe.handle } : probe.email ? { handle: probe.email } : {}) });
  };

  const showTokenForm = token.kind === 'missing' || token.kind === 'error' || editing;

  return (
    <section className={styles.panel} aria-label="Token Figma và kiểm tra link">
      <div className={styles.row}>
        <div className={styles.rowText}>
          <strong>Token Figma</strong>
          {token.kind === 'loading' ? <span>Đang kiểm tra…</span> : null}
          {token.kind === 'saved' ? (
            <span data-ok="true">Đã lưu{token.handle ? ` · tài khoản ${token.handle}` : ''}. Dùng chung cho mọi dự án trên máy này.</span>
          ) : null}
          {token.kind === 'missing' ? <span data-ok="false">Chưa có token. Dán Personal Access Token của Figma để ứng dụng đọc được file.</span> : null}
          {token.kind === 'error' ? <span data-ok="false">{token.message}</span> : null}
        </div>
        {token.kind === 'saved' && !editing ? (
          <button type="button" className={styles.linkButton} onClick={() => setEditing(true)}>Đổi token</button>
        ) : null}
      </div>

      {showTokenForm ? (
        <div className={styles.tokenForm}>
          <input
            type="password"
            className={styles.tokenInput}
            aria-label="Personal Access Token của Figma"
            placeholder="figd_…"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveToken(); } }}
            disabled={saving}
          />
          <button type="button" className={styles.primaryButton} onClick={() => void saveToken()} disabled={saving || !draft.trim()} data-testid="figma-token-save">
            <Icon name={saving ? 'spinner' : 'check'} size={14} />
            <span>{saving ? 'Đang kiểm tra…' : 'Lưu token'}</span>
          </button>
          {editing && token.kind === 'saved' ? (
            <button type="button" className={styles.linkButton} onClick={() => { setEditing(false); setDraft(''); }} disabled={saving}>Huỷ</button>
          ) : null}
          <button type="button" className={styles.linkButton} onClick={() => setGuideOpen((open) => !open)} aria-expanded={guideOpen}>
            {guideOpen ? 'Ẩn hướng dẫn' : 'Cách lấy token'}
          </button>
          {guideOpen ? (
            <ol className={styles.guide}>
              {FIGMA_TOKEN_GUIDE_STEPS.map((step) => <li key={step}>{step}</li>)}
            </ol>
          ) : null}
        </div>
      ) : null}

      <div className={styles.row}>
        <div className={styles.rowText}>
          <strong>Kiểm tra link</strong>
          {linksError ? <span>Sửa link ở trên trước đã.</span>
            : links.length === 0 ? <span>Dán link để kiểm tra.</span>
              : token.kind !== 'saved' ? <span>Cần token Figma để kiểm tra link.</span>
                : verifying ? <span>Đang đọc {links.length} file từ Figma…</span>
                  : rows ? <span>{rows.every((row) => row.ok) ? 'Tất cả link đều đọc được.' : 'Có link chưa đọc được — xem bên dưới.'}</span>
                    : <span>Sẽ tự kiểm tra sau khi bạn dán link.</span>}
        </div>
        {token.kind === 'saved' && links.length > 0 && !linksError ? (
          <button type="button" className={styles.linkButton} onClick={() => void runVerify(links)} disabled={verifying}>
            {verifying ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
          </button>
        ) : null}
      </div>

      {rows && rows.length > 0 ? (
        <ul className={styles.links}>
          {rows.map((row) => (
            <li key={row.fileKey} data-ok={row.ok}>
              <Icon name={row.ok ? 'check' : 'info'} size={13} />
              <span className={styles.linkText}>
                <strong>{row.name || row.fileKey}</strong>
                {row.ok
                  ? <small>{row.componentCount} component</small>
                  : <small>{row.detail ?? 'Không đọc được.'}</small>}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {showDesktopRow && desktopStatus ? (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>Figma Desktop</strong>
            {desktopStatus.available ? (
              <span data-ok="true">
                Đang chạy · MCP bật{desktopStatus.activeFileTitle ? ` · đang mở “${desktopStatus.activeFileTitle}”` : ''}
              </span>
            ) : (
              <span data-ok="false">{desktopStatus.detail ?? 'Chưa kết nối được.'}</span>
            )}
            {desktopStatus.available ? (
              <small className={styles.hint}>Khi chạy bước Màn hình → Component, agent sẽ tự mở từng component trong file bạn khai để đối chiếu.</small>
            ) : (
              <small className={styles.hint}>Không bắt buộc: thiếu Figma Desktop thì bước này chỉ đối chiếu theo catalog.</small>
            )}
            {desktopStatus.available && !desktopStatus.canSwitch ? (
              <small className={styles.hint}>Máy này không tự chuyển file được — hãy mở đúng file trong Figma trước khi chạy.</small>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.linkButton}
            data-testid="figma-desktop-recheck"
            onClick={() => void recheckDesktopStatus()}
            disabled={desktopChecking}
          >
            Kiểm tra lại
          </button>
        </div>
      ) : null}

      {verifyError ? <p className={styles.error} role="alert">{verifyError}</p> : null}
    </section>
  );
}
