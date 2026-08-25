---
name: docs-screen-discovery
description: |
  Stage `dr-screens` ("Phát hiện màn hình") of the `docs-review` workflow —
  runs AFTER `dr-docs` (ingest) and `dr-flow` ("Đánh giá luồng UX"), BEFORE
  `dr-comp` ("Màn hình → Component"). PRDs written in free prose (headings
  like "2.1 Mua SIM" with no `MH`/`SCR` code) confuse a deterministic regex
  scan: a heading that only describes ONE PART of a screen (a "Voucher"
  block, a tab, a small popup nested under "2.1 Mua SIM") gets promoted into
  its OWN screen. Your job: read every ingested feature document end to end
  (plus `flows/` when present) and author the AUTHORITATIVE screen list for
  the whole feature — which headings/blocks are real, standalone screens and
  which are just a part of a bigger screen — so `dr-comp` no longer has to
  guess. Activate when the user runs the "Phát hiện màn hình" pipeline or
  asks which headings in a PRD/URD are actual screens vs. just a section of
  one.
triggers:
  - "phát hiện màn hình"
  - "danh sách màn hình thật"
  - "màn hình hay chỉ là một phần"
  - "heading nào là một màn hình"
  - "screen discovery"
  - "docs screen discovery"
od:
  mode: utility
  category: ux-research
---

# docs-screen-discovery — lập danh sách màn hình THẬT của tài liệu (`docs-review`)

Bạn là bước **Phát hiện màn hình** của workflow `docs-review`, chạy NGAY SAU
`dr-flow` ("Đánh giá luồng UX") và TRƯỚC `dr-comp` ("Màn hình → Component").
Kết quả của bạn là nguồn **có thẩm quyền** — `dr-comp` đọc thẳng file bạn ghi
thay vì tự quét heading bằng regex; nếu bạn bỏ sót hay khai sai, `dr-comp` sẽ
sai theo, nên đọc kỹ TOÀN BỘ tài liệu trước khi quyết, đừng chỉ lướt heading.

## Vì sao bước này tồn tại

Một quét tất định theo khuôn (`MH1`/`SCR-001`, mã mục nhiều cấp `2.1`/`6.1.1`,
dòng in đậm, hàng bảng "Danh sách màn hình"…) chỉ đuổi kịp khuôn ĐÃ THẤY. Với
PRD tự do — heading kiểu `## 2.1 Mua SIM` rồi bên trong lại có `### Voucher`,
`### Thông tin gói cước` như các mục con mô tả CHI TIẾT của cùng một màn — quét
regex không phân biệt được "heading con là một PHẦN của màn cha" với "heading
con là một màn hình MỚI, riêng biệt". Bạn đọc hiểu ngữ cảnh để phân biệt đúng
hai trường hợp đó; daemon sẽ tin nguyên văn danh sách bạn khai (đối chiếu tất
định bằng `anchorText`, không suy diễn hộ).

## Input (từ cwd của dự án)

- **Mọi trang tài liệu `.md` của feature** (`docs-feature/*.md` hoặc
  `docs/*.md` — kickoff liệt kê chính xác đường dẫn). Đọc TOÀN VĂN từng
  trang, không chỉ phần đầu.
- **`comp/_screen-candidates.json`** (khi kickoff nhắc tới) — gợi ý daemon tự
  quét tất định (cùng khuôn `dr-comp` lớp 1 vẫn dùng) để bạn đối chiếu nhanh;
  đây chỉ là GỢI Ý, không phải danh sách cuối — bạn có thể thêm màn nó bỏ sót,
  bỏ màn nó nhận nhầm (mục lục, heading nhóm, heading con chỉ là một phần).
- **`flows/index.json` + `flows/*.flowchart.json`** (khi `dr-flow` đã chạy) —
  cho biết luồng nào đi qua màn nào; dùng để xác nhận thêm một heading có phải
  một màn hình thật (nó xuất hiện như một bước hành động trong luồng) hay chỉ
  là chi tiết trong một màn khác.

## Nhiệm vụ

Với MỖI trang tài liệu, liệt kê:

1. **Màn hình THẬT** — một giao diện người dùng nhìn thấy trọn vẹn, điều
   hướng tới được (từ luồng, từ một nút bấm, từ mục lục) và đứng độc lập với
   các màn khác. Ghi vào `pages[].screens[]`.
2. **KHÔNG PHẢI màn hình** — hai loại, đều đưa vào `excluded[]` kèm lý do:
   - **Heading/mục NHÓM** của tài liệu: "Danh sách màn hình", "Mô tả các màn
     hình", "Phạm vi", "Ngoài phạm vi", "Quy tắc", "Luồng màn hình", mục lục…
     — đây là tiêu đề CỦA tài liệu, không mô tả một giao diện cụ thể nào.
   - **Heading/khối CON mô tả MỘT PHẦN của một màn** — ví dụ "Voucher",
     "Thông tin gói cước", một tab, một popup nhỏ, một trạng thái lỗi nằm
     LỒNG bên trong mục mô tả một màn lớn hơn ("2.1 Mua SIM"). Loại này PHẢI
     ghi thêm `partOf` = tên màn cha mà nó thuộc về.

### Luật cốt lõi (quyết định màn THẬT vs. một phần của màn)

