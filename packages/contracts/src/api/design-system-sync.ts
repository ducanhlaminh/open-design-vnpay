/** Public contracts for sharing approved Figma Design Systems through media-service. */

export type DesignSystemSyncDigest = `sha256:${string}`;
export type DesignSystemSyncVersion = `v${number}`;

export interface DesignSystemOwner {
  id: string;
  email?: string;
  name?: string;
}

export interface DesignSystemUsage {
  kind: 'app' | 'feature';
  appId: string;
  appName?: string;
  featureId?: string;
  featureName?: string;
  contextVersion?: `v${number}`;
  contextDigest?: DesignSystemSyncDigest;
}

export interface DesignSystemPackageFile {
  path: string;
  digest: DesignSystemSyncDigest;
  size: number;
  mime: string;
}

export interface DesignSystemCriteriaSnapshot {
  status: 'current' | 'missing';
  generatedFromVersion: number | null;
  digest: DesignSystemSyncDigest | null;
}

export interface DesignSystemVersionManifest {
  schemaVersion: 1;
  kind: 'design-system-version';
  remoteDesignSystemId: string;
  name: string;
  version: DesignSystemSyncVersion;
  /** Version approved by the controlled local Figma-update lifecycle. */
  sourceVersion: number;
  contentDigest: DesignSystemSyncDigest;
  figmaDigest: DesignSystemSyncDigest | null;
  publishedAt: string;
  owner: DesignSystemOwner;
  criteria: {
    components: DesignSystemCriteriaSnapshot;
    rules: DesignSystemCriteriaSnapshot;
  };
  usage: DesignSystemUsage[];
  files: DesignSystemPackageFile[];
}

export interface DesignSystemCurrentPointer {
  schemaVersion: 1;
  remoteDesignSystemId: string;
  version: DesignSystemSyncVersion;
  contentDigest: DesignSystemSyncDigest;
  updatedAt: string;
}

export interface RemoteDesignSystemSummary {
  schemaVersion: 1;
  remoteDesignSystemId: string;
  name: string;
  owner: DesignSystemOwner;
  currentVersion: DesignSystemSyncVersion;
  currentDigest: DesignSystemSyncDigest;
  updatedAt: string;
  versions: DesignSystemSyncVersion[];
  usage: DesignSystemUsage[];
  visibility: 'workspace';
}

export interface DesignSystemFileChange {
  path: string;
  operation: 'add' | 'edit' | 'delete';
  localDigest?: DesignSystemSyncDigest;
  remoteDigest?: DesignSystemSyncDigest;
}

export interface DesignSystemSyncStatus {
  localDesignSystemId: string;
  remoteDesignSystemId: string | null;
  localVersion: number;
  localDigest: DesignSystemSyncDigest;
  remote: RemoteDesignSystemSummary | null;
  changes: DesignSystemFileChange[];
  historicalVersions: DesignSystemSyncVersion[];
  canPush: boolean;
  blockReason?: 'update_in_progress' | 'criteria_draft' | 'criteria_stale' | 'not_approved';
}

export interface PublishDesignSystemRequest {
  expectedRemoteDigest?: DesignSystemSyncDigest | null;
}

export type PublishDesignSystemResult =
  | { status: 'published'; summary: RemoteDesignSystemSummary; manifest: DesignSystemVersionManifest; uploadedVersions: DesignSystemSyncVersion[] }
  | { status: 'unchanged'; summary: RemoteDesignSystemSummary; manifest: DesignSystemVersionManifest }
  | { status: 'blocked'; localDesignSystemId: string; reason: NonNullable<DesignSystemSyncStatus['blockReason']>; message: string }
  | { status: 'conflict'; localDesignSystemId: string; remoteDesignSystemId: string; localDigest: DesignSystemSyncDigest; remoteDigest: DesignSystemSyncDigest }
  | { status: 'auth_required'; code: 'SYNC_IDENTITY_REQUIRED'; message: string }
  | { status: 'error'; message: string };

export interface PullDesignSystemPlanRequest {
  remoteDesignSystemId: string;
  version?: DesignSystemSyncVersion;
  localDesignSystemId?: string;
}

export interface PullDesignSystemPlan {
  remote: RemoteDesignSystemSummary;
  manifest: DesignSystemVersionManifest;
  localDesignSystemId: string;
  localExists: boolean;
  localDigest: DesignSystemSyncDigest | null;
  changes: DesignSystemFileChange[];
  conflict: boolean;
}

export interface PullDesignSystemRequest extends PullDesignSystemPlanRequest {
  expectedLocalDigest?: DesignSystemSyncDigest | null;
  resolution?: 'use_remote' | 'keep_local';
}

export type PullDesignSystemResult =
  | { status: 'pulled'; localDesignSystemId: string; remoteDesignSystemId: string; manifest: DesignSystemVersionManifest; bindingsChanged: false; contextCreated: false }
  | { status: 'unchanged'; localDesignSystemId: string; remoteDesignSystemId: string; manifest: DesignSystemVersionManifest; bindingsChanged: false; contextCreated: false }
  | { status: 'kept_local'; localDesignSystemId: string; remoteDesignSystemId: string; bindingsChanged: false; contextCreated: false }
  | { status: 'conflict'; plan: PullDesignSystemPlan }
  | { status: 'auth_required'; code: 'SYNC_IDENTITY_REQUIRED'; message: string }
  | { status: 'not_found'; remoteDesignSystemId: string }
  | { status: 'error'; message: string };

export interface ListRemoteDesignSystemsResponse {
  items: RemoteDesignSystemSummary[];
  total: number;
}

export const designSystemSyncContractFixtures = {
  remote: {
    schemaVersion: 1,
    remoteDesignSystemId: 'payments-ds',
    name: 'Payments Design System',
    owner: { id: '00000000-0000-4000-8000-000000000001', name: 'Designer' },
    currentVersion: 'v2',
    currentDigest: 'sha256:bbbb',
    updatedAt: '2026-08-10T09:00:00.000Z',
    versions: ['v1', 'v2'],
    usage: [],
    visibility: 'workspace',
  },
} as const satisfies { remote: RemoteDesignSystemSummary };
