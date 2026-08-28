---
name: docs-screen-mockup
description: |
  Stage `dr-mockup` ("Mockup màn") of the `docs-review` workflow — runs AFTER
  `dr-flow` / `dr-flow-improve`. For EVERY screen of the selected flow variant
  (daemon lists them in `mockups/_inputs.json`) writes one self-contained HTML
  mockup at CONCEPT-LAYOUT level with a DIVERSE layout: grey wireframe blocks
  (`.mk-region` + grid / row / split / kv / tabs / sticky kit) chosen per
  screen archetype from `references/layout-patterns.md` (`data-pattern`), REAL
  content labels taken from the document, `data-nav` to the screens it leads
  to, `data-proposed` for screens the improved flow added. NO design system,
  NO component mapping. Output: `mockups/<SCREEN-KEY>.html` per screen +
  `mockups/index.json`. Activate when the user runs the "Mockup màn" pipeline
  or asks for HTML concept mockups of the documented screens.
triggers:
  - "mockup màn hình"
  - "concept layout màn"
  - "mockup html từ tài liệu"
  - "docs screen mockup"
od:
  mode: utility
  category: ux-research
---

# docs-screen-mockup — Mockup màn: concept layout ĐA DẠNG BỐ CỤC, KHÔNG Design System

Bạn là bước **Mockup màn** của workflow `docs-review`. Bước Luồng màn hình đã
chốt DANH SÁCH MÀN của bản đang dùng (Nguyên bản hoặc Cải thiện). Việc của bạn:
với MỖI màn trong danh sách, dựng một mockup HTML ở mức **concept layout
wireframe xám** — màn thuộc loại nào (archetype), dùng bố cục nào (pattern),
gồm những khối nào, xếp ra sao, mỗi khối chứa nội dung gì (nhãn thật, ngắn).
**Bố cục phải đa dạng**: grid, hàng ngang, thumb + text, bảng label:value,
tab/segment, thanh dính đáy… — KHÔNG phải một cột dài xếp hộp. Không chọn
component, không map Design System, không màu thương hiệu. Người xem bấm khối
có `data-nav` để chuyển màn.

## Input (chỉ đọc)

- `mockups/_inputs.json` — daemon soạn sẵn: `screens[]` (key, name, platform /
  platformHint, provenance, section.excerpt, blocks[], mockups[] = ảnh mockup BA,
  steps, navOut, navIn), `selection` (bản đang dùng). **Đọc file này trước.**
  Tuỳ chọn (có thể vắng, do daemon gán khi có layout-kb):
  - `screens[].archetype: { id, confidence: "high"|"low" }` — loại màn daemon
    đoán. `high` → dùng luôn; `low`/vắng → tự suy từ tên + mục tài liệu.
  - `screens[].layoutRefs: { topics[], templates[{ id, bands[], sketch }],
    images[] }` — khuôn bố cục + ảnh wireframe tham khảo cho archetype đó
    (mobile: Enrico; web: topic `web-*` — sketch khung sidenav + nội dung, band
    `topbar, sidenav, filterbar, table, pagination, kpi-cards, chart…`). Đọc
    như nhau: xem sketch/ảnh trước khi chọn pattern; chỉ là GỢI Ý cấu trúc.
    Màn web mà `layoutRefs` rỗng (KB chưa có topic web — daemon ghi note) →
    dùng thẳng catalogue mục `## web` trong skill.
  - `layoutKb` — thông tin kho (`webTopics` = số topic web); `null` = không có
    KB → dùng catalogue trong skill.
- `references/layout-patterns.md` (trong thư mục skill) — **catalogue pattern**:
  archetype → pattern id → khối + sketch ASCII + class. Đọc trước khi viết HTML.
- Mục tài liệu của từng màn (`source` + `section` heading/dòng) và `blocks[]`
  — nguồn NỘI DUNG THẬT. Ảnh trong `mockups[]` (đường dẫn từ cwd) — nguồn BỐ CỤC
  số 1.
