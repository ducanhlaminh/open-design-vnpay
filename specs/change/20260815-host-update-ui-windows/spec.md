# Host-runtime self-update: UI-triggered (not silent) + Windows support

## Bối cảnh

Tính năng self-update đã có sẵn (không phải việc mới):
`GET /api/update/status` + `POST /api/update/apply` trong `apps/daemon/src/server.ts`
(quanh dòng 5318-5390, xác minh lại bằng grep trước khi sửa — line trôi),
`apps/web/src/components/UpdateCheck.tsx` (poll 7 phút, tự bắn `apply` ngay
khi thấy `updateAvailable`, không hỏi, không có nút gì cả).

Hai vấn đề cần sửa, đúng theo yêu cầu chủ repo:

1. **Đổi từ im lặng tự động → UI trigger.** User muốn thấy có bản mới và tự
   bấm nút để cập nhật, không muốn app tự ý update ngầm nữa.
2. **Windows chưa chạy được.** `/api/update/apply` hardcode
   `spawn('bash', [path.join(odHome, 'current', 'install.sh'), '--update'])`.
   Trên Windows không có `bash` theo mặc định, và kể cả có thì `install.sh`
   không tương thích layout Windows (Junction/schtasks/icacls, không phải
   symlink/launchd/chmod). Lỗi spawn hiện bị nuốt im lặng (`detached: true,
   stdio: 'ignore'`, không lắng nghe event `'error'`) — bấm xong tưởng chạy,
   thực ra không có gì xảy ra, không toast, không lỗi.

## Vùng sở hữu (chỉ sửa các file này)

- `apps/daemon/src/server.ts` — 2 route `/api/update/status`, `/api/update/apply`.
- `apps/daemon/src/cli.ts` — thêm subcommand CLI mới (bắt buộc theo
  `AGENTS.md` §"Capability exposure (UI/CLI dual-track)": mọi capability lộ
  qua UI phải có CLI tương ứng, cùng gọi chung API).
- `apps/web/src/components/UpdateCheck.tsx` (+ `.module.css` nếu cần, đặt
  cạnh file, xem `InfraSetupGate.module.css` làm mẫu).
- File test mới trong `apps/daemon/tests/` cho phần logic thuần (xem mục
  Test bên dưới).
- **KHÔNG đụng** `deploy/host/install.sh`, `deploy/host/install.ps1`,
  `scripts/host-runtime/**`, `.github/workflows/**` — các file này đã đúng,
  vấn đề chỉ nằm ở cách daemon GỌI chúng, không phải bản thân chúng.

## 1. Backend — platform-aware spawn, tách hàm thuần để test được

Hàm hiện tại inline spawn logic thẳng trong route handler — không test được.
Tách ra một hàm thuần (pure function, không side effect), theo đúng pattern
đã có sẵn trong repo cho các seam có nhánh platform/OS (xem
`apps/daemon/src/runtimes/env.ts` `stripUnlessCustomBaseUrl`,
`apps/daemon/src/load-host-config-env.ts` `resolveOdHomeFromModuleDir` —
cả hai đều tách phần "quyết định" ra khỏi phần "thực thi" để unit test
không cần fs/spawn thật):

```ts
// ví dụ hình dạng, không phải code bắt buộc chép nguyên văn
export function resolveUpdateCommand(
  odHome: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return {
      cmd: 'powershell', // resolve qua resolveOnPath, xem dưới
      args: ['-File', path.join(odHome, 'current', 'install.ps1'), '-Update'],
    };
  }
  return {
    cmd: 'bash',
    args: [path.join(odHome, 'current', 'install.sh'), '--update'],
  };
}
```

Điểm bắt buộc:

- **Windows dùng đúng lệnh đã document sẵn** trong
  `deploy/host/README.md` mục "Update" (Windows):
  `powershell -File $env:USERPROFILE\.open-design\current\install.ps1 -Update`.
  KHÔNG tự thêm `-ExecutionPolicy Bypass` — README's example không cần nó,
  đừng đoán, giữ nguyên đúng như đã document.
- **Resolve `powershell` qua `resolveOnPath()`** đã có sẵn ở
  `apps/daemon/src/runtimes/executables.ts` (đọc PATH/PATHEXT đúng kiểu
  Windows, đã được dùng chỗ khác trong daemon) — đừng tự viết lại logic
  tìm binary. Nếu resolve ra `null` (không tìm thấy powershell trên máy —
  gần như không thể xảy ra nhưng vẫn phải xử lý), coi là lỗi và set
  `lastUpdateError` (xem dưới), KHÔNG spawn mù.
