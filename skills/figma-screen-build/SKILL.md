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
5. **CẤM text bù**: khi override text (bước 3) THẤT BẠI ở bất kỳ mức nào —
   không tìm được layer trống, layer không sửa được, component lỗi… — bạn
   CHỈ được ghi một dòng vào `warnings[]`. TUYỆT ĐỐI không tạo TEXT node
   "dự phòng" đặt cạnh hay đè lên instance để hiển thị thay nội dung thật —
   đây chính là nguyên nhân gây text trùng lặp rác (ví dụ "eSIM Trung Quốc"
   xuất hiện 2 lần: một lần trong instance không override được, một lần do
   bạn tự chèn bù). TEXT node trần chỉ được phép tạo cho phần tử KHÔNG có
   `component` (bước 3, mục "Không có `component`") — không có ngoại lệ
   nào khác.

## input.json — shape

```json
{
  "schema_version": 2,
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
  "layout": [
    { "type": "heading", "text": "Thông tin đăng nhập" },
    { "type": "row", "children": [{ "type": "el", "id": "el-1" }, { "type": "el", "id": "el-2" }] }
  ],
  "mockups": ["docs-feature/attachments/image-12.png"],
  "rules": { "scope": "…", "naming": "…", "idempotent": "…" }
}
```

- `elements[]` đã ĐÚNG THỨ TỰ bố cục (thứ tự xuất hiện trong wireframe) — mỗi
  phần tử ở đây được dựng theo đúng mục "Dựng MỘT phần tử" bên dưới, BẤT KỂ
  bạn đang xếp phẳng hay đệ quy theo `layout`.
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
- `layout` (mảng, TUỲ CHỌN — vắng mặt trên input.json cũ `schema_version: 1`)
  = cây bố cục THẬT của màn (hàng ngang, nhóm lồng nhau, đầu mục) suy ra tất
  định từ wireframe. **Có mặt → dựng theo cây** (mục "Dựng theo `layout`" bên
  dưới) THAY VÌ xếp phẳng. **Vắng mặt → xếp phẳng như trước** (mục "Không có
  `layout`" bên dưới) — input.json cũ vẫn dựng được, không phải lỗi.
- `mockups` (mảng đường dẫn, TUỲ CHỌN) = ảnh mockup BA — xem mục "Ảnh mockup
  tham chiếu" bên dưới.

## Các bước dựng

1. Mở file `previewFileKey` (dùng công cụ MCP Figma tương đương "mở file theo
   key/id" — xem mục "Tên tool MCP" bên dưới).
2. Áp mục "Idempotent theo tên frame" ở trên: xác định vị trí, xóa frame cũ
   nếu có, tạo frame mới rỗng tại đúng vị trí, đặt tên `frameName`. Kích
   thước khung: `platform === 'mobile'` → rộng 390; `'web'` → rộng 1440. Auto
   layout dọc (padding + gap hợp lý, tối thiểu 16px), chiều cao tự co giãn
   theo nội dung.
3. Xác định bố cục trước khi dựng:
   - Input.json có `layout` (mảng, không rỗng) → dựng ĐỆ QUY theo cây, xem
     mục "Dựng theo `layout`" ngay dưới đây — KHÔNG xếp `elements[]` thành
     một cột dọc nữa.
   - Input.json KHÔNG có `layout` (input cũ, `schema_version: 1`, hoặc
     wireframe không khớp phần tử nào) → xếp PHẲNG như trước WP29: duyệt
     `elements[]` đúng thứ tự, mỗi phần tử áp dụng mục "Dựng MỘT phần tử" bên
     dưới, append lần lượt vào frame (frame đã là auto-layout dọc từ bước 2)
     — hành vi y hệt input.json cũ, không có gì thay đổi ở đây.

### Dựng theo `layout` (khi có)

Duyệt mảng `layout` ĐÚNG THỨ TỰ, mỗi node append trực tiếp vào frame/container
cha hiện tại (bắt đầu từ chính frame màn, đã auto-layout dọc từ bước 2):

- `{"type":"el","id":"…"}` → tra `id` trong `elements[]`, dựng đúng mục "Dựng
  MỘT phần tử" bên dưới.
- `{"type":"group","id":"…","children":[…]}` → `id` cũng tra trong
  `elements[]` NHƯ MỘT PHẦN TỬ BÌNH THƯỜNG (dựng instance/text y hệt mục
  "Dựng MỘT phần tử"), rồi tạo một FRAME auto-layout DỌC mới chứa: instance/
  text của chính `id` đó ĐỨNG ĐẦU, tiếp theo là từng node trong `children`
  (đệ quy cùng quy tắc này, append vào frame dọc mới này). **LƯU Ý QUAN
  TRỌNG**: instance Figma KHÔNG nhận children — một component không thể
  thật sự "bọc" các con của nó trong Figma như trong wireframe. Đây là một
  XẤP XỈ v1: instance đứng RIÊNG ở đầu, các con xếp NGAY SAU nó trong CÙNG
  một frame dọc — TUYỆT ĐỐI không cố nhét node con vào bên trong instance
  (không có API nào làm được việc đó với một instance component).
- `{"type":"row","children":[…]}` → tạo một FRAME auto-layout NGANG mới (gap
  ~12px), dựng từng con trong `children` (đệ quy) rồi append vào frame ngang
  này theo đúng thứ tự; đặt `layoutSizingHorizontal`/`layoutSizingVertical`
  hợp lý cho từng con (FILL khi con nên giãn đều theo hàng, HUG khi con có
  kích thước cố định) sao cho tổng bề rộng không tràn mép frame ngoài cùng
  (390 mobile / 1440 web) — co nhỏ gap hoặc để các con HUG nếu cần.
- `{"type":"heading","text":"…"}` → một TEXT node đơn giản (không phải
  component), chữ đậm, cỡ ~13–14px, dùng làm nhãn đầu mục cho khối theo sau.
- Mỗi frame mới tạo cho `row`/`group` ở trên: set
  `layoutSizingHorizontal = 'FILL'` khi append nó vào cha auto-layout dọc —
  bọc try/catch, giống mục "Fill width" ở "Dựng MỘT phần tử" bên dưới.

Hai trường hợp lệch giữa `layout` và `elements[]` (daemon compile tất định
nên hiếm khi xảy ra, nhưng vẫn phải xử lý không lỗi):
- Một phần tử có trong `elements[]` nhưng KHÔNG xuất hiện ở bất kỳ đâu trong
  `layout` → dựng nối vào CUỐI frame (theo mục "Dựng MỘT phần tử") sau khi
  duyệt xong toàn bộ `layout` — không được bỏ sót phần tử nào.
- Một `id` trong `layout` không có trong `elements[]` → bỏ qua NGUYÊN node đó
  (không dựng gì cho nó, kể cả nếu nó là `group` có children — vẫn dựng
  `children` của nó bình thường, chỉ bỏ phần instance/text của chính `id`),
  ghi một dòng vào `warnings[]`.

### Ảnh mockup tham chiếu

`mockups[]` (nếu input.json có) là đường dẫn ẢNH tính từ cwd của BẠN (không
phải path trong Figma) — vd `"docs-feature/attachments/image-12.png"`. NẾU
công cụ bạn đang chạy đọc được ảnh (tool Read/xem file…), hãy MỞ XEM TỪNG ảnh
TRƯỚC KHI dựng, dùng làm chuẩn khoảng cách/gộp nhóm/tỉ lệ giữa các khối —
KHÔNG dùng để đổi cấu trúc: `layout` (khi có) hoặc `elements[]` (khi không)
VẪN LÀ NGUỒN CẤU TRÚC QUYẾT ĐỊNH, tuyệt đối không thêm/bớt/đổi thứ tự phần tử
theo ảnh. Không xem được ảnh (công cụ không hỗ trợ, hoặc `mockups` vắng mặt)
→ bỏ qua mục này, dựng theo `layout`/`elements[]` bình thường — KHÔNG coi là
lỗi, KHÔNG ghi warning.

### Dựng MỘT phần tử

Áp dụng cho mỗi phần tử tra được từ `elements[]` theo `id` — bất kể bạn đang
xếp phẳng (không có `layout`) hay đang dựng theo node `el`/`group` của cây
`layout` ở trên:

   - Có `component`: import component theo `key` (variant hoặc độc lập, xem
     trên) từ `dsFileKey` sang file hiện tại, tạo instance trong frame. Nếu
     instance hỗ trợ set thuộc tính variant (component thuộc set) và bạn có
     cách xác nhận lại variant qua API, xác nhận nó khớp `variantNodeId`
     trước khi override text — KHÔNG tự đổi variant khác.
   - **Fill width**: ngay sau khi append instance vào frame (frame là
     auto-layout dọc), set `instance.layoutSizingHorizontal = 'FILL'` —
     bọc trong try/catch, một số component không cho set fill thì bỏ qua
     (không phải lỗi, không bắt buộc ghi warning). Giữ nguyên padding/gap
     của frame cha, không tự đổi.
   - **Override bằng duyệt cây, CẤM id suy diễn**: sau khi tạo instance,
     dùng Plugin API DUYỆT CÂY CON của chính instance đó
     (`instance.findAll(n => n.type === 'TEXT')`), lọc `node.visible`, để
     có DANH SÁCH NODE OBJECT text theo đúng thứ tự đọc (top-to-bottom,
     left-to-right theo cây). MỌI thao tác set `characters` phải đi qua
     một node object lấy được từ chính bước duyệt cây này. TUYỆT ĐỐI KHÔNG
     tự lắp ghép hay đoán node id dạng `"I<a>;<b>;<c>"` (id suy diễn theo
     cấu trúc nested instance) rồi gọi API theo id đó — đây chính là
     nguyên nhân override trượt hàng loạt trong thực tế (text lồng sâu
     trong nested instance có id thật khác hẳn suy đoán), khiến nút hiện
     chữ mặc định "Button", card hiện "Title/Body" thay vì nội dung thật.
   - **Map `content` → layer** (áp dụng trên danh sách node text vừa duyệt
     được ở trên; mỗi layer chỉ nhận MỘT field — đã dùng cho field này thì
     field khác phải sang layer còn trống khác):
     - `content.text` → layer tên khớp `/title|label|text|heading/i`
       (ưu tiên); không có layer nào khớp tên → dùng layer text ĐẦU TIÊN
       trong danh sách (theo thứ tự đọc) còn trống.
     - `content.secondary` → layer tên khớp
       `/subtitle|description|caption|secondary/i`; không khớp → layer
       text THỨ HAI còn trống.
     - `content.value` → layer tên khớp `/value|price|amount/i`; không
       khớp → layer text CUỐI CÙNG còn trống.
     - `content.badge` → layer tên khớp `/badge|tag|chip/i`.
     - Field có giá trị nhưng KHÔNG tìm được layer còn trống tương ứng →
       ghi warning `"Element <id>: không tìm thấy layer cho <field> — bỏ
       qua."` vào `warnings[]` — xem mục "CẤM text bù" ở Hợp đồng chống
       rác, TUYỆT ĐỐI không tự tạo layer/node nào để bù.
     - Load font của từng layer TRƯỚC khi set `characters` (bắt buộc với
       Figma API), như cũ.
   - **`content.items[]`** (danh sách nhiều dòng — tab, listing nhiều
     dòng…): tìm nhóm HÀNG LẶP bên trong instance — các node con cùng cấp
     có tên trùng nhau hoặc cấu trúc giống nhau (mỗi hàng tự chứa ít nhất
     một layer text). Đổ `items[i]` vào layer text chính của hàng thứ `i`
     (áp dụng đúng quy tắc map field→layer ở trên, phạm vi tìm layer chỉ
     trong hàng đó).
     - Số hàng có sẵn NHIỀU HƠN số `items` → **ẨN** các hàng dư bằng
       `row.visible = false` (Figma KHÔNG cho phép xóa con của một
       instance — chỉ được ẩn; TUYỆT ĐỐI không xóa row).
     - Số `items` NHIỀU HƠN số hàng có sẵn → đổ đủ tới hàng cuối cùng rồi
       ghi warning `"Element <id>: chỉ hiện được N/M items."` (N = số hàng
       thật, M = `items.length`). TUYỆT ĐỐI không tạo node mới (ngoài hay
       trong instance) để hiển thị phần items dư ra.
   - Không có `component`: tạo một TEXT node đơn giản từ `label`/`content`
     (không cố dựng UI phức tạp) — CHỈ trường hợp này mới được tạo TEXT
     node trần trực tiếp trong frame.
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
