# Sub-plan: screen-variants — phân rã cho sub-agent chạy song song

**Nguồn:** `docs/screen-variants-spec.md` (hướng A, flat + groupKey)
**Nguyên tắc phân rã:** WP V1–V5 phụ thuộc dây chuyền nên KHÔNG song song
theo WP được. Song song hóa bằng cách tách "lõi thuần" (module MỚI + test,
không đụng file chung) khỏi "tích hợp" (sửa file hiện có, một người làm).
Mỗi task là spec ĐÓNG giao cho một sonnet-executor: vùng file riêng, không
chồng nhau, không chồng vùng dr-review của phiên khác (docs-review.ts,
server.ts ~19259–19437, DocRedlinePreview.tsx).

## Sơ đồ wave

```
Wave 0 (serial, 1 task)   : T0 khóa types/contracts
Wave 1 (SONG SONG, 5 task): T1 T2 T3 T4 T5 — toàn file MỚI + skill text
Wave 2 (serial, 1 task)   : T6 tích hợp daemon (điểm nối duy nhất)
Wave 3 (SONG SONG, 2 task): T7 UI · T8 e2e + wire drift
```

Fixture dùng chung (chuẩn bị trong T0): trích đoạn
`CR-Ho-tro-truc-tuyen-GD2.md` (observation `76422f1f239d`) đưa vào
`apps/daemon/tests/fixtures/multi-platform-cr.md` — đủ mục 2.1 (rút gọn),
2 bảng MB/IB (mỗi bảng ≥4 màn, ≥3 màn trùng tên), 1 mục BO, BR có chữ
"SDK" (để test fallback không bị nhiễm).

---

## Wave 0 — khóa nền (chạy trước, ~1 giờ)

### T0 — types + fixture (spec §3.1–3.4)

- **Sửa:** `apps/daemon/src/screen-components.ts` (CHỈ khối type
  ScreenInput: thêm `platform?`, `groupKey?`),
  `apps/daemon/src/screen-overrides.ts` (type ScreensManifest v2 +
  buildScreensManifest pass-through 2 field mới + reader nhận v1),
  `apps/daemon/src/screen-recovery.ts` (type `groups?` trong
  RecoveryScreensFile). **Tạo:** fixture md nói trên.
- **Cấm:** mọi thay đổi hành vi ngoài pass-through; không đụng server.ts.
- **Acceptance:** `tsc --noEmit` daemon xanh; test hiện có xanh; manifest
  emit cho dữ liệu không platform/groupKey ra byte-identical với trước
  (field optional vắng thì không serialize).

## Wave 1 — SONG SONG 5 task (sau T0 merge; mỗi task một executor)

### T1 — module platform theo section (V1 lõi)

- **Tạo:** `apps/daemon/src/screen-platform.ts` +
  `apps/daemon/tests/screen-platform.test.ts`.
- **API:** `resolveScreenPlatform(md: string, sectionStartLine: number):
  'mobile' | 'web' | null` — leo chuỗi heading cha (gần nhất thắng), bảng
  từ khóa spec §WP-V1; null = không suy được (caller fallback
  MOBILE_HINT_RE). Export thêm bảng từ khóa để test/skill tham chiếu.
- **Cấm:** không import vào code hiện có (T6 mới wire), không sửa
  MOBILE_HINT_RE.
- **Acceptance:** fixture — màn dưới "Màn hình MB" → mobile; "Màn hình
  IB"/"BO …" → web; heading không khớp → null; chữ "SDK" trong BR không
  ảnh hưởng (vì chỉ đọc heading chain).

### T2 — module nhóm biến thể (V2 lõi)

- **Tạo:** `apps/daemon/src/screen-groups.ts` +
  `apps/daemon/tests/screen-groups.test.ts`.
- **API:**
  - `normalizeScreenName(name): string` (lowercase, bỏ dấu, bỏ tiền tố
    màn hình/man hinh/popup, collapse space);
  - `autoGroupScreens(screens: {key,name,platform}[]): {groups, renamedKeys,
    suggestions}` — auto-nhóm CHỈ trùng-hệt tên chuẩn hóa + khác platform;
    sinh groupKey `<stem>__G-<slug>` + hậu tố key CHUẨN HÓA `--app`/`--web`
    cho thành viên (MB/IB là thuật ngữ bank, chỉ dùng ở tầng từ khóa phát
    hiện heading); tên gần-giống khác platform → đẩy vào `suggestions`
    (cho agent), KHÔNG tự nhóm; cùng platform → không bao giờ nhóm.
- **Cấm:** không wire; không đụng mergeExtractedScreens.
- **Acceptance:** fixture — ≥3 nhóm auto đúng; cặp "danh sách lý do" vs
  "popup danh sách lý do hỗ trợ" nằm ở suggestions; 2 màn cùng tên cùng
  platform không nhóm; màn đơn giữ key nguyên trạng.

### T3 — module thứ tự mockup trước/sau (V4 lõi)

- **Tạo:** `apps/daemon/src/mockup-order.ts` +
  `apps/daemon/tests/mockup-order.test.ts`.
- **API:** `orderMockupsByChangeColumn(sectionLines: string[], mockups:
  string[]): {ordered: string[], hasBeforeAfter: boolean}` — nhận diện
  bảng `Hiện trạng | Thay đổi`, ảnh cột "Thay đổi" xếp trước; bảng không
  đúng dạng → giữ nguyên thứ tự, hasBeforeAfter=false.
- **Acceptance:** fixture bảng MB — ảnh cột 2 lên đầu; màn chỉ có cột 1
  → thứ tự gốc; section không bảng → giữ nguyên.

### T4 — sửa skill text (V1/V2 phần prompt)

