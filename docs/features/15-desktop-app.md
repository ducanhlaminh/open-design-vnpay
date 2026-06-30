# F-20: Desktop Application (Electron)

**Nhóm:** 🖥️ Platform — Desktop  
**Nguồn code:** `apps/desktop/`, `apps/daemon/src/sidecar/`, `apps/packaged/`  
**Platforms:** macOS (Apple Silicon + Intel), Windows (x64), Linux AppImage (beta)

---

## 1. Tổng quan

**Desktop Application** là Electron shell wrapper xung quanh Web UI, cho phép dùng Open Design như một native app mà không cần browser. Daemon khởi động tự động trong background khi app mở.

---

## 2. Kiến trúc Desktop

```
Electron App (Desktop)
  ├── Renderer Process: Web UI (Next.js / web view)
  ├── Main Process: App lifecycle, IPC bridge
  └── Sidecar Process: Local daemon (Express + SQLite)
       ↕ Unix socket IPC
```

---

## 3. Sidecar IPC

Desktop app giao tiếp với daemon qua **Unix socket**:

```
/tmp/open-design/ipc/<namespace>/<app>.sock
```

### 3.1 IPC Commands

| Command | Payload | Mô tả |
|---------|---------|-------|
| `STATUS` | — | Daemon status (running, version, port) |
| `EVAL` | `{script: string}` | Execute JS trong renderer process |
| `SCREENSHOT` | — | Capture full-page screenshot |
| `CONSOLE` | — | Get console messages |
| `CLICK` | `{x, y}` | Simulate mouse click |
| `SHUTDOWN` | — | Graceful shutdown |

### 3.2 Auto Port Discovery

- Desktop app tự động tìm daemon port qua IPC
- Không cần config port thủ công
- `STATUS` command trả về: `{ port: 7456, pid: ... }`

---

## 4. Desktop Auth Gate

Khi `OD_DESKTOP_AUTH=1`:

```
Boot → Generate auth secret
     → App opens with secret in query param
     → Daemon validates secret on each API call
     → Secret rotates after each boot
```

**Import nonce mechanism:**
- Ngăn replay attacks
- Nonce single-use, expire after 30s

---

## 5. Data Migration

### Option A: Auto-migration (`OD_LEGACY_DATA_DIR`)

```bash
OD_LEGACY_DATA_DIR="/path/to/.od" \
  "/Applications/Open Design.app/Contents/MacOS/Open Design"
```

**Flow:**
1. Daemon phát hiện `OD_LEGACY_DATA_DIR`
2. Copy `.od/` vào app data directory (staging)
3. Validate: source phải có `app.sqlite`
4. Atomic promote staging → active
5. Tạo `.migrated-from` marker để ngăn re-migration

**Fail conditions:**
- Source không có `app.sqlite` → Error
- Desktop đã có data riêng → Không merge, error

### Option B: Manual copy

```bash
rsync -av ~/.od/ ~/Library/Application\ Support/OpenDesign/.od/
```

---

## 6. Packaged App

`apps/packaged/` — Electron builder config:
- macOS: `.dmg` universal binary (Intel + Apple Silicon)
- Windows: `.exe` installer (x64)
- Linux: `.AppImage` (beta)
- Auto-updater support (`UpdaterPopup.tsx`)

---

## 7. App Startup

```
1. Electron main process starts
2. Spawn sidecar daemon
3. Wait for daemon STATUS = running
4. Open web view pointing to daemon URL
5. Auth gate handshake (nếu enabled)
6. UI loads
```

**Target:** App startup < **5 giây**

---

## 8. Updates

`UpdaterPopup.tsx`:
- Check for updates on startup
- Download update in background
- Notify user when update ready
- One-click install and restart

---

## 9. Acceptance Criteria

- [x] App khởi động < 5 giây
- [x] Không cần config port thủ công
- [x] Sidecar IPC: STATUS / EVAL / SCREENSHOT / SHUTDOWN / CLICK
- [x] macOS (Apple Silicon + Intel) support
- [x] Windows x64 support
- [x] Desktop auth gate với rotating secret
- [x] Data migration từ dev-server không mất data
- [x] `.migrated-from` marker ngăn re-migration
- [x] Auto-updater notification
