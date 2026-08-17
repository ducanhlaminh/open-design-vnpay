export interface SelfUpdateFollowResult {
  ok: boolean;
  restartRequired?: boolean;
  error?: string;
  operationId: string;
  targetVersion: string;
  status: Record<string, any> | null;
}

interface FollowOptions {
  base: string;
  operationId: string;
  targetVersion: string;
  onProgress?: (status: Record<string, any>) => void;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  reconnectGraceMs?: number;
  overallTimeoutMs?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Windows permits three three-minute download attempts. Keep a deliberately
// generous overall budget for slow extraction, restart and health/rollback;
// the follower must not declare failure while the bounded installer is alive.
export const DEFAULT_SELF_UPDATE_OVERALL_TIMEOUT_MS = 35 * 60_000;

export function isSuccessfulUpdateNoop(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.started === false && response.reason === 'up-to-date';
}

export function selfUpdateProgressKey(status: Record<string, any>): string {
  const phase = status?.phase ?? status?.progress;
  return [status?.state, phase?.step, phase?.totalSteps, phase?.label].join('|');
}

/** Polls through the expected daemon restart and accepts success only on the target version. */
export async function followHostUpdate(options: FollowOptions): Promise<SelfUpdateFollowResult> {
  const {
    base,
    operationId,
    targetVersion,
    onProgress,
    fetchImpl = fetch,
    pollMs = 1_000,
    reconnectGraceMs = 90_000,
    overallTimeoutMs = DEFAULT_SELF_UPDATE_OVERALL_TIMEOUT_MS,
    requestTimeoutMs = 5_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const startedAt = Date.now();
  let disconnectedAt: number | null = null;
  let lastProgressKey: string | null = null;
  let lastStatus: Record<string, any> | null = null;

  while (Date.now() - startedAt < overallTimeoutMs) {
    try {
      const resp = await fetchImpl(`${base}/api/update/status`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!resp.ok) throw new Error(`status endpoint returned HTTP ${resp.status}`);
      const status = await resp.json() as Record<string, any>;
      disconnectedAt = null;
      lastStatus = status;

      if (status.operationId && status.operationId !== operationId) {
        return {
          ok: false,
          error: `another update operation replaced ${operationId}`,
          operationId,
          targetVersion,
          status,
        };
      }

      const key = selfUpdateProgressKey(status);
      if (onProgress && key !== lastProgressKey) {
        onProgress(status);
        lastProgressKey = key;
      }

      if (status.state === 'healthy') {
        if (status.currentVersion === targetVersion) {
          return { ok: true, operationId, targetVersion, status };
        }
        return {
          ok: false,
          error: `daemon reported healthy on ${status.currentVersion ?? 'unknown'}, expected ${targetVersion}`,
          operationId,
          targetVersion,
          status,
        };
      }
      if (status.state === 'restart-required') {
        return {
          ok: true,
          restartRequired: true,
          operationId,
          targetVersion,
          status,
        };
      }
      if (status.state === 'failed' || status.state === 'rolled-back') {
        return {
          ok: false,
          error: status.lastError?.message ?? status.updateState?.error?.message ?? `update ${status.state}`,
          operationId,
          targetVersion,
          status,
        };
      }
    } catch (error) {
      disconnectedAt ??= Date.now();
      if (Date.now() - disconnectedAt > reconnectGraceMs) {
        return {
          ok: false,
          error: `daemon did not reconnect within ${reconnectGraceMs / 1000}s: ${(error as Error)?.message ?? error}`,
          operationId,
          targetVersion,
          status: lastStatus,
        };
      }
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    error: `update did not finish within ${overallTimeoutMs / 60_000} minutes`,
    operationId,
    targetVersion,
    status: lastStatus,
  };
}
