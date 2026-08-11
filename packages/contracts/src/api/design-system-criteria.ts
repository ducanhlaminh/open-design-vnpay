import type { DesignSystemCriteriaKind, DesignSystemCriteriaStatus } from './design-system-update.js';

/** The two review documents generated from a Design System. */
export type CriteriaGenerationKind = DesignSystemCriteriaKind;

export type CriteriaGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type CriteriaGenerationStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface CriteriaGenerationJobStep {
  id: string;
  title: string;
  status: CriteriaGenerationStepStatus;
  message?: string;
}

/** Stable destination the web app can open immediately after starting a job. */
export interface CriteriaGenerationWorkspace {
  projectId: string;
  conversationId: string;
  runId: string;
}

export interface CriteriaGenerationJob {
  id: string;
  designSystemId: string;
  kind: CriteriaGenerationKind;
  status: CriteriaGenerationJobStatus;
  message: string;
  error: string | null;
  steps: CriteriaGenerationJobStep[];
  createdAt: string;
  updatedAt: string;
  workspace: CriteriaGenerationWorkspace;
  notes: string[];
}

export interface CriteriaDocumentSnapshot {
  content: string;
  updatedAt: string;
  count: number;
  status: Extract<DesignSystemCriteriaStatus, 'current' | 'stale' | 'draft'>;
}

export interface CriteriaGenerationDocumentResponse {
  kind: CriteriaGenerationKind;
  current: CriteriaDocumentSnapshot | null;
  draft: CriteriaDocumentSnapshot | null;
  job: CriteriaGenerationJob | null;
}

export interface CriteriaGenerationStartResponse {
  job: CriteriaGenerationJob;
  /** True when the daemon returned the already-running job instead of spawning another run. */
  reused: boolean;
}

