# layout-patterns — catalogue bố cục cho mockup màn (dr-mockup)

Kho pattern **wireframe xám** (không DS, không màu thương hiệu) để stage `dr-mockup` chọn bố cục
theo **archetype** của màn thay vì stack 1 cột. Mỗi màn chọn ĐÚNG 1 pattern → ghi
`<body data-pattern="<id>">` + `pattern` trong `index.json.screens[]`.

Archetype: `list | picker | detail | form | checkout | result | status | overlay | home | settings | web`
+ `table | dashboard` (CHỈ gán cho màn `platform: "web"`; daemon `guessArchetype(screen, platform)`).
(`content` = chưa phân loại được → chọn theo nội dung, thường `detail-hero-kv-cta` hoặc `list-search-rows`;
màn web `content` → `web-detail-tabs` / `web-table-filters`).

Nguồn ký hiệu: **Magdoub/claude-wireframe-skill (MIT)** — khối wireframe ASCII mobile;
**M3 canonical** — canonical layouts của Material 3 (list-detail, supporting pane, feed);
**Enrico topic** — topic dataset Enrico (Aalto, MIT: list, form, login, search, menu, profile, settings, modal, gallery, news);
**Admin shell (AdminLTE/Tabler, MIT)** — quy ước sidenav + topbar + content, filterbar/bảng/phân trang của web quản trị;
**tự đặt** — rút từ 11 mockup dự án SIM du lịch (mobile) và màn BO/portal SIM du lịch (web).

Ưu tiên khi chọn: **ảnh mockup BA (`mockups[]`) thắng** → `layoutRefs` (KB Enrico cho mobile / topic `web-*` cho web, nếu daemon có) → catalogue này.
Ký hiệu sketch: `▣` thumb/ảnh · `○` icon · `[ ]` ô nhập · `(  )` nút · `═` sticky · `≡` app bar · `···` cuộn ngang.
Khung sketch = `.mk-mobile` 390px; web ghi riêng ở mục `## web` cuối file với 2 khung: `.mk-web-shell` (quản trị BO/CMS:
sidenav 240px + topbar + main) và `.mk-web` (khách hàng IB/portal: navbar ngang + nội dung 1200px).

---

## list

### list-search-rows — Danh sách có ô tìm, dòng 2 tầng
Dùng khi: danh sách dài cần tìm (quốc gia, gói cước, giao dịch, đơn hàng). | Archetype: list
Khối (trên→dưới): appbar · search · list dòng 2 tầng (thumb + text + meta) · fab/cta
```
┌──────────────────────────────────────┐
│ ≡  ← Chọn quốc gia              ○   │  appbar
├──────────────────────────────────────┤
│ [ 🔍 Tìm theo tên quốc gia        ] │  search (.mk-field data-type=search)
├──────────────────────────────────────┤
│ ▣  Nhật Bản                    →    │  .mk-split (thumb 56 + text + meta)
│    từ 150.000đ · 5 gói               │
│ ▣  Hàn Quốc                    →    │
│    từ 120.000đ · 3 gói               │
│ ▣  Thái Lan                    →    │
│    từ 90.000đ · 4 gói                │
│                                      │
│                              (+) fab │  .mk-fab (tuỳ chọn)
└──────────────────────────────────────┘
```
Class dùng: `.mk-field[data-type=search]` `.mk-region[data-region=list]` `.mk-split` `.mk-thumb` `.mk-meta` `.mk-fab`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic list/search

### list-chips-cards — Chip lọc cuộn ngang + card
Dùng khi: danh sách có bộ lọc nhanh (loại gói, thời hạn, vùng). | Archetype: list
Khối: appbar · hscroll chip lọc · card list (thumb 16:9 + tên + giá + meta) · sticky cta (tuỳ)
```
┌──────────────────────────────────────┐
│ ≡  ← Gói cước Nhật Bản              │  appbar
├──────────────────────────────────────┤
│ (Tất cả)(5 ngày)(10 ngày)(Data···)   │  .mk-hscroll > .mk-chip
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │  card
│ │ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ 16:9  │ │  .mk-thumb[data-ratio=16x9]
│ │ Gói 5GB/ngày · 7 ngày             │ │
│ │ 250.000đ                    →    │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣       │ │
│ │ Gói 3GB/ngày · 5 ngày · 180.000đ │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```
Class dùng: `.mk-hscroll` `.mk-chip` `.mk-region[data-region=list]` `.mk-thumb[data-ratio=16x9]`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic list

### list-segment-tabs — Segment 2–3 tab, list theo tab
Dùng khi: cùng loại đối tượng chia trạng thái (Đang dùng / Hết hạn; eSIM / SIM vật lý). | Archetype: list
Khối: appbar · segment 2–3 tab · list theo tab · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Gói của tôi                    │  appbar
├──────────────────────────────────────┤
│ ┃ Đang dùng ┃  Hết hạn  ┃  Chờ kích ┃ │  .mk-seg (tab hiện tại đậm)
├──────────────────────────────────────┤
│ ▣  Nhật Bản · 5GB/ngày         →    │  .mk-split
│    Còn 3 ngày · hết 12/09            │
│ ▣  Thái Lan · 3GB/ngày         →    │
│    Còn 1 ngày                        │
│                                      │
│                                      │
│══════════════════════════════════════│
│         (  Mua gói mới  )           │  .mk-sticky > cta
└──────────────────────────────────────┘
```
Class dùng: `.mk-seg` `.mk-region[data-region=list]` `.mk-split` `.mk-sticky`
Nguồn: M3 canonical (segmented button + list) · tự đặt

### grid-cards-2col — Grid 2 cột card
Dùng khi: catalogue nhìn bằng ảnh (quốc gia có cờ, gói theo vùng, sản phẩm). | Archetype: list
Khối: appbar · hero ngắn · grid 2 cột card (ảnh + tên + giá) · tabbar (tuỳ)
```
┌──────────────────────────────────────┐
│ ≡  ← Điểm đến phổ biến              │  appbar
├──────────────────────────────────────┤
│ Chọn quốc gia bạn sắp đến            │  hero ngắn
├──────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐  │  .mk-grid-2
│ │ ▣▣▣▣▣ 1:1     │ │ ▣▣▣▣▣ 1:1     │  │
│ │ Nhật Bản      │ │ Hàn Quốc      │  │
│ │ từ 150.000đ   │ │ từ 120.000đ   │  │
│ └───────────────┘ └───────────────┘  │
│ ┌───────────────┐ ┌───────────────┐  │
│ │ ▣▣▣▣▣         │ │ ▣▣▣▣▣         │  │
│ │ Thái Lan      │ │ Singapore     │  │
│ └───────────────┘ └───────────────┘  │
│ ○ Trang chủ  ○ Gói  ○ Đơn  ○ Tôi    │  .mk-tabbar
└──────────────────────────────────────┘
```
Class dùng: `.mk-region[data-region=hero]` `.mk-grid-2` `.mk-thumb[data-ratio=1x1]` `.mk-tabbar`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic gallery

## picker

### picker-search-groups — Ô tìm + list nhóm theo chữ cái/vùng, sticky Tiếp tục
Dùng khi: chọn 1 trong nhiều mục có nhóm tự nhiên (quốc gia theo châu lục/chữ cái, ngân hàng). | Archetype: picker
Khối: appbar · search · list nhóm (tiêu đề nhóm + dòng chọn) · sticky "Tiếp tục"
```
┌──────────────────────────────────────┐
│ ≡  ← Chọn quốc gia                  │  appbar
├──────────────────────────────────────┤
│ [ 🔍 Tìm quốc gia                 ] │  .mk-field[data-type=search]
├──────────────────────────────────────┤
│ CHÂU Á                               │  tiêu đề nhóm (.mk-meta)
│ ○ Nhật Bản                    ◉     │  dòng chọn (radio)
│ ○ Hàn Quốc                    ○     │
│ ○ Thái Lan                    ○     │
│ CHÂU ÂU                              │
│ ○ Pháp                        ○     │
│ ○ Đức                         ○     │
│══════════════════════════════════════│
│           (  Tiếp tục  )            │  .mk-sticky > cta
└──────────────────────────────────────┘
```
Class dùng: `.mk-field[data-type=search]` `.mk-region[data-region=list]` `.mk-meta` `.mk-split` `.mk-sticky`
Nguồn: Enrico topic search/list · Magdoub/claude-wireframe-skill (MIT)

### picker-grid-3col — Grid 3 cột ô chọn
Dùng khi: ≤ 12 lựa chọn ngắn có icon/cờ (loại SIM, thời hạn, mệnh giá nạp). | Archetype: picker
Khối: appbar · câu hỏi · grid 3 cột ô chọn (icon + nhãn) · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Chọn thời hạn                  │  appbar
├──────────────────────────────────────┤
│ Bạn đi bao lâu?                      │  content
├──────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐     │  .mk-grid-3
│ │   ○    │ │   ○    │ │   ○    │     │
│ │ 3 ngày │ │ 5 ngày │ │ 7 ngày │     │
│ └────────┘ └────────┘ └────────┘     │
│ ┌────────┐ ┌────────┐ ┌────────┐     │
│ │ 10 ngày│ │ 15 ngày│ │ 30 ngày│     │
│ └────────┘ └────────┘ └────────┘     │
│                                      │
│══════════════════════════════════════│
│           (  Tiếp tục  )            │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-grid-3` `.mk-region[data-region=content]` `.mk-sticky`
Nguồn: Enrico topic menu · tự đặt

