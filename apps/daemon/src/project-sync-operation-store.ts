import { randomUUID } from 'node:crypto';

import type {
  ProjectSyncApplyResult,
  ProjectSyncOperation,
  ProjectSyncOperationError,
  ProjectSyncOperationPhase,
} from '@open-design/contracts';

export const PROJECT_SYNC_OPERATION_TTL_MS = 10 * 60_000;

const PHASE_INDEX: Record<ProjectSyncOperationPhase, number> = {
  validating: 0,
  transferring: 1,
  finalizing: 2,
};

interface StoredProjectSyncOperation {
  operation: ProjectSyncOperation;
  expiresAtMs: number;
}

export interface CreateProjectSyncOperationInput {
  planId: string;
  /** Fixed for the lifetime of the operation. */
  totalItems: number;
}

export interface UpdateProjectSyncOperationInput {
  phase: ProjectSyncOperationPhase;
  completedItems: number;
  currentPath?: string | null;
  currentFeatureId?: string | null;
}

export class ProjectSyncOperationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectSyncOperationTransitionError';
  }
}

function requireCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function percentOf(completedItems: number, totalItems: number): number {
  return totalItems === 0 ? 100 : Math.floor((completedItems / totalItems) * 100);
}

function cloneResult(result: ProjectSyncApplyResult): ProjectSyncApplyResult {
  return {
    ...result,
    softHiddenOriginFeatureIds: [...result.softHiddenOriginFeatureIds],
    stale: result.stale.map((item) => ({ ...item })),
  };
}

function cloneOperation(operation: ProjectSyncOperation): ProjectSyncOperation {
  return {
    ...operation,
    progress: { ...operation.progress },
    ...(operation.result ? { result: cloneResult(operation.result) } : {}),
    ...(operation.error ? { error: { ...operation.error } } : {}),
  };
}

/** In-process progress store. Operations are immutable once terminal so repeat
 * polling (and duplicate completion callbacks) observes the same result. */
export class ProjectSyncOperationStore {
  private readonly operations = new Map<string, StoredProjectSyncOperation>();

  constructor(
    private readonly ttlMs = PROJECT_SYNC_OPERATION_TTL_MS,
    private readonly now = Date.now,
    private readonly createId = () => `project_sync_operation_${randomUUID()}`,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive safe integer');
  }

  create(input: CreateProjectSyncOperationInput): ProjectSyncOperation {
    this.sweep();
    if (!input.planId) throw new TypeError('planId must not be empty');
    const totalItems = requireCount('totalItems', input.totalItems);
    const operationId = this.createId();
    if (!operationId || this.operations.has(operationId)) throw new Error(`Duplicate project sync operation id: ${operationId}`);
    const nowMs = this.now();
    const expiresAtMs = nowMs + this.ttlMs;
    const operation: ProjectSyncOperation = {
      operationId,
      planId: input.planId,
      state: 'queued',
      phase: 'validating',
      progress: { completedItems: 0, totalItems, percent: percentOf(0, totalItems) },
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.operations.set(operationId, { operation, expiresAtMs });
    return cloneOperation(operation);
  }

  get(operationId: string): ProjectSyncOperation | null {
    this.sweep();
    const stored = this.operations.get(operationId);
    return stored ? cloneOperation(stored.operation) : null;
  }

  update(operationId: string, input: UpdateProjectSyncOperationInput): ProjectSyncOperation | null {
    this.sweep();
    const stored = this.operations.get(operationId);
    if (!stored) return null;
    const current = stored.operation;
    if (current.state === 'succeeded' || current.state === 'failed') return cloneOperation(current);
    const completedItems = requireCount('completedItems', input.completedItems);
    if (completedItems < current.progress.completedItems) {
      throw new ProjectSyncOperationTransitionError('completedItems cannot decrease');
    }
    if (completedItems > current.progress.totalItems) {
      throw new ProjectSyncOperationTransitionError('completedItems cannot exceed totalItems');
    }
    if (PHASE_INDEX[input.phase] < PHASE_INDEX[current.phase]) {
      throw new ProjectSyncOperationTransitionError('operation phase cannot move backwards');
    }
    const progress = {
      completedItems,
      totalItems: current.progress.totalItems,
      percent: percentOf(completedItems, current.progress.totalItems),
      ...(input.currentPath !== undefined ? { currentPath: input.currentPath } : {}),
      ...(input.currentFeatureId !== undefined ? { currentFeatureId: input.currentFeatureId } : {}),
    };
    return this.replace(stored, { ...current, state: 'running', phase: input.phase, progress });
  }

  succeed(operationId: string, result: ProjectSyncApplyResult): ProjectSyncOperation | null {
    this.sweep();
    const stored = this.operations.get(operationId);
    if (!stored) return null;
    if (stored.operation.state === 'succeeded' || stored.operation.state === 'failed') return cloneOperation(stored.operation);
    if (result.planId !== stored.operation.planId) {
      throw new ProjectSyncOperationTransitionError('result planId must match the operation planId');
    }
    const current = stored.operation;
    return this.replace(stored, {
      ...current,
      state: 'succeeded',
      phase: 'finalizing',
      progress: {
        completedItems: current.progress.totalItems,
        totalItems: current.progress.totalItems,
        percent: 100,
      },
      result: cloneResult(result),
    });
  }

  fail(operationId: string, error: ProjectSyncOperationError): ProjectSyncOperation | null {
    this.sweep();
    const stored = this.operations.get(operationId);
    if (!stored) return null;
    if (stored.operation.state === 'succeeded' || stored.operation.state === 'failed') return cloneOperation(stored.operation);
    return this.replace(stored, { ...stored.operation, state: 'failed', error: { ...error } });
  }

  private replace(stored: StoredProjectSyncOperation, operation: ProjectSyncOperation): ProjectSyncOperation {
    const nowMs = this.now();
    const expiresAtMs = nowMs + this.ttlMs;
    stored.expiresAtMs = expiresAtMs;
    stored.operation = {
      ...operation,
      updatedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    return cloneOperation(stored.operation);
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const [operationId, stored] of this.operations) {
      if (stored.expiresAtMs <= nowMs) this.operations.delete(operationId);
    }
  }
}
