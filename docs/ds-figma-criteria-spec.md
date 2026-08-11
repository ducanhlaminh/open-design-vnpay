# DS Figma → bộ tiêu chí review (`criteria/`) — spec

Nạp một Design System Figma sinh ra **danh mục component hợp lệ** dùng lại được
cho mọi feature; chạy workflow `docs-review` chọn DS đó thì danh mục được chép
vào `criteria/` của workspace. Bộ **quy tắc UX** (`rules.md`) đi kèm DS như một
file tuỳ chọn người dùng nạp lên, KHÔNG sinh tự động.

## Vì sao tách đôi hai file

| File | Sinh từ đâu | Lý do |
|---|---|---|
| `criteria/components.md` | **Agent đọc DS zip** | Zip có đủ dữ liệu: `react/docs/catalog.md` (component + bảng prop/variant/state + description) và `react/STYLE-GUIDE.md` (token). Mọi dòng đều truy được về nguồn. |
| `criteria/rules.md` | **Người dùng nạp lên** | Quy tắc UX ("form dài → Drawer", "luồng nhiều bước → trang riêng") là quyết định sản phẩm, KHÔNG nằm trong export Figma. Bắt agent sinh = nó bịa, và `dr-review` sẽ dùng chính rule bịa đó làm căn cứ buộc tội tài liệu sai. |

Hệ quả: agent chỉ được ghi thứ **đọc được từ catalog**. Cấm suy diễn quy tắc dùng.

## Bố cục file trên đĩa

```
<USER_DESIGN_SYSTEMS_DIR>/<dsId>/
  DESIGN.md, tokens.css, components.html, manifest.json, react/, ir/   ← đã có
  criteria/
    components.md    ← agent sinh; nguồn: react/docs/catalog.md + STYLE-GUIDE.md
    rules.md         ← tuỳ chọn; nguyên văn file .md người dùng nạp cùng zip
    _meta.json       ← { generatedAt, components, rulesBytes|null, sourceCatalogSha }
```

`criteria/` là thư mục ĐỘC LẬP với `react/` — re-import DS xoá sạch `react/` và
`ir/` (xem `figma-ds-import.ts`), nhưng KHÔNG được xoá `criteria/rules.md` (đó
là file người dùng, không phải output của compiler).

## Ràng buộc format — bất di bất dịch

Anchor = mọi token nằm trong backtick trên dòng heading, bỏ dấu `#` đứng đầu.
Hai parser đọc chúng, quy ước phải khớp TUYỆT ĐỐI:

- `collectComponentCatalog` — `apps/daemon/src/docs-components.ts:120`
  `### \`#button\` Button` → key `Button`, rule_id `criteria/components.md#button`
- `collectCriteriaAnchors` — `apps/daemon/src/docs-review.ts:813`
  `## \`R-OVERLAY\` Khi nào dùng…` → `criteria/rules.md#R-OVERLAY`

Sai format ⇒ `rule_id` do agent sinh ra bị coi là bịa ⇒ **daemon đánh hỏng CẢ
TRANG** trong `dr-comp`/`dr-review`. Đây là lý do phải validate deterministic
sau khi sinh, trước khi ghi đè file cũ.

## Luồng 1 — nạp DS Figma

`POST /api/design-systems/import/figma` (multipart, field `files`, tối đa 16).

1. Tách upload theo đuôi: `.md` → rules; `.json`/`.zip` → IR.
2. `.md` nhiều hơn 1 file → `400 BAD_REQUEST` ("chỉ nhận 1 file rules .md").
3. Không có file IR nào → giữ nguyên lỗi 400 hiện tại.
4. Import IR chạy y như cũ (deterministic, đồng bộ).
5. File `.md` ghi **nguyên văn** vào `<ds>/criteria/rules.md`. Không parse lại,
   không reformat — người dùng chịu trách nhiệm nội dung.
6. Chạy `collectCriteriaAnchors` trên nội dung đó. 0 anchor → **warning** (không
   chặn): "rules.md không có heading nào mang anchor dạng `` `R-XXX` `` —
   `dr-review` sẽ không trace được rule_id về file này."
7. Response trả thêm `criteria: { rules: boolean, components: false }`.
8. Kick job sinh `components.md` (fire-and-forget), trả `criteriaJobId` trong
   response để UI poll ngay.

## Luồng 2 — sinh `components.md`

`POST /api/design-systems/:id/criteria/generate` → `{ jobId }`
`GET  /api/design-systems/:id/criteria` → trạng thái + job đang chạy

Job dùng lại hạ tầng `design-system-generation-jobs.ts` (đã có step/status/
message). Agent chạy với **cwd = `<ds>/`**, skill `ds-criteria-extract`.

**Ghi an toàn:** agent ghi ra `criteria/components.md.next`. Daemon validate:

1. `collectComponentCatalog(text).size >= 1`
2. Không có anchor trùng nhau
3. Mọi heading cấp 3 (`###`) phải có token backtick — heading cấp 1/2 là tiêu đề
   nhóm, được phép không có

Pass → `rename` đè `components.md`, cập nhật `_meta.json`, job `succeeded`.
Fail → xoá `.next`, **giữ nguyên file cũ**, job `failed` kèm lý do cụ thể.

## Luồng 3 — chạy `docs-review`

Cấu hình: dùng lại field `designSystemId` đã có sẵn 3 trạng thái trong
`RunAllConfig` (`packages/contracts/src/api/pipelines.ts:748`). Config lưu theo
TỪNG workflow nên DS của `docs-to-ui` không đụng `docs-review` — không cần field
mới, không đổi contract.

Bước `dr-docs` chạy, sau khi stage `docs-feature/` + `docs-app/`:

- Không chọn DS → **không đụng gì** vào `criteria/` (file người dùng tự upload
  qua ⋯ → Tải file lên giữ nguyên).
- Có chọn DS → chép `<ds>/criteria/components.md` → `<wf>/criteria/components.md`,
  và `<ds>/criteria/rules.md` → `<wf>/criteria/rules.md` nếu DS có.
  **Ghi đè, có log rõ:** `[dr-criteria] chép từ DS "<id>": components.md (48
  component), rules.md (12 rule)`.
- DS được chọn nhưng chưa có `components.md` → log cảnh báo, **không fail bước**.

## Kiểm thử bắt buộc

1. Anchor round-trip: sinh `components.md` giả → `collectComponentCatalog` trả
   đúng số component và rule_id đúng anchor của chính tên đó.
2. Import kèm 1 file `.md` → `<ds>/criteria/rules.md` khớp byte-for-byte.
3. Import kèm 2 file `.md` → 400.
4. Validate fail (file 0 component) → file cũ còn nguyên, job `failed`.
5. `dr-docs` không chọn DS → `criteria/` không bị chạm; chọn DS → 2 file có mặt.