### picker-sheet — Bottom sheet chọn
Dùng khi: chọn nhanh 3–8 mục trên nền màn hiện tại (ngôn ngữ, phương thức thanh toán, sắp xếp). | Archetype: picker (overlay)
Khối: màn nền mờ · bottom sheet (tiêu đề + list chọn) · nút xác nhận
```
┌──────────────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  nền mờ (.mk-overlay)
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ┌──────────────────────────────────┐ │  sheet
│ │        ──                       │ │
│ │ Chọn phương thức thanh toán      │ │
│ │ ○ Ví VNPAY                  ◉   │ │  list chọn
│ │ ○ Thẻ nội địa               ○   │ │
│ │ ○ Thẻ quốc tế               ○   │ │
│ │══════════════════════════════════│ │
│ │         (  Xác nhận  )          │ │  .mk-sticky
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```
Class dùng: `<body data-overlay="sheet" data-overlay-of="<KEY>">` `.mk-overlay` `.mk-region[data-region=overlay]` `.mk-sticky`
Nguồn: Enrico topic modal · M3 bottom sheet

## detail

### detail-hero-kv-cta — Hero + bảng label:value + sticky CTA
Dùng khi: xem chi tiết 1 đối tượng trước khi hành động (gói cước, đơn hàng, giao dịch). | Archetype: detail
Khối: appbar · hero (ảnh/tên/giá) · bảng label:value 2 cột · mô tả · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Chi tiết gói                ○  │  appbar
├──────────────────────────────────────┤
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ 16:9     │  hero (.mk-thumb)
│ Gói 5GB/ngày · Nhật Bản              │
│ 250.000đ                             │
├──────────────────────────────────────┤
│ Dung lượng      │ 5GB/ngày           │  .mk-kv (2 cột)
│ Thời hạn        │ 7 ngày             │
│ Nhà mạng        │ Docomo             │
│ Kích hoạt       │ Khi đến nơi        │
├──────────────────────────────────────┤
│ Mô tả: Tốc độ 4G/5G, hết dung lượng │  content
│ giảm còn 128kbps…                    │
│══════════════════════════════════════│
│           (  Mua ngay  )            │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-region[data-region=hero]` `.mk-thumb[data-ratio=16x9]` `.mk-kv` `.mk-sticky`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic news/profile

### detail-tabs — Hero + tab nội dung
Dùng khi: chi tiết có nhiều nhóm nội dung dài (Mô tả / Điều kiện / Đánh giá / FAQ). | Archetype: detail
Khối: appbar · hero · tabs · nội dung tab hiện tại · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Gói 5GB/ngày                   │  appbar
├──────────────────────────────────────┤
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣           │  hero
│ 250.000đ · 7 ngày                    │
├──────────────────────────────────────┤
│  Mô tả  │ Điều kiện │ Đánh giá       │  .mk-tabs (tab hiện tại gạch chân)
│ ────────                             │
│ • Dùng cho eSIM và SIM vật lý        │  content của tab
│ • Kích hoạt tự động khi đến nơi      │
│ • Hỗ trợ hotspot                     │
│                                      │
│══════════════════════════════════════│
│           (  Mua ngay  )            │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-region[data-region=hero]` `.mk-tabs` `.mk-region[data-region=content]` `.mk-sticky`
Nguồn: M3 canonical (tabs) · Enrico topic news

## form

