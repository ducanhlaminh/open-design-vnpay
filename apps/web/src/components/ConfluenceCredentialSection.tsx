// Confluence credential (deployment URL + per-user PAT) — its own small
// settings section, INDEPENDENT of the generic external-MCP config panel
// (McpClientSection). WP8 (2026-08): JIRA ingest was removed and the
// Confluence creds moved out of the generic `mcp-atlassian` MCP server row
// into this dedicated store (`state/confluence-config.ts` ->
// `/api/confluence-config`). GET never returns the real token, only
// `hasToken` — the token field below never round-trips a saved secret back
// into the input; an unedited (empty) field on Save keeps the existing one.

import { useEffect, useMemo, useState } from 'react';
import type { ConfluenceConfigResponse } from '../state/confluence-config';
import { fetchConfluenceConfig, testConfluenceConnection } from '../state/confluence-config';
import { Icon } from './Icon';
import { ConfluenceTokenEditModal } from './ConfluenceTokenEditModal';
import { ConfluenceTokenGuideModal } from './ConfluenceTokenGuideModal';
import styles from './ConfluenceCredentialSection.module.css';

function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Confluence Server/Data Center's standard per-user PAT-creation route,
// derived from whatever base URL is currently typed so the link always
// points at the user's own instance.
function tokenPageUrl(rawBase: string): string | null {
  const base = normalizeBase(rawBase);
  return base ? `${base}/plugins/personalaccesstokens/usertokens.action` : null;
}

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; ok: boolean; detail?: string; displayName?: string };

export function ConfluenceCredentialSection() {
  const [loaded, setLoaded] = useState(false);
  const [base, setBase] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [guideOpen, setGuideOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editInitialToken, setEditInitialToken] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchConfluenceConfig();
      if (cancelled) return;
      if (cfg) {
        setBase(cfg.base);
        setHasToken(cfg.hasToken);
      } else {
        setError('Không thể tải cấu hình Confluence.');
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tokenUrl = useMemo(() => tokenPageUrl(base), [base]);
  const canTest = loaded && base.trim().length > 0 && hasToken;

  const runTest = async () => {
    if (testState.status === 'running' || !canTest) return;
    setTestState({ status: 'running' });
    const result = await testConfluenceConnection({});
    setTestState({ status: 'done', ok: result.ok, detail: result.detail, displayName: result.displayName });
  };

  const openEditor = (initialToken = '') => {
    setEditInitialToken(initialToken);
    setEditOpen(true);
  };

  const onSaved = (config: ConfluenceConfigResponse) => {
    setBase(config.base);
    setHasToken(config.hasToken);
    setSavedAt(Date.now());
    setTestState({ status: 'idle' });
  };

  return (
    <section className={`settings-section ${styles.card}`} data-testid="confluence-config-section">
      <header className={styles.header}>
        <span className={styles.brandIcon}><Icon name="link" size={20} /></span>
        <div className={styles.heading}>
          <h3>Confluence</h3>
          <p>Cho phép Docs pipeline lấy tài liệu trực tiếp bằng Personal Access Token lưu trên máy này.</p>
        </div>
        {loaded ? (
          <span className={`${styles.statusBadge}${hasToken ? '' : ` ${styles.statusBadgePending}`}`}>
            <Icon name={hasToken ? 'check' : 'info'} size={12} />
            {hasToken ? 'Đã cấu hình' : 'Chưa cấu hình'}
          </span>
        ) : null}
      </header>

      {!loaded ? <div className={styles.loadingLine} aria-label="Đang tải cấu hình Confluence" /> : (
        <div className={`${styles.connectionPanel}${hasToken ? '' : ` ${styles.connectionPanelPending}`}`}>
          <div className={styles.connectionInfo}>
            <span className={styles.connectionIcon}>
              <Icon name={hasToken ? 'check' : 'info'} size={17} />
            </span>
            <div>
              <strong>{hasToken ? 'PAT đã được lưu an toàn' : 'Chưa có Personal Access Token'}</strong>
              <p>{hasToken ? 'Docs pipeline đã sẵn sàng đọc tài liệu Confluence.' : 'Thiết lập PAT để bắt đầu lấy tài liệu vào dự án.'}</p>
            </div>
          </div>
          <button
            type="button"
            className={hasToken ? styles.secondaryAction : styles.primaryAction}
            onClick={() => openEditor()}
            data-testid={hasToken ? 'confluence-config-edit' : 'confluence-config-setup'}
          >
            <Icon name={hasToken ? 'edit' : 'plus'} size={13} />
            {hasToken ? 'Thay đổi PAT' : 'Thiết lập PAT'}
          </button>
        </div>
      )}

      <div className={styles.utilityRow}>
        {hasToken ? <button
          type="button"
          className={styles.secondaryAction}
          disabled={!canTest || testState.status === 'running'}
          onClick={() => void runTest()}
          data-testid="confluence-config-test"
        >
          <Icon name={testState.status === 'running' ? 'spinner' : 'reload'} size={13} className={testState.status === 'running' ? 'icon-spin' : ''} />
          {testState.status === 'running' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
        </button> : null}
        {tokenUrl ? <button type="button" className={styles.guideButton} onClick={() => setGuideOpen(true)}>
          <Icon name="info" size={13} /> Hướng dẫn lấy PAT
        </button> : null}
        {tokenUrl ? <a href={tokenUrl} target="_blank" rel="noreferrer" data-testid="confluence-config-token-link">
          Tạo PAT trên Confluence <Icon name="external-link" size={12} />
        </a> : null}
      </div>

      {testState.status === 'done' ? <div
        className={`${styles.result} ${testState.ok ? styles.testSuccess : styles.testError}`}
        role={testState.ok ? 'status' : 'alert'}
        data-testid="confluence-config-test-result"
      >
        <Icon name={testState.ok ? 'check' : 'info'} size={15} />
        {testState.ok
          ? testState.displayName ? `Kết nối thành công với tài khoản ${testState.displayName}.` : 'Kết nối Confluence thành công.'
          : testState.detail || 'Không thể kết nối Confluence.'}
      </div> : null}

      <p className={styles.footnote} role={error ? 'alert' : undefined}>
        {error ?? (savedAt ? 'PAT mới đã được lưu trên máy này.' : 'Dùng cho các bước Docs, PRD và review tài liệu; không cần MCP server bên ngoài.')}
      </p>

      {guideOpen && tokenUrl ? (
        <ConfluenceTokenGuideModal
          tokenUrl={tokenUrl}
          onClose={() => setGuideOpen(false)}
          onUseToken={(token) => {
            setGuideOpen(false);
            openEditor(token);
          }}
        />
      ) : null}
      {editOpen ? (
        <ConfluenceTokenEditModal
          replacing={hasToken}
          initialToken={editInitialToken}
          tokenUrl={tokenUrl}
          onClose={() => {
            setEditOpen(false);
            setEditInitialToken('');
          }}
          onSaved={onSaved}
        />
      ) : null}
    </section>
  );
}
