# Graph mode — author screen bằng node/edge trong KG local (od-kg)

> Chế độ thứ hai của skill này: thay vì author tay `screen.json` (file mode),
> agent **tạo node/edge cho screen trong Neo4j local của project** qua MCP
> server `kg-local`, grounding vào catalog/screen thật đã clone từ design KG,
> rồi **export** ra `screen.json` để shell render. Trong graph mode, **GRAPH là
> source of truth** — `screen.json` export ra là build artifact, CẤM sửa tay;
> muốn đổi màn thì sửa graph rồi re-export.

## Hạ tầng (one-time setup)

```bash
pnpm tools-kg neo4j up        # Neo4j local (Docker): bolt 27787, browser http://localhost:27475
pnpm tools-kg clone           # clone subgraph UI_* từ design KG nguồn (bolt 27687)
pnpm tools-kg clone --refresh # re-sync reference data; KHÔNG BAO GIỜ đụng screen agent
```

MCP server `kg-local` đã đăng ký trong `.od/mcp-config.json` (stdio,
`node tools/kg/bin/tools-kg.mjs mcp`). Nếu tool `kg_*`/`ui_*` chưa thấy trong
session → mở lại session (MCP nạp tool lúc khởi động).

## Graph model (bắt buộc theo — verbatim từ design-v3)

```
(UI_WORKSPACE)-[:OWNS_SCREEN]->(UI_PROJECT_SCREEN {id, slug, name, category, viewport, workspaceId})
(UI_PROJECT_SCREEN)-[:CONTAINS {order}]->(UI_SCREEN_INSTANCE)            ← đúng 1 root/screen
(UI_SCREEN_INSTANCE)-[:COMPOSES {order}]->(UI_SCREEN_INSTANCE)           ← con, order quyết định thứ tự
(UI_SCREEN_INSTANCE {id, workspaceId, componentSlug, label, text, props})  ← props là JSON-STRING
(UI_SCREEN_INSTANCE)-[:RENDERS_AS]->(UI_COMPONENT {slug})                ← traceability (tự động, best-effort)
(UI_SCREEN_INSTANCE)-[:FLOWS_TO {type, label}]->(UI_PROJECT_SCREEN)      ← navigate | showDialog | closeDialog
```

Quy ước:
- Screen id = `scr-<slug>` (tool tự đặt). Instance id: đặt tay theo pattern
  `<screen>-<vai trò>` (vd `login-submit`) hoặc để tool sinh `inst-<random>`.
- `props` lưu trong graph là **JSON string** — tool `ui_instance_upsert` nhận
  object và tự stringify; không bao giờ tự nối chuỗi.
- `order` 1-based, duy nhất giữa các sibling cùng parent.
- Mọi node agent tạo nằm trong workspace **`ws-od-prototypes`**, stamp
  `source:'agent'`. Node clone (có `odClonedFrom`) là **bất biến** — tool write
  từ chối đụng; muốn "sửa" màn XPOS thì dựng screen mới trong prototype
  workspace theo pattern của nó.

## MCP tools (server `kg-local`)

| Tool | Dùng để |
|---|---|
| `kg_cypher_read` | grounding query read-only (write clause bị chặn) |
| `kg_find` | tìm nhanh node theo name/slug/componentSlug (vd tìm component catalog) |
| `ui_screen_upsert` | tạo/sửa screen meta (`slug`, `name`, `viewport`) |
| `ui_instance_upsert` | tạo/sửa 1 instance + gắn vào cây: `screenSlug` (root) HOẶC `parentId` (con) + `order` |
| `ui_flow_link` | nối flow giữa trigger instance → screen đích |
| `ui_screen_lint` | check whitelist slug, order trùng, cycle, props JSON, flow target |
| `ui_screen_export` | graph → `screen.json` (ghi `.od/kg-exports/<slug>/screen.json`) |
| `ui_screen_delete` | xóa screen/subtree agent-owned |
| **`ui_tokens_get`** | **creative grounding**: palette resolved (dark/light + utilities) + `cssVars` payload để fill vào artifact (cửa 1 `brand.css` / cửa 2 slot `<style id="brand">`) |

CLI tương đương (ngoài session MCP): `pnpm tools-kg lint|export <slug>`.

