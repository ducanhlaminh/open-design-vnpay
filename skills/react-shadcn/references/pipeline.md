# Xương sống pipeline (CANONICAL) — nguồn-sự-thật-duy-nhất cho THỨ TỰ dựng prototype

> Tài liệu này là **AUTHORITY về thứ tự chặng**. `SKILL.md`,
> `references/screen-graph-authoring.md`, và skill `kg-theme-composition` đều **trỏ
> về đây**. Khi bất kỳ doc nào kể một thứ tự khác → **doc này thắng**. Mỗi doc kia chỉ
> mô tả *thao tác chi tiết của chặng nó phụ trách*, KHÔNG tự định nghĩa lại thứ tự tổng thể.

## 5 chặng (theo đúng thứ tự tuyến tính)

```
Stage 0  PREFLIGHT HITL   KG có màn chưa? → AskUserQuestion (tạo ở đâu)     [SKILL.md §"Step 0"]
Stage ①  AUTHOR (KG)      ui_screen_upsert + ui_instance_upsert cây node    [screen-graph-authoring.md]
Stage ②  EXPORT           ui_screen_export → screen.json (+ __provenance)   [screen-graph-authoring.md]
Stage ④  OUTPUT + VERIFY  CHỈ screen.json → validate (cổng) → verify (harness) [SKILL.md §"Quy trình bắt buộc" b7–9]
```

> Stage ④ **KHÔNG materialize html/css**: output per màn = DUY NHẤT `screen.json`
> (KHÔNG shell.html/shell-light.html/brand.css/index.html). Host `preview-runtime-v3`
> render cây + tự resolve theme. Verify dùng harness `assets/shell.html` trong thư mục
> TẠM rồi xoá (xem SKILL.md "OUTPUT POLICY" + Hard rule 7).

Chỉ 4 hộp tuyến tính: **Preflight → ① Author → ② Export → ④ Output/Verify**. Theme
(Stage ③) **không** phải một hộp đứng giữa ② và ④ — xem mục kế.

## Theme (Stage ③) = MỐI BẬN CHÉO, có 2 thời điểm — KHÔNG tuần tự

Đây là nhập nhằng kinh điển. Theme đụng pipeline ở **hai** điểm khác nhau:

- **Grounding SỚM** — *trước/trong khi* Stage ① author: `ui_tokens_get` đọc `palette`
  (giá trị dark/light + utilities mỗi token) để phối màu **decorative** đúng token
  (Hard rule 5–6). Phải BIẾT palette **trước khi** viết className decorative, nếu không
  chọn màu mù.
- **Binding do HOST** — KHÔNG còn fill `brand.css` ở Stage ④. Theme (giá trị token thực)
  do host `preview-runtime-v3` resolve khi render (ThemeLab đọc composition của màn từ KG).
  Agent chỉ cần gắn đúng composition cho màn trong KG; KHÔNG ghi css vào artifact.

→ Thứ tự thật: **grounding theme xen vào TRƯỚC ①** (để chọn màu decorative đúng), **binding
do host lúc render** (không phải một bước ghi file ở ④). Một câu để nhớ:
*biết palette để vẽ (sớm), host nạp giá trị để render (lúc preview).*

## Fork: "chọn theme" = DÙNG CÓ SẴN hay TẠO MỚI?

```
User nêu style / composition X
   ├─ X ĐÃ là composition trong KG   → ui_tokens_get {compositionId: X}              (dùng luôn)
   └─ X là style MỚI (chưa có)       → skill kg-theme-composition (tạo X: 7 axis)  →  ui_tokens_get {X}
                                        rồi MỚI quay lại pipeline này (grounding/binding như trên)
```

Nếu mơ hồ "X đã có hay chưa" → **HITL** (giống Stage 0): `AskUserQuestion` hỏi user
"dùng composition có sẵn nào" hay "tạo style mới". KHÔNG tự quyết tạo mới một composition.

## Bản đồ doc — mỗi doc lo chặng nào (đọc doc tương ứng để biết THAO TÁC)

| Chặng | Doc thao tác |
|---|---|
| 0 — Preflight HITL | `SKILL.md` §"Step 0 — Preflight HITL" |
| ① Author + ② Export | `references/screen-graph-authoring.md` §"Workflow bắt buộc" |
| ③ Theme — *tạo mới* | skill `kg-theme-composition` (`SKILL.md`) |
| ③ Theme — *grounding + binding* & ④ Build/Verify | `SKILL.md` §"Quy trình bắt buộc (KG-first)" |

## Thoát hiểm (file mode)

Chỉ khi user **chủ động** từ chối KG: bỏ Stage 0/①/②, author tay `*.screen.json`,
`validate.mjs --allow-handwritten`. Đánh đổi: không trace KG, không reskin theo
composition KG chuẩn. KHÔNG phải đường mặc định.
