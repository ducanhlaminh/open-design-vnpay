# Windows Cold-Machine Docker Setup

## Status and scope

This document is the implementation specification for making a clean Windows
machine ready for Open Design's Docker sandbox through the app UI. It extends
the existing `/api/sandbox/docker/setup` flow; it does not change the sandbox,
runtime-login, or image-build contracts except where readiness orchestration
needs to call them.

The intended user experience is click-only inside Open Design, plus Windows
security surfaces that applications cannot safely bypass:

- the user may have to approve a UAC prompt;
- Windows may have to restart;
- when firmware virtualization is disabled, the user must enable it in
  BIOS/UEFI using model-aware instructions prepared before restart.

The feature targets supported Windows 10/11 x64 machines with hardware
virtualization. macOS behavior remains unchanged. Linux is out of scope.

## Product outcome

On a supported clean Windows machine, the onboarding gate shall lead the user
through this state machine without requiring a terminal:

```text
inspect machine
  -> unsupported hardware / managed-device stop
  -> firmware virtualization disabled
       -> show vendor guidance and safety check
       -> restart directly to UEFI, or show boot-key fallback
       -> resume inspection after Windows starts
  -> enable WSL + VirtualMachinePlatform
       -> restart if required
       -> resume inspection after Windows starts
  -> install Docker Desktop (WinGet or official installer fallback)
  -> start Docker and wait for engine
  -> prepare sandbox image
  -> runtime login
  -> ready
```

"Automatic" never means silently changing firmware, suppressing UAC, disabling
BitLocker, bypassing organization policy, or forcing a restart without explicit
confirmation.

## Architecture and ownership

- `packages/contracts` owns all DTOs and stable enum values described below.
- `apps/daemon` owns machine inspection, elevation, download verification,
  Windows feature changes, persisted setup state, restart requests, Docker
  installation, and redacted diagnostics.
- `apps/web` only presents inspection results, consent, instructions, progress,
  and recovery actions through the daemon API.
- `od sandbox setup` exposes the same capability through the same API. It must
  support `--json`; CLI output may tell a human to complete a UAC/firmware step
  but must not implement a separate setup path.
- The packaged Electron layer may provide an explicit relaunch-at-login hook if
  required. Business state and decisions remain daemon-owned.

No web code may execute PowerShell, inspect CIM/WMI, or construct privileged
commands.

## Machine inspection

Inspection is read-only and runs before any setup mutation. The daemon invokes
PowerShell with a fixed, repository-owned script or encoded command and parses
JSON. It must never interpolate user input into PowerShell.

### Required facts

The normalized result contains:

- Windows edition, build number, architecture, and whether the supported
  Windows baseline is met.
- Computer manufacturer and model from `Win32_ComputerSystem`.
- System SKU when available from `Win32_ComputerSystemProduct`.
- BIOS vendor/version from `Win32_BIOS`.
- CPU manufacturer/name and `SecondLevelAddressTranslationExtensions` from
  `Win32_Processor`.
- `VirtualizationFirmwareEnabled` from every processor. The normalized value is
  `enabled`, `disabled`, `unsupported`, or `unknown`; do not coerce a missing
  CIM value to `false`.
- `HypervisorPresent` from `Win32_ComputerSystem` as supporting evidence, not as
  a substitute for firmware virtualization support.
- Firmware boot mode (`uefi`, `legacy`, or `unknown`). Prefer a supported
  firmware-type API/registry signal and treat failure as `unknown`; Secure Boot
  being disabled does not imply legacy BIOS.
- WSL optional-feature state, VirtualMachinePlatform state, `wsl.exe` presence,
  `wsl --status` outcome, pending-reboot signals, WinGet presence/version,
  installed Docker Desktop version, Docker executable location, and Docker
  engine reachability.
- Device-management indicators when cheaply and reliably available. Detection
  is advisory; an access-denied or policy-blocked mutation is authoritative.

Raw manufacturer/model strings are trimmed, whitespace-normalized, length
capped, and retained for display. Guidance selection uses a lowercase,
punctuation-normalized value. Inspection failure returns `unknown` facts plus a
diagnostic code; it must not incorrectly claim virtualization is disabled.

### Virtualization decision

Use the following precedence:

1. No SLAT or an explicitly unsupported processor: `unsupported-hardware`.
2. Firmware virtualization explicitly false: `firmware-action-required`.
3. Firmware virtualization true: continue to Windows-feature inspection.
4. Conflicting processor results or inaccessible properties: `needs-diagnosis`.

