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
}
