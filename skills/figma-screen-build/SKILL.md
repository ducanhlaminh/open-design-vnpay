---
name: figma-screen-build
description: |
  Dựng một màn NGAY TRONG Figma bằng instance thật của Design System — import
  component theo key, ghép frame, override text theo nội dung thật (không bịa
  layout). Idempotent theo tên frame (regen = THAY, không THÊM) và chỉ đụng
  MỘT file Figma (file preview) — TUYỆT ĐỐI không mở/sửa file DS hay file nào
  khác. Dùng bởi job nền "Dựng trong Figma" của bước Màn hình → Component
  (docs-review).
triggers:
  - "dựng màn trong figma"
  - "figma screen build"
  - "dựng trong figma"
od:
  mode: utility
  category: figma
---

# figma-screen-build — dựng một màn trong Figma từ instance DS thật

Bạn chạy **không có người ngồi cạnh** (job nền, một lượt/màn). Nhiệm vụ DUY
NHẤT: đọc `comp/figma-build/<SCREEN-KEY>.input.json` (đường dẫn tính từ cwd
của bạn — job kickoff nêu đúng đường dẫn), dựng đúng MỘT frame trong file
Figma preview theo hợp đồng dưới đây, rồi ghi ĐÚNG MỘT file
`comp/figma-build/<SCREEN-KEY>.result.json` cùng thư mục. Không hỏi lại,
không chờ xác nhận — chọn mặc định hợp lý theo `input.json` và hoàn thành.

## Hợp đồng chống rác (cứng — vi phạm là lỗi nghiêm trọng)

1. **Chỉ đụng file `previewFileKey`** (field trong input.json). TUYỆT ĐỐI
   không mở, không sửa bất kỳ file Figma nào khác — kể cả `dsFileKey`, việc
   duy nhất bạn được làm với nó là **import component theo `key`** (component
   sang file preview vẫn giữ nguyên `key` gốc, không cần mở file DS).
2. **Trang**: tìm trang tên đúng `pageName` (input.json) trong file preview.
   Có → dùng nó. Không có → tạo mới, đặt tên đúng `pageName`.
3. **Idempotent theo tên frame**: trong trang đó, tìm frame tên đúng
   `frameName`. Có → ghi nhớ vị trí `{x, y}` của nó rồi **XÓA** frame đó,
   dựng frame MỚI cùng tên tại ĐÚNG vị trí cũ (regen = THAY, không phải
   THÊM — không bao giờ để hai frame cùng tên tồn tại song song). Không có
   frame cũ → xếp cạnh frame `[OD] …` gần nhất trong trang (cách ~100px),
   không đè lên node nào khác; không có frame `[OD]` nào → góc trên-trái
   trang, cách mép ~100px.
4. Mọi node bạn tạo phải nằm **bên trong** frame đó — không rải node ra
   ngoài trang.

## input.json — shape

```json
{
  "schema_version": 1,
  "screenKey": "SCR-001",
  "screenName": "Đăng nhập",
  "appFeature": "Ví điện tử",
  "previewFileKey": "abc123XYZ",
  "dsFileKey": "ZGM77akVOW7JyhsVv6FidK",
  "platform": "mobile",
  "pageName": "[OD] Ví điện tử",
  "frameName": "SCR-001 — Đăng nhập",
  "elements": [
    {
      "id": "el-1",
      "role": "primary-button",
      "label": "Nút Đăng nhập",
      "content": { "text": "Đăng nhập" },
      "component": { "name": "Button", "key": "abcdef0123456789", "variantNodeId": "10:2", "setNodeId": "10:1", "variant": "State=Default" }
    },
    { "id": "el-2", "role": "heading", "label": "Tiêu đề", "content": { "text": "Chào mừng trở lại" } }
  ],
  "rules": { "scope": "…", "naming": "…", "idempotent": "…" }
}
```

- `elements[]` đã ĐÚNG THỨ TỰ bố cục (thứ tự xuất hiện trong wireframe) — dựng
  theo đúng thứ tự này, từ trên xuống (auto-layout dọc).
- `component` **vắng mặt** → phần tử không có DS component tương ứng: dựng
  một TEXT/FRAME đơn giản từ `label`/`content`, không cố map sang component
  nào.
- `component.variantNodeId` + `component.setNodeId` có mặt → component này
  thuộc một COMPONENT_SET; import/instantiate đúng **variant** đó (không phải
  set). Chỉ `component.key` (không có `variantNodeId`) → component độc lập,
  import thẳng bằng key đó.
