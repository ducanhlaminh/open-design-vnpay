# WP0 — Baseline & smoke host mode

Ước lượng: 0.5 ngày. Phụ thuộc: không. Có thể chạy song song WP1.

## Mục tiêu

Chụp trạng thái test/typecheck TRƯỚC khi mọi WP khác sửa code (repo có nhóm test đỏ sẵn từ baseline — tránh đổ oan cho WP sau), và xác nhận đường chạy host (`OD_SANDBOX=0`) hoạt động ở mức cấu hình.

## Việc cụ thể

1. Chạy lần lượt, ghi kết quả đầy đủ (pass/fail count + tên test fail):
   - `pnpm guard`
   - `pnpm typecheck`
   - `pnpm --filter @open-design/daemon test`
   - `pnpm --filter @open-design/web test`
   - `pnpm --filter @open-design/contracts test` (nếu có script test)
2. Ghi kết quả vào `specs/change/20260813-web-first/baseline.md` theo format:
   - Ngày giờ chạy, commit HEAD (`git rev-parse HEAD`), nhánh.
   - Bảng: lệnh | pass | fail | danh sách test fail (tên file + tên test).
   - Mục "Nhóm đỏ baseline" — các fail tồn tại sẵn, WP sau KHÔNG được làm tăng danh sách này.
3. Xác minh cấu hình host-mode trên máy này (chỉ đọc + ghi nhận, KHÔNG sửa code):
   - Đọc `~/od-data/vnpay-design/app-config.json` → ghi lại giá trị `sandbox` hiện tại vào baseline.md (dự kiến `enabled:true` + skills legacy).
   - Đọc `.env.local` → ghi lại `OD_WRITE_ISOLATION` hiện tại.
   - Kiểm tra `claude --version` và `probeClaudeAuthStatus` gián tiếp: chạy `security find-generic-password -s "Claude Code-credentials"` (chỉ attribute, không `-w`) → ghi "CLI có/không, login có/không".
4. KHÔNG chạy pipeline thật (tốn quota). Smoke run thật là bước manual của chủ dự án, ghi chú lại trong baseline.md là "chưa chạy".

## Ngoài phạm vi

- Sửa bất kỳ file source/test nào.
- Sửa app-config.json hay .env.local.

## Acceptance & Verify

- `baseline.md` tồn tại, có đủ 4 mục trên, danh sách test đỏ baseline liệt kê tường minh từng tên test (không ghi chung chung "một số fail").
