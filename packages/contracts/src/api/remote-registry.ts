import type { AppContextManifest, FeatureContextBinding } from './app-context-version.js';

export type ProjectVisibility = 'visible' | 'hidden';

/** Studio-owned lifecycle metadata stored alongside, but independently from,
 *  the Open Design-owned project.json artifact. */
export interface ProjectLifecycle {
  schemaVersion: 1;
  projectId: string;
  visibility: ProjectVisibility;
  hiddenAt?: string;
  hiddenBy?: string;
  reason?: string;
}

// Remote registry DTOs — list + delete projects that live on the remote store.
//
// "Remote" is the media-service file store (one folder per project). The
// registry enumerates it so the user can see — and prune — what's on the
// server, independent of what's local. (Prior to the KGS removal this also
// merged a separate graph store; that half is gone — see docs/guides/
// media-file-sync-design.md.)
//
// Phase 1 supports deleting FILES only (media folder). `graph`/`all` scopes
// are reserved but unimplemented — there is no separate graph store anymore.

export interface RemoteProject {
  projectId: string;
  /** Display name; falls back to the projectId. */
  name: string;
  /** A media-service folder for this projectId exists. */
  inMedia: boolean;
  /** File count in the media folder (0 when inMedia is false). */
  files: number;
  /** True when projectId is an App container (media folder `app--<slug>`,
   *  per pipeline-studio's server/apps.ts) — not a pipeline target itself,
   *  just a grouping + shared UX-charter layer above features. */
  isApp: boolean;
  /** The parent App's projectId, read from this feature's project.json
   *  (apps/daemon/src/app-context.ts resolveAppId). Undefined/null when
   *  ungrouped, or when this entry is itself an App. */
  appId?: string | null;
  /** Missing on older callers/fixtures; remote readers normalize it to
   *  `visible`. A hidden App also hides its child Features from Pull. */
  visibility?: ProjectVisibility;
  hiddenAt?: string;
}

/** Product-facing project summary returned by `/api/kg/remote-projects`. */
export interface RemoteProjectSummary extends RemoteProject {
  displayName: string;
  appName?: string | null;
  ownerName?: string | null;
  lastPublishedAt?: string | null;
  version?: string | null;
  availableOutputs: string[];
  alreadyOnThisDevice: boolean;
  accessRole: 'owner' | 'editor' | 'viewer' | 'admin';
  /** Present for App rows published with App Context schema v1. */
  appContext?: {
    current: AppContextManifest;
    localCurrentDigest?: `sha256:${string}` | null;
  };
  /** Published immutable context selected by a Feature. */
  appContextBinding?: FeatureContextBinding;
}

/** What a remote delete removes. Phase 1 implements `files` only. */
export type RemoteDeleteScope = 'files' | 'graph' | 'all';

export interface RemoteDeleteResult {
  projectId: string;
  scope: RemoteDeleteScope;
  /** Number of media files removed. */
  filesDeleted: number;
  /** Whether a media folder existed and was removed. */
  folderRemoved: boolean;
}

export interface RemoteProjectsResponse {
  ok: boolean;
  data: RemoteProjectSummary[];
}

export interface RemoteDeleteResponse {
  ok: boolean;
  data: RemoteDeleteResult;
}
