# Spec: Màn hình đa nền tảng (screen variants) — docs-review

**Trạng thái:** draft chờ duyệt · **Hướng:** A (variant hóa schema, flat + groupKey)
**Ngày:** 2026-08-26 · **Fixture chuẩn:** dự án `eib-cr-ho-tro-truc-tuyen-gd2`
(observation `76422f1f239d` trong `__od-screen-format-reports` — chứa full
tài liệu `CR-Ho-tro-truc-tuyen-GD2.md` + 29 attachment)

## 1. Bối cảnh & vấn đề

Tài liệu CR của EIB khai cùng một tính năng trên **3 nền tảng trong 1 file**:

- Mục 2.2 "Màn hình MB" — bảng `Hiện trạng | Thay đổi | Mô tả`, 13 màn,
  mỗi màn 2 dòng bảng (dòng tên in đậm + dòng cặp mockup trước/sau).
- Mục 2.3 "Màn hình IB" — cùng format bảng, 12 màn, phần lớn TRÙNG TÊN với
  2.2 nhưng mockup khác (web vs mobile).
- Mục 2.4–2.7 "Màn hình BO" — 12 màn dạng heading đậm + ảnh + bullet.

Hệ hiện tại vỡ ở 3 chỗ:

1. **Platform gán theo file, không theo màn.** `platformHint:
   MOBILE_HINT_RE.test(md)` quét CẢ file, một giá trị nhị phân áp cho mọi
   màn — `screen-extract.ts` (mergeExtractedScreens) + `screen-components.ts`
   (3 chỗ, ~dòng 1102/1132/1190). Doc EIB chứa "SDK" (BR-3) → toàn bộ 37 màn
   kể cả IB/BO bị hint `mobile`. Skill docs-screen-components cũng khai
   "`platform` … áp cho mọi màn".
2. **Không có chiều biến thể.** `ScreenInput` = 1 key/1 name/1 section/1
   platformHint. Cùng màn khai 2 lần (MB + IB) → hoặc gộp 1 (mất 1 bộ
   mockup), hoặc 2 entry rời không liên hệ.
3. **Flow map cell → đúng 1 màn.** `RecoveryScreensFile.cells` là
   `{cellId: screenKey}` (`screen-recovery.ts`). Drawio HTTT không tách
   MB/IB → 12 màn recovery của run thật vừa qua TRỘN anchor từ cả bảng MB
   lẫn IB cho cùng một hành trình.

Hệ quả xuôi dòng: dr-comp compose mỗi màn theo đúng 1 bộ mockup (mất bộ còn
lại), BO bị ép layout mobile, dr-review không thể phát hiện lệch nội dung
giữa 2 bảng MB/IB (một lớp lỗi tài liệu có thật trong chính doc EIB).

## 2. Mục tiêu / Non-goals

**Mục tiêu**

- G1: Mỗi màn mang `platform` đúng theo section khai báo nó (mobile/web).
- G2: Các biến thể nền tảng của cùng một màn nghiệp vụ được LIÊN KẾT
  (`groupKey`), mỗi biến thể giữ trọn bộ mockup của mình.
- G3: Flow coverage đếm theo màn nghiệp vụ (nhóm), không theo biến thể.
- G4: dr-comp compose TỪNG biến thể với đúng mockup + platform của nó.
- G5: dr-review có finding mới "lệch biến thể" (variant drift).
- G6: Tài liệu một-nền-tảng (toàn bộ dự án hiện có) ra kết quả
  **byte-identical** với trước — mọi WP đều phải giữ bất biến này.

**Non-goals**

- Không mô hình hóa trục "Hiện trạng vs Thay đổi" thành schema riêng ở đợt
  này (chỉ ưu tiên ảnh cột "Thay đổi" khi chọn mockup — xem WP-V4).
- Không đổi cách dr-flow dựng topology (drawio/mermaid giữ nguyên).
- Không thêm platform thứ ba vào union (`mobile | web` giữ nguyên; BO = web).
- Không migrate output cũ — dự án muốn dùng tính năng mới thì run lại
  (convention hiện hành).

## 3. Thiết kế dữ liệu — flat + groupKey

**Nguyên tắc quyết định:** giữ `comp/_screens.json` và `ScreenInput[]` là
danh sách PHẲNG. Biến thể = các entry anh em cùng `groupKey`. Consumer cũ
không biết trường mới vẫn chạy đúng. KHÔNG dùng nested `variants[]` — phá
mọi consumer đang iterate list.

