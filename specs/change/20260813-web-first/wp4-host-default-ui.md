# WP4 — Đảo mặc định về host + đổi surface UI/CLI

Ước lượng: 2 ngày. Phụ thuộc: WP2 + WP3 xong (KHÔNG bật host mặc định khi chưa có whitelist env + tree-kill). Vùng sở hữu: `agent-sandbox.ts` (config), `write-isolation.ts` (default), `server.ts` (/api/agents + usage), `sandbox-routes.ts`, web InfraSetupGate/Settings, contracts sandbox, `cli.ts` (od sandbox), i18n.

## Mục tiêu

Mặc định mọi run chạy host CLI; Docker sandbox thành chế độ opt-in (`OD_SANDBOX=1` hoặc prefs) còn nguyên chức năng; màn hình setup đổi từ "Docker → image → login volume" sang "Claude CLI → đã login"; seatbelt bật mặc định trên macOS.

## Việc cụ thể

### 4.1 Config & defaults — `apps/daemon/src/agent-sandbox.ts`
- `resolveSandboxConfig` (~L293-338): đổi `enabled = prefs?.enabled !== false` → `enabled = prefs?.enabled === true`. `OD_SANDBOX=1|0` giữ nguyên làm escape hatch hai chiều.
- **Đảo migration legacy** (~L261-270): hiện `skills:['ui-react']`/`runtimes:['claude']` bị auto-nâng thành `['*']`/`['claude','codex']`. Sau khi default off, migration này chỉ còn áp KHI user chủ động bật sandbox — giữ logic nhưng thêm test khẳng định: prefs legacy + không bật tường minh ⇒ sandbox OFF.
- Dọn docblock chết về `OD_SANDBOX_DEFAULT` (~L282-292) — daemon không đọc biến này.
- KHÔNG xóa bất kỳ hàm Docker nào.

### 4.2 Write isolation mặc định — `apps/daemon/src/write-isolation.ts`
- `writeIsolationMode` (~L38-42): default `off` → **`on` khi `platform === 'darwin'`**, giữ `off` nơi khác (Linux chưa có cơ chế — hành xử cũ). `required` vẫn qua env. Cập nhật `docs/run-write-isolation-spec.md` (Phase 2 chính là bước này).
- Test: default darwin = on; `OD_WRITE_ISOLATION=off` vẫn tắt được.

### 4.3 Host CLI hiện hình — `apps/daemon/src/server.ts`
- `/api/agents` (~L6188-6230): bỏ nhánh `dockerOnly` ẩn host CLI khi sandbox tắt (điều kiện `dockerOnly = sandboxCfg.enabled && skills.includes('*')` tự thành false sau 4.1 — nhưng RÀ để chắc host detection + capability probe (`runtimes/detection.ts` ~L163-178, skip tại ~L6197-6200) chạy lại; hệ quả tốt: `--include-partial-messages` được bật).
- `static-resource-routes.ts` ~L74-79, `runtimes/detection.ts` ~L245-247: rà lại điều kiện sandbox-owned.
- Usage meter: `/api/usage/claude` (~L13773-13826) khi sandbox off → đọc host (đường Keychain trong `claude-usage.ts` ~L36-58 đã có). `/api/usage/codex` đang unconditional Docker → khi sandbox off trả `{available:false}` sạch sẽ thay vì lỗi.
- Preflight sandbox (~L12204-12252) chỉ chạy khi `willSandbox` — xác nhận không còn đường nào chạm Docker khi sandbox off (kể cả orphan container sweep ~L18950: gate theo sandbox enabled).

### 4.4 Setup gate web — `apps/web/src/components/InfraSetupGate.tsx` (+ `sandbox-runtime.ts`)
- Chế độ host (mặc định): gate chỉ còn 2 bước — (1) Claude CLI có trên máy, (2) đã login. Nguồn dữ liệu: `/api/agents` (`authStatus`/`authMessage` từ `probeClaudeAuthStatus`, `runtimes/auth.ts` ~L177-231 — Keychain-aware, message tiếng Việt sẵn). Thiếu CLI → hướng dẫn cài (link `https://claude.ai/install.sh` + lệnh); chưa login → hướng dẫn `claude /login`. BỎ hẳn bước Docker/image khỏi luồng mặc định.
- Chế độ sandbox (khi user bật lại): giữ wizard cũ nguyên trạng.
- `SandboxSection.tsx`: thêm khối "Chế độ thực thi: Host CLI (mặc định) / Docker sandbox" — toggle ghi prefs (`PUT /api/app-config`). `ClaudeAccountSwitcher`: host mode ẩn/hiện "không áp dụng — dùng tài khoản của claude CLI trên máy". `AgentPicker.tsx` (~L58-61): suffix "· Docker" chỉ khi sandbox thật sự own.
- Contracts `packages/contracts/src/api/sandbox.ts`: `dockerOk/imageOk/authVolumeOk` → optional; thêm `mode: 'host'|'sandbox'`, `hostClaude: {available, version?, authStatus, authMessage?}`. Cập nhật `api/registry.ts` (~L36-43) tương ứng.
- `sandbox-routes.ts` `GET /api/sandbox/status` (~L397): trả thêm mode + host fields; các endpoint Docker-only (build, accounts, embedded-login) khi mode host trả 409 `SANDBOX_MODE_HOST` message rõ, KHÔNG 500.
- i18n 19 locale cho mọi chuỗi mới (quy tắc chung #8).

### 4.5 CLI — `apps/daemon/src/cli.ts`
- `od sandbox status` in mode + trạng thái host CLI. `od sandbox enable|disable` giữ nguyên (giờ disable là mặc định). Các lệnh Docker-only (`build/login/logout/ps/kill`, ~L6283-6400) khi mode host: in "đang ở chế độ host — lệnh này chỉ dùng cho Docker sandbox (od sandbox enable trước)" exit 1, KHÔNG chạy docker.
- Thêm `od doctor` HOẶC mở rộng `od sandbox status`: check claude CLI + login + write-isolation, in checklist — dùng làm lệnh chẩn đoán sau cài đặt (WP6 sẽ gọi nó).

### 4.6 Docs
- Cập nhật `docs/prod-docker-removal-spec.md` trạng thái các phase đã thành hiện thực; note trong `AGENTS.md` phần chạy dev: mặc định host, bật lại sandbox bằng `OD_SANDBOX=1`.

## Tests

- Sửa `agent-sandbox.test.ts` (~L36 đang assert default-ON → default-OFF), `sandbox-routes.test.ts`, `chat-route.test.ts` (đang set `OD_SANDBOX=0` thủ công — rà lại), web `InfraSetupGate.runtime.test.tsx`, `SandboxSection.runtime.test.tsx`.
- Mới: default off; `OD_SANDBOX=1` bật lại nguyên chức năng; usage claude đọc host khi off; endpoint Docker-only trả 409 ở host mode; gate web render nhánh host.

## Ngoài phạm vi

- Xóa code Electron/desktop (WP5). Xóa code Docker (không bao giờ trong đợt này).
- Installer (WP6). Multi-account host (đã chốt bỏ).

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` + test khu vực xanh; không tăng đỏ baseline.
2. Máy sạch config (xóa/đổi tên `app-config.json` tạm): khởi động daemon KHÔNG đòi Docker; `/api/agents` thấy host claude; chat run chạy thẳng host với write-isolation on (darwin).
3. `OD_SANDBOX=1`: hành vi Docker cũ trở lại nguyên vẹn (InfraSetupGate wizard cũ, run trong container).
4. Report ghi rõ những chỗ line-drift so với spec.