### form-grouped-cards — Stepper + card nhóm trường
Dùng khi: form ≥ 4 trường chia nhóm (Thông tin cá nhân / Giấy tờ / Liên hệ). | Archetype: form
Khối: appbar · stepper · card nhóm (mỗi trường 1 `.mk-field`) · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Thông tin người dùng           │  appbar
├──────────────────────────────────────┤
│ ●──────○──────○   Bước 1/3           │  .mk-stepper
├──────────────────────────────────────┤
│ THÔNG TIN CÁ NHÂN                    │  card nhóm (.mk-region form)
│ Họ tên                               │  .mk-field
│ [ Nguyễn Văn A                    ]  │
│ Ngày sinh                            │  .mk-field[data-type=date]
│ [ dd/mm/yyyy                   📅 ]  │
│ Giới tính                            │  .mk-field[data-type=select]
│ [ Chọn                          ▾ ]  │
├──────────────────────────────────────┤
│ GIẤY TỜ                              │
│ Số CCCD                              │
│ [ 12 số                           ]  │
│══════════════════════════════════════│
│           (  Tiếp tục  )            │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-stepper` `.mk-region[data-region=form]` `.mk-field[data-type=text|select|date]` `.mk-sticky`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic form

### form-two-col-short — Cặp trường ngắn cùng hàng
Dùng khi: form có cặp trường ngắn liên quan (SĐT | Email, Ngày đi | Ngày về, Mã | Số lượng). | Archetype: form
Khối: appbar · (stepper) · card nhóm với `.mk-grid-2` cho cặp ngắn · trường dài full · sticky cta
```
┌──────────────────────────────────────┐
│ ≡  ← Thông tin liên hệ              │  appbar
├──────────────────────────────────────┤
│ ●──────●──────○   Bước 2/3           │  .mk-stepper
├──────────────────────────────────────┤
│ Số điện thoại     │ Email            │  .mk-grid-2 > .mk-field ×2
│ [ 09xx xxx xxx ]  │ [ a@b.vn      ]  │
│ Ngày đi           │ Ngày về          │
│ [ 01/09      📅 ] │ [ 08/09     📅 ] │
│ Địa chỉ nhận SIM (nếu SIM vật lý)    │  .mk-field full
│ [ Số nhà, đường, quận              ] │
│ Nhận thông báo qua email     [ ●━ ]  │  .mk-field[data-type=toggle]
│                                      │
│══════════════════════════════════════│
│           (  Tiếp tục  )            │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-stepper` `.mk-grid-2` `.mk-field[data-type=text|date|toggle]` `.mk-sticky`
Nguồn: tự đặt · Enrico topic form

## checkout

### checkout-summary-sticky — Tóm tắt đơn + nhóm form + thanh tổng tiền dính đáy
Dùng khi: màn xác nhận đơn / thanh toán có tổng tiền. | Archetype: checkout
Khối: appbar · tóm tắt đơn (split thumb + text) · nhóm form (mã giảm giá, phương thức) · kv tiền · thanh tổng tiền + cta dính đáy
```
┌──────────────────────────────────────┐
│ ≡  ← Xác nhận đơn hàng              │  appbar
├──────────────────────────────────────┤
│ ▣  Gói 5GB/ngày · Nhật Bản           │  .mk-split (tóm tắt đơn)
│    7 ngày · eSIM · 250.000đ          │
├──────────────────────────────────────┤
│ Mã giảm giá                          │  .mk-field
│ [ Nhập mã                  ] (Áp)   │
│ Phương thức thanh toán               │  .mk-field[data-type=select]
│ [ Ví VNPAY                      ▾ ]  │
├──────────────────────────────────────┤
│ Giá gói          │ 250.000đ          │  .mk-kv
│ Giảm giá         │ −20.000đ          │
│ Phí              │ 0đ                │
│══════════════════════════════════════│
│ Tổng 230.000đ      (  Thanh toán  )  │  .mk-sticky (tổng + cta cùng hàng)
└──────────────────────────────────────┘
```
Class dùng: `.mk-split` `.mk-thumb` `.mk-field` `.mk-kv` `.mk-sticky` `.mk-row`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · tự đặt

### checkout-accordion — Tóm tắt + accordion nhóm
Dùng khi: checkout nhiều nhóm thông tin phải rà (Người mua / Giao hàng / Thanh toán) — mỗi nhóm mở/đóng. | Archetype: checkout
Khối: appbar · tóm tắt · accordion nhóm · sticky tổng + cta
```
┌──────────────────────────────────────┐
│ ≡  ← Thanh toán                     │  appbar
├──────────────────────────────────────┤
│ ▣  2 gói · 430.000đ                  │  .mk-split
├──────────────────────────────────────┤
│ Người mua                      ▴    │  .mk-accordion (mở)
│   Nguyễn Văn A · 09xx xxx xxx        │
│   a@b.vn                             │
│ Giao hàng (SIM vật lý)         ▾    │  .mk-accordion (đóng)
│ Phương thức thanh toán         ▾    │
│ Mã giảm giá                    ▾    │
│                                      │
│══════════════════════════════════════│
│ Tổng 430.000đ      (  Thanh toán  )  │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-split` `.mk-accordion` `.mk-sticky` `.mk-row`
Nguồn: M3 canonical (expansion) · tự đặt

## result

### result-center-status — Icon trạng thái giữa + card tóm tắt + 2 nút phụ + cta
Dùng khi: màn thành công / thất bại sau thanh toán, sau kích hoạt. | Archetype: result
Khối: icon trạng thái giữa · tiêu đề · card tóm tắt kv · hàng 2 nút phụ · cta chính
```
┌──────────────────────────────────────┐
│                                      │
│              ┌──────┐                │  .mk-status (64px, ✓ / ✕)
│              │  ✓   │                │
│              └──────┘                │
│        Thanh toán thành công         │  status text
│     Mã đơn #SIM-2025-0912            │
├──────────────────────────────────────┤
│ Gói              │ 5GB/ngày · 7 ngày │  .mk-kv (card tóm tắt)
│ Số tiền          │ 230.000đ          │
│ Thời gian        │ 12/09 10:32       │
├──────────────────────────────────────┤
│ ( Xem eSIM )      ( Chia sẻ )        │  .mk-grid-2 nút phụ
│══════════════════════════════════════│
│           (  Về trang chủ  )        │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-status[data-kind=ok|fail]` `.mk-region[data-region=status]` `.mk-kv` `.mk-grid-2` `.mk-sticky`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic modal

### result-timeline — Trạng thái + timeline bước
Dùng khi: kết quả có nhiều bước xử lý tiếp theo (đã thanh toán → đang cấp eSIM → hoàn tất; giao SIM vật lý). | Archetype: result
Khối: status · timeline bước · kv ngắn · cta
```
┌──────────────────────────────────────┐
│              ┌──────┐                │  .mk-status (⏳)
│              │  ⏳  │                │
│              └──────┘                │
│        Đang cấp eSIM cho bạn         │
├──────────────────────────────────────┤
│ ●  Đã thanh toán       12/09 10:32   │  .mk-stepper[data-dir=vertical]
│ │                                    │
│ ●  Đang xử lý          ~2 phút       │  (bước hiện tại đậm)
│ │                                    │
│ ○  Hoàn tất · gửi QR eSIM            │
├──────────────────────────────────────┤
│ Mã đơn           │ #SIM-2025-0912    │  .mk-kv
│══════════════════════════════════════│
│         (  Xem đơn hàng  )          │  .mk-sticky
└──────────────────────────────────────┘
```
Class dùng: `.mk-status[data-kind=wait]` `.mk-stepper[data-dir=vertical]` `.mk-kv` `.mk-sticky`
Nguồn: tự đặt · M3 canonical (progress)

## status

### status-processing — Spinner/tiến trình + text + nút phụ
Dùng khi: màn chờ (đang xử lý thanh toán, đang kích hoạt, timeout). | Archetype: status
Khối: spinner/tiến trình giữa · text · nút phụ (huỷ / về trang chủ)
```
┌──────────────────────────────────────┐
│ ≡  Đang xử lý                        │  appbar (tuỳ)
│                                      │
│                                      │
│              ┌──────┐                │  .mk-status (⏳)
│              │  ⏳  │                │
│              └──────┘                │
│        Đang xác nhận thanh toán      │
│        Vui lòng không tắt ứng dụng   │
│     ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ 45%         │  .mk-progress
│                                      │
│                                      │
│          ( Huỷ giao dịch )           │  nút phụ (không sticky)
│                                      │
└──────────────────────────────────────┘
```
Class dùng: `.mk-status[data-kind=wait]` `.mk-progress` `.mk-region[data-region=status]`
Nguồn: Enrico topic modal/tutorial · tự đặt

### status-empty — Minh hoạ + text + cta
Dùng khi: empty state (chưa có gói, chưa có đơn, không tìm thấy). | Archetype: status
Khối: minh hoạ · text · cta
```
┌──────────────────────────────────────┐
│ ≡  ← Gói của tôi                    │  appbar
│                                      │
│                                      │
│           ▣▣▣▣▣▣▣▣▣▣▣▣               │  .mk-thumb (minh hoạ 1:1, 120px)
│           ▣▣▣▣▣▣▣▣▣▣▣▣               │
│           ▣▣▣▣▣▣▣▣▣▣▣▣               │
│                                      │
│        Bạn chưa có gói nào           │  status text
│   Mua gói đầu tiên để dùng khi đi    │
│           nước ngoài                 │
│                                      │
│         (  Mua gói ngay  )          │  cta (giữa, không cần sticky)
│                                      │
└──────────────────────────────────────┘
```
Class dùng: `.mk-region[data-region=status]` `.mk-thumb[data-ratio=1x1]` `.mk-region[data-region=cta]`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic tutorial

## overlay

### overlay-dialog — Dialog giữa màn
Dùng khi: xác nhận / cảnh báo cần quyết định ngay (Huỷ đơn? Xoá eSIM?). | Archetype: overlay
Khối: nền mờ · dialog giữa (tiêu đề · nội dung · hàng 1–2 nút)
```
┌──────────────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  .mk-overlay (nền mờ)
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ░░┌──────────────────────────────┐░░ │
│ ░░│ Huỷ đơn hàng?                │░░ │  dialog (.mk-region overlay)
│ ░░│                              │░░ │
│ ░░│ Đơn #SIM-2025-0912 sẽ bị huỷ │░░ │
│ ░░│ và hoàn tiền trong 3–5 ngày. │░░ │
│ ░░│                              │░░ │
│ ░░│  ( Giữ lại )   ( Huỷ đơn )   │░░ │  .mk-grid-2 nút
│ ░░└──────────────────────────────┘░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└──────────────────────────────────────┘
```
Class dùng: `<body data-overlay="dialog" data-overlay-of="<KEY>">` `.mk-overlay` `.mk-region[data-region=overlay]` `.mk-grid-2`
Nguồn: Enrico topic modal · M3 dialog

### overlay-sheet — Bottom sheet thông tin / hành động
Dùng khi: thông tin bổ sung, danh sách hành động, bước phụ không rời màn (xem QR eSIM, hướng dẫn cài). | Archetype: overlay
Khối: nền mờ · sheet đáy (grabber · tiêu đề · nội dung · 1–2 nút)
```
┌──────────────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  .mk-overlay
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ┌──────────────────────────────────┐ │  sheet
│ │        ──                       │ │
│ │ Cài đặt eSIM                     │ │
│ │ ▣▣▣▣▣▣▣▣ QR 1:1                  │ │  .mk-thumb
│ │ ▣▣▣▣▣▣▣▣                         │ │
│ │ 1. Mở Cài đặt › Di động          │ │
│ │ 2. Thêm eSIM › Quét mã           │ │
│ │                                  │ │
│ │ ( Sao chép mã )  ( Đã hiểu )     │ │  .mk-grid-2
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```
Class dùng: `<body data-overlay="sheet" data-overlay-of="<KEY>">` `.mk-overlay` `.mk-region[data-region=overlay]` `.mk-thumb` `.mk-grid-2`
Nguồn: Enrico topic modal · M3 bottom sheet

## home

### home-hero-quickactions — Hero + hàng quick action + section + tabbar
Dùng khi: trang chủ / dashboard app (số dư, banner, lối tắt, danh sách gần đây). | Archetype: home
Khối: appbar · hero số dư/banner · hàng 4 quick action (icon + nhãn) · section list/carousel · tabbar
```
┌──────────────────────────────────────┐
│ ≡  Xin chào, An               ○ ○   │  appbar
├──────────────────────────────────────┤
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │  hero (banner / số dư)
│ Gói đang dùng: Nhật Bản · còn 3 ngày │
├──────────────────────────────────────┤
│   ○        ○        ○        ○      │  .mk-grid-4 quick action
│ Mua gói   Gói tôi   Nạp     Hỗ trợ   │
├──────────────────────────────────────┤
│ Điểm đến phổ biến              Xem › │  section heading
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌───···   │  .mk-hscroll card
│ │ ▣    │ │ ▣    │ │ ▣    │ │        │
│ │Nhật  │ │Hàn   │ │Thái  │ │        │
│ └──────┘ └──────┘ └──────┘ └───      │
├──────────────────────────────────────┤
│ ○ Trang chủ  ○ Gói  ○ Đơn  ○ Tôi    │  .mk-tabbar
└──────────────────────────────────────┘
```
Class dùng: `.mk-region[data-region=hero]` `.mk-grid-4` `.mk-hscroll` `.mk-thumb` `.mk-tabbar`
Nguồn: Magdoub/claude-wireframe-skill (MIT) · Enrico topic profile/news

## settings

### settings-groups — Profile row + nhóm dòng
Dùng khi: cài đặt, tài khoản, trung tâm trợ giúp. | Archetype: settings
Khối: appbar · profile row (avatar + tên + meta) · nhóm dòng (icon · nhãn · chevron/toggle) · tabbar (tuỳ)
```
┌──────────────────────────────────────┐
│ ≡  Tài khoản                        │  appbar
├──────────────────────────────────────┤
│ ▣  Nguyễn Văn A                 →   │  .mk-split (profile row)
│    09xx xxx xxx · Đã xác thực        │
├──────────────────────────────────────┤
│ TÀI KHOẢN                            │  nhóm (.mk-meta)
│ ○ Thông tin cá nhân            ›    │  dòng
│ ○ Giấy tờ định danh            ›    │
│ ○ Phương thức thanh toán       ›    │
│ CÀI ĐẶT                              │
│ ○ Thông báo                  [ ●━ ] │  .mk-field[data-type=toggle]
│ ○ Ngôn ngữ · Tiếng Việt        ›    │
│ ○ Đăng xuất                          │
├──────────────────────────────────────┤
│ ○ Trang chủ  ○ Gói  ○ Đơn  ○ Tôi    │  .mk-tabbar
└──────────────────────────────────────┘
```
Class dùng: `.mk-split` `.mk-thumb[data-ratio=1x1]` `.mk-region[data-region=list]` `.mk-field[data-type=toggle]` `.mk-tabbar`
Nguồn: Enrico topic settings/profile · M3 canonical (list)

## web — 2 khung: quản trị (BO/CMS) `.mk-web-shell` · khách hàng (IB/portal) `.mk-web`

Màn `platform: "web"` CHỈ chọn pattern trong mục này (cột **Web** ở bảng tra cuối file) — KHÔNG lấy
pattern mobile; ngược lại màn mobile không lấy pattern web. Chọn KHUNG theo nội dung tài liệu (agent
quyết; ảnh mockup BA thắng; `layoutRefs` topic `web-*` nếu daemon có = gợi ý thứ tự khối):

- **Web quản trị (BO/CMS)** — người vận hành: quản lý / tra cứu / duyệt / cấu hình, menu trái nhiều mục,
  bảng dữ liệu → khung `.mk-web-shell` = `.mk-sidenav` 240px + `.mk-topbar` (breadcrumb + tài khoản)
  + `.mk-main` (nội dung; `.mk-sticky` dính đáy `.mk-main`).
- **Web khách hàng (IB/portal)** — khách tự phục vụ: mua / đăng ký / tra cứu của mình, ít mục, có footer
  → khung `.mk-web` = `.mk-navbar` ngang + nội dung 1200px + `.mk-footer`.
- Chung cho cả 2 khung: `web-auth-split` (đăng nhập), `web-result-center` (kết quả).

Ký hiệu thêm cho sketch web: cột trái 13 ký tự = `.mk-sidenav` (mục hiện tại `●`) · `▨` vùng chart ·
`░` nền mờ · `‹ [1] 2 3 ›` = `.mk-pagination`.

### Web quản trị (BO/CMS) — khung `.mk-web-shell`

### web-table-filters — Thanh lọc + bảng + phân trang + nút hành động (mặc định BO)
Dùng khi: màn quản lý / tra cứu / danh sách bản ghi trong BO (đơn hàng, giao dịch, người dùng, cấu hình). | Archetype: table / list (web BO)
Khối: topbar (breadcrumb + tài khoản) · sidenav · tiêu đề + nút hành động phải · filterbar (search + select + ngày + nút Lọc) · bảng (header + 3–4 hàng mẫu, cột trạng thái chip, cột thao tác) · pagination
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Đơn hàng                    ○ Admin ▾│  .mk-topbar (.mk-breadcrumb · .mk-meta tài khoản)
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Quản lý đơn hàng           ( Xuất Excel ) (+ Tạo)│  .mk-row[data-cols="1fr auto"] tiêu đề + nút
│ ● Đơn hàng  │ [🔍 Mã đơn, SĐT ] [Trạng thái ▾] [Từ ngày 📅] (Lọc)│  .mk-filterbar > .mk-field ×n + .mk-btn
│ ○ Gói cước  │ MÃ ĐƠN│ KHÁCH HÀNG  │ GÓI    │ TRẠNG THÁI │ TIỀN │  .mk-table[data-cols="5"] · .mk-tr[data-head]
│ ○ Khách hàng│ #0912 │ Nguyễn Văn A│ 5GB·7n │ (Đã TT)    │ 230k │  hàng .mk-tr (chip trạng thái .mk-chip)
│ ○ Báo cáo   │ #0911 │ Trần Thị B  │ 3GB·5n │ (Chờ TT)   │ 180k │
│             │ #0910 │ Lê Văn C    │ 5GB·7n │ (Đã huỷ)   │ 250k │
│ CẤU HÌNH    │ #0909 │ Phạm D      │ 1GB·3n │ (Đã TT)    │  90k │  tối đa 3–4 hàng mẫu
│ ○ Tham số   │                                                  │
│ ○ Người dùng│ 1–20 / 245                 ‹  [1]  2  3  …  13  ›│  .mk-pagination (.mk-meta trái, [data-on] trang hiện tại)
│ ○ Cài đặt   │                                                  │
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-sidenav` `.mk-topbar` `.mk-breadcrumb` `.mk-main` `.mk-row[data-cols="1fr auto"]` `.mk-filterbar` `.mk-field[data-type=search|select|date]` `.mk-btn` `.mk-table[data-cols]` `.mk-tr[data-head]` `.mk-chip` `.mk-pagination`
Nguồn: Admin shell (AdminLTE/Tabler, MIT) · tự đặt (BO)