### 3.1 ScreenInput (screen-components.ts) — thêm 2 field optional

```ts
/** Nền tảng CỦA MÀN NÀY, suy từ chuỗi heading cha của section (WP-V1).
 *  Vắng = chưa xác định theo section, dùng platformHint như cũ. */
platform?: 'mobile' | 'web';
/** Khóa nhóm màn nghiệp vụ (WP-V2). Các biến thể MB/IB của cùng màn có
 *  chung groupKey. Vắng = màn đứng một mình (nhóm 1 phần tử ngầm định). */
groupKey?: string;
```

`platformHint` GIỮ NGUYÊN ngữ nghĩa cũ (tín hiệu yếu mức tài liệu) làm
fallback; `platform` (khi có) luôn thắng. Không xóa field nào.

### 3.2 ScreensManifest (screen-overrides.ts) — v2, parse lùi

- `schema_version: 2`; entry thêm `platform?`, `groupKey?` (pass-through từ
  ScreenInput).
- Reader (studio, web, dr-comp route) chấp nhận cả v1 lẫn v2: v1 → coi mọi
  entry không nhóm, platform = platformHint cũ. KHÔNG từ chối v1.

### 3.3 RecoveryScreensFile (screen-recovery.ts) — cells map sang nhóm

- `cells: {cellId: key}` giữ nguyên KIỂU, nhưng ngữ nghĩa mở rộng: `key` có
  thể là `groupKey`. Thêm field mới optional:

```ts
/** WP-V3: key trong `cells`/`names` là groupKey khi màn có biến thể. */
groups?: { [groupKey: string]: string[] /* các screen key thành viên */ };
```

- File cũ không có `groups` → mọi key là màn đơn, hành vi y hệt hôm nay.
- Coverage check của dr-flow ("flow có ≥1 màn"): tính theo key trong
  `cells` như cũ — không đổi logic, chỉ đổi việc key có thể đại diện nhóm.

### 3.4 Quy ước khóa

- `groupKey` = `<mdStem>__G-<slug tên chuẩn hóa>` (vd
  `CR-Ho-tro-truc-tuyen-GD2__G-man-hinh-quan-ly-yeu-cau-cua-toi`).
- Screen key biến thể = key hiện hành + hậu tố platform khi (và chỉ khi)
  màn nằm trong nhóm ≥2: `<key>--app` (mobile) / `<key>--web` (web) — nhãn
  CHUẨN HÓA App/Web phủ mọi loại dự án; MB/IB chỉ là cách gọi riêng của
  dự án bank (Mobile/Internet Banking) và CHỈ tồn tại ở tầng TỪ KHÓA PHÁT
  HIỆN heading (WP-V1), không bao giờ xuất hiện trong key/nhãn UI. BO
  không cần hậu tố — không trùng ai. Màn đơn giữ key như cũ → G6 bảo toàn.
- Chuẩn hóa tên để so trùng: lowercase, bỏ dấu, bỏ tiền tố
  `màn hình|man hinh|popup`, collapse khoảng trắng.

## 4. Work packages (thứ tự ship, mỗi WP tự chạy được)

### WP-V1 — platform theo section (nền của mọi thứ, ship riêng được)

**Đích:** mỗi màn có `platform` đúng; BO/IB hết bị "SDK" trong BR kéo thành
mobile.

- Bảng từ khóa heading → platform (module mới `screen-platform.ts`).
  Đây là tầng PHÁT HIỆN — chứa cả cách viết generic lẫn alias theo domain
  (bank: MB/IB/BO); nhãn chuẩn hóa ra ngoài luôn là App/Web:
  - mobile (App): `\bapp\b`, `mobile`, `app di động`, `ứng dụng di động`,
    `iOS`, `Android`, `SDK`, alias bank `\bMB\b`
  - web (Web): `\bweb\b`, `\bCMS\b`, `quản trị`, `backoffice`, `back office`,
    alias bank `\bIB\b`, `internet banking`, `\bBO\b`
- Suy `platform` cho một màn bằng cách leo CHUỖI HEADING CHA của
  `section.startLine` (gần nhất thắng); không heading nào khớp → fallback
  `MOBILE_HINT_RE` toàn file như cũ.
