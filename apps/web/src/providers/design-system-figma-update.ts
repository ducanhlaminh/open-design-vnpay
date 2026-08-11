import type {
  ApproveFigmaDesignSystemUpdateResponse,
  DesignSystemCriteriaKind,
  DesignSystemCriteriaStatus,
  DesignSystemCriteriaVersionState,
  DesignSystemFigmaUpdateState,
  DesignSystemUpdateLifecycle,
} from '@open-design/contracts';

export type {
  ApproveFigmaDesignSystemUpdateResponse,
  DesignSystemCriteriaKind,
  DesignSystemCriteriaVersionState as DesignSystemCriteriaUpdateState,
  DesignSystemFigmaUpdateState,
} from '@open-design/contracts';

export type DesignSystemContextUpdate = ApproveFigmaDesignSystemUpdateResponse['contextUpdates'][number];

export interface DesignSystemFigmaUpdateError {
  message: string;
  code?: string;
  staleCriteria?: DesignSystemCriteriaKind[];
}

export type DesignSystemFigmaUpdateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesignSystemFigmaUpdateError };

const CRITERIA_KINDS: DesignSystemCriteriaKind[] = ['components', 'rules'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseCriteriaState(
  kind: DesignSystemCriteriaKind,
  value: unknown,
): DesignSystemCriteriaVersionState {
  const source = isObject(value) ? value : {};
  const rawStatus = source.status;
  const status: DesignSystemCriteriaStatus =
    rawStatus === 'missing' || rawStatus === 'stale' || rawStatus === 'draft' || rawStatus === 'current'
      ? rawStatus
      : 'missing';
  const count = typeof source.count === 'number' && Number.isFinite(source.count) ? source.count : 0;
  return {
    kind,
    status,
    hasApprovedFile: source.hasApprovedFile === true || typeof source.approvedContent === 'string',
    hasDraft: source.hasDraft === true || typeof source.draftContent === 'string',
    approvedContent: nullableString(source.approvedContent),
    draftContent: nullableString(source.draftContent),
    count,
    generatedAt: nullableString(source.generatedAt),
    generatedFromVersion: positiveVersion(source.generatedFromVersion) ?? null,
    generatedFromFigmaDigest: nullableString(source.generatedFromFigmaDigest),
  };
}

/**
 * Older installations can return no update lifecycle at all. Treat that as
 * an approved v1 instead of hiding the update entry point or crashing the
 * Design System page.
 */
export function parseDesignSystemFigmaUpdateState(value: unknown): DesignSystemFigmaUpdateState {
  const outer = isObject(value) ? value : {};
  const source = isObject(outer.updateState)
    ? outer.updateState
    : isObject(outer.state)
      ? outer.state
      : outer;
  const rawLifecycle = source.lifecycle;
  const lifecycle: DesignSystemUpdateLifecycle =
    rawLifecycle === 'drafting'
      || rawLifecycle === 'criteria_pending'
      || rawLifecycle === 'ready_for_review'
      || rawLifecycle === 'approved'
      ? rawLifecycle
      : 'approved';
  const criteriaSource = isObject(source.criteria) ? source.criteria : {};
  const candidateVersion = positiveVersion(source.candidateVersion) ?? null;

  return {
    schemaVersion: 1,
    designSystemId: typeof source.designSystemId === 'string' ? source.designSystemId : '',
    lifecycle,
    currentVersion: positiveVersion(source.currentVersion) ?? 1,
    currentFigmaDigest: nullableString(source.currentFigmaDigest),
    candidateVersion,
    candidateFigmaDigest: nullableString(source.candidateFigmaDigest),
    candidateCreatedAt: nullableString(source.candidateCreatedAt),
    deleteOldSourceAfterApproval: source.deleteOldSourceAfterApproval === true,
    approvedAt: nullableString(source.approvedAt),
    contextVersioning:
      source.contextVersioning === 'pending'
        || source.contextVersioning === 'completed'
        || source.contextVersioning === 'failed'
        || source.contextVersioning === 'not_started'
        ? source.contextVersioning
        : 'not_started',
    contextVersioningError: nullableString(source.contextVersioningError),
    criteria: {
      components: parseCriteriaState('components', criteriaSource.components),
      rules: parseCriteriaState('rules', criteriaSource.rules),
    },
  };
}

async function readError(response: Response, fallback: string): Promise<DesignSystemFigmaUpdateError> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isObject(payload)) return { message: fallback };
  const nested = isObject(payload.error) ? payload.error : payload;
  const staleCriteria = Array.isArray(nested.staleCriteria)
    ? nested.staleCriteria.filter((item): item is DesignSystemCriteriaKind => CRITERIA_KINDS.includes(item as DesignSystemCriteriaKind))
    : undefined;
  return {
    message:
      typeof nested.message === 'string'
        ? nested.message
        : typeof payload.error === 'string'
          ? payload.error
          : fallback,
    ...(typeof nested.code === 'string' ? { code: nested.code } : {}),
    ...(staleCriteria && staleCriteria.length > 0 ? { staleCriteria } : {}),
  };
}

