import type { AppContextManifest, FeatureContextBinding } from './app-context-version.js';

// Remote registry DTOs — list + delete projects that live on the remote stores.
//
// "Remote" is two independent kewords: the KGS graph (DP_UI_WORKSPACE + nodes)
// and the media-service file store (one folder per project). A project can exist
// in one, the other, or both. The registry merges them by projectId so the user
// can see — and prune — what's on the server, independent of what's local.
//
// Phase 1 supports deleting FILES only (media folder). Graph deletion (`graph`/
// `all`) is reserved but not yet implemented in the daemon — see
// docs/guides/media-file-sync-design.md §5 and the KgsClient (no delete method).

export interface RemoteProject {
  projectId: string;
  /** KGS workspace name when present, else the projectId. */
  name: string;
  /** A DP_UI_WORKSPACE for this projectId exists in KGS. */
  inKgs: boolean;
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
