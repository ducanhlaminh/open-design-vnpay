# Cập nhật Figma Design System và App Context

Luồng này thay source Figma của một Design System hiện có mà không làm Feature đang chạy đổi Context ngoài ý muốn.

## Vòng đời

1. `POST /api/design-systems/:id/figma-update` nhận ZIP mới và tạo candidate version. Design System hiện hành và App Context hiện hành chưa đổi.
2. `components.md` và `rules.md` đã duyệt được giữ nguyên nhưng có trạng thái `stale`. Hệ thống không tự sinh và không tự duyệt hai file này.
3. Người dùng chủ động sinh bản nháp, xem nội dung, rồi duyệt từng file qua endpoint criteria tương ứng.
4. `POST /api/design-systems/:id/figma-update/approve` mới promote candidate và tạo App Context mới cho các App đang dùng Design System. Nếu criteria còn stale/missing, request phải gửi `confirmStaleCriteria: true`.
5. Feature tiếp tục giữ `appContextBinding` cũ. Người dùng xem diff Context và xác nhận nâng từng Feature; thay đổi chỉ áp dụng cho lần chạy sau.

## Invariant tích hợp

- Upload hoặc duyệt riêng criteria không được tạo App Context version.
- Final approval là điểm duy nhất phát hành App Context mới từ DS candidate.
- Push/Share chuyển cả Context version Feature đang bind; Pull cài Context nhưng không đổi binding.
- Run luôn stage immutable package đã bind, không đọc lại source DS hiện hành.
- Xóa source DS cũ sau approval không được xóa `projects/<appId>/context/versions/**`; run lịch sử vẫn phải stage được criteria và token từ snapshot.

## Kiểm tra cục bộ

```bash
pnpm --filter @open-design/contracts typecheck
pnpm --filter @open-design/daemon test -- app-context-version design-system-update
pnpm --filter @open-design/web test -- context-sync
```

Khi kiểm thử thủ công, ghi lại version trước upload, sau upload và sau final approval. Version chỉ được tăng ở bước cuối; Feature phải tiếp tục hiện bản binding cũ cho tới khi người dùng bấm xác nhận dùng bản mới.