- `component.warning` (nếu có, xem input.json thật) không phải lỗi của bạn —
  daemon đã tự chọn phương án dự phòng (ví dụ variant mặc định khi không khớp
  chuỗi variant của screen). Cứ dựng theo `component` đã cho.

## Các bước dựng

1. Mở file `previewFileKey` (dùng công cụ MCP Figma tương đương "mở file theo
   key/id" — xem mục "Tên tool MCP" bên dưới).
2. Áp mục "Idempotent theo tên frame" ở trên: xác định vị trí, xóa frame cũ
   nếu có, tạo frame mới rỗng tại đúng vị trí, đặt tên `frameName`. Kích
   thước khung: `platform === 'mobile'` → rộng 390; `'web'` → rộng 1440. Auto
   layout dọc (padding + gap hợp lý, tối thiểu 16px), chiều cao tự co giãn
   theo nội dung.
3. Với từng phần tử trong `elements[]`, THEO ĐÚNG THỨ TỰ:
   - Có `component`: import component theo `key` (variant hoặc độc lập, xem
     trên) từ `dsFileKey` sang file hiện tại, tạo instance trong frame. Nếu
     instance hỗ trợ set thuộc tính variant (component thuộc set) và bạn có
     cách xác nhận lại variant qua API, xác nhận nó khớp `variantNodeId`
     trước khi override text — KHÔNG tự đổi variant khác.
   - Override phần TEXT bên trong instance bằng `content` (field nào có thì
     dùng field đó — `text`, `secondary`, `value`, `badge`, `items` là danh
     sách nhiều dòng): tìm layer text tương ứng bên trong instance theo tên
     lớp hợp lý (ví dụ lớp tên "Label"/"Title"/"Text" khớp với `role`), load
     font của layer đó TRƯỚC khi set characters (bắt buộc với Figma API).
   - Không có `component`: tạo một TEXT node đơn giản từ `label`/`content`
     (không cố dựng UI phức tạp).
   - Một phần tử lỗi (component không import được, layer text không tìm
     thấy…) → GHI một dòng vào `warnings[]` của result.json, **đừng** dừng cả
     màn — dựng tiếp các phần tử còn lại.
4. Sau khi dựng xong, lấy `nodeId` của frame vừa tạo, ghi
   `comp/figma-build/<SCREEN-KEY>.result.json`:

```json
{
  "frameNodeId": "12:34",
  "frameUrl": "https://www.figma.com/design/<previewFileKey>/?node-id=12-34",
  "warnings": ["Element el-3: không tìm thấy layer text khớp — bỏ qua override."]
}
```

   `frameUrl`'s `node-id` = `frameNodeId` với `:` đổi thành `-`. KHÔNG ghi
   file nào khác ngoài `result.json` này (không sửa `input.json`, không tạo
   file phụ trong `comp/figma-build/`).

## Tên tool MCP

Tên tool MCP Figma dạng `mcp__<server>__*` có thể khác nhau tuỳ server người
dùng đã thêm trong Cài đặt → MCP (server chính thức của Figma hay một server
tương thích khác) — ĐỪNG hard-code một tên tool duy nhất. Liệt kê tool khả
dụng của server đó trước, rồi chọn theo NĂNG LỰC cần dùng, ưu tiên theo thứ
tự:

1. Một tool "execute code"/"run script" chung (ví dụ `use_figma`,
   `execute_figma_command`) — chạy trực tiếp code Figma Plugin API
   (`figma.importComponentByKeyAsync`, `instance.setProperties`,
   `node.setRangeCharacters`/`characters =`, …) là cách chắc chắn nhất để
   thực hiện đúng hợp đồng chống rác ở trên (xóa-rồi-dựng-lại theo tên, tạo
   trang theo tên).
2. Nếu server KHÔNG có tool "execute code", dùng tổ hợp tool chuyên biệt
   tương đương (tạo file/mở file theo key, tạo frame, import component,
   set text) — vẫn phải đọc kỹ input.json và tự đảm bảo đúng thứ tự elements
   + đúng variant + đúng vị trí frame.

Nếu **không tìm thấy tool Figma nào có thể ghi** (server chỉ đọc), coi đây là
lỗi của job (không phải của bạn) — vẫn cố ghi `result.json` với
`frameNodeId` rỗng bị bỏ; job sẽ đánh dấu màn này "failed" và người dùng sẽ
thấy thông báo cần kiểm tra lại Figma MCP trong Cài đặt.
