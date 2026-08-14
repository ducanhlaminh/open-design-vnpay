// Login status + (best-effort) account email line, shared by
// ClaudeUsagePanel and CodexUsagePanel — the two usage panels mounted from
// InlineModelSwitcher's "Local CLI" popover. Owns the login-trigger button
// and its polling (via useAgentLogin) so the two panels never run two
// independent polling loops against the same agent.

import { useState } from 'react';
import { useT } from '../i18n';
import { useAgentLogin } from '../hooks/useAgentLogin';
import type { AgentInfo } from '../types';

interface Props {
  agentId: 'claude' | 'codex';
  agent?: AgentInfo | null;
  /** Called once, right after a poll detects the agent's authStatus flipped
   *  away from 'missing' — the caller refreshes whatever central `agents`
   *  state it owns so the flip is reflected everywhere at once. */
  onAuthChanged?: () => void;
}

export function AgentAuthLine({ agentId, agent, onAuthChanged }: Props): JSX.Element | null {
  const t = useT();
  const { state, start } = useAgentLogin(agentId, onAuthChanged);
  const authStatus = agent?.authStatus;

  if (authStatus === 'ok') {
    const email = agent?.authAccount?.email;
    return (
      <div className="agent-auth-line agent-auth-line--ok">
        <span className="agent-auth-line__dot" aria-hidden="true" />
        <span>{t('inlineSwitcher.authOk')}</span>
        {email ? <span className="agent-auth-line__email">{email}</span> : null}
      </div>
    );
  }

  if (authStatus !== 'missing') return null;

  const busy = state.phase === 'starting' || state.phase === 'waiting';

  return (
    <div className="agent-auth-line agent-auth-line--missing">
      <div className="agent-auth-line__row">
        <span className="agent-auth-line__dot agent-auth-line__dot--missing" aria-hidden="true" />
        <span>{t('inlineSwitcher.authMissing')}</span>
        <button
          type="button"
          className="agent-auth-line__login-btn"
          data-testid={`agent-auth-login-${agentId}`}
          onClick={() => void start()}
          disabled={busy}
        >
          {state.phase === 'starting'
            ? t('inlineSwitcher.loginStarting')
            : state.phase === 'waiting'
              ? t('inlineSwitcher.loginWaiting')
              : t('inlineSwitcher.loginButton')}
        </button>
      </div>
      {state.phase === 'waiting' && state.message ? (
        <p className="agent-auth-line__note">{state.message}</p>
      ) : null}
      {state.phase === 'waiting' && state.launched === false && state.command ? (
        <CommandFallback command={state.command} />
      ) : null}
      {state.phase === 'error' ? (
        <p className="agent-auth-line__note">
          {state.message ?? t('inlineSwitcher.loginErrorFallback')}
        </p>
      ) : null}
    </div>
  );
}

function CommandFallback({ command }: { command: string }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-auth-line__fallback">
      <code>{command}</code>
      <button
        type="button"
        className="agent-auth-line__copy-btn"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              /* clipboard unavailable — the command text is still visible to copy manually */
            });
        }}
      >
        {copied ? t('inlineSwitcher.loginCopied') : t('inlineSwitcher.loginCopyCommand')}
      </button>
    </div>
  );
}
