# Đồng bộ Dự án và Tính năng với kho chung

Mỗi Dự án và Tính năng trên máy có thể đối chiếu với **bản đích** của nó trong kho
chung. Bản đích là bản đã được liên kết trước đó; nó không được suy ra từ
tên hiển thị.

Thiếu liên kết không bao giờ được suy ra theo ID trùng nhau: trạng thái là
`Tạo mới` cho tới khi người dùng chọn một bản trong kho chung hợp lệ hoặc tạo
ID mới. Sau Apply thành công, liên kết đã chọn được lưu cho lần đồng bộ sau.

## Chọn đúng phạm vi

- **Đẩy/Lấy Dự án** xử lý Dự án và toàn bộ Tính năng con. Đây là lựa chọn đúng khi
  muốn đưa hoặc lấy lại cả sản phẩm, và không có ô chọn để bỏ riêng một
  Tính năng.
- **Đẩy/Lấy Tính năng** chỉ xử lý Tính năng đang chọn. Dùng lựa chọn này khi
  thay đổi chỉ thuộc một tính năng.
- Mỗi thao tác luôn mở phần xem trước trước khi ghi. Dự án/Tính năng trên máy vẫn
  xuất hiện trong danh sách, kể cả khi bản đích đã bị ẩn, bị xóa, hoặc
  liên kết không còn hợp lệ.

## Bốn trạng thái đồng bộ

| Trạng thái | Ý nghĩa | Push | Pull |
| --- | --- | --- | --- |
| Đồng bộ | Bản trên máy và bản trong kho chung có cùng nội dung | Không cần thay đổi | Không cần thay đổi |
| Có thay đổi | Cả hai phía có thể có khác biệt | Cập nhật bản chung sau khi xem kế hoạch | Lấy thay đổi sau khi chọn cách xử lý xung đột |
| Tạo mới | Chưa có bản đích hợp lệ | Tạo bản đích mới | Không có bản để lấy |
| Liên kết không hợp lệ | Bản đích đã bị ẩn/không tồn tại, hoặc liên kết không khớp loại/phạm vi | Xem lại kế hoạch; không ghi đè nhầm bản đích | Chưa thể lấy cho tới khi liên kết hợp lệ |

`Tạo mới` tạo **ID bản đích mới**. Nó không tái sử dụng một ID cũ chỉ vì tên Dự án
hoặc Tính năng trùng nhau. Khi đẩy Dự án để tạo mới, các Tính năng con được tạo và liên
kết trong cùng phạm vi Dự án; không thể loại riêng Tính năng khỏi thao tác này.

## Pull và xung đột tệp

Kế hoạch Pull liệt kê tệp mới và từng tệp xung đột. Với mỗi xung đột, chọn một
trong hai cách:

- **Dùng bản trong kho chung**: ghi bản chung về máy.
- **Giữ bản trên máy**: giữ nguyên tệp hiện có trên máy.

Tệp mới từ kho chung được lấy theo kế hoạch. Không có tệp trên máy nào bị ghi đè âm
thầm; phần xem trước là nơi xác nhận từng quyết định trước khi áp dụng.

## Kế hoạch hết hạn

Kế hoạch là ảnh chụp ngắn hạn để tránh ghi dựa trên dữ liệu cũ. Nếu Apply trả
về `PLAN_EXPIRED`, không thử lại cùng `planId`: mở lại xem trước để lấy kế
hoạch mới, kiểm tra thay đổi, rồi áp dụng lại. Tương tự, tệp đã đổi trong kho chung
sau lúc lập kế hoạch sẽ được báo là stale/thay đổi thay vì bị ghi mù.

## CLI

CLI gọi cùng API với UI. Các lệnh thường dùng:

```bash
# Chỉ liệt kê bản đích đang hiển thị và hợp lệ để chọn
od project-sync origins --json

# Đọc trạng thái của toàn bộ dữ liệu trên máy hoặc phạm vi được chỉ định
od project-sync status --json
od project-sync status --kind feature --project checkout --app-id retail --json

# Tạo plan trước khi ghi; sau đó Apply plan đã xem
od project-sync plan --direction push --kind app --project retail --new-origin retail-origin --json
od project-sync plan --direction pull --kind feature --project checkout --app-id retail --json
od project-sync apply --plan-id plan-id --resolution docs/spec.md=pull --json
```

Khi chạy không có `--json`, CLI in kết quả đọc được; thêm `--json` cho script
hoặc automation. `plan` trả về `planId`; chỉ `apply` mới ghi. Đưa lựa chọn
bản đích, phạm vi và cách xử lý vào JSON theo contract của lệnh. Nếu Apply trả về
`PLAN_EXPIRED`, chạy lại `plan`, xem lại thay đổi, rồi gọi `apply` với plan mới.
Plan cho thực thể chưa liên kết phải nêu rõ bản đích (`existing` hoặc `new`); nếu
không API trả `ORIGIN_REQUIRED`. Một đích đã ẩn không thể được tái dùng và sẽ
trả `ORIGIN_HIDDEN_REQUIRES_NEW_ID` — chọn hoặc tạo ID mới.
