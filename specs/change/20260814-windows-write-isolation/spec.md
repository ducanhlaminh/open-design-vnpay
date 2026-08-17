# Windows write-isolation (restricted-token backend)

Ước lượng: 1-2 tuần (cơ chế OS-level thật, chưa từng có tiền lệ trong repo
này, cần prototype cẩn thận). Phụ thuộc: không phụ thuộc kỹ thuật vào
`20260814-windows-native-install` — chạy song song được (không đụng file
chung: spec này chỉ sửa `apps/daemon/src/**`, spec kia chỉ sửa
`deploy/host/**` + build pipeline).

Vùng sở hữu: `apps/daemon/src/write-isolation-windows.ts` (mới),
seam gọi write-isolation trong `server.ts` (verify vị trí chính xác bằng
grep `planWriteIsolation\|wrapInvocationInWriteIsolation` trước khi sửa —
KHÔNG tin line number từ báo cáo research cũ, file trôi nhanh), và (side-item
nhỏ) `apps/daemon/src/runtimes/defs/codex.ts:118-143`.

**KHÔNG đụng** `apps/daemon/src/write-isolation.ts` (module macOS/Seatbelt) —
giữ nguyên 100%, chỉ thêm nhánh mới song song, không sửa logic cũ.

## Bối cảnh

macOS có write-isolation thật qua Seatbelt (`/usr/bin/sandbox-exec`,
`write-isolation.ts`). Linux/Windows hiện tại đều `off`-by-default, không
enforcement nào (`write-isolation.ts:36-42`,
`docs/run-write-isolation-spec.md:64-65`, "Phase 1: unisolated, loud log
line"). Quyết định: xây backend thật cho Windows (Linux vẫn giữ nguyên
Phase 1, không phải việc của spec này).

**Đã verify kỹ thuật này khả thi và đã chạy thật trong production**: OpenAI
Codex CLI's Windows sandbox ("unelevated mode") dùng đúng cơ chế restricted
token — không cần quyền admin, restricting-SID list gồm Everyone + Logon SID
(+ synthetic SID riêng của họ), plant ACE ghi rõ ràng trên từng
`writable_root`, và xác nhận: **"Reads remain unrestricted across the
filesystem; only writes are gated by ACL evaluation."** Đây không phải kỹ
thuật tự nghĩ ra — là mô hình đã được validate bởi 1 sản phẩm thật đang chạy.
(Nguồn: tổng hợp research qua WebSearch — Microsoft Learn's
"Restricted Tokens" doc + "Write-restricted token" blog, và bài phân tích kỹ
thuật Codex Windows sandbox trên codex.danielvaughan.com, 2026-07-18.)

Giới hạn đã biết (chính team Codex cũng ghi nhận): thư mục nào ĐÃ có sẵn ACL
cho phép "Everyone: Write" thì cơ chế restricted-SID không thêm được lớp
chặn nào (hai-lượt kiểm tra đều pass sẵn) — hiếm gặp trên thư mục cá nhân
thông thường, chấp nhận như 1 giới hạn đã biết, không cố giải quyết ở spec
này.

## Thiết kế

### Module mới: `apps/daemon/src/write-isolation-windows.ts`
Cấu trúc song song `write-isolation.ts` (cùng shape hàm, để chỗ gọi ở
`server.ts` chỉ cần branch theo platform, không phải viết lại luồng):

- `restrictedTokenIsolationMode(env, platform)` — gate, cùng semantics
  `writeIsolationMode` (`on`/`off`/`required`, đọc `OD_WRITE_ISOLATION`,
  default `off` cho tới khi module này đủ tin cậy — quyết định flip default
  sang `on` là việc riêng, làm SAU khi CI xác nhận chạy được thật trên
  windows-latest, không làm trong lần merge đầu).
