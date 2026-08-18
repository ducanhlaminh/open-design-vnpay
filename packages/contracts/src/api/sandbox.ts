// Agent-in-sandbox status surface (`GET /api/sandbox/status`). The sandbox
// spawns gated agent runs inside a throwaway Docker container; this DTO is the
// shared shape the web Settings card and `od sandbox status` both read.
// Enable/disable persists through the existing app-config surface
// (`PUT /api/app-config` with a `sandbox` section), not a dedicated endpoint.

export type SandboxRuntimeId = 'claude' | 'codex';

export type SandboxRuntimeAuthStatus = 'logged-in' | 'missing' | 'unknown';

export type SandboxRuntimeLoginMethod = 'interactive' | 'device' | 'unknown';

export interface SandboxRuntimeStatus {
  /** Stable runtime id. */
  id: SandboxRuntimeId;
  /** CLI version reported from inside the sandbox image, when probeable. */
  version: string | null;
  /** The sandbox image exists locally. */
  imageAvailable: boolean;
  /** Runtime-specific auth volume name (e.g. `od-claude-auth`). */
  authVolume: string;
  /** Auth volume exists locally. */
  authVolumeAvailable: boolean;
  /** Whether the auth surface is logged in, missing, or not yet probed. */
  authStatus: SandboxRuntimeAuthStatus;
  /** How this runtime authenticates inside the sandbox. */
  loginMethod: SandboxRuntimeLoginMethod;
}

/**
 * Effective execution mode, derived from `enabled` (`resolveSandboxConfig` /
 * `OD_SANDBOX`): `'host'` = every run spawns as a host CLI process (default
 * since the web-first migration); `'sandbox'` = the Docker sandbox owns gated
 * runs. Kept as its own field (rather than making every consumer re-derive it
 * from `enabled`) so web/CLI surfaces branch on one canonical value.
 */
export type SandboxMode = 'host' | 'sandbox';

/** Host Claude CLI snapshot, always populated regardless of `mode` — cheap
 *  (file/Keychain probe, no Docker) so the web Settings execution-mode toggle
 *  can preview host readiness even while sandbox mode is active. */
export interface SandboxHostClaudeStatus {
  /** The `claude` binary resolves on PATH. */
  available: boolean;
  version?: string | null;
  authStatus: 'ok' | 'missing' | 'unknown';
  /** Human (Vietnamese) guidance when not `'ok'` — from `probeClaudeAuthStatus`. */
  authMessage?: string;
  /** Best-effort logged-in account identity (email from `~/.claude.json`). */
  account?: { email?: string };
}

/** Host Codex CLI snapshot — same shape/semantics as `SandboxHostClaudeStatus`
 *  (PATH resolution + `~/.codex/auth.json` probe, no Docker), so the host-mode
 *  Codex card can show installed / needs-login / ready + the account email. */
export type SandboxHostCodexStatus = SandboxHostClaudeStatus;

/** `POST /api/sandbox/host/claude/logout` — clears the HOST Claude CLI login
 *  (credentials file + macOS Keychain item). Env-routed auth (API key /
 *  Bedrock / Vertex) has nothing to clear and answers 409 instead. */
export interface HostClaudeLogoutResponse {
  ok: true;
  /** Fresh snapshot after the logout, so the UI updates without a re-poll. */
  hostClaude: SandboxHostClaudeStatus;
}

export interface SandboxStatusResponse {
  /** Effective enabled flag (prefs + OD_SANDBOX env override). */
  enabled: boolean;
  /** Same information as `enabled`, spelled as the mode web/CLI branch on. */
  mode: SandboxMode;
  /** Agent runtime ids gated into the sandbox (default ['claude']). */
  runtimes: string[];
  /** Skill ids gated into the sandbox (default ['*'] — every run). */
  skills: string[];
  timeoutMinutes: number;
  /**
   * Docker engine reachable. Optional: a future caller/mode may report
   * status without probing Docker at all; existing responses still always
   * populate it today.
   */
  dockerOk?: boolean;
  /** Expected image tag (od-agent-sandbox:<sandbox.version>). */
  image: string;
  /** Expected image tag present locally. Optional, see `dockerOk`. */
  imageOk?: boolean;
  /** Claude CLI version pinned in the image recipe (sandbox/claude.version). */
  claudeVersion: string | null;
  /** Shared auth volume exists. Optional, see `dockerOk`. */
  authVolumeOk?: boolean;
  /**
   * Auth volume holds Claude credentials. Probed with a short-lived
   * container, so only when docker + image are available; null = not probed.
   */
  authLoggedIn: boolean | null;
  /** Per-runtime availability/auth status used by the CLI and agent fallback. */
  runtimeStatuses: SandboxRuntimeStatus[];
  /** Names of live od.sandbox containers (active sandboxed runs). */
  activeContainers: string[];
  /**
   * Absolute path of the ui-react builder dir on the daemon machine — where
   * `od sandbox build` / `od sandbox login` find build-sandbox.sh and the
   * version pins.
   */
  builderDir: string;
  /** Host Claude CLI snapshot — see `SandboxHostClaudeStatus`. */
  hostClaude: SandboxHostClaudeStatus;
  /** Host Codex CLI snapshot — see `SandboxHostCodexStatus`. */
  hostCodex: SandboxHostCodexStatus;
}