- `spawn(...)` cho nhánh Windows cần thêm `windowsHide: true` bên cạnh
  `detached: true, stdio: 'ignore'` hiện có — nếu không, Node có thể bật
  một cửa sổ console nháy lên khi spawn không qua shell trên Windows.
- macOS/Linux: giữ nguyên hệt hành vi cũ (`bash install.sh --update`).

## 2. Backend — báo lỗi spawn thay vì nuốt im lặng (phạm vi hẹp, xem "Ngoài phạm vi")

Thêm state trong-memory (không cần ghi file — xem lý do trong "Ngoài phạm vi"):

```ts
let lastUpdateError: { message: string; at: string } | null = null;
```

- Đầu mỗi lần `/api/update/apply` chạy thật (qua được 2 guard
  `updateApplyInProgress` / `runs-active`), set `lastUpdateError = null`.
- Lắng nghe `child.on('error', (err) => { lastUpdateError = { message:
  String(err?.message ?? err), at: new Date().toISOString() };
  updateApplyInProgress = false; })` — đây là lỗi spawn thật sự (ví dụ ENOENT
  vì thiếu `bash`/`powershell`, hoặc install script không tồn tại).
- `GET /api/update/status` response thêm field `lastError:
  { message: string; at: string } | null` = giá trị hiện tại của
  `lastUpdateError`.
- Cập nhật type dùng chung trong `packages/contracts` nếu response shape
  của `/api/update/status` đã có type ở đó (grep `UpdateStatusResponse`
  hoặc tương đương trong `packages/contracts` trước khi sửa — nếu có,
  sửa tại nguồn, không định nghĩa type trùng ở 2 chỗ).

## 3. Frontend — `UpdateCheck.tsx`: banner + nút, bỏ tự bắn ngầm

Giữ nguyên toast "Đã cập nhật lên v..." khi `justUpdated` xuất hiện — không
đổi phần đó.

Đổi phần còn lại:

- **Bỏ hẳn** đoạn tự động gọi `POST /api/update/apply` ngay khi
  `updateAvailable === true` trong `checkStatus()`.
- Khi `status.updateAvailable === true` và không có update nào đang chạy,
  hiện 1 banner nhỏ, gọn (không phải modal chặn thao tác) với nội dung kiểu:
  "Có bản cập nhật mới: v{latestVersion} (đang chạy v{currentVersion})" +
  nút "Cập nhật ngay".
- Bấm nút → `POST /api/update/apply` → disable nút, đổi text nút thành
  "Đang cập nhật…" (không phải spinner phức tạp, chỉ cần disable + đổi chữ).
- Sau khi bấm, tạm thời poll nhanh hơn (ví dụ mỗi 4s, giống cách
  `InfraSetupGate.tsx` poll nhanh trong lúc overlay của nó đang mở — xem
  file đó làm mẫu) cho tới khi xảy ra MỘT trong ba việc, rồi quay lại poll
  7 phút như cũ:
  1. `justUpdated` xuất hiện → thành công, hiện toast có sẵn.
  2. `lastError` khác null → hiện `Toast` với `role="alert"`,
     message + `details` = `lastError.message`.
  3. Timeout hợp lý (đề xuất 90s, khớp cửa sổ health-check-với-rollback
     của install.sh/install.ps1) mà không có (1) hay (2) → hiện Toast báo
     "Cập nhật có thể chưa xong hoặc thất bại, thử tải lại trang" (đây là
     giới hạn thật của kiến trúc — daemon tự giết chính nó giữa chừng khi
     update, xem comment sẵn có trong server.ts dòng ~5310-5316).
- **Không thêm i18n key mới** — giữ đúng quy ước "Vietnamese-only copy on
  purpose" đã ghi rõ trong docblock hiện tại của file này (tham chiếu
  `InfraSetupGate.tsx` / `ClaudeAccountSwitcher.tsx` cùng quy ước).
- Banner style: tạo `UpdateCheck.module.css` cạnh file nếu cần, phong cách
  tối giản khớp `InfraSetupGate.module.css` (không cần match pixel-perfect,
  chỉ cần nhất quán tông màu/spacing với phần UI xung quanh).

## 4. CLI — `od self-update` (bắt buộc theo AGENTS.md dual-track)

