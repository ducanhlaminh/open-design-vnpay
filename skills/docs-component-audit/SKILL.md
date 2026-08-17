---
name: docs-component-audit
description: |
  MIDDLE stage of the `docs-review` workflow (pipeline `dr-comp`) — runs after
  `dr-docs` has ingested the pages and BEFORE `dr-review` reviews/edits them.
  Read ONE ingested page (`docs/<page>.md`, strictly read-only) and list WHICH
  COMPONENT EACH SCREEN declares (screens
  are declared as `###### Màn hình 1: SCR-001 — …` headings; elements come from
  each screen table's "Kiểu hiển thị" column), map every declared type onto the
  project's valid component catalogue (`criteria/components.md`) BY MEANING,
  and emit one verdict per element (`ok` | `not-in-catalog` |
  `variant-mismatch` | `ambiguous` | `internal`) into
  `comp/<page-slug>.components.json`, then draw ONE low-fi wireframe per screen
  (`wireframes/<SCREEN-KEY>.html` — gray blocks labelled with the component
  name, built from the document TEXT, never from mockup images). The terminal
  `dr-review` stage READS the JSON instead of re-deriving the component lens
  from scratch — that reuse is the entire reason this stage exists; the flow
  viewer shows the wireframes as screen thumbnails. This stage never edits the
  document.
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
dr-docs (nạp tài liệu)  →  dr-flow (sơ đồ luồng)  →  dr-comp (BẠN Ở ĐÂY)  →  dr-review (review + sửa tài liệu)
```

Upstream, `dr-docs` đã nạp tài liệu (Confluence hoặc `.md` người dùng tải lên)
vào `docs/`, và `dr-flow` đã rút sơ đồ luồng màn hình vào
`flows/*.flowchart.json` (node có thể gắn `screen` = SCREEN-KEY của màn). Ảnh
mockup có thể nằm trong `attachments/`, nhưng chỉ là minh hoạ, không phải đầu
vào để xác định component hay hướng thiết kế. Downstream, `dr-review` sẽ **đọc
file kết quả của bạn** thay vì tự phán lại xem màn hình dùng component gì, và
viewer sơ đồ luồng hiện **wireframe của bạn** làm thumbnail từng màn.

Vì sao tách thành một bước riêng: map component từ **khai báo chữ trong URD/PRD**
với danh mục hợp lệ là một quyết định cần nhất quán cho cả trang. `dr-review`
chỉ việc đọc dữ liệu đã chốt, không tự suy lại theo từng section.

**Bạn chỉ xử lý MỘT TRANG mỗi lần chạy.** Daemon fan-out stage này theo trang —
kickoff nêu đích danh đường dẫn trang bạn phụ trách và đường dẫn file JSON bạn
phải ghi ra. Đừng đi lang thang sang trang khác: trang đó đã có (hoặc sẽ có)
lượt chạy của riêng nó, và hai lượt cùng ghi một file là mất dữ liệu.

Bạn **không review câu chữ, không sửa tài liệu, không thiết kế màn hình mới**.
Bạn đọc, bạn ghi ra đúng một file JSON, rồi vẽ mỗi màn trong đó một wireframe
HTML khối xám (Bước 6).

## Bộ quy tắc Design System

Nếu có `criteria/rules.md`, đọc trước khi map component và ghi nhận rule anchor liên quan. File này có thể do người dùng nạp tay HOẶC do daemon tự sinh từ showcase + token của DS, nên ngoài quyết định overlay/feedback/table/badge/action nó còn có thể phủ màu, typography, spacing, elevation/radius (anchor kiểu `R-COLOR-*`, `R-TYPE-*`, `R-SPACING-*`). Trích đúng anchor CÓ THẬT trong file, đừng giả định một tập anchor cố định. `criteria/components.md` là danh mục component hợp lệ đóng; không suy đoán component từ trí nhớ. Thiếu file là hợp lệ.

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
- **Catalog Figma (TUỲ CHỌN):** `.figma-catalog/components.json` — chỉ có khi
  App chọn nguồn *Link Figma*; daemon tự sinh cùng lúc với
  `criteria/components.md`, chứa `fileKey` + `nodeId` của từng component để
  dùng ở Bước 3b. Không tự sửa file này.
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
  dẫn tương đối đúng như trong tài liệu, **chỉ để trace nguồn**. Không mở ảnh,
  không dùng ảnh để map component, variant, state hay layout.

Element của màn nằm trong **bảng** ngay dưới heading. Cột thứ 3 tên
**"Kiểu hiển thị"** là component **tài liệu tự khai**. Giá trị thật gặp được:
`Button`, `Label`, `Text field`, `Combobox`, `Number field`, `Table`,
`Label / Card`, `Tab`, `Multi-select combobox`, `Link`, `Badge`, `Date picker`,
`Icon menu`, `Chip / Tag list`.

## Bước 2 — giữ mockup ngoài quyết định audit

**Không mở ảnh trong `images`.** Mockup/screenshot nhúng trong URD/PRD là minh
hoạ, không phải "thứ thật sự sẽ được dựng" và không được dùng để phủ định hay
bổ sung cho bảng/đoạn yêu cầu. `images` vẫn xuất hiện trong JSON để người đọc
biết tài liệu có minh hoạ gì, nhưng không có tác dụng đánh giá.

Chỉ dùng component, variant và state **được viết rõ trong tài liệu** cùng
`criteria/components.md`. Nếu tài liệu không ghi rõ variant/state thì không suy
ra từ ảnh và không phát hành `variant-mismatch`; ghi `ok` khi component map được
hoặc `ambiguous` khi chính văn bản khai hai kiểu.

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

## Bước 3b — (chỉ khi được phép) mở component thật trong Figma Desktop

Khi danh mục đến từ **Link Figma** và kickoff nói *"Figma Desktop đang chạy
trên máy này"*, bạn có thêm 4 lệnh đọc **một component** qua daemon (daemon
tự chuyển Figma Desktop sang đúng file, chỉ cho phép các file trong catalog,
và ghi audit):

```
"$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file <fileKey> --node <nodeId>
"$OD_NODE_BIN" "$OD_BIN" tools figma screenshot     --file <fileKey> --node <nodeId>   # in ra đường dẫn PNG tương đối cwd → Read để ĐỊNH HƯỚNG, không làm căn cứ verdict
"$OD_NODE_BIN" "$OD_BIN" tools figma variable-defs  --file <fileKey> --node <nodeId>
"$OD_NODE_BIN" "$OD_BIN" tools figma metadata       --file <fileKey> --node <nodeId>
```

`fileKey` và `nodeId` lấy trong `.figma-catalog/components.json`
(`files[].fileKey`, `files[].components[].nodeId`) — **không** bịa nodeId, không
dùng nodeId từ URL của tài liệu.

**Khi nào dùng** — chỉ hai trường hợp, và mỗi trang **tối đa 8 lượt gọi**
(mỗi lượt là một lần chuyển file/đọc Figma thật, chậm và làm Figma bật lên):
1. `doc_type` map được sang **2+ component** gần nghĩa nhau (vd `Chip` vs
   `Badge`, `Select` vs `Combobox`) — mở từng ứng viên, đọc `design-context`
   (props/variants/auto-layout) để chọn đúng cái tài liệu mô tả.
2. Định kết luận `variant-mismatch` — mở component để **xác nhận** bảng biến
   thể thật (variant/property trong `design-context`) trước khi ghi verdict.

Căn cứ để phán là **văn bản** `design-context` / `variable-defs` (props,
variants, auto-layout, token). Ảnh `screenshot` chỉ giúp bạn nhận ra mình đang
nhìn đúng component — Hard rules "không mở ảnh để ra verdict" vẫn áp dụng.

**Ghi kết quả** — schema JSON ở Bước 5 **KHÔNG đổi** (daemon validate chặt,
thêm trường là hỏng cả trang). Bằng chứng từ Figma đi vào `note`, một câu:
`Figma "<tên component>" (nodeId <id>) có variant Size=S/M/L, không có XL →
variant-mismatch.`

**Khi lệnh lỗi** — stderr JSON có `error.code`:
- `FIGMA_DESKTOP_UNAVAILABLE`, `FIGMA_SWITCH_TIMEOUT`, `FIGMA_SWITCH_UNSUPPORTED`
  → Figma Desktop không mở được đúng file lúc này: **bỏ qua**, phán theo
  catalog như không có Bước 3b, KHÔNG thử lại quá 1 lần.
- `FIGMA_FILE_DENIED` → file đó không nằm trong catalog: **không được** tìm
  đường khác, phán theo catalog.
- `FIGMA_TOOL_ERROR` (nodeId không có trong file) → kiểm lại nodeId trong
  catalog; sai thì thôi.
Không có Bước 3b (kickoff nói Figma Desktop KHÔNG sẵn sàng, hoặc danh mục đến từ
Design System nội bộ) thì **không gọi** các lệnh này.

## Bước 4 — verdict cho từng element

`verdict` là tập ĐÓNG đúng 5 giá trị:

- **`ok`** — map được sang **đúng một** component có trong danh mục, và mọi
  biến thể/trạng thái **được văn bản mô tả** đều tồn tại trong bảng biến thể của
  component đó. Ghi cả `component` lẫn `rule_id`.
- **`not-in-catalog`** — tài liệu dùng thứ **không có** trong danh mục. Ví dụ
  đo được: `Icon menu`, `Link`. **BẮT BUỘC có `note` nói nên dùng gì thay
  thế** — một dòng "không có trong danh mục" mà không kèm lối ra chỉ chuyển
  việc suy nghĩ sang người đọc, và người đọc thường không có danh mục mở sẵn
  như bạn lúc này.
- **`variant-mismatch`** — component **có thật** trong danh mục, nhưng **văn
  bản tài liệu** mô tả một biến thể/trạng thái không tồn tại trong bảng biến thể
  của chính nó. Không bao giờ kết luận từ ảnh minh hoạ. Vẫn ghi `component` +
  `rule_id` — component đúng, chỉ biến thể sai.
- **`ambiguous`** — tài liệu khai **hai kiểu cho một phần tử**: `Label / Card`,
  `Button / Toggle`. Đây là chỗ tài liệu chưa chốt. Không chọn hộ theo ảnh;
  để `component` trống và nêu trong `note` rằng chủ tài liệu cần chọn một kiểu
  từ danh mục.
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

## Bước 6 — wireframe màn hình: `wireframes/<SCREEN-KEY>.html`

Sau khi JSON đã chốt, với **mỗi màn** trong `screens[]` vẽ **một** file HTML
wireframe. Mục đích: người review nhìn một lượt là biết màn có **những gì** —
mỗi phần tử là một khối xám ghi **tên component** đã map — theo đúng **CHỮ**
của tài liệu, không phải theo mockup. Nó không cần giống mockup, không cần
đẹp; nó là bảng element của Bước 5 được xếp thành hình. Viewer sơ đồ luồng
(dr-flow) dùng chính file này làm thumbnail cho node màn hình.

**Tên file = SCREEN-KEY**, một màn một file, nằm ở **gốc thư mục workflow**
ngang `comp/` và `flows/` (không lồng trong `comp/`):

- `SCREEN-KEY = <prefix>__<mã màn>` — **LUÔN LUÔN có prefix**, kể cả khi trang
  chỉ có một màn. `<mã màn>` là `id` nguyên văn của màn (`SCR-001`,
  `SCR-002.1`…). `<prefix>` là tên file `.md` bạn đang đọc bỏ đuôi `.md`, không
  đổi gì khác — **kickoff đã ghi sẵn nguyên văn**, chép lại, đừng tự suy hay
  rút gọn. Ví dụ `2.1.1-URD-Quan-ly-nhan-vien__SCR-001`.
- Vì sao prefix: mã màn được đánh lại từ đầu trong từng URD, và `dr-flow`
  (chạy một lượt cho cả feature) gắn `screen` = SCREEN-KEY theo cùng luật này
  mà không nhìn thấy bạn — hai bên chỉ khớp nhau khi cùng nhìn tên file.

**Hợp đồng file** (viewer đọc đúng các thứ này, đừng sáng tạo thêm):

- Tự chứa: `<!doctype html>`, **một** `<style>` chép **NGUYÊN VĂN** nội dung
  `wireframes/_wireframe.css` (daemon đã copy sẵn từ skill ux-spec — `Read`
  nó rồi dán vào; chỉ thêm tối đa vài rule layout của riêng màn). Không
  `<script>`, không `<link>`, không ảnh. `_wireframe.css` **không phải màn** —
  đừng sửa, đừng xoá.
- `<body data-screen="<SCREEN-KEY>" data-layout="web|mobile">` — `web` mặc
  định (URD backoffice); `mobile` chỉ khi tài liệu nói rõ app di động. Bên
  trong là một `<div class="wf-web">` (hoặc `wf-mobile`).
- Mỗi phần tử trong `elements[]` của màn = **MỘT** `<div class="wf-component">`
  theo đúng thứ tự tài liệu:
  - `verdict = ok` → chữ trong block là **tên component**, block mang
    `data-comp="<anchor>"` (anchor = phần sau `#` của `rule_id`).
  - `verdict ≠ ok` (kể cả không có danh mục nên `component` trống) → chữ =
    `doc_type` nguyên văn + hậu tố ` ?`, **không** `data-comp`.
- Khung: chỉ nhóm theo cụm tài liệu — dòng phân nhóm ("Khối …") → một
  `<div class="wf-card">` bọc các block con. Không suy bố cục từ ảnh mockup.
  Không màu, không icon, không nội dung mẫu.
- `data-nav="<SCREEN-KEY đích>"` trên block là nút/link **khi** `flows/*.flowchart.json`
  có cạnh từ một node thuộc màn này (node có `screen` = SCREEN-KEY của màn)
  sang một node thuộc màn khác. Không có flow, hoặc không có cạnh nào như vậy →
  bỏ, đừng bịa đích.
- Màn overlay (popup/dialog): `data-overlay="dialog"` +
  `data-overlay-of="<SCREEN-KEY màn cơ sở>"` trên `<body>` khi tài liệu nói
  popup thuộc màn nào; thân file chỉ chứa nội dung popup.

Ví dụ một màn có 3 phần tử (một `ok`, một `not-in-catalog`, một nút có đích
trong flow) — `wireframes/2.1.1-URD-Quan-ly-nhan-vien__SCR-001.html`:

```html
<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>SCR-001 — Danh sách Nhân viên</title>
<style>
/* … NGUYÊN VĂN wireframes/_wireframe.css … */
.wf-actions { display: flex; gap: 12px; }
</style>
</head>
<body data-screen="2.1.1-URD-Quan-ly-nhan-vien__SCR-001" data-layout="web">
<div class="wf-web">
  <div class="wf-card">
    <div class="wf-section">Nút thao tác</div>
    <div class="wf-actions">
      <div class="wf-component" data-comp="button" data-nav="2.1.1-URD-Quan-ly-nhan-vien__SCR-002">Button</div>
      <div class="wf-component">Icon menu ?</div>
    </div>
  </div>
  <div class="wf-component" data-comp="table">Table</div>
</div>
</body>
</html>
```

Wireframe vẽ từ **CHỮ** — bảng element và verdict bạn vừa chốt ở Bước 5.
**Không mở ảnh mockup để vẽ**, không mở `tools figma screenshot` để vẽ. Trang có
`screens: []` thì không có wireframe nào.

## Hard rules

- **CẤM sửa bất cứ file nào dưới `docs/`.** Bước này chỉ đọc. `docs/` là bản
  gốc mà `dr-review` phía sau dùng để đối chiếu `before` của từng thay đổi —
  một chữ bị đổi ở đây làm sai lệch bản gốc của một bước chưa chạy, và không ai
  đi truy ngược được vì bước này lẽ ra không ghi vào đó.
- **Chỉ ghi vào `comp/` và `wireframes/`.** Cả hai nằm ở **gốc thư mục
  workflow**, KHÔNG lồng trong `review/`: `review/` là output của `dr-review`
  và bị dựng lại mỗi lần chạy lại bước đó — lồng vào đấy thì `dr-review` sẽ
  xoá sạch chính input của nó. Không ghi vào `flows/` (output của `dr-flow`,
  bạn chỉ đọc).
- **Một màn một file wireframe, tên = SCREEN-KEY** (`<prefix>__<mã màn>`,
  prefix nguyên văn từ kickoff). Không gộp nhiều màn vào một file, không đặt
  tên khác, không đụng `wireframes/_wireframe.css`.
- **Không mở ảnh để vẽ wireframe.** Wireframe là bảng element + verdict xếp
  thành khối xám; bố cục chỉ nhóm theo dòng phân nhóm của tài liệu, không suy
  từ mockup.
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
- **Không mở ảnh để đưa ra bất kỳ verdict nào.** Ảnh trong `images[]` chỉ là
  metadata traceability (xem Bước 2); ảnh `tools figma screenshot` (Bước 3b)
  cũng chỉ để định hướng.
- **Bước 3b có hạn mức và phạm vi:** tối đa 8 lượt `tools figma` mỗi trang,
  chỉ nodeId có trong `.figma-catalog/components.json`, lỗi thì bỏ qua — không
  vòng qua bằng cách khác.
- File-only: không đẩy bất cứ gì lên KGS.
