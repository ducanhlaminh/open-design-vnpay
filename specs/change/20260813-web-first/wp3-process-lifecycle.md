# WP3 — Vòng đời process cho host run

Ước lượng: 1 ngày. Phụ thuộc: **TUẦN TỰ sau WP2** (cùng đụng `server.ts` seam spawn). Vùng sở hữu: `server.ts` (seam spawn + timeout), `runs.ts`.

## Vấn đề (đã xác minh 13/08)

Docker cho không: `docker kill` một phát sạch cả cây + wall-clock 30 phút + orphan sweep theo label. Host mode hiện tại:
- `spawn(...)` tại `server.ts` ~L12435-12444 **không `detached`** → không có process group riêng.
- `runs.ts` ~L191-253 kill **chỉ con trực tiếp** — MCP stdio con, vite, python cháu sống sót thành orphan.
- Wall-clock 30' tại `server.ts` ~L12461-12474 gate `if (sandboxPlan && ...)` → host run KHÔNG có trần thời gian (chỉ có inactivity watchdog `resolveChatRunInactivityTimeoutMs` ~L3585).
- Orphan sweep khởi động (`server.ts` ~L18950-18975) chỉ quét container.

## Thiết kế

1. **Process group** (darwin/linux): spawn host run với `detached: true`; kill bằng `process.kill(-pid, signal)` (SIGTERM → grace 5s → SIGKILL). Windows: best-effort `taskkill /PID <pid> /T /F` (daemon dev trên Windows vẫn tồn tại dù không còn là target end-user — không đầu tư hơn mức này).
   - Chỉ áp cho nhánh host (`!sandboxPlan`). Nhánh sandbox giữ nguyên (docker CLI child + `killSandboxContainer`).
   - Kiểm tra tương tác với `sandbox-exec` wrapper (write isolation): `sandbox-exec` là parent của agent — kill group phủ cả hai. Xác nhận `wrapInvocationInWriteIsolation` không phá `detached`.
   - Điểm sửa kill: `runs.ts` các nhánh cancel (~L191-228) và shutdown (~L243-253) — tách helper `killRunProcessTree(run)` dùng chung.
2. **Wall-clock timeout cho host**: mở rộng timer ~L12461 chạy cho CẢ host run; lấy cùng `timeoutMinutes` từ sandbox prefs (mặc định 30) — đổi tên biến đọc config thành trung tính (vd `runTimeoutMinutes`) nhưng GIỮ key config cũ để không phá app-config đã lưu. Hết giờ: kill tree + close run với lý do timeout (SSE error message nói rõ "quá 30 phút").
3. **Orphan sweep host**: khi daemon khởi động, quét process mồ côi của lần chạy trước. Dùng process-stamp primitive có sẵn trong `@open-design/platform` (spec cũ §4.4 đã chỉ) — stamp env con (vd `OD_RUN_STAMP=<runId>`), sweep = liệt kê process mang stamp (ps + grep env qua `ps eww` trên darwin hoặc đọc `/proc/*/environ` trên Linux) rồi kill tree. Nếu primitive platform không khớp nhu cầu, fallback: ghi pid-file per-run trong `<OD_DATA_DIR>/runs/` và sweep theo file lúc boot.
4. KHÔNG làm ở WP này: giới hạn CPU/RAM/PID per-run (chấp nhận mất so với Docker — đã chốt trong phân tích; ghi chú vào docs của WP4).

## Tests (red-spec trước)

- `apps/daemon/tests/` mới `host-lifecycle.test.ts`:
  - Spawn cây giả (sh cha sinh sleep con) qua helper → `killRunProcessTree` → cả cha lẫn con chết.
  - Host run vượt timeout giả lập (timeout đặt nhỏ) → run close với status timeout, cây chết.
  - Sweep: tạo process giả mang stamp → boot-sweep giết được.
- Test hiện có về cancel/close (`runs`, `chat-route`) vẫn xanh.

## Ngoài phạm vi

- Đổi mặc định sandbox (WP4). UI hiển thị timeout (WP4 nếu cần).
- Resource limits (cgroup/ulimit) — ghi nhận là non-goal.

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` + test mới xanh; không tăng đỏ baseline.
2. Kịch bản tay (ghi vào report): chạy 1 chat run host (`OD_SANDBOX=0`) rồi Cancel → `ps` không còn process con nào của run (kể cả MCP stdio).
3. Restart daemon giữa chừng một run → boot sweep dọn sạch, log ghi số process đã dọn.