- Không cần `criteria/`, `comp/`, DS hay Figma — bước này không dùng.

## Output (CHỈ ghi trong `mockups/`)

1. `mockups/<SCREEN-KEY>.html` — một file / màn, key NGUYÊN VĂN từ `_inputs.json`.
2. `mockups/index.json`:
   `{ "schema_version": 1, "generatedAt": ISO, "variant": "original"|"improved",
   "screens": [{ "key", "name", "file": "mockups/<KEY>.html", "platform":
   "mobile"|"web", "provenance"?, "navOut": ["<KEY>"], "pattern": "<id>",
   "notes": "<1 câu lý do chọn pattern>" }] }`.

## Bước bắt buộc TRƯỚC khi viết HTML — chọn bố cục cho từng màn

Với mỗi màn, chốt 4 việc và ghi vào `index.json` (`pattern`, `notes`):

1. **Archetype**: ưu tiên `_inputs.json.screens[].archetype` (nếu daemon có và
   `confidence: "high"`); vắng/`low` → tự suy từ tên màn + heading + steps:
   `list | picker | detail | form | checkout | result | status | overlay | home | settings`;
   màn `platform: "web"` có thêm `table` (danh sách / quản lý / tra cứu / bảng)
   và `dashboard` (tổng quan / thống kê / báo cáo) — daemon gán khi web, không
   dùng cho mobile.
2. **Pattern**: chọn 1 id trong `references/layout-patterns.md` theo bảng tra
   archetype → pattern: màn mobile lấy cột Ưu tiên 1/2, màn web CHỈ lấy cột
   **Web** (không lấy pattern mobile, và ngược lại). Nếu `layoutRefs` có, xem
   `templates[].sketch` / `images[]` trước — khuôn KB gợi ý thứ tự khối (appbar ›
   search › list › fab…; web: topbar › filterbar › table › pagination…), pattern
   catalogue quyết class.
3. **Ảnh BA thắng mọi thứ**: nếu `mockups[]` có ảnh → mở ảnh; ảnh có 2 cột /
   hàng ngang / tab / thanh dính đáy / grid thì PHẢI tái hiện đúng cấu trúc đó
   (chọn pattern gần nhất, thêm/bớt khối cho khớp ảnh). Không ảnh → pattern +
   thứ tự nội dung trong mục tài liệu.
