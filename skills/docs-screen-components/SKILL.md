---
name: docs-screen-components
description: |
  MIDDLE stage of the `docs-review` workflow (pipeline `dr-comp`, "Màn hình →
  Component") — runs after `dr-docs` (ingest) and `dr-flow` ("Đánh giá luồng
  UX"), before `dr-review`. The FLOW stage already listed every screen of the
  feature (`flows/index.json[].screens`) and which flow steps happen on each;
  the daemon compiles that plus the document section of each screen into
  `comp/_inputs.json`. Your job: decide WHICH DESIGN SYSTEM COMPONENTS each
  screen should be built from — driven by the DS catalogue
  (`criteria/components.md`, `catalog.md`, `examples.md`, `rules.md`), NOT by
  the document's own "Kiểu hiển thị" table (reference only) and NOT by mockup
  images (component/anchor choice never comes from a picture) — but the
  screen's mockup image(s), when the kickoff lists any, ARE the source of
  truth for LAYOUT + CONTENT (wireframe layout, `elements[].content`) — and
  draw ONE ux-spec-style HTML wireframe per screen
  (`wireframes/<SCREEN-KEY>.html`) whose blocks carry `data-el` /
  `data-comp` / `data-nav`, plus a machine-checkable
  `comp/<SCREEN-KEY>.screen.json`. Two kickoff modes: ROLE-MAP (once per
  feature → `comp/_role-map.json`, role → DS component) and SCREEN (one screen
  per run). Activate when the user runs the "Màn hình → Component" pipeline or
  asks which DS components a spec's screens should use / for screen wireframes
  from a spec.
triggers:
  - "màn hình dùng component gì"
  - "đề xuất component cho màn hình"
  - "wireframe màn hình từ tài liệu"
  - "map màn hình sang design system"
  - "docs screen components"
  - "screen component proposal"
od:
  mode: utility
  category: ux-research
---

# docs-screen-components — mỗi màn hình dựng bằng component DS nào (Middle, `docs-review`)

Bạn là bước **Màn hình → Component** của workflow `docs-review`:

```
dr-docs (nạp tài liệu) → dr-flow (Đánh giá luồng UX) → dr-comp (BẠN Ở ĐÂY) → dr-review (review tài liệu)
```

Bước Flow đã trả lời "feature này có những màn nào, mỗi màn diễn ra bước gì,
đi sang màn nào". Bạn trả lời câu tiếp theo: **mỗi màn đó nên dựng bằng
component nào của Design System hiện tại**, và trông ra sao ở mức khung
(wireframe HTML). Người review mở wireframe + panel component để duyệt; bước
`dr-review` và các bước UI phía sau dựa vào đề xuất của bạn.

Ba nguyên tắc cố định:

1. **Nguồn màn hình = bước Flow + tài liệu, HỢP NHẤT.** Danh sách `screens[]`
   trong `_inputs.json` là **hợp của hai nguồn**, không phải chỉ Flow: mỗi màn
   Flow gắn được (`origin: "flow"`) CỘNG những màn tài liệu khai rõ mà Flow
   không gắn được vào bước nào (`origin: "doc"` — daemon tự quét khai màn theo
   4 khuôn: heading `MH1`/`SCR-001`/`S01`, mã mục nhiều cấp `6.1.1` (chỉ khi
   tài liệu không tự đánh mã màn riêng), dòng in đậm đứng riêng `**MH1:
   Tên**`, hoặc hàng trong bảng "Danh sách màn hình"; `origin: "agent"` khi cả
   4 khuôn đó vẫn không ra mã (chế độ EXTRACT bên dưới đọc hiểu tự do); rồi bổ
   sung). Lý do phổ
   biến nhất một màn chỉ có ở tài liệu: sơ đồ kiểu sequence không có node cho
   nó, hoặc agent gắn màn đó vào một node chỉ tồn tại ở bản ĐỀ XUẤT (patch),
   không có ở flowchart hiện trạng. Bảng "cấu trúc màn hình" / "Kiểu hiển thị"
   trong tài liệu vẫn chỉ để **tham khảo tên trường và thứ tự** — không phải
   hợp đồng, dù màn đó `origin` gì. Với màn `origin: "doc"` hoặc `"agent"`:
   `steps[]`/`navOut[]`/`navIn[]` RỖNG là BÌNH THƯỜNG, không phải lỗi — đừng cố
   suy diễn luồng hay `nav[]` không có căn cứ; dựng cấu thành màn từ `section`
   (mục tài liệu mô tả màn) + `referenceTable` (bảng trường) + ảnh mockup của
   chính mục đó khi kickoff liệt kê (LƯU Ý: nguyên tắc 3 bên dưới — ảnh giúp
   bạn dựng bố cục + nội dung, KHÔNG giúp bạn chọn component/anchor, kể cả khi
   hoàn toàn không có bước luồng nào). Không tự tìm thêm màn ngoài
   `_inputs.json`, không bịa màn.
2. **Component do Design System quyết.** Chỉ đề xuất component CÓ THẬT trong
   `criteria/components.md`; chọn theo `catalog.md` ("Dùng khi / Không dùng
   khi", Screen scaffolding), lồng theo `examples.md`, tuân `rules.md`. Không
   có DS ⇒ mọi `ds` là `null`, chỉ ghi vai trò.
3. **Ảnh mockup = nguồn sự thật BỐ CỤC + NỘI DUNG, KHÔNG bao giờ là nguồn
   chọn component.** Khi kickoff liệt kê ảnh mockup của màn (`mockups[]`
   trong `_inputs.json`), đó là ẢNH THẬT — BẮT BUỘC mở bằng Read: wireframe vẽ
   đúng bố cục trong ảnh (thứ tự khối, hàng/cột, nhóm card), `elements[].content`
   chép nội dung thật (tên gói, giá, nhãn, badge…). Nhưng việc CHỌN
   component/anchor vẫn CHỈ dựa vào chữ tài liệu + Design System (nguyên tắc
   2) — TUYỆT ĐỐI không suy component/anchor từ ảnh. Màn không có ảnh (kickoff
   không liệt kê) → tự dựng bố cục hợp lý + nội dung mẫu thực tế (không lorem).

Bạn **không review câu chữ, không sửa tài liệu, không sửa `flows/`**.

## Bước 0 — đọc input (từ cwd của dự án)

- **`comp/_inputs.json`** (daemon dựng, ĐỌC TRƯỚC TIÊN): `screens[]` theo thứ tự
  luồng — mỗi màn có `key` (SCREEN-KEY), `name`, `flowTitle`, `source` (trang
  `.md`), `section` {heading, startLine, endLine, excerpt} (mục tài liệu mô tả
  màn, nếu tìm thấy), `referenceTable` (bảng cấu trúc — tham khảo), `mockups[]`
  (đường dẫn ảnh mockup THẬT của màn — daemon tự quét, tồn tại trên đĩa, tối
  đa 6, có thể vắng/rỗng khi tài liệu không có ảnh cho màn này; xem nguyên tắc
  3), `blocks[]` (khối bổ sung của màn này mà BA đặt RỜI ở chỗ khác trong tài
  liệu — dr-screens phát hiện, mỗi khối có `name` + `section` {heading,
  startLine, endLine, excerpt}; có thể vắng khi màn không có khối bổ sung nào
  — PHẢI đọc các khoảng dòng này y như `section` chính, xem Chế độ SCREEN),
  `steps[]` (bước luồng diễn ra trên màn), `navOut[]` (đi sang màn nào,
  qua bước nào, điều kiện gì), `navIn[]`, `findings[]` (phát hiện UX của
  dr-flow chạm màn này), `platform` (nền tảng CỦA MÀN NÀY, khi daemon suy
  được theo section — xem luật `platform` ở Chế độ SCREEN dưới), `platformHint`
  (tín hiệu yếu mức TÀI LIỆU, dùng làm fallback khi màn không có `platform`
  riêng); và `ds` (file nào của DS đang có).
- **Design System** (có file nào đọc file đó; thiếu là bình thường):
  `criteria/components.md` — danh mục ĐÓNG (`### \`#anchor\` Tên`); `criteria/
  catalog.md` — kiến thức chọn component + bảng Screen scaffolding; `criteria/
  examples.md` — component nào chứa component nào; `criteria/rules.md` — quy
  tắc (R-OVERLAY, R-FEEDBACK, R-TABLE, R-BADGE, R-HEURISTIC, R-COLOR-*…);
  `.figma-catalog/components.json` — fileKey/nodeId khi DS là Link Figma.
  Component trong `components.md` không có dòng "Mô tả:" → tra
  `criteria/components-guide.md` (cùng thư mục, nếu tồn tại) theo đúng anchor
  `#figma-…`: đó là mô tả do AI sinh từ phân tích node + ảnh Figma — dùng làm
  ngữ cảnh để hiểu component khi viết `why`, KHÔNG dùng làm `rule_id`/`anchor`
  của `ds` (những trường đó vẫn chỉ trỏ `criteria/components.md#…`), và khi
  trích dẫn phải ghi rõ nguồn "(AI sinh)". File không tồn tại hoặc không có
  entry cho component đó → coi như component không có mô tả, xử lý như trước nay.
- **Tài liệu** (CHỈ ĐỌC): trang `source` của màn — Read đúng khoảng dòng
  `section` (mở rộng sang mục lân cận nếu thiếu); dự án gắn App: `docs-feature/`
  là nguồn sự thật, `docs-app/` chỉ tham khảo. Ảnh mockup của màn nằm ở
  `mockups[]` (xem nguyên tắc 3) — mở TỪNG ảnh đó khi kickoff liệt kê; các file
  khác trong `attachments/` không liên quan tới màn đang chạy thì bỏ qua.
- **`flows/`**: đã được tóm vào `_inputs.json`; cần chi tiết thì đọc
  `flows/<FLOW-ID>.flowchart.json` và `flows/<FLOW-ID>/ux-review.json`.
- **`wireframes/_wireframe.css`**: CSS dùng chung (daemon copy từ skill
  ux-spec) — Read rồi dán vào `<style>` của từng wireframe. Không sửa file này.

## Chế độ ROLE-MAP (lượt 0 — một lần cho cả feature)

Kickoff nói "ROLE-MAP mode". Bạn đọc mọi màn trong `_inputs.json` + Design
System và ghi **đúng một file** `comp/_role-map.json`:

```json
{
  "schema_version": "2.0",
  "platform": "mobile",
  "roles": [
    { "role": "app-bar",       "component": "Top App Bar",  "anchor": "top-app-bar", "variant": "Size=Small · Back=true", "when": "Mọi màn con; màn gốc không có nút back" },
    { "role": "list-item",     "component": "List Item",    "anchor": "list-item",   "variant": "Leading=Icon · Trailing=Chevron", "when": "Danh sách chọn 1 mục (quốc gia, gói cước)" },
    { "role": "primary-cta",   "component": "Button",       "anchor": "button",      "variant": "Hierarchy=Primary · Size=Large", "when": "Đúng MỘT nút chính ở đáy màn (R-HEURISTIC)" },
    { "role": "input-text",    "component": "Input Field",  "anchor": "input-field", "when": "Nhập họ tên, SĐT, email" },
    { "role": "bottom-sheet",  "component": null,           "fallback": "Dùng Dialog (anchor dialog) — DS này không có Bottom Sheet" }
  ],
  "notes": ["DS không có component Stepper — luồng nhiều bước dùng Top App Bar + Progress"]
}
```

- `platform`: `mobile` | `web` — mức mặc định của lượt ROLE-MAP (kickoff gợi ý
  theo cảm nhận chung của tài liệu), dùng để thiên vị biến thể role/component
  khi liệt kê `roles[]`. **Platform là của TỪNG MÀN, không phải một giá trị
  chung cho cả tài liệu**: tài liệu đa nền tảng (vd cùng khai cả "Màn hình
  MB" lẫn "Màn hình IB") thì mỗi màn ở chế độ SCREEN đọc `platform` riêng của
  chính nó trong kickoff (fallback `platformHint` khi màn không có `platform`
  riêng) — các màn trong cùng lượt hoàn toàn có thể ra platform khác nhau;
  đừng suy một platform duy nhất rồi áp cho mọi màn của tài liệu.
- `roles[]`: **phủ đủ mọi vai trò mà các màn của feature sẽ cần** — đọc hết
  `steps`, `section.excerpt`, `referenceTable` của mọi màn để liệt kê (app
  bar, tab, search, list item, card, table, form input các loại, select, date
  picker, checkbox/radio/switch, primary/secondary CTA, link, badge/status,
  empty state, error/feedback, dialog/bottom sheet, stepper/progress, summary
  row, price row, QR/image holder…). Tên `role` là slug ngắn `[a-z0-9-]`.
- `component` **phải là tên có thật** trong `criteria/components.md` — chép
  NGUYÊN VĂN phần tên sau `### \`#anchor\`` (danh mục Figma có thể có nhiều
  mục cùng tên gốc, được phân biệt bằng hậu tố ` — [File] (id)`: phải chép cả
  hậu tố, hoặc ít nhất ghi đúng `anchor` của mục đó để daemon phân biệt);
  `anchor` là anchor của chính mục đó. DS không có ⇒ `component: null` +
  `fallback` nói dùng gì thay. Không có `components.md` ⇒ mọi `component` là
  `null`. Daemon đối chiếu: tên không có/không phân biệt được bị hạ về `null`
  kèm cảnh báo hiển thị cho người xem — đừng đoán tên.
- `variant`: biến thể mặc định theo bảng thuộc tính của component (chuỗi
  `Prop=Value · Prop=Value`); không chắc thì bỏ.
- Không vẽ wireframe, không ghi file nào khác ở lượt này.

## Chế độ SCREEN (một màn mỗi lượt)

Kickoff nêu đích danh SCREEN-KEY, tên màn, khoảng dòng tài liệu, các lối đi
sang màn khác. Bạn ghi **đúng hai file**.

Một màn có thể có **KHỐI BỔ SUNG** nằm **RỜI ở chỗ khác** trong tài liệu — ví
dụ "Voucher" là chi tiết thêm của màn "Mua SIM" nhưng BA đặt tách xa, không
liền `section` chính. Khi kickoff liệt kê thêm (các) khoảng dòng của những
khối này (`blocks[]` trong `_inputs.json`), bạn **PHẢI Read đúng các khoảng
dòng đó** — dù nằm ngoài `section` chính của màn — và đưa element/nội dung
của chúng vào **CẢ** `screen.json` lẫn wireframe của màn này, coi như một
phần của màn (KHÔNG tạo màn/wireframe riêng cho khối đó, KHÔNG bỏ qua vì nó
nằm ngoài `section`).

### 1. `comp/<SCREEN-KEY>.screen.json`

```json
{
  "schema_version": "2.0",
  "key": "2.1-PRD-Mua-SIM__SCR-003",
  "name": "Chọn gói cước",
  "flowId": "FLOW-mua-sim",
  "platform": "mobile",
  "source": "docs-feature/2.1-PRD-Mua-SIM.md",
  "elements": [
    { "id": "appbar",   "label": "Chọn gói cước",           "role": "app-bar",     "ds": { "component": "Top App Bar", "anchor": "top-app-bar", "variant": "Back=true" }, "confidence": "high",   "provenance": "flow" },
    { "id": "tabs",     "label": "eSIM | SIM vật lý",        "role": "tab",         "ds": { "component": "Tabs", "anchor": "tabs" },                                    "confidence": "high",   "provenance": "text",  "docType": "Tab" },
    { "id": "plan-list","label": "Danh sách gói cước",       "role": "list-item",   "ds": { "component": "List Item", "anchor": "list-item", "variant": "Trailing=Radio" }, "confidence": "medium", "provenance": "text",  "why": "Tài liệu mô tả chọn 1 gói → List Item + Radio thay vì Card (catalog.md: Card cho nội dung hỗn hợp)",
      "content": { "text": "VN Traveler 79", "secondary": "5GB/ngày · 7 ngày", "value": "79.000đ", "badge": "-21%" } },
    { "id": "cta-next", "label": "Tiếp tục",                 "role": "primary-cta", "ds": { "component": "Button", "anchor": "button", "variant": "Hierarchy=Primary · Size=Large" }, "confidence": "high", "provenance": "flow" },
    { "id": "empty",    "label": "Chưa có gói cước phù hợp", "role": "empty-state", "ds": null,                                                                          "confidence": "low",    "provenance": "ds",    "why": "DS không có Empty State (role-map) — dùng Typography + Button" }
  ],
  "nav": [ { "el": "cta-next", "to": "2.1-PRD-Mua-SIM__SCR-004" } ],
  "notes": ["Tài liệu không nói trạng thái loading của danh sách gói."]
}
```

- `key`: đúng SCREEN-KEY kickoff nêu.
- `platform`: CỦA MÀN NÀY — đọc trường `platform` mà kickoff liệt kê cho đúng
  màn này, fallback `platformHint` khi kickoff không có `platform` riêng cho
  màn. Tài liệu đa nền tảng thì các màn khác nhau trong cùng lượt SCREEN có
  thể ra `platform` khác nhau — KHÔNG suy theo `platform` của role-map hay
  theo một platform chung cảm nhận từ cả tài liệu.
- `elements[]`: mọi phần tử người dùng thấy/tương tác trên màn, theo thứ tự
  bố cục từ trên xuống. `id` ổn định, chỉ `[A-Za-z0-9_.-]`, duy nhất trong
  màn — wireframe dùng đúng id này ở `data-el`.
  - `label`: nhãn thật (tên trường / nút / tiêu đề) — theo chữ tài liệu; bước
    luồng không có tên trường thì đặt theo tên bước.
  - `role`: slug trong `_role-map.json` (thêm role mới chỉ khi role-map thiếu,
    ghi `why`).
  - `ds`: `{component, anchor, variant?}` — component/anchor **có thật** trong
    `criteria/components.md`, đúng theo role-map; DS không có ⇒ `null`.
  - `confidence`: `high` (tài liệu + DS đều rõ) · `medium` (suy từ mô tả) ·
    `low` (chỉ từ tên bước / DS không có).
  - `provenance`: `text` (mục tài liệu) · `flow` (bước luồng) · `table` (bảng
    cấu trúc — tham khảo) · `ds` (bắt buộc theo rules/scaffolding của DS, vd
    app bar, empty state).
  - `docType`: nguyên văn ô "Kiểu hiển thị" nếu `referenceTable` có dòng
    tương ứng — chỉ để người đọc đối chiếu "tài liệu khai X, DS dùng Y".
  - `why`: một câu, bắt buộc khi lệch role-map, khi `ds: null` dù DS có, hoặc
    khi `docType` khác component chọn.
  - `content` (tuỳ chọn, tối đa 5 khoá `text`/`secondary`/`value`/`badge`/
    `items[]`): NỘI DUNG THẬT của element — chép từ ảnh mockup khi màn có
    ảnh (`mockups[]`), hoặc từ chữ/bảng tài liệu khi không, hoặc do bạn tự đặt
    (nội dung mẫu thực tế, không lorem) khi cả hai đều không đủ. Khoá lạ hay
    kiểu sai bị daemon bỏ kèm cảnh báo — không hard-fail.
- `nav[]`: mỗi lối đi kickoff kể → `{el, to}` (`el` = id của nút/dòng dẫn đi,
  `to` = SCREEN-KEY đích, phải là màn của luồng). Không bịa đích.
- `notes[]`: chỗ tài liệu mơ hồ ảnh hưởng tới màn (không phải review câu chữ).
- `layoutSource`: **daemon tự ghi ĐÈ** sau khi bạn nộp bài (`"doc-image"` khi
  màn có ảnh mockup thật, `"agent"` khi không) — bạn KHÔNG cần khai trường
  này, khai gì cũng bị ghi đè (tránh ảo giác "tôi tự nhận có ảnh").

### 2. `wireframes/<SCREEN-KEY>.html`

Wireframe **kiểu ux-spec** (xem `skills/ux-spec/references/wireframe.md`): một
file HTML tự chứa, DOM là bố cục thật của màn, không vocabulary đóng.

- `<!doctype html>`; một `<style>` chép NGUYÊN VĂN `wireframes/_wireframe.css`
  rồi thêm rule layout của riêng màn; không `<script>`, `<link>`, font, ảnh.
- `<body data-screen="<SCREEN-KEY>" data-layout="mobile|web">` (= `platform`);
  bên trong `<main class="wf-mobile">` hoặc `<main class="wf-web">`.
- Bố cục thật: màn có ảnh mockup (`mockups[]`) → vẽ ĐÚNG bố cục trong ảnh
  (thứ tự khối, hàng/cột, nhóm card — nhiều ảnh = các trạng thái/đoạn cuộn của
  CÙNG màn, hợp nhất thành MỘT wireframe, trạng thái phụ ghi vào `notes`
  thay vì vẽ riêng); màn không có ảnh → tự dựng bố cục hợp lý theo khuôn
  header (app bar) – thân (cuộn) – chân (CTA); hàng/cột bằng grid/flex; nhóm
  bằng `<section class="wf-card">`; lồng đúng như DS lồng (`examples.md`).
  Web: desktop-first + `@media (max-width: 834px)` và `390px`.
- **Mỗi element trong JSON = một block** `class="wf-component"` mang
  `data-el="<id>"` (BẮT BUỘC, đúng id), `data-comp="<anchor>"` khi `ds` có,
  `data-variant="…"` nếu có, `data-nav="<SCREEN-KEY đích>"` đúng như `nav`.
  Chữ trong block = nội dung thật, ngắn gọn của element (content chính trong
  `content` khi có, không thì `label`). Không có `ds` ⇒ không `data-comp` (CSS
  tự ẩn tên).
- Overlay (dialog/bottom sheet): `data-overlay="dialog|sheet"` +
  `data-overlay-of="<SCREEN-KEY màn cơ sở>"` trên `<body>`, thân chỉ có nội
  dung overlay.
- Xám, cấu trúc, low-fi: không màu thương hiệu, không icon, nội dung thật,
  ngắn gọn.

Ví dụ rút gọn (mobile):

```html
<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCR-003 — Chọn gói cước</title>
<style>
/* … NGUYÊN VĂN wireframes/_wireframe.css … */
.stack { display: grid; gap: 12px; }
.footer { position: sticky; bottom: 0; }
</style>
</head>
<body data-screen="2.1-PRD-Mua-SIM__SCR-003" data-layout="mobile">
<main class="wf-mobile stack">
  <header class="wf-component" data-el="appbar" data-comp="top-app-bar" data-variant="Back=true">Chọn gói cước</header>
  <div class="wf-component" data-el="tabs" data-comp="tabs">eSIM | SIM vật lý</div>
  <section class="wf-card stack">
    <div class="wf-component" data-el="plan-list" data-comp="list-item" data-variant="Trailing=Radio">Danh sách gói cước</div>
    <div class="wf-component" data-el="empty">Chưa có gói cước phù hợp</div>
  </section>
  <footer class="footer">
    <button class="wf-component" data-el="cta-next" data-comp="button" data-variant="Hierarchy=Primary · Size=Large" data-nav="2.1-PRD-Mua-SIM__SCR-004">Tiếp tục</button>
  </footer>
</main>
</body>
</html>
```

## Chế độ EXTRACT (lớp 2 — khi lớp 1 quét không ra)

Kiến trúc trích màn hình có 3 lớp: lớp 1 = daemon tự quét tất định theo 4
khuôn ĐÃ THẤY (heading `MH1`/`SCR-001`/`S01`, mã mục nhiều cấp `6.1.1`, dòng
in đậm đứng riêng `**MH1: Tên**`, hàng bảng "Danh sách màn hình"); lớp 2 = CHẾ ĐỘ
NÀY, agent đọc hiểu khi lớp 1 báo hiệu trang có màn hình (heading kiểu "Danh
sách màn hình" / "Mô tả các màn hình") nhưng không nhận ra mã màn nào — tài
liệu trình bày tự do, ngoài khuôn lớp 1 biết đọc; lớp 3 = manifest cho người
dùng tự sửa (không thuộc chế độ này). Vì lớp 2 để bạn tự đọc hiểu, daemon
KHÔNG tin lời bạn khai tay không — mọi màn phải kèm bằng chứng đối chiếu
được, cùng triết lý chống ảo giác của bước review tài liệu.

Kickoff nói "EXTRACT mode" kèm danh sách CÁC TRANG (đường dẫn `.md`) mà lớp 1
không quét ra được. Nhiệm vụ: đọc TỪNG TRANG đó, tìm MỌI màn hình tài liệu
khai — bất kể cách trình bày (heading, dòng in đậm, hàng bảng…) — rồi ghi
**đúng một file** `comp/_doc-screens.json`:

```json
{
  "schema_version": 1,
  "pages": [
    {
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "screens": [
        { "code": "MH1", "name": "Trang chủ", "anchorText": "| MH1 | Trang chủ |" },
        { "code": null, "name": "Xác nhận thanh toán", "anchorText": "**Màn xác nhận thanh toán**" }
      ]
    }
  ]
}
```

Ví dụ input rút gọn tương ứng (trang khai màn bằng bảng + một dòng in đậm rời
rạc, khuôn tự do lớp 1 không đọc được):

```
| Mã MH | Tên màn hình |
|---|---|
| MH1 | Trang chủ |

**Màn xác nhận thanh toán**
```

Luật:

- `source`: đúng đường dẫn trang mà kickoff liệt kê, chép nguyên văn.
- `anchorText`: chép **NGUYÊN VĂN CẢ MỘT DÒNG** của trang — dòng heading, dòng
  in đậm, hay một hàng bảng đều được, miễn là dòng đó DUY NHẤT trong trang
  (khớp y nguyên sau khi trim khoảng trắng đầu/cuối). Daemon đối chiếu tất
  định: không tìm thấy, xuất hiện hơn một lần, hoặc chỉ nằm trong code fence
  → màn đó bị loại kèm lý do, không suy diễn hộ bạn — đừng diễn giải lại câu
  chữ, đừng ghép nhiều dòng.
- **Mỗi màn một `anchorText` riêng** — không dùng chung một dòng cho hai màn
  khác nhau.
- `code`: lấy đúng mã tài liệu đã ghi (giữ nguyên chữ/số, kể cả hậu tố). Tài
  liệu KHÔNG có mã thì để `null` — **KHÔNG BỊA MÃ**; daemon tự đánh `X1`,
  `X2`… theo thứ tự xuất hiện trong trang, không cần bạn tự đếm.
- **KHÔNG khai mục tài liệu làm màn**: heading kiểu "Danh sách màn hình", "Mô
  tả các màn hình", "Luồng màn hình", "Phạm vi", "Quy tắc"… là tiêu đề MỤC
  của tài liệu, không phải một màn hình cụ thể — đừng liệt các heading cấp
  trên đó vào `screens[]`.
- **Chỉ ghi đúng một file `comp/_doc-screens.json`.** Không ghi file nào
  khác, không sửa trang tài liệu, không đụng `_inputs.json`, `flows/`,
  `criteria/`.

## Cách quyết định component (áp cho cả hai chế độ ROLE-MAP/SCREEN)

1. Xác định **vai trò** của phần tử từ chữ tài liệu / bước luồng (đây là
   "chọn 1 trong danh sách", "nhập số điện thoại", "xác nhận trước khi trả
   tiền"…).
2. Tra `_role-map.json` (chế độ SCREEN) hoặc lập nó (chế độ ROLE-MAP) từ
   `catalog.md` → "Dùng khi / Không dùng khi", bảng Screen scaffolding; kiểm
   biến thể trong bảng thuộc tính của component ở `components.md`.
3. Áp `rules.md` khi có xung đột (R-OVERLAY: 1 bước xác nhận = Dialog;
   R-HEURISTIC: một Primary/màn; R-TABLE: bảng có toolbar + phân trang…).
4. Tài liệu ép một kiểu khác DS (vd đòi "Combobox" nhưng DS chỉ có Select) →
   dùng component DS, ghi `docType` + `why`. Tài liệu ép một hành vi trái rules
   → theo tài liệu (nó là yêu cầu), ghi `why`.
5. Không chắc giữa 2 component gần nghĩa và kickoff nói Figma Desktop sẵn
   sàng → tối đa 8 lượt `"$OD_NODE_BIN" "$OD_BIN" tools figma design-context
   --file <fileKey> --node <nodeId>` (nodeId từ `.figma-catalog/components.json`)
   để đọc props/variants; lỗi `FIGMA_*` thì bỏ qua, chọn theo catalog. Không
   dùng ảnh screenshot để quyết.

## Hard rules

- **Chỉ ghi vào `comp/` và `wireframes/`** đúng file kickoff nêu
  (`comp/_role-map.json` ở lượt 0; `comp/<KEY>.screen.json` +
  `wireframes/<KEY>.html` ở lượt màn). Không sửa `docs/`, `docs-feature/`,
  `flows/`, `criteria/`, `_inputs.json`, `_wireframe.css`; không tự ghi
  `comp/index.json` / `comp/summary.md` (daemon gộp sau).
- Không tự ghi `comp/screen-flows/**`: đây là artifact screen-flow daemon-owned,
  daemon dựng tất định sau khi áp manifest/overrides và hoàn tất fan-out màn.
- **`component`/`anchor`/`data-comp` phải có thật** trong `criteria/components.md`
  (tên nguyên văn kể cả hậu tố phân biệt, hoặc anchor đúng). Daemon đối
  chiếu: component lạ bị hạ về `ds: null` + cảnh báo, `data-comp`/`data-nav`
  lạ bị gỡ khỏi wireframe — kết quả vẫn ra nhưng kém giá trị. Không có danh
  mục ⇒ `ds: null`, không `data-comp`.
- **`data-el` ↔ `elements[].id` khớp 1-1**; `data-nav`/`nav.to` phải là
  SCREEN-KEY của luồng (trong `_inputs.json`). Daemon kiểm và ghi cảnh báo.
- **Lỗi cứng (hỏng lượt màn):** thiếu một trong hai file, JSON không đọc
  được, `key` sai, wireframe có `<script>`.
- **Không dựng màn ngoài danh sách của Flow, không chia kịch bản.** Một màn =
  một wireframe đầy đủ.
- **Không dùng ảnh mockup để chọn component/anchor** — dù ảnh mở được và là
  nguồn sự thật cho bố cục/nội dung, việc chọn component vẫn CHỈ theo chữ tài
  liệu + Design System (nguyên tắc 2).
- **Wireframe không `<script>`**, tự chứa, bắt đầu bằng `<!doctype html>`,
  `data-screen` đúng key, `data-layout` = `platform`.
- File-only: không đẩy bất cứ gì lên KGS.
