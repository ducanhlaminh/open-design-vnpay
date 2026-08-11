/** Controlled lifecycle for replacing the Figma source of an existing Design System. */
export type DesignSystemUpdateLifecycle =
  | 'drafting'
  | 'criteria_pending'
  | 'ready_for_review'
  | 'approved';

export type DesignSystemCriteriaKind = 'components' | 'rules';
export type DesignSystemCriteriaStatus = 'missing' | 'current' | 'stale' | 'draft';

export interface DesignSystemCriteriaVersionState {
  kind: DesignSystemCriteriaKind;
  status: DesignSystemCriteriaStatus;
  hasApprovedFile: boolean;
  hasDraft: boolean;
  approvedContent: string | null;
  draftContent: string | null;
  count: number;
  generatedFromVersion: number | null;
  generatedFromFigmaDigest: string | null;
  generatedAt: string | null;
}

export interface DesignSystemFigmaUpdateState {
  schemaVersion: 1;
  designSystemId: string;
  lifecycle: DesignSystemUpdateLifecycle;
  currentVersion: number;
  currentFigmaDigest: string | null;
  candidateVersion: number | null;
  candidateFigmaDigest: string | null;
  candidateCreatedAt: string | null;
  deleteOldSourceAfterApproval: boolean;
  approvedAt: string | null;
  contextVersioning: 'not_started' | 'pending' | 'completed' | 'failed';
  contextVersioningError: string | null;
  criteria: Record<DesignSystemCriteriaKind, DesignSystemCriteriaVersionState>;
}

/** Multipart fields for POST /api/design-systems/:id/figma-update. */
export interface UpdateFigmaDesignSystemFields {
  /** Delete the archived vN Figma source only after candidate vN+1 is promoted. */
  deleteOldSourceAfterApproval?: boolean;
}

export interface UpdateFigmaDesignSystemResponse {
  state: DesignSystemFigmaUpdateState;
  warnings: string[];
  summary: import('./registry.js').ImportFigmaDesignSystemSummary;
}

export interface ApproveDesignSystemCriteriaResponse {
  state: DesignSystemFigmaUpdateState;
  approved: DesignSystemCriteriaKind;
}

export interface ApproveFigmaDesignSystemUpdateRequest {
  /** Required when one or both criteria files are still stale/missing. */
  confirmStaleCriteria?: boolean;
}

export interface ApproveFigmaDesignSystemUpdateResponse {
  state: DesignSystemFigmaUpdateState;
  staleCriteriaAccepted: DesignSystemCriteriaKind[];
  contextUpdates: Array<{
    appId: string;
    status: 'created' | 'unchanged' | 'failed';
    contextVersion: string | null;
    error?: string;
  }>;
}

/** Stable examples used by the web app and route tests while wiring this API. */
export const designSystemUpdateContractFixtures = {
  criteriaPending: {
    schemaVersion: 1,
    designSystemId: 'user:payments',
    lifecycle: 'criteria_pending',
    currentVersion: 1,
    currentFigmaDigest: 'sha256:old',
    candidateVersion: 2,
    candidateFigmaDigest: 'sha256:new',
    candidateCreatedAt: '2026-01-02T03:04:05.000Z',
    deleteOldSourceAfterApproval: false,
    approvedAt: null,
    contextVersioning: 'not_started',
    contextVersioningError: null,
    criteria: {
      components: {
        kind: 'components', status: 'stale', hasApprovedFile: true, hasDraft: false,
        approvedContent: '# Components\n', draftContent: null, count: 1,
        generatedFromVersion: 1, generatedFromFigmaDigest: 'sha256:old', generatedAt: null,
      },
      rules: {
        kind: 'rules', status: 'stale', hasApprovedFile: true, hasDraft: false,
        approvedContent: '# Rules\n', draftContent: null, count: 1,
        generatedFromVersion: 1, generatedFromFigmaDigest: 'sha256:old', generatedAt: null,
      },
    },
  },
} as const satisfies { criteriaPending: DesignSystemFigmaUpdateState };