## Workflow bắt buộc

> Thứ tự tổng thể theo **`pipeline.md`** (canonical) — mục này = thao tác **Stage ①
> author + ② export**. TRƯỚC khi author: chạy **Step 0 — Preflight HITL** trong
> `SKILL.md` (kiểm tra màn đã có trong KG chưa → `AskUserQuestion` đề xuất phương án
> tạo: màn mới trong dự án có sẵn / dự án mới). KHÔNG tự `ui_screen_upsert` khi user
> chưa chọn (Hard rule 11).

```
1. GROUNDING — đừng chế slug/pattern từ trí nhớ:
   - Component catalog:  kg_find {term: "button", label: "UI_COMPONENT"}
   - Variant có sẵn:     kg_cypher_read "MATCH (c:UI_COMPONENT {slug:'button'})-[:HAS_VARIANT]->(v)-[:HAS_OPTION]->(o) RETURN v.name, collect(o.value)"
   - Screen mẫu (XPOS):  kg_cypher_read "MATCH (s:UI_PROJECT_SCREEN) WHERE s.workspaceId <> 'ws-od-prototypes' RETURN s.slug, s.name"
   - Soi cấu trúc 1 màn mẫu để copy pattern:
       kg_cypher_read "MATCH (s:UI_PROJECT_SCREEN {slug:$slug})-[:CONTAINS]->(r)-[:COMPOSES*0..2]->(i) RETURN i.id, i.componentSlug, i.text LIMIT 50" {slug:"dang-nhap-login"}
2. ui_screen_upsert {slug, name, viewport}
3. ui_instance_upsert root (screenSlug=..., order=1, componentSlug="div",
   props={className:"flex h-full flex-col bg-background"}) → rồi đệ quy con
   qua parentId. Tuân Hard rules 5–6 của SKILL.md (variant/token, KHÔNG tự sơn màu).
4. (nếu đa màn) ui_flow_link cho các trigger navigate/showDialog.
5. ui_screen_lint → sửa đến khi 0 error.
6. ui_screen_export {slug} → .od/kg-exports/<slug>/screen.json
7. node skills/react-shadcn/builder/validate.mjs <file> (double-check offline)
8. Copy assets/shell.html + screen.json cạnh nhau vào thư mục artifact → render.
   Verify: node skills/react-shadcn/builder/verify.mjs <artifact-dir>
```

## Style authoring — tạo style mới theo Compositional Pattern

> Bản chất tạo style mới: **KHÔNG dựng lại hệ thống** — chỉ tạo `UI_THEME` cho
> axis cần đổi + `UI_TOKEN_VALUE` cho theme đó + 1 `UI_THEME_COMPOSITION` mix &
> match layer mới với layer clone sẵn có (`USES_THEME {order}`, layer sau đè
> layer trước theo từng `targetPath`).

MCP tools (cùng server `kg-local`):

| Tool | Dùng để |
|---|---|
| `ui_theme_upsert` | tạo theme 1 axis (`kind`: spacing/rounded/typography/control-density/visual/icon/brand). **`basedOnThemeId`** = copy toàn bộ value từ theme có sẵn rồi override dần — workflow chuẩn |
| `ui_token_values_set` | bulk set value: `{targetPath, value}` (cả 2 scheme) hoặc `{targetPath, dark, light}`. rawValue nhận 4 định dạng: plain CSS · paint JSON (gradient) · shadow JSON · Tailwind class-token (glass surface) |
| `ui_composition_upsert` | mix layers (theme agent + theme clone) theo `order`; `layersJson` là property source of truth — **sống sót qua `clone --refresh`** |
| `ui_composition_lint` | layer tồn tại, 1 theme/axis, phủ 7 axis, dual-scheme đủ |
| `ui_composition_export_css` | composition → stylesheet dual-scheme chuẩn `vnpay-glass.css` (`:root` light + `html.dark` + glass/control `[data-slot]` bindings). Include SAU `theme.css` trong shell để THẤY style trên component thật |

CLI tương đương: `pnpm tools-kg style-lint <comp>` · `pnpm tools-kg css <comp> [--vars-only]` · `pnpm tools-kg tokens <comp>`.

