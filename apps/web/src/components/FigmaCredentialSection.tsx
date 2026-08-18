// Figma Personal Access Token — its own settings card in Tích hợp (MCP tab),
// right next to Confluence. The daemon reads Figma files (Nạp Design system
// từ link Figma; docs-review "Màn hình → Component") through the REST API
// with this token — no agent, no MCP, no Figma Desktop needed — so it is a
// machine-wide credential, not something tied to one Design system or App.
// Until 0.8.64 the token form lived inside the "Nạp Design system từ link
// Figma" modal (FigmaLinksPanel); it moved here so the token is set up once
// in the place people expect credentials to be. GET never returns the real
// token, only `hasToken`; saving probes the draft against Figma
// (`POST /api/figma-config/test`) BEFORE replacing a known-good saved token.

import { useEffect, useState } from 'react';

import { fetchFigmaConfig, saveFigmaConfig, testFigmaConnection } from '../state/figma-config';
import { Icon } from './Icon';
import card from './ConfluenceCredentialSection.module.css';
import styles from './FigmaCredentialSection.module.css';

export const FIGMA_TOKEN_GUIDE_STEPS: readonly string[] = [
  'Mở Figma (web hoặc Desktop) → bấm ảnh đại diện góc trên → Settings.',
  'Chọn thẻ Security → mục Personal access tokens → Generate new token.',
  'Đặt tên (vd “Open Design”), thời hạn tuỳ ý; quyền chỉ cần File content: Read-only.',
  'Bấm Generate, sao chép token (Figma chỉ hiện MỘT lần) rồi dán vào ô token phía trên.',
];

/** Figma account settings — the Security tab holds Personal access tokens. */
export const FIGMA_TOKEN_SETTINGS_URL = 'https://www.figma.com/settings';

type TokenState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'saved'; handle?: string }
  | { kind: 'error'; message: string };

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; ok: boolean; detail?: string; handle?: string };

