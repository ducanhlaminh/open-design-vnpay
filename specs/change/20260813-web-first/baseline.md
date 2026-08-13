# WP0 — Baseline (chạy lại)

Ngày giờ chạy: 2026-08-13 14:06:54 +0700
Commit HEAD: `2c55c27c6c44ac93c64a0de569a12ba6b6b5676c`
Nhánh: `main`
Máy: macOS 26.5.1 (BuildVersion 25F80), 10 core / 16 GB RAM.

## 1. Kết quả lệnh

| Lệnh | Pass | Fail | Ghi chú |
|---|---|---|---|
| `pnpm guard` | ✅ toàn bộ check | 0 | Xem chi tiết log ở mục "guard" bên dưới. |
| `pnpm typecheck` | ✅ toàn bộ workspace | 0 | Chạy nền do vượt timeout tương tác, hoàn tất exit code 0. |
| `pnpm --filter @open-design/daemon test` | 338 file / 3975 test | 3 file / 3 test | Danh sách fail ở mục "Nhóm đỏ baseline". Có 2 skip, 4 todo. Duration 263.68s. |
| `pnpm --filter @open-design/web test` | — | — | **CHƯA CHẠY — bị SKIP theo quyết định chủ dự án** (xem mục "Web test — lý do skip" bên dưới). Không được coi là "xanh". |
| `pnpm --filter @open-design/contracts test` | 17 file / 128 test | 0 | Duration 570ms. |

### guard — chi tiết pass
`tsx ./scripts/guard.ts` + style-policy test: tất cả check (residual JS, dependency spec, test layout, style policy, design-system manifest/token/A1/A2/B-slot/flag-parity/component-manifest) đều PASS. 6/6 style-policy unit test pass. Không có fail.

## 2. Nhóm đỏ baseline (WP sau KHÔNG được làm tăng danh sách này)

`pnpm --filter @open-design/daemon test` — 3 test fail sẵn từ baseline:

1. `tests/bas-client.test.ts` › `fetchConfluencePages follows seed links depth-1, rewrites cross-page links, marks linked pages`
   — assertion regex `/\[BO spec\]\(\.\/BO-SPEC\.md\)/` không khớp; nội dung trả về giữ nguyên link gốc `../context/BO-SPEC.md` thay vì rewrite thành `./BO-SPEC.md`.
2. `tests/diagnostics-export.test.ts` › `diagnostics export handler — non-sidecar launch > emits a standalone-launch warning when runtime is null`
   — kỳ vọng `manifest.files` rỗng nhưng nhận về 1 file crash-report thật đang tồn tại trên máy này (`/Library/Logs/DiagnosticReports/Open Design 0.8.43 Helper (Renderer)_2026-08-13-125149_...diag`). **Nghi ngờ đây là fail do môi trường máy cục bộ (có crash log thật), không phải logic sai** — cần xác nhận lại trên máy CI/sạch.
3. `tests/mcp-spawn.test.ts` › `spawn writes external MCP config for Claude Code > writes .mcp.json into the per-project dir, then removes it when servers are cleared`
   — lỗi `Error: run did not finish` tại `waitForRunStatus`. Chạy đơn lẻ lúc hệ thống đang tải nặng (xem mục dưới) — cần chạy lại để xác nhận có phải flaky do tải hay lỗi thật.

`pnpm --filter @open-design/contracts test`: 0 fail — không có nhóm đỏ.

`pnpm --filter @open-design/web test`: **không xác định được** — xem mục dưới.

## 3. Web test — lý do skip (KHÔNG có baseline đỏ cho web)

Hai lần thử chạy `pnpm --filter @open-design/web test` đều bị dừng thủ công (kill) trước khi hoàn tất:

- Lần 1: phát hiện một tiến trình `pnpm --filter @open-design/web test` **mồ côi** (PID 11840, `ppid=1`) đã chạy sẵn ~11 phút, 2 worker vitest ăn liên tục >98–107% CPU, kéo load average hệ thống lên ~13 — không rõ có phải do lần chạy trước đó trong phiên bị treo hay không. Đã kill để giải phóng tài nguyên.
- Lần 2: chạy lại sạch, nhưng theo yêu cầu chủ dự án, đã kill sớm để chuyển sang bước khác của plan thay vì chờ hoàn tất.

Khảo sát tĩnh (không chạy hết suite) để tìm nguyên nhân chậm:
- 286 file test, 2525 test case, 480 `describe`.
- 167/286 file (~58%) chạy dưới `environment: jsdom` (render DOM thật qua `@testing-library/react`) — nặng hơn nhiều so với daemon (toàn bộ node-only, không DOM).
- 3 file lớn nhất: `FileViewer.test.tsx` (3149 dòng, 49 lần `render()`), `DesignSystemFlow.test.tsx` (2428 dòng, 30 lần `render()`), `SettingsDialog.execution.test.tsx` (2721 dòng, nhiều `waitFor` timeout 2000–2500ms).
- Không tìm thấy config giới hạn `maxForks`/`poolOptions` bất thường, không tìm thấy fetch mạng thật chưa mock, chỉ có 1 chỗ dùng real `setTimeout(1100ms)`.
- Máy đủ tài nguyên (10 core / 16GB), không bị giới hạn bởi container/sandbox (`os.availableParallelism()` = 10, khớp host).

**Kết luận tạm thời:** nhiều khả năng là chi phí hợp lý của một suite nặng jsdom/component-integration (không phải bug), nhưng chưa có bằng chứng đo thời lượng thật (per-file timing) để loại trừ khả năng có test bị treo thật sự. **Việc xác nhận danh sách đỏ baseline cho web CÒN THIẾU — cần chạy lại và hoàn tất trước khi bất kỳ WP nào động tới `apps/web` được coi là "không làm đỏ thêm" so với baseline.**

## 4. Cấu hình host-mode (chỉ đọc, không sửa)

- `~/od-data/vnpay-design/app-config.json` → `sandbox`: `{ "enabled": true, "runtimes": ["claude"], "skills": ["ui-react"] }` — đúng như dự kiến (`enabled:true` + skill legacy `ui-react`).
- `.env.local` → `OD_WRITE_ISOLATION=on`.
- `claude --version` → `2.1.229 (Claude Code)`.
- `security find-generic-password -s "Claude Code-credentials"` (chỉ attribute, không `-w`) → tìm thấy entry (`acct="anhnd13"`, `svce="Claude Code-credentials"`, `mdat=2026-08-13T05:14:45Z`) ⇒ **CLI có cài, có login** (credential tồn tại trong keychain).

## 5. Smoke run thật

Chưa chạy — theo đúng phạm vi WP0 (tốn quota, là bước manual của chủ dự án).