The app must not tell the user to enter firmware on an `unknown` result. Offer
retry and a copyable diagnostic report instead.

## Vendor-aware BIOS/UEFI guidance

Guidance is a versioned data table in daemon-owned source, not prose selected in
React. Matching is manufacturer-first with optional model-family overrides.
Every record has:

```ts
interface FirmwareGuidance {
  vendorId: string;
  manufacturerPatterns: string[];
  modelPatterns?: string[];
  displayVendor: string;
  bootKeys: string[];
  paths: string[][];
  settingNames: string[];
  saveKeys: string[];
  notes: string[];
  supportUrl?: string;
  confidence: 'model' | 'vendor' | 'generic';
}
```

Initial table:

| Vendor/family | Boot key or entry | Common firmware path/settings |
|---|---|---|
| Dell / Alienware | `F2` | `Virtualization Support > Virtualization`; enable Intel Virtualization Technology. `VT for Direct I/O` may also be offered but is not the Docker prerequisite. |
| HP consumer | `Esc`, then `F10` | `Configuration > Virtualization Technology`; on some models `System Configuration`. |
| HP business | `Esc`, then `F10` | `Advanced > System Options > Virtualization Technology (VTx)`; AMD models may say `SVM CPU Virtualization`. |
| Lenovo ThinkPad/ThinkCentre | `F1` (sometimes `Enter`, then `F1`) | `Security > Virtualization`; enable Intel Virtualization Technology or AMD V Technology. |
| Lenovo IdeaPad/consumer | `F2`, `Fn+F2`, or Novo button | `Configuration > Intel Virtual Technology` or `SVM Mode`. |
| Acer | `F2` | `Advanced` or `Main > Intel Virtualization Technology`, `Intel VTX`, or `SVM Mode`. Some models reveal Advanced with a model-specific key sequence; do not prescribe one without a model match. |
| ASUS laptop | `F2` | `Advanced Mode > Advanced > CPU Configuration > Intel (VMX) Virtualization Technology` or `SVM Mode`. |
| ASUS desktop/motherboard | `Del` or `F2` | Same CPU Configuration setting. |
| MSI | `Del` | `OC > CPU Features` or `Advanced > CPU Configuration > SVM Mode/Intel Virtualization Tech`. |
| Gigabyte/AORUS | `Del` | `Tweaker` or `Settings > CPU Settings > SVM Mode/Intel Virtualization Technology`. |
| Microsoft Surface | UEFI volume-up method or Windows UEFI entry | Surface UEFI location varies by generation; show the Microsoft support link and the setting names reported for the matched family. |
| Unknown/OEM/VM | Windows UEFI entry if available; otherwise `F2`, `Del`, `Esc`, `F10`, or vendor documentation | Search for `Virtualization`, `Intel VT-x/VMX`, `AMD-V`, or `SVM Mode`. Mark guidance as generic. |

Paths are explicitly labelled "vị trí thường gặp" because firmware menus vary
within a vendor. The screen shows detected manufacturer, exact model, CPU type,
boot keys, likely menu paths, setting synonyms, Save & Exit action, and the
confidence level. Intel guidance prioritizes `Intel Virtualization
Technology`, `VT-x`, or `VMX`; AMD guidance prioritizes `SVM Mode` or `AMD-V`.

Manufacturer support URLs must be allowlisted HTTPS URLs maintained with the
table. Do not build a web-search URL from unescaped machine strings and do not
claim a model-specific path unless a model rule matched.

## Firmware restart behavior

Before restart, the app presents the full instructions and recommends taking a
phone photo because Open Design will not be visible inside firmware. The user
must explicitly select `Khởi động vào BIOS/UEFI`.

The daemon persists state first, requests elevation, and then attempts the
equivalent of:

```powershell
shutdown.exe /r /fw /t 0
```

This requests the next boot into firmware; it does not enable virtualization.
The API must distinguish:

- accepted and restart initiated;
- access denied/UAC cancelled;
- `/fw` unsupported (including legacy firmware);
- command failed for another reason.

When `/fw` is unsupported, do not restart immediately. Change to
`manual-boot-required`, show the matched boot keys and the sequence "Restart,
press the key repeatedly when the vendor logo appears", and provide a separate
confirmed normal-restart action. This prevents an unexpected reboot that still
misses firmware setup.

## WSL2 and Windows feature setup

After virtualization is enabled, the daemon enables only the prerequisites
required by the chosen Docker backend:

1. Prefer `wsl.exe --install --no-distribution` when supported.
2. Otherwise, from an elevated fixed script, enable
   `Microsoft-Windows-Subsystem-Linux` and `VirtualMachinePlatform` with DISM
   and `/NoRestart`.