export function FigmaCredentialSection() {
  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchFigmaConfig();
      if (cancelled) return;
      if (!cfg) {
        setLoadError('Không đọc được cấu hình Figma từ daemon.');
        setToken({ kind: 'missing' });
        return;
      }
      if (!cfg.hasToken) { setToken({ kind: 'missing' }); return; }
      const probe = await testFigmaConnection();
      if (cancelled) return;
      setToken(probe.ok
        ? { kind: 'saved', ...(probe.handle ? { handle: probe.handle } : probe.email ? { handle: probe.email } : {}) }
        : { kind: 'error', message: probe.detail ?? 'Token Figma đã lưu nhưng không dùng được.' });
    })();
    return () => { cancelled = true; };
  }, []);

  const hasToken = token.kind === 'saved' || token.kind === 'error';
  const loaded = token.kind !== 'loading';

  const openForm = () => {
    setDraft('');
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
    setDraft('');
    setFormError(null);
  };

  const save = async () => {
    const value = draft.trim();
    if (!value || saving) return;
    setSaving(true);
    setFormError(null);
    // Probe the draft first so a typo can never overwrite a working token.
    const probe = await testFigmaConnection({ token: value });
    if (!probe.ok) {
      setSaving(false);
      setFormError(probe.detail ?? 'Token Figma không hợp lệ.');
      return;
    }
    const saved = await saveFigmaConfig({ token: value });
    setSaving(false);
    if (!saved?.hasToken) {
      setFormError('Không lưu được token vào daemon.');
      return;
    }
    setToken({ kind: 'saved', ...(probe.handle ? { handle: probe.handle } : probe.email ? { handle: probe.email } : {}) });
    setSavedAt(Date.now());
    setTestState({ status: 'idle' });
    setFormOpen(false);
    setDraft('');
  };

  const runTest = async () => {
    if (testState.status === 'running' || !hasToken) return;
    setTestState({ status: 'running' });
    const result = await testFigmaConnection();
    const handle = result.handle ?? result.email;
    setTestState({ status: 'done', ok: result.ok, detail: result.detail, ...(handle ? { handle } : {}) });
    if (result.ok) setToken({ kind: 'saved', ...(handle ? { handle } : {}) });
    else setToken({ kind: 'error', message: result.detail ?? 'Token Figma đã lưu nhưng không dùng được.' });
  };

  const clear = async () => {
    if (saving || !hasToken) return;
    if (!window.confirm('Gỡ token Figma khỏi máy này? Các Design system nạp từ link Figma sẽ không cập nhật được cho tới khi có token mới.')) return;
    setSaving(true);
    const result = await saveFigmaConfig({ clear: true });
    setSaving(false);
    if (!result) {
      setLoadError('Không gỡ được token khỏi daemon.');
      return;
    }
    setToken(result.hasToken ? token : { kind: 'missing' });
    setTestState({ status: 'idle' });
    setSavedAt(null);
    setFormOpen(false);
  };

  const statusStrong = token.kind === 'saved'
    ? `Token đã được lưu an toàn${token.handle ? ` · tài khoản ${token.handle}` : ''}`
    : token.kind === 'error'
      ? 'Token đã lưu nhưng không dùng được'
      : 'Chưa có Personal Access Token';
  const statusBody = token.kind === 'saved'
    ? 'Dùng chung cho mọi Design system và dự án trên máy này.'
    : token.kind === 'error'
      ? token.message
      : 'Thiết lập token để nạp Design system từ link Figma và đối chiếu component.';

  return (
    <section className={`settings-section ${card.card}`} data-testid="figma-config-section">
      <header className={card.header}>
        <span className={card.brandIcon}><Icon name="link" size={20} /></span>
        <div className={card.heading}>
          <h3>Figma</h3>
          <p>Personal Access Token để daemon đọc danh mục component thẳng từ file Figma (Nạp Design system từ link Figma, bước Màn hình → Component). Lưu một lần cho cả máy.</p>
        </div>
        {loaded ? (
          <span className={`${card.statusBadge}${token.kind === 'saved' ? '' : ` ${card.statusBadgePending}`}`}>
            <Icon name={token.kind === 'saved' ? 'check' : 'info'} size={12} />
            {token.kind === 'saved' ? 'Đã cấu hình' : token.kind === 'error' ? 'Cần kiểm tra' : 'Chưa cấu hình'}
          </span>
        ) : null}
      </header>

      {!loaded ? <div className={card.loadingLine} aria-label="Đang tải cấu hình Figma" /> : (
        <div className={`${card.connectionPanel}${token.kind === 'saved' ? '' : ` ${card.connectionPanelPending}`}`}>
          <div className={card.connectionInfo}>
            <span className={card.connectionIcon}>
              <Icon name={token.kind === 'saved' ? 'check' : 'info'} size={17} />
            </span>
            <div>
              <strong>{statusStrong}</strong>
              <p>{statusBody}</p>
            </div>
          </div>
          {!formOpen ? (
            <button
              type="button"
              className={hasToken ? card.secondaryAction : card.primaryAction}
              onClick={openForm}
              data-testid={hasToken ? 'figma-config-edit' : 'figma-config-setup'}
            >
              <Icon name={hasToken ? 'edit' : 'plus'} size={13} />
              {hasToken ? 'Đổi token' : 'Thiết lập token'}
            </button>
          ) : null}
        </div>
      )}

      {formOpen ? (
        <div className={styles.tokenForm}>
          <input
            type="password"
            className={styles.tokenInput}
            aria-label="Personal Access Token của Figma"
            placeholder="figd_…"
            value={draft}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void save(); }
              if (event.key === 'Escape') { event.preventDefault(); closeForm(); }
            }}
            disabled={saving}
          />
          <button type="button" className={card.primaryAction} onClick={() => void save()} disabled={saving || !draft.trim()} data-testid="figma-token-save">
            <Icon name={saving ? 'spinner' : 'check'} size={13} className={saving ? 'icon-spin' : ''} />
            {saving ? 'Đang kiểm tra…' : 'Lưu token'}
          </button>
          <button type="button" className={card.secondaryAction} onClick={closeForm} disabled={saving}>Huỷ</button>
          {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
        </div>
      ) : null}

      <div className={card.utilityRow}>
        {hasToken ? <button
          type="button"
          className={card.secondaryAction}
          disabled={testState.status === 'running' || saving}
          onClick={() => void runTest()}
          data-testid="figma-config-test"
        >
          <Icon name={testState.status === 'running' ? 'spinner' : 'reload'} size={13} className={testState.status === 'running' ? 'icon-spin' : ''} />
          {testState.status === 'running' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
        </button> : null}
        <button type="button" className={card.guideButton} onClick={() => setGuideOpen((open) => !open)} aria-expanded={guideOpen}>
          <Icon name="info" size={13} /> {guideOpen ? 'Ẩn hướng dẫn' : 'Cách lấy token'}
        </button>
        <a href={FIGMA_TOKEN_SETTINGS_URL} target="_blank" rel="noreferrer" data-testid="figma-config-token-link">
          Tạo token trên Figma <Icon name="external-link" size={12} />
        </a>
        {hasToken ? <button type="button" className={styles.dangerButton} onClick={() => void clear()} disabled={saving} data-testid="figma-config-clear">
          Gỡ token
        </button> : null}
      </div>

      {guideOpen ? (
        <ol className={styles.guide}>
          {FIGMA_TOKEN_GUIDE_STEPS.map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}

      {testState.status === 'done' ? <div
        className={`${card.result} ${testState.ok ? card.testSuccess : card.testError}`}
        role={testState.ok ? 'status' : 'alert'}
        data-testid="figma-config-test-result"
      >
        <Icon name={testState.ok ? 'check' : 'info'} size={15} />
        {testState.ok
          ? testState.handle ? `Kết nối thành công với tài khoản ${testState.handle}.` : (testState.detail ?? 'Kết nối Figma thành công.')
          : testState.detail || 'Không thể kết nối Figma.'}
      </div> : null}

      <p className={card.footnote} role={loadError ? 'alert' : undefined}>
        {loadError ?? (savedAt
          ? 'Token mới đã được lưu trên máy này.'
          : 'Chỉ cần quyền File content: Read-only. Token không rời khỏi máy này; daemon dùng nó để gọi Figma REST API.')}
      </p>
    </section>
  );
}