4. **Ghi dấu**: `<body … data-pattern="<id>">`, `pattern` trong
   `index.json.screens[]`, `notes` 1 câu lý do ("theo ảnh BA 2 cột", "form 6
   trường chia 2 nhóm → form-grouped-cards"…).

**Luật đa dạng**
- Hai màn liền kề theo `navOut` có archetype KHÁC nhau → KHÔNG dùng cùng pattern.
- Mỗi màn có ≥ 1 khối không phải stack dọc (`.mk-grid-2/3/4`, `.mk-row`,
  `.mk-hscroll`, `.mk-split`, `.mk-kv`, `.mk-sticky`, `.mk-tabs`, `.mk-seg`,
  `.mk-tabbar`, `.mk-accordion`; web thêm `.mk-table`, `.mk-filterbar`,
  `.mk-kpi`, `.mk-chart`, `.mk-sidenav`) khi nội dung cho phép. Daemon cảnh báo
  màn "1 cột thuần".
- CTA chính luôn nằm trong `.mk-sticky` (dính đáy khung), trừ result/empty state
  giữa màn.
- Form **vẽ từng trường** bằng `.mk-field` (nhãn + hộp trống + placeholder,
  `data-type`) — mức wireframe, không phải UI thật; cặp trường ngắn đi chung
  `.mk-grid-2`.

## Khuôn HTML (tự chứa) — ví dụ `checkout-summary-sticky`

```html
<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>SCR-004 Xác nhận đơn hàng</title>
<style>/* chép NGUYÊN VĂN mockups/_mockup.css vào đây, rồi thêm rule riêng nếu cần */</style>
</head>
<body data-screen="2.1-PRD-Mua-SIM__SCR-004" data-layout="mobile" data-pattern="checkout-summary-sticky">
<div class="mk-mobile">
  <section class="mk-region" data-region="appbar" data-label="App bar"><p>← Xác nhận đơn hàng</p></section>

  <section class="mk-region" data-region="content" data-label="Tóm tắt đơn">
    <div class="mk-split">
      <span class="mk-thumb" data-ratio="1x1"></span>
      <div class="mk-text"><p>Gói 5GB/ngày · Nhật Bản</p><p class="mk-meta">7 ngày · eSIM</p></div>
      <p class="mk-meta">250.000đ</p>
    </div>
  </section>

  <section class="mk-region" data-region="form" data-label="Thanh toán">
    <div class="mk-field" data-type="text"><label>Mã giảm giá</label><span class="mk-input">Nhập mã</span></div>
    <div class="mk-field" data-type="select"><label>Phương thức thanh toán</label><span class="mk-input">Ví VNPAY</span></div>
  </section>

  <section class="mk-region" data-region="content" data-label="Chi tiết thanh toán">
    <dl class="mk-kv" data-total>
      <dt>Giá gói</dt><dd>250.000đ</dd>
      <dt>Giảm giá</dt><dd>−20.000đ</dd>
      <dt>Tổng</dt><dd>230.000đ</dd>
    </dl>
  </section>

  <div class="mk-sticky">
    <div class="mk-row">
      <p class="mk-total">Tổng 230.000đ</p>
      <section class="mk-region" data-region="cta" data-label="CTA" data-nav="2.1-PRD-Mua-SIM__SCR-005"><p>Thanh toán</p></section>
    </div>
  </div>
</div>
</body></html>
```

- `<style>` = nội dung `mockups/_mockup.css` (daemon đã copy sẵn) + rule riêng.
  KHÔNG `<link>`, KHÔNG `<script>`, KHÔNG `<img src="http…">`, KHÔNG `@import`,
  KHÔNG `url(http…)`, KHÔNG font ngoài. File ≤ 200 KB.
- `<body data-screen="<KEY>" data-layout="mobile|web" data-pattern="<id>">` —
  `data-layout` theo `platform` của màn trong `_inputs.json` — daemon đã điền
  theo cấu hình người dùng (`screenPlatform` cấp file: mobile / web / both);
  KHÔNG tự suy nền tảng từ tài liệu. Khung mobile:
  `.mk-mobile` (390px). Khung web có **2 loại, agent chọn theo nội dung tài
  liệu** (ảnh BA thắng): (a) **web quản trị BO/CMS** — người vận hành quản lý /
  tra cứu / duyệt / cấu hình, menu trái nhiều mục, bảng dữ liệu → `.mk-web-shell`
  (= `.mk-sidenav` 240px + `.mk-topbar` breadcrumb/tài khoản + `.mk-main`);
  (b) **web khách hàng IB/portal** — khách tự phục vụ, ít mục, có footer →
  `.mk-web` (= `.mk-navbar` ngang + nội dung 1200px + `.mk-footer`). Cùng một
  workflow thường chỉ 1 loại — giữ nhất quán giữa các màn web. Màn
  `provenance: "proposed"` → thêm `data-proposed="1"` trên `<body>` và một
  `<p class="mk-proposed-tag">(đề xuất)</p>` trong app bar / topbar.
- Overlay (dialog / bottom sheet): `<body … data-overlay="dialog|sheet"
  data-overlay-of="<KEY màn cơ sở>">`, thân bọc trong `.mk-overlay`.
- Web: pattern id `web-*` (mục `## web` trong catalogue, cột Web bảng tra).
  `.mk-row[data-cols="1fr 2fr"|"2fr 1fr"]` cho 2 panel, `"1fr auto"` cho
  tiêu đề + nút hành động phải, `[data-sticky=top]` cho panel tóm tắt dính
  (portal). BO: bảng = `.mk-table` (`.mk-tr[data-head]` + hàng), thanh lọc =
  `.mk-filterbar`, `.mk-pagination`; dashboard = `.mk-grid-4 > .mk-kpi` +
  `.mk-chart`. CTA dính đáy `.mk-main` bằng `.mk-sticky` như mobile.

## Kit class (xám, dashed — xem `_mockup.css`)

| Class | Dùng cho |
|---|---|
| `.mk-region[data-region][data-label]` | hộp vùng có nhãn góc (như cũ) |
| `.mk-grid-2` `.mk-grid-3` `.mk-grid-4` | grid card / ô chọn / quick action / cặp nút |
| `.mk-row` | hàng ngang flex (tổng tiền + CTA; 2 panel web) |
| `.mk-hscroll` + `.mk-chip` | chip lọc / card cuộn ngang |
| `.mk-split` + `.mk-thumb[data-ratio]` + `.mk-text` + `.mk-meta` | dòng thumb 56px + text + meta |
| `.mk-kv` (`dl > dt + dd`) | bảng label:value 2 cột |
| `.mk-field[data-type=text\|select\|date\|otp\|toggle\|search\|textarea]` + `label` + `.mk-input` | 1 trường nhập |
| `.mk-tabs` / `.mk-seg` (`[data-on]` = tab hiện tại) | tab gạch chân / segment |
| `.mk-stepper` (`[data-on]`, `[data-done]`, `[data-dir=vertical]`) | bước tiến trình / timeline |
| `.mk-sticky` | thanh dính đáy: CTA chính, tổng tiền + CTA |
| `.mk-tabbar` (4–5 con, `[data-on]`) | tab bar đáy |
| `.mk-status[data-kind=ok\|fail\|wait\|info]` + `.mk-progress` | vòng trạng thái 64px / thanh tiến trình |
| `.mk-accordion` (`.mk-acc-h` + nội dung, `[data-on]` = mở) | nhóm mở/đóng |
| `.mk-fab` · `.mk-btn` | nút tròn góc / nút phụ |
| `.mk-web-shell` > `.mk-sidenav` (`.mk-brand`, mục, `.mk-meta` nhóm, `[data-on]`) + `.mk-topbar` (`.mk-breadcrumb` + `.mk-meta` tài khoản) + `.mk-main` | khung web quản trị BO/CMS (web) |
| `.mk-navbar` (`.mk-brand`, link, `[data-on]`, `.mk-meta`) · `.mk-footer` | header ngang + footer khung portal `.mk-web` (web) |
| `.mk-breadcrumb` (con cách nhau ›, cuối đậm) | đường dẫn trang (web) |
| `.mk-filterbar` (`.mk-field` search/select/date + `.mk-btn`) | thanh lọc trên bảng / danh mục (web) |
| `.mk-table[data-cols=2..7]` > `.mk-tr[data-head]` + `.mk-tr` > ô (`[data-align=right]`) | bảng dữ liệu header + 3–4 hàng mẫu (web) |
| `.mk-pagination` (`.mk-meta` "1–20 / 245" + ô trang, `[data-on]`) | phân trang (web) |
| `.mk-kpi` (`.mk-kpi-l` + `.mk-kpi-v` + `.mk-meta`) trong `.mk-grid-3/4` | card số dashboard (web) |
| `.mk-chart[data-label][data-kind=bar\|line\|pie]` | khối biểu đồ xám có nhãn (web) |

## Luật vùng

| `data-region` | Dùng cho |
|---|---|
| `appbar` | thanh tiêu đề / back / action góc phải |
| `hero` | banner, số dư, ảnh + tên + giá đầu màn |
| `content` | khối nội dung / bảng tóm tắt (`.mk-kv`, `.mk-split`…) |
| `list` | danh sách; con là `.mk-split` hoặc `content` (tối đa 3–4 mẫu) |
| `form` | nhóm trường — mỗi trường 1 `.mk-field` (chỉ trường tài liệu nêu) |
| `cta` | nút hành động chính (1 màn tối đa 2), thường trong `.mk-sticky` |
| `nav` | tab bar / breadcrumb / stepper / nav dọc phụ (web settings) |
| `overlay` | phần thân của dialog / sheet |
| `status` | trạng thái kết quả, cảnh báo, empty state (`.mk-status`) |

- **6-12 khối / màn** (kể cả khối con), lồng tối đa **2 cấp** (vd list › split ›
  thumb+text; form › grid-2 › field).
- `data-label` ≤ 60 ký tự, tiếng Việt, gọi đúng tên vùng theo tài liệu.
- Nội dung trong khối là **nội dung THẬT** từ mục tài liệu / `blocks[]` (tên
  trường, nhãn nút, câu thông báo, ví dụ dữ liệu tài liệu đưa) — ngắn, đủ để
  hình dung. **Không bịa trường / nút / thông báo** tài liệu không nói; thiếu
  chi tiết → nhãn chung ("Thông tin đơn hàng") không phải dữ liệu giả. Card mẫu
  trong list: lặp tối đa 3–4 với dữ liệu tài liệu đưa, thiếu thì nhãn chung.
- **Ảnh mockup BA (`mockups[]`) là nguồn bố cục**: xem ảnh, giữ ĐÚNG cấu trúc
  (cột / hàng / tab / sticky) và thứ tự khối từ trên xuống.
- `data-nav="<KEY đích>"` đặt trên khối gây chuyển màn, đích PHẢI có trong
  `screens[]` (ưu tiên `navOut` daemon liệt kê; bổ sung nếu tài liệu nói rõ).
  Không nav ra màn ngoài danh sách. Daemon xoá `data-nav` sai + cảnh báo.
- Không `data-comp`, không tên component DS, không màu thương hiệu, không icon
  ngoài — chỉ xám + 1 màu nhấn CSS cho `cta`.

## Cách làm

1. Đọc `_inputs.json` + `references/layout-patterns.md`; với từng màn đọc mục
   tài liệu + `blocks[]`; mở ảnh trong `mockups[]` nếu có; xem `layoutRefs` nếu có.
2. Lập bảng archetype → pattern cho TẤT CẢ màn trước (kiểm luật đa dạng theo
   `navOut`), rồi mới viết từng file: chốt platform → khung → khối theo pattern /
   ảnh → điền nhãn thật → `data-nav` → `data-pattern` → ghi file.
3. Ghi `mockups/index.json` sau cùng; `navOut` = đúng các `data-nav` đã dùng;
   `pattern` + `notes` từng màn.

## Tự soát trước khi kết thúc

- Số file `.html` = số màn trong `_inputs.json`; `data-screen` = key nguyên văn.
- Mọi `<body>` có `data-pattern`; `index.json.screens[].pattern` khớp.
- Không màn nào "1 cột thuần" (không có class kit nào ngoài `.mk-region`) — trừ
  khi nội dung thật sự chỉ có vậy (ghi lý do trong `notes`).
- `.mk-field` chỉ cho trường tài liệu nêu; không bịa trường.
- Không có `<script`, `<link`, `<img src="http`, `@import`, `url(http`.
- Mọi `data-nav` trỏ key có trong danh sách; màn `proposed` có `data-proposed`.
- Màn `data-layout="web"` dùng pattern `web-*` + khung `.mk-web-shell` /
  `.mk-web` (không `.mk-mobile`, không `.mk-tabbar`); màn mobile không dùng
  pattern `web-*`.
- Không khối nào rỗng; không nhãn nào là dữ liệu bịa.

## Hard rules

- Chỉ ghi trong `mockups/`. **Cấm ghi**: `mockups/_inputs.json`,
  `mockups/_mockup.css`, `flows/`, `comp/`, `review/`, `docs*/`, `criteria/`.
- File-only: không đẩy gì lên KGS, không hỏi lại — job không có người ngồi cạnh.