### web-master-detail — List-detail 2 panel
Dùng khi: tra cứu / xử lý từng bản ghi liên tục: danh sách bên trái, chi tiết bên phải, không rời trang. | Archetype: list / detail (web BO)
Khối: topbar · sidenav · `.mk-row` [ panel list (search + rows + pagination) 1/3 | panel detail (header + kv + timeline) 2/3 ]
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Đơn hàng › #0912            ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ [🔍 Tìm đơn    ]  │ Đơn #SIM-2025-0912   (Huỷ đơn)│  .mk-row[data-cols="1fr 2fr"] · trái: .mk-field search
│ ● Đơn hàng  │ ▣ #0912 · 230k ● │ ──────────────────────────────│  trái: .mk-split (dòng chọn đậm)
│ ○ Gói cước  │ ▣ #0911 · 180k   │ Khách hàng   │ Nguyễn Văn A   │  phải: .mk-kv
│ ○ Khách hàng│ ▣ #0910 · 250k   │ Gói          │ 5GB/ngày·7 ngày│
│ ○ Báo cáo   │ ▣ #0909 · 90k    │ Trạng thái   │ Đã thanh toán  │
│             │ ▣ #0908 · 120k   │ Thời gian    │ 12/09 10:32    │
│ CẤU HÌNH    │                  │ ──────────────────────────────│
│ ○ Tham số   │                  │ Lịch sử xử lý                 │
│ ○ Người dùng│ ‹ [1] 2 3 ›      │ ● Tạo đơn ● Thanh toán ○ eSIM │  .mk-pagination · .mk-stepper
│ ○ Cài đặt   │                                                  │
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` (hoặc `.mk-web` khi không có menu trái) `.mk-row[data-cols="1fr 2fr"]` `.mk-field[data-type=search]` `.mk-split` `.mk-pagination` `.mk-kv` `.mk-stepper`
Nguồn: M3 canonical list-detail

### web-detail-tabs — Header bản ghi + tab + bảng kv + hành động phải
Dùng khi: xem / xử lý 1 bản ghi có nhiều nhóm thông tin (đơn hàng, khách hàng, hồ sơ KYC) — chi tiết là cả trang. | Archetype: detail (web BO)
Khối: topbar (breadcrumb tới bản ghi) · sidenav · header bản ghi (tên + chip trạng thái + hàng nút phải) · meta 1 dòng · tabs · nội dung tab = `.mk-grid-2` × `.mk-kv` · timeline (tuỳ)
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Đơn hàng › #SIM-2025-0912   ○ Admin ▾│  .mk-topbar (.mk-breadcrumb tới bản ghi)
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Đơn #SIM-2025-0912 (Đã TT)   ( Huỷ ) ( Cấp lại ) │  .mk-row[data-cols="1fr auto"] header + .mk-chip + nút phải
│ ● Đơn hàng  │ Nguyễn Văn A · 09xx xxx xxx · tạo 12/09 10:32    │  .mk-meta
│ ○ Gói cước  │  Thông tin  │ Lịch sử │ Thanh toán │ Ghi chú     │  .mk-tabs ([data-on] = tab hiện tại)
│ ○ Khách hàng│ ──────────                                       │
│ ○ Báo cáo   │ Gói        │ 5GB · 7ng │ Kích hoạt  │ Khi đến nơi│  .mk-grid-2 > .mk-kv ×2
│             │ Nhà mạng   │ Docomo    │ eSIM        │ Đã cấp    │
│ CẤU HÌNH    │ Số tiền    │ 230.000đ  │ Kênh        │ App       │
│ ○ Tham số   │ ─────────────────────────────────────────────────│
│ ○ Người dùng│ Lịch sử xử lý  ● Tạo đơn  ● Thanh toán ○ Cấp eSIM│  .mk-stepper (tuỳ)
│ ○ Cài đặt   │                                                  │
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-breadcrumb` `.mk-row[data-cols="1fr auto"]` `.mk-chip` `.mk-btn` `.mk-meta` `.mk-tabs` `.mk-grid-2` `.mk-kv` `.mk-stepper`
Nguồn: Admin shell (AdminLTE/Tabler, MIT) · M3 canonical (tabs)

