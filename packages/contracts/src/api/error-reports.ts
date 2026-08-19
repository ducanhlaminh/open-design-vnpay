// Pipeline stage error reports — the daemon builds one whenever a stage
// ends `failed`, uploads it to the shared media store (dedicated folder
// `PIPELINE_ERROR_REPORTS_FOLDER`, path `errors/<installationId>/<id>.json`)
// so pipeline-studio can list them for the developers. Never carries the
// designer's documents / stage outputs — only run metadata, the failure
// reason and a redacted daemon-log tail.

/** Media-store folder (a pseudo project id) that holds every report. Kept out
 *  of the real project folders so a local-only project never gets a folder
 *  created in the shared store just because a stage failed. */
export const PIPELINE_ERROR_REPORTS_FOLDER = '__od-error-reports';
export const PIPELINE_ERROR_REPORTS_PREFIX = 'errors/';

export interface PipelineErrorReport {
  schemaVersion: 1;
  /** Short id shown to the designer ("Đã gửi báo cáo lỗi #ab12cd34"). */
  id: string;
  createdAt: number;
  app: {
    version: string;
    channel: string;
    packaged: boolean;
  };
  machine: {
    platform: string;
    release: string;
    arch: string;
    nodeVersion: string;
  };
  identity: {
    /** SSO email when signed in, else feedbackUsername / installationId. */
    user: string;
    installationId: string;
    namespace: string | null;
    channel: 'dev' | 'packaged';
  };
  run: {
    projectId: string;
    projectName?: string;
    workflowId: string | null;
    stageId: string;
    runId?: string;
    agentId?: string;
    model?: string | null;
    reasoning?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    errorCode?: string | null;
    durationMs?: number | null;
    /** Expected outputs vs what landed (`describeStageOutputs`). */
    outputs?: string | null;
    /** How the run was classified before mapping to the stage status. */
    finalStatus?: string | null;
  };
  /** The stage's failure reason — same text "Xem lỗi" shows. */
  error: string;
  /** Last 2000 chars of the agent's stderr / stdout when the run failed. */
  stderrTail?: string | null;
  stdoutTail?: string | null;
  /** Redacted tail of logs/daemon/latest.log around the failure. */
  logTail?: string | null;

  // ── Additive context (0.8.67+). Every field below is optional so older
  // readers keep parsing; none of it is produced by an LLM — all values are
  // read straight from the daemon's DB, process, env and filesystem.

  /** What the agent that ran the failing (sub-)conversation actually did. */
  agent?: ErrorReportAgentContext | null;
  /** Fan-out / validation view of the stage. */
  stage?: ErrorReportStageContext | null;
  /** Machine + network environment at the moment of failure. */
  env?: ErrorReportEnvContext | null;
  /** Stable hash of (stage, normalized cause) so the studio can count "same
   *  failure on N machines". */
  fingerprint?: string | null;
  /** Id of the previous report for the same project + stage, if any. */
  previousReportId?: string | null;
}

export interface ErrorReportAgentContext {
  /** Conversation the tails below came from (stage conversation, or the
   *  first failed sub-conversation of a fan-out). */
  conversationId: string | null;
  /** Last assistant text of that conversation — redacted, ≤3000 chars. */
  transcriptTail: string | null;
  /** Tool-call summary from the last assistant message's events. */
  tools: {
    total: number;
    failed: number;
    lastTool: string | null;
    /** "<tool>: <first line of error>" — up to 10. */
    failures: string[];
  } | null;
  /** Token usage the CLI reported for that run, when it did. */
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  /** The CLI as the daemon sees it (same data as the Local CLI panel). */
  cli: {
    available: boolean | null;
    version: string | null;
    path: string | null;
    authStatus: string | null;
    /** True when the run went through the Docker sandbox, false on host. */
    sandbox: boolean | null;
  } | null;
  /** Subscription quota at (or shortly before) the failure. */
  quota: {
    source: string;
    windows: Array<{ label: string; utilization: number | null; resetsAt: string | null }>;
    reason: string | null;
    /** When the snapshot was read (ms epoch), null when unknown. */
    readAt: number | null;
  } | null;
  /** Size of the kickoff prompt + skill that drove the run. */
  prompt: { chars: number | null; skillId: string | null } | null;
}

export interface ErrorReportStageContext {
  /** Sub-conversation status counts (fan-out stages). */
  tasks: { total: number; queued: number; running: number; succeeded: number; failed: number } | null;
  /** Structured per-item validation failures (docs-review pages, docs-comp
   *  screens…): `code` is a stable enum-like tag derived from the daemon's
   *  own error string, `detail` the original text. */
  validation: Array<{ item: string; code: string; detail: string }> | null;
  /** "path  size  mtime" lines of what is on disk under the stage's output
   *  dir at report time (names only, never content). */
  outputsListing: string | null;
}

export interface ErrorReportEnvContext {
  diskFreeBytes: number | null;
  memFreeBytes: number | null;
  memTotalBytes: number | null;
  /** Length of the project root path (Windows MAX_PATH suspects). */
  projectRootLength: number | null;
  locale: string | null;
  timezone: string | null;
  daemonUptimeMs: number | null;
  /** Agent runs in flight when the report was built. */
  activeRuns: number | null;
  /** HTTPS_PROXY / HTTP_PROXY set. */
  proxy: boolean;
  /** NODE_EXTRA_CA_CERTS set (corporate TLS inspection). */
  extraCaCerts: boolean;
  sandboxEnabled: boolean | null;
  /** Quick reachability probes (3s each) to the services the run needs. */
  connectivity: Array<{ target: string; result: string; ms: number }> | null;
}
