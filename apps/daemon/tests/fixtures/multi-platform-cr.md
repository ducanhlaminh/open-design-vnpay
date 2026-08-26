---
title: [CR] - Fixture đa nền tảng (rút gọn từ CR Hỗ trợ trực tuyến GĐ2)
page_id: 946866388
source: confluence
---

<!-- Fixture chuẩn cho screen-variants (docs/screen-variants-spec.md, subplan
     T0). Rút gọn từ observation 76422f1f239d: giữ đúng các pattern hệ phải
     xử lý — (1) luồng bước đánh số nhắc màn bằng TÊN IN ĐẬM không mã màn,
     (2) bảng MB/IB `Hiện trạng | Thay đổi | Mô tả` mỗi màn 2 dòng, ≥3 màn
     trùng tên giữa hai bảng + 1 cặp tên gần-giống (ca mờ cho agent),
     (3) mục BO dạng heading đậm + ảnh + bullet, (4) BR chứa chữ "SDK" để
     test rằng platform theo section KHÔNG bị hint toàn-file kéo lệch. -->

- I. Phạm vi thay đổi
- II. Mô tả thay đổi

## **I. Phạm vi thay đổi**

Chức năng hỗ trợ trực tuyến

- App EDigi (MB & IB)
- Backoffice EDigi

## **II. Mô tả thay đổi**

### 2.1 Luồng xử lý khởi tạo yêu cầu

1. KH truy cập chức năng **Hỗ trợ trực tuyến**
2. KH chọn **Quản lý yêu cầu của tôi**
3. KH chọn vào thông tin giao dịch để mở màn hình **Chi tiết giao dịch**
4. Hệ thống EDigi hiển thị màn hình **Tạo yêu cầu hỗ trợ**
5. KH thực hiện xác thực Smart OTP, khởi tạo yêu cầu thành công

### 2.2 Màn hình MB

| Hiện trạng | Thay đổi | Mô tả |
| --- | --- | --- |
| **Màn hình quản lý yêu cầu của tôi** |  |  |
| ![](attachments/mb-quan-ly-cu.png) | ![](attachments/mb-quan-ly-moi.png) | • Mã yêu cầu (bổ sung)<br>• Số tiền giao dịch (bổ sung)<br>• Thời gian xử lý dự kiến (bỏ) |
| **Màn hình tạo yêu cầu hỗ trợ trực tuyến** |  |  |
| ![](attachments/mb-tao-yeu-cau.png) |  | Bổ sung màn hình tạo yêu cầu, thông tin bao gồm<br>• Lý do hỗ trợ<br>• Ghi chú<br>• Checkbox |
| **Màn hình kết quả giao dịch** |  |  |
| ![](attachments/mb-ket-qua-cu.png) | ![](attachments/mb-ket-qua-moi.png) | • Mã yêu cầu (bổ sung)<br>• Số tiền GD (bổ sung)<br>• Phản hồi (bổ sung) |
| **Màn hình danh sách lý do** |  |  |
| ![](attachments/mb-ly-do.png) |  | Danh sách lý do hỗ trợ hiển thị theo **Loại giao dịch + Trạng thái giao dịch** |

### 2.3 Màn hình IB

| Hiện trạng | Thay đổi | Mô tả |
| --- | --- | --- |
| **Màn hình quản lý yêu cầu của tôi** |  |  |
| ![](attachments/ib-quan-ly-cu.png) | ![](attachments/ib-quan-ly-moi.png) | • Mã yêu cầu (bổ sung)<br>• Số tiền giao dịch (bổ sung)<br>• Thời gian xử lý dự kiến (bỏ) |
| **Màn hình tạo yêu cầu hỗ trợ trực tuyến** |  |  |
| ![](attachments/ib-tao-yeu-cau.png) |  | Bổ sung màn hình tạo yêu cầu, thông tin bao gồm<br>• Lý do hỗ trợ<br>• Ghi chú<br>• Checkbox |
| **Màn hình kết quả giao dịch** |  |  |
| ![](attachments/ib-ket-qua-cu.png) | ![](attachments/ib-ket-qua-moi.png) | • Mã yêu cầu (bổ sung)<br>• Số tiền GD (bổ sung) |
| **Popup danh sách lý do hỗ trợ** |  |  |
| ![](attachments/ib-ly-do.png) |  | Danh sách lý do hỗ trợ hiển thị theo **Loại giao dịch + Trạng thái giao dịch** |

### 2.4 Màn hình BO quản lý yêu cầu hỗ trợ

**Màn hình quản lý yêu cầu hỗ trợ**

![](attachments/bo-quan-ly.png)

Bổ sung thông tin

- Khu vực tìm kiếm
  - Ngày KH đánh giá
- Bảng dữ liệu
  - Lý do cần hỗ trợ

**Màn hình chi tiết yêu cầu hỗ trợ - GDV tiếp nhận yêu cầu**

![](attachments/bo-chi-tiet.png)

Bổ sung mục phản hồi, cho phép GDV nhập nội dung

### 2.5 Các yêu cầu nghiệp vụ bổ sung

| Business Rules | Mô tả | Ghi chú |
| --- | --- | --- |
| BR-1 | 1 mã giao dịch được tạo 1 yêu cầu hỗ trợ trực tuyến |  |
| BR-2 | Hiển thị tin OTT thông báo cập nhật trạng thái. Hiện tại chức năng điều hướng OTT chỉ áp dụng cho các SDK của app và deeplink đến website bên ngoài |  |