### web-form-two-col — Form 2 cột + panel phụ phải (thay `web-two-col-form`)
Dùng khi: tạo / sửa bản ghi trong BO có ≥ 4 trường; panel phụ = trạng thái, ảnh, ghi chú, tóm tắt. Alias cũ: `web-two-col-form` (đọc như id này). | Archetype: form / checkout (web BO)
Khối: topbar · sidenav · tiêu đề · `.mk-row` [ form 2/3 (`.mk-grid-2` cặp trường + trường dài) | panel phụ 1/3 (select trạng thái, thumb, ghi chú) ] · `.mk-sticky` Huỷ / Lưu
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Gói cước › Tạo gói          ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Tạo gói cước mới                                 │  tiêu đề trang
│ ○ Đơn hàng  │ THÔNG TIN GÓI                   │ Trạng thái     │  .mk-row[data-cols="2fr 1fr"] · trái .mk-region form · phải panel phụ
│ ● Gói cước  │ Tên gói         │ Quốc gia      │ [ Nháp      ▾ ]│  .mk-grid-2 > .mk-field ×2
│ ○ Khách hàng│ [             ] │ [ Chọn    ▾ ] │ ────────────── │
│ ○ Báo cáo   │ Dung lượng/ngày │ Thời hạn      │ Ảnh gói        │
│             │ [ GB         ] │ [ ngày      ]  │ ▣▣▣▣▣▣ 16:9    │  .mk-thumb
│ CẤU HÌNH    │ Mô tả                           │ ────────────── │
│ ○ Tham số   │ [                             ] │ Ghi chú nội bộ │  .mk-field[data-type=textarea]
│ ○ Người dùng│ ═════════════════════════════════════════════════│  .mk-sticky (trong .mk-main)
│ ○ Cài đặt   │ ( Huỷ )                             (  Lưu gói  )│  .mk-row: .mk-btn + cta
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-row[data-cols="2fr 1fr"]` `.mk-region[data-region=form]` `.mk-grid-2` `.mk-field[data-type=text|select|textarea]` `.mk-thumb` `.mk-sticky` `.mk-btn`
Nguồn: M3 canonical supporting pane · tự đặt (BO)

### web-wizard-stepper — Wizard nhiều bước trên 1 trang
Dùng khi: tạo đối tượng phức tạp ≥ 3 bước có xác nhận cuối (chiến dịch khuyến mãi, onboarding merchant, cấu hình gói). | Archetype: form / wizard (web BO)
Khối: topbar · sidenav · tiêu đề · `.mk-stepper` ngang 3–4 bước có nhãn · nội dung bước hiện tại (`.mk-region` form, `.mk-grid-2`) · `.mk-sticky` Quay lại / Tiếp tục
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Khuyến mãi › Tạo mới        ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Tạo chiến dịch khuyến mãi                        │  tiêu đề trang
│ ● Khuyến mãi│ ●────────────●────────────○────────────○         │  .mk-stepper 4 bước ([data-done] [data-on])
│ ○ Gói cước  │ Thông tin     Điều kiện    Gói áp dụng   Xác nhận│
│ ○ Khách hàng│ ─────────────────────────────────────────────────│
│ ○ Báo cáo   │ Loại giảm              │ Mức giảm                │  .mk-region form > .mk-grid-2 > .mk-field
│             │ [ Phần trăm       ▾ ]  │ [ %                 ]   │
│ CẤU HÌNH    │ Từ ngày                │ Đến ngày                │
│ ○ Tham số   │ [ dd/mm/yyyy    📅 ]    │ [ dd/mm/yyyy     📅 ]    │
│ ○ Người dùng│ ═════════════════════════════════════════════════│  .mk-sticky
│ ○ Cài đặt   │ ( Quay lại )                       (  Tiếp tục  )│  .mk-row: .mk-btn + cta
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-stepper` `.mk-region[data-region=form]` `.mk-grid-2` `.mk-field[data-type=select|date|text]` `.mk-sticky` `.mk-btn`
Nguồn: M3 canonical (progress) · tự đặt (BO)