export async function fetchDesignSystemFigmaUpdateState(
  id: string,
): Promise<DesignSystemFigmaUpdateResult<DesignSystemFigmaUpdateState>> {
  try {
    const response = await fetch(`/api/design-systems/${encodeURIComponent(id)}/update-state`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response, `Không đọc được trạng thái cập nhật (${response.status}).`) };
    }
    return { ok: true, value: parseDesignSystemFigmaUpdateState(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không đọc được trạng thái cập nhật.' },
    };
  }
}

export async function uploadDesignSystemFigmaUpdate(
  id: string,
  files: File[],
  deleteOldSourceAfterApproval: boolean,
): Promise<DesignSystemFigmaUpdateResult<DesignSystemFigmaUpdateState>> {
  try {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    if (deleteOldSourceAfterApproval) form.append('deleteOldSourceAfterApproval', 'true');
    const response = await fetch(`/api/design-systems/${encodeURIComponent(id)}/figma-update`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response, `Không cập nhật được bộ Figma (${response.status}).`) };
    }
    return { ok: true, value: parseDesignSystemFigmaUpdateState(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không cập nhật được bộ Figma.' },
    };
  }
}

export async function approveDesignSystemCriteriaDraft(
  id: string,
  kind: DesignSystemCriteriaKind,
): Promise<DesignSystemFigmaUpdateResult<DesignSystemFigmaUpdateState>> {
  try {
    const response = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/criteria/${kind}/approve`,
      { method: 'POST' },
    );
    if (!response.ok) {
      return { ok: false, error: await readError(response, `Không duyệt được bản mới (${response.status}).`) };
    }
    return { ok: true, value: parseDesignSystemFigmaUpdateState(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không duyệt được bản mới.' },
    };
  }
}

export async function discardDesignSystemCriteriaDraft(
  id: string,
  kind: DesignSystemCriteriaKind,
): Promise<DesignSystemFigmaUpdateResult<DesignSystemFigmaUpdateState>> {
  try {
    const response = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/criteria/${kind}/draft`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      return { ok: false, error: await readError(response, `Không bỏ được bản nháp (${response.status}).`) };
    }
    return { ok: true, value: parseDesignSystemFigmaUpdateState(await response.json()) };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không bỏ được bản nháp.' },
    };
  }
}

export async function approveDesignSystemFigmaUpdate(
  id: string,
  confirmStaleCriteria: boolean,
): Promise<DesignSystemFigmaUpdateResult<ApproveFigmaDesignSystemUpdateResponse>> {
  try {
    const response = await fetch(`/api/design-systems/${encodeURIComponent(id)}/figma-update/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmStaleCriteria }),
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response, `Không duyệt được Design System (${response.status}).`) };
    }
    const payload = (await response.json()) as unknown;
    const source = isObject(payload) ? payload : {};
    const contextUpdates: ApproveFigmaDesignSystemUpdateResponse['contextUpdates'] = Array.isArray(source.contextUpdates)
      ? source.contextUpdates.flatMap((item) => {
          if (!isObject(item) || typeof item.appId !== 'string') return [];
          const status: DesignSystemContextUpdate['status'] = item.status === 'created' || item.status === 'unchanged' || item.status === 'failed'
            ? item.status
            : 'failed';
          return [{
            appId: item.appId,
            status,
            contextVersion: typeof item.contextVersion === 'string' ? item.contextVersion : null,
            ...(typeof item.error === 'string' ? { error: item.error } : {}),
          }];
        })
      : [];
    const staleCriteriaAccepted = Array.isArray(source.staleCriteriaAccepted)
      ? source.staleCriteriaAccepted.filter(
          (item): item is DesignSystemCriteriaKind => CRITERIA_KINDS.includes(item as DesignSystemCriteriaKind),
        )
      : [];
    return {
      ok: true,
      value: {
        state: parseDesignSystemFigmaUpdateState(payload),
        contextUpdates,
        staleCriteriaAccepted,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Không duyệt được Design System.' },
    };
  }
}
