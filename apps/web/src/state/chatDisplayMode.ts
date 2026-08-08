'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * How much of the agent's turn the chat surface shows.
 *
 * `simple` is the reader-facing view: prose, questions it needs answered,
 * and the files it produced. The agent's narration of its own plumbing —
 * tool cards, reasoning blocks, status pills, token/cost stats — is hidden.
 * `full` is the original developer view with everything in the flow.
 *
 * This lives in its own localStorage key rather than in `AppConfig`: it is a
 * per-machine viewing preference, not settings the daemon mirrors, so it does
 * not need the config load/save/migrate round trip.
 */
export type ChatDisplayMode = 'simple' | 'full';

const STORAGE_KEY = 'od-chat-display-mode';

/**
 * Non-technical users are the default audience for the chat surface, so a
 * fresh install starts simplified. Developers flip it once and the choice
 * sticks.
 */
export const DEFAULT_CHAT_DISPLAY_MODE: ChatDisplayMode = 'simple';

export function readChatDisplayMode(): ChatDisplayMode {
  if (typeof window === 'undefined') return DEFAULT_CHAT_DISPLAY_MODE;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'full'
      ? 'full'
      : 'simple';
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
    return DEFAULT_CHAT_DISPLAY_MODE;
  }
}

export function writeChatDisplayMode(mode: ChatDisplayMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore — the in-memory state still drives this session.
  }
}

/**
 * Reads the stored mode after mount rather than during the first render so
 * the server-rendered markup and the hydrated tree agree. The one-frame
 * default matches the rest of the app's localStorage-backed preferences.
 */
export function useChatDisplayMode(): [ChatDisplayMode, (mode: ChatDisplayMode) => void] {
  const [mode, setMode] = useState<ChatDisplayMode>(DEFAULT_CHAT_DISPLAY_MODE);
  useEffect(() => {
    setMode(readChatDisplayMode());
  }, []);
  const update = useCallback((next: ChatDisplayMode) => {
    setMode(next);
    writeChatDisplayMode(next);
  }, []);
  return [mode, update];
}
