// Web → daemon calls for conflict-aware pull (PLAN → APPLY). Backs the
// PullConflictModal + the per-project "Pull" button in PipelinesView. See
// apps/daemon/src/remote-projects-routes.ts and
// docs/guides/pull-conflict-resolution-spec.md.

import {
  ERR_PLAN_EXPIRED,
  type PullApplyRequest,
  type PullApplyResult,
  type PullPlan,
} from '@open-design/contracts';

/** Thrown when APPLY references a plan the daemon has expired/forgotten (HTTP
 *  409 PLAN_EXPIRED). Callers should re-plan and let the user review again. */
export class PlanExpiredError extends Error {
  constructor() {
    super('plan expired');
    this.name = 'PlanExpiredError';
  }
}

function errorMessage(body: unknown, fallback: string): string {
  return (body as { error?: { message?: string } })?.error?.message ?? fallback;
}

/** PLAN: classify a project's remote files vs the local cwd (no disk writes). */
export async function pullPlan(projectId: string): Promise<PullPlan> {
  const res = await fetch('/api/kg/pull-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(body, `pull-plan → HTTP ${res.status}`));
  return (body as { data: PullPlan }).data;
}

/** APPLY: download chosen-remote + new files; keep chosen-local untouched. */
export async function pullApply(req: PullApplyRequest): Promise<PullApplyResult> {
  const res = await fetch('/api/kg/pull-apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && (body as { error?: { code?: string } })?.error?.code === ERR_PLAN_EXPIRED) {
    throw new PlanExpiredError();
  }
  if (!res.ok) throw new Error(errorMessage(body, `pull-apply → HTTP ${res.status}`));
  return (body as { data: PullApplyResult }).data;
}