## Luồng trọn vẹn: KG-driven prototype (user chọn composition → sáng tác)

> ⚠️ Thứ tự tổng thể theo **`pipeline.md`** (canonical), KHÔNG theo đánh số dưới đây.
> Mục này chỉ minh hoạ thao tác theme cho ca "user chọn composition có sẵn"; lưu ý
> theme là mối bận **chéo**: `ui_tokens_get` GROUNDING (đọc palette) xảy ra *trước/khi
> author*, còn BINDING (fill brand.css) xảy ra *lúc build* — không phải một bước tuần
> tự đứng đầu. Author **luôn theo graph mode** (Stage ①), không phải "file mode hoặc graph mode".

```
1. USER: "dựng prototype theo composition <X>"   (Stage 0 preflight HITL trước — xem SKILL.md)
2. THEME grounding: ui_tokens_get {compositionId: X}
     → palette: ĐỌC giá trị thật để phán đoán phối màu (hue primary/accent, có data-* không…)
     → cssVars: GIỮ lại để FILL vào artifact ở bước build (Stage ④), KHÔNG fill ngay
3. Author screen TRONG GRAPH (Stage ①) → ui_screen_lint → ui_screen_export (Stage ②)
4. SÁNG TÁC theo khế ước mức A: component nguyên trạng; decorative tự do bằng
   utility token (bg-primary/12, from-info…) — pattern: references/creative-with-tokens.md
5. BINDING (Stage ④): ghi <artifact>/brand.css (cửa 1) hoặc slot <style id="brand"> (cửa 2)
6. node builder/validate.mjs <file> (cổng __provenance + foreign-color + component-paint)
7. Serve shell.html + screen.json + brand.css cạnh nhau → render → verify.mjs
```

Shell KHÔNG cần rebuild khi đổi style: vocabulary + structure nằm sẵn trong shell,
brand.css chỉ chở GIÁ TRỊ — không có brand.css thì artifact mang default VNPAY Glass.

Workflow mẫu (đã verify e2e — reskin brand sang emerald):
```
1. ui_theme_upsert {name:"Emerald Merchant", kind:"brand",
     basedOnThemeId:"4b2ecd3e-…"(VNPAY Merchant)}        → copy 28 values
2. ui_token_values_set {themeId, values:[
     {targetPath:"primary", value:'{"type":"paint","layers":[{"kind":"gradient",…}]}'},
     {targetPath:"accent",  value:"oklch(0.76 0.16 70)"},
     {targetPath:"ring",    dark:"…", light:"…"}]}
3. ui_composition_upsert {name:"xPOS Emerald Glass", layers:[
     6 layer Glass clone (spacing/rounded/typo/control/color/icon, order 1–6),
     {themeId:"theme-brand-emerald-merchant", order:7}]}
4. ui_composition_lint → 0 vi phạm
5. ui_composition_export_css → .od/kg-exports/_css/<name>.css
6. Nhúng css đó vào shell (SAU theme.css) → render screen → nút/brand đổi màu
```

Lưu ý scheme: dual-scheme lưu bằng **property `scheme: 'dark'|'light'`** trên
value (data clone thì suy từ edge `IN_MODE` → mode `Dark`/`Light`); value không
scheme = dùng chung 2 mode. Đường path `type.*`/`asset.*` là meta, không ra CSS.

## Guardrails (đã enforce trong server — biết để không húc tường)

- KHÔNG có tool write-Cypher. Mọi write qua `ui_*` typed tools.
- Write tự inject `workspaceId = ws-od-prototypes` + `source:'agent'`; id trùng
  với node clone/foreign → lỗi "not agent-owned", chọn id khác.
- `ui_flow_link` chỉ cho target trong prototype workspace (flow trỏ màn clone
  không export/render được — dựng màn đích trước).
- `clone --refresh` chỉ wipe node có `odClonedFrom` → screen agent an toàn
  tuyệt đối. Edge RENDERS_AS từ instance agent → catalog clone sẽ mất sau
  refresh (vô hại — lint chỉ báo info; tự tái tạo khi instance được touch).
- `componentSlug` ngoài whitelist: tool vẫn ghi nhưng warn — sửa ngay, đừng để
  đến lúc render mới thấy badge đỏ `?slug`.