// ── Claude account switching (Docker-only sandbox) ──────────────────────────
// The sandbox Claude auth is ONE `.credentials.json` in the `od-claude-auth`
// volume. To hold several Claude accounts, each login is snapshotted to
// `accounts/<label>.json` in the same volume; "switch" copies one back over the
// active `.credentials.json`. Labels are filesystem-safe slugs.

/** A regex the label must satisfy (also enforced server-side). Kept
 *  filesystem-safe (no spaces/slashes) since the label IS the stored filename. */
export const SANDBOX_ACCOUNT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * Turn a Claude account email into a label satisfying SANDBOX_ACCOUNT_LABEL_RE,
 * so a login can be saved without asking the user to invent a name.
 *
 * The label becomes a FILENAME that the daemon interpolates into a shell
 * command, so this must never widen what the regex allows: everything outside
 * `[A-Za-z0-9_-]` collapses to `-`, and the caller still validates the result.
 * Returns null when nothing usable survives (e.g. an all-symbol local part) —
 * callers then fall back to asking the user.
 */
export function sandboxAccountLabelFromEmail(email: string): string | null {
  const localPart = String(email || '').split('@')[0] ?? '';
  const slug = localPart
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  // The regex additionally demands an alphanumeric FIRST character.
  const label = slug.replace(/^[^A-Za-z0-9]+/, '');
  return label && SANDBOX_ACCOUNT_LABEL_RE.test(label) ? label : null;
}

/** Who a saved login belongs to, read from the volume's `.claude.json`. */
export interface SandboxAccountIdentity {
  /** Stable per-account id — the dedup key, since tokens change every login. */
  accountUuid: string;
  emailAddress: string;
  /** e.g. "claude_max" — shown next to the account so plans are tellable apart. */
  organizationType?: string | null;
}

export interface SandboxAccount {
  /** Label, e.g. "Personal" / "Work"; auto-derived from the email when saved
   *  automatically on login. */
  label: string;
  /** True when this account's saved credentials match the active ones. */
  active: boolean;
  /** Identity recorded when the account was saved; absent for accounts saved
   *  before auto-save existed (label-only). */
  identity?: SandboxAccountIdentity | null;
  /** True when this entry was added automatically on login detection. */
  auto?: boolean;
}

export interface SandboxAccountsResponse {
  /** The sandbox owns Claude (Docker-only) — the switcher only applies then. */
  supported: boolean;
  /** Claude credentials exist at all (someone has logged in). */
  loggedIn: boolean;
  /** A credentials.json is present but matches no saved account (login not saved). */
  activeUnsaved: boolean;
  accounts: SandboxAccount[];
}

/** Save (snapshot the current login) / switch / remove all return the fresh list. */
export type SandboxAccountsMutationResponse = SandboxAccountsResponse;

/** Live health of one saved account — its OAuth token probed against Claude.
 *  A revoked/expired token (e.g. the password was changed) comes back `ok:false`
 *  with a human `error`; the account is flagged red, NOT deleted. */
export interface SandboxAccountStatus {
  label: string;
  ok: boolean;
  /** Short reason when not ok (e.g. "HTTP 401 — token hết hạn / bị thu hồi"). */
  error?: string;
}

export interface SandboxAccountsCheckResponse {
  statuses: SandboxAccountStatus[];
}

/**
 * Adding an account = a fresh Claude OAuth login, which is an INTERACTIVE
 * terminal flow (`claude /login`), so it can't be embedded in the web UI. The
 * daemon best-effort opens a host terminal running the login command; the UI
 * then tells the user to finish there and Save the result under a label.
 */
