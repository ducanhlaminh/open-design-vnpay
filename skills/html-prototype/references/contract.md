# HTML Contract (v1)

Bộ luật mà HTML đầu vào (AI vibe-code sinh ra) **phải tuân** để extractor map sạch sang Figma Auto Layout, deterministic, không cần raster.

> Triết lý: "trả giá trước" ở khâu sinh HTML để "đỡ khổ sau" ở khâu convert. Contract càng chặt → IR càng sạch → file Figma càng đẹp.

## 1. Layout — chỉ Flexbox

| Luật | |
|---|---|
| ✅ Mọi container layout dùng `display: flex` | bắt buộc |
| ✅ Khai báo rõ `flex-direction`, `gap`, `padding` | bắt buộc |
| ✅ `position: absolute` cho **overlay** (FAB, badge, blob, lỗ donut) → `layoutPositioning:ABSOLUTE` | **Phase 5** (xem mục 7) |
| ❌ Cấm `float`, `position: sticky` | v1 |
| ❌ Cấm `display: grid`, `table` | v1 — thay bằng flex lồng nhau |
| ❌ Cấm `flex-wrap: wrap` | v1 — Auto Layout wrap còn hạn chế |

### 7. Overlay — position:absolute (Phase 5)

| Luật | |
|---|---|
| ✅ Phần tử absolute phải là **con trực tiếp** của 1 cha `position:relative` | bắt buộc — Figma định vị theo frame cha |
| ✅ Vị trí lấy từ rect thật (x/y so với góc trái-trên cha); ra khỏi flow, không ảnh hưởng sizing anh em | tự động |
| ✅ Constraint suy theo **cạnh gần hơn** (min/max/center) — không theo `left/right` (computedStyle resolve cả 2 thành px) | |
| ✅ Tràn ra ngoài cha (blob `top:-20px`) vẫn hiện (`clipsContent=false`) | |
| ⚠️ `position:fixed` | coi như absolute theo cha gần nhất |
| ℹ️ Lỗ donut = 1 hình tròn màu nền đặt absolute giữa, đè lên conic | đây là cách "khoét" thay cho `mask` |

## 2. Spacing & Size

| Luật | |
|---|---|
| ✅ Spacing theo thang token: 4 / 8 / 12 / 16 / 20 / 24 / 32 … | nên |
| ✅ Co giãn bằng `flex: 1` (fill) hoặc `width/height` px cố định | |
| ❌ Tránh `%`, `vw`, `vh`, `calc()` cho kích thước | v1 — khó map hug/fill |

## 3. Text

| Luật | |
|---|---|
| ✅ Mỗi đoạn text nằm trong **element riêng** (`<p>`, `<span>`, `<h*>`) | bắt buộc |
| ❌ Không trộn text trực tiếp lẫn element con trong cùng 1 div | v1 — text trực tiếp bị bỏ qua |
| ℹ️ Font bị bỏ qua (luôn render Inter trong Figma) | theo định hướng |

## 4. Color & Style

| Luật | |
|---|---|
| ✅ Màu dùng `rgb/rgba/hex` (extractor tự quy về `{r,g,b,a}`) | |
| ✅ `border-radius`, `border` map được | |
| ✅ `box-shadow` — cả **drop** lẫn **inset** (inset → `INNER_SHADOW`) | Phase 3.0 |
| ✅ **Ảnh**: `<img>` và `background-image: url(...)` (nhúng base64, fill IMAGE) | đã chạy |
| ✅ `overflow: hidden` → `clipsContent=true` (cắt overlay tràn, vd glow trong thẻ) | Phase 5 |
| ✅ `background: linear-gradient(...)` → `GRADIENT_LINEAR` | **Phase 3.1** |
| ✅ `radial-gradient(...)` → `GRADIENT_RADIAL` (tâm `at`, size keyword/px/**%**) | **Phase 3.2/3.3** |
| ✅ `conic-gradient(...)` → `GRADIENT_ANGULAR` (`from <angle>`, tâm `at`, hard-stop) | **Phase 3.2** |
| ✅ `backdrop-filter: blur()` → `BACKGROUND_BLUR`; `filter: blur()` → `LAYER_BLUR` | **Phase 3.3** (glass thật) |
| ✅ Gradient trên chữ (`background-clip:text`) → fill gradient lên text | **Phase 3.3** |
| ❌ Tránh `mix-blend-mode`, `clip-path`, `mask`, `filter` (ngoài blur) | Figma không có tương đương vector |

### 4.1 Luật riêng cho gradient (Phase 3.1–3.2)

| Luật | |
|---|---|
| ✅ Stop **linear** theo `%` hoặc **`px`** (chuẩn hoá theo độ dài đường gradient); **conic** `deg/turn/rad`/`%` | thiếu pos → rải đều |
| ✅ Hard-stop (`color 0% 62%`) → 2 stop cùng màu | OK (donut) |
| ✅ Linear: `Ndeg` / `to <hướng>`; Conic: `from <angle>`; tâm `at x% y%`; radial size `%` (vd `120% 62%`) | |
| ⚠️ Stop radial/conic theo `px` | chưa — dùng `%`/`deg` |
| ⚠️ `radial-gradient(circle ...)` | v1 coi như `ellipse` (lệch khi hộp không vuông) |
| ⚠️ Donut bằng `mask` (khoét lỗ giữa) | Figma không khoét được → ra **đĩa đặc**; muốn lỗ phải đặt 1 hình tròn che giữa (cần `position:absolute`, Phase 5) |
| ℹ️ Linear dài theo cạnh hộp (không kéo tới góc như CSS) | lệch nhỏ ở góc chéo, chấp nhận v1 |

## 5. Cấu trúc

| Luật | |
|---|---|
| ✅ Semantic, hạn chế div wrapper rỗng | extractor sẽ gộp bớt |
| ✅ Đánh dấu component để map Design System: `data-figma-component="Button"` | Phase 4 |
| ✅ Đặt tên layer: `data-figma-name="..."` (mặc định lấy theo tag/class) | tùy chọn |

## 6. Icon — inline SVG (Phase 4.0)

| Luật | |
|---|---|
| ✅ Icon = **inline `<svg>`** (dán path từ Phosphor/Tabler/Lucide) → `createNodeFromSvg` ra vector thật | bắt buộc |
| ✅ Màu icon: `fill="currentColor"` / `stroke="currentColor"` + set `color` ở CSS | extractor bake currentColor → màu computed |
| ✅ Kích thước: đặt `width/height` trên `<svg>` (hoặc CSS); extractor đo & rescale đồng đều | |
| ❌ **KHÔNG** dùng icon font (Phosphor `<i class="ph">`…) | glyph ở `::before`, extractor không đọc được → mất icon |
| ❌ **KHÔNG** dùng `<img src="*.svg">` | `figma.createImage` chỉ nhận PNG/JPG/GIF, không nhận SVG |
| ℹ️ `<svg>` được coi là **leaf** (không tách path con thành layer) | |

## Phần extractor tự xử lý (không cần contract lo)

- Bỏ node ẩn: `display:none`, `visibility:hidden`, `opacity:0`, kích thước 0.
- Quy mọi đơn vị về px (qua `getComputedStyle`).
- Suy ra `fill` / `hug` / `fixed` từ `flex-grow` và ngữ cảnh cha.