- **Sửa:** `skills/docs-screen-discovery/SKILL.md` (thêm mục "gợi ý nhóm
  biến thể": agent chỉ xác nhận trong danh sách gợi ý, phải nêu anchorText
  cả hai phía; luật màn trùng tên khác nền tảng → code hậu tố chuẩn hóa
  -APP/-WEB),
  `skills/docs-screen-components/SKILL.md` (bỏ "platform … áp cho mọi màn"
  → "theo từng màn, đọc `platform` của màn trong kickoff").
- **Cấm:** không đụng skill khác; không đổi contract JSON output ngoài
  phần mô tả trên.
- **Acceptance:** lint skill pass (nếu có); diff chỉ nằm trong 2 file;
  các ví dụ JSON trong skill cập nhật nhất quán với field mới.

### T5 — module variant drift (V5 lõi, thuần)

- **Tạo:** `apps/daemon/src/variant-drift.ts` +
  `apps/daemon/tests/variant-drift.test.ts`.
- **API:** `diffVariantDescriptions(groupEntries: {key, platform,
  descriptionBullets: string[]}[]): VariantDriftFinding[]` — chuẩn hóa
  bullet (bỏ dấu câu/space), lệch thực chất mới báo; finding mang evidence
  bullet 2 phía.
- **Cấm:** không wire vào dr-review (T8 làm, phối hợp phiên kia);
  không đụng docs-review.ts.
- **Acceptance:** fixture MB/IB — bắt được lệch "Phản hồi (bổ sung)" chỉ
  có một phía; 2 danh sách tương đương khác thứ tự → 0 finding.

## Wave 2 — tích hợp daemon (1 executor DUY NHẤT, sau khi T1–T5 xong)

### T6 — wire tất cả vào pipeline (V1+V2+V3+V4 tích hợp)

- **Sửa:** `apps/daemon/src/screen-components.ts` (resolveDocScreens/scan:
  gọi resolveScreenPlatform, fallback hint cũ),
  `apps/daemon/src/screen-extract.ts` (mergeExtractedScreens: platform per
  màn), điểm gọi autoGroupScreens sau extract trước buildScreensManifest,
  `apps/daemon/src/screen-recovery.ts` + `finalizeFlowUx` (expand groupKey
  → thành viên, đọc/ghi `groups`), `apps/daemon/src/server.ts` (2 hunk
  NHỎ: dr-comp kickoff `data-layout` = `platform ?? platformHint`; gọi
  orderMockupsByChangeColumn khi dựng mảng mockups).
- **Ràng buộc phối hợp:** TRƯỚC khi sửa server.ts phải nhắn phiên
  dr-review (SendMessage) khai báo 2 hunk; hunk phải nằm ngoài vùng
  ~19259–19437.
- **Acceptance:** toàn bộ test daemon xanh; fixture đa nền tảng chạy qua
  scan→extract→manifest ra đúng nhóm/platform như acceptance V1+V2 trong
  spec; dự án một-nền-tảng (test hiện có) byte-identical (G6); tsc xanh.

## Wave 3 — SONG SONG 2 task (sau T6)

### T7 — UI nhóm biến thể (V5 UI)

- **Sửa:** components rail màn hình trong `apps/web` (ScreenListManager +
  các component screens; KHÔNG đụng DocRedlinePreview.tsx) và
  `ui/pipeline-studio` phần hiển thị screens: entry cùng groupKey gộp 1
  hàng + tab theo platform; manifest v1/không groupKey → hàng đơn như cũ.
- **Acceptance:** test component mới cho 2 trạng thái (có nhóm/không);
  manifest v1 render y hệt trước.

### T8 — e2e + wire VARIANT-DRIFT (V5 còn lại)

- **Sửa:** wire variant-drift vào dr-review (PHỐI HỢP trước với phiên
  dr-review vì đụng docs-review.ts — nếu vùng còn bận thì task này chờ),
  e2e docs-review thêm fixture đa nền tảng.
- **Acceptance:** e2e xanh; doc một-nền-tảng: 0 finding VARIANT-DRIFT,
  findings khác không đổi.

---

## Ma trận vùng file (chống giẫm chân)

| Task | Vùng SỞ HỮU (chỉ được sửa/tạo trong đây) |
|---|---|
| T0 | screen-components.ts (types), screen-overrides.ts, screen-recovery.ts (types), tests/fixtures/multi-platform-cr.md |
| T1 | screen-platform.ts (mới) + test |
| T2 | screen-groups.ts (mới) + test |
| T3 | mockup-order.ts (mới) + test |
| T4 | skills/docs-screen-discovery, skills/docs-screen-components |
| T5 | variant-drift.ts (mới) + test |
| T6 | screen-components.ts, screen-extract.ts, screen-recovery.ts, server.ts (2 hunk, ngoài ~19259–19437), tests liên quan |
| T7 | apps/web screens components (trừ DocRedlinePreview), pipeline-studio screens UI |
| T8 | docs-review wiring (sau phối hợp) + e2e |

Luật chung cho mọi executor: không `git add -A`; chỉ add file trong vùng
sở hữu; không commit — orchestrator gom, review rồi commit theo wave; mỗi
wave xong chạy `tsc --noEmit` + test daemon trước khi sang wave sau.

## Ước lượng lại theo wave (wall-clock khi song song)

| Wave | Task | Tuần tự | Song song |
|---|---|---|---|
| 0 | T0 | ~1h | ~1h |
| 1 | T1–T5 | ~2 ngày | **~0.5 ngày** |
| 2 | T6 | ~1 ngày | ~1 ngày |
| 3 | T7–T8 | ~1.5 ngày | **~1 ngày** |

Tổng wall-clock ~2.5–3 ngày (so với 4–5 ngày tuần tự).
