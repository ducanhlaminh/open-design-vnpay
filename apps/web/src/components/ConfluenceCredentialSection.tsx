// Confluence credential (base URL + Personal Access Token) — its own small
// settings section, INDEPENDENT of the generic external-MCP config panel
// (McpClientSection). WP8 (2026-08): JIRA ingest was removed and the
// Confluence creds moved out of the generic `mcp-atlassian` MCP server row
// into this dedicated store (`state/confluence-config.ts` ->
// `/api/confluence-config`). GET never returns the real token, only
// `hasToken` — the token field below never round-trips a saved secret back
// into the input; an unedited (empty) field on Save keeps the existing one.

import { useEffect, useState } from 'react';
import { fetchConfluenceConfig, saveConfluenceConfig } from '../state/confluence-config';
import { useT } from '../i18n';
import { Icon } from './Icon';

export function ConfluenceCredentialSection() {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [base, setBase] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await fetchConfluenceConfig();
      if (cancelled) return;
      if (cfg) {
        setBase(cfg.base);
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
      setBase(result.base);
      setHasToken(result.hasToken);
      setTokenDraft('');
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
            onChange={(e) => setBase(e.target.value)}
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
        </span>
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
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && loaded && !saving) {
                e.preventDefault();
                void save();
              }
            }}
            data-testid="confluence-config-token-input"
          />
        </div>
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