3. Do not install an Ubuntu/user distribution; Docker owns its distributions.
4. Record whether each command changed state and whether Windows reports a
   restart requirement.
5. Ask for explicit confirmation before restarting. Never use a forced close
   option and never restart while the setup API still has unpersisted state.

After restart, inspect again rather than trusting the pre-restart command exit
code. Continue only when the required features and virtualization are observed.

## Docker installation without a WinGet dependency

If Docker is not installed:

1. Use WinGet when it is present and operational.
2. Otherwise download the official Docker Desktop installer from a pinned,
   repository-controlled Docker HTTPS endpoint.
3. Verify Authenticode publisher and signature before elevation. The expected
   publisher is pinned; a missing, invalid, or mismatched signature is a hard
   stop. Where Docker publishes a stable checksum through a trusted channel,
   verify that as an additional check.
4. Show Docker's license notice and require explicit acceptance in Open Design.
5. Run the installer elevated with fixed arguments equivalent to `install`,
   `--accept-license`, and `--backend=wsl-2`. Never interpolate remote output or
   user strings into arguments.
6. Delete the temporary installer after completion or terminal failure.
7. Start Docker Desktop and poll engine readiness with a bounded timeout. A
   timeout becomes a recoverable state: retry start, restart if indicated, or
   open diagnostics.

The installer must not be fetched from search results, redirects to an
unallowlisted host, mirrors, or a mutable user-provided URL. Proxy/TLS/policy
failures are shown as actionable errors for IT rather than bypassed.

## Persistence and resume

The existing in-memory Docker setup state is insufficient for reboot steps.
Persist a schema-versioned, atomic JSON state under the daemon's namespace-
scoped runtime data directory. It contains no credentials.

```ts
type WindowsSetupPhase =
  | 'idle'
  | 'inspecting'
  | 'firmware-guidance'
  | 'firmware-restart-requested'
  | 'manual-boot-required'
  | 'enabling-windows-features'
  | 'windows-restart-required'
  | 'installing-docker'
  | 'starting-docker'
  | 'waiting-for-docker'
  | 'preparing-image'
  | 'ready'
  | 'unsupported'
  | 'blocked'
  | 'error';
```

Persist at least schema version, phase, operation id, timestamps, sanitized
inspection snapshot, guidance id/confidence, completed idempotent steps,
restart reason, restart-attempt count, last error code, and recovery action.
Do not persist raw installer output that may contain usernames/paths; maintain
a redacted bounded diagnostic log.

On every daemon start:

1. Load and validate state; quarantine malformed or future-version state and
   fall back to a safe fresh inspection.
2. If a restart was requested, run inspection and compare observed facts.
3. If virtualization/features are now enabled, mark the step complete and
   continue only after the UI or an explicitly persisted `resumeApproved`
   choice reconnects. Do not create a surprise elevation prompt at login.
4. If the expected state did not change, return to the relevant guidance with
   a retry counter and diagnostic help; never enter a restart loop.
5. Treat all mutation steps as idempotent. A second POST while an operation is
   active returns the same operation rather than spawning another installer.

The packaged app should offer `Mở lại Open Design sau khi đăng nhập Windows`
before restart. It may register a per-user, removable one-shot resume entry.
Registration requires consent and must be removed after ready, cancellation,
or a bounded expiry. If not registered, normal manual app launch resumes from
the persisted state.

## BitLocker, UAC, and safety gates

### BitLocker/device encryption

Entering UEFI can trigger a BitLocker recovery challenge on some devices even
when no boot setting is intentionally changed. Before offering firmware
restart, detect protection status for the OS volume using read-only supported
Windows APIs/commands.

- If protection is on, show a blocking acknowledgement: the user should know
  where the recovery key is before continuing.
- Offer only trusted links/actions to Microsoft's recovery-key guidance and
  the organization's IT guidance. Never read, collect, upload, display, or log
  a recovery key.
- Do not automatically suspend BitLocker. Suspending protection is a separate,
  security-sensitive administrator action and is outside this flow.
- If status is unknown, say so and require acknowledgement rather than claiming
  encryption is off.

### UAC and organization policy

- Elevate only the smallest fixed operation when it is needed. The daemon and
  web app should otherwise remain non-elevated.
- Use Windows-native elevation with visible UAC. Cancellation is a normal,
  retryable result, not an installation failure.
