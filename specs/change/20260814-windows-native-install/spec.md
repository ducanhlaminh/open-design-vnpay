# Windows-native install (`install.ps1` + build pipeline)

Ước lượng: 3-4 ngày. Phụ thuộc: không phụ thuộc kỹ thuật vào WP8/9/10 (phần
KGS removal) — chạy song song được. Có phụ thuộc **cấu hình** (không phải
code) vào `specs/change/20260814-windows-write-isolation/spec.md`: một khi
spec đó xong, quay lại đổi default `OD_WRITE_ISOLATION` trong file này từ
`off` sang `required` (xem mục cuối).

Vùng sở hữu: `deploy/host/install.ps1` (mới), `scripts/host-runtime/build-runtime.sh`
(sửa allow-list), `scripts/host-runtime/build-release-manifest.ts` (sửa regex),
`.github/workflows/release-host-runtime.yml` (thêm matrix leg),
`deploy/host/README.md`, `QUICKSTART.md` (nếu có phần OS-gated).

## Bối cảnh

`deploy/host/install.sh` (`curl | bash`) chỉ chạy trên Darwin/Linux
(`detect_platform()`, `install.sh:182-203` — hard fail mọi OS khác). Đây là
quyết định đã chốt trong web-first migration (`plan.md:70-71`), giờ bị mở
lại theo yêu cầu người dùng: thêm Windows làm nền tảng thứ 4, **ngang hàng**
macOS/Linux, không phải bản rút gọn.

Route thực tế bị chặn hôm nay: user chạy đúng lệnh 1-dòng documented trên
Git Bash (`MINGW64_NT-10.0-19045`) và nhận
`"Unsupported OS: MINGW64_NT-10.0-19045 (only macOS and Linux are supported)"`.

## Thiết kế

`install.ps1` mirror **từng bước** của `install.sh` (giữ cùng số bước/tên
phase trong output để hai script đồng bộ khái niệm — không phải port dịch
1-1 cú pháp bash sang PowerShell, mà giữ cùng LOGIC mỗi bước):

### Params (mirror toàn bộ flags của install.sh)
`-Archive`, `-ReleaseUrl`, `-Sha256`, `-Port`, `-DataDir`, `-EnvFile`,
`-MediaUrl`, `-MediaAppId`, `-MediaUserId`, `-MediaUserRole`, `-IdentityUrl`,
`-GoogleClientId`, `-GoogleClientSecret`, `-SessionSecret`, `-NoStart`,
`-Update`. `$OdHome = Join-Path $env:USERPROFILE ".open-design"`.

### Step 1 — verify package
- Platform luôn là `win32-x64` cho v1 (không cần auto-detect phức tạp —
  script chỉ chạy trên Windows). Kiến trúc: kiểm tra
  `[Environment]::Is64BitOperatingSystem`, fail rõ ràng nếu 32-bit hoặc ARM
  (ARM64 ngoài phạm vi v1, xem "Ngoài phạm vi").
- Checksum: `Get-FileHash -Algorithm SHA256` (built-in PowerShell 5.1+, thay
  `sha256_of()`).
- Download: `Invoke-WebRequest`.
- Tar-safety: dùng `tar.exe` (native trên Windows 10 1803+/Windows 11 —
  **đây là version tối thiểu, phải document rõ**) để list + verify, cùng
  logic `..`-traversal reject + single-root-dir check như
  `verify_tar_safety()` (`install.sh:269-283`).
- **Xác minh lại bằng grep trước khi map 1-1**: đọc lại đúng
  `install.sh` hiện tại (không phải bản đã research — có thể đã trôi), lấy
  đúng field/flag list, đừng suy đoán từ báo cáo cũ.

### Step 2 — Node.js
Fetch `node-v24.x.y-win-x64.zip` (khác `.tar.gz` của darwin/linux!), extract
qua `Expand-Archive`. Version gốc lấy từ `apps/daemon/package.json#engines`
giống bash.

