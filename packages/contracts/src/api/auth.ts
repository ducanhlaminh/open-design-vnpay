export type AuthSyncIssue =
  | 'identity_not_configured'
  | 'identity_unavailable'
  | 'identity_user_unresolved';

/** Identity state shared by the web UI, daemon HTTP surface, and CLI. */
export interface AuthSyncState {
  syncReady: boolean;
  /** Canonical preview-identity UUID. Never contains a provider-prefixed id. */
  identityUserId: string | null;
  syncIssue: AuthSyncIssue | null;
}

export interface AuthSessionUserDto {
  /** Google subject retained only as login provenance, never used as an identity id. */
  googleSubject: string;
  email: string;
  name: string;
  picture?: string;
  provider: 'google';
  roles: string[];
}

export interface AuthMeResponse extends AuthSyncState {
  user: AuthSessionUserDto;
}