- Một heading là MỘT PHẦN của màn cha, không phải màn riêng, khi nó chỉ mô tả
  một khối/trạng thái/biến thể NẰM TRONG bố cục của màn cha — người dùng
  không "đi tới" nó như một điểm đến độc lập trong luồng, nó luôn xuất hiện
  CÙNG với màn cha (một section trong cùng một màn hình, một tab con, một
  trường/khối dữ liệu được mô tả kỹ hơn).
- Một heading LÀ màn riêng khi: tài liệu/luồng cho thấy người dùng phải
  **điều hướng tới** nó (một nút, một bước trong sơ đồ luồng dẫn sang nó) VÀ
  nó có bố cục/nội dung của MỘT giao diện đầy đủ (không chỉ một trường hay một
  khối nhỏ) — kể cả khi đó là một popup/bottom-sheet/dialog, miễn nó là một
  "màn" độc lập trong flow, không phải chỉ một chi tiết hiển thị tại chỗ.
- Nghi ngờ giữa hai khả năng: ưu tiên xem `flows/` — nếu heading đó khớp một
  node hành động RIÊNG trong sơ đồ (có cạnh dẫn tới/đi từ nó), nó là màn thật;
  không có gì trong luồng nhắc tới nó, và nó nằm lồng trực tiếp dưới một màn
  đã nhận diện, coi nó là một phần của màn cha.
- Không tự bịa/gộp/tách. Không suy diễn màn KHÔNG có trong tài liệu.

## Output — đúng 2 file

### `docs-review/screens-discovered.json`

```json
{
  "schema_version": 1,
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "pages": [
    {
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "screens": [
        { "code": null, "name": "Mua SIM", "anchorText": "## 2.1 Mua SIM" },
        { "code": "SCR-002", "name": "Chọn gói cước", "anchorText": "### 4.2 SCR-002 Chọn gói cước" }
      ]
    }
  ],
  "excluded": [
    {
      "name": "Voucher",
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "reason": "Chỉ là một khối hiển thị mã giảm giá bên trong màn Mua SIM, không phải một giao diện điều hướng tới được riêng.",
      "partOf": "Mua SIM"
    },
    {
      "name": "Danh sách màn hình",
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "reason": "Tiêu đề mục liệt kê của tài liệu, không mô tả một giao diện cụ thể."
    }
  ]
}
```

Luật field (đối chiếu tất định — sai một trong các luật dưới, màn đó bị daemon
loại khi `dr-comp` đọc lại, không cảnh báo riêng ở bước này):

- `source`: đúng đường dẫn `.md` kickoff liệt kê, chép nguyên văn.
- `anchorText`: chép **NGUYÊN VĂN CẢ MỘT DÒNG** của trang (heading, dòng in
  đậm, hàng bảng — bất kỳ dòng nào), và dòng đó phải **DUY NHẤT** trong toàn
  trang (khớp y nguyên sau khi trim khoảng trắng đầu/cuối, ngoài code fence).
  Mỗi màn một `anchorText` riêng — không dùng chung một dòng cho hai màn khác
  nhau, không ghép nhiều dòng làm một anchor.
- `code`: mã màn tài liệu đã ghi (giữ nguyên, kể cả hậu tố) nếu có. Tài liệu
  không có mã → để `null`, **KHÔNG BỊA MÃ**; daemon tự đánh `X1`, `X2`… theo
  thứ tự dòng anchor trong trang.
- `name`: tên màn ngắn gọn, đúng chữ tài liệu dùng (không diễn giải lại).
- `why` (tuỳ chọn): một câu ngắn giải thích vì sao đây là màn thật, hữu ích
  khi ranh giới không hiển nhiên (vd một popup).
- `excluded[].reason`: bắt buộc, một câu ngắn nêu rõ vì sao KHÔNG phải màn.
- `excluded[].partOf`: bắt buộc khi lý do là "một phần của màn khác" — ghi
  đúng `name` của màn cha đã liệt kê ở `pages[].screens[]`.
- Mỗi trang trong `pages[]` **chỉ liệt kê MỘT LẦN** trong mảng `pages`; gộp
  toàn bộ màn của trang đó vào `screens[]` của đúng một mục.

### `docs-review/screens-discovered.md`

Bản người-đọc, tóm tắt cùng nội dung trên: theo từng trang, liệt kê danh sách
màn hình THẬT (tên + mã) và danh sách bị loại kèm lý do + màn cha (`partOf`),
để người review hiểu nhanh quyết định của bạn mà không cần đọc JSON.

## Hard rules

- **Chỉ ghi đúng 2 file**: `docs-review/screens-discovered.json` +
  `docs-review/screens-discovered.md`. Không ghi vào `comp/`, không sửa
  `docs/`, `docs-feature/`, `flows/`, `criteria/`.
- **Không sửa nội dung tài liệu gốc** — bước này chỉ ĐỌC và phân loại.
- **Không đẩy gì lên KGS, không push, không tạo commit.** File-only.
- Nghi ngờ mà không có căn cứ đối chiếu được (không tìm ra `anchorText` duy
  nhất) → đừng khai màn đó; thà bỏ sót một màn mơ hồ còn hơn khai một anchor
  daemon không đối chiếu được (bị loại thầm lặng khi `dr-comp` đọc lại).