### web-modal-form — Dialog form trên trang bảng mờ
Dùng khi: thêm / sửa nhanh 1 bản ghi ít trường, chọn 1 mục, xác nhận có tham số — không rời màn bảng (thêm người dùng, đổi trạng thái, chọn gói). | Archetype: overlay / picker (web BO)
Khối: màn nền = shell + bảng mờ (`.mk-overlay`) · dialog giữa 520–720px (tiêu đề + ✕ · `.mk-grid-2` trường · trường dài · hàng nút phải Huỷ / Lưu)
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ ░░░░ Trang chủ › Người dùng ░░░░░░░░░░░░░░░░░░░░░│  .mk-overlay bọc cả shell (nền mờ)
├─────────────┬──────────────────────────────────────────────────┤
│ ░ Tổng quan │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  bảng phía sau mờ
│ ░ Đơn hàng  │░░░░░┌──────────────────────────────────────┐░░░░░│  dialog .mk-region[data-region=overlay]
│ ░ Gói cước  │░░░░░│ Thêm người dùng                     ✕│░░░░░│
│ ░ Khách hàng│░░░░░│ Họ tên           │ Email             │░░░░░│  .mk-grid-2 > .mk-field
│ ░ Báo cáo   │░░░░░│ [              ] │ [               ] │░░░░░│
│             │░░░░░│ Vai trò                              │░░░░░│
│ CẤU HÌNH    │░░░░░│ [ Chọn vai trò                    ▾ ]│░░░░░│  .mk-field[data-type=select]
│ ░ Tham số   │░░░░░│                                      │░░░░░│
│ ░ Người dùng│░░░░░│             ( Huỷ )      (  Lưu  )   │░░░░░│  .mk-row nút phải: .mk-btn + cta
│ ░ Cài đặt   │░░░░░└──────────────────────────────────────┘░░░░░│
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `<body data-overlay="dialog" data-overlay-of="<KEY màn bảng>">` `.mk-overlay[data-frame=web]` `.mk-region[data-region=overlay]` `.mk-grid-2` `.mk-field` `.mk-row` `.mk-btn`
Nguồn: Enrico topic modal · M3 dialog · Admin shell (AdminLTE/Tabler, MIT)

### web-dashboard-cards — KPI cards + chart + bảng nhỏ
Dùng khi: trang tổng quan / thống kê / báo cáo: vài con số lớn, 1–2 biểu đồ, danh sách mới nhất. | Archetype: dashboard / home (web BO)
Khối: topbar · sidenav · tiêu đề + bộ lọc thời gian phải · `.mk-grid-4` × `.mk-kpi` · `.mk-row` [ `.mk-chart` 2/3 | bảng xếp hạng nhỏ 1/3 ] · bảng "mới nhất" (tuỳ)
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Tổng quan                   ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ● Tổng quan │ Tổng quan hoạt động          [ 01/09 – 30/09  📅 ]│  .mk-row[data-cols="1fr auto"] + .mk-field date
│ ○ Đơn hàng  │ DOANH THU  │ ĐƠN HÀNG   │ KHÁCH MỚI  │ TỶ LỆ HUỶ │  .mk-grid-4 > .mk-kpi (nhãn)
│ ○ Gói cước  │ 1,2 tỷ     │ 3.245      │ 812        │ 2,1%      │  số lớn (.mk-kpi-v)
│ ○ Khách hàng│ ▲ 12%      │ ▲ 8%       │ ▼ 3%       │ ▼ 0,4%    │  .mk-meta so kỳ trước
│ ○ Báo cáo   │ Doanh thu theo ngày             │ Top gói bán    │  .mk-row[data-cols="2fr 1fr"]
│             │ ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨ │ 1. 5GB·7n  42% │  trái: .mk-chart[data-kind=bar] · phải: .mk-table[data-cols="3"]
│ CẤU HÌNH    │ ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨ │ 2. 3GB·5n  27% │
│ ○ Tham số   │ ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨ │ 3. 1GB·3n  15% │
│ ○ Người dùng│ Đơn mới nhất  #0912 · #0911 · #0910  Xem tất cả ›│  .mk-table nhỏ 3 hàng (tuỳ)
│ ○ Cài đặt   │                                                  │
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-row[data-cols="1fr auto"|"2fr 1fr"]` `.mk-field[data-type=date]` `.mk-grid-4` `.mk-kpi` (`.mk-kpi-l` + `.mk-kpi-v` + `.mk-meta`) `.mk-chart[data-kind=bar|line|pie][data-label]` `.mk-table[data-cols]`
Nguồn: Admin shell (AdminLTE/Tabler, MIT) · tự đặt (BO)

### web-settings-sidenav — Nav dọc phụ + form nhóm
Dùng khi: cài đặt hệ thống / hồ sơ tài khoản / phân quyền: nhiều nhóm thiết lập, mỗi nhóm 1 trang form ngắn. | Archetype: settings (web BO)
Khối: topbar · sidenav · tiêu đề · `.mk-row` [ nav dọc phụ 1/3 (`.mk-region[data-region=nav]`, mục hiện tại đậm) | form nhóm 2/3 (`.mk-field`, `.mk-grid-2`, toggle, nút Lưu phải) ]
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Cài đặt hệ thống            ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Cài đặt hệ thống                                 │  tiêu đề trang
│ ○ Đơn hàng  │ ● Chung        │ THÔNG TIN CHUNG                 │  .mk-row[data-cols="1fr 2fr"] · trái: .mk-region nav (dọc phụ) · phải: .mk-region form
│ ○ Gói cước  │ ○ Thanh toán   │ Tên hệ thống                    │  .mk-field
│ ○ Khách hàng│ ○ Thông báo    │ [ SIM Admin                    ]│
│ ○ Báo cáo   │ ○ Phân quyền   │ Múi giờ       │ Ngôn ngữ        │  .mk-grid-2 > .mk-field select ×2
│             │ ○ Tích hợp     │ [ GMT+7   ▾ ] │ [ Tiếng Việt ▾ ]│
│ CẤU HÌNH    │                │ Bật xác thực 2 lớp        [ ●━ ]│  .mk-field[data-type=toggle]
│ ○ Tham số   │                │ ────────────────────────────────│
│ ○ Người dùng│                │ THÔNG BÁO                       │  nhóm 2 (tuỳ)
│ ● Cài đặt   │                │               (  Lưu thay đổi  )│  cta phải (hoặc .mk-sticky)
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-row[data-cols="1fr 2fr"]` `.mk-region[data-region=nav]` `.mk-region[data-region=form]` `.mk-field[data-type=text|select|toggle]` `.mk-grid-2` `.mk-region[data-region=cta]`
Nguồn: Enrico topic settings · Admin shell (AdminLTE/Tabler, MIT)