- Điểm sửa: `resolveDocScreens`/scan (screen-components.ts ~1102/1132/1190),
  `mergeExtractedScreens` (screen-extract.ts ~286). Skill
  `docs-screen-components`: sửa câu "áp cho mọi màn" → "theo từng màn, xem
  `platform` trong kickoff".
- dr-comp kickoff dùng `screen.platform ?? platformHint` cho
  `data-layout` — một dòng, không đổi schema kickoff.

**Acceptance:** fixture EIB — mọi màn dưới 2.2 ra `mobile`; dưới 2.3 và
2.4–2.7 ra `web`. Doc một-nền-tảng bất kỳ trong test hiện có: output
byte-identical (platform vắng hoặc = platformHint).

### WP-V2 — nhóm biến thể (dr-screens)

**Đích:** màn trùng tên chuẩn hóa ở các section KHÁC platform → chung
`groupKey`, key thành viên nhận hậu tố; tên lệch nhẹ để agent quyết.

- Tất định (daemon, sau lớp quét + lớp extract, trước
  `buildScreensManifest`): auto-nhóm CHỈ KHI tên chuẩn hóa trùng HỆT và
  platform khác nhau. Không bao giờ auto-nhóm 2 màn cùng platform.
- Ca mờ (vd "danh sách lý do" MB vs "popup danh sách lý do hỗ trợ" IB,
  "đánh giá" vs "popup đánh giá"): thêm mục "gợi ý nhóm" vào kickoff lớp 2
  (docs-screen-discovery) — agent xác nhận bằng `anchorText` cả hai phía;
  daemon validate anchor tồn tại rồi mới nhận. Agent KHÔNG tự bịa nhóm
  ngoài danh sách gợi ý.
- Manifest v2 ghi `platform` + `groupKey` (mục 3.2).

**Acceptance:** fixture EIB — ≥8 nhóm 2-biến-thể được auto-nhóm (quản lý
yêu cầu của tôi; 3 màn chi tiết YCHT; tạo YCHT; xác nhận; kết quả GD; danh
sách thẻ; chi tiết thẻ); 0 nhóm sai platform; các ca mờ xuất hiện trong
gợi ý chứ không auto. Doc một-nền-tảng: 0 nhóm, key không đổi.

### WP-V3 — flow map theo nhóm (dr-flow)

**Đích:** một node drawio phủ cả nhóm; hết cảnh biến thể IB "chưa được phủ".

- `finalizeFlowUx`: khi build `flows/index.json[].screens`, resolve key qua
  manifest — key là groupKey thì expand ra thành viên (mỗi thành viên giữ
  provenance/evidence của nhóm).
- Recovery (`screen-recovery.ts`): candidate được phép trả groupKey; prompt
  recovery kickoff liệt kê các nhóm đã biết từ manifest (nếu dr-screens đã
  chạy) — với run-all thứ tự hiện tại là dr-flow TRƯỚC dr-screens, nên
  nhánh này chỉ kích hoạt ở lượt re-run/Kiểm-tra-&-tiếp-tục; lượt đầu
  candidate theo tên như cũ, WP-V2 sẽ hợp nhất về nhóm ở dr-screens.
- File `screens.json` cũ (không `groups`): đọc như hôm nay.

**Acceptance:** fixture EIB — `flows/index.json` FLOW-httt có đủ cặp biến
thể cho các màn journey thuộc nhóm; coverage check pass; file screens.json
cũ của dự án khác load nguyên trạng.

### WP-V4 — dr-comp fan-out theo biến thể

**Đích:** mỗi biến thể một lượt compose với đúng mockup + platform của nó.

- Fan-out iterate manifest như cũ (list phẳng → tự nhiên ra từng biến thể;
  KHÔNG cần logic mới ở pool). Việc chính là kickoff: `mockups` của màn
  lấy trong `section` CỦA BIẾN THỂ ĐÓ (đã đúng sẵn vì section khác nhau);
  bổ sung ưu tiên: trong bảng `Hiện trạng|Thay đổi`, ảnh cột "Thay đổi"
  xếp trước ảnh cột "Hiện trạng" trong mảng `mockups` (parse vị trí cột từ
  dòng bảng — tất định), kèm 1 dòng ghi chú trong kickoff "ảnh đầu là
  trạng thái ĐÍCH".