### Step 3 — extract, config, service, symlink
- `tar -xzf ... --strip-components=1` (tar.exe hỗ trợ flag này).
- `config.env` viết qua `Set-Content`. **`OD_WRITE_ISOLATION=off`** (không
  phải `required`) — xem lý do ở mục cuối file này, đây là default TẠM
  THỜI cho tới khi spec write-isolation-windows xong; kèm comment rõ trong
  file config.env giải thích tại sao (mirror đúng tinh thần cảnh báo "Phase 1
  unisolated" đã có sẵn trong `docs/run-write-isolation-spec.md`).
- Lock file bằng ACL: `icacls $path /inheritance:r /grant:r
  "$env:USERNAME:F"` (tương đương `chmod 600`).
- `current` pointer: `New-Item -ItemType Junction -Path "$OdHome\current"
  -Target $ReleaseDir -Force`. **Không phải kỹ thuật mới** — đúng cơ chế
  `fs.symlinkSync(realPath, linkPath, 'junction')` đã chạy thật trong
  `apps/daemon/src/library-install.ts:136`. Không cần admin/Developer Mode.
- **Service registration** — điểm khác biệt lớn nhất so với bash:
  ```
  schtasks.exe /Create /SC ONLOGON /RL LIMITED /F /TN "OpenDesignDaemon" `
    /TR "`"$NodeBin`" `"$OdHome\current\apps\daemon\dist\cli.js`" --no-open"
  ```
  Per-user, không cần admin (`/RL LIMITED`), trigger khi logon — tương đương
  vai trò LaunchAgent/systemd-user-unit. KHÔNG dùng `sc.exe create` (cần
  admin) và KHÔNG dùng NSSM (thêm dependency ngoài). Start ngay sau install:
  `Start-Process -WindowStyle Hidden`. Stop: `Stop-Process` theo PID đã lưu +
  fallback `taskkill /T /F` (đúng primitive `runs.ts:69-73` daemon đã dùng
  cho chính con nó spawn ra — nhất quán).

### Step 4/5 — health check, rollback
`Invoke-WebRequest` poll loop mirror `wait_for_health()`. Rollback: re-point
Junction về release cũ + restart scheduled task, cùng shape `rollback()`
(`install.sh:589-606`).

### Step 6 — Claude CLI
Dùng lại đúng check JSON-file `~/.claude/.credentials.json` (đã OS-agnostic
qua `$env:USERPROFILE`, không cần viết lại) — bỏ nhánh Keychain-only (không
có gì thay thế cần thiết, nhánh đó vốn chỉ chạy trên Darwin).
**Xác minh lúc thực thi**: Anthropic có publish native Windows install
script cho Claude Code không — đừng giả định URL, nếu không có thì in
hướng dẫn cài thủ công.

## Build pipeline — thêm `win32-x64`

1. `scripts/host-runtime/build-runtime.sh`: mở allow-list `--platform` thêm
   `win32-x64`. Kiểm tra lại (grep) xem `host_platform()`'s auto-detect có
   thực sự được CI dùng không, hay CI luôn pass `--platform` tường minh —
   nếu tường minh thì auto-detect không cần sửa. `windows-latest` GH runner
   có sẵn Git Bash — script bash chạy thẳng được trên đó, không cần port
   sang PowerShell.
2. `scripts/host-runtime/build-release-manifest.ts:33`: mở rộng
   `TARBALL_RE` chấp nhận `win32-x64`.
3. `.github/workflows/release-host-runtime.yml`: thêm matrix leg
   `{platform: win32-x64, os: windows-latest}`.
4. Verify: `better-sqlite3@12.10.0` có prebuild `win32-x64` cho Node 24
   không — chạy thật CI leg này lần đầu để xác nhận, nếu fallback
   `node-gyp rebuild` thì `windows-latest` runner có sẵn MSVC Build Tools +
   Python nên vẫn build được (chậm hơn), không phải blocker nhưng phải ghi
   rõ trong report.

## Docs
`deploy/host/README.md`: thêm mục Windows (prereq: Windows 10 1803+/11,
PowerShell 5.1+), one-liner `irm <url>/install.ps1 | iex`, sửa dòng
`:160-161` đang trỏ sai vào `apps/desktop` (Electron) đã bị xoá.

## Tests
`deploy/tests/` — không thể chạy full `install.ps1` từ máy dev (không có
Windows). Verify thật = CI job mới trên `windows-latest` chạy
`install.ps1 -Archive <local> -NoStart`, mirror đúng job description
mac/ubuntu đã có ở `wp6-installer.md:60`. Mở rộng test parsing platform
hiện có (bash/TS) thêm case `win32-x64`.

## Ngoài phạm vi
- Windows-on-ARM (chỉ x64 cho v1).
- Điện Electron/NSIS/portable-zip packaging (đã xoá ở WP5, không dựng lại).
- Windows write-isolation thật — xem
  `specs/change/20260814-windows-write-isolation/spec.md` (spec riêng).
- Bất kỳ thay đổi nào ở code daemon runtime đã xác nhận sẵn-sàng-Windows
  (process-tree-kill, path/binary resolution) — không đụng, đã hoạt động
  đúng.

## Sau khi spec write-isolation-windows xong (không phải việc của spec này)
Quay lại đổi `config.env`'s `OD_WRITE_ISOLATION=off` → `required`/`on`,
việc nhỏ, 1 dòng, không cần re-viết cả spec.

## Acceptance & Verify
1. `pnpm guard` + `pnpm typecheck` xanh (phần TS bị sửa:
   `build-release-manifest.ts`).
2. Không có `pwsh` trên máy dev hiện tại — không thể verify cú pháp
   `install.ps1` local. Ghi rõ trong report, không claim đã test được.
3. Grep xác nhận không có call nào cần admin (`sc.exe create`, elevated
   `New-Item -ItemType SymbolicLink`...) — giữ đúng bất biến "no sudo" của
   `install.sh`.
4. Report liệt kê rõ: có tìm được URL cài Claude Code native cho Windows
   hay không, quyết định fallback thế nào.