### web-empty-state — Trang chưa có dữ liệu / không tìm thấy
Dùng khi: empty state trong BO (chưa có bản ghi, lọc không ra kết quả, chưa cấu hình) — giữ tiêu đề + filterbar để nhận biết màn. | Archetype: status (web BO)
Khối: topbar · sidenav · tiêu đề + nút Tạo mới · filterbar (tuỳ) · khối `.mk-region[data-region=status]` giữa (minh hoạ + 1 câu + gợi ý + cta giữa)
```
┌────────────────────────────────────────────────────────────────┐
│ ≡ SIM Admin │ Trang chủ › Khuyến mãi                  ○ Admin ▾│  .mk-topbar
├─────────────┬──────────────────────────────────────────────────┤  .mk-sidenav | .mk-main
│ ○ Tổng quan │ Chiến dịch khuyến mãi                 (+ Tạo mới)│  .mk-row[data-cols="1fr auto"]
│ ● Khuyến mãi│ [🔍 Tìm chiến dịch    ] [Trạng thái ▾]       (Lọc)│  .mk-filterbar (tuỳ)
│ ○ Gói cước  │ ┌──────────────────────────────────────────────┐ │  .mk-region[data-region=status] (giữa, 1 khối)
│ ○ Khách hàng│ │                  ▣▣▣▣▣▣▣▣                    │ │  .mk-thumb[data-size=lg]
│ ○ Báo cáo   │ │                  ▣▣▣▣▣▣▣▣                    │ │
│             │ │          Chưa có chiến dịch nào              │ │  status text
│ CẤU HÌNH    │ │   Tạo chiến dịch đầu tiên để áp dụng mã giảm │ │
│ ○ Tham số   │ │                                              │ │
│ ○ Người dùng│ │            (  Tạo chiến dịch  )              │ │  cta giữa (không sticky)
│ ○ Cài đặt   │ └──────────────────────────────────────────────┘ │
└─────────────┴──────────────────────────────────────────────────┘
```
Class dùng: `.mk-web-shell` `.mk-row[data-cols="1fr auto"]` `.mk-filterbar` `.mk-region[data-region=status]` `.mk-thumb[data-size=lg]` `.mk-region[data-region=cta]`
Nguồn: Enrico topic tutorial · tự đặt (BO)

### Web khách hàng (IB/portal) — khung `.mk-web`

### web-portal-list — Hero mỏng + filter + card 3 cột
Dùng khi: trang danh mục / kết quả tìm cho khách (gói cước theo quốc gia, sản phẩm, ưu đãi); cũng là trang chủ portal khi nội dung chính là catalogue. | Archetype: list / home (web portal)
Khối: navbar ngang · hero mỏng (tiêu đề + 1 câu) · filterbar (search + select + sắp xếp phải) · `.mk-grid-3` card (thumb 16:9 + tên + giá + nút) · pagination giữa · footer
```
┌────────────────────────────────────────────────────────────────┐
│ ▣ SIM Du lịch  Trang chủ  Gói cước  Đơn của tôi  Hỗ trợ  ○ An ▾│  .mk-navbar ([data-on] mục hiện tại, .mk-meta tài khoản phải)
├────────────────────────────────────────────────────────────────┤
│ Gói cước Nhật Bản                                              │  .mk-region[data-region=hero] mỏng
│ Chọn gói phù hợp cho chuyến đi của bạn                         │
├────────────────────────────────────────────────────────────────┤
│ [🔍 Tìm quốc gia     ] [Thời hạn ▾] [Dung lượng ▾]     Sắp xếp ▾│  .mk-filterbar
│ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ │  .mk-grid-3 > .mk-region card
│ │ ▣▣▣▣▣▣▣▣▣▣ 16:9  │ │ ▣▣▣▣▣▣▣▣▣▣ 16:9  │ │ ▣▣▣▣▣▣▣▣▣▣ 16:9  │ │  .mk-thumb[data-ratio=16x9]
│ │ Gói 5GB/ngày     │ │ Gói 3GB/ngày     │ │ Gói 1GB/ngày     │ │
│ │ 7 ngày · Docomo  │ │ 5 ngày · Docomo  │ │ 3 ngày · SoftBank│ │  .mk-meta
│ │ 250.000đ  (Mua)  │ │ 180.000đ  (Mua)  │ │ 90.000đ   (Mua)  │ │  giá + .mk-btn
│ └──────────────────┘ └──────────────────┘ └──────────────────┘ │
│                          ‹  [1]  2  3  ›                       │  .mk-pagination (giữa)
│ © SIM Du lịch · Điều khoản · Chính sách · Liên hệ              │  .mk-footer
└────────────────────────────────────────────────────────────────┘
```
Class dùng: `.mk-web` `.mk-navbar` `.mk-region[data-region=hero]` `.mk-filterbar` `.mk-field[data-type=search|select]` `.mk-grid-3` `.mk-thumb[data-ratio=16x9]` `.mk-meta` `.mk-btn` `.mk-pagination` `.mk-footer`
Nguồn: M3 canonical feed · Enrico topic gallery/list · tự đặt (portal)

### web-portal-detail — 2 cột nội dung + panel tóm tắt phải
Dùng khi: trang chi tiết sản phẩm / gói / đơn của khách: nội dung dài bên trái, panel giá + cta dính bên phải. | Archetype: detail (web portal)
Khối: navbar · breadcrumb · `.mk-row` [ trái 2/3: hero 16:9 + tên + tabs + nội dung tab | phải 1/3: panel tóm tắt `[data-sticky=top]` (tên + giá + kv + cta) ] · footer
```
┌────────────────────────────────────────────────────────────────┐
│ ▣ SIM Du lịch  Trang chủ  Gói cước  Đơn của tôi  Hỗ trợ  ○ An ▾│  .mk-navbar
├────────────────────────────────────────────────────────────────┤
│ Trang chủ › Gói cước › Nhật Bản › Gói 5GB/ngày                 │  .mk-breadcrumb
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ 16:9     │ Gói 5GB/ngày · 7 ngày│  .mk-row[data-cols="2fr 1fr"] · phải: .mk-region[data-sticky=top]
│ Gói 5GB/ngày · Nhật Bản                 │ 250.000đ             │  trái: .mk-thumb + tên
│  Mô tả  │ Điều kiện │ Đánh giá          │ ─────────────────────│  .mk-tabs
│ ─────────                               │ Dung lượng │ 5GB/ngày│  phải: .mk-kv
│ • Dùng cho eSIM và SIM vật lý           │ Thời hạn   │ 7 ngày  │
│ • Kích hoạt tự động khi đến nơi         │ Nhà mạng   │ Docomo  │
│ • Hỗ trợ hotspot                        │ ─────────────────────│
│                                         │   (  Mua ngay  )     │  cta trong panel
│ © SIM Du lịch · Điều khoản · Chính sách · Liên hệ              │  .mk-footer
└────────────────────────────────────────────────────────────────┘
```
Class dùng: `.mk-web` `.mk-navbar` `.mk-breadcrumb` `.mk-row[data-cols="2fr 1fr"]` `.mk-thumb[data-ratio=16x9]` `.mk-tabs` `.mk-region[data-sticky=top]` `.mk-kv` `.mk-region[data-region=cta]` `.mk-footer`
Nguồn: M3 canonical supporting pane · Enrico topic news · tự đặt (portal)

### web-portal-form-summary — Form + tóm tắt / tổng tiền dính phải
Dùng khi: đăng ký / đặt mua / thanh toán trên portal: form dài bên trái, tóm tắt đơn + tổng tiền + cta luôn thấy bên phải. | Archetype: form / checkout (web portal)
Khối: navbar · `.mk-stepper` · `.mk-row` [ trái 2/3: `.mk-region` form (`.mk-grid-2` cặp trường + trường dài) + nút Quay lại | phải 1/3: panel `[data-sticky=top]` (split đơn + kv tiền + cta) ] · footer
```
┌────────────────────────────────────────────────────────────────┐
│ ▣ SIM Du lịch  Trang chủ  Gói cước  Đơn của tôi  Hỗ trợ  ○ An ▾│  .mk-navbar
├────────────────────────────────────────────────────────────────┤
│ ●────────●────────○   Bước 2/3 · Thông tin người dùng          │  .mk-stepper
│ THÔNG TIN NGƯỜI DÙNG                    │ Tóm tắt đơn          │  .mk-row[data-cols="2fr 1fr"] · phải: .mk-region[data-sticky=top]
│ Họ tên            │ Số CCCD             │ ▣ Gói 5GB · Nhật Bản │  .mk-grid-2 > .mk-field · .mk-split
│ [               ] │ [               ]   │ ─────────────────────│
│ Số điện thoại     │ Email               │ Giá gói   │ 250.000đ │  .mk-kv[data-total]
│ [               ] │ [               ]   │ Giảm      │ −20.000đ │
│ Địa chỉ nhận SIM (SIM vật lý)           │ Tổng      │ 230.000đ │
│ [                                     ] │ ─────────────────────│
│                                         │  (  Thanh toán  )    │  cta trong panel dính
│ ( Quay lại )                            │                      │  .mk-btn
│ © SIM Du lịch · Điều khoản · Chính sách · Liên hệ              │  .mk-footer
└────────────────────────────────────────────────────────────────┘
```
Class dùng: `.mk-web` `.mk-navbar` `.mk-stepper` `.mk-row[data-cols="2fr 1fr"]` `.mk-region[data-region=form]` `.mk-grid-2` `.mk-field` `.mk-region[data-sticky=top]` `.mk-split` `.mk-kv[data-total]` `.mk-region[data-region=cta]` `.mk-btn` `.mk-footer`
Nguồn: M3 canonical supporting pane · tự đặt (portal)

