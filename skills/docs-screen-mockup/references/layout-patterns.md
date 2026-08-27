# layout-patterns — catalogue bố cục cho mockup màn (dr-mockup)

Kho pattern **wireframe xám** (không DS, không màu thương hiệu) để stage `dr-mockup` chọn bố cục
theo **archetype** của màn thay vì stack 1 cột. Mỗi màn chọn ĐÚNG 1 pattern → ghi
`<body data-pattern="<id>">` + `pattern` trong `index.json.screens[]`.

Archetype: `list | picker | detail | form | checkout | result | status | overlay | home | settings | web`
(`content` = chưa phân loại được → chọn theo nội dung, thường `detail-hero-kv-cta` hoặc `list-search-rows`).

Nguồn ký hiệu: **Magdoub/claude-wireframe-skill (MIT)** — khối wireframe ASCII mobile;
**M3 canonical** — canonical layouts của Material 3 (list-detail, supporting pane, feed);
**Enrico topic** — topic dataset Enrico (Aalto, MIT: list, form, login, search, menu, profile, settings, modal, gallery, news);
**tự đặt** — rút từ 11 mockup dự án SIM du lịch.

Ưu tiên khi chọn: **ảnh mockup BA (`mockups[]`) thắng** → `layoutRefs` (KB Enrico, nếu daemon có) → catalogue này.
Ký hiệu sketch: `▣` thumb/ảnh · `○` icon · `[ ]` ô nhập · `(  )` nút · `═` sticky · `≡` app bar · `···` cuộn ngang.
Khung sketch = `.mk-mobile` 390px; web (1200px) ghi riêng ở cuối.

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

## web (khung `.mk-web` 1200px)

### web-master-detail — List-detail 2 panel
Dùng khi: màn web quản trị / tra cứu: danh sách bên trái, chi tiết bên phải. | Archetype: web (list/detail)
Khối: appbar · `.mk-row` [ panel list (search + rows) 1/3 | panel detail (hero + kv + cta) 2/3 ]
```
┌────────────────────────────────────────────────────────────────┐
│ ≡  Quản lý đơn hàng                          ○ Admin           │  appbar
├──────────────────────┬─────────────────────────────────────────┤
│ [ 🔍 Tìm đơn       ] │ Đơn #SIM-2025-0912            (Huỷ đơn)│  .mk-row
│ ▣ #0912 · 230.000đ ● │ ───────────────────────────────────────  │  trái: list
│ ▣ #0911 · 180.000đ   │ Khách hàng   │ Nguyễn Văn A             │  phải: .mk-kv
│ ▣ #0910 · 250.000đ   │ Gói          │ 5GB/ngày · 7 ngày        │
│ ▣ #0909 · 90.000đ    │ Trạng thái   │ Đã thanh toán            │
│                      │ Thời gian    │ 12/09 10:32              │
│                      │ ───────────────────────────────────────  │
│                      │ Lịch sử xử lý                            │
│                      │ ● Tạo đơn  ● Thanh toán  ○ Cấp eSIM      │  .mk-stepper
└──────────────────────┴─────────────────────────────────────────┘
```
Class dùng: `.mk-web` `.mk-row[data-cols="1fr 2fr"]` `.mk-field[data-type=search]` `.mk-split` `.mk-kv` `.mk-stepper`
Nguồn: M3 canonical list-detail

### web-two-col-form — Form 2 cột + panel tóm tắt phải
Dùng khi: form web dài (đăng ký, đặt hàng) có tóm tắt / tổng tiền đi kèm. | Archetype: web (form/checkout)
Khối: appbar · `.mk-row` [ form 2/3 (stepper + `.mk-grid-2` trường) | panel tóm tắt 1/3 (kv + cta) ]
```
┌────────────────────────────────────────────────────────────────┐
│ ≡  Đặt mua SIM du lịch                                          │  appbar
├────────────────────────────────────┬───────────────────────────┤
│ ●────●────○  Bước 2/3              │ Tóm tắt đơn               │  .mk-row
│ Họ tên           │ Số CCCD         │ ▣ Gói 5GB/ngày · Nhật Bản │  trái: .mk-grid-2 field
│ [            ]   │ [            ]  │ ───────────────────────── │  phải: .mk-split + .mk-kv
│ Số điện thoại    │ Email           │ Giá gói      │ 250.000đ   │
│ [            ]   │ [            ]  │ Giảm         │ −20.000đ   │
│ Địa chỉ nhận SIM                   │ Tổng         │ 230.000đ   │
│ [                                ] │                           │
│                                    │   (   Thanh toán   )      │  cta trong panel
│ ( Quay lại )         ( Tiếp tục )  │                           │
└────────────────────────────────────┴───────────────────────────┘
```
Class dùng: `.mk-web` `.mk-row[data-cols="2fr 1fr"]` `.mk-stepper` `.mk-grid-2` `.mk-field` `.mk-split` `.mk-kv`
Nguồn: M3 canonical supporting pane · tự đặt

---

## Bảng tra nhanh archetype → pattern gợi ý

| Archetype | Ưu tiên 1 | Ưu tiên 2 | Ghi chú |
|---|---|---|---|
| list | list-search-rows | list-chips-cards / list-segment-tabs / grid-cards-2col | có ảnh → grid; có trạng thái → segment |
| picker | picker-search-groups | picker-grid-3col / picker-sheet | ≤ 12 mục ngắn → grid-3 |
| detail | detail-hero-kv-cta | detail-tabs | ≥ 3 nhóm nội dung dài → tabs |
| form | form-grouped-cards | form-two-col-short | có cặp trường ngắn → two-col |
| checkout | checkout-summary-sticky | checkout-accordion | ≥ 3 nhóm phải rà → accordion |
| result | result-center-status | result-timeline | có bước tiếp theo → timeline |
| status | status-processing | status-empty | |
| overlay | overlay-dialog | overlay-sheet / picker-sheet | quyết định → dialog; nội dung → sheet |
| home | home-hero-quickactions | grid-cards-2col | |
| settings | settings-groups | — | |
| web | web-master-detail | web-two-col-form | theo archetype gốc list/detail hay form/checkout |
| content | detail-hero-kv-cta | list-search-rows | tự suy từ nội dung mục tài liệu |

Luật đa dạng: hai màn **liền kề theo `navOut`** có archetype khác nhau thì KHÔNG dùng cùng pattern;
mỗi màn có ≥ 1 khối không phải stack dọc (`.mk-grid-*` / `.mk-row` / `.mk-hscroll` / `.mk-split` /
`.mk-kv` / `.mk-sticky` / `.mk-tabs` / `.mk-seg` / `.mk-tabbar` / `.mk-accordion`) khi nội dung cho phép.
