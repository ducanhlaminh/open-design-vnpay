# 2.1.3. URD Quản lý khách hàng

*A - Tạo mới; M - Sửa đổi; D - Xóa bỏ*

## 1. Tóm tắt tính năng

Xem thêm [BO spec](./BO-spec.md) và [ticket](https://jira.example.com/browse/PRJ-1).

> Tài liệu này thay thế bản V.0.

### 1.1 Phạm vi

Áp dụng cho phân hệ Bán hàng.

```
GET /api/v1/customers?status=active
Authorization: Bearer <token>
```

---

## 2. Ràng buộc

Mã khách hàng theo mẫu `KH-{số}`.