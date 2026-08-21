---
name: figma-comp-describe
description: |
  Sinh mô tả 1-2 câu cho các component Figma đang thiếu description, từ bằng
  chứng thật (cây node rút gọn + ảnh render) — KHÔNG bịa hành vi/tương tác.
  Đọc input-<n>.json (+ ảnh PNG cạnh đó), ghi ĐÚNG MỘT file
  output-<n>.json theo shape [{anchor, description}]. Dùng bởi nút
  "Sinh mô tả (N thiếu)" ở tab Design System của App (component source =
  Link Figma) và vòng sinh bù trước khi freeze catalog của bước
  "Màn hình → Component".
triggers:
  - "sinh mô tả component Figma"
  - "figma comp describe"
  - "mô tả AI cho component thiếu description"
od:
  mode: utility
  category: figma
---

# figma-comp-describe — mô tả component Figma từ bằng chứng

Bạn chạy **không có người ngồi cạnh** (job nền). Nhiệm vụ DUY NHẤT: đọc
`input-<n>.json` trong cwd, viết một mô tả ngắn cho mỗi component
liệt kê trong đó, ghi kết quả ra `output-<n>.json`. Không hỏi lại,
không chờ xác nhận, không sửa file nào khác.

## Input

`input-<n>.json` có shape:

```json
{
  "schemaVersion": "1.0",
  "components": [
    {
      "anchor": "figma-<hash>",
      "name": "Tên component (theo Figma)",
      "page": "Tên trang (nếu có)",
      "properties": [{ "name": "State", "type": "VARIANT", "values": ["Default", "Disabled"] }],
      "tree": { "name": "...", "type": "...", "characters": "...", "children": [...] },
      "image": "img-figma-<hash>.png"
    }
  ]
}
```

- `tree`: cây node Figma đã rút gọn (tên/loại node, chữ trong text layer, số
  con) — có thể `null` nếu daemon không đọc được cây (lỗi mạng); lúc đó dùng
  ảnh làm bằng chứng chính.
- `image`: tên file PNG nằm CẠNH `input-<n>.json` trong cùng thư mục — Read
  từng ảnh trước khi viết mô tả cho component đó. Có thể `null` (ảnh lỗi/URL
  hết hạn) — lúc đó dùng cây node làm bằng chứng chính. Nếu CẢ HAI đều thiếu,
  vẫn cố mô tả bằng `name`/`properties`, đừng bỏ qua component đó.

## Mode asset — entry có `"kind": "asset"`

Một entry có field `kind: "asset"` nghĩa là daemon phân loại component này là
icon/logo/avatar/ảnh minh hoạ (theo tên trang hoặc tiền tố tên) — shape KHÁC
mode thường, CHỈ có tên + trang, KHÔNG có `tree`/`image`/`properties`:

```json
{ "anchor": "figma-<hash>", "name": "ic-arrow-left", "page": "Icons", "kind": "asset" }
```

Không có cây node hay ảnh để soi — viết ĐÚNG MỘT dòng ≤120 ký tự theo khuôn:

> "Icon/Logo/Ảnh &lt;cái gì&gt; — dùng cho &lt;ngữ cảnh suy TỪ TÊN/NHÓM TRANG&gt;."

- Chọn "Icon"/"Logo"/"Ảnh" theo tên/trang (ví dụ trang "Icons" hoặc tên bắt
  đầu `ic-`/`icon` → "Icon…"; tên/trang có "logo" → "Logo…"; còn lại (avatar,
  illustration, cover, thumbnail…) → "Ảnh…").
- "&lt;cái gì&gt;" và "&lt;ngữ cảnh&gt;" CHỈ được suy từ chữ có trong
  `name`/`page` — ví dụ `name: "ic-arrow-left"`, `page: "Icons"` → "Icon mũi
  tên trái — dùng cho điều hướng/quay lại." KHÔNG bịa hành vi/trạng thái
  runtime (không tồn tại bằng chứng cho việc đó ở mode này, càng không được
  suy diễn hơn mode thường).
- Tên MƠ HỒ (không đủ chữ để suy ra "cái gì" — ví dụ chỉ có số/ký tự lạ dù đã
  qua bộ lọc tên rác của daemon) → đưa `anchor` đó vào `rejected` của output
  (xem mục Output) kèm lý do ngắn, KHÔNG cố đoán bừa.
- Vẫn áp mọi luật chung (không markdown, không xuống dòng, không `|`, không
  lặp nguyên văn `name`).

Mode thường (không có `kind`) giữ NGUYÊN hướng dẫn ở trên — không đổi.

## Luật viết mô tả — chỉ tả những gì THẤY được

- Chỉ dựa vào bằng chứng có trong `tree`/`image`/`properties` của ĐÚNG
  component đó: nó là loại UI gì (nút, ô nhập, thẻ, huy hiệu, thanh điều
  hướng…) và dùng trong ngữ cảnh nào nếu cây/trang cho thấy rõ (ví dụ "trong
  biểu mẫu", "trên thanh điều hướng dưới"). KHÔNG bịa hành vi tương tác
  (onClick làm gì, validate ra sao, gọi API nào…) nếu không có bằng chứng —
  Figma tĩnh không chứng minh được hành vi runtime.
- KHÔNG markdown (không `**`, không danh sách, không backtick) — mô tả nằm
  gọn trong MỘT ô bảng của `components-guide.md`.
- KHÔNG xuống dòng, KHÔNG chứa ký tự `|` (vỡ ô bảng).
- Tối đa 300 ký tự. Câu ngắn, 1-2 câu, tiếng Việt.
- KHÔNG lặp lại nguyên văn `name` làm mô tả (ví dụ tên là "Button" thì không
  được viết mô tả là "Button" hay "button") — daemon loại thẳng entry đó vì
  không nói thêm gì.
- Nếu một component vượt quá khả năng suy luận từ bằng chứng (tree rỗng, ảnh
  hỏng, tên chung chung) — vẫn cố viết một câu mô tả CHUNG CHUNG NHƯNG ĐÚNG
  dựa trên tên + properties (ví dụ "Component giao diện dạng <tên>, có các
  biến thể <properties>."), đừng bỏ sót — daemon sẽ tự loại nếu mô tả đó
  trùng tên component.

## Output — ĐÚNG MỘT file

Ghi `output-<n>.json` (CÙNG chỉ số `<n>` với input đã đọc), shape:

```json
[
  { "anchor": "figma-<hash>", "description": "Nút bấm chính, dùng để xác nhận hành động trong biểu mẫu." }
]
```

- Một phần tử cho MỖI component trong input (kể cả khi bạn không chắc — viết
  mô tả chung chung theo luật ở trên thay vì bỏ qua; daemon là nơi quyết định
  loại/giữ, không phải bạn).
- `anchor` phải khớp NGUYÊN VĂN với `anchor` trong input — không tự đổi,
  không bịa anchor mới.
- KHÔNG tạo file nào khác, KHÔNG sửa `input-<n>.json`, KHÔNG động tới bất cứ
  gì ngoài `output-<n>.json`.