Thêm subcommand top-level mới trong `apps/daemon/src/cli.ts` — tìm điểm
dispatch bằng grep (`argv[0] ===` — có nhiều nhánh kiểu này trong file, tự
xác định chỗ hợp lý để thêm, đặt gần các subcommand thin-client khác như
`od media`/`od sandbox`). Thin client giống `od media`/`od sandbox status`
đã có — chỉ gọi `fetch` tới daemon qua `resolveDaemonUrl()` đã import sẵn
ở đầu file, KHÔNG tự implement lại logic update:

```
od self-update           # = check: in currentVersion/latestVersion/updateAvailable/lastError
od self-update check     # alias của trên
od self-update apply     # POST /api/update/apply, in kết quả {started, reason?}
```

In JSON gọn (xem cách `print()` helper hiện có trong file xử lý response —
dùng lại, không viết logic in mới).

## API contract (chốt, cả UI lẫn CLI dùng chung, không đổi khi thực thi)

`GET /api/update/status` →
```json
{
  "currentVersion": "0.8.4",
  "latestVersion": "0.8.5",
  "updateAvailable": true,
  "justUpdated": null,
  "lastError": null
}
```

`POST /api/update/apply` → không đổi shape hiện có:
`{ "started": true }` hoặc `{ "started": false, "reason": "...", "error"?: "..." }`.

## Ngoài phạm vi (không làm trong lượt này)

- **Không** xử lý trường hợp update chạy thành công tới bước health-check
  rồi FAIL và rollback (install.sh/install.ps1 tự restart daemon bản cũ) —
  case này daemon gốc đã bị kill trước khi biết kết quả, cần install.sh/
  install.ps1 tự ghi marker lỗi ra đĩa để daemon MỚI (bản rollback) đọc lại
  — đụng vào install.sh/install.ps1, ngoài vùng sở hữu của lượt này. Chỉ
  xử lý lỗi spawn NGAY LẬP TỨC (trước khi child kịp chạy) — đủ để sửa đúng
  bug đang có (Windows thiếu `bash` → spawn ENOENT ngay).
- **Không** đổi cơ chế bundled-secrets / `host-env.template` (đã xong ở
  spec khác, không liên quan).
- **Không** thêm E2E CI test tự thật sự update từ version A → version B
  trên Windows runner (cần 2 tarball version khác nhau, phức tạp/dễ flaky
  so với giá trị mang lại) — verify Windows bằng cách:
  unit test `resolveUpdateCommand('win32', ...)` trả đúng cmd/args, KHÔNG
  cần spawn thật trong test.

## Test bắt buộc

- `apps/daemon/tests/<tên-mới>.test.ts`: test `resolveUpdateCommand(...)`
  cho cả `'win32'` và `'darwin'`/`'linux'` — assert đúng `cmd`/`args`,
  đặc biệt đúng `install.ps1 -Update` vs `install.sh --update`. Test thuần,
  không mock fs/spawn thật (hàm này không nên tự đọc fs — chỉ nhận
  `odHome`/`platform` làm tham số, xem chữ ký mẫu ở mục 1).
- Nếu tách thêm hàm áp dụng `lastUpdateError`, test luôn hàm đó tương tự.
- Gate bắt buộc trước khi báo xong:
  `pnpm --filter @open-design/daemon test -- <file test mới>` xanh,
  `pnpm --filter @open-design/daemon typecheck` xanh,
  `pnpm --filter @open-design/web typecheck` xanh (đụng .tsx).
- **Không thể verify Windows thật trên máy dev này** (không có máy Windows).
  Ghi rõ điều này trong report thay vì tự nhận đã test được — verify thật
  là việc của mình (orchestrator) làm sau, qua CI Windows đã có sẵn trong
  `.github/workflows/release-host-runtime.yml` (KHÔNG phải việc của lượt
  thực thi này).

## Quy tắc chung khi thực thi

1. Line refs trong spec này là mốc lúc viết (15/08) — `server.ts` rất lớn
   (~19k dòng), xác minh lại bằng grep trước khi sửa.
2. Không commit, không push. Để nguyên working tree.
3. Daemon chạy tsx không hot-reload route — nếu tự chạy thử phải restart
   tools-dev.
4. Trả report: danh sách file đã sửa, các quyết định đã đưa ra (đặc biệt
   nếu response shape của `/api/update/status` đã có type sẵn ở
   `packages/contracts` và bạn phải sửa ở đó), kết quả từng lệnh verify,
   việc còn lại nếu có.
