/** Immutable, content-addressed App Context contracts shared by Open Design and Pipeline Studio. */

export type AppContextFileSource = 'app-context' | 'docs' | 'design-system';

export interface AppContextFileDigest {
  /** Path inside the immutable version package, always using `/`. */
  path: string;
  source: AppContextFileSource;
  digest: `sha256:${string}`;
  size: number;
}

export interface AppContextManifest {
  schemaVersion: 1;
  appId: string;
  appName: string;
  /** Monotonic display version. The digest, not this label, is the identity. */
  contextVersion: `v${number}`;
  contentDigest: `sha256:${string}`;
  createdAt: string;
  previousVersion?: `v${number}`;
  designSystem: {
    id: string | null;
    contentDigest: `sha256:${string}` | null;
  };
  files: AppContextFileDigest[];
}

export interface AppContextCurrentPointer {
  schemaVersion: 1;
  appId: string;
  contextVersion: `v${number}`;
  contentDigest: `sha256:${string}`;
  updatedAt: string;
}

/** The immutable context version a Feature deliberately chose. */
export interface FeatureContextBinding {
  schemaVersion: 1;
  appId: string;
  contextVersion: `v${number}`;
  contentDigest: `sha256:${string}`;
  boundAt: string;
}

/** Frozen into a run cwd before execution so a historical result is reproducible. */
export interface RunContextLock extends FeatureContextBinding {
  featureId: string;
  runId: string;
  workflowId?: string;
  lockedAt: string;
  manifestPath: string;
}

export interface AppContextVersionSummary {
  appId: string;
  appName: string;
  current: AppContextManifest | null;
  versions: AppContextManifest[];
}

export interface CreateAppContextVersionRequest {
  /** Optional optimistic guard used by UI/CLI conflict handling. */
  expectedCurrentDigest?: `sha256:${string}` | null;
}

export type CreateAppContextVersionResult =
  | { status: 'created'; manifest: AppContextManifest }
  | { status: 'unchanged'; manifest: AppContextManifest };

export interface BindFeatureContextRequest {
  appId: string;
  contextVersion: `v${number}`;
  contentDigest: `sha256:${string}`;
}

export interface BindFeatureContextResult {
  featureId: string;
  binding: FeatureContextBinding;
}

export interface PublishAppContextRequest {
  appId: string;
  contextVersion?: `v${number}`;
}

export type PublishAppContextResult =
  | { status: 'published'; appId: string; manifest: AppContextManifest }
  | { status: 'pending_approval'; appId: string; requestId: string; manifest: AppContextManifest }
  | { status: 'rejected'; appId: string; requestId: string; reason: string }
  | { status: 'auth_required'; appId: string; code: 'SYNC_IDENTITY_REQUIRED'; message: string }
  | { status: 'error'; appId: string; message: string };

export interface PullAppContextRequest {
  appId: string;
  contextVersion?: `v${number}`;
  /** Pull downloads a version; it never upgrades Feature bindings implicitly. */
  expectedLocalDigest?: `sha256:${string}` | null;
}

export type PullAppContextResult =
  | { status: 'pulled'; appId: string; manifest: AppContextManifest; bindingChanged: false }
  | { status: 'unchanged'; appId: string; manifest: AppContextManifest; bindingChanged: false }
  | { status: 'conflict'; appId: string; localDigest: string; remoteDigest: string; bindingChanged: false }
  | { status: 'not_found'; appId: string }
  | { status: 'error'; appId: string; message: string };

/** App-only approval ticket. Feature staging tickets stay backward compatible. */
export interface AppContextStagingRequest {
  schema: 3;
  subject: 'app-context';
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  submitter: { id: string; email?: string; name?: string };
  app: {
    localId: string;
    desiredId: string;
    displayName: string;
    designSystemId: string | null;
  };
  context: {
    contextVersion: `v${number}`;
    contentDigest: `sha256:${string}`;
    files: number;
  };
  history: Array<{ at: string; event: string; note?: string }>;
}