- Output/route/`comp/_screens.json` đã key theo screen key → không đổi.
- Re-run fence: xóa-output-cũ theo key như hiện hành; key đổi hậu tố ở
  WP-V2 nghĩa là dự án cũ run lại sẽ sinh key mới — chấp nhận (non-goal
  migrate).

**Acceptance:** fixture EIB — "Quản lý yêu cầu của tôi" ra 2 HTML
(`--app` data-layout=mobile, `--web` data-layout=web), mỗi cái bám mockup
của bảng tương ứng; màn BO ra data-layout=web.

### WP-V5 — studio UI + dr-review variant drift

**Đích:** người xem thấy nhóm; BA thấy lệch biến thể.

- Studio/web rail màn hình: entry cùng `groupKey` gộp 1 hàng + tab nhãn
  chuẩn hóa **App** (mobile) / **Web** (fallback: không groupKey → hàng
  đơn như cũ). Không dùng nhãn MB/IB trong UI.
- dr-review: rule mới `VARIANT-DRIFT` — so cột "Mô tả" của 2 dòng bảng
  cùng nhóm (diff bullet chuẩn hóa), lệch thực chất → finding kèm evidence
  2 anchor. Chỉ chạy khi tài liệu có nhóm (0 nhóm = 0 chi phí).
- e2e docs-review cập nhật fixture đa nền tảng.

**Acceptance:** fixture EIB — UI hiện ~8 nhóm dạng tab; dr-review bắt được
ít nhất 1 lệch thật giữa bảng MB/IB của doc (vd khác biệt danh sách bullet
"Phản hồi (bổ sung)"); dự án một-nền-tảng: UI và findings y hệt trước.

## 5. Rủi ro & giảm nhẹ

| Rủi ro | Giảm nhẹ |
|---|---|
| Nhóm sai (2 màn khác nhau tên giống) | Auto-nhóm chỉ khi trùng HỆT tên chuẩn hóa + khác platform; ca mờ bắt buộc qua agent + validate anchor; không auto-nhóm cùng platform |
| Heading không chuẩn ("App MB", "Mobile Banking"…) | Bảng từ khóa mở rộng được + fallback hint cũ; log warning khi section có màn mà không suy được platform |
| Schema churn 3 app | Ship đúng thứ tự V1→V5, mỗi WP parse lùi; contracts sửa xong PHẢI rebuild dist trước khi web/studio build (bài học WP25) |
| Key đổi hậu tố phá dữ liệu cũ | Chỉ đổi key khi màn VÀO nhóm ≥2 (tức tài liệu đa nền tảng — trước giờ vốn chạy sai); dự án cũ một-nền-tảng key không đổi (G6) |
| Run-all thứ tự dr-flow trước dr-screens | WP-V3 không phụ thuộc manifest ở lượt đầu; hợp nhất nhóm xảy ra ở dr-screens; re-run/continue mới dùng nhóm trong recovery |

## 6. Ước lượng & thứ tự

| WP | Ước lượng | Ghi chú |
|---|---|---|
| V1 platform theo section | 0.5–1 ngày | = trọn phương án B; giá trị ngay cả khi dừng ở đây |
| V2 nhóm biến thể | 1 ngày | daemon + skill discovery + manifest v2 |
| V3 flow theo nhóm | 0.5 ngày | finalizeFlowUx + recovery prompt |
| V4 dr-comp theo biến thể | 1 ngày | kickoff mockup ưu tiên cột Thay đổi |
| V5 UI + variant drift | 1–1.5 ngày | studio/web + dr-review rule + e2e |

Tổng ~4–5 ngày. Điểm dừng an toàn sau MỖI WP; sau V1 đã hết lỗi platform,
sau V4 đã đạt giá trị chính (compose đúng từng biến thể).

## 7. Việc KHÔNG được làm khi thực thi

- Không đổi kiểu `cells` trong RecoveryScreensFile (chỉ thêm `groups`).
- Không reject manifest/screens.json schema cũ ở bất kỳ reader nào.
- Không nested `variants[]` trong ScreenInput.
- Không auto-nhóm 2 màn cùng platform, dù tên trùng hệt.
- Không sửa vùng dr-review WP-A đang có WIP của phiên khác
  (docs-review.ts, server.ts ~19259–19450, DocRedlinePreview.tsx) — phối
  hợp trước nếu V5 chạm tới.