### web-auth-split — Đăng nhập / đăng ký 2 nửa
Dùng khi: login, đăng ký, quên mật khẩu, OTP trên web (cả BO lẫn portal): nửa trái minh hoạ, nửa phải form ngắn. | Archetype: form / auth (web)
Khối: `.mk-row[data-fill]` [ trái 1/2: `.mk-thumb` minh hoạ full-height + slogan | phải 1/2: logo · tiêu đề · 2–3 `.mk-field` · link phụ · cta · "hoặc" · `.mk-grid-2` nút đăng nhập khác · link đăng ký ]
```
┌────────────────────────────────────────────────────────────────┐
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   ▣ SIM Du lịch                │  .mk-row[data-fill] · trái: .mk-thumb minh hoạ · phải: form
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   Đăng nhập                    │  tiêu đề
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   Số điện thoại                │  .mk-field
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   [ 09xx xxx xxx             ] │
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   Mật khẩu                     │
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   [ ••••••••                 ] │
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │                  Quên mật khẩu?│  link phụ
│ ▣▣▣▣ Đi xa, luôn kết nối ▣▣▣▣ │   (       Đăng nhập       )    │  .mk-region[data-region=cta]
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   ──────── hoặc ────────       │
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   ( Google )   ( Ví VNPAY )    │  .mk-grid-2 > .mk-btn
│ ▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣▣ │   Chưa có tài khoản? Đăng ký   │  link .mk-meta
└────────────────────────────────────────────────────────────────┘
```
Class dùng: `.mk-web` `.mk-row[data-fill]` `.mk-thumb` `.mk-region[data-region=form]` `.mk-field[data-type=text|otp]` `.mk-region[data-region=cta]` `.mk-grid-2` `.mk-btn` `.mk-meta`
Nguồn: Enrico topic login · Admin shell (AdminLTE/Tabler, MIT) trang login

### web-result-center — Kết quả giữa trang + card tóm tắt + hàng nút
Dùng khi: màn thành công / thất bại sau thanh toán, đăng ký, gửi yêu cầu trên web (BO lẫn portal). | Archetype: result (web)
Khối: navbar (portal) hoặc shell (BO) · `.mk-region[data-region=status]` giữa, tối đa 520px: `.mk-status` + tiêu đề + mã đơn · card `.mk-kv` · `.mk-grid-3` nút (cta giữa, không sticky) · footer
```
┌────────────────────────────────────────────────────────────────┐
│ ▣ SIM Du lịch  Trang chủ  Gói cước  Đơn của tôi  Hỗ trợ  ○ An ▾│  .mk-navbar (BO: thay bằng .mk-web-shell)
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                            ┌──────┐                            │  .mk-status[data-kind=ok|fail]
│                            │  ✓   │                            │
│                            └──────┘                            │
│                       Thanh toán thành công                    │  status text
│                 Mã đơn #SIM-2025-0912 · 12/09 10:32            │  .mk-meta
│           ┌────────────────────────────────────────┐           │  card .mk-region content (max 520px, giữa)
│           │ Gói            │ 5GB/ngày · 7 ngày     │           │  .mk-kv
│           │ Số tiền        │ 230.000đ              │           │
│           │ Kích hoạt      │ Khi đến nơi           │           │
│           └────────────────────────────────────────┘           │
│            ( Xem eSIM )   ( Tải hoá đơn )  (Về trang chủ)      │  .mk-grid-3: .mk-btn ×2 + cta
│ © SIM Du lịch · Điều khoản · Chính sách · Liên hệ              │  .mk-footer
└────────────────────────────────────────────────────────────────┘
```
Class dùng: `.mk-web` (hoặc `.mk-web-shell`) `.mk-region[data-region=status]` `.mk-status[data-kind=ok|fail|wait]` `.mk-kv` `.mk-grid-3` `.mk-btn` `.mk-region[data-region=cta]` `.mk-footer`
Nguồn: Enrico topic modal · tự đặt (portal)

---

## Bảng tra nhanh archetype → pattern gợi ý

| Archetype | Ưu tiên 1 (mobile) | Ưu tiên 2 (mobile) | Web (BO / portal) | Ghi chú |
|---|---|---|---|---|
| list | list-search-rows | list-chips-cards / list-segment-tabs / grid-cards-2col | web-table-filters / web-portal-list | có ảnh → grid; có trạng thái → segment; BO tra cứu liên tục → web-master-detail |
| picker | picker-search-groups | picker-grid-3col / picker-sheet | web-modal-form | ≤ 12 mục ngắn → grid-3 |
| detail | detail-hero-kv-cta | detail-tabs | web-detail-tabs / web-portal-detail | ≥ 3 nhóm nội dung dài → tabs |
| form | form-grouped-cards | form-two-col-short | web-form-two-col / web-portal-form-summary | có cặp trường ngắn → two-col; ≥ 3 bước → web-wizard-stepper; đăng nhập → web-auth-split |
| checkout | checkout-summary-sticky | checkout-accordion | web-form-two-col / web-portal-form-summary | ≥ 3 nhóm phải rà → accordion |
| result | result-center-status | result-timeline | web-result-center | có bước tiếp theo → timeline |
| status | status-processing | status-empty | web-empty-state | |
| overlay | overlay-dialog | overlay-sheet / picker-sheet | web-modal-form | quyết định → dialog; nội dung → sheet |
| home | home-hero-quickactions | grid-cards-2col | web-dashboard-cards / web-portal-list | BO → dashboard; portal → list |
| settings | settings-groups | — | web-settings-sidenav | |
| table | — | — | web-table-filters | chỉ màn web; danh sách/quản lý/tra cứu/bảng |
| dashboard | — | — | web-dashboard-cards | chỉ màn web; tổng quan/thống kê/báo cáo |
| web | — | — | theo archetype gốc (cột Web) | archetype cũ; BO hay portal do agent quyết theo tài liệu |
| content | detail-hero-kv-cta | list-search-rows | web-detail-tabs / web-table-filters | tự suy từ nội dung mục tài liệu |

**Luật platform**: màn `platform: "web"` CHỈ chọn id trong cột **Web** (BO = `.mk-web-shell`, portal = `.mk-web`);
màn mobile CHỈ chọn cột Ưu tiên 1/2. Không trộn: không dựng bảng `.mk-table` trong `.mk-mobile`, không dựng
`.mk-tabbar` trong khung web.

Luật đa dạng: hai màn **liền kề theo `navOut`** có archetype khác nhau thì KHÔNG dùng cùng pattern;
mỗi màn có ≥ 1 khối không phải stack dọc (`.mk-grid-*` / `.mk-row` / `.mk-hscroll` / `.mk-split` /
`.mk-kv` / `.mk-sticky` / `.mk-tabs` / `.mk-seg` / `.mk-tabbar` / `.mk-accordion`; web thêm `.mk-table` /
`.mk-filterbar` / `.mk-kpi` / `.mk-chart` / `.mk-sidenav`) khi nội dung cho phép.
