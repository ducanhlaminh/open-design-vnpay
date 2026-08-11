# Xóa dự án đã lấy về máy

`DELETE /api/pipelines/apps/:appId` là thao tác **chỉ trên máy hiện tại**. API
xóa App local, toàn bộ Feature thuộc App và các thư mục làm việc tương ứng; nó
không đọc hoặc xóa artifact trên KGS, media-service hay Pipeline Studio.

Response thành công:

```json
{
  "ok": true,
  "deletedFeatures": 2,
  "localOnly": true
}
```

Sau khi xóa, App không còn trong `GET /api/pipelines/apps`. Bản kho chung vẫn
được liệt kê qua `GET /api/kg/remote-projects`, vì vậy người dùng có thể lấy lại
dự án và tạo một local mirror mới. Xóa local phải hoạt động cả khi các dịch vụ
kho chung đang offline.

Xóa riêng một Feature tiếp tục dùng `DELETE /api/projects/:featureId`; App và
các Feature cùng cấp không bị ảnh hưởng.

Regression route-level nằm tại
`apps/daemon/tests/pulled-project-local-delete.integration.test.ts` và bao phủ:

- lấy về → xóa local → bản remote không đổi → lấy lại;
- xóa khi kho chung offline;
- xóa một Feature không làm mất App hoặc Feature cùng cấp.