- Never request, store, or simulate administrator credentials.
- Policy blocks, non-admin environments, BIOS passwords, managed firmware, and
  disabled installer services result in `blocked` with an IT-ready diagnostic
  report. The app must not weaken policy, Defender, firewall, proxy, Secure
  Boot, or disk encryption to proceed.
- Before every restart, state that open work may be lost and require explicit
  confirmation. The app does not force-close programs.

## Proposed contracts

Contract names may be adjusted to repository conventions, but UI and CLI must
share these semantics.

```ts
interface WindowsMachineInspection {
  platform: 'win32';
  supported: boolean;
  manufacturer: string | null;
  model: string | null;
  systemSku: string | null;
  cpuVendor: 'intel' | 'amd' | 'other' | 'unknown';
  cpuName: string | null;
  slat: boolean | null;
  virtualization: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
  firmwareMode: 'uefi' | 'legacy' | 'unknown';
  hypervisorPresent: boolean | null;
  bitLocker: 'on' | 'off' | 'unknown';
  wsl: 'ready' | 'feature-disabled' | 'missing' | 'restart-required' | 'unknown';
  virtualMachinePlatform: 'enabled' | 'disabled' | 'restart-required' | 'unknown';
  wingetAvailable: boolean;
  dockerInstalled: boolean;
  dockerOk: boolean;
  diagnostics: string[];
}

interface WindowsSetupStatusResponse extends DockerSetupResponse {
  operationId: string | null;
  windowsPhase: WindowsSetupPhase;
  inspection: WindowsMachineInspection | null;
  guidance: FirmwareGuidance | null;
  consentRequired: Array<'docker-license' | 'bitlocker-risk' | 'restart'>;
  restart: null | {
    reason: 'firmware' | 'windows-features' | 'docker';
    method: 'uefi-direct' | 'manual-boot-key' | 'normal';
  };
  recoveryAction: 'retry' | 'open-guidance' | 'contact-it' | 'restart' | null;
  errorCode: string | null;
}
```

Suggested endpoint behavior:

- `GET /api/sandbox/docker/setup`: return current/resumed status. Preserve the
  existing response fields for compatibility while adding the Windows fields.
- `POST /api/sandbox/docker/inspect`: start/refresh read-only inspection.
- `POST /api/sandbox/docker/setup`: start or continue idempotent setup; body
  carries explicit accepted consent identifiers, not a generic `force` flag.
- `POST /api/sandbox/docker/restart`: request one specific restart method with
  current operation id and required consent.
- `POST /api/sandbox/docker/cancel`: stop future work and remove one-shot resume
  registration; it cannot cancel an installer already committed by Windows.
- `GET /api/sandbox/docker/diagnostics`: sanitized machine-readable report for
  support. No recovery keys, environment dump, tokens, or unrestricted logs.

Mutating endpoints reject stale operation ids with `409`. Errors use stable
codes such as `UAC_CANCELLED`, `FIRMWARE_RESTART_UNSUPPORTED`,
`VIRTUALIZATION_UNKNOWN`, `VIRTUALIZATION_UNSUPPORTED`, `BITLOCKER_ACK_REQUIRED`,
`WINDOWS_RESTART_REQUIRED`, `INSTALLER_SIGNATURE_INVALID`, `POLICY_BLOCKED`, and
`DOCKER_START_TIMEOUT`.

CLI surface:

```text
od sandbox setup [--json]
od sandbox setup inspect [--json]
od sandbox setup continue --accept <consent-id>... [--json]
od sandbox setup restart --operation-id <id> --method <uefi|normal> --confirm [--json]
od sandbox setup cancel [--json]
od sandbox setup diagnostics [--json]
```

Interactive CLI may print steps and wait for an ordinary yes/no confirmation.
`--json` never prompts; it returns required consents/actions and a nonzero exit
status when human action is required.

## UI requirements

The onboarding gate uses one primary action at a time and keeps technical logs
behind `Chi tiết chẩn đoán`.

For firmware-disabled machines it shows:

- `Virtualization đang tắt`;
- detected vendor/model and Intel/AMD CPU;
- model/vendor/generic confidence;
- numbered BIOS steps, exact setting synonyms, Save & Exit instruction;
- a prominent reminder to photograph the steps;
- the BitLocker acknowledgement when applicable/unknown;
- `Khởi động vào BIOS/UEFI`, with manual-key fallback only after direct entry is
  known unavailable;
- `Để sau`, which exits setup without marking onboarding complete.

After app relaunch, the first card says either `Đã bật virtualization — tiếp
tục thiết lập` or `Virtualization vẫn đang tắt`, never silently repeats a
restart. Windows feature and Docker license consent screens follow the same
single-action pattern. UAC instructions must say the prompt comes from Windows
and name the operation/publisher the user should expect.

