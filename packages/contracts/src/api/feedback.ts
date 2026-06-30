// Cross-user feedback collection API. Each install publishes its genuine
// end-user prompts to the shared media-service store; `pull` merges every
// install's prompts for a project into one local file the summary-feedback
// skill reads. See apps/daemon/src/feedback.ts for the storage model.

/** Result of POST /api/projects/:id/feedback/pull. */
export interface FeedbackPullResponse {
  ok: boolean;
  /** KGS/media project id the feedback was gathered for. */
  projectId: string;
  /** How many per-install `feedback/*.jsonl` files were merged. */
  files: number;
  /** Total prompt records across all merged files. */
  records: number;
  /** Absolute path of the local merged file written into the project cwd. */
  path: string;
}
