---
name: docs-component-audit
description: |
  MIDDLE stage of the `docs-review` workflow (pipeline `dr-comp`) — runs after
  `dr-docs` has ingested the pages and BEFORE `dr-review` reviews/edits them.
  Read ONE ingested page (`docs/<page>.md`, strictly read-only) together with
  every mockup image it embeds, list WHICH COMPONENT EACH SCREEN uses (screens
  are declared as `###### Màn hình 1: SCR-001 — …` headings; elements come from
  each screen table's "Kiểu hiển thị" column), map every declared type onto the
  project's valid component catalogue (`criteria/components.md`) BY MEANING,
  and emit one verdict per element (`ok` | `not-in-catalog` |
  `variant-mismatch` | `ambiguous` | `internal`) into
  `comp/<page-slug>.components.json`. The terminal `dr-review` stage READS that
  file instead of re-deriving the component lens from scratch — that reuse is
  the entire reason this stage exists. This stage never edits the document.
  Activate when the user runs the "Màn hình → Component" pipeline or asks which
  components a spec's screens use / to check a spec's screens against the
  component catalogue.
triggers:
  - "màn hình dùng component gì"
  - "đối chiếu component với danh mục"
  - "kiểm component theo màn hình"
  - "component audit tài liệu"
  - "docs component audit"
  - "screen component audit"
  - "check screens against component catalogue"
od:
  mode: utility
  category: ux-research
---

# docs-component-audit — mỗi màn hình dùng component gì (Middle, `docs-review`)

Bạn là bước **Màn hình → Component** của workflow `docs-review`. Thứ tự các
bước:

```
dr-docs (nạp tài liệu)  →  dr-comp (BẠN Ở ĐÂY)  →  dr-review (review + sửa tài liệu)
```

Upstream, `dr-docs` đã nạp tài liệu (Confluence hoặc `.md` người dùng tải lên)
vào `docs/`, kèm ảnh mockup trong `attachments/` cạnh mỗi trang. Downstream,
`dr-review` sẽ **đọc file kết quả của bạn** thay vì tự phán lại xem màn hình
dùng component gì.

Vì sao tách thành một bước riêng: phán đoán component là việc **nhìn ảnh + tra
danh mục 48 component**, tốn nhất trong cả workflow. Trước đây `dr-review` vừa
phải làm việc đó vừa phải review câu chữ/luồng/gap trên từng lát cắt section —
nghĩa là cùng một trang bị "nhìn" lại nhiều lần, mỗi section một lần, và mỗi
lượt lại ra một kết luận hơi khác lượt trước. Tách ra: nhìn **một lần cho cả
trang**, ghi thành dữ liệu, các lượt sau chỉ việc đọc.

**Bạn chỉ xử lý MỘT TRANG mỗi lần chạy.** Daemon fan-out stage này theo trang —
kickoff nêu đích danh đường dẫn trang bạn phụ trách và đường dẫn file JSON bạn
phải ghi ra. Đừng đi lang thang sang trang khác: trang đó đã có (hoặc sẽ có)
lượt chạy của riêng nó, và hai lượt cùng ghi một file là mất dữ liệu.

Bạn **không review câu chữ, không sửa tài liệu, không thiết kế màn hình mới**.
Bạn đọc, và bạn ghi ra đúng một file JSON.

## Bước 0 — đọc input (từ cwd của dự án)

**Bố cục tài liệu.** Dự án gắn App dùng `./docs-feature/` làm nguồn trang đã chọn; `./docs-app/` chỉ đọc để tham khảo sau khi đọc `./docs-app/_index.md`, không audit hoặc tạo deliverable từ đó. Dự án legacy dùng `./docs/confluence/`, `./docs/jira/`, `./docs/context/`.

- **Tài liệu (CHỈ ĐỌC):** `docs/<page>.md` — kickoff nêu đúng đường dẫn (có thể là `docs-feature/<branch>/…`). Đây là
  nguồn sự thật của cả workflow. **Tuyệt đối không sửa nó**, kể cả một dấu
  cách: bước này không có bản clone nào để sửa an toàn, và `dr-review` phía sau
  dùng chính file này làm bản gốc để đối chiếu `before` của mọi thay đổi — sửa
  vào đây là làm sai lệch bản gốc của một bước chưa chạy.
- **Danh mục component hợp lệ (TUỲ CHỌN):** `criteria/components.md` — người
  dùng tải lên bằng
  `od files upload <proj> <file> --as docs-review/criteria/components.md`. File
  này có 48 component, mỗi cái một heading dạng ``### `#button` Button`` kèm một
  bảng biến thể (variant / state) ngay dưới.
- **Thiếu `criteria/components.md` KHÔNG phải lỗi.** Vẫn chạy: vẫn liệt kê đủ
  màn hình, đủ element, vẫn ghi `doc_type` nguyên văn. Nhưng khi đó **mọi
  `verdict` phải là `ok` và `component` phải bỏ trống**. Không có danh mục thì
  không có gì để phán đúng/sai — một `not-in-catalog` dựng lên từ trí nhớ về
  "design system thường có gì" là lời buộc tội không có bị can, và nó sẽ đi
  thẳng vào bản review cuối như thể có căn cứ. Im lặng đúng hơn đoán mò.

## Bước 1 — tìm mọi màn hình trong trang

Màn hình được khai bằng heading, dạng thật đo trên tài liệu URD:

```
###### Màn hình 1: SCR-001 — Danh sách Nhân viên
```

Quét **mọi** heading khai một màn (`Màn hình …: SCR-…`), bất kể cấp heading
(`###`, `####`, `#####`, `######` đều gặp trong thực tế — đừng khoá cứng vào
sáu dấu thăng). Với mỗi màn, lấy:

- `id` — **mã SCR nguyên văn** (`SCR-001`). Đây là khoá nối sang các bước khác,
  đừng chuẩn hoá lại (không `scr-001`, không `SCR001`).
- `name` — tên màn, phần sau dấu gạch ngang (`Danh sách Nhân viên`).
- `anchor` — **nguyên văn cả dòng heading**, copy y hệt kể cả dấu `—` và số thứ
  tự. Đây là toạ độ để giao diện nhảy tới đúng màn.
- `images` — mọi `![alt](attachments/…)` nằm **trong phạm vi màn đó**: từ dòng
  heading của màn tới ngay trước heading màn kế tiếp (hoặc hết mục). Ghi đường
  dẫn tương đối đúng như trong tài liệu.

Element của màn nằm trong **bảng** ngay dưới heading. Cột thứ 3 tên
**"Kiểu hiển thị"** là component **tài liệu tự khai**. Giá trị thật gặp được:
`Button`, `Label`, `Text field`, `Combobox`, `Number field`, `Table`,
`Label / Card`, `Tab`, `Multi-select combobox`, `Link`, `Badge`, `Date picker`,
`Icon menu`, `Chip / Tag list`.

## Bước 2 — MỞ MỌI ẢNH của màn (bắt buộc)

Dùng Read trên từng file trong `images` trước khi kết luận bất cứ điều gì về
màn đó. **Đây là việc NHÌN, không phải việc đọc chữ.**

Vì sao bắt buộc: bảng "Kiểu hiển thị" là thứ tài liệu **TỰ KHAI**, còn ảnh
mockup là thứ **thật sự sẽ được dựng**. Hai thứ đó lệch nhau chính là phát hiện
đáng giá nhất của cả bước này — bảng khai `Label` nhưng ảnh vẽ một Card có
viền và nút; bảng khai `Table` nhưng ảnh ghim cột trái và có hàng mở rộng;
bảng khai `Button` nhưng ảnh vẽ một biến thể ghost không có trong bảng biến thể
của Button. Không mở ảnh thì bạn chỉ chép lại bảng, và một bước chỉ chép lại
bảng thì không đáng tồn tại.

**Không mở ảnh thì KHÔNG được kết luận `variant-mismatch`.** Verdict đó nói về
biến thể/trạng thái *nhìn thấy được*; suy ra nó từ mấy chữ trong ô bảng là đoán
mò đội lốt bằng chứng.

Màn không có ảnh nào thì `images` là mảng rỗng — hợp lệ, và khi đó bạn chỉ được
phán trên những gì bảng khai.

## Bước 3 — map `doc_type` sang danh mục

Với **mỗi dòng** của bảng màn hình:

1. `label` = tên phần tử nguyên văn trong bảng (cột tên/mô tả phần tử).
2. `doc_type` = **nguyên văn** ô cột "Kiểu hiển thị", không sửa hoa/thường,
   không bỏ khoảng trắng quanh dấu `/`.
3. `component` = tên component trong `criteria/components.md` mà `doc_type` đó
   thật sự nói tới — map theo **NGHĨA**, không đòi trùng ký tự.

Tên tài liệu dùng và tên trong danh mục **không trùng nhau** — đó là chuyện
bình thường, không phải lỗi của tài liệu. Bảng map thật đo được:

| `doc_type` trong tài liệu | Component trong danh mục |
| --- | --- |
| `Text field` | `Input Field` |
| `Combobox` | `Select` |
| `Multi-select combobox` | `Select` (biến thể multiple) |
| `Label` | `Typography` |
| `Chip / Tag list` | `Chip` |
| `Date picker` | `Date Picker` |
| `Toggle` | `Checkbox / Radio / Switch` |
| `Number field` | `Input Field` (biến thể number) |
| `Button`, `Table`, `Tab`, `Badge` | trùng tên, map thẳng |

Đòi trùng ký tự sẽ biến gần như cả trang thành `not-in-catalog` — một danh sách
toàn báo động đỏ thì người đọc bỏ qua cả danh sách, kể cả hai ba mục thật sự
sai nằm lẫn trong đó. Ngược lại, map *quá tay* (nhét `Icon menu` vào `Menu` cho
xong) thì che mất đúng thứ cần thấy. Nguyên tắc: map được rõ ràng thì map, mơ
hồ thì để verdict nói ra.

## Bước 4 — verdict cho từng element

`verdict` là tập ĐÓNG đúng 5 giá trị:

- **`ok`** — map được sang **đúng một** component có trong danh mục, và biến
  thể/trạng thái mô tả (trong bảng và trong ảnh) đều tồn tại trong bảng biến
  thể của component đó. Ghi cả `component` lẫn `rule_id`.
- **`not-in-catalog`** — tài liệu dùng thứ **không có** trong danh mục. Ví dụ
  đo được: `Icon menu`, `Link`. **BẮT BUỘC có `note` nói nên dùng gì thay
  thế** — một dòng "không có trong danh mục" mà không kèm lối ra chỉ chuyển
  việc suy nghĩ sang người đọc, và người đọc thường không có danh mục mở sẵn
  như bạn lúc này.
- **`variant-mismatch`** — component **có thật** trong danh mục, nhưng tài liệu
  hoặc ảnh mô tả một **biến thể/trạng thái không tồn tại** trong bảng biến thể
  của chính nó (ví dụ Badge màu tím trong khi danh mục chỉ có
  success/warning/error/info). Chỉ dùng verdict này khi **đã mở ảnh** (Bước 2).
  Vẫn ghi `component` + `rule_id` — component đúng, chỉ biến thể sai.
- **`ambiguous`** — tài liệu khai **hai kiểu cho một phần tử**: `Label / Card`,
  `Button / Toggle`. Đây không phải lỗi map của bạn, đây là chỗ tài liệu chưa
  chốt. **Phải chốt một cái** trong `component` (cái mà ảnh cho thấy, nếu ảnh
  cho thấy) và nêu trong `note` là đã chốt cái nào, vì sao, cái kia bị loại.
  Bỏ lửng cả hai thì bước sau lại phải mở lại đúng ảnh này.
- **`internal`** — mảnh dựng nội bộ, không phải component người dùng thấy: tên
  bắt đầu bằng **dấu chấm** (`.row-actions`, `.cell-empty`) hoặc được đánh dấu
  `[Internal]` trong danh mục. **Bỏ qua, không bắt lỗi**, không cần `note`.
  Bắt lỗi mảnh nội bộ là tạo nhiễu trên thứ vốn không có gì để tuân thủ.

Không có danh mục (`criteria/components.md` vắng mặt) → **mọi verdict là `ok`,
`component` và `rule_id` bỏ trống** (xem Bước 0).

## Bước 5 — ghi `comp/<page-slug>.components.json`

Ghi đúng **MỘT** file cho trang bạn phụ trách, tại đường dẫn kickoff đã nêu.
Nội dung là **một object** (không phải mảng) đúng schema sau:

```json
{
  "schema_version": "1.0",
  "page": "2.1.1 URD Quản lý nhân viên",
  "doc_path": "docs/confluence/2.1.1-URD-Quan-ly-nhan-vien.md",
  "screens": [
    {
      "id": "SCR-001",
      "name": "Danh sách Nhân viên",
      "anchor": "###### Màn hình 1: SCR-001 — Danh sách Nhân viên",
      "images": ["attachments/scr-001.png"],
      "elements": [
        { "label": "Nút Thêm mới", "doc_type": "Button", "component": "Button",
          "rule_id": "criteria/components.md#button", "verdict": "ok" },
        { "label": "Menu thao tác dòng", "doc_type": "Icon menu",
          "verdict": "not-in-catalog",
          "note": "Danh mục không có 'Icon menu'; gần nhất là Popover hoặc Quick Action." }
      ]
    }
  ]
}
```

Từng field:

- `schema_version`: đúng chuỗi `"1.0"`.
- `page`: tên trang người đọc hiểu được (tiêu đề trang trong tài liệu).
- `doc_path`: đường dẫn trang, **tương đối từ cwd**, đúng như kickoff nêu.
- `screens[]`: theo đúng thứ tự xuất hiện trong trang.
  - `id`, `name`, `anchor`, `images[]`: lấy ở Bước 1.
  - `elements[]`: theo đúng thứ tự dòng trong bảng của màn.
    - `label`, `doc_type`: nguyên văn (Bước 3).
    - `component`: tên component **có thật** trong danh mục; bỏ trống khi
      `not-in-catalog` hoặc khi không có danh mục.
    - `rule_id`: anchor của **chính component đó** trong danh mục, dạng
      `criteria/components.md#<anchor>` — đi kèm `component`, có cái này thì
      phải có cái kia.
    - `verdict`: một trong 5 giá trị ở Bước 4.
    - `note`: một câu; **bắt buộc khi `verdict != "ok"`**.

Trang không khai màn hình nào (trang thuần định nghĩa dữ liệu, thuần quy trình
nghiệp vụ) → vẫn ghi file với `screens: []`. Đừng nặn ra một "màn hình" từ một
đoạn văn: file này là input của bước sau, và một màn bịa ra sẽ kéo theo cả một
chùm note bịa ra ở bản review cuối.

## Hard rules

- **CẤM sửa bất cứ file nào dưới `docs/`.** Bước này chỉ đọc. `docs/` là bản
  gốc mà `dr-review` phía sau dùng để đối chiếu `before` của từng thay đổi —
  một chữ bị đổi ở đây làm sai lệch bản gốc của một bước chưa chạy, và không ai
  đi truy ngược được vì bước này lẽ ra không ghi vào đó.
- **Chỉ ghi vào `comp/`.** `comp/` nằm ở **gốc thư mục workflow**, KHÔNG lồng
  trong `review/`: `review/` là output của `dr-review` và bị dựng lại mỗi lần
  chạy lại bước đó — lồng vào đấy thì `dr-review` sẽ xoá sạch chính input của
  nó.
- **`anchor` và `label` phải là NGUYÊN VĂN có thật trong tài liệu.** Daemon đối
  chiếu lại với trang, và một chỗ trích sai làm **hỏng cả trang**, không phải
  hỏng mỗi dòng đó. **COPY, đừng gõ lại** — dấu `—` (em dash) và dấu `-`
  (hyphen) nhìn như nhau trên màn hình nhưng là hai ký tự khác nhau.
- **`component` phải là tên CÓ THẬT trong danh mục, và `rule_id` phải đúng
  anchor của chính component đó.** Bịa một cái tên nghe hợp lý (`Data Grid`,
  `Action Menu`) làm mọi kết luận phía sau vô nghĩa: `dr-review` tin file này
  và chép thẳng `rule_id` vào note của nó, nên một anchor sai lan sang tận bản
  review cuối. Daemon kiểm và đánh hỏng trang.
- **`verdict != "ok"` thì BẮT BUỘC có `note`** — một câu nói **sai ở đâu** và
  **nên dùng gì**. `dr-review` dựng `finding`/`suggestion` của nó từ đúng câu
  này; `note` rỗng biến một phát hiện thành một dòng trống trong bản review.
- **KHÔNG tự ghi `comp/index.json` hay `comp/summary.md`** — daemon gộp kết quả
  của mọi trang vào đó sau khi tất cả các lượt chạy xong. Bạn tự ghi thì lượt
  chạy song song của trang khác sẽ ghi đè, và bản gộp cuối sẽ chỉ còn dữ liệu
  của một trang.
- **Không mở ảnh thì không được kết luận `variant-mismatch`** (xem Bước 2).
- File-only: không đẩy bất cứ gì lên KGS.
