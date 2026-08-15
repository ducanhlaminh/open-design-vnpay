// Confluence credential (base URL + Personal Access Token) — its own small
// settings section, INDEPENDENT of the generic external-MCP config panel
// (McpClientSection). WP8 (2026-08): JIRA ingest was removed and the
// Confluence creds moved out of the generic `mcp-atlassian` MCP server row
// into this dedicated store (`state/confluence-config.ts` ->
// `/api/confluence-config`). GET never returns the real token, only
// `hasToken` — the token field below never round-trips a saved secret back
// into the input; an unedited (empty) field on Save keeps the existing one.

import { useEffect, useMemo, useState } from 'react';
import { fetchConfluenceConfig, saveConfluenceConfig, testConfluenceConnection } from '../state/confluence-config';
import { useT } from '../i18n';
import { Icon } from './Icon';

// VNPAY's own Confluence — pre-filled so a first-time user never has to
// know or type the base URL themselves; still fully editable for anyone
// pointing at a different instance.
const DEFAULT_BASE = 'https://wiki.servicehub.vn';

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
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [base, setBase] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchConfluenceConfig();
      if (cancelled) return;
      if (cfg) {
        setBase(cfg.base || DEFAULT_BASE);
        setHasToken(cfg.hasToken);
      } else {
        setError(t('confluenceConfig.loadError'));
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tokenUrl = useMemo(() => tokenPageUrl(base), [base]);
  const canTest = loaded && !saving && base.trim().length > 0 && (tokenDraft.trim().length > 0 || hasToken);

  const runTest = async () => {
    if (testState.status === 'running' || !canTest) return;
    setTestState({ status: 'running' });
    const tokenTrimmed = tokenDraft.trim();
    const result = await testConfluenceConnection({
      base: base.trim(),
      ...(tokenTrimmed ? { token: tokenTrimmed } : {}),
    });
    setTestState({ status: 'done', ok: result.ok, detail: result.detail, displayName: result.displayName });
  };

  const save = async () => {
    if (saving || !loaded) return;
    setSaving(true);
    setError(null);
    try {
      const tokenTrimmed = tokenDraft.trim();
      const result = await saveConfluenceConfig({
        base: base.trim(),
        ...(tokenTrimmed ? { token: tokenTrimmed } : {}),
      });
      if (!result) {
        setError(t('confluenceConfig.saveError'));
        return;
      }
      setBase(result.base || DEFAULT_BASE);
      setHasToken(result.hasToken);
      setTokenDraft('');
      setTestState({ status: 'idle' });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" data-testid="confluence-config-section">
      <div className="section-head">
        <div>
          <h3>{t('confluenceConfig.title')}</h3>
          <p className="hint">{t('confluenceConfig.subtitle')}</p>
        </div>
      </div>

      <label className="field">
        <span className="field-label">{t('confluenceConfig.baseLabel')}</span>
        <div className="field-row">
          <input
            type="text"
            value={base}
            disabled={!loaded || saving}
            placeholder={t('confluenceConfig.basePlaceholder')}
            onChange={(e) => {
              setBase(e.target.value);
              setTestState({ status: 'idle' });
            }}
            data-testid="confluence-config-base-input"
          />
        </div>
      </label>

      <label className="field">
        <span className="field-label-row">
          <span className="field-label-group">
            <span className="field-label">{t('confluenceConfig.tokenLabel')}</span>
            {hasToken ? (
              <span className="field-status-badge" title={t('confluenceConfig.tokenSavedTitle')}>
                {t('confluenceConfig.tokenSaved')}
              </span>
            ) : null}
          </span>
          {tokenUrl ? (
            <a
              className="field-label-link"
              href={tokenUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="confluence-config-token-link"
            >
              <Icon name="external-link" size={11} />
              {t('confluenceConfig.tokenCreateLink')}
            </a>
          ) : null}
        </span>
        <p className="hint">{t('confluenceConfig.tokenInstructions')}</p>
        <div className="field-row">
          <input
            type="password"
            value={tokenDraft}
            disabled={!loaded || saving}
            placeholder={
              hasToken
                ? t('confluenceConfig.tokenPlaceholderSaved')
                : t('confluenceConfig.tokenPlaceholderEmpty')
            }
            onChange={(e) => {
              setTokenDraft(e.target.value);
              setTestState({ status: 'idle' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && loaded && !saving) {
                e.preventDefault();
                void save();
              }
            }}
            data-testid="confluence-config-token-input"
          />
          <button
            type="button"
            className={'ghost icon-btn settings-test-btn' + (testState.status === 'running' ? ' loading' : '')}
            disabled={!canTest || testState.status === 'running'}
            onClick={() => void runTest()}
            data-testid="confluence-config-test"
          >
            <Icon
              name={testState.status === 'running' ? 'spinner' : 'reload'}
              size={12}
              className={testState.status === 'running' ? 'icon-spin' : ''}
            />
            <span>{testState.status === 'running' ? t('confluenceConfig.testing') : t('confluenceConfig.testButton')}</span>
          </button>
        </div>
        {testState.status === 'done' ? (
          <span
            className={testState.ok ? 'field-inline-status success' : 'field-error'}
            role={testState.ok ? 'status' : 'alert'}
            data-testid="confluence-config-test-result"
          >
            {testState.ok
              ? testState.displayName
                ? t('confluenceConfig.testSuccessNamed', { name: testState.displayName })
                : t('confluenceConfig.testSuccess')
              : testState.detail || t('confluenceConfig.testFailed')}
          </span>
        ) : null}
      </label>

      <div className="section-head-actions">
        <button
          type="button"
          className={'primary' + (saving ? ' is-busy' : '')}
          disabled={!loaded || saving}
          onClick={() => void save()}
          data-testid="confluence-config-save"
        >
          <Icon name={saving ? 'spinner' : 'check'} size={12} className={saving ? 'icon-spin' : ''} />
          <span>{saving ? t('confluenceConfig.saving') : t('confluenceConfig.saveButton')}</span>
        </button>
      </div>

      <span className="hint" role={error ? 'alert' : undefined}>
        {error ?? (savedAt ? t('confluenceConfig.savedHint') : t('confluenceConfig.helpHint'))}
      </span>
    </section>
  );
}
