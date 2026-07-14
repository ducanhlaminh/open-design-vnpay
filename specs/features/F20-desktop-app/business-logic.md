# F-20: Desktop Application (Electron) — Business Logic

## Overview

The Desktop Application is an Electron shell wrapping the Web UI. The daemon (Express + SQLite) runs as a **sidecar process** inside the Electron app. Communication between the Electron main process and the daemon uses **Unix socket IPC**. A rotating secret auth gate protects the daemon API from unauthorized access.

---

## Business Rules

### Architecture

| Rule | Detail |
|------|--------|
| **BR-01** | Electron has 3 processes: Renderer (Web UI), Main Process (IPC bridge), Sidecar (local daemon) |
| **BR-02** | Renderer ↔ Main communicates via Electron IPC |
| **BR-03** | Main ↔ Sidecar communicates via Unix socket: `/tmp/open-design/ipc/<namespace>/<app>.sock` |
| **BR-04** | Sidecar starts automatically when Electron app opens |
| **BR-05** | No manual port configuration required — auto-discovery via IPC |

### IPC Commands

| Command | Payload | Description |
|---------|---------|-------------|
| `STATUS` | — | Daemon status (running, version, port) |
| `EVAL` | `{ script: string }` | Execute JS in renderer |
| `SCREENSHOT` | — | Capture full-page screenshot |
| `CONSOLE` | — | Get console messages |
| `CLICK` | `{ x, y }` | Simulate mouse click |
| `SHUTDOWN` | — | Graceful shutdown |

### Desktop Auth Gate

| Rule | Detail |
|------|--------|
| **BR-06** | Enabled when `OD_DESKTOP_AUTH=1` |
| **BR-07** | At boot, daemon generates a random auth secret |
| **BR-08** | Electron opens Web UI with secret in query param |
| **BR-09** | Daemon validates secret on every API call |
| **BR-10** | Secret rotates after each boot — no persistent secret |
| **BR-11** | Import nonce mechanism prevents replay attacks (single-use, expires in 30s) |

### Data Migration

| Rule | Detail |
|------|--------|
| **BR-12** | `OD_LEGACY_DATA_DIR` env triggers auto-migration of existing `.od/` data |
| **BR-13** | Migration stages: copy to staging → validate (must have `app.sqlite`) → atomic promote |
| **BR-14** | `.migrated-from` marker file prevents re-migration |
| **BR-15** | If desktop already has its own data, migration refuses to merge (error) |
| **BR-16** | Manual copy via `rsync` is the alternative migration path |

### Platforms

| Platform | Format |
|---------|--------|
| macOS | `.dmg` universal binary (Intel + Apple Silicon) |
| Windows | `.exe` installer (x64) |
| Linux | `.AppImage` (beta) |

### Auto-Updater

| Rule | Detail |
|------|--------|
| **BR-17** | App checks for updates on startup |
| **BR-18** | Update downloads in background |
| **BR-19** | User notified when update is ready |
| **BR-20** | One-click install and restart |

### Performance SLA

| SLA | Target |
|-----|--------|
| App startup | < 5 seconds |
| Port auto-discovery | < 1 second |

---

## Acceptance Criteria

- [ ] App starts in < 5 seconds
- [ ] No manual port configuration needed
- [ ] Sidecar IPC: STATUS / EVAL / SCREENSHOT / SHUTDOWN / CLICK
- [ ] macOS (Apple Silicon + Intel) support
- [ ] Windows x64 support
- [ ] Desktop auth gate with rotating secret
- [ ] Data migration from dev-server without data loss
- [ ] `.migrated-from` marker prevents re-migration
- [ ] Auto-updater notification