export interface SandboxLoginLaunchResponse {
  /** A terminal window was opened running the login command. */
  launched: boolean;
  /** The exact command (shown as a copy-paste fallback when launch failed). */
  command: string;
  /** Human note (why it couldn't launch, or the next step). */
  message?: string;
}

// ── Embedded (no-terminal) Claude login ─────────────────────────────────────
// The daemon drives `claude /login` inside the sandbox container through a
// faked TTY: it auto-answers the onboarding prompts, extracts the OAuth URL,
// opens it in the HOST browser, and the web UI collects the pasted code —
// no terminal window involved. One session at a time.

export type SandboxEmbeddedLoginPhase =
  | 'idle' // no session running
  | 'starting' // container spawning / walking the TUI prompts
  | 'awaiting-code' // OAuth URL extracted (browser opened) — waiting for the pasted code
  | 'verifying' // code submitted — waiting for credentials to land in the volume
  | 'done' // credentials present; container cleaned up
  | 'error';

export interface SandboxEmbeddedLoginStatus {
  phase: SandboxEmbeddedLoginPhase;
  /** OAuth URL once extracted (also auto-opened in the host browser). */
  url: string | null;
  /** Human error (also set alongside awaiting-code on a rejected code retry). */
  error: string | null;
}

export type SandboxCodexDeviceLoginPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-user'
  | 'verifying'
  | 'done'
  | 'error';

export interface SandboxCodexDeviceLoginStatus {
  phase: SandboxCodexDeviceLoginPhase;
  /** Device authorization URL shown to the user. */
  url: string | null;
  /** User code shown alongside the authorization URL. */
  code: string | null;
  /** ISO timestamp when the current flow expires. */
  expiresAt: string | null;
  /** Human error when the flow fails or is cancelled. */
  error: string | null;
}

/**
 * Live state of an in-daemon `docker build` of the sandbox image, driven from
 * the Settings "Build image" button (and pollable by the CLI). Builds take
 * minutes, so `POST /api/sandbox/build` starts it and returns immediately; the
 * UI polls `GET /api/sandbox/build` until `building` flips false. Builds the
 * base image first when that's missing too — "build whatever's missing".
 */
export interface SandboxBuildResponse {
  /** A build is currently running. */
  building: boolean;
  /** Result of the LAST finished build: true = image present, false = failed,
   *  null = never run / still building. */
  ok: boolean | null;
  /** Failure reason when the last build failed. */
  error: string | null;
  /** Tail of the docker build output (most-recent lines, capped). */
  log: string[];
}

export type DockerSetupPhase =
  | 'idle'
  | 'installing'
  | 'starting'
  | 'waiting'
  | 'ready'
  | 'error';

/** Machine-level Docker Desktop installation/startup driven by the daemon. */
export interface DockerSetupResponse {
  phase: DockerSetupPhase;
  /** True while an install/start/wait operation is still active. */
  running: boolean;
  /** Whether the Docker engine answered the latest probe. */
  dockerOk: boolean;
  /** Human-readable failure suitable for the onboarding UI. */
  error: string | null;
  /** Tail of installer/startup output for diagnostics. */
  log: string[];
}

export type WindowsFirmwareVendor =
  | 'dell' | 'hp' | 'lenovo-think' | 'lenovo-consumer'
  | 'acer' | 'asus' | 'msi' | 'gigabyte' | 'microsoft' | 'generic';

export interface WindowsFirmwareGuidance {
  vendor: WindowsFirmwareVendor;
  displayName: string;
  biosKeys: string[];
  menuPaths: string[];
  settingNames: string[];
  notes: string[];
  supportUrl?: string;
}

export interface WindowsFirmwareDetection {
  manufacturer: string;
  model: string;
  cpuManufacturer: string;
  virtualizationEnabled: boolean | null;
  virtualizationSupported: boolean | null;
  firmwareType: 'uefi' | 'bios' | 'unknown';
}

export interface WindowsFirmwarePendingState {
  phase: 'awaiting-bios-virtualization';
  manufacturer: string;
  model: string;
  requestedAt: string;
}

export interface WindowsFirmwareStatusResponse {
  supportedPlatform: boolean;
  detection: WindowsFirmwareDetection | null;
  guidance: WindowsFirmwareGuidance | null;
  pending: WindowsFirmwarePendingState | null;
  canRestartToFirmware: boolean;
}

export interface WindowsFirmwareRestartResponse {
  ok: true;
  restartScheduled: true;
  delaySeconds: number;
  pending: WindowsFirmwarePendingState;
}
