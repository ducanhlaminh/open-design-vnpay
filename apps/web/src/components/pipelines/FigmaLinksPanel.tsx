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
  /** Parent forms use this state as a hard gate: a syntactically-valid link
   *  is not enough until the daemon has read every file successfully. */
  onVerificationChange?: (state: FigmaLinksVerificationState) => void;
};

export type FigmaLinksVerificationState = {
  status: 'idle' | 'pending' | 'verified' | 'failed';
  /** Identifies the exact normalized links that were checked. */
  linksKey: string;
  message?: string;
};

export function figmaLinksVerificationKey(links: FigmaLinksPanelProps['links']): string {
  return links.map((link) => `${link.fileKey}:${link.nodeId ?? ''}`).join('|');
}

function figmaVerificationFailure(
  requested: FigmaLinksPanelProps['links'],
  result: { hasToken: boolean; links: FigmaLinkVerification[] } | null,
): string | null {
  if (!result) return 'Không kiểm tra được token và link (daemon không phản hồi). Thử lại sau.';
  if (!result.hasToken) return 'Token Figma không hợp lệ hoặc không được daemon chấp nhận.';
  const byFileKey = new Map(result.links.map((row) => [row.fileKey, row] as const));
  const missing = requested.find((link) => !byFileKey.has(link.fileKey));
  if (missing) return `Daemon chưa trả kết quả kiểm tra cho file ${missing.fileKey}. Hãy kiểm tra lại.`;
  const failed = requested.map((link) => byFileKey.get(link.fileKey)!).find((row) => !row.ok);
  return failed ? failed.detail ?? `Không đọc được file ${failed.name || failed.fileKey}.` : null;
}

type TokenState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'saved'; handle?: string }
  | { kind: 'error'; message: string };

export function FigmaLinksPanel({ links, linksError, onVerificationChange }: FigmaLinksPanelProps) {
  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [rows, setRows] = useState<FigmaLinkVerification[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const verificationGenerationRef = useRef(0);
  const onVerificationChangeRef = useRef(onVerificationChange);
  onVerificationChangeRef.current = onVerificationChange;
  const [desktopStatus, setDesktopStatus] = useState<FigmaDesktopStatusResponse | null>(null);
  const [desktopChecking, setDesktopChecking] = useState(false);

  const linksKey = figmaLinksVerificationKey(links);
  // Hàng "Figma Desktop" chỉ có ý nghĩa khi người dùng đang dùng nguồn Link Figma.
  const showDesktopRow = links.length > 0 || Boolean(linksError);

  const runVerify = async (currentLinks: typeof links) => {
    abortRef.current?.abort();
    const currentKey = figmaLinksVerificationKey(currentLinks);
    const generation = ++verificationGenerationRef.current;
    if (currentLinks.length === 0) {
      setRows(null);
      onVerificationChangeRef.current?.({ status: 'idle', linksKey: currentKey });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setVerifying(true);
    setVerifyError(null);
    onVerificationChangeRef.current?.({ status: 'pending', linksKey: currentKey });
    const result = await verifyFigmaLinks({ links: currentLinks }, controller.signal);
    if (controller.signal.aborted || generation !== verificationGenerationRef.current) return;
    setVerifying(false);
    const failure = figmaVerificationFailure(currentLinks, result);
    if (failure) {
      const message = failure;
      // A normal per-file denial already renders beside that row; reserve the
      // panel-level alert for transport/token/partial-response failures.
      const hasCompleteFailedRows = result?.hasToken
        && currentLinks.every((link) => result.links.some((row) => row.fileKey === link.fileKey))
        && result.links.some((row) => !row.ok);
      setVerifyError(hasCompleteFailedRows ? null : message);
      if (result && !result.hasToken) setToken({ kind: 'missing' });
      setRows(result?.links ?? null);
      onVerificationChangeRef.current?.({ status: 'failed', linksKey: currentKey, message });
      return;
    }
    // `failure === null` guarantees a non-null response with every requested row.
    if (!result) return;
    setRows(result.links);
    onVerificationChangeRef.current?.({ status: 'verified', linksKey: currentKey });
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
      verificationGenerationRef.current += 1;
      setRows(null);
      setVerifying(false);
      const message = linksError ?? (links.length === 0
        ? 'Dán ít nhất một link Figma.'
        : token.kind === 'loading'
          ? 'Đang kiểm tra token Figma…'
          : 'Cần lưu token Figma hợp lệ trước khi tiếp tục.');
      onVerificationChangeRef.current?.({
        status: token.kind === 'loading' ? 'pending' : linksError || links.length > 0 ? 'failed' : 'idle',
        linksKey,
        message,
      });
      return;
    }
    onVerificationChangeRef.current?.({ status: 'pending', linksKey });
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
    if (linksError || links.length === 0) {
      const message = linksError
        ? 'Hãy sửa link Figma ở trên trước khi lưu token.'
        : 'Hãy dán ít nhất một link Figma trước khi lưu token.';
      setVerifyError(message);
      onVerificationChangeRef.current?.({ status: 'failed', linksKey, message });
      return;
    }
    abortRef.current?.abort();
    verificationGenerationRef.current += 1;
    onVerificationChangeRef.current?.({ status: 'pending', linksKey });
    setSaving(true);
    // Validate the draft against the actual files before replacing a known-good
    // saved token. /v1/me cannot prove file_content/library access.
    const controller = new AbortController();
    abortRef.current = controller;
    const verified = await verifyFigmaLinks({ links, token: value }, controller.signal);
    if (controller.signal.aborted) {
      setSaving(false);
      return;
    }
    const failure = figmaVerificationFailure(links, verified);
    if (failure) {
      const message = failure;
      setSaving(false);
      setRows(verified?.links ?? null);
      setVerifyError(message);
      onVerificationChangeRef.current?.({ status: 'failed', linksKey, message });
      return;
    }
    const saved = await saveFigmaConfig({ token: value });
    setSaving(false);
    if (!saved?.hasToken) {
      const message = 'Không lưu được token vào daemon.';
      setVerifyError(message);
      onVerificationChangeRef.current?.({ status: 'failed', linksKey, message });
      return;
    }
    setDraft('');
    setEditing(false);
    setVerifyError(null);
    setRows(verified!.links);
    setToken({ kind: 'saved' });
    onVerificationChangeRef.current?.({ status: 'verified', linksKey });
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
          <button type="button" className={styles.primaryButton} onClick={() => void saveToken()} disabled={saving || !draft.trim() || Boolean(linksError) || links.length === 0} data-testid="figma-token-save">
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
          {linksError || links.length === 0 ? (
            <p className={styles.error} role="status">
              {linksError ? 'Sửa link Figma ở trên trước khi lưu token.' : 'Dán ít nhất một link Figma trước khi lưu token.'}
            </p>
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