- `planRestrictedTokenIsolation(input: {cwd, extraWritableRoots})` — trả
  `null` nếu không phải `win32` hoặc mode `off`; nếu khả thi, trả 1 plan
  object mang danh sách writable roots đã resolve (giống
  `BuildWriteIsolationProfileInput`'s shape bên macOS) để caller dùng ở
  bước wrap.
- `wrapInvocationInRestrictedTokenIsolation(inv, plan)` — pure rewrite (như
  `wrapInvocationInWriteIsolation`), biến invocation gốc thành:
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command <script>`
  trong đó `<script>` là 1 khối PowerShell (build bằng template string ngay
  trong file `.ts` này — theo đúng tiền lệ đã có trong repo,
  `apps/daemon/src/native-folder-dialog.ts:6-30` build lệnh PowerShell y hệt
  kiểu này, không cần file `.ps1` rời/không cần thêm resource bundle mới).

### Nội dung khối PowerShell (logic lõi)
1. `Add-Type -TypeDefinition '<C# P/Invoke>'` khai báo các Win32 API cần:
   `OpenProcessToken`, `DuplicateTokenEx`, `CreateRestrictedToken`,
   `CreateProcessAsUser`, `GetTokenInformation` (lấy Everyone SID / logon
   SID của chính token hiện tại).
2. Với mỗi writable root trong plan: `icacls "<path>" /grant Everyone:(OI)(CI)W`
   — plant ACE ghi cho SID Everyone, đúng mô hình Codex đã dùng thật.
3. Build restricted token: `CreateRestrictedToken` từ token của process hiện
   tại, `RestrictSids` = [Everyone SID, Logon SID] (bỏ phần "Synthetic SID"
   riêng của Codex — không cần thiết cho phạm vi OD, Everyone+Logon đã đủ
   theo mô tả kỹ thuật đã research). **Không cần
   `SE_ASSIGNPRIMARYTOKEN_NAME`/admin** vì đây là tự-giới-hạn token của
   chính mình, không impersonate user khác — xác nhận qua Microsoft Learn.
4. `CreateProcessAsUser` với token đó, launch command/args gốc, kế thừa
   cwd/env/stdio handles đúng như invocation ban đầu, đợi exit code, forward
   ra ngoài.
5. Dọn ACE đã plant sau khi process kết thúc (không để lại quyền ghi thừa
   trên máy user) — hoặc chấp nhận không dọn nếu chi phí dọn quá phức tạp,
   **quyết định cụ thể do executor đưa ra, ghi rõ lý do trong report**.

### Wiring vào `server.ts`
Grep tìm đúng vị trí gọi `planWriteIsolation`/`wrapInvocationInWriteIsolation`
hiện tại (KHÔNG tin line ref cũ). Thêm nhánh: `platform === 'win32'` →
gọi `planRestrictedTokenIsolation`/`wrapInvocationInRestrictedTokenIsolation`
thay vì macOS path; `platform === 'linux'` → giữ nguyên hành vi cũ (Phase 1,
không đổi). Message cảnh báo/refuse khi `required` mà plan null cũng áp
dụng tương tự nhánh macOS đã có, chỉ đổi text mô tả nguyên nhân
("cần Windows + PowerShell 5.1+" thay vì "cần macOS + sandbox-exec").

### Side-item: re-check Codex's own Windows sandbox
`apps/daemon/src/runtimes/defs/codex.ts:118-143` force
`--sandbox danger-full-access` trên win32, viện dẫn upstream issue #1721
("Codex có sandbox nhưng bị lỗi/chặn hết shell trên Windows"). Nghiên cứu
mới cho thấy Codex CLI đã build 1 Windows sandbox thật (đúng kỹ thuật
restricted-token này) — khả năng cao #1721 đã fix ở version Codex mới hơn.
**Việc cần làm**: kiểm tra version Codex hiện tại daemon đang target/detect
(grep `codex --version`/version-pin logic), tra changelog/release-notes
Codex CLI xem #1721 đã fix chưa, và nếu đã fix thì thử đổi lại
`workspace-write` cho win32 (bỏ `danger-full-access`), verify bằng cách chạy
thử 1 lệnh shell đơn giản qua Codex trên Windows (không có máy Windows ở
đây — ghi rõ "cần verify trên Windows thật" nếu không kiểm tra được, ĐỪNG tự
đổi code sandbox mode nếu không verify được — an toàn hơn giữ nguyên
`danger-full-access` và chỉ ghi lại finding trong report cho người quyết
định sau).

## Tests
Phần pure/mockable (không cần syscall thật): unit test
`planRestrictedTokenIsolation`'s gate logic + `wrapInvocationInRestrictedTokenIsolation`'s
rewrite output, theo đúng triết lý test hiện có của `write-isolation.ts`
("pure, unit-tested directly, no filesystem, no sandbox-exec" — file đó tự
ghi rõ điều này trong doc comment, giữ cùng chuẩn).

Phần cần syscall Win32 thật (CreateRestrictedToken có thực sự chặn ghi
ngoài allowlist hay không) — **không thể verify từ máy dev hiện tại (macOS,
không có Windows)**. Verify thật = CI job `windows-latest` mới: spawn 1
script test ghi vào (a) thư mục trong writable root — phải THÀNH CÔNG, (b)
thư mục ngoài writable root (vd `$env:USERPROFILE\Desktop`) — phải THẤT BẠI
với access-denied. Đây là phần quan trọng nhất của toàn bộ acceptance —
không có nó thì không thể tuyên bố cơ chế hoạt động đúng.

## Ngoài phạm vi
- Linux write-isolation — vẫn giữ Phase 1 (unisolated), không phải việc của
  spec này.
- AppContainer / synthetic-SID kiểu Codex đầy đủ (elevated mode, tài khoản
  Windows riêng, firewall rules cho network isolation) — chỉ làm phần
  write-isolation tương đương "unelevated mode", không làm network
  isolation (Seatbelt trên macOS cũng không làm network isolation, giữ
  parity đúng phạm vi hiện tại của OD, không mở rộng thêm).
- Sửa `write-isolation.ts` (macOS) — không đụng.
- Tự động dọn stale ACE nếu daemon crash giữa chừng run (accepted gap, note
  trong report nếu không làm được trong ước lượng).

## Acceptance & Verify
1. `pnpm guard` + `pnpm typecheck` xanh.
2. Unit test phần pure/mockable xanh (chạy được trên máy dev hiện tại,
   không cần Windows).
3. **Không claim mechanism hoạt động đúng nếu chưa có CI `windows-latest`
   smoke test thật sự pass** — đây là yêu cầu cứng, không phải nice-to-have.
   Nếu CI leg đó chưa tồn tại lúc thực thi spec này (phụ thuộc
   `20260814-windows-native-install` chưa xong), ghi rõ trong report:
   "logic đã viết + unit test pure logic xanh, nhưng CHƯA verify được hành
   vi thật trên Windows — cần CI leg từ spec kia trước khi tin tưởng."
4. Report ghi rõ finding của side-item Codex #1721 (đã fix upstream hay
   chưa, có đổi `danger-full-access` hay không, vì sao).
5. Doc comment trong `write-isolation-windows.ts` ghi rõ giới hạn đã biết
   (Everyone-writable-sẵn không bị thêm chặn) — không được giấu, phải giống
   tinh thần honest-doc-comment của `write-isolation.ts` hiện tại.
