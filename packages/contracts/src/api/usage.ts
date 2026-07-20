// Token-usage monitoring contract.
//
// The daemon records one row per finished run that reported provider usage
// (input/output tokens), then aggregates them into two rolling buckets the
// always-visible Usage meter in the workspace chrome polls:
//   - `session`: since the current daemon process started (resets on restart)
//   - `week`:    the trailing 7 days
export interface TokenUsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of runs that contributed usage to this bucket. */
  runs: number;
}

export interface TokenUsageResponse {
  session: TokenUsageBucket;
  week: TokenUsageBucket;
  /** Epoch ms the current daemon session started — the `session` bucket floor. */
  sessionStartedAt: number;
}
