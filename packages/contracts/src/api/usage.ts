// Claude account usage contract.
//
// The daemon reads the Claude Code OAuth token (macOS Keychain or the
// ~/.claude/.credentials.json fallback) and calls Anthropic's usage endpoint —
// the same data Claude Code's `/usage` shows: how much of the rolling 5-hour
// and 7-day subscription limits has been consumed, as a percentage, plus when
// each window resets. This is account-level quota usage, NOT token counting.
export interface ClaudeUsageWindow {
  /** Percent of the window's limit consumed (0–100), or null if unknown. */
  utilization: number | null;
  /** ISO timestamp when this window resets, or null if unknown. */
  resetsAt: string | null;
}

export interface ClaudeUsageResponse {
  /** False when no OAuth token was found or the endpoint refused — the meter
   *  hides / shows "n/a" rather than a fake percentage. */
  available: boolean;
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  /** e.g. "max", "pro" — surfaced for the popover, null if unknown. */
  subscriptionType: string | null;
}

/** A Codex account limit window reported by the Codex CLI app-server. */
export interface CodexUsageWindow {
  /** Percentage of the account allowance consumed (0–100). */
  utilization: number | null;
  /** Unix seconds at which this rolling window resets. */
  resetsAt: number | null;
  /** Duration of the rolling window, when Codex reports it. */
  durationMinutes: number | null;
}

/**
 * Codex account allowance from `account/rateLimits/read`. It is deliberately
 * separate from OpenAI API-key billing/rate limits.
 */
export interface CodexUsageResponse {
  available: boolean;
  primary: CodexUsageWindow;
  secondary: CodexUsageWindow | null;
  planType: string | null;
  hasCredits: boolean | null;
}
