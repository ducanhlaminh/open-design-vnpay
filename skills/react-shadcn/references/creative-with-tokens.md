# Creative-with-tokens — cookbook sáng tác mức A

> Bạn là **art director được phát đúng một bảng màu** — palette của composition
> user chọn (lấy bằng `ui_tokens_get`). Component là khung tranh: ĐỪNG đụng.
> Toàn bộ phần còn lại của bức tranh — nền, hero, band, chip, glow, nhịp section —
> là đất của bạn, miễn mọi màu là **utility ngữ nghĩa của token**. Mỗi màn nên có
> một hướng art direction RIÊNG; hai màn cùng palette không có nghĩa là trông
> giống nhau.

## Vì sao utility token > mọi cách khác

- `bg-primary/12` tự compile thành color-mix từ token → **tự đúng cả dark/light**
  (hardcode literal thì phải làm 2 bản — và bị validator chặn).
- Đổi composition (brand.css mới) → mọi sáng tác của bạn **tự đổi tông theo**,
  không sửa screen.json.

## Bảng pattern (copy-adapt, đừng tự mò cú pháp)

| # | Ý đồ | Class trên element TRANG TRÍ |
|---|---|---|
| 1 | **Hero gradient** 2–3 token | `bg-linear-135 from-primary to-info` · thêm `via-accent` nếu cần 3 chặng |
| 2 | **Glow blob** sau hero/icon (tối đa 2/màn) | `absolute size-48 rounded-full bg-accent/25 blur-3xl` |
| 3 | **Band section** tạo nhịp xen kẽ | `bg-muted/40 rounded-3xl px-6 py-5` (band nhấn: `bg-primary/8`) |
| 4 | **Icon tile** | `flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary` |
| 5 | **Stat/number nhấn** | `type-display-small text-primary` (số phụ: `type-body-small text-muted-foreground`) |
| 6 | **Divider/edge nhấn** | `border-l-4 border-accent pl-4` |
| 7 | **Shadow nhuốm brand** (CTA wrapper, card nổi) | `shadow-lg shadow-primary/20` |
| 8 | **Nền màn riêng** (thay mesh mặc định) | trên ROOT div của screen: `bg-linear-180 from-background to-primary/8` — KHÔNG cần sửa body |
| 9 | **Chip/badge trang trí** (span) | `rounded-full bg-success/15 text-success px-2.5 py-0.5 type-label-small` |
| 10 | **Chart/data màu** | `bg-data-1` `bg-data-2` `bg-data-3` `bg-data-4` (bar/dot/legend) — KHÔNG dùng red/green tự chế |

Mọi token màu trong palette đều có đủ họ utility: `bg-X` · `text-X` · `border-X` ·
`from-X/via-X/to-X` · `ring-X` · `shadow-X` · và tint `X/N` (N = 5–95).

## Luật cặp đôi màu chữ (contrast — bắt buộc)

| Surface | Chữ trên đó |
|---|---|
| Tint nhạt `bg-X/5..20` | `text-X` (cùng token, bản đặc) |
| Đặc `bg-X` | `text-X-foreground` (cặp foreground của chính token đó) |
| Gradient `from-X to-Y` | `text-primary-foreground` (gradient brand luôn đậm) |
| `bg-muted/N` | `text-foreground` hoặc `text-muted-foreground` |

KHÔNG đặt `text-X` lên `bg-X` bản đặc (chữ chìm), không đặt chữ tint lên nền tint
khác họ (`text-info` trên `bg-accent/10` — loạn quan hệ màu).

## Giới hạn (chống lạm dụng)

- ≤ 2 lớp `blur-*` mỗi màn (mobile rất nặng backdrop/blur).
- ≤ 1 hero gradient lớn/màn; band/chip dùng tint phẳng.
- Glow blob phải `absolute` + nằm trong wrapper `relative overflow-hidden`.
- Đọc `palette` trước khi phối: nếu `primary` và `info` cùng hue (nhìn giá trị oklch
  góc hue gần nhau) thì gradient from-primary to-info sẽ "chết" — chọn cặp lệch hue
  (primary↔accent) hoặc dùng tint đơn sắc.

## DESIGN_VARIANCE mapping

- `low` — chỉ pattern 4, 5, 6: màn gọn, gần như flat, đúng chuẩn dashboard.
- `medium` (mặc định) — thêm 1, 3, 9: có hero + nhịp section.
- `high` — đủ bộ kể cả 2, 7, 8: nền riêng, glow, shadow brand — vẫn trong palette.

## Nhắc lại ranh giới (validator sẽ chặn nếu quên)

- ❌ `bg-[#…]` / `bg-[oklch(…)]` / `bg-[var(--…)]` / `style:{background:…}` / `bg-red-500`
- ❌ utility màu (kể cả token) đặt lên **component** — Button/Card/Input… chỉ nhận
  `variant`/`size` + layout class; sáng tác ở wrapper bao quanh.
- ✅ Sau khi author xong: `node builder/validate.mjs <file>.screen.json` phải PASS.