The final `ready` state is reached only after Docker engine readiness and the
required sandbox image preparation succeed. Runtime authentication remains its
existing subsequent onboarding step.

## Diagnostics and privacy

Logs are bounded and redact usernames, home-directory paths, URLs with query
parameters, tokens, installer temporary paths, and environment values. The
diagnostic report includes normalized facts, command names (not arbitrary
command lines), exit/error codes, timestamps, setup version, and guidance id.
No telemetry upload occurs merely because setup failed; sharing diagnostics is
an explicit user action.

## Test plan

### Pure/unit tests

- Normalize real-world manufacturer/model variants and select the correct
  vendor/model/generic guidance deterministically.
- Intel and AMD setting terminology; unknown vendor fallback.
- Virtualization precedence for true, false, null, unsupported SLAT, multiple
  processors, and conflicting CIM values.
- Firmware-mode detection does not equate Secure Boot off with legacy mode.
- Contract parsing, stale operation ids, required consents, redaction, bounded
  logs, and malformed persisted-state recovery.
- State transitions are idempotent and restart attempts cannot loop.

### Daemon tests with injected platform adapters

- Clean WinGet machine; clean no-WinGet machine using signed direct installer.
- Invalid/mismatched installer signature is rejected before elevation.
- UAC accepted, cancelled, and access denied.
- Firmware disabled with `/fw` success; `/fw` unsupported produces manual-key
  guidance without an immediate restart.
- WSL modern install and DISM fallback, both with and without restart required.
- BitLocker on/off/unknown gates; verify no key is read or logged.
- Resume after firmware restart enabled, still disabled, and inspection error.
- Resume after Windows-feature restart; expired/cancelled one-shot launch entry.
- Policy/proxy/download failure and Docker engine timeout recovery.
- Existing macOS setup behavior and old Docker setup clients remain compatible.

Native commands must be behind an injectable adapter. Unit/CI tests must not
restart hosts, invoke UAC, modify Windows features, or install Docker.

### Web tests

- Render detected model and correct guidance/confidence.
- Consent gates prevent restart/install actions until acknowledged.
- `/fw` fallback, UAC cancellation, policy block, and unknown inspection have
  distinct actionable states.
- Polling/reconnect displays persisted resume state and never starts duplicate
  operations.
- Ready only follows Docker and image readiness.

### Windows acceptance matrix

Validate on disposable physical devices or IT-approved test machines, not only
VMs:

- Dell Intel UEFI, HP Intel UEFI, Lenovo AMD UEFI;
- one unknown OEM using generic guidance;
- virtualization enabled and disabled;
- BitLocker on and off;
- WinGet present and absent;
- admin user, standard user with admin credential available, and policy-blocked
  managed device;
- WSL absent, partially enabled, enabled/pending restart, and ready;
- `/fw` supported and manual-key fallback;
- Windows 10 and Windows 11 supported baselines.

Firmware-setting verification is a manual acceptance step because automated CI
must never modify host firmware.

## Acceptance criteria

The work is complete when:

1. A supported clean Windows machine with virtualization already enabled can
   reach Docker/image readiness through UI clicks, UAC, and at most the Windows-
   required restart, without WinGet or a terminal.
2. When virtualization is disabled, Open Design reliably identifies the
   machine, shows appropriately qualified vendor/model instructions, handles
   BitLocker risk, enters UEFI directly when supported, and safely falls back to
   boot-key instructions.
3. After each restart, the app resumes from persisted state, re-inspects actual
   machine state, and never loops or repeats completed mutations.
4. No path silently accepts a Docker license, suppresses UAC, changes firmware,
   disables security controls, or forces a restart.
5. UI and `od` CLI use the same contracts and daemon operations; `--json` is
   fully machine-readable and noninteractive.
6. Unsupported hardware, unknown inspection, policy blocks, BIOS passwords,
   and network/signature failures end in clear recoverable or IT-escalation
   states rather than misleading success.
7. Existing macOS Docker setup and existing sandbox status/build/login flows do
   not regress.

## Explicit non-goals

- Automatically writing BIOS/UEFI settings through vendor-specific management
  tools.
- Collecting BIOS passwords or BitLocker recovery keys.
- Bypassing UAC, organization policy, application control, proxy/TLS policy, or
  security software.
- Supporting processors without required virtualization/SLAT capabilities.
- Installing a general-purpose Linux distribution for the user.
- Guaranteeing an exact firmware menu path for every model revision.
