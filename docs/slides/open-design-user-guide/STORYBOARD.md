---
workflow: slideshow
mode: autonomous
message: "Open Design đưa một yêu cầu từ tài liệu đầu vào đến kết quả đã duyệt và sẵn sàng chia sẻ"
audience: "Designer, BA, PO và người review tài liệu"
aspect: 1920x1080
language: vi
---

# Storyboard

1. **Open Design biến tài liệu thành kết quả có thể duyệt và chia sẻ.** Cover với đường đi 5 chặng.
2. **Ba tầng Dự án → Tính năng → Quy trình giúp công việc không bị trộn lẫn.** Cây thư mục sản phẩm.
3. **Chỉ cần hoàn tất ba bước để sẵn sàng chạy trợ lý AI.** Docker, Google, Claude/Codex; hotspot xử lý setup.
4. **Một Dự án gom nhiều Tính năng, nhưng mỗi Tính năng chạy độc lập.** Mock danh sách Dự án/Tính năng.
5. **Ba quy trình giải quyết ba loại đầu ra khác nhau.** Ba tuyến đường từ URD/PRD.
6. **Đầu vào đúng quyết định chất lượng của toàn bộ kết quả phía sau.** Picker Confluence và tệp local.
7. **Một bước chỉ hoàn tất khi đã có bản xem trước hợp lệ.** Stepper running/success/error; hotspot xử lý lỗi chạy.
8. **Kết quả của trợ lý AI luôn cần con người xem và xác nhận.** Split review giữa bản gợi ý và quyết định.
9. **Design System được cập nhật theo phiên bản, không âm thầm đổi Tính năng đang dùng.** Version rail và criteria.
10. **Chia sẻ luôn bắt đầu bằng việc xem trước cây thay đổi.** Tree-folder với create/change/delete.
11. **Lấy về luôn cho bạn quyền chọn khi hai phía xung đột.** Local vs kho chung, hai resolution.
12. **Bốn trạng thái cho biết chính xác quan hệ giữa máy và kho chung.** Tạo mới/Không thay đổi/Có thay đổi/Đã xóa.
13. **Một vòng làm việc tốt luôn kết thúc bằng review trước khi chia sẻ.** Vòng 6 bước.
14. **Bàn giao tốt nghĩa là người tiếp theo có đủ tài liệu, Context và quyền.** Checklist kết thúc.

## Branch: Setup

15. **Nếu setup chưa sẵn sàng, xử lý theo thứ tự Docker → đăng nhập → quota.** Decision ladder.

## Branch: Run failure

16. **Mất mạng hoặc hết quota không bao giờ được tính là hoàn tất.** Recovery checklist và quay lại preview.
