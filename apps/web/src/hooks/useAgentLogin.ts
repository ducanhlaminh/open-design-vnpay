// Host-mode CLI login trigger for the "Local CLI" panel (InlineModelSwitcher
// + the Claude/Codex usage panels it mounts). Shared here so the two
// surfaces that can show a "not logged in" state never run two independent
// polling loops against the same agent.
//
// Flow: POST /api/agents/:agentId/login (daemon opens a HOST terminal
// running `claude /login` / `codex login …` — see openHostLoginTerminal in
// apps/daemon/src/agent-sandbox.ts), then poll GET /api/agents every few
// seconds until this agent's authStatus flips away from 'missing', and
// stop. The caller supplies `onLoggedIn` to refresh whatever central
// `agents` state it owns (e.g. App.tsx's `refreshAgents`) so the flip is
// reflected everywhere at once, not just inside this hook's own state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgents } from '../providers/registry';

export type AgentLoginPhase = 'idle' | 'starting' | 'waiting' | 'error';

export interface AgentLoginState {
  phase: AgentLoginPhase;
  /** Whether the daemon managed to open a terminal window for this attempt. */
  launched?: boolean;
  /** The bare login command, shown as a copy-paste fallback. */
  command?: string;
  /** Daemon-supplied guidance string (already localized server-side). */
  message?: string;
}

const POLL_INTERVAL_MS = 4000;
// Stop polling after 5 minutes so an abandoned login attempt (tab left open,
// user gave up) does not poll /api/agents forever in the background.
const POLL_TIMEOUT_MS = 5 * 60_000;

export function useAgentLogin(
  agentId: 'claude' | 'codex',
  onLoggedIn?: () => void,
) {
  const [state, setState] = useState<AgentLoginState>({ phase: 'idle' });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  // Stop any in-flight polling when the component unmounts (agent switched,
  // popover closed and unmounted, etc.) — otherwise the interval keeps
  // firing setState on an unmounted component.
  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(async () => {
    stopPolling();
    setState({ phase: 'starting' });
    let res: Response;
    try {
      res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/login`, { method: 'POST' });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Login request failed.',
      });
      return;
    }
    const json = (await res.json().catch(() => null)) as
      | { launched?: boolean; command?: string; message?: string }
      | { error?: { message?: string } }
      | null;
    if (!res.ok) {
      const errorBody = json as { error?: { message?: string } } | null;
      setState({ phase: 'error', message: errorBody?.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    const body = json as { launched?: boolean; command?: string; message?: string } | null;
    setState({
      phase: 'waiting',
      launched: body?.launched,
      command: body?.command,
      message: body?.message,
    });
    pollTimerRef.current = setInterval(() => {
      void fetchAgents().then((list) => {
        const found = list.find((a) => a.id === agentId);
        if (found && found.authStatus !== 'missing') {
          stopPolling();
          setState({ phase: 'idle' });
          onLoggedInRef.current?.();
        }
      });
    }, POLL_INTERVAL_MS);
    stopTimerRef.current = setTimeout(stopPolling, POLL_TIMEOUT_MS);
  }, [agentId, stopPolling]);

  return { state, start };
}
