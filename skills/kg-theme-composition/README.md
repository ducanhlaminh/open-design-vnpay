# kg-theme-composition

Skill để tạo theme composition mới trong Knowledge Graph UI sử dụng compositional design pattern.

## Bản chất

**Khi tạo style mới, bạn CHỈ cần tạo:**
- `UI_THEME` mới cho các axes cần thay đổi (7 themes/composition)
- `UI_TOKEN_VALUE` mới với `themeId` binding (~118 values/composition)

**Infrastructure được dùng lại:**
- `UI_WORKSPACE` — workspace chứa compositions
- `UI_THEME_AXIS` — 7 axes cố định (Brand, Typography, Spacing, Icon, Visual, Control, Rounded)
- `UI_TOKEN` — token catalog (color, spacing, typography, visual, control, rounded, icon)
- `UI_MODE` — Light/Dark modes

## Kiến trúc 7 tầng

```
UI_WORKSPACE (ws-od-prototypes)
  └─ WORKSPACE_COMPOSITION ─→ UI_THEME_COMPOSITION (tạo mới)
       └─ USES_THEME ─→ 7 × UI_THEME (tạo mới, mỗi axis 1)
            └─ (themeId property) ─→ UI_TOKEN_VALUE (tạo mới, ~118 values)
                 ├─ FOR_TOKEN ─→ UI_TOKEN (dùng lại)
                 └─ IN_MODE ─→ UI_MODE (dùng lại)
```

## Workflow 9 bước

1. **Discovery** — Agent hỏi user về composition name, visual direction, color stance, primary color, platform, density
2. **Phân tích palette** — Map direction → OKLch palette từ `direction-library.md`
3. **Tạo 7 UI_THEME** — Brand, Typography, Spacing, Icon, Visual, Control, Rounded
4. **Kết nối Axes → Themes** — `HAS_THEME` relationships
5. **Tạo UI_THEME_COMPOSITION** — Node chính với metadata
6. **Tạo UI_TOKEN_VALUE** — Values với `themeId` cho mỗi token (Light + Dark)
7. **Gắn vào Workspace** — `WORKSPACE_COMPOSITION` relationship
8. **Verify** — Chạy validation queries (7 themes, token values, Light/Dark parity)
9. **Preview** — Emit HTML artifact với composition tokens (optional)

## Files

- `SKILL.md` — Skill definition với workflow chi tiết
- `references/direction-library.md` — 6 visual directions với OKLch palettes
- `references/token-catalog.md` — Danh sách tokens có sẵn
- `references/validation-queries.md` — Cypher queries để verify composition
- `references/example-neumorphism.md` — Ví dụ hoàn chỉnh Neumorphism composition

## Triggers

```
"tạo theme composition"
"create style composition"
"new design system"
"kg theme"
"compositional design"
```

## Example Usage

```
User: Tạo theme composition Glassmorphism với màu xanh dương Stripe

Agent:
1. Hỏi discovery questions
2. Map direction → Glassmorphism palette
3. Adjust accent hue → Stripe blue (oklch(58% 0.20 250))
4. Tạo 7 themes với frosted glass visual
5. Tạo 118 token values (59 tokens × 2 modes)
6. Verify với validation queries
7. Emit preview HTML artifact
```

## Compose với skills khác

- **react-shadcn** — Render preview của composition bằng React + Tailwind
- **figma-generate-library** — Export composition sang Figma variables/styles
- **html-prototype** — Tạo static HTML prototype với composition tokens

## Token Count

**Standard composition:** ~118 token values
- Brand: 30 values (15 color tokens × 2 modes)
- Typography: 20 values (10 tokens × 2 modes)
- Spacing: 16 values (8 tokens × 2 modes)
- Icon: 10 values (5 tokens × 2 modes)
- Visual: 20 values (10 tokens × 2 modes)
- Control: 12 values (6 tokens × 2 modes)
- Rounded: 10 values (5 tokens × 2 modes)

## Validation Checklist

- [ ] Composition có đúng 7 themes?
- [ ] Mỗi theme kết nối với đúng axis qua `HAS_THEME`?
- [ ] Composition kết nối với 7 themes qua `USES_THEME`?
- [ ] Composition gắn vào workspace qua `WORKSPACE_COMPOSITION`?
- [ ] Mỗi token có cả Light và Dark mode values?
- [ ] Mỗi token value có `themeId` trỏ đúng theme?
- [ ] Tất cả values có `authored: true`?

## MCP Tools Used

- `kg_cypher_read` — Chạy validation queries
- `kg_find` — Tìm existing themes/tokens
- (Write operations phải chạy qua Neo4j Browser hoặc custom MCP write tool)

## Output

Agent tạo file `.cypher` chứa tất cả queries, giải thích từng bước, và emit HTML preview artifact (optional).
